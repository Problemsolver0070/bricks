# Bricks Spec Reconciliation — CRITICAL & HIGH Issue Resolution

> **Date**: 2026-04-08
> **Purpose**: Definitive resolution of all 32 CRITICAL and 54 HIGH issues from the spec review. This document is the tiebreaker. Where it conflicts with any other document, this document wins.

---

## CRITICAL RESOLUTIONS (32)

### 1.1 — ORM: Drizzle Kit (FINAL)

**Decision**: Drizzle Kit. All Prisma references in INFRASTRUCTURE.md and SECURITY_ARCHITECTURE.md are errors.

**Action**: Replace all `prisma migrate` commands with `drizzle-kit push` / `drizzle-kit migrate`. Replace `_prisma_migrations` with `__drizzle_migrations`. Remove "Prisma recommended" from security doc.

---

### 1.2 — Network Policy Engine: Cilium (FINAL)

**Decision**: Cilium with Azure CNI. Not Calico.

**Rationale**: Azure NPM deprecated Sep 2026/2028. Cilium's eBPF provides IMDS blocking, DNS-aware policies, and better observability. AKS supports Cilium natively via `--network-dataplane cilium`.

**Action**: Update INFRASTRUCTURE.md line 94. Remove all Calico references.

---

### 1.3 — Base Image: Ubuntu 24.04 LTS (FINAL)

**Decision**: Ubuntu 24.04 LTS (Noble Numbat).

**Rationale**: 22.04 EOL is April 2027 — less than a year away. 24.04 gives us support through April 2029. Newer kernel (6.8), newer default packages, AppArmor 4.0.

**Action**: Update SANDBOX-DESIGN.md and main spec.

---

### 1.4 — Isolation: Kata Containers on AKS (FINAL)

**Decision**: Kata Containers. Not Firecracker.

**Rationale**: Firecracker is not natively supported on AKS. Kata is supported via `kata-mshv-vm-isolation` runtime class. AI_AGENT_SYSTEM_DESIGN.md references to Firecracker are errors.

**Action**: Replace all Firecracker references in AI_AGENT_SYSTEM_DESIGN.md with Kata Containers.

---

### 1.5 — Claude Opus 4.6 Pricing: Verify from Source (FINAL)

**Decision**: Use Anthropic's official documented pricing. As of April 2026:
- Opus 4.6: $15 input / $75 output per MTok
- Sonnet 4.6: $3 input / $15 output per MTok
- Haiku 4.5: $0.80 input / $4 output per MTok

**Rationale**: The higher prices ($15/$75) appear in the main spec and match Anthropic's published pricing page. The lower numbers in RESEARCH.md may reference cached/batch pricing or older models.

**Action**: All cost calculations, credit system math, and P&L projections must use these numbers. Recalculate credit margins.

**Note**: With prompt caching, effective input cost drops to $1.50/MTok for Opus (90% reduction on cache hits). Factor this into real-world cost estimates.

---

### 1.6 — Billing Plan Numbers (FINAL)

**Decision**: Canonical plan numbers (single source of truth):

| Resource | Free | Pro ($20/mo) | Team ($50/seat/mo) |
|----------|------|-------------|-------------------|
| AI Credits | 100/mo | 1,000/mo | 2,500/seat/mo |
| Compute | 2 hrs/day | Unlimited | Unlimited |
| Storage | 2 GB | 10 GB | 25 GB/seat |
| Idle Timeout | 10 min | 30 min | 2 hrs |
| Max Concurrent Sessions | 1 | 3 | 5/member |
| Max Projects | 3 | 20 | Unlimited |

**Rationale**: Free tier credits at 100 gives ~6-7 Opus sessions or ~20 Sonnet sessions — enough to demonstrate value. Storage at 2 GB is realistic for free (node_modules lives on ephemeral PVC, not counted). Pro storage at 10 GB is sufficient for most projects without over-provisioning disks.

**Action**: Update main spec and BILLING_SYSTEM_DESIGN.md. Kill all other numbers.

---

### 1.9 — Seccomp: Default-DENY / Allowlist (FINAL)

**Decision**: `SCMP_ACT_ERRNO` (default-deny). Allowlist approach.

**Rationale**: Default-allow is fundamentally insecure for untrusted code execution. Every new kernel syscall is automatically exposed. The allowlist is harder to maintain but correct.

**Additional**: Block `io_uring` syscalls (io_uring_setup, io_uring_enter, io_uring_register). 8+ privilege escalation CVEs since 2021. Google disabled it in GKE Autopilot. This means Bun will have degraded performance — document this as a known limitation. Users can use Node.js or Deno instead.

**Action**: Use SECURITY_ARCHITECTURE.md's seccomp profile. Delete SANDBOX-DESIGN.md's denylist profile. Add io_uring to the block list. Document Bun limitation.

---

### 1.17 — Database Schema: schema.sql is Canonical (FINAL)

**Decision**: `schema.sql` is the single source of truth for all database structures. The billing spec's inline schema is documentation-only and must match.

