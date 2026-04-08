# Bricks Sandbox System: Production Design Document

> Version 1.0 | April 2026  
> Status: Architecture Proposal  
> Author: Infrastructure Architecture Team

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Pod Internals](#2-pod-internals)
3. [Sandbox Daemon](#3-sandbox-daemon)
4. [Resource Management](#4-resource-management)
5. [Lifecycle Management](#5-lifecycle-management)
6. [Security Isolation](#6-security-isolation)
7. [File Persistence](#7-file-persistence)
8. [App Preview (Port Forwarding)](#8-app-preview-port-forwarding)
9. [Scaling](#9-scaling)
10. [Pre-pulled Images](#10-pre-pulled-images)
11. [Git Integration](#11-git-integration)
12. [Failure Modes & Recovery](#12-failure-modes--recovery)
13. [Observability](#13-observability)
14. [Cost Model](#14-cost-model)
15. [Open Questions & Risks](#15-open-questions--risks)

---

## 1. Architecture Overview

### High-Level Topology

```
                                    +---------------------------+
                                    |     Bricks Web Client     |
                                    |  (Next.js, Monaco, xterm) |
                                    +------------+--------------+
                                                 |
                                          WebSocket / HTTPS
                                                 |
                                    +------------+--------------+
                                    |   API Gateway / Ingress   |
                                    | (NGINX Ingress Controller)|
                                    +--+--------+----------+---+
                                       |        |          |
                          +------------+  +-----+----+  +--+-----------+
                          |               |          |  |              |
                   +------+------+  +-----+----+ +---+--------+ +-----+------+
                   | Control     |  | Preview  | | WebSocket  | | Auth/API   |
                   | Plane (Go)  |  | Router   | | Gateway    | | (NestJS)   |
                   +------+------+  | (Traefik)| +---+--------+ +-----+------+
                          |         +-----+----+     |                 |
                          |               |          |                 |
                   +------+---------------+----------+-----------------+-------+
                   |                   AKS Cluster                             |
                   |  +------------+  +------------+  +------------+           |
                   |  | Sandbox    |  | Sandbox    |  | Sandbox    |  ...      |
                   |  | Pod (User) |  | Pod (User) |  | Pod (User) |           |
                   |  +------------+  +------------+  +------------+           |
                   |                                                           |
                   |  [Kata VM Isolation / gVisor Runtime Class]               |
                   +-----------------------------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                   |                   |
            +------+------+   +-------+------+   +--------+-------+
            | Azure Blob  |   | Azure Files  |   | Azure Container|
            | (Snapshots) |   | (Shared/PVC) |   | Registry       |
            +-------------+   +--------------+   +----------------+
```

### Design Principles

1. **Defense in depth**: Every boundary is a security boundary. Kernel isolation (Kata/gVisor) + network policies + seccomp + AppArmor + resource limits.
2. **Cattle, not pets**: Pods are disposable. State lives outside the pod. Any pod can be killed at any time and reconstructed.
3. **Fast warm, slow cold**: Warm pools eliminate cold start for active tiers. Cold start (full image pull + volume mount) is the fallback, not the norm.
4. **Isolation over density**: We will sacrifice pod density for security. A compromised sandbox must not be able to reach another sandbox or the control plane.
5. **Observable by default**: Every component emits structured logs, metrics, and traces. We cannot debug what we cannot see.

---

## 2. Pod Internals

### 2.1 Base Container Image

The sandbox image is a fat, multi-language development image. This is NOT a production runtime image -- it is a developer workstation. Minimizing image size is secondary to developer experience. We optimize pull time through pre-pulling, not image shrinkage.

**Base**: Ubuntu 24.04 LTS (not Alpine -- too many compatibility issues with native npm packages, Python wheels, and developer expectations)

**Pre-installed toolchain:**

| Category | Packages | Rationale |
|----------|----------|-----------|
| **Languages** | Node.js 22 LTS, Python 3.12, Go 1.23, Rust 1.78 (via rustup) | Top 4 languages on the platform |
| **Package Managers** | npm 10, yarn 4, pnpm 9, pip, poetry, uv, cargo | Developers expect their preferred package manager |
| **Build Tools** | gcc, g++, make, cmake, pkg-config | Required for native npm modules (node-gyp) and Python C extensions |
| **System Utilities** | git, curl, wget, vim, nano, less, htop, jq, unzip, ssh-client, ca-certificates | Standard developer utilities |
| **Runtime Support** | deno (latest), bun (latest) | Increasingly popular JS runtimes |
| **LSP Servers** | typescript-language-server, pyright, gopls, rust-analyzer | Installed globally, started on-demand by daemon |
| **Database Clients** | postgresql-client, mysql-client, redis-tools, sqlite3 | For connecting to managed databases |
| **Bricks Tooling** | bricks-daemon (our Node.js process), s6-overlay (init system) | Core sandbox infrastructure |

**Image size target**: 4-6 GB compressed (8-12 GB uncompressed). This is large, but acceptable because:
- Images are pre-pulled to every node in the sandbox node pool
- Layer caching means updates only pull changed layers
- The alternative (installing at runtime) adds minutes to cold start

**Image registry**: Azure Container Registry (ACR), same region as the AKS cluster. ACR is connected to AKS via managed identity (no image pull secrets needed).

**Image update cadence**: Weekly automated builds via CI. Canary rollout: new image goes to 5% of warm pool, then 25%, then 100% over 48 hours. Old images remain available for existing sessions.

### 2.2 Process Tree

```
PID 1: s6-overlay (init + supervisor)
  |
  +-- bricks-daemon (Node.js) [PID ~20]
  |     |
  |     +-- node-pty child: /bin/bash (terminal session 1)
  |     +-- node-pty child: /bin/bash (terminal session 2)
  |     +-- typescript-language-server (on-demand)
  |     +-- pyright (on-demand)
  |     +-- chokidar watcher subprocess
  |
  +-- s6-log (structured logging to stdout)
  +-- crond (for periodic cleanup tasks)
```

### 2.3 Init System: s6-overlay

**Why s6-overlay instead of systemd, supervisord, or tini:**

| Init System | Verdict | Reason |
|-------------|---------|--------|
| **systemd** | Rejected | Requires PID 1 privileges that conflict with container security. Enormous dependency tree. Overkill for container use. |
| **supervisord** | Rejected | Python-based (slow startup, memory overhead). No proper PID 1 behavior (doesn't reap zombies correctly in all cases). |
| **tini** | Insufficient | Only handles signal forwarding and zombie reaping. No process supervision, restart policies, or dependency ordering. |
| **s6-overlay** | Selected | Purpose-built for containers. 2 MB binary. Proper PID 1 behavior. Process supervision with restart policies. Dependency ordering between services. Readiness notification protocol. Written in C, near-zero overhead. |

**s6 service definitions:**

```
/etc/s6-overlay/s6-rc.d/
  bricks-daemon/
    type: longrun
    run: exec node /opt/bricks/daemon/index.js
    finish: # logs crash, triggers restart
    dependencies.d/
      base  # waits for base system
    consumer-for: # nothing, it IS the primary service
  
  log-collector/
    type: longrun
    run: exec s6-log -b -- /var/log/bricks/
    pipeline-name: bricks-daemon-log
    producer-for: bricks-daemon
```

**Restart policy**: If bricks-daemon crashes, s6 restarts it immediately. After 5 crashes within 60 seconds, s6 enters a "degraded" state and signals the control plane via a health check failure, which triggers pod replacement.

### 2.4 User Permissions

```
User layout:
  root (UID 0)     - s6-overlay runs as root for PID 1 duties only
  bricks (UID 1000) - bricks-daemon runs as this user
  sandbox (UID 1001) - user terminal sessions run as this user
```

**Why separate bricks and sandbox users:**
- The daemon needs to manage terminals, LSP processes, and file watchers -- it runs as `bricks` (UID 1000)
- User code runs as `sandbox` (UID 1001) -- a further-restricted user
- `bricks` user (UID 1000/daemon) has controlled sudo for package installation via API endpoint. The daemon handles `apt install` requests through a dedicated API method, using a writable overlay for `/usr` paths.
- `sandbox` user (UID 1001) has **NO sudo access**. Package installation is only available through the daemon's API endpoint (e.g., `terminal.installPackage` or a dedicated REST call). Direct `sudo apt install` from the user shell is not available.
- The daemon runs as `bricks` to protect itself from user code -- a malicious `kill -9` from user code cannot kill the daemon (different UID, not root)

**Why sandbox has no sudo:**
Granting sudo to the sandbox user would allow arbitrary privilege escalation within the pod. Instead, package installation is mediated by the daemon (UID 1000), which validates and executes `apt install` requests on behalf of the user. This preserves developer experience (users can still install packages) while maintaining process-level isolation between user code and privileged operations.

### 2.5 Filesystem Layout

```
/
+-- /home/sandbox/           # User's home directory (persisted)
|   +-- /home/sandbox/workspace/  # Project files (persisted, this is the root of their project)
|   +-- /home/sandbox/.config/    # User configs, shell history, etc. (persisted)
|   +-- /home/sandbox/.cache/     # Package manager caches (NOT persisted, ephemeral)
|
+-- /opt/bricks/             # Bricks platform code (read-only, baked into image)
|   +-- /opt/bricks/daemon/       # Daemon source code
|   +-- /opt/bricks/scripts/      # Lifecycle scripts
|   +-- /opt/bricks/lsp/          # LSP server binaries and configs
|
+-- /tmp/                    # Ephemeral temp space (tmpfs, 512MB limit)
+-- /var/run/bricks/         # Unix domain sockets for daemon IPC
+-- /var/log/bricks/         # Log output (ephemeral, streamed to stdout for collection)
```

**Mount details:**

| Path | Storage Type | Persisted? | Size Limit | Notes |
|------|-------------|------------|------------|-------|
| `/workspace` | Azure Disk PVC | Yes | Per tier (see Section 4) | User's project files |
| `/tmp/` | emptyDir | No | 1 GB | Ephemeral scratch space |
| `/var/log/bricks/` | emptyDir | No | 50 MB | Log output, streamed to stdout for collection |
| `/var/run/bricks/` | emptyDir | No | N/A | Unix domain sockets for daemon IPC |
| `/home/bricks/` | emptyDir | No | N/A | Daemon user home directory |
| `/home/sandbox/` | emptyDir | No | N/A | Sandbox user home directory |
| `/opt/bricks/` | Image layer (read-only) | N/A | N/A | Immutable platform code |

**Root filesystem is read-only.** Package installation is handled by the daemon (UID 1000) via an API endpoint which uses a writable overlay for `/usr` paths. Direct `sudo apt install` from the user shell is not available. The writable overlay ensures installed packages persist for the session but are discarded on pod restart (packages needed across restarts should be specified in the sandbox template configuration).

---

## 3. Sandbox Daemon

### 3.1 Overview

The sandbox daemon (`bricks-daemon`) is the brain inside the pod. It is a Node.js process that:

1. Exposes a WebSocket API to the Bricks frontend
2. Manages terminal sessions via node-pty
3. Manages file operations and watches the filesystem
4. Starts/stops LSP servers on demand
5. Reports health, resource usage, and metrics to the control plane
6. Handles graceful shutdown and state snapshotting

**Why Node.js (not Go, not Rust):**
- Same language as the frontend team -- shared code, shared debugging tools
- node-pty is the battle-tested PTY library for Node.js
- Excellent WebSocket ecosystem (ws library)
- Fast iteration speed -- the daemon will evolve rapidly in early stages
- Memory overhead (~50-80 MB) is acceptable given per-pod resource budgets

### 3.2 API Design

The daemon exposes a single WebSocket endpoint. All communication uses JSON-RPC 2.0 over WebSocket, with binary channels for terminal I/O.

**Connection**: `wss+unix:///var/run/bricks/daemon.sock` (Unix domain socket -- the daemon does NOT listen on a TCP port. This prevents user code from connecting to the daemon.)

The API is multiplexed -- a single WebSocket connection carries all channels (terminals, file ops, LSP, control). Each message has a `channel` field to route it.

#### 3.2.1 Terminal API

```jsonc
// Client -> Daemon: Create terminal
{
  "jsonrpc": "2.0",
  "method": "terminal.create",
  "id": 1,
  "params": {
    "cols": 120,
    "rows": 40,
    "cwd": "/home/sandbox/workspace",
    "env": { "TERM": "xterm-256color" },
    "shell": "/bin/bash"  // optional, defaults to user's shell
  }
}

// Daemon -> Client: Terminal created
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "terminalId": "t_abc123",
    "pid": 4521
  }
}

// Client -> Daemon: Send input (binary-optimized)
// Uses a binary frame: [0x01 (terminal marker)][terminalId (16 bytes)][raw bytes]
// This avoids JSON overhead for every keystroke.

// Daemon -> Client: Terminal output (binary-optimized)
// Same binary frame format for output.

// Client -> Daemon: Resize terminal
{
  "jsonrpc": "2.0",
  "method": "terminal.resize",
  "params": { "terminalId": "t_abc123", "cols": 200, "rows": 50 }
}

// Client -> Daemon: Kill terminal
{
  "jsonrpc": "2.0",
  "method": "terminal.kill",
  "params": { "terminalId": "t_abc123" }
}
```

**Concurrency**: Up to 8 simultaneous terminal sessions per pod. Each terminal is a separate node-pty instance. Terminal sessions are tracked in-memory; if the daemon restarts, terminals are lost (user sees "Terminal disconnected, reconnecting..." and a new shell spawns).

**Terminal output buffering**: The daemon maintains a scrollback buffer (last 10,000 lines) per terminal in memory. When the frontend reconnects after a brief disconnect, it receives the buffered output so the user doesn't lose context.

#### 3.2.2 File System API

```jsonc
// Read file
{ "method": "fs.readFile", "params": { "path": "/home/sandbox/workspace/src/index.ts" } }
// Returns: { "result": { "content": "...", "encoding": "utf-8" } }
// For binary files, content is base64 encoded.

// Write file
{ "method": "fs.writeFile", "params": { "path": "...", "content": "...", "encoding": "utf-8" } }

// Read directory
{ "method": "fs.readDir", "params": { "path": "/home/sandbox/workspace/src/" } }
// Returns: { "result": { "entries": [{ "name": "index.ts", "type": "file", "size": 2048, "mtime": 1712534400 }, ...] } }

// Watch events (daemon -> client, unsolicited notifications)
{
  "jsonrpc": "2.0",
  "method": "fs.change",
  "params": {
    "type": "modify",  // create | modify | delete | rename
    "path": "/home/sandbox/workspace/src/index.ts"
  }
}

// File tree (optimized batch read for initial load)
{ "method": "fs.tree", "params": { "path": "/home/sandbox/workspace/", "depth": 3 } }
// Returns nested structure. Excludes node_modules/.git by default unless explicitly requested.
```

**File watcher implementation**: Chokidar v4 watches `/home/sandbox/workspace/` recursively. Key settings:
- `ignored`: `['**/node_modules/**', '**/.git/objects/**', '**/dist/**', '**/build/**', '**/.next/**']`
- `awaitWriteFinish`: `{ stabilityThreshold: 100, pollInterval: 50 }` -- prevents partial-write events
- `usePolling: false` -- uses inotify (kernel-level, efficient)
- Debounce: Events are batched and sent every 100ms to avoid flooding the WebSocket

**Large file handling**: Files > 1 MB are not sent in full -- the client gets a truncation notice and can request chunks via `fs.readFileChunk` with offset/length parameters. Files > 50 MB are flagged as "too large to edit" in the UI.

**Binary protocol for bulk transfers**: When the client requests a directory download or project export, we switch to a binary tar stream instead of JSON.

#### 3.2.3 LSP API

LSP servers are not directly exposed over WebSocket. Instead, the daemon acts as a proxy:

```
Browser (Monaco) <--WebSocket--> Daemon <--stdio--> LSP Server Process
```

```jsonc
// Start LSP server for a language
{ "method": "lsp.start", "params": { "languageId": "typescript", "rootUri": "file:///home/sandbox/workspace" } }

// Forward LSP message to server
{ "method": "lsp.send", "params": { "languageId": "typescript", "message": { /* standard LSP JSON-RPC */ } } }

// Receive LSP message from server (daemon -> client)
{ "method": "lsp.receive", "params": { "languageId": "typescript", "message": { /* standard LSP JSON-RPC */ } } }
```

**LSP server lifecycle:**
- Servers are started on-demand when the user opens a file of that language
- Servers are killed after 5 minutes of inactivity (no open files of that language)
- At most 3 LSP servers simultaneously (to prevent memory exhaustion)
- If memory pressure is detected, least-recently-used LSP server is killed first

**Supported LSP servers:**

| Language | Server | Memory Budget |
|----------|--------|---------------|
| TypeScript/JavaScript | typescript-language-server (wraps tsserver) | 512 MB max |
| Python | pyright | 384 MB max |
| Go | gopls | 256 MB max |
| Rust | rust-analyzer | 768 MB max |
| HTML/CSS | vscode-langservers-extracted | 128 MB max |
| JSON/YAML | vscode-langservers-extracted | 128 MB max |

#### 3.2.4 Control API (Internal, not exposed to frontend)

```jsonc
// Health check (called by Kubernetes liveness probe via HTTP, not WebSocket)
// GET /healthz -> 200 OK or 500

// Readiness check (called by Kubernetes readiness probe)
// GET /readyz -> 200 OK when daemon is fully initialized and ready for connections

// Metrics (Prometheus format, scraped by monitoring)
// GET /metrics -> Prometheus text format

// Graceful shutdown trigger
// POST /shutdown -> daemon starts graceful shutdown sequence

// Snapshot trigger (from control plane)
// POST /snapshot -> daemon flushes all buffers, syncs filesystem, responds when safe to snapshot
```

### 3.3 Daemon Crash Recovery

**If the daemon crashes:**
1. s6-overlay detects the crash (process exit) and restarts the daemon within 1 second
2. The Kubernetes liveness probe fails after 3 consecutive failures (30 seconds)
3. If s6 cannot recover (5 crashes in 60 seconds), the liveness probe failure triggers pod restart
4. The frontend detects WebSocket disconnection immediately and shows a "Reconnecting..." overlay
5. On reconnection, the frontend re-establishes terminal sessions and re-fetches the file tree
6. Terminal scrollback is lost on daemon crash (acceptable -- user sees a fresh shell)

**If the WebSocket connection drops (network blip, not daemon crash):**
1. Frontend uses exponential backoff reconnection: 100ms, 200ms, 400ms, 800ms, ... up to 30 seconds
2. On reconnection, frontend sends a `session.restore` message with the last known state
3. Daemon responds with current state (active terminals, file tree hash, etc.)
4. Terminal scrollback buffer (10,000 lines retained in daemon memory) is replayed to the client
5. If the disconnect lasted < 60 seconds, terminals are still alive and the user sees no interruption
6. If > 60 seconds, terminals may have produced output the buffer cannot hold -- user sees a gap indicator

### 3.4 Concurrency Model

The daemon is single-threaded (Node.js event loop) with the following concurrency strategy:

- **Terminal I/O**: Non-blocking. node-pty uses native bindings that don't block the event loop. Output is streamed via events.
- **File reads**: Non-blocking. Uses `fs.promises` API (libuv thread pool).
- **File writes**: Queued per-file. No two concurrent writes to the same file. Writes to different files are parallel.
- **LSP messages**: Forwarded asynchronously. The daemon does not process LSP payloads, just routes them.
- **File watching**: Chokidar runs on the event loop. Events are batched and debounced.

**Potential bottleneck**: A `fs.tree` call on a project with 100,000 files could block the event loop. Mitigation: `fs.tree` runs in a worker thread with a 5-second timeout and a maximum depth/count limit.

---

## 4. Resource Management

### 4.1 Tier Definitions

| Resource | Free Tier | Pro Tier | Team Tier |
|----------|-----------|----------|-----------|
| **CPU** | 1 vCPU (request: 0.5, limit: 1.0) | 2 vCPU (request: 1.0, limit: 2.0) | 4 vCPU (request: 2.0, limit: 4.0) |
| **Memory** | 2 GB (request: 1 GB, limit: 2 GB) | 4 GB (request: 2 GB, limit: 4 GB) | 8 GB (request: 4 GB, limit: 8 GB) |
| **Disk (PVC)** | 5 GB | 20 GB | 50 GB |
| **Ephemeral Storage** | 5 GB (cache) | 10 GB (cache) | 20 GB (cache) |
| **Concurrent Terminals** | 4 | 8 | 16 |
| **Session Duration** | 2 hours (then idle timeout) | 8 hours | 24 hours |
| **Idle Timeout** | 10 minutes | 30 minutes | 2 hours |
| **Active Sandboxes** | 1 | 3 | 10 |
| **Outbound Network** | Yes (rate limited: 10 Mbps) | Yes (rate limited: 50 Mbps) | Yes (rate limited: 100 Mbps) |
| **App Preview Ports** | 1 | 5 | 10 |

### 4.2 CPU Management

**Kubernetes CPU limits use CFS (Completely Fair Scheduler) throttling.** When a pod hits its CPU limit, it is not killed -- it is throttled. The process slows down.

Implications:
- Compilation (webpack, cargo build) will be slow on Free tier but won't OOM
- CPU throttling is invisible to the user -- things just feel slow. We surface this in the UI: "Your sandbox is being CPU-throttled. Upgrade to Pro for faster builds."
- The daemon monitors `/sys/fs/cgroup/cpu.stat` for `nr_throttled` and `throttled_time` and reports to the frontend

**CPU burst**: For short bursts (< 5 seconds), Kubernetes allows exceeding CPU requests up to the limit. This helps with interactive tasks (starting a dev server, running a quick test).

### 4.3 Memory Management (OOM)

**When a pod hits its memory limit, the OOM killer activates.** This is the most disruptive resource event.

OOM kill order (most likely to be killed first):
1. Language servers (rust-analyzer, tsserver can balloon to 1 GB+)
2. User processes (dev servers, build tools)
3. bricks-daemon (last resort -- should be protected)

**OOM prevention strategy:**

1. **Daemon memory budget**: The daemon itself targets < 100 MB. We set `--max-old-space-size=128` for the Node.js process.

2. **LSP memory caps**: Each LSP server is launched with memory limits:
   - `tsserver`: `--max-old-space-size=512`
   - `pyright`: ulimit -v
   - `rust-analyzer`: Wrapped in a cgroup sub-limit

3. **Proactive monitoring**: The daemon reads `/sys/fs/cgroup/memory.current` and `/sys/fs/cgroup/memory.max` every 5 seconds. When usage exceeds 85% of limit:
   - Kill least-recently-used LSP server
   - Send warning to frontend: "Memory usage is high. Some features may be disabled."
   
   When usage exceeds 95%:
   - Kill ALL LSP servers
   - Send critical warning to frontend
   - Log to control plane for tier upgrade prompt

4. **OOM score adjustment**: The daemon's `oom_score_adj` is set to -999 (protected). User processes run with default score. LSP servers run with +500 (killed first).

### 4.4 Disk Quotas

**PVC disk quota** is enforced by Azure Disk size. If the user fills the disk:
- Write operations fail with ENOSPC
- The daemon catches this and sends a clear error to the frontend
- The frontend shows disk usage and suggests cleanup (`node_modules`, build artifacts)
- `du -sh` summary is available via the daemon API

**Ephemeral storage (emptyDir) quota**: Kubernetes enforces `ephemeral-storage` limits. If the cache (`/home/sandbox/.cache/`) exceeds the limit, the pod is evicted. To prevent this:
- The daemon runs a periodic cleanup (every 5 minutes) that prunes the npm/pip/cargo cache if it exceeds 80% of the ephemeral limit
- `npm cache clean --force` and `pip cache purge` are aggressive but acceptable -- caches rebuild

### 4.5 Anti-Abuse: Crypto Mining & Resource Abuse

**Detection layers:**

1. **CPU pattern detection** (daemon-level): The daemon monitors CPU usage patterns. Sustained >90% CPU for >5 minutes with no terminal interaction triggers a "suspected abuse" flag sent to the control plane.

2. **Process name heuristics** (daemon-level): The daemon periodically scans `/proc/*/comm` for known mining binaries: `xmrig`, `minerd`, `cpuminer`, `ethminer`, `nbminer`, etc. Instant termination + flag.

3. **Network pattern detection** (control plane level): Outbound connections to known mining pool IPs/domains (maintained blocklist). Stratum protocol detection (TCP connections on port 3333, 4444, etc.).

4. **cgroup CPU accounting** (control plane level): Pods that consistently use >90% of their CPU limit for >30 minutes are flagged for review. This catches miners even if they rename the binary.

5. **eBPF-based runtime detection** (node level): Falco or ARMO with eBPF sensors on each node. Detects anomalous syscall patterns (crypto mining has distinctive syscall signatures: high rates of specific math-related syscalls).

**Response to detected abuse:**
- Immediate: Pod is terminated
- Account: Flagged for review, sandbox creation temporarily suspended
- Repeated: Account suspended pending manual review

---

## 5. Lifecycle Management

### 5.1 State Machine

```
                        User clicks                          User returns
                       "New Sandbox"                        (has snapshot)
                            |                                    |
                            v                                    v
                     +-----------+                        +------------+
          +--------->| CREATING  |                        | RESTORING  |
          |          +-----------+                        +------------+
          |               |                                    |
          |     Pod scheduled, PVC                  PVC restored from
          |     bound, daemon ready                 snapshot, pod starts
          |               |                                    |
          |               v                                    v
          |          +-----------+                        +-----------+
          |          |  ACTIVE   |<----- user activity ---|  ACTIVE   |
          |          +-----------+                        +-----------+
          |               |                                    |
          |     No user activity                               |
          |     for idle_timeout                               |
          |               |                                    |
          |               v                                    |
          |          +-----------+                             |
          |          |   IDLE    |-------- user returns ------+
          |          +-----------+
          |               |
          |     Idle for snapshot_timeout
          |     (30 min Free, 2hr Pro)
          |               |
          |               v
          |       +--------------+
          |       | SNAPSHOTTING |
          |       +--------------+
          |               |
          |       Filesystem synced
          |       to Azure Blob, PVC
          |       snapshot created
          |               |
          |               v
          |       +--------------+
          |       |  SUSPENDED   |---- user returns (fast) ----> RESTORING
          |       +--------------+
          |               |
          |       After retention_period
          |       (7 days Free, 30 days Pro)
          |               |
          |               v
          |       +--------------+
          |       |  DESTROYED   |
          |       +--------------+
          |               |
          |       Blob snapshot retained
          |       (30 days Free, 90 days Pro)
          |       then permanently deleted
          |               |
          |               v
          |       +--------------+
          +-------|   ARCHIVED   |---- user explicitly restores (slow) ---+
                  +--------------+
```

### 5.2 State Transitions in Detail

#### CREATING (Target: < 10 seconds with warm pool, < 60 seconds cold)

1. Control plane receives "create sandbox" request
2. **Warm pool path** (common case):
   - Control plane claims a pre-warmed pod from the warm pool
   - Pre-warmed pod already has: image pulled, PVC attached (empty), daemon running, health check passing
   - Control plane sends `POST /initialize` to daemon with user config (git repo URL, environment variables, tier limits)
   - Daemon clones the repo (or restores from snapshot), configures user environment
   - **Time: 3-10 seconds** (dominated by git clone)
   
3. **Cold start path** (warm pool exhausted):
   - Control plane creates a new Pod manifest + PVC claim
   - Pod is scheduled to a node (requires Kata VM provisioning)
   - Image is already pre-pulled (if not, this adds 30-60 seconds -- catastrophic)
   - PVC is dynamically provisioned (Azure Disk: 10-30 seconds)
   - Daemon boots, receives initialization
   - **Time: 30-60 seconds**

4. **Failure modes during creation:**
   - No nodes available: Queue the request, trigger node pool scale-up. Show "Waiting for capacity" with ETA.
   - PVC provisioning fails: Retry once, then fail with "Storage temporarily unavailable"
   - Image pull fails (image not pre-pulled on this node): Fall back to pulling. Log as critical incident (pre-pull gap).
   - Git clone fails: Pod is created but workspace is empty. User sees "Clone failed" with retry button.

#### ACTIVE -> IDLE Detection

The daemon tracks user activity signals:
- WebSocket messages received (any)
- Terminal input events
- File save events
- LSP interactions

A heartbeat is sent from the frontend every 30 seconds. If no activity AND no heartbeat for `idle_timeout`:
1. Daemon sends `idle.warning` to frontend (if still connected): "Your sandbox will suspend in 5 minutes"
2. If no response after 5 more minutes: transition to IDLE
3. Daemon notifies control plane: `PATCH /sandboxes/{id}/status = idle`

**Edge case: Long-running process with no interaction.** A user starts `npm run build` (takes 20 minutes) and walks away. The terminal has output, but there is no user input.

Resolution: Terminal output counts as "activity" for idle detection purposes. Only truly idle pods (no user input AND no process output for the timeout period) are suspended.

#### IDLE -> SNAPSHOTTING

1. Control plane triggers snapshot after `snapshot_timeout`
2. Sends `POST /snapshot` to daemon
3. Daemon:
   a. Flushes all file buffers (`sync` syscall)
   b. Terminates all user processes gracefully (SIGTERM, then SIGKILL after 10 seconds)
   c. Kills all LSP servers
   d. Writes a state manifest: `{ lastDir: "/home/sandbox/workspace/src", openFiles: [...], terminalHistory: [...] }`
   e. Responds "ready for snapshot"
4. Control plane creates Azure Disk snapshot (VolumeSnapshot CRD)
5. Once snapshot is ReadyToUse (10-30 seconds for Azure Disk), control plane deletes the pod
6. Sandbox transitions to SUSPENDED

#### SUSPENDED -> RESTORING (Target: < 15 seconds)

1. User returns, hits API: `POST /sandboxes/{id}/restore`
2. **Warm pool path** (common):
   - Claim a pre-warmed pod
   - Restore PVC from snapshot (create new PVC with snapshot as dataSource)
   - PVC restoration: Azure Disk from snapshot takes 10-30 seconds
   - Daemon receives initialization with restore flag
   - Daemon reads state manifest, sends to frontend: previously open files, working directory
   - **Time: 10-20 seconds**
   
3. **Without warm pool**:
   - Full cold start + snapshot restore
   - **Time: 30-90 seconds**

#### Network Disconnect During Active Use

This is the most common disruption. The user closes their laptop, their WiFi drops, etc.

1. Frontend WebSocket disconnects
2. Daemon notices (WebSocket `close` event) -- but does NOT immediately terminate
3. Daemon enters "headless" mode: all user processes keep running. Terminals keep running. Output is buffered.
4. Idle timeout starts counting from the disconnect moment
5. If user reconnects within idle timeout: seamless resume. Buffered terminal output is replayed.
6. If user doesn't reconnect: normal idle -> snapshot -> suspend flow

**Critical edge case: User is running a deployment script and WiFi drops.**
- The script keeps running inside the pod
- Terminal output is buffered (up to 10,000 lines per terminal)
- User reconnects 5 minutes later, sees all the output, script has completed
- This is a MAJOR UX advantage over solutions that kill pods on disconnect

### 5.3 Warm Pool Design

The warm pool is a set of pre-created, unassigned sandbox pods maintained by the control plane.

**Warm pool sizing formula:**
```
target_warm_pods = max(
  min_warm_pods,                           // Floor: never less than this
  avg_creation_rate_per_minute * 2,        // 2 minutes of runway
  concurrent_active_sandboxes * 0.05       // 5% of active as buffer
)
```

**Warm pool parameters by scale:**

| Scale | Active Sandboxes | Warm Pool Size | Min | Max |
|-------|-----------------|----------------|-----|-----|
| Launch | 10-50 | 5 | 3 | 10 |
| Growth | 50-500 | 20 | 10 | 50 |
| Scale | 500-5000 | 100 | 50 | 200 |
| Large | 5000+ | 300 | 100 | 500 |

**Warm pool pod spec:**
- Image: pre-pulled (guaranteed by DaemonSet that pulls on every node)
- PVC: P2 (8 GB) Azure Disk for Free tier, P10 (128 GB) for Pro/Team -- pre-provisioned but empty
- Daemon: running, health check passing, waiting for `POST /initialize`
- Runtime class: `kata-vm-isolation`
- Labels: `bricks.io/role=warm-pool`, `bricks.io/tier=default`

**Warm pool replenishment**: A Kubernetes controller (Go, running in control plane) watches the warm pool count and creates replacement pods whenever the count drops below target. Replenishment rate is limited to avoid overwhelming the API server: max 10 pod creates per minute.

---

## 6. Security Isolation

### 6.1 Isolation Architecture (Defense in Depth)

```
Layer 1: Kata Containers (hardware VM boundary)
  |
  +-- Each pod runs in its own lightweight VM with its own kernel
  |   Hypervisor: Cloud Hypervisor (default on AKS Kata)
  |   Even root inside the VM cannot access the host kernel
  |
  Layer 2: Kubernetes Network Policies (network boundary)
    |
    +-- Pods cannot communicate with each other
    |   Pods cannot access the Kubernetes API server
    |   Pods CAN access the internet (egress) through a controlled gateway
    |
    Layer 3: Seccomp Profile (syscall filtering)
      |
      +-- Custom seccomp profile that allows common development syscalls
      |   but blocks dangerous ones (see 6.3)
      |
      Layer 4: AppArmor Profile (MAC enforcement)
        |
        +-- Restricts file access patterns, capability usage
        |
        Layer 5: Resource Limits (resource boundary)
          |
          +-- CPU, memory, disk, network rate limits per tier
          |
          Layer 6: User Separation (process boundary)
            |
            +-- daemon runs as UID 1000, user code runs as UID 1001
```

### 6.2 Why Kata Containers (Not gVisor) on AKS

| Factor | Kata Containers | gVisor |
|--------|----------------|--------|
| **AKS Support** | Native. `--workload-runtime KataVmIsolation` | Not natively supported on AKS. Must self-manage. |
| **Isolation Strength** | Strongest. Hardware VM boundary. Separate kernel. | Strong but userspace. Syscall emulation, not a real kernel boundary. |
| **Compatibility** | Near-perfect Linux compatibility. Own kernel. | ~70% syscall compatibility. Some npm packages, Python C extensions, Go programs may break. |
| **Performance Overhead** | ~5-10% overhead. ~200ms VM boot. ~30MB memory overhead per VM. | ~10-30% I/O overhead. Near-zero boot overhead. ~10MB memory overhead. |
| **Developer Experience Impact** | None. Everything works as expected. | Developers hit mysterious failures: "why does X work locally but not in the sandbox?" |
| **Package installation (via daemon API)** | Works perfectly -- real kernel. | Partially works. Some package installations fail due to missing syscalls. |

**Decision: Kata Containers.** The compatibility advantage is decisive for a developer platform. We cannot have users debugging gVisor syscall gaps. The performance overhead (~5-10%) and memory cost (~30 MB per pod) are acceptable.

**Fallback plan**: If Kata proves problematic at scale (boot time, resource overhead), we can introduce gVisor as an option for "light" sandboxes (e.g., free tier preview-only mode) while keeping Kata for Pro/Team tiers.

### 6.3 Seccomp Profile

Even with Kata isolation, we apply a seccomp profile as a second layer. This uses a **default-DENY (allowlist)** approach -- only explicitly permitted syscalls are allowed:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "openat", "close", "stat", "fstat", "lstat",
        "poll", "lseek", "mmap", "mprotect", "munmap", "brk",
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "ioctl", "pread64", "pwrite64", "readv", "writev",
        "access", "pipe", "pipe2", "select", "pselect6",
        "sched_yield", "mremap", "msync", "mincore", "madvise",
        "shmget", "shmat", "shmctl", "shmdt",
        "dup", "dup2", "dup3", "pause", "nanosleep", "clock_nanosleep",
        "getitimer", "alarm", "setitimer",
        "getpid", "sendfile",
        "socket", "connect", "accept", "accept4",
        "sendto", "recvfrom", "sendmsg", "recvmsg",
        "shutdown", "bind", "listen", "getsockname", "getpeername",
        "socketpair", "setsockopt", "getsockopt",
        "clone", "clone3", "fork", "vfork", "execve", "execveat",
        "exit", "exit_group", "wait4", "waitid",
        "kill", "tgkill", "tkill",
        "uname", "fcntl", "flock", "fsync", "fdatasync",
        "truncate", "ftruncate",
        "getdents", "getdents64", "getcwd", "chdir", "fchdir",
        "rename", "renameat", "renameat2",
        "mkdir", "mkdirat", "rmdir",
        "creat", "link", "linkat", "unlink", "unlinkat",
        "symlink", "symlinkat", "readlink", "readlinkat",
        "chmod", "fchmod", "fchmodat",
        "chown", "fchown", "fchownat", "lchown",
        "umask", "gettimeofday", "clock_gettime", "clock_getres",
        "getrlimit", "setrlimit", "prlimit64",
        "getrusage", "sysinfo", "times",
        "getuid", "getgid", "geteuid", "getegid",
        "setuid", "setgid", "setreuid", "setregid",
        "getgroups", "setgroups",
        "getresuid", "getresgid", "setresuid", "setresgid",
        "getpgid", "setpgid", "getpgrp", "getsid", "setsid",
        "sigaltstack", "statfs", "fstatfs",
        "prctl", "arch_prctl",
        "futex", "set_tid_address", "set_robust_list", "get_robust_list",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait",
        "timerfd_create", "timerfd_settime", "timerfd_gettime",
        "eventfd", "eventfd2", "signalfd", "signalfd4",
        "inotify_init", "inotify_init1", "inotify_add_watch", "inotify_rm_watch",
        "fadvise64", "fallocate",
        "getrandom", "memfd_create", "copy_file_range",
        "statx", "rseq",
        "newfstatat", "ppoll",
        "splice", "tee", "vmsplice",
        "mlock", "mlock2", "munlock", "mlockall", "munlockall",
        "sched_getaffinity", "sched_setaffinity",
        "sched_getscheduler", "sched_setscheduler",
        "sched_getparam", "sched_setparam",
        "capget", "capset",
        "seccomp",
        "close_range", "openat2", "faccessat2", "pidfd_open"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [],
      "comment": "Allow common syscalls needed for development workflows"
    }
  ]
}
```

**Explicitly DENIED syscalls (blocked by default-DENY, NOT in the allowlist above):**
- `io_uring_setup`, `io_uring_enter`, `io_uring_register` -- io_uring attack surface
- `mount`, `umount2` -- filesystem manipulation
- `ptrace` -- process debugging/injection
- `setns`, `unshare` -- namespace manipulation
- `chroot` -- filesystem root manipulation
- `reboot`, `kexec_load`, `kexec_file_load` -- system control
- `init_module`, `finit_module`, `delete_module` -- kernel module loading
- `bpf` -- eBPF injection
- `swapon`, `swapoff`, `acct`, `settimeofday`, `clock_settime`, `adjtimex`, `pivot_root`, `nfsservctl`, `lookup_dcookie`, `perf_event_open`, `userfaultfd`

**Known limitation: Bun uses io_uring and will have degraded performance.** Bun falls back to epoll when io_uring is unavailable, which is slower but functional.

**Philosophy: Default DENY, explicit ALLOW.** We use an allowlist (default-deny) approach:
- Defense in depth: even inside a Kata VM, only known-safe syscalls are permitted
- Any new/unknown syscall is blocked by default, reducing attack surface from kernel zero-days
- The allowlist is comprehensive enough for standard development workflows (compiling, running servers, package installation, etc.)

### 6.4 Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-isolation
  namespace: sandboxes
spec:
  podSelector:
    matchLabels:
      bricks.io/role: sandbox
  policyTypes:
    - Ingress
    - Egress
  
  ingress:
    # Only allow traffic from the WebSocket gateway and preview router
    - from:
        - namespaceSelector:
            matchLabels:
              bricks.io/system: gateway
        - namespaceSelector:
            matchLabels:
              bricks.io/system: preview-router
      ports:
        - port: 3000-9999  # App preview ports
          protocol: TCP
        # Note: Daemon communicates via Unix socket /var/run/bricks/daemon.sock
        # The WebSocket gateway connects through a sidecar or node-level proxy, not a TCP port
  
  egress:
    # Allow outbound HTTPS (npm install, pip install, git clone, etc.)
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              # Block access to entire link-local range (includes Azure IMDS at 169.254.169.254)
              - 169.254.0.0/16
              # Block access to Azure Wireserver (platform agent, credential theft vector)
              - 168.63.129.16/32
              # Block access to Kubernetes API server
              - 10.0.0.1/32
              # Block access to other pods in the cluster (entire pod CIDR)
              - 10.244.0.0/16
              # Block access to node network
              - 10.240.0.0/16
      ports:
        - port: 443
          protocol: TCP
        - port: 80
          protocol: TCP
        - port: 22
          protocol: TCP  # git clone via SSH
        - port: 9418
          protocol: TCP  # git protocol
```

**Critical security notes:**

1. **Block 169.254.0.0/16**: The entire link-local range, which includes the Azure Instance Metadata Service (IMDS) at 169.254.169.254. If a sandbox can reach IMDS, it can steal the node's managed identity credentials and access Azure resources. This is the #1 attack vector in cloud container escapes. We also block **168.63.129.16** (Azure Wireserver / platform agent), which is another credential theft vector.

2. **Block pod-to-pod**: Sandboxes must NEVER be able to reach other sandboxes directly. All communication goes through the gateway.

3. **Block Kubernetes API**: Sandboxes must not be able to query or modify Kubernetes resources.

4. **Allow outbound HTTP/HTTPS**: Required for `npm install`, `pip install`, `cargo build`, `git clone`, and general development. Blocking this would make the platform useless.

5. **Egress rate limiting**: Implemented via Cilium network policy extensions (bandwidth annotations). Prevents sandboxes from being used as DDoS amplifiers.

### 6.5 Docker-in-Docker (DinD) / Running Docker Inside Sandbox

**Decision: Not supported in v1.**

Running Docker inside the sandbox requires either:
- Docker socket passthrough (catastrophic security -- direct host access)
- Nested virtualization inside Kata VM (theoretically possible but extremely complex, performance is terrible)
- Sysbox (doesn't work inside Kata)
- Rootless Docker/Podman (might work inside Kata, but untested on AKS + Kata combination, likely to have issues)

**What we offer instead:**
- The base image includes the languages and tools users need
- Users can install additional system packages via the daemon's package installation API
- For users who need Docker (e.g., docker-compose based projects), we offer a future "Docker-enabled" sandbox type with Sysbox isolation (different node pool, higher tier only, separate security posture)

### 6.6 Outbound Network Filtering

Beyond network policies, we deploy an egress proxy (Squid or Envoy) that:

1. **DNS-level blocking**: Block known malicious domains, mining pool domains, C2 servers. Updated daily from threat intelligence feeds.

2. **Protocol enforcement**: Only HTTP/HTTPS/SSH/Git traffic is allowed outbound. Raw TCP connections (e.g., Stratum mining protocol) are blocked.

3. **Rate limiting**: Per-pod outbound bandwidth limits (see tier table). Prevents abuse of the platform as a proxy/VPN.

4. **Logging**: All outbound connections are logged (destination IP/domain, bytes transferred) for abuse investigation. Logs are retained for 30 days.

---

## 7. File Persistence

### 7.1 Storage Architecture

```
Hot Path (Active Pod):
  Azure Managed Disk (PVC)
  +-- /home/sandbox/workspace/    <- user project files
  +-- /home/sandbox/.config/      <- user dotfiles
  +-- state-manifest.json         <- daemon state for restore

Warm Path (Suspended):
  Azure Disk Snapshot (VolumeSnapshot)
  +-- Point-in-time snapshot of the PVC
  +-- Restore time: 10-30 seconds
  +-- Cost: ~$0.05/GB/month (snapshot storage)

Cold Path (Archived):
  Azure Blob Storage (Archive tier)
  +-- tar.gz of workspace directory
  +-- Restore time: minutes (rehydration from archive tier)
  +-- Cost: ~$0.002/GB/month
```

### 7.2 What Gets Persisted (and What Doesn't)

| Path | Persisted? | Why |
|------|-----------|-----|
| `/home/sandbox/workspace/` (project files) | YES | User's work. Critical. |
| `/home/sandbox/.config/` (dotfiles, git config) | YES | User preferences. |
| `/home/sandbox/.ssh/` (SSH keys) | YES (encrypted) | Git authentication. |
| `/home/sandbox/.cache/` (npm, pip cache) | NO | Rebuilds from package-lock.json. 2-20 GB of disposable data. |
| `node_modules/` inside workspace | YES (with caveats) | See 7.3 below. |
| `.git/` inside workspace | YES | Version history. |
| `/tmp/` | NO | Ephemeral by design. |
| LSP server indexes | NO | Rebuilt on start. ~100-500 MB of transient data. |

### 7.3 The node_modules Problem

`node_modules` is the single hardest persistence problem in a cloud IDE. Here is why and what we do:

**The numbers:**
- Average Next.js project: `node_modules` = 300-800 MB
- Monorepo: `node_modules` can exceed 2-5 GB
- Files: 50,000-200,000 small files
- Snapshotting 200,000 small files is slow (metadata-heavy)
- Syncing 200,000 small files to blob storage is slow (per-file overhead)

**Strategy: Persist node_modules on the PVC, but optimize around it.**

1. **On PVC (Azure Disk)**: node_modules lives on the local disk. Disk snapshots capture it as a block-level operation (fast, regardless of file count). This is the primary persistence mechanism.

2. **NOT synced to blob storage individually**: When we archive to cold storage, we tar the entire workspace directory. This is much faster than file-by-file sync for node_modules.

3. **Cache acceleration on restore**: When restoring from snapshot, `node_modules` is present in the snapshot. No `npm install` needed. When restoring from cold archive (tar), `node_modules` might be stale. We run `npm ci` post-restore if `package-lock.json` has changed.

4. **Exclusion from file watcher**: Chokidar ignores `node_modules/**`. The frontend never receives events for node_modules changes. This prevents flooding the WebSocket during `npm install`.

5. **PVC size implication**: The PVC must be sized to accommodate `node_modules`. Free tier (5 GB) will be tight for large projects. This is intentional -- it incentivizes upgrading.

### 7.4 Snapshot Mechanism

**Azure Disk Snapshots (VolumeSnapshot CRD):**

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: sandbox-{sandboxId}-{timestamp}
  namespace: sandboxes
spec:
  volumeSnapshotClassName: azure-disk-snapshot
  source:
    persistentVolumeClaimName: sandbox-{sandboxId}-pvc
```

**Snapshot characteristics on Azure:**
- Creation time: < 5 seconds (incremental snapshot -- only changed blocks)
- First snapshot: captures full disk
- Subsequent snapshots: captures only changed blocks since last snapshot
- Restore time: 10-30 seconds (lazy load -- snapshot is accessible immediately, blocks are loaded on first read)
- Cost: ~$0.05/GB/month for snapshot storage

**Snapshot retention policy:**

| Tier | Snapshots Retained | Snapshot Frequency | Archive After |
|------|-------------------|-------------------|---------------|
| Free | 1 (latest only) | On suspend only | 7 days suspended |
| Pro | 5 (rolling) | On suspend + every 6 hours if active | 30 days suspended |
| Team | 10 (rolling) | On suspend + every 2 hours if active | 90 days suspended |

### 7.5 Cold Archive to Azure Blob

When a sandbox has been SUSPENDED for longer than the tier's archive threshold:

1. Control plane triggers archive job
2. Job creates a new pod that mounts the snapshot as a PVC
3. Job runs: `tar czf - /home/sandbox/workspace/ /home/sandbox/.config/ | azcopy copy - "https://{account}.blob.core.windows.net/archives/{sandboxId}/{timestamp}.tar.gz"`
4. Archive is stored in Azure Blob Hot tier (first 30 days) then moved to Cool/Archive tier via lifecycle policy
5. Original disk snapshot is deleted (cost savings)
6. Metadata (file list, sizes, git branch, last opened files) is stored in the database for quick display in the UI without rehydrating the archive

**Restoration from cold archive:**
1. User requests restore
2. Control plane creates a new PVC, creates a pod
3. Pod downloads tar from blob, extracts to PVC
4. Runs `npm ci` or equivalent if dependencies are stale
5. **Time: 1-5 minutes** depending on project size
6. User sees a progress bar: "Restoring your sandbox... Downloading files... Installing dependencies..."

### 7.6 Large Project Handling

**Projects > 5 GB (monorepos, large assets):**

- PVC size can be increased on-demand (Azure Disk supports online resize)
- Control plane exposes `PATCH /sandboxes/{id}/disk` to resize PVC
- Resize is non-disruptive (Azure Disk online expansion)
- Maximum PVC size: 100 GB (hard limit to prevent abuse)

**Git LFS objects:**
- Stored in the PVC like regular files
- LFS smudge/clean filters work normally inside the sandbox
- Large LFS objects count against disk quota

---

## 8. App Preview (Port Forwarding)

### 8.1 Architecture

```
User's browser                                       Sandbox Pod
     |                                                    |
     |  https://abc123-3000.preview.bricks.dev            |
     |                                                    |
     +---------> Traefik Ingress Controller               |
                 (wildcard *.preview.bricks.dev)          |
                         |                                |
                         | Route: extract sandboxId       |
                         | and port from subdomain        |
                         |                                |
                         +-------> Preview Router --------+
                                  (L7 reverse proxy)      |
                                         |                |
                                         +--- TCP proxy --+-> localhost:3000
                                              to pod's        inside pod
                                              port 3000
```

### 8.2 URL Scheme

Format: `https://{sandboxId}-{port}.preview.bricks.dev`

Examples:
- `https://abc123-3000.preview.bricks.dev` -> pod abc123, port 3000
- `https://abc123-8080.preview.bricks.dev` -> pod abc123, port 8080
- `https://abc123-5173.preview.bricks.dev` -> pod abc123, port 5173 (Vite)

**Why this scheme:**
- Each sandbox+port gets a unique origin (important for cookies, localStorage, CORS)
- Wildcard TLS cert covers all subdomains: `*.preview.bricks.dev`
- DNS: Wildcard CNAME `*.preview.bricks.dev` -> Traefik load balancer IP
- No DNS propagation delay for new sandboxes -- wildcard handles everything

**Subdomain length constraint**: Each DNS label (segment between dots) must be <= 63 characters. With format `{sandboxId}-{port}`, sandboxId must be <= 57 characters (63 - 1 dash - 5 port digits). We use 12-character alphanumeric IDs, so this is fine.

### 8.3 Port Detection

The daemon monitors for listening ports inside the pod:

```javascript
// Daemon polls /proc/net/tcp every 2 seconds
// Parses listening sockets, detects new ports
// Filters: ignore ports < 1024 (system)
// Note: daemon uses Unix socket (/var/run/bricks/daemon.sock), not a TCP port

// When new port detected:
{
  "jsonrpc": "2.0",
  "method": "preview.portDetected",
  "params": {
    "port": 3000,
    "pid": 12345,
    "process": "node",
    "previewUrl": "https://abc123-3000.preview.bricks.dev"
  }
}
```

The frontend shows a toast notification: "Port 3000 detected (node). Open preview?" with a clickable link.

### 8.4 HTTPS Termination

- TLS is terminated at the Traefik ingress controller
- Wildcard certificate for `*.preview.bricks.dev` (Let's Encrypt or Azure-managed)
- Traffic between Traefik and the pod is plain HTTP over the cluster network (encrypted by Kata VM boundary)
- The preview URL is always HTTPS -- user apps that check `window.location.protocol` see `https:`

### 8.5 WebSocket Support

WebSocket connections through the preview URL work transparently:
- Traefik supports WebSocket upgrade
- `Connection: Upgrade` and `Upgrade: websocket` headers are passed through
- This is critical for Next.js hot module reload, Socket.IO apps, etc.

### 8.6 Authentication for Preview URLs

**Default: Public (no auth)**. Preview URLs are accessible to anyone with the link. This matches developer expectations (sharing a preview with a colleague/client). Preview domain is `bricks-preview.dev` (separate registered domain from `bricks.dev`).

**Optional: Authenticated previews** (Pro/Team tier):
- Preview URL requires a Bricks session cookie
- Implemented via Traefik middleware that checks the cookie against the Bricks auth service
- Use case: Private demos, sensitive data in the preview app

**Sharing controls:**
- "Anyone with link" (default)
- "Only me" (requires Bricks auth)
- "Anyone in my team" (requires Bricks auth + team membership check)

### 8.7 Multiple Ports

Users often run multiple servers (frontend on 3000, API on 8080, database admin on 5432). Each gets its own preview URL. The daemon detects all listening ports and presents them in the UI.

**Port limit per tier:**
- Free: 1 preview port (additional ports are accessible from within the sandbox but not externally)
- Pro: 5 preview ports
- Team: 10 preview ports

### 8.8 Hot Module Reload (HMR) Considerations

Many frameworks (Next.js, Vite, Webpack) use WebSocket-based HMR that connects back to the dev server. The HMR WebSocket URL must point to the preview URL, not `localhost`.

**Problem**: The dev server inside the sandbox thinks it is running on `localhost:3000`. It tells the browser to connect HMR WebSocket to `ws://localhost:3000`. This fails because the browser is not on the same machine.

**Solution**: The daemon injects environment variables that frameworks respect:

```bash
# For webpack-dev-server / Next.js
WDS_SOCKET_HOST=abc123-3000.preview.bricks.dev
WDS_SOCKET_PORT=443

# For Vite
VITE_HMR_PROTOCOL=wss
VITE_HMR_HOST=abc123-3000.preview.bricks.dev
VITE_HMR_PORT=443

# Generic
BRICKS_PREVIEW_HOST=abc123-3000.preview.bricks.dev
```

The daemon sets these environment variables for every terminal session. Most modern frameworks auto-detect these. For frameworks that don't, we document the workaround.

---

## 9. Scaling

### 9.1 Scale Progression & Breaking Points

#### 10 Users (Launch)

**Infrastructure:**
- 1 AKS cluster, 1 region
- 1 system node pool (Standard_D4s_v5, 2 nodes)
- 1 sandbox node pool (Standard_D8s_v5 with nested virt, 3 nodes -- each handles ~3-4 Kata pods)
- Warm pool: 5 pods

**What works fine:**
- Everything. This is trivially simple.
- Single Traefik instance handles all preview traffic
- Single PostgreSQL (Azure Database for PostgreSQL Flexible Server, Burstable B2ms) for control plane state

**Total monthly cost estimate**: ~$800-1,200

#### 100 Users

**Infrastructure:**
- 1 AKS cluster, 1 region
- System pool: 2 nodes (D4s_v5)
- Sandbox pool: 8-12 nodes (D8s_v5)
- Warm pool: 15 pods

**What starts to matter:**
- PVC provisioning rate: Azure Disk has a per-subscription rate limit (~100 creates/min). At 100 concurrent users, if they all start sandboxes in a burst (e.g., after a demo), we might hit this. Mitigation: warm pool with pre-provisioned PVCs.
- Snapshot storage costs: 100 users x 20 GB average = 2 TB of snapshot storage = ~$100/month
- Control plane DB: Still fine on a single PostgreSQL instance.

**Total monthly cost estimate**: ~$5,000-8,000

#### 1,000 Users

**Infrastructure:**
- 1 AKS cluster, 1 region (consider multi-region at 2,000+)
- System pool: 3 nodes (D4s_v5)
- Sandbox pool: 50-80 nodes (D8s_v5), autoscaling enabled
- Warm pool: 50 pods
- Redis cluster for session state and pub/sub
- PostgreSQL: General Purpose (D4ds_v4, 4 vCPU)

**Breaking points to address:**

1. **Kubernetes API server load**: 1,000 pods with frequent status updates, watch streams, and health checks. AKS API server starts to feel the load. Mitigation: Reduce health check frequency, batch status updates, use informers instead of polling.

2. **Node pool autoscaling lag**: Adding a node takes 3-5 minutes (VM provisioning + image pull + Kata setup). During a usage spike, users wait. Mitigation: Over-provision by 20% during peak hours; use NAP (Karpenter-based) for faster, right-sized provisioning.

3. **PVC scheduling**: 1,000 PVCs across 80 nodes. Azure Disk PVCs are zonal -- a PVC in Zone 1 can only attach to a node in Zone 1. This creates scheduling constraints. Mitigation: Create sandbox node pools in all 3 availability zones; ensure warm pool is distributed across zones.

4. **Traefik scaling**: Single Traefik instance handles 1,000+ WebSocket connections (long-lived) plus preview HTTP traffic. Need to scale Traefik to 2-3 replicas with session affinity for WebSocket connections.

5. **Snapshot storage**: 1,000 x 20 GB = 20 TB. ~$1,000/month just for snapshots. Implement aggressive snapshot cleanup and encourage archive-to-blob for idle sandboxes.

**Total monthly cost estimate**: ~$30,000-50,000

#### 10,000 Users

**Infrastructure:**
- 2-3 AKS clusters across 2 regions (e.g., East US + West Europe)
- Global load balancer (Azure Front Door) for region routing
- Sandbox pools: 300-500 nodes per region
- Warm pool: 200 pods per region
- PostgreSQL: Business Critical (D8ds_v4) with read replicas
- Redis Cluster (6 nodes) for session state, pub/sub, rate limiting
- Dedicated monitoring cluster

**Breaking points to address:**

1. **Kubernetes scalability wall**: A single AKS cluster is tested to 5,000 nodes / 150,000 pods. At 10,000 concurrent sandboxes, a single cluster is feasible but operating near limits. Multi-cluster is safer.

2. **etcd pressure**: Every pod, PVC, snapshot, network policy, and service is an etcd object. 10,000 sandboxes = ~40,000-60,000 etcd objects. etcd performs well to ~100,000 objects but degrades above that. Mitigation: Aggressive garbage collection, avoid storing large objects in etcd, use external state store for sandbox metadata.

3. **Node pool fragmentation**: With autoscaling, nodes are added/removed frequently. A node with 1 pod remaining cannot be drained (that pod's PVC is zonal). Mitigation: Use pod disruption budgets of 0 (allow drain) for idle sandboxes; use NAP for right-sized node provisioning.

4. **Azure subscription limits**: 
   - Standard_D8s_v5 vCPU quota: default 350 cores per region. Need to request increase to 4,000+.
   - Managed disks per subscription: 50,000 (sufficient)
   - Disk snapshots per subscription: 25,000 (may need increase or multi-subscription strategy)
   - Public IP addresses: 1 per preview ingress (not per sandbox, so this is fine)

5. **DNS resolution volume**: 10,000 sandboxes x frequent npm/pip installs = millions of DNS queries/hour. CoreDNS might become a bottleneck. Mitigation: Run CoreDNS with node-local cache (NodeLocal DNSCache DaemonSet).

6. **Cost**: At 10,000 concurrent users, infrastructure cost alone is ~$200,000-400,000/month. This requires a solid revenue model. At $20/user/month (Pro tier), 10,000 users = $200K MRR -- barely breaking even on infrastructure. Need a mix: most users on Free (with aggressive idle timeout and suspend), paying users on Pro/Team subsidizing infrastructure.

**Total monthly cost estimate**: ~$200,000-400,000

### 9.2 Multi-Cluster Strategy (10,000+ Users)

```
                        Azure Front Door
                     (global load balancer)
                        /            \
                       /              \
              +-------+------+   +-----+--------+
              | AKS Cluster  |   | AKS Cluster  |
              | East US      |   | West Europe  |
              | 5000 pods    |   | 5000 pods    |
              +-------+------+   +-----+--------+
                      |                 |
              +-------+------+   +-----+--------+
              | Azure PG     |   | Azure PG     |
              | (Primary)    |   | (Read Replica)|
              +--------------+   +--------------+
```

**User-to-cluster routing**: Users are assigned to the nearest region. Sandbox metadata includes the cluster assignment. If a user creates a sandbox in East US, all interactions for that sandbox route to East US.

**Cross-region migration**: Not supported in v1. If a user moves continents, they can create a new sandbox in the closer region and clone their repo there. Cold archive (Azure Blob) can be replicated cross-region for restore.

### 9.3 Node Pool Configuration

```yaml
# Sandbox node pool for Kata workloads
apiVersion: containerservice.azure.com/v1
kind: ManagedCluster/AgentPool
metadata:
  name: sandbox
spec:
  vmSize: Standard_D8s_v5   # 8 vCPU, 32 GB RAM
  enableAutoScaling: true
  minCount: 3
  maxCount: 100              # Scale up per demand
  osSKU: AzureLinux          # Required for Kata on AKS
  workloadRuntime: KataVmIsolation
  mode: User
  nodeLabels:
    bricks.io/pool: sandbox
  nodeTaints:
    - key: bricks.io/sandbox
      value: "true"
      effect: NoSchedule     # Only sandbox pods land here
  availabilityZones:
    - "1"
    - "2"
    - "3"
```

**VM sizing rationale for D8s_v5:**
- 8 vCPU, 32 GB RAM per node
- With Kata overhead (~30 MB + ~0.5 vCPU per VM), each node handles:
  - ~3 Pro-tier sandboxes (2 vCPU + 4 GB each) or
  - ~6 Free-tier sandboxes (1 vCPU + 2 GB each)
- Mixed workloads: ~4-5 sandboxes per node on average
- This gives good bin-packing without excessive fragmentation

---

## 10. Pre-pulled Images

### 10.1 Pre-pull Strategy

Images must be present on every sandbox node BEFORE a pod is scheduled there. Pulling a 4-6 GB image takes 30-60 seconds even from ACR in the same region -- unacceptable as a cold start penalty.

**DaemonSet approach:**

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-prepuller
  namespace: bricks-system
spec:
  selector:
    matchLabels:
      app: image-prepuller
  template:
    spec:
      nodeSelector:
        bricks.io/pool: sandbox
      tolerations:
        - key: bricks.io/sandbox
          operator: Exists
      initContainers:
        - name: pull-sandbox-image
          image: acrbricks.azurecr.io/bricks-sandbox:latest
          command: ["sh", "-c", "echo Image pulled successfully"]
          # This initContainer does nothing except force the image to be pulled.
          # Once it completes, the image is cached on the node.
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
```

**How it works:**
- DaemonSet runs on every node in the sandbox pool
- The initContainer references the sandbox image, forcing kubelet to pull it
- Once pulled, the main container (pause) keeps the DaemonSet pod alive with near-zero resources
- When the image tag is updated (new version), the DaemonSet is updated with a rolling strategy
- New nodes added by autoscaling automatically get the DaemonSet pod, triggering image pull

**Image pull optimization:**
- ACR is in the same region as AKS -- pull time is dominated by decompression, not transfer
- ACR artifact streaming (preview): Layers are streamed on-demand instead of pulled in full. Can reduce effective pull time to seconds. Worth evaluating.
- We maintain 2 image tags: `latest` (current) and `previous` (fallback). Warm pool pods use `latest`. If `latest` has issues, we can roll back by pointing the DaemonSet to `previous`.

### 10.2 Image Contents & Size Breakdown

| Layer | Approximate Size (Compressed) | Contents |
|-------|-------------------------------|----------|
| Ubuntu 24.04 base | 30 MB | Minimal OS |
| System packages (build-essential, git, curl, etc.) | 200 MB | Development tools |
| Node.js 22 LTS | 50 MB | Runtime + npm |
| Python 3.12 + pip + poetry + uv | 150 MB | Runtime + package managers |
| Go 1.23 | 150 MB | Runtime |
| Rust (rustup + stable toolchain) | 300 MB | Toolchain |
| Deno + Bun | 80 MB | Alternative JS runtimes |
| LSP servers (tsserver, pyright, gopls, rust-analyzer) | 200 MB | Language intelligence |
| Database clients (psql, mysql, redis-cli, sqlite3) | 50 MB | Database tools |
| Bricks daemon + s6-overlay | 30 MB | Platform infrastructure |
| Miscellaneous (jq, htop, vim, nano, etc.) | 60 MB | Developer utilities |
| **Total compressed** | **~1.3 GB** | |
| **Total uncompressed** | **~4.5 GB** | |

### 10.3 Image Update Process

1. **Weekly automated build** (Monday 02:00 UTC):
   - CI builds the new image, runs smoke tests (can we start the daemon, open a terminal, run node/python/go/rust, install an npm package?)
   - Image is pushed to ACR with tag `{date}-{git-sha}` and `canary`

2. **Canary rollout** (Monday 06:00 UTC):
   - DaemonSet updated to pull `canary` on 2 nodes (via node selector for canary nodes)
   - Warm pool creates 5 pods with the canary image
   - Monitor for 24 hours: daemon crash rate, image pull time, user-reported issues

3. **Full rollout** (Tuesday 06:00 UTC if canary passes):
   - DaemonSet updated to pull new `latest` tag on all nodes
   - Warm pool transitions to new image
   - Existing active pods are NOT affected (they keep their current image until suspend/restore)

4. **Emergency rollback**:
   - DaemonSet reverted to `previous` tag
   - Warm pool pods with bad image are terminated
   - Incident logged and investigated

### 10.4 Language-Specific Optimization

Not all users need all languages. Future optimization:

**Phase 2 (multi-image):**
- `bricks-sandbox-js`: Node.js + Deno + Bun + TS LSP (1.5 GB uncompressed)
- `bricks-sandbox-python`: Python + pyright (2 GB uncompressed)
- `bricks-sandbox-full`: Everything (4.5 GB uncompressed, current default)

The appropriate image is selected based on the project's detected language or user preference. The full image remains the default to avoid surprising users.

---

## 11. Git Integration

### 11.1 Authentication Flow

```
User's browser                    Bricks API                 GitHub
     |                               |                         |
     | 1. "Connect GitHub"           |                         |
     +------------------------------>|                         |
     |                               | 2. OAuth redirect       |
     |<------------------------------+------------------------>|
     | 3. User authorizes                                      |
     |                               |<------------------------+
     |                               | 4. Receive OAuth token  |
     |                               |                         |
     | 5. Store token (encrypted)    |                         |
     |   in Bricks DB                |                         |
     |                               |                         |
     | 6. Create sandbox             |                         |
     +------------------------------>|                         |
     |                               | 7. Inject token into    |
     |                               |    pod as secret env    |
     |                               |                         |
     |            Pod                |                         |
     |   git credential helper       |                         |
     |   reads BRICKS_GIT_TOKEN     |                         |
     |   and returns it for          |                         |
     |   github.com requests         |                         |
```

### 11.2 Credential Management Inside the Pod

**Git credential helper** (installed in base image):

```bash
#!/bin/bash
# /opt/bricks/scripts/git-credential-bricks
# Custom git credential helper

case "$1" in
  get)
    # Read the request (protocol, host)
    while IFS='=' read -r key value; do
      case "$key" in
        protocol) protocol="$value" ;;
        host) host="$value" ;;
      esac
    done

    # Return credentials based on host
    if [ "$host" = "github.com" ] && [ -n "$BRICKS_GITHUB_TOKEN" ]; then
      echo "protocol=https"
      echo "host=github.com"
      echo "username=x-access-token"
      echo "password=$BRICKS_GITHUB_TOKEN"
    elif [ "$host" = "gitlab.com" ] && [ -n "$BRICKS_GITLAB_TOKEN" ]; then
      echo "protocol=https"
      echo "host=gitlab.com"
      echo "username=oauth2"
      echo "password=$BRICKS_GITLAB_TOKEN"
    fi
    ;;
  store|erase)
    # No-op: we don't persist credentials from inside the sandbox
    ;;
esac
```

**Git config** (set by daemon on initialization):

```ini
[credential]
    helper = /opt/bricks/scripts/git-credential-bricks

[user]
    name = {user's name from Bricks profile}
    email = {user's email from Bricks profile}

[safe]
    directory = /home/sandbox/workspace
```

### 11.3 Token Security

- OAuth tokens are stored **encrypted at rest** in the Bricks database (AES-256-GCM, key in Azure Key Vault)
- Tokens are injected into the pod as Kubernetes secrets (mounted as environment variables, not files)
- Secrets are mounted with `readOnly: true` in the pod spec
- The daemon runs as `bricks` (UID 1000) and can read the env var. User processes (UID 1001) inherit the env var through the terminal session. This is intentional -- the user needs git access.
- Token scope is minimized: `repo` scope for GitHub (read/write to repos the user has access to). No `admin`, no `delete_repo`, no `org` access beyond what the user explicitly grants.
- **Token refresh**: GitHub OAuth tokens don't expire but can be revoked. We check token validity on sandbox creation and prompt re-auth if invalid.

**Risk: User prints the token.** A user can run `echo $BRICKS_GITHUB_TOKEN` in the terminal and see their token. This is unavoidable -- the process needs the token to authenticate with GitHub. The same is true of GitHub Codespaces. We mitigate by:
- Using short-lived GitHub App installation tokens (1 hour expiry) instead of long-lived OAuth tokens where possible
- Logging token access (daemon logs when the credential helper is invoked)
- Documenting that the token is scoped and can be revoked

### 11.4 SSH Key Support

Some users prefer SSH-based git authentication. We support this:

1. User generates SSH key in the sandbox: `ssh-keygen -t ed25519`
2. Key is stored in `/home/sandbox/.ssh/` (persisted on PVC)
3. User adds public key to their GitHub/GitLab account manually
4. Git operations use SSH transport normally

**Alternative (better UX):** User uploads their existing SSH key through the Bricks UI. The key is encrypted and stored in the Bricks database. On sandbox creation, it is injected into `/home/sandbox/.ssh/id_ed25519` with `chmod 600`.

### 11.5 Clone Performance

**Problem**: Cloning a large repo (e.g., 1 GB+, deep history) over HTTPS from inside the sandbox can take minutes.

**Optimizations:**

1. **Shallow clone by default**: When the user creates a sandbox from a repo URL, we clone with `--depth=1` by default. Full history can be fetched later with `git fetch --unshallow`.

2. **Git partial clone**: Use `--filter=blob:none` for very large repos. Git fetches file contents on demand instead of upfront.

3. **ACR-based repo cache** (future optimization): For popular repos (e.g., Next.js starter templates), maintain a git mirror inside our Azure network. Clone from the mirror (10x faster) instead of from github.com.

4. **Pre-cloned templates**: For "Create from template" scenarios, the warm pool pod can have the template repo pre-cloned. User sees the workspace immediately.

### 11.6 Git Configuration Persistence

The `.gitconfig` file and git-related dotfiles are stored in `/home/sandbox/.config/git/` (persisted on PVC). This means:
- User's git aliases survive sandbox restarts
- Git hooks, commit templates, etc. are preserved
- The credential helper config is re-injected on every sandbox start (not persisted -- token may have changed)

---

## 12. Failure Modes & Recovery

### 12.1 Failure Taxonomy

| Failure | Blast Radius | Detection | Recovery | MTTR |
|---------|-------------|-----------|----------|------|
| **Daemon crash** | 1 user | s6 restart + liveness probe | Auto-restart (s6) or pod restart (kubelet) | 1-30 seconds |
| **Pod OOM kill** | 1 user | Kubernetes event, pod restart | Pod restart, user reconnects | 30-60 seconds |
| **Node failure** | 3-6 users (all pods on that node) | Kubernetes node NotReady | Pods rescheduled to other nodes. PVC reattaches. | 2-5 minutes |
| **AKS control plane outage** | ALL users (no new pods, no scaling) | Azure status page, API server health check | Wait for Azure. Existing pods keep running. | 5-30 minutes |
| **ACR outage** | New sandbox creation fails | Image pull failures | Fall back to cached images on nodes. Pre-pulled images still work. | Until ACR recovers |
| **Azure Disk service degradation** | Snapshot/restore operations | Azure Monitor alerts | Snapshots queued, retried. Existing pods unaffected. | Until service recovers |
| **Network partition (pod <-> gateway)** | Affected users lose connection | WebSocket heartbeat failure | Auto-reconnect when network recovers. Pod stays alive. | Duration of partition |
| **Bricks control plane crash** | No new sandboxes, no lifecycle ops | Health checks, Kubernetes restarts | Control plane pods restart automatically. Stateless -- recovers from DB. | 30-60 seconds |

### 12.2 Data Loss Scenarios

| Scenario | Data at Risk | Mitigation |
|----------|-------------|------------|
| Pod killed during file write | Partially written file | Daemon uses write-then-rename (atomic write) for file save operations. Worst case: last save is lost, previous version intact. |
| Node failure with no recent snapshot | Changes since last snapshot | Periodic auto-snapshot for Pro/Team (every 2-6 hours). Free tier: up to 2 hours of work lost in worst case. |
| Azure Disk failure (rare) | All data on that PVC | Azure Disk has 3x replication within the availability zone. Complete loss would require zone failure. Cross-zone snapshots are the backup. |
| Snapshot corruption | Backup for restore | Retain multiple snapshots (Pro/Team). Free tier has single snapshot -- if corrupted, falls back to blob archive. |
| Blob archive deletion (bug or attack) | Long-term backups | Soft delete enabled on blob storage (30-day recovery). Azure RBAC restricts delete permissions. |

### 12.3 Graceful Degradation Strategy

When subsystems fail, the sandbox should degrade gracefully rather than crash entirely:

| Subsystem Failure | User Experience |
|-------------------|-----------------|
| LSP server crashes | IntelliSense stops. Editor still works. Terminal still works. "Language server unavailable" message. |
| File watcher crashes | File tree doesn't auto-update. Manual refresh works. Terminal unaffected. |
| Preview router unreachable | Dev server runs but preview URL doesn't load. "Preview temporarily unavailable" message. |
| Snapshot service unavailable | Pod stays alive longer (skips suspend). User is unaffected during active use. |
| Control plane unreachable | Existing sandboxes work normally. New sandboxes can't be created. Lifecycle operations (suspend/restore) queued. |

---

## 13. Observability

### 13.1 Metrics (Prometheus)

**Daemon-level metrics** (exposed on `GET /metrics`):

```
# Gauge: current resource usage
bricks_sandbox_cpu_usage_percent{sandbox_id="abc123"} 45.2
bricks_sandbox_memory_usage_bytes{sandbox_id="abc123"} 1073741824
bricks_sandbox_disk_usage_bytes{sandbox_id="abc123"} 2147483648

# Counter: terminal sessions
bricks_terminal_sessions_total{sandbox_id="abc123"} 12
bricks_terminal_sessions_active{sandbox_id="abc123"} 2

# Counter: file operations
bricks_file_operations_total{sandbox_id="abc123", op="read"} 1523
bricks_file_operations_total{sandbox_id="abc123", op="write"} 89

# Histogram: WebSocket message latency
bricks_ws_message_duration_seconds_bucket{le="0.01"} 9823
bricks_ws_message_duration_seconds_bucket{le="0.05"} 10102

# Gauge: LSP server status
bricks_lsp_server_active{sandbox_id="abc123", language="typescript"} 1
bricks_lsp_server_memory_bytes{sandbox_id="abc123", language="typescript"} 268435456
```

**Control plane metrics:**

```
# Histogram: sandbox creation latency
bricks_sandbox_creation_duration_seconds_bucket{path="warm", le="5"} 892
bricks_sandbox_creation_duration_seconds_bucket{path="cold", le="30"} 45

# Gauge: warm pool status
bricks_warmpool_size{tier="default"} 18
bricks_warmpool_target{tier="default"} 20

# Counter: lifecycle transitions
bricks_sandbox_transitions_total{from="active", to="idle"} 5023
bricks_sandbox_transitions_total{from="idle", to="suspended"} 4100

# Gauge: concurrent active sandboxes
bricks_sandboxes_active_total 342

# Counter: abuse detection
bricks_abuse_detected_total{type="crypto_mining"} 3
bricks_abuse_detected_total{type="cpu_abuse"} 12
```

### 13.2 Logging

**Structured JSON logs** from all components, shipped to Azure Monitor / Log Analytics.

```json
{
  "timestamp": "2026-04-08T10:23:45.123Z",
  "level": "info",
  "component": "daemon",
  "sandbox_id": "abc123",
  "user_id": "usr_xyz",
  "event": "terminal.create",
  "terminal_id": "t_456",
  "shell": "/bin/bash",
  "duration_ms": 12
}
```

**Log retention:**
- Hot (searchable): 7 days
- Warm (archived, query on demand): 30 days
- Cold (compliance/audit): 90 days

### 13.3 Distributed Tracing (OpenTelemetry)

Every user action is traced end-to-end:

```
User clicks "Run" in terminal
  -> Frontend span: terminal.input
    -> WebSocket span: ws.send
      -> Daemon span: terminal.write
        -> node-pty span: pty.write
          -> Process execution (not traced, opaque)
        -> node-pty span: pty.read (output)
      -> WebSocket span: ws.send (output back to client)
    -> Frontend span: terminal.render
```

This allows us to diagnose latency issues: Is the delay in the WebSocket? In the daemon? In the pty? In rendering?

### 13.4 Alerting

| Alert | Condition | Severity | Response |
|-------|-----------|----------|----------|
| Warm pool depleted | `bricks_warmpool_size < 3` for 5 min | P1 | Page on-call. Users experiencing slow sandbox creation. |
| Daemon crash rate spike | `> 5% of active sandboxes have daemon crashes in 10 min` | P1 | Possible bad image rollout. Investigate immediately. |
| Sandbox creation failures | `> 10% failure rate for 5 min` | P1 | Infrastructure issue (node pool, PVC, ACR). |
| Node pool at capacity | `node count = maxCount` for 10 min | P2 | Increase maxCount or add new node pool. |
| Average creation latency > 30s | `p95 creation latency > 30s` for 15 min | P2 | Warm pool undersized or PVC provisioning slow. |
| Abuse detection spike | `> 10 abuse events in 1 hour` | P2 | Possible attack wave. Review detection accuracy + block patterns. |
| Snapshot failures | `> 5% snapshot failure rate` for 30 min | P3 | Azure Disk service issue. Monitor and retry. |

---

## 14. Cost Model

### 14.1 Per-Sandbox Cost Breakdown (Pro Tier Example)

| Resource | Spec | Unit Cost | Usage Pattern | Monthly Cost |
|----------|------|-----------|---------------|--------------|
| **Compute** (Kata pod) | 2 vCPU, 4 GB RAM | ~$0.10/hour (share of D8s_v5) | 6 hours/day active | $18.00 |
| **Disk** (Azure Managed Disk P10) | 128 GB provisioned (Pro/Team); P2 8 GB for Free tier | $19.20/month (Pro/Team), $1.54/month (Free) | Always provisioned while active | $19.20 |
| **Snapshot** (Azure Disk) | ~20 GB incremental | $1.00/month | Latest snapshot | $1.00 |
| **Blob archive** | ~2 GB compressed | $0.004/month | Cold storage | ~$0.00 |
| **Network egress** | ~10 GB/month | $0.087/GB | npm install, git clone | $0.87 |
| **Total per Pro user** | | | | **~$39/month** |

**At $20/month Pro tier pricing, we lose ~$19/user.** This means:
- We need a significant portion of users on the Free tier (which costs less due to smaller disk, shorter sessions)
- Free tier cost: ~$8-12/month per user. We lose less but still need monetization.
- Team tier at $50/month with 4 vCPU/8 GB still costs ~$60/month -- tight margin.

**Key cost levers:**
1. **Idle timeout aggressiveness**: Suspending Free tier after 10 min of idle saves ~40% compute cost
2. **Warm pool sizing**: Over-provisioning warm pool is expensive. Right-size it.
3. **Disk type**: Free tier uses P2 (8 GB) disks to minimize cost. Pro/Team use P10 (128 GB). Consider Azure Disk Burstable or Ultra SSD with pay-per-GB actual usage for further optimization.
4. **Spot instances**: Free tier uses Spot VMs (60-90% cheaper). The risk is eviction (30-second notice). Mitigation: snapshot before eviction, restore on a new spot or on-demand node. Pro/Team tiers use regular (on-demand) VMs for reliability.

### 14.2 Cost at Scale

| Users | Monthly Infra Cost | Revenue Needed | Break-even Pro Users |
|-------|-------------------|----------------|---------------------|
| 100 | $5,000-8,000 | $8,000 | 400 (4:1 Pro-to-Free impossible) |
| 1,000 | $30,000-50,000 | $50,000 | 2,500 Pro users (aggressive) |
| 10,000 | $200,000-400,000 | $400,000 | 20,000 Pro ($20) or 8,000 Team ($50) |

**Reality check**: The unit economics are challenging. Every successful cloud IDE (Replit, Codespaces, Gitpod) has wrestled with this. The path to profitability requires:
1. Aggressive idle management (don't pay for compute when users aren't using it)
2. High-margin add-ons (AI features billed per-use, managed databases, deployment hosting)
3. Team/Enterprise tiers with higher margins
4. Eventually, custom hardware or reserved instances for better compute pricing

---

## 15. Open Questions & Risks

### 15.1 Technical Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **Kata on AKS instability at scale** | High | Medium | We're betting on Microsoft's Kata support. If it degrades, fallback to gVisor (with compatibility trade-offs) or dedicated VMs. |
| **Azure Disk PVC provisioning latency spikes** | High | Medium | Warm pool pre-provisions PVCs. Cold start path is the fallback, not the norm. |
| **node_modules blowing disk quotas** | Medium | High | Clear disk usage UI, proactive warnings, documentation on optimizing project size. Consider pnpm (uses hard links, saves disk). |
| **LSP memory consumption** | Medium | High | Per-LSP memory caps, proactive killing. TypeScript projects with large `tsconfig` can cause tsserver to use 2+ GB. Hard kill at limit. |
| **WebSocket connection stability** | Medium | Medium | Reconnection logic, buffering, heartbeats. Mobile users on spotty connections will have a degraded experience. |
| **Image size growth** | Low | High | As we add more languages/tools, the image grows. Need a pruning strategy and the multi-image approach (Phase 2). |
| **Billing complexity** | Medium | High | Usage-based pricing (per-hour compute + per-GB storage) is accurate but complex. Subscription tiers are simpler for users but harder to make profitable. |

### 15.2 Architecture Decisions Still Open

1. **Kubernetes Agent Sandbox CRD vs. Custom Controller**: The new `kubernetes-sigs/agent-sandbox` CRD aligns closely with our needs (stateful singleton pods, warm pools, lifecycle management). Should we adopt it or build a custom controller? Tradeoff: Agent Sandbox is new (2025) and may not be stable enough for production, but it saves us from reinventing warm pools, snapshot integration, and lifecycle management.

2. **Azure Disk vs. Azure Files for PVCs**: Azure Disk is faster (direct attach) but zonal (scheduling constraints). Azure Files (NFS) is multi-attach capable and not zonal, but has higher latency and lower IOPS. For a single-pod workload, Azure Disk is correct -- but it makes scheduling harder at scale.

3. **Egress proxy: Build vs. Buy**: Squid/Envoy egress proxy with custom rules, or a managed solution like Azure Firewall or Zscaler? Custom is more flexible and cheaper, but more operational burden.

4. **Preview URL domain**: `*.preview.bricks.dev` requires a dedicated domain with wildcard TLS. Alternatively, use a path-based scheme (`bricks.dev/preview/{sandboxId}/{port}/`) which avoids the wildcard cert but breaks origin isolation.

5. **Spot VMs for Free tier** (decided): Free tier uses Azure Spot VMs (60-90% compute savings). Eviction risk is acceptable -- Free tier users already have short session limits and aggressive idle timeouts. Eviction triggers snapshot + restore on a new Spot or on-demand node. Pro/Team tiers use regular (on-demand) VMs.

### 15.3 Phased Delivery Plan

**Phase 1 (MVP, Month 1-2):**
- Single AKS cluster, single region
- Standard containers (no Kata yet) with restrictive seccomp + network policies
- Single base image (full stack)
- PVC with Azure Disk, manual snapshot
- Basic daemon: terminals, file ops, no LSP
- No warm pool (accept 30-60s cold start)
- Preview URLs with Traefik
- GitHub OAuth for git

**Phase 2 (Security + Performance, Month 3-4):**
- Kata VM isolation enabled
- Warm pool (10 pods)
- Automated snapshot/suspend/restore lifecycle
- LSP support (TypeScript, Python)
- Idle detection and auto-suspend
- Resource limits enforced per tier
- Abuse detection (basic)

**Phase 3 (Scale, Month 5-6):**
- NAP (Karpenter-based) autoscaling
- Multi-zone node pools
- Warm pool auto-sizing
- Cold archive to Azure Blob
- Multi-image support (JS-only, Python-only, Full)
- eBPF-based runtime security
- Cost optimization (spot VMs for Free tier)

**Phase 4 (Multi-Region, Month 7+):**
- Second AKS cluster in West Europe
- Azure Front Door for global routing
- Cross-region snapshot replication
- Kubernetes Agent Sandbox CRD evaluation
- Docker-in-Docker support (Team tier, dedicated nodes)

---

## Appendix A: Pod Manifest (Complete)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sandbox-{sandboxId}
  namespace: sandboxes
  labels:
    bricks.io/role: sandbox
    bricks.io/sandbox-id: "{sandboxId}"
    bricks.io/user-id: "{userId}"
    bricks.io/tier: "pro"
  annotations:
    bricks.io/created-at: "2026-04-08T10:00:00Z"
spec:
  runtimeClassName: kata-vm-isolation
  
  serviceAccountName: sandbox-sa  # Minimal SA, no Kubernetes API access
  automountServiceAccountToken: false  # Don't mount SA token
  
  securityContext:
    runAsUser: 1000  # bricks user
    runAsGroup: 1000
    fsGroup: 1001    # sandbox group for PVC ownership
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/bricks-sandbox.json
  
  nodeSelector:
    bricks.io/pool: sandbox
  
  tolerations:
    - key: bricks.io/sandbox
      operator: Equal
      value: "true"
      effect: NoSchedule
  
  containers:
    - name: sandbox
      image: acrbricks.azurecr.io/bricks-sandbox:2026-04-08-abc1234
      
      ports:
        - containerPort: 3000
          name: preview-1
          protocol: TCP
        - containerPort: 8080
          name: preview-2
          protocol: TCP
        # Daemon uses Unix socket /var/run/bricks/daemon.sock (no TCP port)
      
      env:
        - name: BRICKS_SANDBOX_ID
          value: "{sandboxId}"
        - name: BRICKS_USER_ID
          value: "{userId}"
        - name: BRICKS_TIER
          value: "pro"
        - name: BRICKS_GITHUB_TOKEN
          valueFrom:
            secretKeyRef:
              name: sandbox-{sandboxId}-secrets
              key: github-token
        - name: NODE_OPTIONS
          value: "--max-old-space-size=128"
      
      resources:
        requests:
          cpu: "1000m"
          memory: "2Gi"
          ephemeral-storage: "10Gi"
        limits:
          cpu: "2000m"
          memory: "4Gi"
          ephemeral-storage: "10Gi"
      
      volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: tmp
          mountPath: /tmp
        - name: bricks-logs
          mountPath: /var/log/bricks/
        - name: bricks-run
          mountPath: /var/run/bricks/
        - name: home-bricks
          mountPath: /home/bricks/
        - name: home-sandbox
          mountPath: /home/sandbox/
      
      livenessProbe:
        exec:
          command:
            - /opt/bricks/scripts/healthz.sh  # Checks daemon via Unix socket /var/run/bricks/daemon.sock
        initialDelaySeconds: 5
        periodSeconds: 10
        failureThreshold: 3
      
      readinessProbe:
        exec:
          command:
            - /opt/bricks/scripts/readyz.sh  # Checks daemon readiness via Unix socket /var/run/bricks/daemon.sock
        initialDelaySeconds: 3
        periodSeconds: 5
        failureThreshold: 2
  
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: sandbox-{sandboxId}-pvc
    - name: tmp
      emptyDir:
        sizeLimit: 1Gi
    - name: bricks-logs
      emptyDir:
        sizeLimit: 50Mi
    - name: bricks-run
      emptyDir: {}
    - name: home-bricks
      emptyDir: {}
    - name: home-sandbox
      emptyDir: {}
  
  terminationGracePeriodSeconds: 30
  
  dnsPolicy: None
  dnsConfig:
    nameservers:
      - 8.8.8.8
      - 8.8.4.4
    options:
      - name: ndots
        value: "1"  # External domains only, no cluster DNS search path
    searches: []  # No cluster search domains -- sandboxes CANNOT resolve internal cluster DNS
```

## Appendix B: Network Policy (Complete)

See Section 6.4 for the full NetworkPolicy manifest.

## Appendix C: Key Azure Resource Dependencies

| Azure Resource | SKU / Tier | Purpose | Critical? |
|---------------|-----------|---------|-----------|
| AKS Cluster | Standard | Container orchestration | Yes |
| ACR | Premium (geo-replication) | Image registry | Yes |
| Azure Managed Disks | Premium SSD P10-P30 | Sandbox PVCs | Yes |
| Azure Blob Storage | Hot + Cool + Archive | Snapshot archives | Yes (for restore) |
| Azure Key Vault | Standard | Token encryption keys | Yes |
| Azure Database for PostgreSQL | Flexible Server, GP D4ds | Control plane state | Yes |
| Azure Cache for Redis | Standard C2 | Session state, pub/sub | Yes (at scale) |
| Azure Monitor + Log Analytics | Standard | Observability | Yes |
| Azure Front Door | Standard | Global load balancing | No (single region only in Phase 1) |

---

*End of document. This is a living design -- it will be updated as we learn from production operation.*
