# Bricks Platform — Design Specification v2 (Reconciled)

> **Date**: 2026-04-08
> **Status**: Pending user review
> **Authority**: This is the SINGLE SOURCE OF TRUTH. Where it conflicts with any other document in the project, this document wins. The RECONCILIATION.md file documents every decision and its rationale.

---

## 1. What Is Bricks

Bricks is a web-based platform that gives users the full Claude Code experience in the browser. Users can write code, run terminals, install packages, run servers, and have Claude AI autonomously build, debug, and refactor their projects — all without installing anything.

### Target Audiences

| Audience | Experience | Primary Mode |
|----------|-----------|-------------|
| Non-technical users | Never used a terminal | **Builder Mode** — chat-first, AI does everything |
| Developers | Know code, want browser IDE | **IDE Mode** — full editor, terminal, AI as assistant |
| Teams/Organizations | Collaborative development | **IDE Mode** + shared projects, RBAC, audit logs |

### Core Capabilities

1. **Code editing** — Monaco Editor with IntelliSense, multi-file tabs, syntax highlighting
2. **Terminal** — Full terminal (xterm.js) connected to an isolated cloud sandbox
3. **AI Agent** — Claude (Opus/Sonnet/Haiku via Azure AI Foundry) autonomously reads/writes files, runs commands, debugs, searches, manages git
4. **App Preview** — See running web apps live at `{id}-{port}.bricks-preview.dev`
5. **File Management** — Full file tree, create/rename/delete, drag-and-drop
6. **Git Integration** — Clone, commit, push, pull, branch — connected to GitHub
7. **Two UX Modes** — Builder Mode (non-technical) and IDE Mode (developers), switchable

---

## 2. Canonical Technology Decisions

Every technology choice is listed once here. No other document may contradict these.

| Component | Choice | Alternatives Rejected | Rationale |
|-----------|--------|----------------------|-----------|
| **Frontend framework** | Next.js 16 (App Router) | SvelteKit, Remix | Largest ecosystem, React compat |
| **Code editor** | Monaco Editor | CodeMirror 6, Ace | Closest to VS Code, best IntelliSense |
| **Terminal** | xterm.js (WebGL renderer) | — | No alternative, industry standard |
| **Styling** | Tailwind CSS + shadcn/ui | Material UI, Chakra | Production-grade, consistent |
| **State management** | Zustand v5 (6 stores) | Redux, Jotai | Lightweight, no boilerplate |
| **Backend** | NestJS (TypeScript monolith) | Express, Fastify, Go | Full-stack TS, structured modules |
| **ORM** | Drizzle Kit | Prisma | 7KB runtime, SQL-visible, no binary |
| **Database** | Azure PostgreSQL Flexible | CosmosDB | RLS, relational integrity, mature |
| **Cache** | Azure Managed Redis | Memcached | Pub/sub, Streams, mature |
| **File storage** | Azure Blob Storage | Azure Files | Cheapest, SDK support |
| **Sandbox isolation** | Kata Containers on AKS | gVisor, Firecracker, plain Docker | Hardware VM, AKS-native, full Linux compat |
| **Node OS (AKS)** | AzureLinux 3 | Ubuntu, Windows | Required for Kata on AKS, actively supported |
| **Sandbox base image** | Ubuntu 24.04 LTS | 22.04 | EOL 2029 vs 2027, newer kernel |
| **Sandbox init** | s6-overlay | systemd, supervisord | Lightweight, proper supervision |
| **Network policies** | Cilium (eBPF) | Calico, Azure NPM | Azure NPM deprecated, eBPF features |
| **Ingress** | NGINX Ingress Controller | Traefik, Azure App Gateway | Single ingress, proven at scale |
| **WebSocket routing** | Go sandbox-router + Redis | NGINX only | Dynamic session→pod IP lookup |
| **Auth** | Clerk (free tier) | Azure AD B2C, Auth.js | B2C dead for new customers, Clerk has org support |
| **Billing** | Stripe (direct, not Clerk Billing) | Clerk Billing | Clerk Billing lacks metered/tax/refunds |
| **AI provider** | Claude via Azure AI Foundry | Direct Anthropic API | Azure credits, billing integration |
| **IaC** | Terraform | Bicep, Pulumi | Multi-cloud option, largest community |
| **CI/CD** | GitHub Actions | Azure DevOps | OIDC to Azure, single platform with code |
| **Preview domain** | `bricks-preview.dev` | subdomain of bricks.dev | CORS isolation, cookie separation |
| **Seccomp** | Default-deny (allowlist) | Default-allow (denylist) | Only secure option for untrusted code |

