# Bricks -- WebSocket & Real-Time Communication Architecture

> Version: 1.0 | Date: 2026-04-08 | Status: Design Document

---

## Table of Contents

1. [Connection Architecture](#1-connection-architecture)
2. [Message Protocol Design](#2-message-protocol-design)
3. [Connection Routing in AKS](#3-connection-routing-in-aks)
4. [Reconnection & Resilience](#4-reconnection--resilience)
5. [Terminal Streaming](#5-terminal-streaming)
6. [File Sync Protocol](#6-file-sync-protocol)
7. [LSP Integration](#7-lsp-integration)
8. [AI Response Streaming](#8-ai-response-streaming)
9. [Scaling Considerations](#9-scaling-considerations)
10. [Security](#10-security)
11. [Heartbeats & Timeouts](#11-heartbeats--timeouts)

---

## 1. Connection Architecture

### Decision: Two WebSocket Connections Per User Session

A single multiplexed connection creates a fatal coupling between unrelated failure domains. The sandbox pod and the core API server are different processes on different machines with independent lifecycles. When the sandbox pod crashes, the user should still see AI responses and project management UI. When the core API redeploys, the terminal should keep working. This requires two connections.

```
                         +-------------------+
                         |   Next.js Client  |
                         +--------+----------+
                                  |
                    +-------------+-------------+
                    |                           |
            Connection #1                Connection #2
            (Sandbox Pod)              (Core API Server)
            Raw WebSocket              Raw WebSocket
                    |                           |
          +---------+---------+      +----------+----------+
          |   Sandbox Agent   |      |    Core API (NestJS) |
          |   (in-pod Node)   |      |    WebSocket Gateway  |
          |                   |      |                       |
          | - Terminal (PTY)  |      | - AI agent streaming  |
          | - File watcher    |      | - Project management  |
          | - LSP bridge      |      | - Presence/collab     |
          | - File operations |      | - Session lifecycle   |
          +-------------------+      +-----------------------+
```

#### Why NOT Three or More Connections

Some designs separate terminal, file sync, and LSP into individual connections. This is unnecessary overhead. These three subsystems all live in the same sandbox pod, share the same failure domain, and benefit from a single authenticated channel. Application-level multiplexing (channels within one connection) handles the routing with less OS resource consumption and simpler reconnection logic.

#### Why NOT One Connection

Routing a single connection to two independent backends (sandbox pod + API server) requires a proxy layer that understands the message protocol, adds latency, becomes a single point of failure, and makes independent scaling impossible. The blast radius of any failure doubles.

#### Why Raw WebSocket Over Socket.IO

Socket.IO adds ~15KB of client-side overhead, introduces its own reconnection and heartbeat semantics that conflict with our custom protocol, and its "room" and "namespace" abstractions are irrelevant for a 1:1 user-to-sandbox mapping. The auto-upgrade fallback to HTTP long-polling is unnecessary in 2026 (WebSocket support is universal). Raw `ws` on the server and the native `WebSocket` API on the client give us full control over the protocol, binary frames, and reconnection behavior.

#### Protocol: JSON-RPC 2.0 Envelope with Binary Escape Hatch

JSON-RPC 2.0 provides a standardized request/response/notification pattern with correlation IDs, error codes, and method routing. This is the same protocol LSP uses natively, so LSP messages tunnel through without transformation. Terminal I/O and large file transfers use binary WebSocket frames with a 4-byte channel header to bypass JSON overhead.

### Connection Summary

| Connection | Destination | Transport | Multiplexed Channels |
|---|---|---|---|
| **Sandbox** | User's sandbox pod (direct pod IP) | Raw WebSocket (WSS) | Terminal, File Sync, LSP, File Ops |
| **Core API** | NestJS API cluster (load-balanced) | Raw WebSocket (WSS) | AI Streaming, Project Mgmt, Presence, Session Control |

---

## 2. Message Protocol Design

### Framing: Dual-Mode (Text + Binary)

Every WebSocket frame is either a **text frame** (JSON-RPC 2.0) or a **binary frame** (channel-prefixed raw bytes). The client and server distinguish them using the WebSocket opcode, which is part of the protocol itself -- no additional overhead.

### Text Frames: JSON-RPC 2.0

All structured communication uses JSON-RPC 2.0:

```typescript
// Request (client -> server)
{
  "jsonrpc": "2.0",
  "id": "req_a7f3b2c1",           // Correlation ID (nanoid, 12 chars)
  "method": "file/save",
  "params": {
    "path": "/src/index.ts",
    "content": "console.log('hello');\n"
  }
}

// Response (server -> client)
{
  "jsonrpc": "2.0",
  "id": "req_a7f3b2c1",
  "result": {
    "saved": true,
    "mtime": 1712567890123
  }
}

// Notification (no response expected, no id)
{
  "jsonrpc": "2.0",
  "method": "file/changed",
  "params": {
    "path": "/src/index.ts",
    "changeType": "modify",
    "mtime": 1712567891456
  }
}

// Error
{
  "jsonrpc": "2.0",
  "id": "req_a7f3b2c1",
  "error": {
    "code": -32001,
    "message": "File not found",
    "data": { "path": "/src/missing.ts" }
  }
}
```

### Method Namespace Convention

Methods are namespaced by subsystem to enable routing within the multiplexed connection:

| Namespace | Methods | Direction |
|---|---|---|
| `terminal/*` | `terminal/create`, `terminal/resize`, `terminal/kill`, `terminal/list` | Bidirectional |
| `file/*` | `file/read`, `file/save`, `file/delete`, `file/rename`, `file/mkdir`, `file/readDir`, `file/stat`, `file/search` | Bidirectional |
| `file/watch/*` | `file/watch/subscribe`, `file/watch/unsubscribe` | Client -> Server |
| `file/changed` | `file/changed`, `file/created`, `file/deleted`, `file/renamed` | Server -> Client (notifications) |
| `lsp/*` | `lsp/request`, `lsp/notify`, `lsp/startServer`, `lsp/stopServer` | Bidirectional |
| `ai/*` | `ai/submit`, `ai/cancel`, `ai/feedback` | Client -> Server |
| `ai/stream/*` | `ai/stream/token`, `ai/stream/tool`, `ai/stream/status`, `ai/stream/done` | Server -> Client (notifications) |
| `session/*` | `session/heartbeat`, `session/sync`, `session/reconnect` | Bidirectional |
| `presence/*` | `presence/update`, `presence/list` | Bidirectional |

### Binary Frames: Channel-Prefixed Raw Bytes

Terminal I/O and large file transfers use binary frames to avoid JSON encoding overhead. The binary frame format:

```
+----------+----------+---------------------------+
| Channel  | Terminal | Payload                   |
| (1 byte) | ID       | (raw bytes)               |
|          | (2 bytes)|                           |
+----------+----------+---------------------------+
```

**Channel byte values:**

| Channel | Value | Description |
|---|---|---|
| `TERMINAL_STDIN` | `0x01` | Keystrokes from xterm.js to PTY |
| `TERMINAL_STDOUT` | `0x02` | PTY output to xterm.js |
| `FILE_CHUNK` | `0x03` | Binary file content (chunked transfer) |
| `RESERVED` | `0x04-0xFF` | Future use |

**Terminal ID** (2 bytes, big-endian uint16): Supports up to 65,535 terminal instances per session. In practice, maximum per tier: Free 4, Pro 8, Team 16.

**Example**: User types "ls\n" in terminal #1:
```
Binary frame: [0x01] [0x00, 0x01] [0x6C, 0x73, 0x0A]
              stdin   term-id=1    "ls\n"
```

### Large Message Handling

JSON-RPC messages have a **1 MB soft limit**. For file contents exceeding this:

1. **Chunked transfer** via binary frames with `FILE_CHUNK` channel
2. Each chunk includes a transfer header:

```
FILE_CHUNK binary frame:
+----------+-------------------+----------+-----------+----------+
| 0x03     | Transfer ID       | Seq Num  | Total     | Payload  |
| (1 byte) | (8 bytes, nanoid) | (4 bytes)| (4 bytes) | (N bytes)|
+----------+-------------------+----------+-----------+----------+
```

3. Chunk size: **64 KB** per frame (balances latency vs overhead)
4. **Initiation** via JSON-RPC: `file/readLarge` returns a `transferId`, then binary chunks follow
5. **Completion** confirmed via JSON-RPC notification: `file/transferComplete`

Files over **50 MB** are rejected outright with error code `-32010` (file too large for editor). These are served via a separate HTTP endpoint for download if needed.

### Correlation ID Format

All request IDs use `nanoid(12)` -- 12-character URL-safe random strings. This avoids integer overflow, collision across sessions, and leaks sequential information. Example: `req_V1StGXR8_Z`.

The client maintains a pending request map with a **30-second timeout** per request. If no response arrives, the request is rejected client-side with a timeout error.

---

## 3. Connection Routing in AKS

### The Problem

User Alice's sandbox is running in pod `sandbox-alice-7f8d2` on node `aks-pool-00003`. When Alice opens her browser, the WebSocket connection from her browser must reach that exact pod -- not any other pod in the cluster. This is fundamentally different from stateless HTTP where any pod can handle any request.

### Architecture: Direct Pod IP Routing via Session Registry

```
+-------------+       +-----------------+       +--------------------+
|   Browser   | WSS   | NGINX Ingress   | TCP   | Pod: sandbox-alice |
|   (Alice)   +-------> (L7 routing)    +-------> 10.244.3.47:8080   |
+-------------+       +-----------------+       +--------------------+
                              |
                              | Reads routing target from
                              v
                       +------+------+
                       |   Redis     |
                       | Session     |
                       | Registry    |
                       +-------------+
```

### Session Registry (Redis)

When a sandbox pod starts, it registers itself:

```
Key:    session:{sessionId}
Value:  {
          "podName": "sandbox-alice-7f8d2",
          "podIP": "10.244.3.47",
          "port": 8080,
          "nodeIP": "10.0.1.15",
          "status": "ready",           // pending | ready | draining | terminated
          "createdAt": 1712567890,
          "lastHeartbeat": 1712567950,
          "userId": "user_abc123",
          "projectId": "proj_xyz789"
        }
TTL:    300 seconds (refreshed every 60 seconds by pod heartbeat)
```

### Routing Flow: Initial Connection

1. **Client** requests WebSocket upgrade to `wss://ws.bricks.dev/sandbox/{sessionId}`
2. **NGINX Ingress** receives the upgrade request
3. **Custom auth middleware** (Lua or external auth service) extracts `sessionId` from the URL path, looks up the session in Redis, validates the JWT from the `Authorization` query param, and returns the pod IP as an upstream
4. **NGINX** proxies the WebSocket upgrade to the pod's direct IP
5. **Pod** accepts the connection, verifies the session token, begins protocol

### NGINX Ingress Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sandbox-websocket
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "86400"      # 24 hours
    nginx.ingress.kubernetes.io/proxy-send-timeout: "86400"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
    nginx.ingress.kubernetes.io/upstream-hash-by: "$arg_session"  # Route by session
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - ws.bricks.dev
      secretName: bricks-tls
  rules:
    - host: ws.bricks.dev
      http:
        paths:
          - path: /sandbox/
            pathType: Prefix
            backend:
              service:
                name: sandbox-router   # Custom service, not a pod service
                port:
                  number: 80
```

### Sandbox Router Service (Go)

Because NGINX Ingress cannot natively look up a Redis key and route to an arbitrary pod IP, we deploy a lightweight **Go-based reverse proxy** (`sandbox-router`) that:

1. Accepts the WebSocket upgrade from NGINX
2. Extracts the `sessionId` from the URL
3. Looks up the pod IP in Redis
4. Opens a WebSocket connection to the target pod
5. Bidirectionally pipes frames between client and pod
6. Reports connection status back to Redis

This is a thin L4/L7 proxy -- it does NOT inspect or modify message content. It adds approximately **1-5ms of latency** per message, p99 up to 10-20ms under load (measured: TCP proxy overhead on same-region communication in AKS).

```
Browser -> NGINX Ingress -> sandbox-router (Go) -> Pod (direct IP)
                                    |
                                    +-- Redis lookup per connection (not per message)
```

**Why not eliminate NGINX and have the Go router handle TLS directly?** NGINX handles TLS termination, certificate rotation, rate limiting, and DDoS mitigation at the edge. The Go router handles only session-aware routing. Separation of concerns.

### Reconnection Routing

When the user refreshes the page or their connection drops:

1. Client reconnects to the same `wss://ws.bricks.dev/sandbox/{sessionId}` URL
2. `sandbox-router` looks up the session in Redis
3. If the pod IP is the same and status is `ready`, route to the same pod
4. If the pod IP changed (pod restarted, rescheduled), route to the new pod
5. If no entry exists (pod terminated), return HTTP 410 Gone -- client shows "Session ended" UI

### Pod Restart / Rescheduling

When a pod crashes:

1. The old pod's Redis entry TTL expires (300s) or the orchestrator actively deletes it
2. The **Session Controller** (Go service watching Kubernetes events) detects pod termination
3. If the session is still active (user hasn't explicitly ended it), the controller schedules a new pod
4. New pod boots, registers in Redis with the same `sessionId` but a new `podIP`
5. Client's reconnection logic (exponential backoff) eventually succeeds when the new pod registers
6. On reconnect, client sends `session/reconnect` with its last known state (see Section 4)

### Future: Kubernetes Gateway API

NGINX Ingress enters maintenance-only mode in 2026. The long-term migration path is Kubernetes Gateway API with Istio or Cilium as the data plane, which natively supports:
- HTTPRoute with backend references to specific endpoints
- Session persistence policies
- WebSocket timeout configuration

The `sandbox-router` pattern translates cleanly to a Gateway API `BackendTLSPolicy` + custom controller.

---

## 4. Reconnection & Resilience

### Fundamental Principle

WebSocket connections WILL break. The system must treat disconnection as a normal event, not an exception. Every subsystem must define what "catch up" means after a gap.

### Client-Side Reconnection State Machine

```
                    +----------+
                    | CONNECTED|
                    +----+-----+
                         |
                    connection lost
                         |
                    +----v--------+
              +---->| RECONNECTING|<----+
              |     +----+--------+     |
              |          |              |
              |     attempt connect     |
              |          |              |
              |     +----v-----+        |
              |     | success? |        |
              |     +----+-----+        |
              |      yes |   no         |
              |          |   |          |
              |          |   +----------+  (exponential backoff)
              |          |
              |     +----v---------+
              |     | SYNCHRONIZING|  (state reconciliation)
              |     +----+---------+
              |          |
              |     sync complete
              |          |
              |     +----v-----+
              |     | CONNECTED|
              |     +----------+
              |
              +-- connection lost again
```

### Exponential Backoff Parameters

```typescript
const RECONNECT_CONFIG = {
  initialDelay: 500,        // ms
  maxDelay: 30_000,         // ms (30 seconds)
  maxAttempts: 20,          // then show "offline" UI permanently
  resetAfterConnected: 5000, // ms connected before resetting attempt count
  // Full jitter algorithm: random(0, min(30s, 500ms * 2^attempt))
  getDelay: (attempt: number) => Math.random() * Math.min(30_000, 500 * Math.pow(2, attempt)),
};
```

Jitter prevents the thundering herd: if 1000 users disconnect simultaneously (e.g., NGINX restart), they must not all reconnect at the same instant. Full jitter (not equal jitter) provides the best spread distribution.

**Client-side circuit breaker:** After 5 consecutive reconnection failures, enter open state and show a manual "Retry Connection" button. After 30 seconds in open state, automatically send a single probe attempt. If the probe succeeds, resume normal reconnection. If the probe fails, return to open state and show the manual retry button again.

### State Reconciliation Protocol

On successful reconnect, the client sends a `session/reconnect` request:

```typescript
// Client -> Server (Sandbox Connection)
{
  "jsonrpc": "2.0",
  "id": "req_reconnect_1",
  "method": "session/reconnect",
  "params": {
    "lastSequence": 847293,              // Last received server sequence number
    "terminals": {
      "1": { "alive": true },            // Terminal IDs client had open
      "2": { "alive": true }
    },
    "openFiles": ["/src/index.ts", "/src/App.tsx"],  // Files open in editor
    "watchedPaths": ["/src/", "/public/"]             // Active file watchers
  }
}
```

Server responds with a state delta:

```typescript
// Server -> Client
{
  "jsonrpc": "2.0",
  "id": "req_reconnect_1",
  "result": {
    "missedMessages": 12,                 // Count of buffered messages being replayed
    "terminals": {
      "1": { "alive": true, "replayBytes": 4096 },  // Will replay last 4KB of output
      "2": { "alive": false, "exitCode": 0 }         // Terminal exited while disconnected
    },
    "fileChanges": [                      // Files that changed while disconnected
      { "path": "/src/index.ts", "type": "modify", "mtime": 1712567891456 },
      { "path": "/src/new-file.ts", "type": "create", "mtime": 1712567892000 }
    ],
    "serverSequence": 847305              // Current server sequence
  }
}
```

After this response, the server replays buffered messages (sequence 847294 through 847305), then resumes normal delivery.

### Server-Side Message Buffer

The sandbox agent maintains a **ring buffer** of the last 5,000 JSON-RPC messages (notifications only -- responses are not buffered because the original request is stale). This buffer is held in memory and costs approximately **10-25 MB** per session assuming average message size of 2-5 KB.

The Core API WebSocket maintains a separate **ring buffer** of the last 2,000 messages for AI streaming events and project management notifications. This ensures AI response continuity across reconnections.

If the user was disconnected longer than the buffer covers, the server falls back to **full state sync**:
- Resend the full file tree (not contents, just paths and mtimes)
- Client diffs against its local cache and requests changed file contents
- Terminal output before the buffer window is lost (acceptable -- user can scroll up in their shell history)

### Stampede Mitigation

Server-side rate limit: 50 reconnections/second per router instance. If exceeded, return 503 with `Retry-After` header. File tree sync on reconnect is paginated at 100 files/batch to prevent memory spikes from large project reconnections.

### Scenario Matrix

| Scenario | Duration | Recovery Strategy |
|---|---|---|
| **Flaky WiFi** | <5 sec | WebSocket TCP keepalive sustains connection. No action needed. |
| **Tab backgrounded** | 5-60 sec | Browser may throttle. Heartbeat detects. Reconnect + buffer replay. |
| **Internet drop** | 30 sec - 5 min | Reconnect with backoff. Buffer replay for <5,000 messages (sandbox) or <2,000 messages (core). Full sync if buffer exceeded. |
| **Internet drop** | >5 min | Reconnect. Full state sync. Terminal output gap (acceptable). |
| **Sandbox pod restart** | 10-60 sec | Client retries. New pod registers in Redis. Reconnect to new pod. Full state sync (buffer was on old pod). Persistent volume preserves files. |
| **Core API restart** | 5-15 sec | Connection #2 reconnects. AI streaming in progress is lost -- client resumes from last complete message. No file/terminal impact. |
| **NGINX restart** | 2-10 sec | Both connections drop. Both reconnect independently. Rolling restart strategy limits blast radius. |

### What Gets Lost (By Design)

Not everything can or should be preserved:

- **Terminal output during disconnect**: The PTY kept running. Output scrolled. We replay the last 4KB per terminal and accept the gap. The user can re-run commands.
- **Partial AI token stream**: If Claude was mid-sentence when the API connection dropped, the partial response is discarded. The client can re-request or the server resends from the last complete content block.
- **LSP diagnostics**: Stale diagnostics are useless. On reconnect, the client triggers a full diagnostic refresh by reopening documents with the language server.

### Two-Connection Coordination

When one WebSocket connection is down while the other is up, the system degrades gracefully:

**Sandbox WS down, Core WS up:** AI text streaming works normally, but tool execution results (file edits, terminal commands) are unavailable because they require the sandbox connection. The UI shows a "Sandbox reconnecting..." banner. AI responses that require tool calls are queued and held until the sandbox reconnects.

**Core WS down, Sandbox WS up:** Terminal, file editor, and LSP all continue working normally. AI chat is unavailable. The UI shows an "AI service reconnecting..." banner. The user can continue editing and running commands but cannot start new AI conversations.

Both connections report their status independently to the `ConnectionManager`, which provides a unified status to the UI layer.

---

## 5. Terminal Streaming

### Architecture Per Terminal Instance

```
+----------------+     Binary WS Frames     +------------------+
|  xterm.js      | <======================> |  Sandbox Agent   |
|  (browser)     |   Channel 0x01/0x02      |  (in-pod Node)   |
|                |   + Terminal ID           |                  |
|  - Renders     |                           |  +------------+  |
|  - Input       |                           |  | node-pty   |  |
|  - Selection   |                           |  | (PTY fork) |  |
+----------------+                           |  +------+-----+  |
                                             |         |        |
                                             |  +------v-----+  |
                                             |  | /bin/bash   |  |
                                             |  | (or zsh)    |  |
                                             |  +-------------+  |
                                             +------------------+
```

### Latency Requirements

- **Keystroke-to-echo**: < 50ms (perceived as instant)
- **Command output start**: < 100ms (acceptable for non-interactive)
- **Measurement**: The round-trip path is browser -> NGINX -> sandbox-router -> pod -> PTY -> pod -> sandbox-router -> NGINX -> browser. With all components in the same Azure region, typical RTT is 5-15ms. The bottleneck is NGINX proxy hops, not the WebSocket protocol.

### Terminal Lifecycle (JSON-RPC)

```typescript
// Create terminal
{ "method": "terminal/create", "params": { "shell": "/bin/bash", "cols": 120, "rows": 30, "cwd": "/workspace", "env": { "TERM": "xterm-256color" } } }
// Response: { "result": { "terminalId": 1 } }

// Resize terminal
{ "method": "terminal/resize", "params": { "terminalId": 1, "cols": 150, "rows": 40 } }

// Kill terminal
{ "method": "terminal/kill", "params": { "terminalId": 1 } }

// Terminal exited (server notification)
{ "method": "terminal/exited", "params": { "terminalId": 1, "exitCode": 0 } }
```

### I/O Streaming (Binary Frames)

All keystroke and output data flows via binary frames. Zero JSON parsing overhead for the hot path.

**Client -> Server (stdin)**:
```
[0x01] [uint16 terminalId] [raw bytes from xterm.js onData]
```

**Server -> Client (stdout)**:
```
[0x02] [uint16 terminalId] [raw bytes from node-pty onData]
```

### Buffering Strategy

**Server-side (PTY -> WebSocket)**:
- node-pty emits data events at high frequency during heavy output (`find /` can produce 100+ events/second)
- **Coalescing buffer**: Accumulate PTY output for up to **5ms** or **16 KB**, whichever comes first, then flush as a single binary frame
- This reduces frame count by 10-50x during burst output without perceptible latency increase
- The 5ms window is below human perception threshold (50ms)

**Client-side (WebSocket -> xterm.js)**:
- xterm.js handles rendering efficiently via its WebGL addon
- For extreme output volumes, the client measures render time per frame. If a frame takes >16ms to render (below 60fps), enable **output throttling**: buffer incoming frames and render at a capped rate, discarding intermediate frames and keeping only the latest
- Show a "output throttled" indicator when this triggers

### Handling 100MB of Output

When a command produces massive output (e.g., `cat /dev/urandom | hexdump`):

1. **Server-side cap**: The sandbox agent tracks bytes-per-second per terminal. If output exceeds **10 MB/s sustained for 5 seconds**, inject a warning: `\r\n[bricks: output truncated -- 50MB limit reached. Use > file to redirect]\r\n`
2. **Hard limit**: 50 MB total buffered output per terminal before truncation. The PTY keeps running, but output is discarded until the rate drops.
3. **Client-side**: xterm.js has a `scrollback` limit (default 10,000 lines). Old lines are discarded from memory. The frontend never holds more than ~20MB of terminal buffer.

### Multiple Terminals

Each terminal instance gets a unique `terminalId` (uint16). The binary frame header routes to the correct xterm.js instance. Maximum per tier: Free 4, Pro 8, Team 16 (enforced server-side). Terminal list is synced on reconnect.

### Terminal Resize

Resize events use JSON-RPC (not binary) because they are infrequent and require structured data:

```typescript
{ "method": "terminal/resize", "params": { "terminalId": 1, "cols": 120, "rows": 30 } }
```

The server calls `pty.resize(cols, rows)`. The shell and running programs receive `SIGWINCH`. Resize events are **debounced client-side at 100ms** to avoid flooding during smooth panel resizing.

---

## 6. File Sync Protocol

### Design Philosophy

The filesystem in the sandbox pod is the **source of truth**. The browser holds a **cache** of recently opened files. Edits flow in both directions, but the sandbox filesystem is authoritative. This is NOT collaborative editing between multiple users -- it is synchronization between one user's browser and their sandbox.

### Architecture

```
+-------------------+                    +----------------------------+
|   Monaco Editor   |                    |   Sandbox Pod              |
|   (browser)       |                    |                            |
|                   |  file/save         |   +--------------------+   |
|   Edit buffer ----+-------------------->   | File System        |   |
|                   |                    |   | (PVC-backed)       |   |
|                   |  file/changed      |   +--------+-----------+   |
|   Update buffer <-+--------------------+            |               |
|                   |                    |   +--------v-----------+   |
+-------------------+                    |   | Chokidar (watcher) |   |
                                         |   +--------------------+   |
                                         |                            |
                                         |   AI Agent also writes     |
                                         |   files to this filesystem |
                                         +----------------------------+
```

### User Edits File in Monaco (Browser -> Sandbox)

1. User types in Monaco editor
2. **Debounce**: 300ms after last keystroke (configurable, shorter for auto-save-heavy users)
3. Client sends `file/save`:

```typescript
{
  "method": "file/save",
  "params": {
    "path": "/src/index.ts",
    "content": "...full file content...",
    "expectedMtime": 1712567890123    // Optimistic concurrency check
  }
}
```

4. Server compares `expectedMtime` with actual mtime on disk:
   - **Match**: Write file, respond with new mtime. Success.
   - **Mismatch**: Another process modified the file. Respond with error code `-32002` (conflict) and include both the server content and the server mtime.
5. On conflict, the client shows a diff view: "This file was modified outside the editor. Merge or overwrite?"

### Sandbox Modifies File (Sandbox -> Browser)

When Claude's AI agent, a terminal command, or any other process modifies a file:

1. **Chokidar** detects the change and emits an event
2. Sandbox agent checks if the changed file is in the client's **watch list** (files currently open in editor tabs + watched directories)
3. If watched, sends a notification:

```typescript
{
  "method": "file/changed",
  "params": {
    "path": "/src/index.ts",
    "changeType": "modify",       // "create" | "modify" | "delete" | "rename"
    "mtime": 1712567891456,
    "size": 2847                   // New file size in bytes
  }
}
```

4. Client receives notification, compares with its local buffer:
   - If the file has **no unsaved local changes**: fetch new content via `file/read` and update Monaco
   - If the file has **unsaved local changes**: show a notification: "File changed on disk. Reload?" with options to reload (discard local) or keep local (overwrite on next save)

### Batch Changes (git checkout, npm install)

When `git checkout another-branch` changes 500 files simultaneously:

1. Chokidar fires hundreds of events in rapid succession
2. **Server-side batching**: The sandbox agent accumulates file change events for **100ms** after the first event in a burst, then sends a single batch notification:

```typescript
{
  "method": "file/batchChanged",
  "params": {
    "changes": [
      { "path": "/src/index.ts", "changeType": "modify", "mtime": 1712567891456 },
      { "path": "/src/old-file.ts", "changeType": "delete" },
      { "path": "/src/new-file.ts", "changeType": "create", "mtime": 1712567891500 }
      // ... potentially hundreds of entries
    ],
    "hint": "git-operation"    // Helps client decide on UI behavior
  }
}
```

3. Client receives the batch and:
   - Refreshes the file tree sidebar
   - For open editor tabs: checks each one against the changes and reloads modified files (if no local edits) or prompts conflict resolution
   - Does NOT fetch file contents for files that aren't open in the editor

### The node_modules Problem

`npm install` creates 100,000+ files. Sending file/created events for each one would flood the WebSocket. Solution:

1. **Ignore patterns**: The Chokidar watcher is configured with ignore patterns matching `.gitignore` semantics:
   ```
   node_modules/**, .git/**, dist/**, build/**, *.lock (watched but not synced to editor)
   ```
2. The file tree sidebar shows `node_modules/` as a collapsed, lazy-loaded directory. Contents are fetched on-demand via `file/readDir` only when the user expands it.
3. If the user explicitly opens a file inside `node_modules`, it is fetched and displayed but NOT watched for changes.

### Binary Files

Binary files (images, compiled assets, `.wasm`) are handled differently:

1. `file/read` response includes a `binary: true` flag and `mimeType`
2. Content is transferred via the binary chunked protocol (Section 2) or as base64 in JSON for small files (<100 KB)
3. Monaco does not attempt to display binary files. The client shows a preview (image viewer) or a "Binary file" placeholder.

### File Tree Synchronization

The client maintains a lightweight file tree (paths + mtimes + sizes, no contents). On initial load and reconnect:

```typescript
// Client requests tree
{ "method": "file/tree", "params": { "root": "/workspace", "depth": 3, "ignore": ["node_modules", ".git", "dist"] } }

// Server responds
{
  "result": {
    "tree": {
      "name": "workspace",
      "type": "directory",
      "children": [
        { "name": "src", "type": "directory", "children": [...] },
        { "name": "package.json", "type": "file", "size": 1234, "mtime": 1712567890123 },
        ...
      ]
    }
  }
}
```

The tree is incrementally updated via `file/changed` notifications. Full tree re-fetch happens only on reconnect or after batch operations.

---

## 7. LSP Integration

### Architecture

Language servers run inside the sandbox pod (same filesystem as the user's code). LSP messages tunnel through the sandbox WebSocket connection using JSON-RPC, which is natively the same protocol LSP uses.

```
+------------------+     JSON-RPC       +----------------------------+
|  Monaco Editor   |  (over sandbox WS) |  Sandbox Pod               |
|  + LSP Client    | <================> |  LSP Bridge (Node process) |
|                  |                    |       |          |         |
|  monaco-         |                    |  +----v---+ +----v---+     |
|  languageclient  |                    |  | tsserv | | cssls  |     |
|  (v10.7)         |                    |  | (stdio)| | (stdio)|     |
+------------------+                    |  +--------+ +--------+     |
                                        +----------------------------+
```

### LSP Bridge (In-Pod Process)

The sandbox agent includes an LSP bridge that:

1. Starts language servers on demand (when the user opens a file of that type)
2. Communicates with each language server via **stdio** (standard LSP transport)
3. Routes LSP JSON-RPC messages between the WebSocket and the correct language server
4. Manages language server lifecycle (start, restart on crash, stop when idle)

### Message Tunneling

LSP messages are wrapped in our `lsp/*` namespace to distinguish them from file/terminal messages:

```typescript
// Client -> Server: LSP request tunneled through our protocol
{
  "jsonrpc": "2.0",
  "id": "req_lsp_001",
  "method": "lsp/request",
  "params": {
    "serverId": "typescript",           // Which language server
    "lspMessage": {                     // Standard LSP message, forwarded as-is
      "jsonrpc": "2.0",
      "id": 1,
      "method": "textDocument/completion",
      "params": {
        "textDocument": { "uri": "file:///workspace/src/index.ts" },
        "position": { "line": 10, "character": 15 }
      }
    }
  }
}

// Server -> Client: LSP response tunneled back
{
  "jsonrpc": "2.0",
  "id": "req_lsp_001",
  "result": {
    "serverId": "typescript",
    "lspMessage": {
      "jsonrpc": "2.0",
      "id": 1,
      "result": {
        "isIncomplete": false,
        "items": [...]
      }
    }
  }
}

// Server -> Client: LSP notification (diagnostics pushed)
{
  "jsonrpc": "2.0",
  "method": "lsp/notify",
  "params": {
    "serverId": "typescript",
    "lspMessage": {
      "jsonrpc": "2.0",
      "method": "textDocument/publishDiagnostics",
      "params": {
        "uri": "file:///workspace/src/index.ts",
        "diagnostics": [...]
      }
    }
  }
}
```

### Multiple Language Servers

Each file type maps to a language server:

| File Extension | Language Server | Package | Startup |
|---|---|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx` | TypeScript Language Server | `typescript-language-server` | On first `.ts/.js` file open |
| `.css`, `.scss`, `.less` | CSS Language Server | `vscode-css-languageserver-bin` | On first CSS file open |
| `.json` | JSON Language Server | `vscode-json-languageserver-bin` | On first JSON file open |
| `.html` | HTML Language Server | `vscode-html-languageserver-bin` | On first HTML file open |
| `.py` | Pyright / Pylsp | `pyright` | On first `.py` file open |
| `.go` | gopls | `gopls` | On first `.go` file open |
| `.rs` | rust-analyzer | `rust-analyzer` | On first `.rs` file open |

Language servers are **started lazily** and **stopped after 5 minutes of inactivity** (no open files of that type) to conserve sandbox resources.

### Latency Considerations

LSP completion requests are latency-sensitive (user is typing and waiting for suggestions). The full path:

```
Keystroke -> Monaco -> LSP client -> JSON serialize -> WebSocket frame ->
NGINX -> sandbox-router -> Pod WebSocket -> LSP bridge -> stdio -> tsserver ->
stdio -> LSP bridge -> Pod WebSocket -> sandbox-router -> NGINX ->
WebSocket frame -> JSON parse -> LSP client -> Monaco -> UI update
```

Measured end-to-end: **30-80ms** (Azure same-region). This is acceptable -- VS Code's built-in completion also takes 20-50ms locally. The critical optimization is **not** the transport (which adds ~10ms over local) but ensuring the language server is warm (already started, project indexed).

### Optimization: LSP Request Cancellation

If the user types another character before the completion response arrives, the previous request is stale. The client sends an LSP `$/cancelRequest` notification, which the bridge forwards to the language server. This prevents wasted computation and keeps the response pipeline clear.

### Document Synchronization

LSP requires `textDocument/didOpen`, `textDocument/didChange`, and `textDocument/didClose` notifications to keep the language server's in-memory state in sync with the editor. These are forwarded through the same tunnel. `didChange` uses **incremental sync** (only the changed range, not the full document) to minimize bandwidth:

```typescript
{
  "method": "lsp/notify",
  "params": {
    "serverId": "typescript",
    "lspMessage": {
      "method": "textDocument/didChange",
      "params": {
        "textDocument": { "uri": "file:///workspace/src/index.ts", "version": 42 },
        "contentChanges": [{
          "range": { "start": { "line": 10, "character": 0 }, "end": { "line": 10, "character": 5 } },
          "text": "const"
        }]
      }
    }
  }
}
```

---

## 8. AI Response Streaming

### Architecture

AI interactions flow through the **Core API WebSocket** (Connection #2), not the sandbox connection. The core API server manages the Claude API session, tool execution orchestration, and response streaming.

**Event transport:** Redis Streams (not pub/sub) for AI streaming events. Persistent, ordered, with consumer groups. Subscriber GC pauses do not lose messages. Redis pub/sub is retained only for ephemeral events (presence, typing indicators).

```
+------------------+    Core API WS     +------------------+     Anthropic API
|  Browser         | <================> |  Core API Server | <================>
|  (AI chat panel) |  AI stream msgs    |  (NestJS)        |  SSE / HTTP stream
|                  |                    |                  |
+------------------+                    |  Orchestrates:   |
                                        |  - Claude calls  |
                                        |  - Tool dispatch |
                                        |  - To sandbox    |
                                        +--------+---------+
                                                 |
                                                 | Internal gRPC/WS
                                                 v
                                        +--------+---------+
                                        |  Sandbox Pod     |
                                        |  (executes tools)|
                                        +------------------+
```

### AI Message Flow

When the user submits a prompt ("Fix the TypeScript errors in index.ts"):

1. Client sends `ai/submit` via Core API WebSocket
2. Core API calls Claude API (via Azure Foundry) with streaming enabled
3. Claude's response streams token-by-token
4. When Claude invokes a tool (e.g., "read file", "edit file", "run command"), the Core API:
   - Pauses token streaming
   - Dispatches the tool call to the sandbox pod (via internal connection)
   - Streams tool execution status to the client
   - Feeds tool results back to Claude
   - Resumes token streaming
5. This loop continues until Claude signals completion

### Stream Event Types

All AI streaming events are JSON-RPC notifications on the Core API WebSocket:

```typescript
// 1. Acknowledgment -- AI processing started
{
  "method": "ai/stream/status",
  "params": {
    "requestId": "ai_req_001",
    "status": "thinking",
    "message": "Analyzing your request..."
  }
}

// 2. Token stream -- Claude's text response
{
  "method": "ai/stream/token",
  "params": {
    "requestId": "ai_req_001",
    "contentBlockIndex": 0,
    "delta": "I'll fix the Type",            // Partial token(s)
    "accumulatedLength": 18                   // Total chars sent so far in this block
  }
}

// 3. Tool invocation -- Claude decided to use a tool
{
  "method": "ai/stream/tool",
  "params": {
    "requestId": "ai_req_001",
    "toolCallId": "tc_001",
    "tool": "file_read",
    "status": "invoking",
    "input": { "path": "/src/index.ts" },    // What Claude asked for
    "displayText": "Reading /src/index.ts..." // Human-readable status
  }
}

// 4. Tool progress -- for long-running tools
{
  "method": "ai/stream/tool",
  "params": {
    "requestId": "ai_req_001",
    "toolCallId": "tc_002",
    "tool": "terminal_run",
    "status": "running",
    "input": { "command": "npm test" },
    "displayText": "Running npm test...",
    "output": "PASS src/App.test.tsx\nPASS src/utils.test.ts\n"  // Partial output
  }
}

// 5. Tool completed
{
  "method": "ai/stream/tool",
  "params": {
    "requestId": "ai_req_001",
    "toolCallId": "tc_002",
    "tool": "terminal_run",
    "status": "completed",
    "result": { "exitCode": 0, "output": "..." },
    "displayText": "npm test passed (2 tests)"
  }
}

// 6. File edit by AI -- special tool event for editor integration
{
  "method": "ai/stream/tool",
  "params": {
    "requestId": "ai_req_001",
    "toolCallId": "tc_003",
    "tool": "file_edit",
    "status": "completed",
    "input": { "path": "/src/index.ts" },
    "result": {
      "path": "/src/index.ts",
      "diff": "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -10,3 +10,3 @@\n-const x: string = 42;\n+const x: number = 42;\n",
      "newContent": "..."
    },
    "displayText": "Edited /src/index.ts (fixed type error)"
  }
}

// 7. Content block boundary -- Claude finished one text block, may start another
{
  "method": "ai/stream/blockEnd",
  "params": {
    "requestId": "ai_req_001",
    "contentBlockIndex": 0,
    "blockType": "text"
  }
}

// 8. Completion -- entire response finished
{
  "method": "ai/stream/done",
  "params": {
    "requestId": "ai_req_001",
    "usage": {
      "inputTokens": 15420,
      "outputTokens": 3847,
      "cacheReadTokens": 12000,
      "cacheWriteTokens": 3420
    },
    "stopReason": "end_turn",
    "summary": "Fixed 3 TypeScript errors in index.ts"
  }
}

// 9. Error during AI processing
{
  "method": "ai/stream/error",
  "params": {
    "requestId": "ai_req_001",
    "error": {
      "code": "rate_limited",
      "message": "Claude API rate limit exceeded. Retrying in 5 seconds.",
      "retryable": true,
      "retryAfter": 5000
    }
  }
}
```

### Frontend Rendering States

The AI chat panel renders based on the stream events:

| Event | UI State |
|---|---|
| `ai/stream/status` (thinking) | Pulsing indicator: "Claude is thinking..." |
| `ai/stream/token` | Streaming text, rendered as markdown in real-time |
| `ai/stream/tool` (invoking) | Collapsed tool card: "Reading /src/index.ts..." with spinner |
| `ai/stream/tool` (running) | Expanded tool card with live output (for terminal commands) |
| `ai/stream/tool` (completed, file_edit) | Inline diff view, clickable to open file |
| `ai/stream/tool` (completed, terminal_run) | Collapsed output with exit code badge |
| `ai/stream/done` | Remove thinking indicator. Show usage stats (optional, dev mode). |
| `ai/stream/error` | Error banner with retry button if retryable |

### Cancellation

User clicks "Stop" mid-response:

```typescript
{ "method": "ai/cancel", "params": { "requestId": "ai_req_001" } }
```

Server immediately:
1. Cancels the Claude API stream
2. Cancels any in-flight tool executions (kills running terminal commands)
3. Sends `ai/stream/done` with `stopReason: "user_cancelled"`

### Interleaving Token Streaming with Tool Execution

The Claude API natively interleaves text and tool use in its streaming response. Our protocol mirrors this exactly. A typical flow:

```
ai/stream/status  -> "thinking"
ai/stream/token   -> "Let me look at the file..."
ai/stream/token   -> " I'll read index.ts first."
ai/stream/blockEnd
ai/stream/tool    -> file_read, invoking
ai/stream/tool    -> file_read, completed
ai/stream/token   -> "I can see the issue. The variable `x`..."
ai/stream/token   -> "...is typed as string but assigned a number."
ai/stream/blockEnd
ai/stream/tool    -> file_edit, invoking
ai/stream/tool    -> file_edit, completed (with diff)
ai/stream/token   -> "I've fixed the type error. Let me verify..."
ai/stream/blockEnd
ai/stream/tool    -> terminal_run ("npx tsc --noEmit"), invoking
ai/stream/tool    -> terminal_run, running (partial output)
ai/stream/tool    -> terminal_run, completed
ai/stream/token   -> "TypeScript compilation succeeds. The fix is correct."
ai/stream/blockEnd
ai/stream/done
```

---

## 9. Scaling Considerations

### Connection Math

| Metric | Value | Basis |
|---|---|---|
| WebSocket connections per user | 2 | Sandbox + Core API |
| Memory per idle WebSocket (NGINX) | ~20 KB | NGINX benchmarks: 50K connections < 1GB |
| Memory per active WebSocket (application) | ~2-5 MB | Message buffers, terminal state, file cache |
| NGINX connections per pod (conservative) | 10,000 | With 1 CPU, 1GB RAM allocated |
| NGINX connections per pod (tuned) | 50,000 | With 2 CPU, 2GB RAM, tuned worker_connections |
| Max concurrent users per NGINX pod | 5,000-25,000 | 2 connections per user |
| AKS node Standard_D8s_v5 capacity | ~4,000 sandbox pods | 8 vCPU, 32GB RAM, ~1 vCPU + 2GB per sandbox |

### At 1,000 Concurrent Users

| Component | Instance Count | Connections Handled | Resource Usage |
|---|---|---|---|
| NGINX Ingress | 2 (HA) | 1,000 each | ~20MB RAM each |
| sandbox-router (Go) | 3 | ~333 each | ~100MB RAM each |
| Core API (NestJS) | 3 | ~333 each | ~500MB RAM each |
| Sandbox pods | 1,000 | 1 each | ~2GB RAM each |
| Redis (session registry) | 1 (HA pair) | -- | ~50MB |
| **Total AKS nodes** | ~8-10 (Standard_D8s_v5) | -- | -- |

### Horizontal Scaling Strategy

**NGINX Ingress**: Scale based on connection count. HPA with custom metric `nginx_ingress_controller_nginx_process_connections` targeting 80% of `worker_connections`.

**sandbox-router**: Scale based on active WebSocket connections. Each instance handles up to 5,000 simultaneous proxy connections. Stateless -- any instance can proxy any session (Redis lookup).

**Core API**: Scale based on both connection count and CPU (AI orchestration is CPU-intensive for JSON serialization). HPA with dual metrics.

**Sandbox pods**: One per active session. Scale by creating/destroying pods. Auto-terminate after 30 minutes of no WebSocket connection (idle cleanup).

### Connection Distribution

Use **consistent hashing** in the sandbox-router to distribute connections across instances. When a router instance scales down, only 1/N connections need to re-route (where N is the number of instances), not all connections.

### Pod Disruption Budget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: nginx-ingress-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: nginx-ingress

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sandbox-router-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: sandbox-router
```

### Graceful Shutdown

When a sandbox-router instance is being terminated:

1. Receives `SIGTERM`
2. Stops accepting new connections
3. Sends `close` frame to all connected clients (code 1012: Service Restart)
4. Waits up to 30 seconds for clients to reconnect to other instances
5. Force-closes remaining connections
6. Exits

---

## 10. Security

### WebSocket Authentication

#### Initial Upgrade (Handshake)

The WebSocket upgrade request carries authentication via a **short-lived connection token** in the query string:

```
wss://ws.bricks.dev/sandbox/{sessionId}?token={connectionToken}
```

**Why query string and not headers?** The browser `WebSocket` API does not support custom headers. The `Sec-WebSocket-Protocol` header hack is brittle. Query string is the standard approach, confirmed by industry practice.

**Connection token properties:**
- Issued by the Core API via a REST endpoint: `POST /api/sessions/{sessionId}/ws-token`
- **Short-lived**: 30-second TTL (enough to complete the upgrade handshake, useless if intercepted later)
- **Single-use**: Invalidated after first use (stored in Redis with `NX` flag)
- **Scoped**: Contains `sessionId`, `userId`, `connectionType` (sandbox or api) in the JWT claims
- **Signed**: RS256 JWT, verified by the sandbox-router and the Core API WebSocket gateway

#### Upgrade Flow

```
1. Client: POST /api/sessions/{sessionId}/ws-token
           Headers: Authorization: Bearer {clerk_session_jwt}
           Response: { "token": "eyJhbG...", "expiresIn": 30 }

2. Client: new WebSocket("wss://ws.bricks.dev/sandbox/{sessionId}?token=eyJhbG...")

3. sandbox-router:
   - Extract token from query string
   - Verify JWT signature (RS256, public key from JWKS)
   - Check token not already used (Redis GETDEL)
   - Check token not expired
   - Check sessionId in URL matches sessionId in token claims
   - Look up pod IP from Redis session registry
   - Proxy upgrade to pod

4. Pod sandbox agent:
   - Receives upgrade with forwarded claims (via X-Bricks-UserId header from router)
   - Verifies userId matches pod's assigned user
   - Accepts WebSocket
```

### Token Refresh While Connected

The connection token is only for the upgrade handshake. Once the WebSocket is established, authentication is maintained by:

1. **Heartbeat authentication**: Every heartbeat message (every 30 seconds) includes the current Clerk session token:

```typescript
{
  "method": "session/heartbeat",
  "params": {
    "timestamp": 1712567890123,
    "sessionToken": "eyJhbG..."    // Current Clerk JWT
  }
}
```

2. The server validates the session token on each heartbeat. If the token is expired and the Clerk session has been revoked (user logged out on another device), the server closes the WebSocket with code 4001 (Authentication Expired).

3. The Clerk SDK on the frontend automatically refreshes session tokens. The client always sends the latest token.

### Protocol Version Negotiation

WebSocket upgrade includes `X-Bricks-Protocol-Version` header. Server validates compatibility. Incompatible versions receive a clean error response (HTTP 426 Upgrade Required) with upgrade instructions pointing to the latest client version. This allows rolling out protocol changes without breaking existing clients.

### Preventing WebSocket Hijacking

- **Origin validation**: The sandbox-router rejects upgrades where the `Origin` header is not `https://bricks.dev` or `https://*.bricks.dev`
- **CORS on upgrade**: While not standard WebSocket behavior, our Go router checks the origin before proxying
- **Token binding**: The connection token is bound to the specific `sessionId` -- even if intercepted, it cannot be used for a different session
- **TLS everywhere**: WSS only. Plain `ws://` is never accepted. HSTS headers on all HTTP responses.

### Rate Limiting on WebSocket Messages

Rate limiting operates at two levels:

**Per-connection (enforced by sandbox agent and Core API):**

| Message Type | Limit | Window | Action on Exceed |
|---|---|---|---|
| `file/save` | 30 | 10 seconds | Queue excess, warn client |
| `terminal/create` | 5 | 60 seconds | Reject with error |
| `lsp/request` | 100 | 10 seconds | Drop oldest, warn client |
| `ai/submit` | 5 | 60 seconds | Reject with error |
| Binary frames (terminal stdin) | 10,000 | 1 second | Drop excess silently |
| Any JSON-RPC message | 200 | 1 second | Close connection (abuse) |

**Per-user across connections (enforced by Core API via Redis):**

| Resource | Limit | Window |
|---|---|---|
| AI requests | 60 | 1 hour (free tier) |
| AI requests | 600 | 1 hour (pro tier) |
| Total WebSocket connections | 4 | Concurrent (2 sandbox + 2 API for redundancy) |
| Sandbox pods | 3 | Concurrent (multi-project) |

### Max Message Size

- **Text frames (JSON-RPC)**: 1 MB hard limit. Messages exceeding this are rejected and the connection is closed with code 1009 (Message Too Big).
- **Binary frames**: 64 KB per frame (chunked transfer for larger payloads).
- **Aggregate**: No more than 10 MB/second sustained throughput per connection. Enforced server-side with a token bucket rate limiter.

### Content Security

- File paths are validated server-side: no path traversal (`../`), no symlink following outside `/workspace`
- Terminal commands execute as a non-root user inside the sandbox
- WebSocket messages are logged (metadata only, not content) for abuse detection
- Sandbox pods have network policies restricting egress (no access to AKS control plane, internal services, or other users' pods)

---

## 11. Heartbeats & Timeouts

### Heartbeat Protocol

Heartbeats serve three purposes: keep the TCP connection alive through proxies, detect dead connections, and refresh authentication.

```typescript
// Client -> Server (every 30 seconds)
{
  "method": "session/heartbeat",
  "params": {
    "timestamp": 1712567890123,
    "sessionToken": "eyJhbG..."     // Current auth token
  }
}

// Server -> Client (response, also serves as server-side keepalive)
{
  "method": "session/heartbeatAck",
  "params": {
    "timestamp": 1712567890456,
    "serverTime": 1712567890500,    // For clock drift detection
    "nextExpected": 30000           // ms until server expects next heartbeat
  }
}
```

### Server-Initiated Keepalive

Server sends an unsolicited keepalive frame every 20 seconds (in addition to responding to client heartbeats). This prevents corporate proxy kill of idle connections. Many corporate firewalls and transparent proxies terminate WebSocket connections after 30-60 seconds of inactivity. The 20-second interval ensures continuous traffic in both directions without relying on the client's heartbeat timing.

### WebSocket Ping/Pong (Transport Level)

In addition to application-level heartbeats, the server sends WebSocket **ping frames** every 15 seconds. The client's WebSocket implementation automatically responds with pong frames. If no pong is received within 10 seconds, the server considers the connection dead and closes it.

This catches scenarios where the application layer is frozen (browser tab suspended) but the TCP connection technically still exists.

### Timeout Hierarchy

```
+--------------------------------------------------------------+
| Layer          | Mechanism       | Interval | Dead After     |
+--------------------------------------------------------------+
| TCP            | TCP keepalive   | 60s      | 3 probes = 3m  |
| WebSocket      | Ping/Pong       | 15s      | 10s no pong    |
| Application    | Heartbeat       | 30s      | 3 missed = 90s |
| NGINX          | proxy_read_timeout | 86400s (24h)           |
| Session        | No connection   | --       | 30 min         |
+--------------------------------------------------------------+
```

Detection priority: WebSocket ping/pong detects fastest (25 seconds). Application heartbeat catches cases where the connection is alive but the client is misbehaving (90 seconds). TCP keepalive is the last resort (3 minutes).

### Distinguishing "User Went to Lunch" vs "Connection Died"

These require different responses:

**Connection died (no pong response within 10s):**
1. Server closes WebSocket
2. Server keeps session alive for 30 minutes
3. Client reconnects when network returns
4. State reconciliation per Section 4

**User went to lunch (heartbeats still arriving, no user activity):**
1. Client tracks last user interaction (keystroke, click, scroll)
2. After **5 minutes of no user activity**, client sends:

```typescript
{
  "method": "session/heartbeat",
  "params": {
    "timestamp": 1712567890123,
    "sessionToken": "eyJhbG...",
    "idle": true,
    "idleSince": 1712567590000    // 5 minutes ago
  }
}
```

3. Server transitions session to **idle state**:
   - Terminal PTYs remain alive (user might have a long build running)
   - File watchers remain active
   - Language servers are stopped after 5 minutes of idle (save resources)
   - Sandbox pod resource limits are tightened (CPU throttled to 0.1 cores)
4. After **30 minutes of idle**, server sends a warning:

```typescript
{
  "method": "session/idleWarning",
  "params": {
    "minutesUntilShutdown": 5,
    "message": "Your session will be suspended in 5 minutes due to inactivity."
  }
}
```

5. After **35 minutes of idle** (no user activity resume), session is **suspended**:
   - Pod is terminated
   - Persistent volume is retained
   - Session registry entry updated: `status: "suspended"`
   - Client shows "Session suspended. Click to resume." UI

6. Resuming a suspended session:
   - Client sends `POST /api/sessions/{sessionId}/resume`
   - New pod is scheduled with the same persistent volume
   - Client reconnects once pod is ready

### Connection Cleanup

The sandbox agent tracks all active connections. When the last WebSocket connection to a sandbox pod closes:

1. Start a **2-minute grace period** (allows for page refresh reconnection)
2. If no reconnection within 2 minutes, start the **30-minute idle timer**
3. If no reconnection within 30 minutes, mark session for suspension

This prevents premature pod termination during brief disconnections while ensuring orphaned pods are cleaned up.

---

## Appendix A: Error Codes

Custom JSON-RPC error codes for the Bricks protocol:

| Code | Name | Description |
|---|---|---|
| -32000 | ServerError | Generic server error |
| -32001 | FileNotFound | Requested file does not exist |
| -32002 | FileConflict | File modified externally (mtime mismatch) |
| -32003 | TerminalNotFound | Terminal ID does not exist |
| -32004 | TerminalLimitExceeded | Maximum terminals reached |
| -32005 | LSPServerNotRunning | Language server for this file type not started |
| -32006 | LSPServerCrashed | Language server crashed, restarting |
| -32007 | SessionNotFound | Session ID not found in registry |
| -32008 | SessionSuspended | Session is suspended, needs resume |
| -32009 | AuthExpired | Authentication token expired |
| -32010 | FileTooLarge | File exceeds 50MB editor limit |
| -32011 | RateLimited | Too many requests of this type |
| -32012 | PodNotReady | Sandbox pod is still starting |
| -32013 | AIQuotaExceeded | AI usage quota exceeded for billing period |
| -32014 | TransferFailed | Chunked file transfer failed |
| -32015 | PathTraversal | Attempted path traversal attack blocked |

---

## Appendix B: Sequence Diagram -- Full User Session

```
Browser                    NGINX     sandbox-router    Redis     Sandbox Pod     Core API
  |                          |            |              |            |              |
  |-- POST /api/session/create -------------------------------------------------->|
  |<------- { sessionId, status: "creating" } ------------------------------------|
  |                          |            |              |            |              |
  |                          |            |              |  Pod boots, registers     |
  |                          |            |              |<-----------+              |
  |                          |            |              |  SET session:{id} podIP   |
  |                          |            |              |            |              |
  |-- POST /api/sessions/{id}/ws-token ------------------------------------------>|
  |<------- { token: "eyJ..." } --------------------------------------------------|
  |                          |            |              |            |              |
  |-- WSS /sandbox/{id}?token=eyJ... --->|              |            |              |
  |                          |            |-- GET Redis -+->          |              |
  |                          |            |<-- podIP ----+            |              |
  |                          |            |-- WSS upgrade ----------->|              |
  |<========= WebSocket Established (Sandbox) ==========>|           |              |
  |                          |            |              |            |              |
  |-- WSS /api/ws?token=eyJ... ----------+------------------------------------->|  |
  |<========= WebSocket Established (Core API) =============================+   |  |
  |                          |            |              |            |      |   |  |
  |-- terminal/create =================================>|            |      |   |  |
  |<-- { terminalId: 1 } ==================================         |      |   |  |
  |                          |            |              |            |      |   |  |
  |-- [binary: stdin] ====================================>          |      |   |  |
  |<-- [binary: stdout] =====================================       |      |   |  |
  |                          |            |              |            |      |   |  |
  |-- file/tree ===========================================>         |      |   |  |
  |<-- { tree: {...} } =====================================         |      |   |  |
  |                          |            |              |            |      |   |  |
  |-- ai/submit "Fix errors" ------------------------------------------------>|   |
  |<-- ai/stream/status "thinking" -------------------------------------------|   |
  |<-- ai/stream/token "Let me..." -------------------------------------------|   |
  |<-- ai/stream/tool file_read invoking --------------------------------------|   |
  |                          |            |              |     Core API --gRPC-->|  |
  |                          |            |              |     reads file from pod  |
  |<-- ai/stream/tool file_read completed ------------------------------------|   |
  |<-- ai/stream/token "I found the issue..." --------------------------------|   |
  |<-- ai/stream/tool file_edit completed -------------------------------------|   |
  |<-- file/changed (from sandbox watcher) ==================                  |   |
  |<-- ai/stream/done ---------------------------------------------------------|   |
  |                          |            |              |            |              |
```

---

## Appendix C: Technology Decisions Summary

| Decision | Choice | Alternatives Considered | Rationale |
|---|---|---|---|
| Connection count | 2 per user | 1 multiplexed, 3+ dedicated | Independent failure domains without excessive overhead |
| Transport | Raw WebSocket (WSS) | Socket.IO, Engine.IO | Full protocol control, no unnecessary abstraction |
| Message format | JSON-RPC 2.0 + binary frames | Custom JSON, Protocol Buffers, MessagePack | JSON-RPC is LSP-native, binary frames for hot paths |
| Routing | Go reverse proxy + Redis | NGINX sticky sessions, Istio service mesh | Session-to-pod mapping requires dynamic lookup |
| Reconnection | Sequence-based replay + full sync fallback | Event sourcing, last-state-only | Balances completeness vs memory cost |
| File sync | Last-writer-wins with conflict detection | CRDT (Yjs), OT | Single-user-to-sandbox (not multi-user collab on same file) |
| LSP transport | JSON-RPC tunneled in our JSON-RPC | Separate WebSocket per LSP, HTTP proxy | Reuses existing connection, same protocol family |
| AI streaming | Custom event notifications | SSE, Server-Sent Events | Bidirectional needed (cancel, feedback) |
| Auth on WS | Short-lived JWT in query string | Cookie, Sec-WebSocket-Protocol header | Browser WS API limitation |
| AI event transport | Redis Streams | Redis pub/sub, Kafka, NATS | Persistent, ordered, consumer groups. No message loss on GC pauses. Pub/sub only for ephemeral (presence, typing) |
| Session registry | Redis | etcd, PostgreSQL, Consul | Speed, TTL support, pub/sub for lifecycle events |
| Future ingress | Kubernetes Gateway API | Stay on NGINX Ingress | NGINX Ingress EOL 2026, Gateway API is the successor |

---

## Appendix D: Monitoring & Observability

### Key Metrics to Track

| Metric | Source | Alert Threshold |
|---|---|---|
| `ws_connections_active` | sandbox-router, Core API | >80% of capacity |
| `ws_connection_duration_seconds` | sandbox-router | Histogram for session length analysis |
| `ws_messages_per_second` | All WebSocket endpoints | >500/s per connection (abuse) |
| `ws_reconnection_rate` | Client telemetry | >10% of active sessions reconnecting/min |
| `ws_message_latency_ms` | Application (request to response) | p99 > 200ms |
| `sandbox_router_redis_lookup_ms` | sandbox-router | p99 > 10ms |
| `terminal_output_bytes_per_second` | Sandbox agent | >10MB/s (throttle trigger) |
| `lsp_request_latency_ms` | LSP bridge | p99 > 500ms |
| `ai_stream_token_latency_ms` | Core API | p99 > 100ms (per token) |
| `session_idle_count` | Session controller | For capacity planning |
| `session_orphaned_count` | Session controller | >0 for >5 min (cleanup failure) |

### Structured Logging

Every WebSocket message is logged with:
- `connectionId`, `sessionId`, `userId` (correlation)
- `method` (message type)
- `direction` (inbound/outbound)
- `sizeBytes` (message size, not content)
- `latencyMs` (for request-response pairs)
- **Never log message content** (may contain user code, secrets)

---

## Appendix E: Future Considerations

1. **Multi-user collaboration**: When two users share a session, upgrade from last-writer-wins to Y.js CRDT for real-time collaborative editing within the same file. The sandbox connection architecture supports multiple concurrent clients per pod; the file sync protocol would need the CRDT layer.

2. **HTTP/3 and WebTransport**: WebTransport (built on HTTP/3/QUIC) offers native multiplexing, unreliable delivery (useful for terminal output where old data is stale), and connection migration (seamless reconnection across network changes). Monitor browser support maturity.

3. **Edge routing**: Deploy sandbox-router instances in multiple Azure regions. Route users to the nearest router, which proxies to the centralized sandbox pod region. Adds latency to the sandbox connection but improves initial handshake time globally.

4. **Terminal recording**: Store terminal sessions using the `asciinema` format for playback. Useful for AI-assisted debugging ("show me what happened") and session sharing.

5. **Predictive preloading**: When Claude says "I'll edit index.ts", the frontend can pre-fetch the file content before the tool execution completes, reducing perceived latency.
