# Bricks -- Production Infrastructure Design

> Version: 1.0 | Date: 2026-04-08
> Platform: Azure | Compute: AKS | Data: PostgreSQL Flexible Server | Cache: Azure Managed Redis | Files: Azure Blob Storage | AI: Azure AI Foundry (Claude)

---

## Table of Contents

1. [AKS Cluster Design](#1-aks-cluster-design)
2. [Infrastructure as Code](#2-infrastructure-as-code)
3. [CI/CD Pipeline](#3-cicd-pipeline)
4. [Monitoring and Observability](#4-monitoring-and-observability)
5. [Cost Management](#5-cost-management)
6. [Scaling Strategy](#6-scaling-strategy)
7. [Disaster Recovery](#7-disaster-recovery)
8. [SSL/TLS and DNS](#8-ssltls-and-dns)
9. [Container Image Strategy](#9-container-image-strategy)
10. [Development Environment](#10-development-environment)
11. [Rollback Strategy](#11-rollback-strategy)
12. [Estimated Cost Models](#12-estimated-cost-models)

---

## 1. AKS Cluster Design

### 1.1 Cluster Topology

One AKS cluster per environment (dev, staging, prod). Production uses AKS Standard tier for the financially backed SLA. Dev and staging use AKS Free tier.

```
Cluster: bricks-prod-eastus-aks
  |
  |-- system-pool          (system pods, ingress, cert-manager, monitoring agents)
  |-- core-pool            (Bricks API, WebSocket server, web frontend)
  |-- sandbox-pool         (user sandbox pods -- ephemeral, autoscaled)
  |-- sandbox-pool-spot    (overflow sandbox pods on Spot VMs -- cost optimization)
```

### 1.2 Node Pools

| Pool Name | Purpose | VM SKU | Min Nodes | Max Nodes | OS | Taints | AZ |
|---|---|---|---|---|---|---|---|
| `system` | CoreDNS, ingress-nginx, cert-manager, OTel collectors, kube-system | `Standard_D2s_v5` (2 vCPU, 8 GiB) | 3 | 5 | AzureLinux 3 | `CriticalAddonsOnly=true:NoSchedule` | 1,2,3 |
| `core` | Bricks API (NestJS), WebSocket server, Next.js frontend, Go orchestrator | `Standard_D4s_v5` (4 vCPU, 16 GiB) | 2 | 10 | AzureLinux 3 | none | 1,2,3 |
| `sandbox` | User sandbox containers (code execution, terminal, LSP) | `Standard_D4s_v5` (4 vCPU, 16 GiB) | 1 | 50 | AzureLinux 3 | `workload=sandbox:NoSchedule` | 1,2,3 |
| `sandbox-spot` | Overflow sandbox containers on Spot VMs (up to 90% cheaper) | `Standard_D4s_v5` (4 vCPU, 16 GiB) | 0 | 30 | AzureLinux 3 | `workload=sandbox:NoSchedule`, `kubernetes.azure.com/scalesetpriority=spot:NoSchedule` | 1,2,3 |

**Why these SKUs:**
- `Standard_D2s_v5` for system: System pods are lightweight. 2 vCPU / 8 GiB is more than sufficient for CoreDNS, ingress controllers, and monitoring DaemonSets. At ~$70/mo per node, 3 nodes = ~$210/mo for the system plane.
- `Standard_D4s_v5` for core and sandbox: 4 vCPU / 16 GiB provides enough headroom for the NestJS API server (which handles WebSocket connections and is memory-hungry) and for sandbox pods (each sandbox needs ~0.5-1 vCPU and 512 MiB-2 GiB RAM depending on workload). At ~$140/mo per node this is the best price/performance ratio in the Dv5 family.
- Spot VMs for sandbox-spot: Identical SKU but up to 90% cheaper. Sandboxes are ephemeral and tolerant of eviction -- if a Spot VM is reclaimed, the sandbox is simply recreated. Users see a brief reconnection, not data loss.

### 1.3 Sandbox Pod Resource Limits

Each sandbox pod runs a user's development environment (Node.js, Python, etc. with a terminal and file system).

```yaml
# Per sandbox pod
resources:
  requests:
    cpu: "250m"
    memory: "512Mi"
  limits:
    cpu: "1000m"       # burst up to 1 vCPU
    memory: "2Gi"      # hard cap to prevent OOM from user code
    ephemeral-storage: "5Gi"
```

This means a single `Standard_D4s_v5` node (4 vCPU, 16 GiB) can host approximately 8-16 sandbox pods depending on burst behavior.

### 1.4 Networking

**Plugin: Azure CNI Overlay**

Rationale:
- Azure CNI Overlay assigns pods IPs from a separate overlay network (default /24 per node), avoiding VNet IP exhaustion -- critical when sandbox pods scale to hundreds.
- Pods still get direct VNet connectivity for Azure services (PostgreSQL private endpoint, Redis private endpoint, Blob Storage).
- Avoids the kubenet limitation of 400 nodes/cluster and the Azure CNI limitation of consuming one VNet IP per pod.

```
VNet: bricks-prod-vnet (10.0.0.0/16)
  |-- subnet-system:    10.0.0.0/24    (AKS system nodes)
  |-- subnet-core:      10.0.1.0/24    (AKS core nodes)
  |-- subnet-sandbox:   10.0.2.0/22    (AKS sandbox nodes -- larger range for autoscaling)
  |-- subnet-postgres:  10.0.8.0/24    (PostgreSQL Flexible Server delegated subnet)
  |-- subnet-redis:     10.0.9.0/24    (Azure Managed Redis private endpoint)
  |-- subnet-pe:        10.0.10.0/24   (Private endpoints: ACR, Blob, Key Vault)

Pod CIDR (overlay): 10.244.0.0/16
Service CIDR:       10.96.0.0/16
```

**Network Policies:** Cilium (Azure CNI, eBPF-based). Used to:
- Isolate sandbox pods from each other (namespace-level network policies per user session).
- Restrict sandbox pod egress to only allowed destinations (prevent crypto mining, outbound abuse).
- Allow sandbox pods to reach the internet (npm install, pip install) but block access to the Azure metadata endpoint (169.254.169.254) and internal cluster services.

### 1.5 Kubernetes Version

Use the latest stable AKS version available at deployment time. As of April 2026, target **Kubernetes 1.30.x** (the latest GA version on AKS). Enable the AKS auto-upgrade channel set to `patch` for automatic patch version upgrades. Pin the minor version manually and upgrade after testing in staging.

### 1.6 Key AKS Features to Enable

| Feature | Purpose |
|---|---|
| Managed Identity (User-Assigned) | Single identity for ACR pull, Key Vault access, DNS zone management |
| Workload Identity | Pod-level Azure auth for cert-manager, app pods accessing Key Vault |
| Azure Policy for AKS | Enforce pod security standards (restricted profile for sandbox pods) |
| Container Insights | Built-in monitoring integration with Log Analytics |
| Defender for Containers | Runtime threat detection, image vulnerability scanning |
| KEDA | Event-driven autoscaling (used for sandbox pool scaling based on queue depth) |
| Azure Key Vault Provider for Secrets Store CSI | Mount Key Vault secrets as volumes in pods |

---

## 2. Infrastructure as Code

### 2.1 Tool: Terraform

**Why Terraform over Bicep or Pulumi:**
- Terraform has the largest ecosystem and community. The `azurerm` provider is mature and well-documented.
- Azure Verified Modules (AVM) provide production-ready, Microsoft-endorsed Terraform modules (e.g., `avm-ptn-aks-production`).
- Multi-cloud flexibility if Bricks ever expands beyond Azure.
- Bicep is Azure-only and lacks the module ecosystem. Pulumi adds language complexity without proportional benefit for this use case.
- The team likely already knows HCL. If not, HCL is simpler to learn than Pulumi's general-purpose language approach.

### 2.2 Repository Structure

```
infra/
  |-- modules/
  |     |-- aks/                   # AKS cluster + node pools
  |     |-- networking/            # VNet, subnets, NSGs, private endpoints
  |     |-- database/              # PostgreSQL Flexible Server
  |     |-- redis/                 # Azure Managed Redis
  |     |-- storage/               # Blob Storage accounts
  |     |-- acr/                   # Azure Container Registry
  |     |-- dns/                   # Azure DNS zones
  |     |-- keyvault/              # Azure Key Vault
  |     |-- monitoring/            # Log Analytics, App Insights, alerts
  |     |-- ai-foundry/            # Azure AI Foundry resource + model deployment
  |     |-- identity/              # User-assigned managed identities, role assignments
  |
  |-- environments/
  |     |-- dev/
  |     |     |-- main.tf          # Module composition for dev
  |     |     |-- variables.tf
  |     |     |-- terraform.tfvars # Dev-specific values (smaller SKUs, fewer nodes)
  |     |     |-- backend.tf       # Dev state backend config
  |     |
  |     |-- staging/
  |     |     |-- main.tf
  |     |     |-- variables.tf
  |     |     |-- terraform.tfvars
  |     |     |-- backend.tf
  |     |
  |     |-- prod/
  |           |-- main.tf
  |           |-- variables.tf
  |           |-- terraform.tfvars
  |           |-- backend.tf
  |
  |-- global/
  |     |-- main.tf                # Resources shared across environments (ACR, DNS zone)
  |     |-- backend.tf
  |
  |-- scripts/
        |-- init-backend.sh        # Create storage account for TF state (run once)
```

### 2.3 State Management

**Backend: Azure Blob Storage with state locking via Azure Blob lease.**

```hcl
# backend.tf (example for prod)
terraform {
  backend "azurerm" {
    resource_group_name  = "bricks-tfstate-rg"
    storage_account_name = "brickstfstateprod"
    container_name       = "tfstate"
    key                  = "prod/terraform.tfstate"
    use_oidc             = true       # OIDC auth from GitHub Actions
  }
}
```

Each environment has its own state file in a separate blob. The storage account uses:
- Soft delete enabled (recover accidentally deleted state)
- Versioning enabled (roll back state file if corrupted)
- RA-GRS redundancy (readable in secondary region)
- `prevent_destroy` lifecycle rule on critical resources (AKS cluster, PostgreSQL, Key Vault)

### 2.4 Secret Management

**Zero secrets in code. Period.**

| Secret Type | Storage | Access Method |
|---|---|---|
| Database connection string | Azure Key Vault | Secrets Store CSI Driver mounted in pods |
| Redis connection string | Azure Key Vault | Secrets Store CSI Driver |
| Claude API key (AI Foundry) | Azure Key Vault | Secrets Store CSI Driver |
| Clerk auth keys | Azure Key Vault | Secrets Store CSI Driver |
| Stripe API keys | Azure Key Vault | Secrets Store CSI Driver |
| TLS certificates | Kubernetes Secrets (managed by cert-manager) | Automatic via cert-manager |
| Terraform state access | OIDC federated credential | GitHub Actions OIDC -- no stored credentials |
| ACR image pull | AKS managed identity | `acrPull` role assignment -- no image pull secret |

**Azure Key Vault Configuration:**
- SKU: Standard (sufficient for secret storage; Premium only needed for HSM-backed keys)
- Soft delete: enabled (mandatory since 2025)
- Purge protection: enabled for production
- RBAC authorization: enabled (no access policies; use Azure RBAC for granular control)
- Private endpoint: enabled (Key Vault only accessible from the VNet)

### 2.5 Resources Defined in Terraform

| Resource | Terraform Resource Type | Notes |
|---|---|---|
| Resource Group | `azurerm_resource_group` | One per environment: `bricks-dev-rg`, `bricks-staging-rg`, `bricks-prod-rg` |
| VNet + Subnets | `azurerm_virtual_network`, `azurerm_subnet` | See networking section |
| AKS Cluster | `azurerm_kubernetes_cluster` | Using AVM module |
| AKS Node Pools | `azurerm_kubernetes_cluster_node_pool` | System, core, sandbox, sandbox-spot |
| PostgreSQL Flexible | `azurerm_postgresql_flexible_server` | General Purpose, zone-redundant HA in prod |
| Azure Managed Redis | `azurerm_redis_cache` | Standard C1 for dev, Premium P1 for prod |
| Blob Storage | `azurerm_storage_account` + containers | For user project files, sandbox snapshots |
| ACR | `azurerm_container_registry` | Premium (geo-replication, content trust) |
| Key Vault | `azurerm_key_vault` | One per environment |
| Azure DNS Zone | `azurerm_dns_zone` | `bricks.dev` (global, not per-env) |
| Log Analytics | `azurerm_log_analytics_workspace` | One per environment |
| App Insights | `azurerm_application_insights` | Connected to Log Analytics |
| User-Assigned Identity | `azurerm_user_assigned_identity` | For AKS, cert-manager workload identity |
| Private Endpoints | `azurerm_private_endpoint` | For PostgreSQL, Redis, ACR, Key Vault, Blob |
| NSGs | `azurerm_network_security_group` | Per subnet |
| Azure AI Foundry | `azurerm_ai_foundry` / marketplace | Claude model deployment |
| Budget Alerts | `azurerm_consumption_budget_resource_group` | Per environment |

---

## 3. CI/CD Pipeline

### 3.1 Platform: GitHub Actions

**Why GitHub Actions over Azure DevOps:**
- Bricks source code lives on GitHub. Native integration eliminates context switching.
- OIDC federated credentials (secretless auth to Azure) are first-class in GitHub Actions.
- GitHub Actions marketplace has mature AKS/Helm/Terraform actions.
- Azure DevOps adds unnecessary overhead for a team that is already on GitHub.

### 3.2 Pipeline Architecture

```
                    [Pull Request]                        [Merge to main]                [Tag vX.Y.Z]
                         |                                      |                              |
                    [PR Pipeline]                         [CI Pipeline]                  [Release Pipeline]
                         |                                      |                              |
               +---------+---------+              +-------------+-------------+          +-----+-----+
               |         |         |              |             |             |          |           |
            [Lint]   [Test]   [Build]       [Build+Push]  [Deploy Dev]  [Migrate DB]  [Deploy]  [Promote]
               |         |         |              |             |             |        Staging    Prod
               |         |         |              |             |             |          |           |
            eslint    jest      docker          ACR          helm upgrade    drizzle-kit (auto)    (manual
            tflint    e2e       build           push         --atomic        migrate               approval)
            hadolint  unit      (no push)       (sha tag)
```

### 3.3 Workflow Files

#### 3.3.1 PR Pipeline (`.github/workflows/pr.yml`)

Triggered on every pull request to `main`:

```yaml
name: PR Checks
on:
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run lint           # ESLint + Prettier check
      - run: npm run typecheck      # tsc --noEmit

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: bricks_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
      redis:
        image: redis:7
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:e2e

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile
          push: false                # Build only, no push
          tags: bricks-core:pr-${{ github.event.number }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  terraform-plan:
    runs-on: ubuntu-latest
    if: contains(github.event.pull_request.labels.*.name, 'infra')
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: |
          cd infra/environments/dev
          terraform init
          terraform plan -no-color
```

#### 3.3.2 CI Pipeline (`.github/workflows/ci.yml`)

Triggered on merge to `main`:

```yaml
name: CI - Build and Deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write        # OIDC
  contents: read

env:
  ACR_NAME: bricksprodacr
  IMAGE_NAME: bricks-core
  AKS_CLUSTER: bricks-dev-eastus-aks
  AKS_RG: bricks-dev-rg

jobs:
  build-push:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.ACR_NAME }}.azurecr.io
          username: 00000000-0000-0000-0000-000000000000
          password: ${{ steps.acr-token.outputs.token }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.ACR_NAME }}.azurecr.io/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=
            type=ref,event=branch
            type=raw,value=latest

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  migrate-db:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - run: |
          # Run Drizzle Kit migrations against dev database
          npx drizzle-kit migrate

  deploy-dev:
    needs: [build-push, migrate-db]
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - uses: azure/aks-set-context@v4
        with:
          resource-group: ${{ env.AKS_RG }}
          cluster-name: ${{ env.AKS_CLUSTER }}

      - run: |
          helm upgrade --install bricks-core ./helm/bricks-core \
            --namespace bricks \
            --create-namespace \
            --set image.tag=${{ needs.build-push.outputs.image-tag }} \
            --set image.repository=${{ env.ACR_NAME }}.azurecr.io/${{ env.IMAGE_NAME }} \
            --values ./helm/bricks-core/values-dev.yaml \
            --atomic \
            --wait \
            --timeout 5m
```

#### 3.3.3 Release Pipeline (`.github/workflows/release.yml`)

Triggered on tag push (e.g., `v1.2.3`):

```yaml
name: Release - Deploy to Staging and Prod
on:
  push:
    tags: ['v*']

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment: staging       # auto-approve
    steps:
      # ... same Helm deploy pattern with values-staging.yaml

  smoke-test:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - run: |
          # Hit staging health endpoint, run critical path tests
          curl -f https://staging.bricks.dev/api/health
          npm run test:smoke -- --base-url=https://staging.bricks.dev

  deploy-prod:
    needs: smoke-test
    runs-on: ubuntu-latest
    environment: production    # REQUIRES manual approval
    steps:
      # ... same Helm deploy pattern with values-prod.yaml
```

### 3.4 Deployment Strategy

**Rolling Update with Automatic Rollback (Helm `--atomic`).**

```yaml
# Kubernetes Deployment strategy (in Helm chart)
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```

- `maxSurge: 1`: Creates one new pod before removing an old one.
- `maxUnavailable: 0`: Zero downtime -- old pods keep serving until new pods pass readiness probes.
- `--atomic`: If Helm detects the rollout failed (pods not ready within timeout), it automatically rolls back to the previous release.
- `--wait`: Helm waits for pods to become ready before marking the release as successful.

**Why not blue-green or canary for v1:**
- Blue-green doubles infrastructure cost (two full deployments running simultaneously).
- Canary requires a service mesh (Istio/Linkerd) or Flagger -- operational complexity not justified at launch.
- Rolling update with `--atomic` provides zero-downtime deploys with automatic rollback. This is the right tradeoff for an early-stage product.
- Graduate to canary with Flagger + NGINX ingress annotations when user count exceeds ~5,000.

**Graceful Shutdown for WebSocket-Holding Pods:**

Pods that hold long-lived WebSocket connections (the API server, sandbox-router) need extra care during rolling updates to avoid abruptly dropping user sessions.

```yaml
# In Helm chart Deployment spec for bricks-api and sandbox-router
spec:
  terminationGracePeriodSeconds: 300    # 5 minutes to drain WebSocket connections
  containers:
    - name: bricks-api
      lifecycle:
        preStop:
          exec:
            command:
              - /bin/sh
              - -c
              - |
                # Signal the app to stop accepting new connections,
                # then wait for existing WebSocket connections to close gracefully.
                kill -SIGTERM 1
                sleep 15    # Give load balancer time to remove pod from endpoints
```

- `terminationGracePeriodSeconds: 300`: Kubernetes waits up to 5 minutes for the pod to shut down before force-killing it. This gives active WebSocket sessions time to complete or reconnect.
- `preStop` hook: Sends SIGTERM to the application process and sleeps 15 seconds. The sleep ensures the NGINX ingress controller removes the pod from its upstream list before the pod starts rejecting connections.
- The application should handle SIGTERM by: (1) stopping acceptance of new connections, (2) sending a "reconnect" frame to active WebSocket clients, (3) waiting for in-flight requests to complete, (4) exiting cleanly.

**PodDisruptionBudget for sandbox-router:**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sandbox-router-pdb
  namespace: bricks
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: sandbox-router
```

This ensures that during voluntary disruptions (node upgrades, cluster autoscaler scale-down, rolling updates), at most 1 sandbox-router pod is unavailable at any time. Combined with at least 2 replicas, this guarantees continuous sandbox routing during deployments and maintenance.

**Warning: Helm Concurrent Deploy Risk**

Helm uses a single release lock per release name. If two CI pipelines attempt `helm upgrade` on the same release concurrently (e.g., two rapid merges to `main`), one will fail with a "another operation is in progress" error. Mitigations:
- GitHub Actions concurrency groups: set `concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: true }` on the deploy job. This cancels the older deploy when a newer one starts.
- Alternatively, use `--wait --timeout 5m` with the `--atomic` flag (already configured), which ensures the first release completes or rolls back before the next one can proceed.
- Never run `helm upgrade` from multiple CI jobs targeting the same release name in parallel.

### 3.5 Database Migrations in the Pipeline

**Tool: Drizzle Kit**

Migration flow:
1. Developer creates/modifies schema in `src/db/schema.ts` and pushes to dev: `npx drizzle-kit push`
2. For production migrations, generate SQL: `npx drizzle-kit generate` (creates SQL files in `drizzle/migrations/`).
3. CI pipeline runs `npx drizzle-kit migrate` against the target database BEFORE deploying new application code.
4. Migrations are forward-only. No down migrations in production.
5. For breaking schema changes (column renames, type changes), use the expand-contract pattern:
   - **Expand**: Add new column, deploy code that writes to both old and new.
   - **Migrate**: Backfill data.
   - **Contract**: Deploy code that reads from new column only, then drop old column.

**Safety rails:**
- `drizzle-kit migrate` only runs pending migrations. It does not generate new migrations.
- Migrations are idempotent (Drizzle Kit tracks which have been applied in `__drizzle_migrations` table).
- A failed migration halts the pipeline. The deployment does not proceed.
- For emergency rollback: deploy the previous application version (which still works with the expanded schema).

### 3.6 Sandbox Base Image Updates

Sandbox images are separate from the application image. They follow a different lifecycle:

```yaml
# .github/workflows/sandbox-images.yml
name: Build Sandbox Base Images
on:
  schedule:
    - cron: '0 2 * * 1'        # Every Monday at 2 AM UTC
  workflow_dispatch:             # Manual trigger
  push:
    paths:
      - 'sandbox/images/**'

jobs:
  build-node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v6
        with:
          context: ./sandbox/images/node
          push: true
          tags: |
            bricksprodacr.azurecr.io/sandbox-node:22-latest
            bricksprodacr.azurecr.io/sandbox-node:22-${{ github.sha }}

  build-python:
    # ... similar for Python sandbox image

  build-go:
    # ... similar for Go sandbox image

  vulnerability-scan:
    needs: [build-node, build-python, build-go]
    steps:
      - run: |
          az acr run --cmd "trivy image bricksprodacr.azurecr.io/sandbox-node:22-latest" /dev/null
```

### 3.7 Environment Promotion

```
dev         <- auto-deploy on merge to main
staging     <- auto-deploy on tag (vX.Y.Z), auto-approve
production  <- deploy on tag (vX.Y.Z), MANUAL approval required
```

Each environment has its own:
- AKS cluster
- PostgreSQL instance (dev: Burstable B2s, staging: GP D2ds_v5, prod: GP D4ds_v5 with HA)
- Redis instance (dev: Basic C0, staging: Standard C1, prod: Premium P1)
- Helm values file (replica counts, resource limits, feature flags)
- Key Vault (environment-specific secrets)

---

## 4. Monitoring and Observability

### 4.1 Stack

**Primary: Azure-native with OpenTelemetry instrumentation.**

| Component | Tool | Rationale |
|---|---|---|
| Metrics | Azure Monitor Metrics + Prometheus (via Container Insights) | Native AKS integration, no infrastructure to manage |
| Logs | Azure Log Analytics Workspace | Centralized querying with KQL, integrated with AKS |
| Traces | Application Insights (via OpenTelemetry SDK) | Distributed tracing across API, AI service, sandbox |
| Dashboards | Azure Workbooks + Grafana (Azure Managed Grafana) | Workbooks for ops team, Grafana for engineering |
| Alerting | Azure Monitor Alerts + PagerDuty/Opsgenie integration | Tiered alerting with escalation policies |

**Why not self-hosted Grafana Loki/Prometheus/Tempo:**
- Self-hosted observability is a second product to operate. At launch, the team should be building features, not maintaining Prometheus storage.
- Azure Monitor + Log Analytics handles petabytes of log data with zero infra management.
- Azure Managed Grafana gives Grafana dashboards without operating the instance.
- If costs become unreasonable at scale (>10K users), migrate to self-hosted then.

### 4.2 Instrumentation

**OpenTelemetry SDK in every service:**

```typescript
// In NestJS main.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AzureMonitorTraceExporter } from '@azure/monitor-opentelemetry-exporter';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  traceExporter: new AzureMonitorTraceExporter({
    connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'bricks-api',
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION,
  }),
});
sdk.start();
```

**Two-tier OTel Collector deployment on AKS:**
- DaemonSet agents on each node: collect pod logs, node metrics, Kubernetes events.
- Gateway Deployment: aggregate, filter (drop `/healthz` and `/readyz` spans), sample, and export to Azure Monitor.

### 4.3 Uptime Targets (SLOs)

Different components have different reliability characteristics. Setting a single uptime number is misleading -- AI services depend on third-party APIs, sandboxes are ephemeral by design, and the web UI is mostly static. Tiered targets reflect reality:

| Component | Uptime SLO | Rationale |
|---|---|---|
| **Web UI (Next.js frontend)** | 99.9% (~8.7h downtime/year) | Static assets + CDN. Rarely goes down unless AKS cluster is lost. |
| **API (NestJS backend)** | 99.9% (~8.7h downtime/year) | Stateless, multi-replica, rolling deploys. Achievable with current architecture. |
| **Sandbox (code execution)** | 99.5% (~43.8h downtime/year) | Ephemeral pods on autoscaled nodes. Cold starts, Spot VM evictions, and node scaling latency reduce effective uptime. Users experience brief reconnections, not data loss. |
| **AI Features (Claude via AI Foundry)** | 99.0% (~87.6h downtime/year) | Depends on Azure AI Foundry + Anthropic upstream availability. Third-party dependency outside our control. Degrade gracefully when unavailable (disable AI features, show "AI temporarily unavailable" banner). |
| **Overall Platform** | 99.0% (~87.6h downtime/year) | Composite of all components. The weakest link (AI) determines the overall number. |

**Error budget policy:**
- If a component burns >50% of its monthly error budget in a week, halt feature deployments and focus on reliability.
- Track error budgets in the Platform Health dashboard.

### 4.4 Key Metrics to Track

| Metric | Source | Why It Matters |
|---|---|---|
| **Sandbox Pod Creation Time** | Custom metric (p50, p95, p99) | Users feel this directly. Target: p95 < 5s |
| **WebSocket Connection Count** | Custom gauge | Tracks active users. Capacity planning signal |
| **WebSocket Message Latency** | Custom histogram | Real-time feel depends on this. Target: p95 < 50ms |
| **AI Response Latency** | OTel span duration | Claude API call time. Target: p95 < 3s for short prompts |
| **AI Token Usage** | Custom counter (input/output tokens) | Cost tracking. Alert on anomalous spikes |
| **API Error Rate** | HTTP response codes (5xx / total) | SLI for reliability. Target: < 0.1% |
| **API Latency** | HTTP request duration (p50, p95, p99) | SLI for performance. Target: p95 < 200ms (excl. AI) |
| **Pod CPU/Memory Utilization** | Container Insights | Capacity planning, rightsize detection |
| **Node Pool Utilization** | Cluster Autoscaler metrics | Detect under/over-provisioning |
| **PostgreSQL Connections** | Azure PG metrics | Connection pool exhaustion is a common 3 AM outage |
| **PostgreSQL CPU/IOPS** | Azure PG metrics | Database is often the bottleneck |
| **Redis Hit Ratio** | Azure Redis metrics | Low hit ratio = cache is not working, investigate |
| **Blob Storage Throughput** | Azure Storage metrics | File upload/download performance |
| **Certificate Expiry Days** | cert-manager metrics | Alert at 14 days, page at 7 days |
| **Cluster Autoscaler Pending Pods** | Cluster Autoscaler metrics | Pods waiting for nodes = users waiting |

### 4.5 Dashboards

| Dashboard | Audience | Contents |
|---|---|---|
| **Platform Health** | On-call engineer | Error rates, latency percentiles, pod status, node status, recent deployments |
| **Sandbox Operations** | Platform team | Pod creation time distribution, active sandboxes by type, sandbox pool utilization, eviction rate |
| **AI Usage** | Product/Engineering | Token consumption by model, request latency, error rate, cost per hour |
| **User Activity** | Product | Active users, sessions created, projects created, file operations/min |
| **Cost** | Engineering lead | Daily/weekly burn rate by resource type, projected monthly cost |
| **Database** | Backend team | Query latency, connection count, lock waits, replication lag (when applicable) |

### 4.6 Alerting Rules

**Severity Levels:**
- **Sev0 (Page immediately):** Platform is down or degrading for users. Auto-escalate after 15 min.
- **Sev1 (Page within 30 min):** Significant degradation. Likely to become Sev0.
- **Sev2 (Slack notification):** Anomaly detected. Needs investigation during business hours.
- **Sev3 (Ticket):** Informational. Address in next sprint.

| Alert | Condition | Severity |
|---|---|---|
| API 5xx Rate > 5% for 5 min | `count(status >= 500) / count(*) > 0.05` | Sev0 |
| Sandbox creation failure rate > 10% for 5 min | Custom metric threshold | Sev0 |
| Pod CrashLoopBackOff in `bricks` namespace | `kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}` | Sev0 |
| PostgreSQL CPU > 90% for 10 min | Azure metric | Sev1 |
| PostgreSQL connection count > 80% of max | Azure metric | Sev1 |
| Cluster Autoscaler unable to scale (pending pods > 5 for 5 min) | CA metrics | Sev1 |
| API p95 latency > 500ms for 10 min | OTel metric | Sev1 |
| WebSocket disconnection rate spike > 2x baseline | Custom metric | Sev1 |
| AI Foundry error rate > 5% for 5 min | Custom metric | Sev1 |
| Certificate expiry < 7 days | cert-manager metric | Sev1 |
| Redis memory > 80% | Azure metric | Sev2 |
| AI token usage > 2x daily average | Custom metric | Sev2 |
| Blob storage egress > threshold | Azure metric | Sev2 |
| Certificate expiry < 14 days | cert-manager metric | Sev2 |
| AKS node count at max for > 1 hour | CA metrics | Sev3 |
| Daily cost > budget threshold | Azure Cost Management | Sev3 |

---

## 5. Cost Management

### 5.1 Cost Hierarchy

From most expensive to least (at scale):

1. **AKS Compute (VM nodes)** -- 40-50% of total cost
2. **AI Foundry (Claude tokens)** -- 20-30% (highly variable, depends on usage)
3. **Azure PostgreSQL** -- 10-15%
4. **Azure Managed Redis** -- 5-8%
5. **Networking (egress, load balancer)** -- 3-5%
6. **Blob Storage** -- 2-3%
7. **ACR, Key Vault, Log Analytics, DNS** -- 2-5%

### 5.2 Cost Optimization Strategies

| Strategy | Savings | Complexity |
|---|---|---|
| **Spot VMs for sandbox-spot pool** | Up to 90% on overflow sandbox nodes | Low (built into node pool config, pods tolerate eviction) |
| **Cluster Autoscaler scale-down** | Sandbox pool scales to 1 node at night (warm standby) | Low (set `min_count = 1` on sandbox pool; spot pool scales to 0) |
| **Reserved Instances (1-year)** for system + core pools | 30-40% on always-on nodes | Low (purchase commitment) |
| **PostgreSQL Reserved Capacity (1-year)** | Up to 40% | Low |
| **AI prompt caching** | Up to 90% on repeated context | Medium (requires caching layer in API) |
| **AI Batch API for async tasks** | 50% on token costs | Medium (requires queue-based architecture) |
| **Burstable PostgreSQL for dev/staging** | ~60% vs General Purpose | Low |
| **Lifecycle management on Blob Storage** | Move old project files to Cool tier after 30 days | Low (Azure policy) |
| **Right-size pods** | 10-30% (reduce over-provisioned requests) | Medium (requires load testing) |

### 5.3 Azure Cost Management Setup

```hcl
# Terraform: Budget alerts per resource group
resource "azurerm_consumption_budget_resource_group" "prod" {
  name              = "bricks-prod-monthly-budget"
  resource_group_id = azurerm_resource_group.prod.id
  amount            = 3000      # USD per month
  time_grain        = "Monthly"
  time_period {
    start_date = "2026-05-01T00:00:00Z"
    end_date   = "2027-05-01T00:00:00Z"
  }

  notification {
    enabled   = true
    threshold = 50
    operator  = "GreaterThan"
    contact_emails = ["engineering@bricks.dev"]
  }
  notification {
    enabled   = true
    threshold = 80
    operator  = "GreaterThan"
    contact_emails = ["engineering@bricks.dev", "cto@bricks.dev"]
  }
  notification {
    enabled   = true
    threshold = 100
    operator  = "GreaterThan"
    contact_emails = ["engineering@bricks.dev", "cto@bricks.dev", "finance@bricks.dev"]
  }
}
```

**Daily cost review process:**
- Azure Cost Management dashboard pinned in the engineering Slack channel via a daily bot post.
- Weekly cost review in sprint planning.
- Monthly detailed cost analysis with optimization recommendations.

### 5.4 Important Note on Azure Credits

Claude models via Azure AI Foundry are billed as third-party Marketplace items. This means **Azure sponsorship/startup credits typically do NOT cover AI Foundry Claude usage**. Plan for Claude token costs to come from actual payment methods, not credits. All other Azure resources (AKS, PostgreSQL, Redis, Blob, networking) are eligible for Azure credits.

---

## 6. Scaling Strategy

### 6.1 Bottleneck Analysis by Scale

| Users | Bottleneck | Action |
|---|---|---|
| **0-100** | Nothing. Single instance of everything works. | Default config. Focus on shipping features. |
| **100-500** | WebSocket connections per pod (~1000 max). Sandbox pod creation latency. | HPA for API pods (target: 70% CPU). Pre-warm 2-3 sandbox nodes. |
| **500-2,000** | PostgreSQL connections (default 100 max). Node pool scaling speed. | PgBouncer connection pooling. Increase PG SKU. Pre-scale sandbox pool during peak hours. |
| **2,000-5,000** | Database read throughput. Redis cache pressure. AI token costs. | Add PostgreSQL read replica. Upgrade Redis to Premium P1. Implement aggressive AI prompt caching. |
| **5,000-10,000** | AKS node provisioning latency. Cross-AZ network costs. Database write throughput. | Over-provision sandbox pool by 20%. Consider ACA for sandbox bursting. Upgrade PostgreSQL to 8+ vCores. |
| **10,000+** | Everything. | Multi-region. Database sharding or Citus. Dedicated AI token budget per user tier. CDN for static assets. Consider Firecracker microVMs for sandbox density. |

### 6.2 Horizontal Pod Autoscaler (HPA) -- Bricks Core

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: bricks-api-hpa
  namespace: bricks
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: bricks-api
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    - type: Pods
      pods:
        metric:
          name: websocket_active_connections
        target:
          type: AverageValue
          averageValue: "800"       # Scale when avg connections per pod exceeds 800
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300    # Wait 5 min before scaling down
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

### 6.3 Cluster Autoscaler -- Sandbox Node Pool

```hcl
# Terraform: sandbox node pool
resource "azurerm_kubernetes_cluster_node_pool" "sandbox" {
  name                  = "sandbox"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = "Standard_D4s_v5"
  min_count             = 1         # Keep 1 warm node to avoid cold-start latency
  max_count             = 50
  auto_scaling_enabled  = true
  os_sku                = "AzureLinux"
  zones                 = [1, 2, 3]

  node_taints = ["workload=sandbox:NoSchedule"]
  node_labels = {
    "bricks.dev/pool" = "sandbox"
  }

  # Cluster autoscaler profile (on cluster resource)
  # scale_down_delay_after_add       = "10m"
  # scale_down_unneeded              = "10m"
  # scan_interval                    = "10s"
  # max_graceful_termination_sec     = 600
}
```

**KEDA for event-driven sandbox scaling:**

For scenarios where we need faster-than-HPA scaling (e.g., a burst of users creating sandboxes), use KEDA with a Redis or Azure Service Bus scaler. The sandbox orchestrator (Go service) pushes sandbox creation requests to a queue. KEDA scales the sandbox pool based on queue depth, which is faster than waiting for pending pods to trigger the Cluster Autoscaler.

### 6.4 Database Scaling Plan

| Phase | Configuration | Cost |
|---|---|---|
| **Launch** | General Purpose D2ds_v5 (2 vCPU, 8 GiB), 128 GB storage, zone-redundant HA | ~$250/mo |
| **500 users** | Add PgBouncer (built-in to Azure PG Flexible Server). Max connections: 100 -> effective: 500+ | $0 extra |
| **2,000 users** | Scale up to D4ds_v5 (4 vCPU, 16 GiB). Add read replica for analytics queries | ~$500/mo |
| **5,000 users** | Scale up to D8ds_v5 (8 vCPU, 32 GiB). 512 GB storage. Read replica for API reads | ~$1,000/mo |
| **10,000+ users** | D16ds_v5 (16 vCPU, 64 GiB) or consider Citus for horizontal scaling | ~$2,000/mo |

### 6.5 Redis Scaling Plan

| Phase | Configuration | Cost |
|---|---|---|
| **Launch** | Standard C1 (1 GB, replicated) | ~$40/mo |
| **2,000 users** | Premium P1 (6 GB, clustering, VNet) | ~$225/mo |
| **10,000+ users** | Premium P2 (13 GB) or Azure Managed Redis Balanced B3 | ~$450/mo |

---

## 7. Disaster Recovery

### 7.1 RTO and RPO Targets

| Tier | RTO (Recovery Time Objective) | RPO (Recovery Point Objective) |
|---|---|---|
| **Bricks API + Frontend** | 15 minutes | 0 (stateless, redeploy from ACR) |
| **PostgreSQL** | 1 hour | 5 minutes (point-in-time restore) |
| **Redis** | 30 minutes | Some data loss acceptable (cache, not source of truth) |
| **Blob Storage** | 30 minutes | 0 (GRS replication) |
| **Sandbox pods** | Instant (ephemeral, recreated on demand) | N/A (ephemeral) |
| **User project files** | 1 hour | 5 minutes (Blob versioning + GRS) |

### 7.2 AKS Cluster Failure

**Scenario: AKS cluster becomes unresponsive.**

- AKS control plane is managed by Azure with a 99.95% SLA (Standard tier) and 99.99% SLA (Premium tier with AZs).
- If the control plane goes down: existing pods continue running (kubelet operates independently). No new pods can be scheduled. No scaling occurs.
- If worker nodes go down: Cluster Autoscaler replaces them (if the control plane is healthy). Pods are rescheduled to healthy nodes.
- **Full cluster loss (catastrophic):**
  1. Terraform re-creates the AKS cluster from code (15-20 minutes).
  2. Helm re-deploys all workloads (5 minutes).
  3. cert-manager re-issues certificates (2-5 minutes).
  4. DNS TTL determines user impact (set TTL to 60s for critical records).
  5. Total RTO: ~30 minutes.

**For v1, we do NOT need multi-region.** The probability of a full AKS cluster loss in a single region is extremely low. Design the IaC to be re-creatable, and multi-region can be added later.

### 7.3 PostgreSQL Failure

**Zone-redundant High Availability (enabled in production):**
- Azure PG Flexible Server with zone-redundant HA maintains a synchronous standby replica in a different AZ.
- Automatic failover: 60-120 seconds (zero data loss, synchronous replication).
- Built-in point-in-time restore: up to 35 days of backups.
- Geo-redundant backup: enabled, backups replicated to paired region.

```hcl
resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "bricks-prod-pg"
  resource_group_name           = azurerm_resource_group.prod.name
  location                      = "eastus"
  version                       = "16"
  sku_name                      = "GP_Standard_D4ds_v5"
  storage_mb                    = 131072    # 128 GB
  backup_retention_days         = 35
  geo_redundant_backup_enabled  = true
  zone                          = "1"

  high_availability {
    mode                      = "ZoneRedundant"
    standby_availability_zone = "2"
  }

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false    # Entra ID only -- no passwords
  }
}
```

### 7.4 Blob Storage Failure

- Use **GRS (Geo-Redundant Storage)** for the production storage account.
- Data is synchronously written to 3 copies in the primary region (LRS), then asynchronously replicated to the paired region.
- Enable **soft delete** (14 days) and **versioning** for user project files.
- Enable **immutable storage** for audit logs.

### 7.5 Backup Strategy Summary

| Data Store | Backup Method | Retention | RPO |
|---|---|---|---|
| PostgreSQL | Azure automated backups + geo-redundant | 35 days | 5 min (PITR) |
| Blob Storage | GRS + versioning + soft delete | 14 days (soft delete), indefinite (versioning) | ~0 (async repl.) |
| Redis | AOF persistence (Premium tier) + RDB snapshots | 12 hours (RDB), continuous (AOF) | Minutes |
| AKS cluster config | Terraform state (versioned, geo-redundant blob) | Indefinite | 0 (IaC) |
| Application config | Git repository | Indefinite | 0 |
| Container images | ACR geo-replication (Premium) | Indefinite (with retention policy) | 0 |
| Secrets | Key Vault soft delete + purge protection | 90 days after deletion | 0 |

### 7.6 Multi-Region (Future, v2+)

When the user base justifies it:
- Active-passive: Primary in East US, standby AKS cluster in West US (Terraform can spin it up from code).
- Azure Front Door for global load balancing and failover.
- PostgreSQL geo-replica in West US (async, read-only).
- ACR geo-replication already in place (Premium tier).
- Blob GRS already replicating to paired region.
- The IaC is designed to make this a matter of adding a second environment, not a rewrite.

---

## 8. SSL/TLS and DNS

### 8.1 DNS Management

**Azure DNS** for the `bricks.dev` zone.

```
bricks.dev                    A       -> Azure Load Balancer (AKS ingress)
www.bricks.dev                CNAME   -> bricks.dev
api.bricks.dev                A       -> Azure Load Balancer (AKS ingress)
*.preview.bricks.dev          A       -> Azure Load Balancer (AKS ingress)
staging.bricks.dev            A       -> Staging AKS LB
staging-api.bricks.dev        A       -> Staging AKS LB
```

### 8.2 cert-manager + Let's Encrypt

**Install cert-manager via Helm in the AKS cluster:**

```yaml
# ClusterIssuer for Let's Encrypt production
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: engineering@bricks.dev
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: <subscription-id>
            resourceGroupName: bricks-global-rg
            hostedZoneName: bricks.dev
            environment: AzurePublicCloud
            managedIdentity:
              clientID: <cert-manager-workload-identity-client-id>
```

**Why DNS-01 (not HTTP-01):**
- DNS-01 is the ONLY ACME challenge type that supports wildcard certificates.
- We need `*.preview.bricks.dev` for sandbox preview URLs.
- Uses Workload Identity Federation (no stored credentials).

**Staging Issuer (important for testing):**

Always deploy a Let's Encrypt **staging** ClusterIssuer alongside the production one. Let's Encrypt production has strict rate limits (50 certificates per registered domain per week). During initial setup, cert-manager misconfiguration, or CI/CD testing, you can burn through these limits quickly and get locked out for a week.

```yaml
# ClusterIssuer for Let's Encrypt staging (no rate limits, untrusted certs)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: engineering@bricks.dev
    privateKeySecretRef:
      name: letsencrypt-staging-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: <subscription-id>
            resourceGroupName: bricks-global-rg
            hostedZoneName: bricks.dev
            environment: AzurePublicCloud
            managedIdentity:
              clientID: <cert-manager-workload-identity-client-id>
```

- Use `letsencrypt-staging` issuer in dev and staging environments. Switch to `letsencrypt-prod` only in production.
- Staging certificates are signed by an untrusted CA ("Fake LE Intermediate X1"), so browsers will show a warning. This is expected and correct for non-production environments.
- Once you have verified that cert-manager is issuing staging certs correctly, switch the Certificate resources in production to reference `letsencrypt-prod`.

### 8.3 Certificate Strategy

| Domain | Certificate | Challenge |
|---|---|---|
| `bricks.dev`, `www.bricks.dev` | Single cert | DNS-01 |
| `api.bricks.dev` | Single cert | DNS-01 |
| `*.preview.bricks.dev` | Wildcard cert | DNS-01 |

```yaml
# Wildcard certificate for sandbox preview URLs
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: bricks-preview-wildcard
  namespace: bricks
spec:
  secretName: bricks-preview-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - "*.preview.bricks.dev"
  renewBefore: 720h    # Renew 30 days before expiry (LE certs are 90 days)
```

### 8.4 Sandbox Preview URLs

Pattern: `{project-id}.preview.bricks.dev`

How it works:
1. User clicks "Preview" in the IDE. The sandbox pod exposes port 3000 (or whatever the user's app runs on).
2. The Bricks API creates a unique subdomain entry: `abc123.preview.bricks.dev`.
3. NGINX Ingress routes `abc123.preview.bricks.dev` to the correct sandbox pod using a dynamically generated Ingress resource (or by parsing the Host header in a catch-all ingress that routes to the sandbox orchestrator).
4. The wildcard TLS certificate covers all `*.preview.bricks.dev` subdomains automatically.
5. Preview URLs are ephemeral -- they are deleted when the sandbox is destroyed.

**NGINX Ingress configuration:**

```yaml
# Catch-all ingress for preview URLs
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sandbox-preview-catchall
  namespace: bricks
  annotations:
    nginx.ingress.kubernetes.io/upstream-vhost: "$host"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header X-Original-Host $host;
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - "*.preview.bricks.dev"
      secretName: bricks-preview-tls
  rules:
    - host: "*.preview.bricks.dev"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: sandbox-router    # Go service that routes to correct sandbox pod
                port:
                  number: 80
```

---

## 9. Container Image Strategy

### 9.1 Bricks Core Image

Multi-stage Dockerfile for minimal production image:

```dockerfile
# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Stage 2: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build              # Next.js build + NestJS compile
RUN npm prune --production     # Remove devDependencies

# Stage 3: Production
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 bricks && \
    adduser --system --uid 1001 bricks

COPY --from=builder --chown=bricks:bricks /app/dist ./dist
COPY --from=builder --chown=bricks:bricks /app/node_modules ./node_modules
COPY --from=builder --chown=bricks:bricks /app/package.json ./

USER bricks
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

**Expected size:** ~200-300 MB (Alpine base + Node.js runtime + production dependencies).

### 9.2 Sandbox Base Images

Each sandbox image is a pre-built development environment:

```
sandbox/images/
  |-- node/
  |     |-- Dockerfile          # Node.js 22 + npm + yarn + pnpm + common global tools
  |-- python/
  |     |-- Dockerfile          # Python 3.12 + pip + venv + common packages
  |-- go/
  |     |-- Dockerfile          # Go 1.23 + common tools
  |-- base/
        |-- Dockerfile          # Shared base: Ubuntu 24.04 + git + curl + vim + tmux + zsh
```

**What's pre-installed in every sandbox image:**
- OS: Ubuntu 24.04 LTS (familiar to developers, broad package support)
- Shell: zsh + oh-my-zsh (developer experience)
- Tools: git, curl, wget, vim, nano, tmux, htop, jq
- node-pty support libraries
- Chokidar dependencies (inotify)
- Language server binaries (TypeScript language server, Pyright, gopls)
- A non-root user (`sandbox`, UID 1000)

**Expected size:** 800 MB - 1.5 GB per sandbox image (large, but cached on nodes and in ACR).

**Update strategy:**
- Weekly automated builds (Monday 2 AM UTC) via GitHub Actions.
- Vulnerability scanning with Trivy after every build.
- Semantic versioning: `sandbox-node:22-20260408` (language version + build date).
- `latest` tag always points to the most recent build.
- Old images retained for 30 days, then garbage collected via ACR retention policy.

### 9.3 Image Tagging Strategy

| Tag Pattern | Example | Usage |
|---|---|---|
| Git SHA (short) | `bricks-core:a1b2c3d` | Every CI build. Immutable. Used in Helm deployments. |
| Branch name | `bricks-core:main` | Mutable. Points to latest build from branch. Dev environment auto-deploy. |
| Semantic version | `bricks-core:v1.2.3` | Release tags. Used in staging and production. |
| `latest` | `bricks-core:latest` | Always points to latest `main` build. Never used in production deployments. |

**Critical rule:** Production deployments ALWAYS use the immutable SHA tag or semver tag, NEVER `latest` or branch tags.

### 9.4 Image Security

| Tool | Purpose | When |
|---|---|---|
| **Azure Defender for Containers** | Runtime vulnerability scanning, behavioral detection | Always-on in production |
| **Trivy** (in CI) | Image vulnerability scanning before push | Every CI build |
| **ACR Content Trust** | Image signing (Docker Content Trust / Notary v2) | Production images only |
| **ACR Quarantine** (Premium) | Images must pass scan before becoming pullable | Production registry |
| **Hadolint** (in CI) | Dockerfile linting | Every PR |

---

## 10. Development Environment

### 10.1 Local Development Stack

Developers run Bricks locally using Docker Compose:

```yaml
# docker-compose.yml
services:
  # -- Infrastructure --
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: bricks
      POSTGRES_USER: bricks
      POSTGRES_PASSWORD: localdev
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  # -- Application --
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3001:3001"          # NestJS API
      - "3002:3002"          # WebSocket server
    environment:
      DATABASE_URL: postgresql://bricks:localdev@postgres:5432/bricks
      REDIS_URL: redis://redis:6379
      CLAUDE_API_KEY: ${CLAUDE_API_KEY}       # From .env file (never committed)
      NODE_ENV: development
    volumes:
      - .:/app                               # Hot reload
      - /app/node_modules                    # Exclude node_modules from mount
    depends_on:
      - postgres
      - redis

  web:
    build:
      context: ./apps/web
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"          # Next.js frontend
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:3001
      NEXT_PUBLIC_WS_URL: ws://localhost:3002
    volumes:
      - ./apps/web:/app
      - /app/node_modules

  # -- Sandbox (local simulation) --
  sandbox:
    build:
      context: ./sandbox/images/node
    ports:
      - "3003:3000"          # Sandbox app preview port
      - "3004:8080"          # Sandbox terminal WebSocket
    volumes:
      - sandbox-workspace:/workspace
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
    security_opt:
      - no-new-privileges:true

volumes:
  pgdata:
  sandbox-workspace:
```

### 10.2 Environment Variables

```bash
# .env.example (committed to repo)
DATABASE_URL=postgresql://bricks:localdev@localhost:5432/bricks
REDIS_URL=redis://localhost:6379
CLAUDE_API_KEY=              # Get from Azure AI Foundry or Anthropic directly
CLERK_SECRET_KEY=            # Get from Clerk dashboard
CLERK_PUBLISHABLE_KEY=       # Get from Clerk dashboard
STRIPE_SECRET_KEY=           # Get from Stripe dashboard (test mode)
BLOB_STORAGE_CONNECTION=     # Use Azurite for local dev
NODE_ENV=development

# .env (NOT committed -- in .gitignore)
# Developer copies .env.example to .env and fills in real values
```

**For local Blob Storage:** Use [Azurite](https://github.com/Azure/Azurite) (Azure Storage emulator) in Docker Compose.

### 10.3 Local Kubernetes Testing

For testing sandbox orchestration locally (Kubernetes-specific behavior):

```bash
# Option 1: kind (Kubernetes IN Docker) -- recommended
kind create cluster --name bricks-local
kubectl apply -f helm/bricks-core/templates/     # Apply manifests directly

# Option 2: minikube with Docker driver
minikube start --driver=docker --memory=8192 --cpus=4
```

**When to use local K8s:**
- Testing Helm chart changes
- Testing pod scheduling with taints/tolerations
- Testing RBAC policies
- Testing network policies

**When NOT to use local K8s:**
- Day-to-day feature development (use Docker Compose)
- Frontend development (run Next.js directly with `npm run dev`)

### 10.4 Makefile for Developer Ergonomics

```makefile
# Makefile
.PHONY: up down logs test migrate sandbox-shell

up:                           ## Start all services
	docker compose up -d

down:                         ## Stop all services
	docker compose down

logs:                         ## Tail all logs
	docker compose logs -f

test:                         ## Run all tests
	npm run test:unit && npm run test:integration

migrate:                      ## Run database migrations (dev: push schema directly)
	npx drizzle-kit push

migrate-generate:             ## Generate migration SQL for production
	npx drizzle-kit generate

migrate-deploy:               ## Apply pending migrations (CI/production)
	npx drizzle-kit migrate

sandbox-shell:                ## Open a shell in the sandbox container
	docker compose exec sandbox /bin/zsh

seed:                         ## Seed database with test data
	npx tsx src/db/seed.ts

lint:                         ## Run all linters
	npm run lint && npm run typecheck

format:                       ## Format code
	npm run format
```

---

## 11. Rollback Strategy

### 11.1 Application Rollback

**Helm provides instant rollback:**

```bash
# List release history
helm history bricks-core -n bricks

# Rollback to previous release
helm rollback bricks-core -n bricks

# Rollback to specific revision
helm rollback bricks-core 5 -n bricks
```

Helm keeps the last 10 release revisions by default (configurable). Each revision stores the full manifest, so rollback is instantaneous -- it re-applies the previous Kubernetes resources.

**Automatic rollback (already configured):**
- `--atomic` flag on `helm upgrade` means a failed deployment is automatically rolled back.
- Readiness probes must pass for the deployment to be marked successful.
- If probes fail within the timeout (5 minutes), Helm rolls back.

### 11.2 Database Rollback

**Databases do NOT support backward migrations in production.**

Strategy:
- Schema changes are always forward-compatible (expand-contract pattern).
- If a migration introduces a bug, fix it with a new forward migration.
- For catastrophic data corruption: Azure PostgreSQL Point-In-Time Restore (PITR) to any point in the last 35 days.
- PITR creates a NEW server instance. Update the connection string (via Key Vault) and redeploy.

### 11.3 Feature Flags

**Use feature flags for risky changes:**

```typescript
// Feature flag service (backed by Redis for performance, PostgreSQL for persistence)
const flags = {
  'sandbox-v2-engine': {
    enabled: false,
    rollout: 0,           // 0% of users
    allowlist: ['user-123', 'user-456'],   // Internal testers
  },
  'ai-code-review': {
    enabled: true,
    rollout: 25,          // 25% of users (gradual rollout)
  },
};
```

**Flag evaluation flow:**
1. On user request, check Redis for cached flag state.
2. If cache miss, fetch from PostgreSQL.
3. Evaluate: is the user in the allowlist? If not, is the feature enabled? If so, is the user within the rollout percentage?
4. Return boolean.

**For v1, build a simple feature flag system** (Redis + PostgreSQL, ~200 lines of code). Do NOT use LaunchDarkly ($1,000+/mo) or Unleash (operational overhead) at this stage.

**Rollout workflow for risky changes:**
1. Deploy new code behind a feature flag (flag off).
2. Enable flag for internal team (allowlist).
3. Test in production.
4. Gradually increase rollout: 5% -> 25% -> 50% -> 100%.
5. If issues found at any step: set rollout to 0%. No code deployment needed.
6. Once stable at 100%: remove the flag and the old code path.

### 11.4 Rollback Decision Matrix

| Scenario | Action | Time |
|---|---|---|
| Bad deployment (app crashes) | Automatic -- Helm `--atomic` rolls back | 0 min (automatic) |
| Bad deployment (passes probes but has bugs) | `helm rollback bricks-core -n bricks` | 2 min |
| Bad migration (schema issue) | Deploy fix-forward migration | 15-30 min |
| Data corruption | PostgreSQL PITR to pre-corruption timestamp | 30-60 min |
| Complete cluster failure | Terraform re-create + Helm re-deploy | 30-45 min |
| Feature causing user complaints | Disable feature flag | 0 min (instant) |

---

## 12. Estimated Cost Models

### 12.1 Assumptions

- Each active user has 1 sandbox pod running (0.5 vCPU, 1 GiB request).
- Average AI usage: 50K input tokens + 10K output tokens per user per day.
- Using Claude Sonnet 4.6 ($3/MTok input, $15/MTok output) for primary AI features.
- Database size grows ~1 GB per 100 users per month.
- 8 hours of active usage per day average.
- East US region pricing.

### 12.2 Cost at 100 Users (Early Stage)

| Resource | Configuration | Monthly Cost |
|---|---|---|
| AKS Control Plane | Free tier | $0 |
| System Pool | 3x Standard_D2s_v5 | $210 |
| Core Pool | 2x Standard_D4s_v5 | $280 |
| Sandbox Pool | 3x Standard_D4s_v5 (avg, autoscaled) | $420 |
| PostgreSQL | Burstable B2s (2 vCPU, 4 GiB) | $50 |
| Redis | Standard C1 (1 GB) | $40 |
| Blob Storage | ~10 GB Hot | $5 |
| ACR | Standard | $15 |
| Log Analytics | ~5 GB/day ingestion | $75 |
| Networking (LB, egress) | Moderate | $30 |
| Azure DNS | 1 zone | $1 |
| Key Vault | Standard, ~100 operations/day | $1 |
| AI Foundry (Claude Sonnet 4.6) | 100 users x 50K in + 10K out/day x 30 days | ~$600** |
| **TOTAL** | | **~$2,500-3,500/mo** |

**Note: AI cost is highly variable. The range reflects uncertainty in actual usage patterns and prompt caching effectiveness. With aggressive prompt caching (90% reduction on repeated context), costs trend toward the lower end. Without caching or with heavy AI usage, costs trend toward the upper end. Budget for the high end.**

### 12.3 Cost at 1,000 Users (Growth Stage)

| Resource | Configuration | Monthly Cost |
|---|---|---|
| AKS Control Plane | Standard tier (SLA) | $73 |
| System Pool | 3x Standard_D2s_v5 | $210 |
| Core Pool | 4x Standard_D4s_v5 | $560 |
| Sandbox Pool | 15x Standard_D4s_v5 (avg) + 5x Spot | $2,170 |
| PostgreSQL | GP D4ds_v5 (4 vCPU, 16 GiB), HA | $500 |
| Redis | Premium P1 (6 GB) | $225 |
| Blob Storage | ~100 GB Hot + 50 GB Cool | $5 |
| ACR | Premium (for scanning, content trust) | $50 |
| Log Analytics | ~20 GB/day | $300 |
| Networking | Higher egress | $80 |
| AI Foundry (Claude Sonnet 4.6) | 1K users x tokens x 30 days (with caching) | ~$2,000 |
| **TOTAL** | | **~$8,000-12,000/mo** |

**Note: Range accounts for variable AI token costs, autoscaling behavior, and data transfer. With 1-year reserved instances for system/core pools, save ~$300-500/mo off the lower bound.**

### 12.4 Cost at 10,000 Users (Scale Stage)

| Resource | Configuration | Monthly Cost |
|---|---|---|
| AKS Control Plane | Standard tier | $73 |
| System Pool | 5x Standard_D2s_v5 | $350 |
| Core Pool | 10x Standard_D4s_v5 (reserved) | $980 |
| Sandbox Pool | 80x Standard_D4s_v5 (avg) + 30x Spot | $12,600 |
| PostgreSQL | GP D16ds_v5 (16 vCPU, 64 GiB), HA + read replica | $4,000 |
| Redis | Premium P2 (13 GB, clustered) | $450 |
| Blob Storage | ~2 TB Hot + 1 TB Cool | $50 |
| ACR | Premium with geo-replication | $100 |
| Log Analytics | ~100 GB/day (with sampling) | $750 |
| Networking | High egress, multi-LB | $300 |
| Azure Front Door | CDN + WAF | $200 |
| AI Foundry (Claude) | Batch API + caching, mixed Haiku/Sonnet | ~$8,000 |
| **TOTAL** | | **~$27,853/mo** |

**Major cost reduction levers at 10K users:**
- Spot VMs for 50%+ of sandbox pool: saves ~$5,000/mo
- AI prompt caching + Batch API + Haiku for simple tasks: saves ~$4,000/mo
- 1-year reserved instances: saves ~$2,000/mo
- Scale-to-zero sandbox pool at night: saves ~$2,000/mo
- Aggressive optimized cost: **~$18,000-20,000/mo**

---

## Appendix A: Azure Resource Naming Convention

```
{product}-{environment}-{region}-{resource-type}

Examples:
  bricks-prod-eastus-aks          # AKS cluster
  bricks-prod-eastus-pg           # PostgreSQL
  bricks-prod-eastus-redis        # Redis
  bricks-prod-eastus-kv           # Key Vault
  bricks-prod-eastus-vnet         # Virtual Network
  bricks-prod-eastus-log          # Log Analytics Workspace
  bricks-prod-eastus-ai           # App Insights
  bricksprodacr                   # ACR (globally unique, no hyphens)
  brickstfstateprod               # TF state storage (globally unique, no hyphens)
  bricks-global-dns               # DNS zone (shared across environments)
```

## Appendix B: Kubernetes Namespace Strategy

```
namespaces:
  kube-system          # AKS system components (CoreDNS, etc.)
  ingress-nginx        # NGINX Ingress Controller
  cert-manager         # cert-manager
  monitoring           # OTel collectors, Prometheus adapter
  bricks               # Bricks API, WebSocket server, frontend
  bricks-sandbox       # Sandbox pods (isolated, network-policied)
```

## Appendix C: Key Terraform Variables per Environment

```hcl
# environments/dev/terraform.tfvars
environment                = "dev"
aks_tier                   = "Free"
aks_system_node_count      = 2
aks_core_node_min          = 1
aks_core_node_max          = 3
aks_sandbox_node_min       = 1
aks_sandbox_node_max       = 5
pg_sku                     = "B_Standard_B2s"
pg_ha_enabled              = false
pg_storage_mb              = 32768
redis_sku                  = "Standard"
redis_family               = "C"
redis_capacity             = 0
enable_spot_pool           = false
enable_defender            = false

# environments/prod/terraform.tfvars
environment                = "prod"
aks_tier                   = "Standard"
aks_system_node_count      = 3
aks_core_node_min          = 2
aks_core_node_max          = 10
aks_sandbox_node_min       = 1
aks_sandbox_node_max       = 50
pg_sku                     = "GP_Standard_D4ds_v5"
pg_ha_enabled              = true
pg_storage_mb              = 131072
redis_sku                  = "Premium"
redis_family               = "P"
redis_capacity             = 1
enable_spot_pool           = true
enable_defender            = true
```

---

## Sources

- [Azure AKS Node Pool Best Practices](https://learn.microsoft.com/en-us/azure/aks/use-system-pools)
- [AKS Baseline Architecture](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/containers/aks/baseline-aks)
- [AKS Production Checklist](https://www.the-aks-checklist.com/)
- [AKS Automatic Managed System Node Pools](https://blog.aks.azure.com/2025/11/26/aks-automatic-managed-system-node-pools)
- [Azure VM Pricing (Standard_D4s_v5)](https://cloudprice.net/vm/Standard_D4s_v5)
- [AKS Pricing Guide](https://www.devzero.io/blog/aks-pricing)
- [AKS Pricing Overview](https://sedai.io/blog/understanding-azure-kubernetes-service-aks-pricing-costs)
- [Terraform AVM AKS Production Module](https://github.com/Azure/terraform-azurerm-avm-ptn-aks-production)
- [Terraform AKS Production Rollout Guide](https://medium.com/h7w/deploying-your-aks-cluster-with-terraform-key-points-for-a-successful-production-rollout-e92f1238906f)
- [Deploy AKS Automatic with Terraform and Helm](https://blog.aks.azure.com/2026/01/09/deploy-aks-automatic-terraform-helm)
- [Azure PostgreSQL Flexible Server Pricing](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)
- [Azure PostgreSQL Cost Optimization](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/how-to-cost-optimization)
- [Azure Cache for Redis Pricing](https://azure.microsoft.com/en-us/pricing/details/cache/)
- [Azure Managed Redis Pricing](https://azure.microsoft.com/en-us/pricing/details/managed-redis/)
- [Claude API Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- [Claude Pricing Guide 2026](https://www.finout.io/blog/claude-pricing-in-2026-for-individuals-organizations-and-developers)
- [cert-manager AKS Tutorial](https://cert-manager.io/docs/tutorials/getting-started-aks-letsencrypt/)
- [Let's Encrypt Wildcard Certs with Azure DNS](https://gist.github.com/marcopaga/1b6d045d85099cbf32456443a6e3cdf7)
- [cert-manager on AKS Setup (2026)](https://oneuptime.com/blog/post/2026-02-16-how-to-set-up-cert-manager-on-aks-for-automatic-lets-encrypt-tls-certificate-management/view)
- [Azure Blob Storage Pricing](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/)
- [Azure Blob Storage Pricing Guide](https://sedai.io/blog/azure-blob-storage-pricing)
- [Azure Container Registry SKUs](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-skus)
- [GitHub Actions AKS Deployment](https://learn.microsoft.com/en-us/azure/aks/kubernetes-action)
- [Helm Charts with Automated Rollbacks on AKS](https://oneuptime.com/blog/post/2026-02-16-how-to-deploy-applications-to-aks-using-helm-charts-with-automated-rollbacks/view)
- [OpenTelemetry on Azure](https://learn.microsoft.com/en-us/azure/azure-monitor/app/opentelemetry)
- [OpenTelemetry on AKS Setup](https://oneuptime.com/blog/post/2026-02-06-opentelemetry-azure-kubernetes-service-aks/view)
- [Azure Monitor OpenTelemetry Best Practices](https://learn.microsoft.com/en-us/azure/azure-monitor/app/opentelemetry-configuration)