---

## 3. Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │         Bricks Frontend              │
                    │  Next.js 16 + Monaco + xterm.js      │
                    │  Azure Static Web Apps                │
                    └────────┬──────────────┬──────────────┘
                             │ HTTPS        │ 2x WSS
                             ▼              ▼
                    ┌────────────────────────────────────┐
                    │       NGINX Ingress Controller      │
                    │  /api/* → Bricks Core               │
                    │  /ws/core → Bricks Core             │
                    │  /ws/sandbox/:id → sandbox-router   │
                    │  *.bricks-preview.dev → sandbox-rtr │
                    └───┬──────────┬──────────┬──────────┘
                        │          │          │
           ┌────────────┘    ┌─────┘    ┌─────┘
           ▼                 ▼          ▼
┌──────────────────┐ ┌────────────┐ ┌──────────────────────┐
│   Bricks Core    │ │  Sandbox   │ │   Sandbox Pod        │
│   (NestJS)       │ │  Router    │ │   (1 per session)    │
│                  │ │  (Go)      │ │                      │
│  Modules:        │ │            │ │  ┌──────────────────┐ │
│  • Auth (Clerk)  │ │  Redis     │ │  │ Sandbox Daemon   │ │
│  • Projects      │ │  lookup:   │ │  │ (Node.js)        │ │
│  • AI Agent      │ │  session → │ │  │                  │ │
│  • Billing       │ │  pod IP    │ │  │ Listens on Unix  │ │
│  • Sessions      │ └────────────┘ │  │ socket (not TCP) │ │
│  • Usage         │                │  │                  │ │
│  • Teams         │                │  │ • Terminal (pty)  │ │
└──────────────────┘                │  │ • File watcher   │ │
                                    │  │ • LSP servers    │ │
  Data Layer:                       │  │ • Git ops        │ │
  ┌──────────────┐                  │  │ • Preview detect │ │
  │ Azure        │                  │  └──────────────────┘ │
  │ PostgreSQL   │                  │                      │
  │ (Drizzle ORM)│                  │  Isolation:          │
  ├──────────────┤                  │  • Kata Container    │
  │ Azure Blob   │                  │    (hardware VM)     │
  │ Storage      │                  │  • Seccomp allowlist │
  ├──────────────┤                  │  • Cilium netpol     │
  │ Azure Redis  │                  │  • No sudo for user  │
  │ (cache +     │                  │  • External DNS only │
  │  Streams)    │                  └──────────────────────┘
  └──────────────┘

  External:
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Azure AI     │  │ Stripe       │  │ Clerk        │
  │ Foundry      │  │ (billing)    │  │ (auth)       │
  │ (Claude API) │  │              │  │              │
  └──────────────┘  └──────────────┘  └──────────────┘
```

### Two WebSocket Connections Per User

| Connection | Destination | Purpose | Failure Mode |
|-----------|-------------|---------|--------------|
| **Sandbox WS** | Sandbox pod via sandbox-router | Terminal I/O, file sync, LSP | Terminal/editor frozen, AI chat still works |
| **Core WS** | Bricks Core | AI streaming, presence, notifications | AI unavailable, terminal/editor still works |

Protocol: JSON-RPC 2.0 for structured messages. Binary frames for terminal I/O (3-byte header).

---

## 4. Sandbox Architecture

### Pod Internals

- **Base**: Ubuntu 24.04 LTS (~4.5 GB image)
- **Init**: s6-overlay with `S6_READ_ONLY_ROOT=1`
- **Users**: root (PID 1 only), bricks (UID 1000, daemon), sandbox (UID 1001, user code)
- **Sudo**: bricks (UID 1000) has controlled sudo for package installation. sandbox (UID 1001) has NO sudo.
- **Pre-installed**: Node.js 22 LTS, Python 3.12, Go 1.23, Rust 1.80, Git, common build tools
- **Known limitation**: Bun has degraded performance (io_uring blocked by seccomp). Use Node.js or Deno instead.

### Daemon

- **Runtime**: Node.js, listens on **Unix socket** `/var/run/bricks/daemon.sock` (not TCP port — prevents user code from connecting)
- **Auth**: Pod-unique token in file readable only by UID 1000, validated on WebSocket upgrade
- **Capabilities**: Terminal manager (up to 8 PTY sessions), file watcher (Chokidar), LSP manager (up to 3 servers), git operations, port detection
- **Crash recovery**: s6 restarts within 1 second. Terminal scrollback preserved (10K lines per terminal)
- **Heap limit**: 256 MB (`--max-old-space-size=256`)

### Volume Mounts (ALL writable paths are volumes — Kata filesystem backed by VM memory)

| Path | Type | Purpose |
|------|------|---------|
| `/workspace` | Azure Disk PVC | User code (persisted) |
| `/tmp` | emptyDir (sizeLimit: 1Gi) | Scratch |
| `/var/log/bricks/` | emptyDir (sizeLimit: 50Mi) | Daemon logs |
| `/var/run/bricks/` | emptyDir | Daemon socket + state |
| `/home/bricks/` | emptyDir | Daemon home |
| `/home/sandbox/` | emptyDir | User home |

### Resource Tiers

| Tier | CPU (limit) | RAM (limit) | Disk (PVC) | Idle Timeout | Effective User RAM |
|------|------------|------------|-----------|-------------|-------------------|
| Free | 1 vCPU | 2 GB | 5 GB (P2) | 10 min | ~1.5 GB |
| Pro | 2 vCPU | 4 GB | 20 GB (P10) | 30 min | ~3.5 GB |
| Team | 4 vCPU | 8 GB | 50 GB (P15) | 2 hrs | ~7.5 GB |

**Note**: Kata VM overhead (~256 MB) + daemon (~100 MB) + chokidar (~30 MB) consumes ~400 MB. "Effective User RAM" is what remains for user code, LSP, dev servers.

**LSP on Free tier**: Opt-in with warning ("Language features require ~500 MB RAM. Enable?"). TypeScript LSP capped at 768 MB. Rust LSP Pro/Team only.

### Lifecycle State Machine

```
CREATING → ACTIVE → IDLE → SNAPSHOTTING → SUSPENDED → (RESTORING → ACTIVE)
                                                     → DESTROYED → ARCHIVED
```

- Network disconnect does NOT kill the pod — processes run in "headless" mode, terminal output buffered
- Pre-snapshot: signal user DBs for graceful shutdown, remove lock files, sync
- Snapshot: Azure Disk Snapshot (incremental, <5s create)
- Restore: 10-30s from snapshot

### Isolation (9 Layers)

1. **Kata Containers** — hardware VM boundary (hypervisor escape = $500K+ bounty class)
2. **Pod Security Standards** — Restricted profile
3. **Seccomp** — Default-deny allowlist (io_uring blocked)
4. **AppArmor** — Custom profile
5. **Capabilities** — ALL dropped, only NET_BIND_SERVICE added
6. **Read-only root** — All writable paths are explicit volume mounts
7. **Non-root user** — UID 1001 for user code, no sudo
8. **Cilium network policies** — Pod-to-pod blocked, IMDS blocked (169.254.0.0/16), Wireserver blocked (168.63.129.16), internal DNS blocked
9. **Resource limits** — CPU/memory/PID/disk per tier

### App Preview

- **URL**: `{sandboxId}-{port}.bricks-preview.dev` (separate domain from main app)
- **Routing**: NGINX → sandbox-router → correct pod + port
- **Port detection**: `/proc/net/tcp` polling (2s interval)
- **HMR**: Environment variable injection (WDS_SOCKET_HOST, VITE_HMR_HOST)
- **Auth**: Public by default (user can toggle "Require auth" per project)
- **WebSocket passthrough**: Supported for Socket.IO, HMR

### DNS

`dnsPolicy: None`, nameservers: `[8.8.8.8, 8.8.4.4]`. Sandboxes CANNOT resolve internal cluster DNS.

### Honest Performance Targets

| Scenario | Target |
|----------|--------|
| New empty workspace (warm pool) | p95 < 5s |
| New workspace with git clone | p95 < 20s |
| Restore from snapshot | p95 < 15s |
| Cold start (no warm pool) | p95 < 60s |

---

## 5. AI Agent System

### Agentic Loop

```
User message → Bricks Core (AI module)
  → Build messages array (system + history + user message)
  → Budget check (estimated cost < remaining budget?)
  → Call Claude via Azure AI Foundry (streaming)
  → While stop_reason == "tool_use":
      → Parse tool calls
      → Read-only tools: execute in parallel inside sandbox
      → Mutating tools: execute sequentially inside sandbox
      → Track actual cost from response usage field
      → Stream progress to frontend via Core WS
      → Checkpoint every 10 iterations (to Blob, not JSONB)
  → Final response streamed to user
  → Track total cost (actual, not estimated)

Guards:
  • Max 200 iterations (pause_turn COUNTS toward limit)
  • Budget ceiling: $10 Builder / $5 IDE / $2 Free per conversation
  • 15-minute total timeout
  • Oscillation detection: if error messages repeat >80% similarity over 5 iterations, inject "you appear stuck" system message
  • SubAgent limit: max 3 concurrent, 10 total per conversation, costs roll up to parent budget
  • Concurrent conversation limit: Free 1, Pro 3, Team 5/member
```

### 14 Tools

| Tool | Type | Builder Mode | IDE Mode |
|------|------|-------------|----------|
| FileRead | Read-only | Auto-approve | Auto-approve |
| FileWrite | Mutating | Auto-approve + logged | **Stage → diff → accept/reject** |
| FileEdit | Mutating | Auto-approve + logged | **Stage → diff → accept/reject** |
| FileDelete | Mutating | Auto-approve + logged | User confirmation |
| FileMove | Mutating | Auto-approve + logged | User confirmation |
| Glob | Read-only | Auto-approve | Auto-approve |
| Grep | Read-only | Auto-approve | Auto-approve |
| Bash | Mutating | **User confirmation always** | User confirmation |
| Git | Mutating | Auto-approve + logged | User confirmation |
| BrowserPreview | Read-only | Auto-approve | Auto-approve |
| WebSearch | Read-only | Auto-approve | Auto-approve |
| WebFetch | Read-only | Auto-approve | Auto-approve |
| SubAgent | Read-only | Auto-approve | Auto-approve |
| AskUser | Special | Show prompt | Show prompt |

**IDE Mode file edits**: Written to `.bricks_staging/{path}`. Diff shown. User accepts → atomic rename. User rejects → delete staged, return rejection to Claude. File is NEVER modified before approval.

**Builder Mode**: Every conversation turn creates a filesystem snapshot. "Undo last turn" button always visible.

### File Edit Atomicity

1. Read file, validate search string uniqueness
2. Apply edit to temp file `.bricks_tmp_{name}`
3. Advisory file lock (flock) prevents concurrent edits
4. IDE: show diff from staging. Builder: atomic rename to target.

### AI Model Configuration

| Model | Context | Pricing (per MTok) | Usage |
|-------|---------|-------------------|-------|
| Opus 4.6 | 1M tokens | $15 in / $75 out | Complex reasoning (user-selected) |
| Sonnet 4.6 | 1M tokens | $3 in / $15 out | **Default for all users** |
| Haiku 4.5 | 200K tokens | $0.80 in / $4 out | Titles, summaries, SubAgent tasks |

- **v1**: No automatic routing. Default Sonnet. User manually selects Opus.
- **Free tier**: Sonnet only.
- **Prompt caching**: 90% input cost reduction on cache hits (5-min ephemeral TTL)

### Context Management

- Partition: ~14K fixed (system + tools), ~900K conversation, ~16K output reserve
- **Compaction at 700K tokens**: Summarize using SAME model as conversation (not cheaper model). Max summary: 16K tokens. Delivered as system message, never fabricated assistant message.
- **max_tokens**: Dynamic based on expected output (16K default, increased for FileWrite of large files)

### Streaming

9 event types over Core WS via Redis Streams (ordered, persistent):
`ai/stream/status`, `ai/stream/token`, `ai/stream/tool`, `ai/stream/diff`, `ai/stream/blockEnd`, `ai/stream/done`, `ai/stream/error`, `ai/stream/cost`, `ai/stream/askUser`

**Partial stream failure**: Discard incomplete message, retry full API call (max 3), never execute partial tool calls.

---

## 6. Frontend

### Tech Stack

- Next.js 16 (App Router), Monaco Editor, xterm.js, Tailwind + shadcn/ui
- Zustand v5 (6 client-only stores — NO SSR hydration)
- react-resizable-panels, Clerk React SDK, React Query (REST only, not WebSocket data)
- `mitt` event bus for cross-store communication (typed, synchronous ordering)

### Routes

| Group | Key Routes | Rendering |
|-------|-----------|-----------|
| Marketing | `/`, `/pricing` | SSR + ISR |
| Auth | `/sign-in`, `/sign-up` | SSR |
| Dashboard | `/dashboard`, `/projects`, `/settings`, `/billing` | CSR (protected) |
| Workspace | `/w/:projectId` | CSR (protected, `'use client'` at layout level) |

### Two WebSocket Connection Management

`ConnectionManager` class coordinates:
- `SandboxConnection` — WS to sandbox pod
- `CoreConnection` — WS to Bricks Core
- Independent reconnection with full jitter: `random(0, min(30s, 500ms * 2^attempt))`
- Client-side circuit breaker: 5 failures → open state → manual retry button
- Ring buffers: Sandbox 5,000 messages, Core 2,000 messages
- On buffer overflow: full state sync (file tree manifest + open files from sandbox, conversation reload from DB)

### Error Boundaries (Mandatory)

| Boundary | Wraps | Fallback |
|----------|-------|----------|
| `WorkspaceErrorBoundary` | Entire workspace | "Something went wrong, reload workspace" |
| `EditorPanelBoundary` | Monaco editor | "Editor crashed, click to reload" |
| `TerminalPanelBoundary` | xterm.js | "Terminal disconnected, reconnect" |
| `AIChatBoundary` | AI chat panel | "Chat error, click to retry" |
| `PreviewPanelBoundary` | Preview iframe | "Preview unavailable" |

### Content Security Policy

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
connect-src 'self' wss://*.bricks.dev https://*.bricks.dev;
frame-src https://*.bricks-preview.dev;
img-src 'self' data: blob:;
font-src 'self';
```

### WebSocket Message Authorization

Every message includes `sessionToken` (Clerk, refreshed every 60s). Channel-level permissions enforced server-side. Connection hijack via XSS in preview iframe impossible because preview is on separate domain.

### Monaco Memory Management

- Max 10 active models (LRU eviction on 11th)
- Disposed models reload from sandbox on tab focus
- Persist middleware stores tab metadata only (path, cursor), NOT file contents
- `Map` types replaced with plain objects for JSON serialization

### Mobile (< 768px)

Builder Mode only. Full-width stacked layout:
- AI chat (scrollable)
- "Preview" button → fullscreen overlay
- "View Code" button → fullscreen code viewer
- IDE Mode: "Desktop recommended" interstitial

### LSP Integration

Tunneled through sandbox WebSocket (NOT separate connections). LSP messages wrapped in `lsp/request` and `lsp/notify` JSON-RPC methods. Return type: `Promise<MonacoLanguageClient>` with 10s connection timeout and error handling.

### Honest Performance Targets

| Scenario | Target |
|----------|--------|
| Cold start (new sandbox + first visit) | < 8s |
| Warm sandbox + first visit | < 4s |
| Warm sandbox + cached assets | < 2s |
| Returning visit (all warm) | < 1.5s |

---

## 7. Data Layer

### Database: Azure PostgreSQL Flexible Server

**Canonical schema**: `schema.sql` (ONLY source of truth)

**18 tables** (original 15 + credit_ledger + stripe_events + credit_purchases):
- Users, organizations, org_members, invitations
- Projects, project_environment_variables, project_snapshots
- Sessions, conversations, conversation_branches, messages
- Subscriptions, usage_records, billing_events, audit_log
- **credit_ledger** — grants, deductions, expirations with running balance
- **stripe_events** — idempotent webhook processing
- **credit_purchases** — one-time credit top-ups

**Key fixes from review**:
- UUID v7 via `pg_uuidv7` extension (not `gen_random_uuid()` which is v4)
- `org_id` denormalized onto `messages` table (eliminates correlated subquery in RLS)
- Organizations RLS: `id IN (SELECT org_id FROM org_members WHERE user_id = current_user_id())`
- Audit log RLS: `org_id = current_org_id() OR org_id IS NULL`
- Messages CHECK: `(content IS NOT NULL AND blob_ref IS NULL) OR (content IS NULL AND blob_ref IS NOT NULL)`
- Column name standard: `clerk_user_id` (not `clerk_id`). All PKs UUID (no BIGSERIAL).

**RLS context**: `SET LOCAL app.current_org_id = $1` in transaction (auto-cleared on commit). Enforced via `withOrgContext(orgId, callback)` Drizzle helper.

### Blob Storage (5 containers)

| Container | Purpose |
|-----------|---------|
| `project-files` | Active project data |
| `project-snapshots` | Disk snapshot archives |
| `conversation-blobs` | Large message content (> 4KB) |
| `user-uploads` | User file uploads |
| `exports` | Data export requests (GDPR) |

### Redis

- Session → pod IP mapping (sandbox-router)
- Usage quota counters (sub-millisecond checks)
- **Redis Streams** for AI streaming events (ordered, persistent, consumer groups)
- Redis pub/sub for ephemeral events only (presence, typing)
- Reconciliation with PostgreSQL every 60s (PostgreSQL is source of truth; direction: PG → Redis)

---

## 8. Security

### Authentication (Clerk)

- 60-second JWT lifetimes
- HttpOnly cookies (not localStorage)
- WebSocket upgrade: 30-second single-use token in query param. NGINX configured to strip query params from logs.
- Organizations for multi-tenancy RBAC (Owner/Admin/Member/Viewer)

### Credential Handling — Honest Threat Model

Sandbox pods contain NO API keys, database credentials, or billing secrets. The only credential present is a **short-lived (1-hour) GitHub OAuth token** injected via `GIT_ASKPASS` script when a git operation is requested, scoped to user's authorized repositories. Cleared after operation completes. Risk accepted: malicious code within the sandbox can intercept this token during the operation window. The 1-hour expiry and repo-scoped permissions limit blast radius.

### Network Security (Cilium)

- Pod-to-pod: **BLOCKED**
- IMDS (169.254.0.0/16): **BLOCKED**
- Azure Wireserver (168.63.129.16): **BLOCKED**
- Internal cluster DNS: **BLOCKED** (external DNS only)
- Kubernetes API server: **BLOCKED**
- Internet (80, 443, 22, 9418): **ALLOWED** (for npm, pip, git)
- Outbound rate limit: 100 new connections/minute

### Must-Verify During Phase 1 POC

- [ ] Kata Containers: resource requests limitation confirmed on AKS
- [ ] Kata Containers: host iptables IMDS blocking applies inside Kata VM
- [ ] Kata Containers: Azure Disk PVC mount works correctly
- [ ] AzureLinux 3: Kata runtime class compatibility
- [ ] Cilium: works with Kata on AKS
- [ ] pg_uuidv7 extension available on Azure PostgreSQL Flexible Server

### CVEs to Mitigate at Ingress

- Next.js CVE-2025-29927 (CVSS 9.1): Block `x-middleware-subrequest` header in NGINX config

---

## 9. Billing

### Plans (CANONICAL — single source of truth)

| Resource | Free | Pro ($20/mo) | Team ($50/seat/mo) |
|----------|------|-------------|-------------------|
| AI Credits | 100/mo | 1,000/mo | 2,500/seat/mo |
| Compute | 2 hrs/day | Unlimited | Unlimited |
| Storage | 2 GB | 10 GB | 25 GB/seat |
| Idle Timeout | 10 min | 30 min | 2 hrs |
| Concurrent Sessions | 1 | 3 | 5/member |
| Max Projects | 3 | 20 | Unlimited |
| Concurrent AI Conversations | 1 | 3 | 5/member |
| AI Models | Sonnet only | All | All |
| AI Budget/Conversation | $2 | $5 | $10 |

### Credit System

- **1 credit = 10,000 weighted tokens**
- Model multipliers: Haiku 1x, Sonnet 3x, **Opus 10x**
- Deducted on completion (failed calls not charged)
- Pre-check: if remaining credits < minimum cost estimate, block before API call
- Overdraft cap: 10 credits (safety net only)
- Credit types: plan > bonus > purchased (deduction: bonus first by expiry)
- Team: shared pool with default 20%/day per-member hard cap (admin adjustable)

### Stripe Integration

- Stripe Checkout (not embedded forms)
- Stripe Meters API for overage: idempotency key = `overage_${userId}_${usageRecordId}` (deterministic)
- Flush to Stripe every 15 minutes with exactly-once semantics (reporting_started_at + reported_at state machine)
- Stripe Tax for automatic tax calculation
- Overage price: $0.05/credit (breakeven with Opus caching)

---

## 10. Infrastructure

### AKS Cluster — 4 Node Pools

| Pool | VM SKU | Nodes | Purpose | Spot? |
|------|--------|-------|---------|-------|
| System | D2s_v5 | 3 (fixed) | K8s system components | No |
| Core | D4s_v5 | 2-10 (HPA) | Bricks Core, sandbox-router | No |
| Sandbox | D4s_v5 | 1-50 (autoscale) | User sandbox pods | No |
| Sandbox-Spot | D4s_v5 | 0-30 | Free tier overflow | **Yes** |

**Sandbox pool min_count: 1** (not 0 — avoids cold start from zero nodes).

Spot instances for **Free tier only** (acceptable disruption). Pro/Team use regular VMs. Pre-eviction: save file list + modified files to PVC, save terminal scrollback.

Pod-per-node limits enforced via topology constraints (Kata doesn't support resource requests for scheduling).

### Deployment

- Terraform (Azure Verified Modules), state in Azure Blob Storage
- GitHub Actions with OIDC (no stored secrets)
- Rolling updates with `helm --atomic`
- **`terminationGracePeriodSeconds: 300`** for WebSocket-holding pods
- **`preStop` hook**: Send `CONNECTION_DRAINING` to clients, wait 10s, close
- **PodDisruptionBudget**: `maxUnavailable: 1` for sandbox-router
- cert-manager + Let's Encrypt (DNS-01 via Azure DNS, staging issuer alongside production)
- Wildcard cert for `*.bricks-preview.dev`

### Monitoring

- Azure Monitor Metrics + Azure Managed Grafana
- Azure Log Analytics for logs
- OpenTelemetry → Application Insights for distributed tracing
- Alerts: 4 severity tiers

### Honest Uptime Targets

| Service | Target |
|---------|--------|
| Web UI loads | 99.9% |
| Sandbox available | 99.5% |
| AI available | 99.0% |
| Overall | 99.0% |

### Estimated Costs (Honest)

| Users | Monthly Cost |
|-------|-------------|
| 100 | ~$2,500-3,500 |
| 1,000 | ~$8,000-12,000 |
| 10,000 | ~$25,000-40,000 |

Unit economics are negative at current pricing. Accepted — optimize later with real usage data.

---

## 11. Phased Delivery (Realistic)

| Phase | Scope | Duration |
|-------|-------|----------|
| **1: Foundation + POC** | Terraform, AKS, PostgreSQL, Redis, Blob, ACR, CI/CD, NestJS scaffold, Clerk auth, DB schema, Next.js scaffold, **Kata POC verification** | 6-8 weeks |
| **2: Sandbox + Editor** | Base image, daemon, sandbox-router, Kata + Cilium on AKS, pod lifecycle, Monaco integration, xterm.js, file tree, two WS connections | 6-8 weeks |
| **3: AI Agent** | Claude via Foundry, agentic loop, 14 tools, tool execution bridge, streaming, Builder + IDE modes, diff viewer, accept/reject, undo system | 4-6 weeks |
| **4: Preview + Git** | Wildcard DNS, preview routing, port detection, HMR, git credential helper, GitHub integration, clone/push/pull UI | 3-4 weeks |
| **5: Billing + Polish** | Stripe subscriptions, credit system, quota enforcement, usage dashboard, onboarding, templates, security hardening, accessibility basics, operational runbooks | 4-6 weeks |
| **6: Launch Prep** | Load testing, security testing, monitoring dashboards, DR verification, beta testing | 2-4 weeks |

**Total realistic range: 25-36 weeks**

Phase 1 includes a critical **Kata POC verification** before any further design assumptions are committed to code.

---

## 12. Document Reference

| Document | Role |
|----------|------|
| **This spec (v2)** | SINGLE SOURCE OF TRUTH |
| `RECONCILIATION.md` | Decision rationale for every resolved issue |
| `Review/BRICKS-SPEC-REVIEW.md` | Original 182-issue review |
| `schema.sql` | Canonical database schema (must match this spec) |
| `RESEARCH.md` | Technology research and sources |
| Other .md files | Reference only — where they conflict with this spec, this spec wins |
