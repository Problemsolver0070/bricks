# Bricks Platform — Design Specification

> **Date**: 2026-04-08
> **Status**: Pending user review
> **Detailed designs**: See individual deep-dive documents in project root

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

1. **Code editing** — Monaco Editor (VS Code's editor) with IntelliSense, multi-file tabs, syntax highlighting for all major languages
2. **Terminal** — Full terminal (xterm.js) connected to an isolated cloud container
3. **AI Agent** — Claude Opus 4.6 autonomously reads/writes files, runs commands, debugs, searches codebases, manages git
4. **App Preview** — See running web apps live in the browser with hot reload
5. **File Management** — Full file tree, create/rename/delete, drag-and-drop
6. **Git Integration** — Clone, commit, push, pull, branch — connected to GitHub
7. **Real-time Collaboration** — (Phase 2) Multiple users editing the same project via Y.js CRDTs
8. **Two UX Modes** — Builder Mode (non-technical) and IDE Mode (developers), switchable

---

## 2. Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │         Bricks Frontend              │
                    │  Next.js 16 + Monaco + xterm.js      │
                    │  Azure Static Web Apps                │
                    └────────┬──────────────┬──────────────┘
                             │ HTTPS        │ WSS
                             ▼              ▼
                    ┌────────────────────────────────────┐
                    │       NGINX Ingress Controller      │
                    │  • /api/* → Bricks Core             │
                    │  • /ws/sandbox/:id → sandbox-router  │
                    │  • /ws/core → Bricks Core            │
                    │  • *.preview.bricks.dev → sandbox    │
                    └───┬──────────┬──────────┬───────────┘
                        │          │          │
           ┌────────────┘    ┌─────┘    ┌─────┘
           ▼                 ▼          ▼
┌──────────────────┐ ┌────────────┐ ┌──────────────────────┐
│   Bricks Core    │ │  Sandbox   │ │   Sandbox Pod        │
│   (NestJS        │ │  Router    │ │   (1 per session)    │
│    monolith)     │ │  (Go)      │ │                      │
│                  │ │            │ │  ┌──────────────────┐ │
│  Modules:        │ │  Redis     │ │  │ Sandbox Daemon   │ │
│  • Auth (Clerk)  │ │  session → │ │  │ (Node.js)        │ │
│  • Projects      │ │  pod IP    │ │  │ • Terminal (pty)  │ │
│  • AI Agent      │ │  lookup    │ │  │ • File watcher   │ │
│  • Billing       │ │            │ │  │ • LSP servers    │ │
│  • Sessions      │ └────────────┘ │  │ • Git ops        │ │
│  • Usage         │                │  │ • Preview proxy  │ │
│  • Teams         │                │  └──────────────────┘ │
└──────────────────┘                │                      │
                                    │  Isolation:          │
  ┌──────────────┐                  │  Kata Containers     │
  │ Azure        │                  │  (hardware VM)       │
  │ PostgreSQL   │                  └──────────────────────┘
  │ (15 tables,  │
  │  RLS)        │                  ┌──────────────────────┐
  ├──────────────┤                  │ Azure AI Foundry     │
  │ Azure Blob   │                  │ Claude Opus 4.6      │
  │ Storage      │                  │ Claude Sonnet 4.6    │
  │ (5 containers│                  │ Claude Haiku 4.5     │
  ├──────────────┤                  └──────────────────────┘
  │ Azure Redis  │
  │ (cache +     │                  ┌──────────────────────┐
  │  pub/sub)    │                  │ Stripe               │
  └──────────────┘                  │ (billing + payments) │
                                    └──────────────────────┘
```

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend pattern | Modular monolith (NestJS) | Ship fast, debug easy, split later |
| Sandbox isolation | Kata Containers on AKS | Hardware VM boundary, full Linux compat |
| WebSocket routing | Go sandbox-router + Redis | NGINX can't do dynamic session→pod lookup |
| Connections per user | 2 WebSocket connections | Sandbox (terminal/files/LSP) + Core (AI/presence) — independent failure domains |
| Protocol | JSON-RPC 2.0 + binary frames | JSON-RPC is native LSP; binary for terminal I/O |
| Code editor | Monaco Editor | Closest to VS Code, best IntelliSense |
| State management | Zustand (6 stores) | Lightweight, no boilerplate |
| ORM | Drizzle Kit | 7KB runtime, SQL-visible, surpassed Prisma |
| Multi-tenancy | Shared schema + PostgreSQL RLS | Scales to thousands of tenants, single DB |
| Auth | Clerk (free tier) | Pre-built components, Stripe integration, Organizations |
| Init system (sandbox) | s6-overlay | Lightweight, proper process supervision |
| File persistence | Azure Disk PVC + Disk Snapshots | Block-level snapshots capture node_modules without per-file overhead |
| App preview | Wildcard subdomains via Traefik | `{sandboxId}-{port}.preview.bricks.dev` |

---

## 3. Frontend

**Detailed design**: `FRONTEND_ARCHITECTURE.md` (2,319 lines)

### Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Editor**: Monaco Editor (dynamic import, SSR disabled)
- **Terminal**: xterm.js with WebGL renderer
- **Styling**: Tailwind CSS + shadcn/ui
- **State**: Zustand v5 (6 stores: editor, terminal, AI, session, file-tree, layout)
- **Panels**: react-resizable-panels
- **Auth**: Clerk React SDK
- **Data fetching**: React Query (server state)

### Route Map

| Route Group | Routes | Rendering |
|-------------|--------|-----------|
| Marketing | `/`, `/pricing`, `/blog` | SSR + ISR |
| Auth | `/sign-in`, `/sign-up` | SSR |
| Dashboard | `/dashboard`, `/projects`, `/settings`, `/billing` | CSR (protected) |
| Workspace | `/w/:projectId` | CSR (protected, heavy) |
| Team Admin | `/org/:slug/members`, `/org/:slug/settings` | CSR (protected) |

### Two UX Modes

**Builder Mode** (non-technical):
- Chat-first layout: 40% AI conversation, 60% live preview
- No code visible by default ("View Code" optional overlay)
- AI auto-accepts changes, auto-commits
- Errors translated to plain language

**IDE Mode** (developers):
- VS Code-like layout: file explorer, editor tabs, terminal, AI sidebar
- Full diff review for AI changes (accept/reject per file)
- Terminal visible, multiple tabs
- Git panel, problems panel, output panel

### Performance Targets

- Workspace load: < 800ms to interactive editor
- WebSocket connection: < 200ms establishment
- Monaco lazy-loaded (not in initial bundle)
- Single multiplexed WebSocket per connection type

---

## 4. Backend — Bricks Core

**Detailed design**: Spans multiple docs

### NestJS Modular Monolith

```
src/
├── modules/
│   ├── auth/          # Clerk JWT validation, guards, RBAC
│   ├── projects/      # CRUD, settings, environment variables
│   ├── sessions/      # Sandbox lifecycle, pod management via K8s API
│   ├── ai/            # Agent loop, Claude API, tool execution
│   ├── billing/       # Stripe subscriptions, usage metering, credits
│   ├── teams/         # Organizations, memberships, invitations
│   └── usage/         # Real-time usage tracking, quota enforcement
├── common/
│   ├── guards/        # Auth guard, quota guard, role guard
│   ├── interceptors/  # Logging, error handling, usage tracking
│   ├── filters/       # Exception filters
│   └── pipes/         # Validation pipes
├── websocket/         # Core WebSocket gateway (AI streaming, presence)
├── database/          # Drizzle schema, migrations
└── config/            # Environment, feature flags
```

### API Surface

**REST Endpoints:**
- `POST /api/v1/projects` — Create project
- `GET /api/v1/projects` — List projects
- `POST /api/v1/sessions` — Start sandbox session (returns WSS URLs)
- `DELETE /api/v1/sessions/:id` — Stop session
- `POST /api/v1/ai/message` — Send message to Claude (returns SSE stream)
- `GET /api/v1/billing/usage` — Usage dashboard data
- `POST /api/v1/billing/checkout` — Create Stripe Checkout session

**WebSocket (Core connection):**
- `ai/stream/*` — AI response streaming (9 event types)
- `presence/*` — User presence for collaboration
- `notification/*` — System notifications

### Sandbox Lifecycle (via Kubernetes API)

```
User clicks "Open Project"
  → Core creates Session record (DB)
  → Core calls K8s API: create Pod with project config
  → Pod pulls pre-cached image, mounts PVC
  → s6-overlay starts sandbox daemon
  → Daemon registers with Redis (session→podIP mapping)
  → Core returns WSS URL to frontend
  → Frontend connects directly to sandbox pod via sandbox-router

User goes idle (5 min no activity)
  → Daemon detects idle, notifies Core
  → Resource throttling applied (CPU reduced)

User idle 35 min
  → Core triggers snapshot (Azure Disk Snapshot)
  → Pod suspended (processes stopped, PVC retained)

User returns
  → Core restores from snapshot
  → Pod resumes, daemon reconnects
  → Frontend re-establishes WebSocket
  → Terminal scrollback replayed (10K lines)
```

---

## 5. Sandbox Architecture

**Detailed design**: `SANDBOX-DESIGN.md` (1,939 lines)

### Base Image

- **OS**: Ubuntu 22.04 LTS
- **Size**: ~4.5 GB uncompressed
- **Pre-installed**: Node.js 22 LTS, Python 3.12, Go 1.23, Rust 1.80, Git, common build tools
- **Init**: s6-overlay (lightweight process supervisor)
- **Users**: root (PID 1 only), bricks (UID 1000, daemon), sandbox (UID 1001, user code)

### Sandbox Daemon (Node.js)

Single process managing everything inside the pod:
- **WebSocket server** on port 8080 (JSON-RPC 2.0 + binary frames)
- **Terminal manager**: Up to 8 concurrent PTY sessions via node-pty
- **File watcher**: Chokidar with debouncing, .bricksignore exclusions
- **LSP manager**: Up to 3 language servers, lazy start, 5-min idle shutdown
- **Git operations**: Custom credential helper with injected OAuth tokens
- **Preview proxy**: Detects open ports via `/proc/net/tcp`, routes via Traefik

### Resource Tiers

| Tier | CPU | RAM | Disk | Idle Timeout | Session Limit |
|------|-----|-----|------|-------------|---------------|
| Free | 0.5 vCPU | 1 GB | 5 GB | 15 min | 2 hrs/day |
| Pro | 2 vCPU | 4 GB | 20 GB | 35 min | Unlimited |
| Team | 4 vCPU | 8 GB | 50 GB | 2 hrs | Unlimited |

### Isolation: 9-Layer Defense

1. Kata Containers (hardware VM boundary)
2. Pod Security Standards (Restricted)
3. Custom seccomp profile (block dangerous syscalls)
4. Custom AppArmor profile
5. All capabilities dropped
6. Read-only root filesystem (writable /workspace overlay)
7. Non-root execution (UID 1001 for user code)
8. Cilium network policies (pod-to-pod blocked, IMDS blocked)
9. Resource limits (CPU/memory/PID/disk)

### File Persistence

- **Hot**: Azure Disk PVC (attached to pod)
- **Warm**: Azure Disk Snapshots (incremental, <5s create, 10-30s restore)
- **Cold**: tar.gz to Azure Blob Storage (long-term archive)
- **node_modules**: Lives on PVC, captured by block-level snapshots (file-count agnostic)

### App Preview

- **URL pattern**: `{sandboxId}-{port}.preview.bricks.dev`
- **Routing**: Wildcard DNS → Traefik → sandbox pod
- **Port detection**: Automatic via `/proc/net/tcp` polling
- **HMR support**: Environment variable injection for Vite/Webpack dev servers
- **WebSocket passthrough**: Supports Socket.IO, HMR WebSocket connections

---

## 6. AI Agent System

**Detailed design**: `AI_AGENT_SYSTEM_DESIGN.md` (2,514 lines)

### Agentic Loop

```
User message → Bricks Core (AI module)
  → Build messages array (system + history + user message)
  → Call Claude via Azure AI Foundry (streaming)
  → While stop_reason == "tool_use":
      → Parse tool calls
      → Read-only tools: execute in parallel
      → Mutating tools: execute sequentially
      → Send results back to Claude
      → Stream progress to frontend
  → Final response streamed to user

Guards:
  • Max 200 iterations per turn
  • Per-conversation USD budget ceiling
  • 15-minute total timeout
  • Stuck-loop detection (5 identical calls → intervention)
  • Checkpoint every 10 iterations for crash recovery
```

### 14 Tools

| Tool | Type | Description |
|------|------|-------------|
| FileRead | Read-only | Read file contents |
| FileWrite | Mutating | Write/create file |
| FileEdit | Mutating | Surgical string replacement |
| FileDelete | Mutating | Delete file |
| FileMove | Mutating | Rename/move file |
| Glob | Read-only | Find files by pattern |
| Grep | Read-only | Search file contents |
| Bash | Mutating | Run shell command (with background support) |
| Git | Mutating | Git operations (status, commit, push, pull, branch) |
| BrowserPreview | Read-only | Headless Chromium screenshot of running app |
| WebSearch | Read-only | Search the web |
| WebFetch | Read-only | Fetch URL content |
| SubAgent | Read-only | Delegate subtask to cheaper model |
| AskUser | Special | Ask user a clarifying question |

### Multi-Model Routing

| Model | Use Case | Cost (per 1M tokens) |
|-------|----------|---------------------|
| Opus 4.6 | Complex reasoning, multi-step tasks | $15 input / $75 output |
| Sonnet 4.6 | Routine edits, simple questions | $3 input / $15 output |
| Haiku 4.5 | Titles, summaries, trivial tasks | $0.80 input / $4 output |

- Rule-based routing with complexity estimation
- Free tier locked to Sonnet
- User can always override model choice

### Context Management

- **Window**: 1M tokens on Azure AI Foundry
- **Partition**: ~14K fixed (system + tools), ~900K conversation, ~16K output reserve
- **Prompt caching**: 90% cost reduction on fixed prefix after first turn (5-min ephemeral TTL)
- **Auto-compaction**: At 800K tokens, summarize older messages using Sonnet (cheaper)

### Builder vs IDE Mode

| Aspect | Builder Mode | IDE Mode |
|--------|-------------|----------|
| System prompt | Emphasizes autonomy, non-technical language | Emphasizes collaboration, technical detail |
| Tool permissions | Auto-approve most tools | User reviews mutating operations |
| Change display | Simplified notifications | Full diffs with accept/reject |
| Commits | Auto-commit | User-initiated |
| Error display | Plain language explanation | Full error output + stack traces |

---

## 7. WebSocket & Real-Time

**Detailed design**: `WEBSOCKET_REALTIME_ARCHITECTURE.md` (1,518 lines)

### Two Connections Per User

| Connection | Destination | Purpose | Protocol |
|-----------|-------------|---------|----------|
| Sandbox WS | Sandbox pod (via sandbox-router) | Terminal I/O, file sync, LSP | JSON-RPC 2.0 + binary |
| Core WS | Bricks Core API | AI streaming, presence, notifications | JSON-RPC 2.0 |

### Sandbox-Router (Go)

Lightweight reverse proxy between NGINX Ingress and sandbox pods:
1. Frontend requests WebSocket upgrade to `/ws/sandbox/:sessionId`
2. NGINX routes to sandbox-router
3. Router does single Redis lookup: `session:{id}` → pod IP
4. Proxies WebSocket directly to pod (holds connection open)
5. ~0.5ms added latency (per-connection, not per-message)

### Message Protocol

**JSON-RPC 2.0 for structured messages:**
```json
{"jsonrpc":"2.0","method":"terminal/input","params":{"terminalId":1,"data":"ls\n"},"id":42}
```

**Binary frames for terminal output** (3-byte header: channel + terminal ID):
```
[0x01][0x00][0x01][...terminal bytes...]
```

### Reconnection Strategy

1. Client tracks last received sequence number
2. On reconnect, sends `sync/resume` with last sequence
3. Server replays missed messages from 1000-message ring buffer
4. If buffer exceeded (>5 min disconnect): full state sync (file tree + open files)
5. Terminal: 10K line scrollback preserved, new PTY spawned

### AI Streaming Events (9 types)

`ai/stream/status` → "Claude is thinking..."
`ai/stream/token` → streaming text token
`ai/stream/tool` → tool call started/completed
`ai/stream/diff` → file change with diff hunks
`ai/stream/blockEnd` → content block finished
`ai/stream/done` → turn complete
`ai/stream/error` → error occurred
`ai/stream/cost` → token/cost update
`ai/stream/askUser` → Claude needs user input

---

## 8. Data Layer

**Detailed design**: `DATA_LAYER_ARCHITECTURE.md` (688 lines) + `schema.sql` (1,654 lines)

### Database: Azure PostgreSQL

**15 tables**, **35+ indexes**, **12 RLS policies**, **10 custom ENUMs**

Core tables:
- `users` — synced from Clerk, JSONB settings
- `organizations` — multi-tenant anchor, Stripe customer link
- `org_members` — roles: owner/admin/member/viewer
- `projects` — workspace unit with metadata
- `sessions` — sandbox pod lifecycle tracking
- `conversations` — AI chat sessions with token aggregates
- `messages` — hybrid storage (<4KB inline, >=4KB in Blob)
- `subscriptions` — Stripe mirror with denormalized plan limits
- `usage_records` — partitioned monthly, 7 usage types
- `audit_log` — partitioned monthly, immutable

**Key design choices:**
- UUID v7 (time-sortable) for all primary keys
- Row-Level Security for multi-tenancy (shared schema)
- Monthly partitioning for usage and audit tables
- Hybrid message storage (PG + Blob for large payloads)
- Drizzle Kit for migrations (zero-downtime rules enforced)

### Blob Storage (5 containers)

| Container | Purpose | Path Pattern |
|-----------|---------|-------------|
| `project-files` | Active project data | `org:{id}/proj:{id}/` |
| `project-snapshots` | Disk snapshot archives | `org:{id}/proj:{id}/snap:{id}.tar.gz` |
| `conversation-blobs` | Large message content | `org:{id}/conv:{id}/msg:{id}` |
| `user-uploads` | User file uploads | `user:{id}/uploads/` |
| `exports` | Data export requests | `org:{id}/exports/` |

### Redis

- Session → pod IP mapping (sandbox-router)
- Usage quota counters (sub-millisecond checks)
- Cache: user profiles, project metadata, hot queries
- Pub/sub: WebSocket scaling, real-time notifications
- Background reconciliation with PostgreSQL every 60s

---

## 9. Security

**Detailed design**: `SECURITY_ARCHITECTURE.md` (2,076 lines)

### Authentication (Clerk)

- 60-second JWT lifetimes (reduces token theft window)
- HttpOnly cookie storage (not localStorage)
- Built-in CSRF protection
- Organizations for multi-tenancy RBAC
- Short-lived single-use JWT for WebSocket upgrade (30-second, query param)

### Sandbox Isolation (9 layers)

See Section 5 above. The critical point: **Kata Containers provide hardware VM isolation** — a sandbox escape requires a hypervisor CVE ($500K+ bounty class), not just a container escape.

### Network Security (Cilium)

- Sandbox pods **cannot** communicate with each other
- Sandbox pods **cannot** access IMDS (169.254.169.254) — triple-layer block
- Sandbox pods **cannot** access Kubernetes API server
- Sandbox pods **cannot** resolve internal cluster DNS (external DNS only: 8.8.8.8)
- Sandbox pods **can** access internet (npm, pip, git)
- Sandbox pods **can** communicate with Bricks Core (health/status only)

### Zero Secrets in Sandboxes

Sandbox pods never receive API keys, database credentials, or Stripe secrets. All external service calls are proxied through Bricks Core. GitHub tokens are injected as short-lived (1-hour) OAuth tokens via environment variables.

### Critical CVEs to Mitigate

- **Next.js CVE-2025-29927** (CVSS 9.1): Block `x-middleware-subrequest` header at NGINX Ingress
- Azure NPM deprecation: Use Cilium from day one

### 28-item Pre-Launch Security Checklist

Detailed in `SECURITY_ARCHITECTURE.md` — covers every layer from TLS to seccomp to audit logging.

---

## 10. Billing

**Detailed design**: `BILLING_SYSTEM_DESIGN.md` (2,368 lines)

### Plans

| Plan | Price | AI Credits | Compute | Storage | Sessions |
|------|-------|-----------|---------|---------|----------|
| Free | $0 | 50 credits/mo | 2 hrs/day | 5 GB | 15 min idle |
| Pro | $20/mo | 500 credits/mo | Unlimited | 20 GB | 35 min idle |
| Team | $50/seat/mo | 1000 credits/seat/mo | Unlimited | 50 GB/seat | 2 hr idle |

### Credit System

- **1 credit = 10,000 weighted tokens**
- Model multipliers: Haiku 1x, Sonnet 3x, Opus 5x
- Deducted on completion (failed calls not charged)
- Small overdraft allowed (max 10 credits) to prevent mid-response cutoffs
- Three credit types: plan > bonus > purchased (deduction priority: bonus first)

### Stripe Integration

- Stripe Checkout (not embedded forms) — reduces PCI scope
- Stripe Meters API for usage-based overage billing
- Usage flushed from PostgreSQL to Stripe every 15 minutes
- Webhook handling for subscription lifecycle
- Stripe Tax for automatic tax calculation

### Quota Enforcement

- Redis for sub-millisecond quota checks at API gateway
- PostgreSQL as source of truth
- Graceful degradation: when free user hits limit mid-conversation, Claude completes current response, then shows upgrade prompt

### Anti-Abuse

- FingerprintJS Pro for device fingerprinting
- Disposable email blocking
- IP/ASN reputation analysis
- Stripe Radar for payment fraud
- Referral credit grants delayed 48 hours

---

## 11. Infrastructure

**Detailed design**: `INFRASTRUCTURE.md` (1,597 lines)

### AKS Cluster — 4 Node Pools

| Pool | VM SKU | Nodes | Purpose |
|------|--------|-------|---------|
| System | D2s_v5 | 3 (fixed) | Core K8s components |
| Core | D4s_v5 | 2-10 (autoscale) | Bricks Core, sandbox-router, Redis |
| Sandbox | D4s_v5 | 0-50 (autoscale) | User sandbox pods |
| Sandbox-Spot | D4s_v5 (Spot) | 0-30 | Overflow sandboxes (up to 90% cheaper) |

### IaC: Terraform

- Modular structure with Azure Verified Modules
- State in Azure Blob Storage with versioning
- Environments: dev, staging, production
- OIDC authentication from GitHub Actions (no stored secrets)

### CI/CD: GitHub Actions

- **PR**: lint → test → build → security scan
- **CI**: build → push to ACR → deploy to dev
- **Release**: deploy staging (auto) → production (manual approval)
- Rolling updates with `helm --atomic` (auto-rollback on failure)
- Database migrations run before app deployment (Drizzle, forward-only)

### Monitoring

- **Metrics**: Azure Monitor + Azure Managed Grafana
- **Logs**: Azure Log Analytics
- **Tracing**: OpenTelemetry → Application Insights
- **Alerts**: 4 severity tiers (Sev0 pages immediately, Sev3 is informational)

### Key Performance Targets

| Metric | Target |
|--------|--------|
| Sandbox pod creation | p95 < 5s |
| WebSocket latency | p95 < 50ms |
| AI response (first token) | p95 < 3s |
| API error rate | < 0.1% |
| Uptime | 99.9% |

### SSL/TLS

- cert-manager + Let's Encrypt (DNS-01 challenge via Azure DNS)
- Wildcard cert for `*.preview.bricks.dev`
- HSTS, X-Frame-Options, CSP headers at NGINX Ingress

### Estimated Monthly Costs

| Users | Cost |
|-------|------|
| 100 | ~$1,700 |
| 1,000 | ~$6,200 |
| 10,000 | ~$18,000-28,000 |

---

## 12. Phased Delivery

Based on cross-referencing all deep-dive recommendations:

### Phase 1: Foundation (Weeks 1-4)
- Terraform: AKS cluster, PostgreSQL, Redis, Blob Storage, ACR
- CI/CD pipeline (GitHub Actions)
- NestJS monolith scaffold with Clerk auth
- Database schema + Drizzle migrations
- Next.js frontend scaffold with Clerk, routing, landing page

### Phase 2: Sandbox Core (Weeks 5-8)
- Sandbox base image (Ubuntu 22.04 + languages + s6-overlay)
- Sandbox daemon (WebSocket server, terminal, file watcher)
- Sandbox-router (Go, Redis session lookup)
- Kata Containers + Cilium network policies on AKS
- Pod lifecycle management (create, idle detect, snapshot, destroy)
- Frontend: Monaco Editor integration, xterm.js integration, file tree

### Phase 3: AI Agent (Weeks 9-12)
- Claude integration via Azure AI Foundry
- Agentic loop with all 14 tools
- Tool execution bridge (Core → sandbox daemon)
- AI streaming to frontend (SSE events)
- Builder Mode and IDE Mode system prompts
- Frontend: AI chat panel, diff viewer, accept/reject flow

### Phase 4: App Preview + Git (Weeks 13-15)
- Wildcard DNS + Traefik for preview URLs
- Port auto-detection in sandbox
- HMR passthrough
- Git credential helper
- GitHub integration (clone, push, OAuth)
- Frontend: preview panel, git panel

### Phase 5: Billing + Polish (Weeks 16-18)
- Stripe integration (subscriptions, usage meters, checkout)
- Credit system + quota enforcement
- Usage dashboard
- Free tier enforcement
- Onboarding flow (templates, wizard)
- Builder Mode UX polish
- Security hardening (seccomp, AppArmor, audit logging)
- Performance optimization
- Pre-launch security checklist

### Phase 6: Launch Prep (Weeks 19-20)
- Load testing
- Penetration testing
- Documentation
- Monitoring dashboards + alerts
- Disaster recovery verification
- Beta testing with invited users

---

## 13. File Reference

| Document | Lines | Content |
|----------|-------|---------|
| `RESEARCH.md` | 899 | Technology research with sources |
| `FRONTEND_ARCHITECTURE.md` | 2,319 | Component tree, state, routing, UX modes |
| `AI_AGENT_SYSTEM_DESIGN.md` | 2,514 | Agent loop, tools, context, streaming |
| `WEBSOCKET_REALTIME_ARCHITECTURE.md` | 1,518 | Protocol, routing, reconnection |
| `SECURITY_ARCHITECTURE.md` | 2,076 | 9-layer defense, auth, network, compliance |
| `SANDBOX-DESIGN.md` | 1,939 | Pod internals, lifecycle, isolation |
| `BILLING_SYSTEM_DESIGN.md` | 2,368 | Plans, credits, Stripe, anti-abuse |
| `DATA_LAYER_ARCHITECTURE.md` | 688 | Schema design, caching, multi-tenancy |
| `INFRASTRUCTURE.md` | 1,597 | AKS, Terraform, CI/CD, monitoring |
| `schema.sql` | 1,654 | Complete PostgreSQL schema |
| **Total** | **17,572** | |