**Action**: Add missing tables to schema.sql:
- `credit_ledger` (grants, deductions, expirations with running balance)
- `stripe_events` (idempotent webhook processing)
- `credit_purchases` (one-time credit purchases)

Reconcile column names: standardize on `clerk_user_id` (not `clerk_id`). All PKs are UUID (not BIGSERIAL). Fix `gen_random_uuid()` to use `pg_uuidv7` extension for UUID v7 (resolves issue 8.1 simultaneously).

---

### 1.20 — "Zero Secrets" Claim: Be Honest (FINAL)

**Decision**: Drop the "zero secrets" claim. Replace with accurate threat model.

**New language**: "Sandbox pods contain no API keys, database credentials, or billing secrets. The only credential present is a short-lived (1-hour) GitHub OAuth token injected via environment variable for git operations. This token is scoped to the user's authorized repositories only. We accept the risk that malicious code within the sandbox can read this token via `/proc`, environment inspection, or git hooks. The token's 1-hour expiry and repository-scoped permissions limit blast radius."

**Mitigation**: Inject the token ONLY when a git operation is requested (not at pod creation), and clear the environment variable after the operation completes. Use `GIT_ASKPASS` script approach instead of env var where possible.

---

### 2.1 — Daemon Attack Surface: Harden (FINAL)

**Decision**: Accept that the daemon is an attack surface within the Kata VM. Mitigate:

1. **Remove passwordless sudo for UID 1001 (sandbox user)**. Instead, pre-install common packages in the base image. If users need additional packages, the daemon (UID 1000) installs them on request via a controlled API endpoint — no direct sudo.
2. **Daemon WebSocket on Unix socket, not TCP port**. User code cannot connect to a Unix socket owned by UID 1000 with mode 0700. This kills the localhost:9111 attack vector entirely.
3. **Authenticate daemon internal endpoints** (`/shutdown`, `/snapshot`) with a pod-unique token injected at pod creation, stored in a file readable only by UID 1000.
4. **Sandbox user (UID 1001) cannot read daemon files**. Daemon home dir `/home/bricks/` is mode 0700.

---

### 2.2 — Builder Mode Prompt Injection: Defense in Depth (FINAL)

**Decision**: Builder Mode cannot be fully auto-approve. Add a "trust boundary":

1. **Auto-approve**: FileRead, Glob, Grep, WebSearch, WebFetch, BrowserPreview (read-only tools)
2. **Auto-approve with logging**: FileWrite, FileEdit, FileDelete, FileMove, Git (commit/push) — execute immediately but log every action with full content for rollback
3. **Require confirmation**: Bash commands that match sensitive patterns (network requests with data, process management, credential access)
4. **Always block**: `curl/wget` with `-d`/`--data`/`--upload-file`/`-F` flags, `eval`, `exec`, pipe to `bash/sh`, `/dev/tcp`
5. **Mandatory rollback**: Every conversation turn creates a filesystem snapshot. "Undo last turn" button always visible.
6. **Content isolation**: File content sent to Claude is wrapped in `<bricks_file>` tags with a system-level instruction that content within these tags is DATA, not INSTRUCTIONS. This is not foolproof but raises the bar.

---

### 2.11 — Tool Execution Bridge Auth (FINAL)

**Decision**: Daemon WebSocket listens on Unix socket (see 2.1). External connections come through the sandbox-router which authenticates via the session token. The daemon validates a `X-Bricks-Pod-Token` header on WebSocket upgrade that matches the pod-unique token. User code inside the pod cannot forge this connection.

---

### 3.1 — Kata Resource Requests Not Supported on AKS (FINAL)

**Decision**: This is a real limitation. Mitigate:

1. **Use only `limits`, not `requests`** in pod specs. Accept that Kubernetes scheduler cannot do optimal bin-packing.
2. **Dedicated node pool with taints** ensures only sandbox pods land on sandbox nodes. No resource contention with system workloads.
3. **Fixed pod-per-node calculation** based on limits: D4s_v5 (4 vCPU, 16 GB) → max 2 Pro pods (2 vCPU + 4 GB each) or 4 Free pods (1 vCPU + 2 GB each).
4. **Custom scheduler or topology constraints** to enforce hard pod-per-node limits since requests-based scheduling is broken.
5. **Monitor actual utilization** via cgroup metrics inside Kata VMs and alert on overcommit.

**Risk accepted**: Less efficient bin-packing than standard containers. Higher per-user infrastructure cost.

---

### 3.2 — Kata Filesystem Backed by VM Memory (FINAL)

**Decision**: Critical issue. Mitigate:

1. **Mount ALL writable paths as volumes**, not just /workspace:
   - `/workspace` → Azure Disk PVC (user code)
   - `/tmp` → emptyDir (ephemeral scratch)
   - `/var/log/bricks/` → emptyDir with sizeLimit
   - `/var/run/bricks/` → emptyDir with sizeLimit
   - `/home/bricks/` → emptyDir (daemon state)
   - `/home/sandbox/` → emptyDir (user home)
2. **s6 log rotation** configured to limit total log size to 10 MB.
3. **No writes to root filesystem** enforced by read-only root + explicit volume mounts for every writable path.
4. **Memory budgets revised upward** to account for Kata VM overhead. Free tier minimum 2 GB (not 1 GB). See issue 3.5.

---

### 3.3 — Azure Linux EOL (FINAL)

**Decision**: Use **AzureLinux 3** (formerly CBL-Mariner 3). Azure Linux 2.0 EOL was Nov 2025; images removed March 2026.

**Action**: All Terraform node pool configs must specify `os_sku = "AzureLinux"` which defaults to AzureLinux 3 on current AKS versions. Verify Kata runtime class compatibility with AzureLinux 3.

---

### 4.1 — Compaction: No Fabricated Assistant Messages (FINAL)

**Decision**: Never inject fake assistant messages.

**New approach**: Compaction produces a `system` message (not `assistant`) prepended to the conversation:

```
[system] Conversation summary (auto-generated, turns 1-N compressed):
{summary}
The following messages continue from this point. If context seems incomplete, ask the user for clarification.
```

Claude is not told it "understands" or "has full context." It's given a summary and told to ask if context is missing.

---

### 4.2 — FileEdit Atomicity (FINAL)

**Decision**: Use atomic write pattern:

1. Read file, validate uniqueness of search string
2. Write to `.bricks_tmp_{filename}` (temp file)
3. `rename()` temp file to target (atomic on same filesystem)
4. In IDE Mode: write to temp, show diff, if accepted then rename. If rejected, delete temp. No window where the main file has unapproved changes.
5. File-level advisory lock (flock) prevents concurrent edits to same file.

---

### 4.3 — Budget Ceiling: Raise and Differentiate (FINAL)

**Decision**:
- Builder Mode: $10.00 per conversation (non-technical users need room)
- IDE Mode: $5.00 per conversation (developers can manage context)
- Free tier: $2.00 per conversation (acceptable constraint for free)

Budget is per-conversation, not per-turn. Users can see remaining budget in the UI. When 80% consumed, show a warning. At 100%, Claude completes current response and stops.

---

### 5.1 — TTI Target: Be Honest (FINAL)

**Decision**: Honest performance targets:

| Scenario | Target |
|----------|--------|
| Cold start (new sandbox + first visit) | < 8s |
| Warm sandbox + first visit (no cache) | < 4s |
| Warm sandbox + cached assets | < 2s |
| Returning visit (all warm) | < 1.5s |

---

### 5.2 — Frontend Must Handle Two WebSocket Connections (FINAL)

**Decision**: Frontend architecture must model both connections:

1. `SandboxConnection` class — manages WS to sandbox pod (terminal, files, LSP)
2. `CoreConnection` class — manages WS to Bricks Core (AI streaming, presence, notifications)
3. `ConnectionManager` — coordinates both, handles independent reconnection, exposes unified status
4. When one connection is down and the other is up: degrade gracefully (e.g., sandbox down = terminal/files frozen but AI chat still works for non-tool-use conversation)

---

### 5.3 — Error Boundaries: Define Them (FINAL)

**Decision**: Mandatory error boundaries at these points:

1. `<WorkspaceErrorBoundary>` — wraps entire workspace, fallback: "Something went wrong, reload workspace" with session recovery
2. `<EditorPanelBoundary>` — wraps Monaco, fallback: "Editor crashed, click to reload" (re-mount Monaco)
3. `<TerminalPanelBoundary>` — wraps xterm.js, fallback: "Terminal disconnected, click to reconnect"
4. `<AIChatBoundary>` — wraps AI chat, fallback: "Chat error, click to retry"
5. `<PreviewPanelBoundary>` — wraps preview iframe, fallback: "Preview unavailable"

Each boundary logs the error, reports to telemetry, and provides a recovery action. One panel crash does NOT take down others.

---

### 5.4 — CSP and Sanitization (FINAL)

**Decision**: Define strict Content Security Policy:

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
connect-src 'self' wss://*.bricks.dev https://*.bricks.dev;
frame-src https://*.bricks-preview.dev;
img-src 'self' data: blob:;
font-src 'self';
```

**Preview domain**: Use a completely separate registered domain `bricks-preview.dev` (NOT a subdomain of `bricks.dev`). This prevents cookie scope attacks and isolates preview content from the main application entirely.

**Markdown rendering**: Use `rehype-sanitize` with a strict schema. No raw HTML in AI chat output.

---

### 5.5 — WebSocket Message Authorization (FINAL)

**Decision**: Every WebSocket message includes a `sessionToken` field validated server-side. Channel-level permissions:

- `terminal/*` — requires active session ownership
- `file/*` — requires active session ownership
- `lsp/*` — requires active session ownership
- `ai/*` — requires conversation ownership + active session
- `admin/*` — requires admin role

The session token is the Clerk session token (refreshed every 60s via heartbeat). Not the initial connection JWT.

---

### 7.6 & 7.7 — Missing Schema Tables (FINAL)

**Decision**: Add to schema.sql:

1. `credit_ledger` — type (plan_grant, bonus_grant, purchase, deduction, expiration, adjustment), amount, balance_after, reference_id, expires_at
2. `stripe_events` — event_id (unique), type, data JSONB, processed_at, idempotency protection
3. `credit_purchases` — user_id, org_id, stripe_payment_intent_id, credits, amount_cents, status

All webhook handlers reference these canonical table names.

---

### 8.2 — Messages RLS: Denormalize org_id (FINAL)

**Decision**: Add `org_id UUID NOT NULL` to the `messages` table. 16 bytes per row is trivial. RLS policy becomes:

```sql
USING (org_id = current_org_id() AND deleted_at IS NULL)
```

No correlated subquery. Index-only scans work. Set `org_id` via trigger on INSERT from parent conversation.

---

### 9.1 — Rolling Updates: Graceful WebSocket Drain (FINAL)

**Decision**:

1. **`terminationGracePeriodSeconds: 300`** (5 minutes) for sandbox-router and Bricks Core pods
2. **`preStop` hook**: Send `CONNECTION_DRAINING` message to all connected clients, wait 10s for clients to reconnect elsewhere, then close connections
3. **PodDisruptionBudget**: `maxUnavailable: 1` for sandbox-router (never kill more than one at a time)
4. **NGINX upstream removal**: Before pod termination, remove the pod from NGINX upstream. New connections route to remaining pods. Existing connections drain.
5. **Client behavior**: On receiving `CONNECTION_DRAINING`, client initiates reconnection to a different pod within 10s.

---

## HIGH RESOLUTIONS (54)

### 1.7 — Resource Tiers: Single Answer (FINAL)

| Tier | CPU (limit) | RAM (limit) | Disk (PVC) | Idle Timeout |
|------|------------|------------|-----------|-------------|
| Free | 1 vCPU | 2 GB | 5 GB | 10 min |
| Pro | 2 vCPU | 4 GB | 20 GB | 30 min |
| Team | 4 vCPU | 8 GB | 50 GB | 2 hrs |

**Note**: Kata VM overhead (~256 MB) comes out of the RAM limit. Free tier effective user RAM is ~1.5 GB after daemon + Kata overhead. This is tight but viable for lightweight projects (Node.js, Python). LSP is best-effort on Free tier.

---

### 1.8 — Ingress: NGINX Only (FINAL)

**Decision**: One ingress controller: **NGINX Ingress**. No Traefik.

Preview URL routing handled by the Go sandbox-router (which already does session→pod lookup). NGINX routes `*.bricks-preview.dev` to sandbox-router, which proxies to the correct pod + port.

---

### 1.10 — Preview URLs: Public by Default, Private Option (FINAL)

**Decision**: Previews are **public by default** (anyone with the URL can access). This matches developer expectations (sharing WIP with a client, testing on mobile).

**Why not authenticated**: Preview URLs serve user-generated apps that have their own auth. Adding Bricks auth on top creates CORS nightmares and breaks frameworks that expect clean HTTP.

**Private option**: Users can toggle "Require authentication" per project, which adds a Bricks auth gateway in front of the preview. Off by default.

**Security mitigation**: Preview URLs use random sandbox IDs (UUID) — not guessable. Separate domain (`bricks-preview.dev`) prevents cookie/CORS attacks on main app.

---

### 1.11 — WebSocket Auth: Short-Lived Token in Query Param (FINAL)

**Decision**: Query parameter with short-lived token. Not first message.

**Rationale**: Browser WebSocket API does not support custom headers. The first-message approach requires establishing an unauthenticated connection and then upgrading — the server must hold unauthenticated connections in memory, creating a DoS vector.

**Mitigation for logging**: NGINX configured to NOT log query parameters: `log_format stripped '$remote_addr ... "$request_uri_path"';` with a map that strips query strings. Application-level logging also strips the token parameter.

---

### 1.12 — DNS: External Only (FINAL)

**Decision**: `dnsPolicy: None` with nameservers `[8.8.8.8, 8.8.4.4]`.

Sandboxes CANNOT resolve internal cluster DNS. This is a hard security requirement. The SANDBOX-DESIGN.md `ClusterFirst` reference is an error.

---

### 2.3 & 2.4 — Bash/Credential Allowlists: Abandon Blocklist Approach (FINAL)

**Decision**: Blocklists are fundamentally broken for security. Replace with:

1. **Sandbox isolation is the primary defense**. Even if malicious code runs, it's inside a Kata VM with no access to production secrets.
2. **Network egress monitoring** (not blocking): Log all outbound connections. Alert on unusual patterns. Don't try to block curl/wget — it's unwinnable.
3. **Builder Mode**: Remove Bash from auto-approve entirely. Claude must ask user permission for any shell command in Builder Mode. Show the command in plain language: "I'd like to run `npm install express` to add the Express framework. OK?"
4. **IDE Mode**: All Bash commands shown to user, executed on approval (current Claude Code behavior).

---

### 2.5 — CORS: Separate Preview Domain (FINAL)

**Decision**: Preview domain is `bricks-preview.dev` (completely separate from `bricks.dev`). The API CORS policy ONLY allows `https://bricks.dev` and `https://app.bricks.dev`. No preview domain in CORS. Preview apps cannot make credentialed requests to the Bricks API.

---

### 2.6 — IMDS + Kata: Requires Verification (FINAL)

**Decision**: Mark as **must-verify during Phase 1 POC**. Before building anything on Kata, deploy a test pod with Kata runtime class and verify:
1. Host iptables IMDS blocking applies inside Kata VM
2. If not, add in-VM iptables rules via s6 init script
3. Block Azure Wireserver (168.63.129.16) in addition to IMDS

---

### 2.7 — Egress Security Model: Monitor, Don't Block (FINAL)

**Decision**: For v1, accept that determined attackers can exfiltrate data from their own sandbox. The sandbox contains THEIR code, not other users' data. The real risk is using the sandbox as an attack proxy.

**Mitigations**:
1. Rate limit outbound connections (100 new connections/minute)
2. Block well-known mining pool domains at DNS level
3. Log all outbound traffic metadata (dest IP, port, bytes)
4. Alert on unusual patterns (sustained high-bandwidth outbound)
5. Free tier: stricter egress limits. Paid tiers: relaxed (paid users have accountability via payment method)

---

### 2.8 — RLS Context Setting (FINAL)

**Decision**: Use NestJS middleware that:
1. On every database call, wraps in a transaction
2. First statement: `SET LOCAL app.current_org_id = $1` (transaction-scoped, auto-cleared on commit/rollback)
3. `SET LOCAL` means the setting is ONLY visible within the transaction — no connection pool leakage
4. The Drizzle query builder enforces this via a custom `withOrgContext(orgId, callback)` helper that MUST be used for all queries on RLS-protected tables

---

### 2.9 — WebSocket Token Logging (FINAL)

Addressed in 1.11 — strip query params from all logs.

---

### 2.10 — npm postinstall + Sudo (FINAL)

**Decision**: Remove sudo from sandbox user (UID 1001) entirely (per issue 2.1). Package installation handled via daemon API endpoint. The daemon (UID 1000) has controlled sudo. User code cannot directly escalate.

npm postinstall scripts still run as UID 1001 but without sudo. They can't install system packages or modify system files. Malicious postinstall scripts are contained within the Kata VM — they can damage the user's own workspace but cannot escape.

---

### 2.12 — Network Policy: External DNS Only (FINAL)

Resolved in 1.12. `dnsPolicy: None`, external nameservers only.

---

### 3.4 — Pod Creation Targets: Honest Numbers (FINAL)

| Scenario | Target |
|----------|--------|
| New empty workspace (warm pool) | p95 < 5s |
| New workspace with git clone | p95 < 20s |
| Restore from snapshot | p95 < 15s |
| Cold start (no warm pool, no cache) | p95 < 60s |

---

### 3.5 — Free Tier Memory Budget (FINAL)

With 2 GB limit and Kata overhead:
- Kata VM overhead: ~256 MB
- s6-overlay + daemon: ~100 MB
- 1 terminal: ~10 MB
- Chokidar: ~30 MB
- **Platform overhead: ~400 MB**
- **Available for user: ~1.6 GB**

This runs a React dev server (~300 MB) or Python app comfortably. TypeScript LSP (512 MB) is tight — make LSP **opt-in on Free tier** with a warning: "Language features require ~500 MB RAM. Enable?"

---

### 3.6 — LSP Memory: Realistic Caps (FINAL)

- TypeScript: 768 MB cap (covers medium projects; large projects will degrade)
- Python (Pylsp): 256 MB cap
- Go (gopls): 512 MB cap
- Rust (rust-analyzer): 1 GB cap (Pro/Team only — too heavy for Free)

Document: "LSP performance depends on project size and available memory. Large projects on Free tier may have limited language features."

---

### 3.8 — Snapshot Consistency (FINAL)

Pre-snapshot sequence:
1. Daemon sends `SIGTERM` to user-started database processes (SQLite WAL checkpoint, PostgreSQL graceful shutdown)
2. Wait up to 5 seconds for graceful shutdown
3. Remove `.git/index.lock` and other known lock files
4. `sync` syscall
5. Trigger Azure Disk Snapshot

On restore:
- Check for and remove stale lock files
- Log warning if database files may be inconsistent

---

### 3.12 — Disk Slot Limits (FINAL)

**Decision**: Use D8s_v5 (max 16 data disks). Set hard pod-per-node limit to 8 (leaves headroom for system volumes). Use `maxPods` setting on the node pool.

For Free tier with 5 GB disks: use **Azure Disk P1 (4 GB, $0.60/mo)** or **P2 (8 GB, $1.20/mo)** instead of P10 (128 GB). Massive cost savings.

---

### 4.4 — Stuck Loop Detection: Improve (FINAL)

Replace naive "5 identical calls" with:
1. **Oscillation detection**: Track last 10 tool results. If error messages repeat with >80% similarity (Levenshtein), trigger intervention.
2. **Progress metric**: Track file content hash + test output hash. If neither changes over 5 iterations, Claude is stuck.
3. **Intervention**: Don't auto-cancel. Instead, inject a system message: "You appear to be stuck. Step back and reconsider your approach. If you need help, ask the user."

---

### 4.5 — pause_turn: Count It (FINAL)

`pause_turn` DOES count toward the iteration limit. Remove the exemption.

---

### 4.6 — Compaction: Use Opus for Opus Conversations (FINAL)

**Decision**: Compaction uses the same model that generated the conversation. Opus conversations compacted by Opus. Sonnet conversations by Sonnet. The quality loss from downgrading is worse than the cost savings.

**Max summary size**: 16K tokens (not 8K). Compaction triggered at 700K tokens (not 800K) to leave more room.

---

### 4.7 — Model Routing: Start Simple (FINAL)

**Decision**: For v1, no automatic routing. Default to Sonnet 4.6 for all users. Users can manually select Opus in settings or per-conversation. Free tier: Sonnet only.

Automatic routing is a Phase 2 feature when we have real usage data to calibrate.

---

### 4.8 — Partial Stream Failure (FINAL)

**Decision**: If stream drops mid-tool-use block:
1. Discard the incomplete message entirely
2. Retry the full API call with the same messages array
3. Max 3 retries with exponential backoff
4. If all retries fail, return error to user: "Claude's response was interrupted. Please try again."

The partially accumulated tool calls are NOT executed.

---

### 4.9 — Event Buffer: Increase Size (FINAL)

- Sandbox WS ring buffer: **5,000 messages** (covers ~25 tool call cycles)
- Core WS: Add a ring buffer of **2,000 messages** (was zero — this was a gap)
- On reconnect: replay from last acknowledged sequence
- If buffer exceeded: full state sync (file tree manifest + open file contents + conversation reload from DB)

---

### 4.10 — SubAgent: Limit and Track (FINAL)

- Max 3 concurrent SubAgents per conversation
- Max 10 SubAgents per conversation total
- SubAgent costs tracked against parent conversation budget
- SubAgent budget: min($1.00, remaining_parent_budget * 0.2)

---

### 4.11 — Cost Tracking: Track on Completion AND Failure (FINAL)

- Track cost on EVERY API response (success or failure) using the `usage` field in the response
- Track cost AFTER the call, not before (actual tokens, not estimated)
- WebSearch cost tracked separately (per-search, not per-token)
- SubAgent costs roll up to parent
- Budget check happens BEFORE the call (estimated) AND AFTER (actual). If actual exceeds budget, stop the loop but don't undo the last call.

---

### 4.12 — Concurrent Conversations: Limit (FINAL)

- Free: 1 active AI conversation at a time
- Pro: 3 concurrent
- Team: 5 per member

"Active" = agentic loop is running. Viewing past conversations doesn't count.

---

### 4.17 — IDE Mode: Diff Before Write (FINAL)

**Decision**: In IDE Mode, Claude's file edits go to a staging area:
1. Claude proposes edit → written to `.bricks_staging/{path}`
2. Diff shown in UI (staged vs current)
3. User accepts → atomic rename to real path
4. User rejects → delete staged file, return rejection result to Claude

Claude receives the acceptance/rejection as a tool result and adjusts accordingly.

---

### 5.6 — Builder Mode: Mandatory Undo (FINAL)

**Decision**: Filesystem snapshot before every AI conversation turn. "Undo last turn" button always visible in Builder Mode. Undo reverts filesystem to pre-turn state and removes the last turn from conversation history.

Implementation: lightweight rsync-based diff (not full disk snapshot) for speed.

---

### 5.7 — SSR/Hydration: Client-Only Stores (FINAL)

All Zustand stores are client-only. No `persist` middleware reads during SSR. Workspace route is `'use client'` at the layout level. Stores initialize in a `useEffect` hook after mount, not during render.

---

### 5.8 — Cross-Store: Event Bus with Ordering (FINAL)

Replace ad-hoc `getState()` calls with a typed event bus using `mitt`:
- Events are processed synchronously in subscription order
- Each event type has a defined payload schema
- No store directly imports another store
- `applyDiff` must exist before it's called — TypeScript compilation catches this

---

### 5.9 — Monaco Memory: Lazy Models (FINAL)

- Max 10 active Monaco models (not 30)
- LRU eviction: when opening 11th file, dispose the least-recently-used model
- Tab remains visible but content reloads from sandbox on focus
- Persist middleware does NOT restore file contents, only tab metadata (path, cursor position)

---

### 5.10 — LSP Client: Fix Implementation (FINAL)

- Return type: `Promise<MonacoLanguageClient>` (fix the lie)
- Add `onerror` and connection timeout (10s)
- LSP tunneled through the sandbox WebSocket (not separate connections)
- Dispose on file close / language change
- Reconnect on sandbox WebSocket reconnection

---

### 5.11 — Mobile: Builder Mode Only (FINAL)

**Decision**: On screens < 768px, only Builder Mode is available. Layout:
- Full-width AI chat (stacked, not split)
- "Preview" button opens fullscreen preview overlay
- "View Code" button opens fullscreen code view
- No split panels on mobile

IDE Mode shows "Please use a desktop browser for IDE Mode" interstitial.

---

### 5.12 — File Conflicts: Last-Write-Wins with Notification (FINAL)

- Sandbox filesystem is always source of truth
- If user edits a file that Claude simultaneously edits:
  - Claude's write lands first → user sees a banner "This file was modified by Claude. Your unsaved changes may conflict."
  - User's save lands first → Claude's write overwrites (Claude doesn't know about unsaved editor state)
- No merge dialog for v1. Last-write-wins. The undo system (Builder) and git (IDE) are the recovery mechanisms.

---

### 6.1 — Router Latency: Be Honest (FINAL)

**Decision**: "1-5ms per message, p99 up to 10-20ms under load." Remove the 0.5ms claim.

---

### 6.2 — Core WS Buffer: Add One (FINAL)

Resolved in 4.9. Core WS gets a 2,000-message ring buffer.

---

### 6.3 — Reconnection Stampede: Stagger (FINAL)

- Full jitter: reconnect delay = `random(0, min(cap, base * 2^attempt))` with cap=30s
- Server-side: rate limit reconnections to 50/second per sandbox-router instance
- If rate exceeded, return 503 with `Retry-After` header
- File tree sync: paginated (100 files per batch) to avoid thundering herd on PVC IOPS

---

### 6.4 — Redis: Use Streams for AI Events (FINAL)

**Decision**: Use Redis Streams (not pub/sub) for AI streaming events:
- Persistent, ordered, consumer groups
- If subscriber has a GC pause, messages wait in the stream
- Consumer acknowledges messages after delivery to client
- Trim stream after all consumers have acknowledged

Redis pub/sub remains for ephemeral events (presence, typing indicators).

---

### 6.5 — Thundering Herd: Full Jitter + Circuit Breaker (FINAL)

Resolved in 6.3 (full jitter). Add client-side circuit breaker:
- After 5 consecutive failed reconnections, enter "open" state
- In open state: show "Connection lost. Retrying in X seconds..." with manual retry button
- After 30s, try one probe connection (half-open state)
- If probe succeeds, resume normal reconnection

---

### 7.1 — Credit Margins: Recalculate Honestly (FINAL)

With correct Opus pricing ($15/$75 per MTok) and 1 credit = 10K weighted tokens with 5x Opus multiplier:
- 1 Opus credit = 10K * 5 = 50K weighted tokens = actual 10K tokens
- Cost per 10K Opus tokens: ~$0.15 input or ~$0.75 output
- With 50/50 split: ~$0.45 per credit of Opus usage
- Overage price at $0.02/credit: **negative margin on Opus**

**Fix**: Overage price must be $0.05/credit minimum. Or adjust the multiplier. Decision: **increase Opus multiplier to 10x** (not 5x). 1 Opus credit = 100K weighted tokens but only buys 10K actual tokens. This makes overage at $0.02/credit roughly breakeven with caching.

---

### 7.2 — Stripe Idempotency Key (FINAL)

Change to: `identifier: overage_${userId}_${usageRecordId}` (deterministic, safe to retry).

---

### 7.3 — Stripe Flush: Exactly-Once (FINAL)

1. Read records WHERE `stripe_reported_at IS NULL AND stripe_reporting_started_at IS NULL`
2. SET `stripe_reporting_started_at = NOW()`
3. Send to Stripe
4. On success: SET `stripe_reported_at = NOW()`
5. On failure: SET `stripe_reporting_started_at = NULL` (retry next cycle)
6. Stale detection: if `stripe_reporting_started_at` > 10 minutes ago and `stripe_reported_at IS NULL`, reset for retry

---

### 7.4 — Free Tier Overdraft: Pre-Check at Model Cost (FINAL)

Before starting an API call, estimate the minimum cost (1 credit for Haiku, 3 for Sonnet, 10 for Opus). If remaining credits < estimated minimum cost, block the request BEFORE calling the API. The overdraft cap is a safety net, not the primary control.

---

### 7.5 — Team Credit Pool: Default Hard Cap (FINAL)

Default per-member hard cap: 20% of team pool per day. Admin can adjust. When a member hits the cap, their requests are blocked until the next day or admin raises the limit.

---

### 8.1 — UUID v7: Use pg_uuidv7 Extension (FINAL)

Replace `gen_random_uuid()` with `uuid_generate_v7()` from the `pg_uuidv7` extension. Azure PostgreSQL Flexible Server supports custom extensions.

If `pg_uuidv7` is not available on Azure PostgreSQL, use application-level UUID v7 generation (e.g., `uuidv7` npm package) and pass as parameter instead of relying on DEFAULT.

---

### 8.3 — Organizations RLS: Fix Policy (FINAL)

```sql
CREATE POLICY org_member_access ON organizations
  FOR SELECT USING (
    id IN (SELECT org_id FROM org_members WHERE user_id = current_user_id() AND deleted_at IS NULL)
  );
```

This allows listing all organizations the user belongs to. Write operations restricted to `id = current_org_id()`.

---

### 8.4 — Audit Log RLS: Allow NULL org_id (FINAL)

```sql
CREATE POLICY audit_access ON audit_log
  FOR SELECT USING (
    org_id = current_org_id() OR org_id IS NULL
  );
```

System events (org_id IS NULL) visible to all authenticated users with appropriate role.

---

### 8.5 — Content/Blob CHECK Constraint (FINAL)

```sql
ALTER TABLE messages ADD CONSTRAINT content_xor_blob
  CHECK (
    (content IS NOT NULL AND blob_ref IS NULL) OR
    (content IS NULL AND blob_ref IS NOT NULL)
  );
```

---

### 9.2 — Uptime Target: Define What It Means (FINAL)

| Service | Target | Meaning |
|---------|--------|---------|
| Web UI loads | 99.9% | Landing page, dashboard, project list accessible |
| Sandbox available | 99.5% | Existing sandbox responsive (terminal, files work) |
| AI available | 99.0% | Claude API calls succeed |
| Overall "platform works" | 99.0% | All features functional end-to-end |

---

### 9.3 — Spot Instances: Pre-Eviction Handling (FINAL)

1. AKS provides 30-second eviction notice via Scheduled Events API
2. On notice: daemon triggers lightweight snapshot (file list + modified files only, not full disk)
3. Save terminal scrollback to PVC
4. Pod terminates
5. On reschedule: restore from last full snapshot + apply lightweight delta
6. **Free tier only** uses Spot instances (acceptable disruption for free). Pro/Team use regular VMs.

---

### 9.6 — DR: Write Runbooks (FINAL)

Add to Phase 5 deliverables: operational runbooks for:
1. AKS cluster failure recovery
2. PostgreSQL failover
3. Redis failure
4. Mass sandbox failure
5. Security incident (compromised sandbox)
6. Deployment rollback
7. Certificate renewal failure

Each runbook: step-by-step commands, expected timing, escalation contacts.

---

### 10.1 — Unit Economics: Acknowledged (FINAL)

**Decision**: Accept that v1 operates at a loss. This is a land-grab strategy funded by Azure credits. The user has explicitly said "worry about pricing later."

Document the cost structure honestly so we can optimize later:
- Track per-user cost (compute + AI + storage) as a metric
- Dashboard showing cost/user/tier
- This data informs future pricing decisions

---

### 10.6 — Timeline: Honest Estimate (FINAL)

**Decision**: Replace the 20-week timeline with phased milestones. No end-to-end timeline commitment.

Phase 1 (Foundation + POC): 6-8 weeks
Phase 2 (Sandbox + Editor): 6-8 weeks
Phase 3 (AI Agent): 4-6 weeks
Phase 4 (Preview + Git): 3-4 weeks
Phase 5 (Billing + Polish): 4-6 weeks
Phase 6 (Launch Prep): 2-4 weeks

**Total realistic range**: 25-36 weeks for a solo developer / small team.

Parallelization can compress this. The user's approach of using AI agents for development itself will be a force multiplier — but we should plan conservatively and beat the timeline, not the reverse.

---

## Summary of Key Reconciled Decisions

| Topic | Decision |
|-------|----------|
| ORM | Drizzle Kit |
| Network Policies | Cilium |
| Base Image | Ubuntu 24.04 LTS |
| Container Isolation | Kata Containers on AKS |
| Ingress | NGINX only (no Traefik) |
| Preview Domain | `bricks-preview.dev` (separate domain) |
| DNS in Sandboxes | External only (8.8.8.8) |
| Seccomp | Default-deny (allowlist) |
| Daemon Communication | Unix socket (not TCP port) |
| Sudo in Sandbox | Daemon only (UID 1000), not user (UID 1001) |
| Builder Mode Bash | Not auto-approved, requires user confirmation |
| WebSocket Auth | Short-lived query param token, logs stripped |
| File Edit (IDE) | Stage first, show diff, apply on accept |
| Free Tier RAM | 2 GB (1.6 GB effective after overhead) |
| AI Model Routing | Manual selection for v1, default Sonnet |
| Budget Ceiling | $10 Builder / $5 IDE / $2 Free |
| Opus Credit Multiplier | 10x (not 5x) |
| Compaction | Same-model, system message (not fake assistant) |
| Uptime | 99.0% end-to-end, 99.9% web UI |
| Timeline | 25-36 weeks realistic |
| Unit Economics | Accept loss, track metrics, optimize later |
