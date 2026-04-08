# Bricks Data Layer Architecture

> Version: 1.0.0
> Date: 2026-04-08
> Author: Data Architecture Team

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema (Azure PostgreSQL)](#2-database-schema-azure-postgresql)
3. [File Storage (Azure Blob Storage)](#3-file-storage-azure-blob-storage)
4. [Caching Strategy (Azure Redis)](#4-caching-strategy-azure-redis)
5. [Conversation Storage](#5-conversation-storage)
6. [Multi-Tenancy](#6-multi-tenancy)
7. [Migration Strategy](#7-migration-strategy)
8. [Backup & Recovery](#8-backup--recovery)
9. [Performance](#9-performance)
10. [Data Lifecycle](#10-data-lifecycle)

---

## 1. Architecture Overview

```
                    +-------------------+
                    |   Clerk (Auth)    |
                    +--------+----------+
                             |
                    +--------v----------+
                    |   API Gateway     |
                    |  (NestJS / Next)  |
                    +--------+----------+
                             |
          +------------------+------------------+
          |                  |                  |
+---------v------+  +--------v-------+  +------v---------+
| Azure PostgreSQL|  | Azure Blob     |  | Azure Managed  |
| Flexible Server |  | Storage        |  | Redis          |
| (Relational)   |  | (Files/Blobs)  |  | (Cache/PubSub) |
+-----------------+  +----------------+  +----------------+
     |                                        |
     +--- Built-in PgBouncer                  +--- WebSocket Scaling
     +--- Row-Level Security                  +--- Session Store
     +--- Read Replicas                       +--- Rate Limiting
```

### Design Principles

1. **UUIDs everywhere** -- `gen_random_uuid()` for all primary keys. No sequential IDs (prevents enumeration attacks, simplifies distributed ID generation, no merge conflicts).
2. **Soft deletes** -- `deleted_at TIMESTAMPTZ` on all user-facing entities. Paired with automated hard-delete purge pipeline for GDPR compliance.
3. **Tenant isolation** -- `org_id` on every tenant-scoped table. Row-Level Security (RLS) policies enforced at the database level as a safety net.
4. **Timestamps** -- `created_at` and `updated_at` on every table. All `TIMESTAMPTZ` (UTC storage, timezone-aware).
5. **JSONB for flexibility** -- Settings, preferences, metadata, and tool call payloads stored as JSONB. Avoids schema explosion while remaining queryable.
6. **Partial indexes** -- Soft-deleted rows excluded from unique constraints and hot-path queries via `WHERE deleted_at IS NULL`.
7. **Explicit foreign keys** -- Every relationship declared. Cascade deletes only where semantically correct (e.g., org deletion cascades to memberships). Restrict elsewhere.

---

## 2. Database Schema (Azure PostgreSQL)

The complete schema is defined in `schema.sql`. Below is the entity relationship summary and design rationale for each domain.

### Entity Relationship Diagram (Logical)

```
users 1--* org_members *--1 organizations
users 1--* projects
users 1--* sessions
users 1--* conversations 1--* messages
organizations 1--* projects
organizations 1--* subscriptions 1--* usage_records
organizations 1--* billing_events
organizations 1--* invitations
sessions *--1 projects
conversations *--1 projects
audit_log references users, organizations (polymorphic)
```

### Domain Breakdown

#### Users Domain
- `users` -- Core identity. Synced from Clerk (Clerk is source of truth for auth). Stores profile data, preferences, and settings that our application owns.
- `user_settings` is a JSONB column on `users` rather than a separate table. Rationale: settings are always loaded with the user, never queried independently, and JSONB avoids constant schema migrations for preference changes.

#### Organization Domain
- `organizations` -- Multi-tenant anchor. Every billable entity is an org (even solo users get a "personal" org).
- `org_members` -- Junction table with `role` enum. Supports `owner`, `admin`, `member`, `viewer`.
- `invitations` -- Pending invitations with expiry. Separate from members to avoid polluting the membership table.

#### Project Domain
- `projects` -- Core workspace unit. Contains metadata (name, language, framework, description). Links to org for billing, to user for ownership.
- `project_environment_variables` -- Encrypted env vars per project. Separated for security (can apply column-level encryption, separate access controls).
- `project_snapshots` -- Metadata for point-in-time project snapshots stored in Blob Storage.

#### Session Domain
- `sessions` -- Active sandbox sessions tied to a pod/container. Tracks lifecycle (starting, running, stopped, error), resources allocated, and connection info.
- Ephemeral by nature -- old sessions are cleaned up aggressively.

#### Conversation Domain
- `conversations` -- AI chat sessions. Can be linked to a project (contextual) or standalone.
- `messages` -- Individual messages within a conversation. Supports roles: `user`, `assistant`, `system`, `tool_call`, `tool_result`.
- `message_content` is TEXT in PostgreSQL for messages under 256KB. For larger payloads (full file contents, large tool results), content is stored in Blob Storage with a `blob_ref` pointer in the messages table.
- `conversation_branches` -- Supports branching when a user "goes back" to an earlier point and forks the conversation.

#### Billing Domain
- `subscriptions` -- Stripe subscription mirror. Stores plan tier, status, period dates. Stripe is source of truth; this is a read-optimized cache synced via webhooks.
- `usage_records` -- Granular usage tracking: API tokens consumed, compute minutes, storage bytes. Aggregated hourly.
- `billing_events` -- Immutable ledger of charges, credits, invoice generation. Append-only.

#### Audit Domain
- `audit_log` -- Immutable, append-only log of all significant actions. Who did what, when, to which resource. Stored with JSONB payload for flexibility.
- Partitioned by month on `created_at` for efficient querying and automated archival.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary keys | UUID v7 (time-sortable) | No enumeration, distributed generation, sortable by creation time |
| Soft deletes | `deleted_at TIMESTAMPTZ NULL` | GDPR compliance with purge pipeline, undo capability |
| Multi-tenancy | Shared schema + RLS | Cost-effective, 1-5% overhead, handles thousands of tenants |
| Settings/preferences | JSONB columns | Avoids schema migrations for every preference change |
| Conversation content | Hybrid (PG + Blob) | Small messages in PG for query speed, large payloads in Blob to avoid PG bloat |
| Audit log | Partitioned, append-only | Fast writes, efficient archival, regulatory compliance |
| Billing data | Mirror from Stripe | Low-latency reads, Stripe remains source of truth |
| Enums | PostgreSQL ENUM types | Type safety at DB level, self-documenting schema |

---

## 3. File Storage (Azure Blob Storage)

### Container Structure

```
bricks-storage (Storage Account)
|
+-- project-files/                    # Hot tier - Active project files
|   +-- {org_id}/
|       +-- {project_id}/
|           +-- current/              # Latest file tree
|           |   +-- src/
|           |   +-- package.json
|           |   +-- ...
|           +-- .bricks/              # Bricks metadata
|               +-- snapshot-manifest.json
|               +-- ignore-rules.json
|
+-- project-snapshots/                # Cool tier - Point-in-time snapshots
|   +-- {org_id}/
|       +-- {project_id}/
|           +-- {snapshot_id}/
|               +-- manifest.json     # File list + checksums
|               +-- files.tar.zst     # Compressed archive
|
+-- conversation-blobs/               # Hot tier - Large message content
|   +-- {org_id}/
|       +-- {conversation_id}/
|           +-- {message_id}.json     # Large tool results, file contents
|
+-- user-uploads/                     # Hot tier - Binary uploads
|   +-- {org_id}/
|       +-- {project_id}/
|           +-- images/
|           +-- documents/
|
+-- exports/                          # Cool tier - User data exports (GDPR)
    +-- {user_id}/
        +-- {export_id}.zip
```

### Path Convention

All blob paths use the pattern: `{container}/{org_id}/{resource_id}/...`

The `org_id` prefix enables:
- Azure RBAC scoping at the org level
- Easy bulk deletion for org teardown
- Cost attribution per organization
- Compliance with data residency requirements

### Versioning Strategy

**Do NOT use Azure Blob versioning for project files.** Rationale:
- Blob versioning tracks every write to every blob. For a cloud IDE with auto-save, this generates massive version counts and storage costs.
- Instead, use explicit snapshots.

**Snapshot strategy:**
1. **Auto-snapshots** -- Taken every 30 minutes while a session is active. Kept for 7 days.
2. **Manual snapshots** -- User-triggered "Save checkpoint." Kept until user deletes (subject to plan limits).
3. **Pre-operation snapshots** -- Taken before destructive AI operations (e.g., Claude refactoring multiple files). Kept for 24 hours.

Each snapshot is:
- A `manifest.json` listing every file path + SHA-256 checksum + size
- A `files.tar.zst` (Zstandard-compressed tar) of all included files
- Deduplicated: if a file hasn't changed since last snapshot, only the reference is stored (content-addressable by hash)

### Handling Large Projects (100k+ files with node_modules)

**Problem:** A typical Node.js project with `node_modules` can have 100k+ files totaling 500MB+.

**Solution: Exclusion rules + Lazy sync**

1. **Exclusion rules** (`.bricksignore`):
   ```
   node_modules/
   .git/
   dist/
   build/
   __pycache__/
   .next/
   .venv/
   *.pyc
   ```
   Stored in `{project_id}/.bricks/ignore-rules.json`. Applied during snapshots AND during file tree sync to the browser.

2. **Lazy file sync:**
   - Only the file tree structure (paths + sizes) is sent to the browser initially.
   - File contents are loaded on-demand when a user opens a file in the editor.
   - `node_modules` tree is shown but contents are never synced to the browser.

3. **Dependency caching:**
   - `node_modules` is recreated from `package-lock.json` inside the sandbox pod.
   - A shared dependency cache layer (content-addressable) reduces install times.

### Binary Files (Images, PDFs)

- Stored in `user-uploads/{org_id}/{project_id}/` container.
- Served via SAS tokens with short TTL (15 minutes) for preview in the IDE.
- Not included in conversation context (only file paths referenced).
- Size limit: 50MB per file, 500MB total per project (configurable by plan).

### Concurrent Access (User + Claude Writing Same File)

**Problem:** User is editing `app.tsx` in the editor while Claude is also writing to `app.tsx` via a tool call.

**Solution: Last-write-wins with conflict detection**

1. **Optimistic concurrency** -- Each file has an `etag` (SHA-256 of content). Writes include the expected etag.
2. **Conflict detection** -- If the etag doesn't match, the write is rejected and the client is notified.
3. **Claude's writes** -- Claude writes go through the sandbox filesystem (not directly to Blob Storage). The sandbox file watcher (Chokidar) detects the change and pushes it to the browser via WebSocket. The browser's editor receives the diff and applies it.
4. **User's writes** -- User edits in the browser are sent to the sandbox via WebSocket, written to the filesystem, and the change is synced to Blob Storage.
5. **Both write simultaneously** -- The sandbox filesystem is the single source of truth during an active session. Y.js CRDT handles the merge if real-time collab is enabled. If not, last-write-wins at the filesystem level.

**Key insight:** During an active session, the sandbox pod's filesystem is authoritative. Blob Storage is synced periodically (debounced, every 5 seconds of idle) and on session end. This avoids Blob Storage becoming a bottleneck.

---

## 4. Caching Strategy (Azure Managed Redis)

### What Gets Cached

| Data Type | Redis Key Pattern | TTL | Rationale |
|-----------|------------------|-----|-----------|
| User session (Clerk JWT claims) | `session:{session_id}` | 15 min | Avoid Clerk API call on every request |
| User profile (hot data) | `user:{user_id}:profile` | 5 min | Loaded on every page render |
| Org membership + role | `user:{user_id}:orgs` | 5 min | Authorization check on every API call |
| Project metadata | `project:{project_id}:meta` | 10 min | Loaded when opening project |
| Active session info | `pod:{session_id}:info` | No TTL (evicted on session end) | Pod URL, status, connection info |
| Subscription/plan tier | `org:{org_id}:plan` | 30 min | Rate limiting, feature gating |
| Rate limit counters | `ratelimit:{org_id}:{endpoint}` | 1 min (sliding window) | API rate limiting |
| Feature flags | `flags:{org_id}` | 5 min | Feature gating per org |
| File tree cache | `project:{project_id}:tree` | 2 min | Avoid re-scanning filesystem |

### Cache Invalidation Strategy

**Write-through invalidation:**
- When a write occurs to PostgreSQL, the corresponding Redis key is deleted (not updated).
- Next read triggers a cache miss and repopulates from PostgreSQL.
- This avoids stale data and race conditions from dual-write.

**Event-driven invalidation:**
- Stripe webhook updates subscription -> delete `org:{org_id}:plan`
- Clerk webhook updates user -> delete `user:{user_id}:profile`
- Project settings change -> delete `project:{project_id}:meta`

**Why delete, not update:**
- Simpler. No need to serialize the new value in the write path.
- Avoids thundering herd on popular keys (lazy repopulation spreads load).
- For hot keys, use a short TTL + stale-while-revalidate pattern.

### Redis Pub/Sub Channels

| Channel | Events | Subscribers |
|---------|--------|-------------|
| `pod:{session_id}:status` | `starting`, `running`, `stopped`, `error`, `oom` | API server, WebSocket gateway |
| `project:{project_id}:file-change` | File create/modify/delete events | All connected browser tabs for this project |
| `user:{user_id}:notifications` | System notifications, collab invites | WebSocket gateway -> browser |
| `org:{org_id}:billing` | Usage threshold alerts, plan changes | Billing service, notification service |
| `conversation:{conversation_id}:stream` | Claude response token stream | WebSocket gateway -> browser |

### WebSocket Scaling (Multiple API Instances)

**Problem:** With multiple NestJS API instances behind a load balancer, a WebSocket connected to Instance A needs to receive events from Instance B.

**Solution: Redis as WebSocket backplane**

```
Browser <--WS--> API Instance 1 <--pub/sub--> Redis <--pub/sub--> API Instance 2
Browser <--WS--> API Instance 2
```

- Each API instance subscribes to relevant Redis channels.
- When an event occurs (e.g., Claude finishes writing a file), it's published to the Redis channel.
- All API instances receive it and forward to their connected WebSocket clients.
- Socket.IO's Redis adapter (`@socket.io/redis-adapter`) handles this transparently.

### TTL Summary

| Category | TTL | Rationale |
|----------|-----|-----------|
| Auth/session data | 15 min | Balance security with performance |
| User/org profiles | 5 min | Changes infrequently, needs freshness |
| Project metadata | 10 min | Moderate change frequency |
| Subscription data | 30 min | Rarely changes (only on plan change) |
| Rate limit windows | 1 min sliding | Standard rate limiting window |
| Pod session info | No TTL | Explicitly evicted on lifecycle events |
| Feature flags | 5 min | Deploy-time changes, not real-time |

---

## 5. Conversation Storage

### The Core Challenge

Claude API messages can be enormous:
- A single tool result containing a full file could be 50-200KB.
- A conversation with 50 messages including file contents could be 5-10MB.
- Context window is up to 1M tokens (~4MB of text).

Storing all of this in PostgreSQL rows would cause table bloat, slow backups, and expensive queries.

### Hybrid Storage Architecture

```
+------------------+     +-------------------+     +------------------+
|   PostgreSQL     |     |   Azure Blob      |     |   Redis          |
|                  |     |   Storage          |     |                  |
| - Message meta   |     | - Large content   |     | - Active convo   |
| - Role, tokens   |     | - Tool results    |     |   context cache  |
| - Small content  |     | - File contents   |     | - Token stream   |
|   (< 4KB inline) |     | - Full snapshots  |     |                  |
| - blob_ref ptr   |     |                   |     |                  |
+------------------+     +-------------------+     +------------------+
```

**Rules:**
1. Messages with `content` under 4KB: stored inline in PostgreSQL `content` column.
2. Messages with `content` over 4KB: content stored in Blob Storage at `conversation-blobs/{org_id}/{conversation_id}/{message_id}.json`. PostgreSQL stores `blob_ref` (the blob path) and `content` is set to NULL.
3. Tool call metadata (function name, arguments structure) always in PostgreSQL. Tool result payloads follow the 4KB rule.
4. Active conversation context (last N messages needed for the next Claude API call) is cached in Redis with a 30-minute TTL.

### Conversation Branching

**Problem:** User sends messages A -> B -> C -> D, then clicks on message B and sends a different message E, forking the conversation.

**Solution: Tree structure with parent references**

```sql
messages.parent_message_id  -- Points to the message this is a reply to
conversation_branches       -- Named branch metadata
```

- Each message has a `parent_message_id` (NULL for the first message).
- A branch is created when a message's parent already has a child (fork point).
- The `conversation_branches` table stores branch metadata (name, fork point, active flag).
- To load a branch: walk the parent chain from the branch tip back to root.
- The "main" branch is the default. Other branches are named (e.g., "Alternative approach", "Rollback to v2").

**Loading context for Claude API calls:**
1. Start from the active branch tip.
2. Walk `parent_message_id` chain back to root.
3. Collect messages in order.
4. For messages with `blob_ref`, fetch content from Blob Storage (parallelized).
5. Cache the assembled context in Redis for 30 minutes.

### Token Counting and Storage

- `input_tokens` and `output_tokens` stored on each message (from Claude API response `usage` object).
- `cached_tokens` stored separately (for Anthropic prompt caching billing).
- `total_cost_microcents` computed and stored (allows billing without re-querying token prices).
- Aggregated hourly into `usage_records` for billing.

---

## 6. Multi-Tenancy

### Strategy: Shared Database + Row-Level Security

**Why not schema-per-tenant or database-per-tenant:**
- We expect thousands of tenants (organizations), not hundreds.
- Schema-per-tenant degrades `pg_catalog` performance beyond ~5,000 schemas.
- Database-per-tenant has massive operational overhead.
- Shared database + RLS gives us isolation with 1-5% query overhead.

### Row-Level Security Implementation

Every tenant-scoped table has an `org_id` column. RLS policies enforce that a database session can only see rows belonging to the current tenant.

**Tenant context flow:**
1. API request arrives with Clerk JWT.
2. Middleware extracts `org_id` from JWT claims.
3. Before executing any query, set session variable: `SET LOCAL bricks.current_org_id = '{org_id}'`.
4. RLS policies use `current_setting('bricks.current_org_id')` to filter rows.
5. Transaction commits, session variable is cleared.

**Critical safety rules:**
- The `SET LOCAL` is scoped to the current transaction. If the transaction ends, the variable is gone. This prevents leakage across requests.
- Even if application code has a bug and forgets a WHERE clause, RLS prevents cross-tenant data access.
- Superuser/migration connections bypass RLS (by design). Application connections use a restricted role.

### Application-Level Isolation

RLS is the safety net. The application ALSO filters by `org_id` in every query:
- Drizzle schema definitions include `org_id` in all tenant-scoped queries.
- A middleware wrapper automatically injects `org_id` into query builders.
- Integration tests verify that cross-tenant queries return empty results.

### Preventing Cross-Tenant Data Leaks

| Layer | Mechanism |
|-------|-----------|
| Database | RLS policies on every tenant-scoped table |
| Application | Middleware injects `org_id` into every query |
| API | Authorization middleware validates org membership |
| Blob Storage | Path prefix `{org_id}/` + SAS tokens scoped to org container |
| Redis | Key prefix includes `org_id` where applicable |
| Audit | All cross-tenant access attempts logged |
| Testing | Automated tests verify tenant isolation |

---

## 7. Migration Strategy

### Tool: Drizzle Kit

**Why Drizzle over Prisma Migrate:**
- Zero binary dependencies (no Prisma engine to deploy).
- 7KB runtime vs 40KB+ for Prisma.
- SQL-like query builder -- developers see exactly what SQL is generated.
- Better serverless/edge compatibility.
- Code-first schema: schema IS the TypeScript code.
- Drizzle has surpassed Prisma in weekly npm downloads as of late 2025.

**Why not raw SQL migrations:**
- Lose type safety and schema diffing.
- Manual migration file management is error-prone.
- No automatic rollback generation.

### Migration Workflow

```
Development:
  1. Edit schema in TypeScript (drizzle/schema/*.ts)
  2. Run `drizzle-kit generate` -- produces SQL migration file
  3. Review generated SQL (always review!)
  4. Run `drizzle-kit migrate` against dev database
  5. Commit migration files to git

Staging:
  1. CI pipeline runs `drizzle-kit migrate` against staging DB
  2. Run integration test suite
  3. Verify no regressions

Production:
  1. CD pipeline runs `drizzle-kit migrate` against production DB
  2. Migrations run inside a transaction (atomic)
  3. If migration fails, transaction rolls back, deployment stops
  4. Post-migration health check verifies schema state
```

### Zero-Downtime Migration Rules

1. **Never rename a column in one step.** Instead: add new column -> backfill -> update app to use new column -> drop old column. (3 separate migrations.)
2. **Never drop a column that the app still reads.** Deploy app code first (stop reading the column), then drop.
3. **Add columns as NULLable.** Adding a NOT NULL column to a large table locks it. Add as NULLable, backfill, then add constraint.
4. **Create indexes CONCURRENTLY.** `CREATE INDEX CONCURRENTLY` avoids table locks.
5. **Use advisory locks** to prevent concurrent migration runs.
6. **RLS policy changes are instant** -- no table locks, can be deployed freely.

### Migration File Naming

```
drizzle/migrations/
  0001_initial_schema.sql
  0002_add_project_snapshots.sql
  0003_add_conversation_branching.sql
  ...
```

Sequential numbering. Timestamp-based naming (e.g., `20260408120000_`) is also acceptable but sequential is simpler for small teams.

---

## 8. Backup & Recovery

### Azure PostgreSQL Automated Backups

| Setting | Value | Rationale |
|---------|-------|-----------|
| Backup retention | **35 days** (maximum) | Maximum protection window |
| Backup redundancy | **Zone-redundant** | Survives AZ failure |
| PITR granularity | **Up to 5 min RPO** | Azure default, sufficient for our use case |

### RPO and RTO Targets

| Scenario | RPO Target | RTO Target | Mechanism |
|----------|-----------|-----------|-----------|
| AZ failure (same region) | 5 minutes | < 30 minutes | Zone-redundant HA, automatic failover |
| Regional failure | 1 hour | < 4 hours | Geo-redundant backup restore |
| Accidental data deletion | 0 (point-in-time) | < 1 hour | PITR to any point in last 35 days |
| Schema migration failure | 0 (transaction rollback) | < 5 minutes | Migrations are transactional |

### Azure Blob Storage Backup

| Setting | Value | Rationale |
|---------|-------|-----------|
| Redundancy | **GRS** (Geo-Redundant Storage) for `project-files` and `conversation-blobs` | Survives regional failure |
| Redundancy | **LRS** for `exports` and `project-snapshots` | Cost savings, already redundant by nature |
| Soft delete | **Enabled, 30-day retention** | Protects against accidental blob deletion |
| Versioning | **Disabled** (we use explicit snapshots) | Avoids cost explosion from auto-save writes |

### Manual Backup Procedures

1. **Weekly logical backup** -- `pg_dump` of the full database, compressed, stored in a separate Azure Blob container with 90-day retention. Serves as an independent backup layer beyond Azure's automated backups.
2. **Pre-migration backup** -- Automated `pg_dump` triggered by CI before every production migration.
3. **Audit log export** -- Monthly export of audit log partitions to cold storage (Archive tier) for long-term compliance retention.

### Disaster Recovery Testing

- **Monthly:** Restore from PITR to a test server, run schema validation and sample queries.
- **Quarterly:** Full DR drill -- restore from geo-redundant backup in a secondary region, verify full application functionality.

---

## 9. Performance

### Expected Query Patterns and Optimization

#### Hot Path Queries (< 10ms target)

| Query | Frequency | Index Strategy |
|-------|-----------|----------------|
| Get user by Clerk ID | Every request | `idx_users_clerk_id` (unique) |
| Get user's org memberships | Every request | `idx_org_members_user_id` + `WHERE deleted_at IS NULL` |
| Check org membership + role | Every request | `idx_org_members_user_org` (composite unique) |
| Get project by ID (with org check) | High | PK lookup + RLS |
| Get active session for project | High | `idx_sessions_project_active` (partial, status = 'running') |
| Get recent conversations for project | Medium | `idx_conversations_project_updated` |
| Get messages for conversation (ordered) | Medium | `idx_messages_conversation_order` |
| Get subscription for org | Medium | `idx_subscriptions_org_active` (partial) |

#### Warm Path Queries (< 100ms target)

| Query | Frequency | Optimization |
|-------|-----------|-------------|
| List projects for org | Medium | Index on `(org_id, updated_at DESC)` + pagination |
| Search audit log by org + date range | Low | Partition pruning on `created_at` + index on `org_id` |
| Aggregate usage records for billing | Hourly batch | Pre-aggregated by hour, index on `(org_id, period_start)` |
| List messages with content (conversation) | Medium | Covering index avoids table lookup for metadata |

### Connection Pooling

**Use Azure PostgreSQL's built-in PgBouncer:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| Pool mode | `transaction` | Best for web workloads, releases connections between transactions |
| `default_pool_size` | `50` | Sized for our expected pool count and max_connections |
| `max_client_conn` | `5000` | Handles burst from multiple API instances |
| `max_prepared_statements` | `100` | Enable prepared statement support in transaction mode |

**Application-level pooling (Drizzle + node-postgres):**
- `max` connections per API instance: `20`
- `idleTimeoutMillis`: `30000` (30 seconds)
- `connectionTimeoutMillis`: `5000` (5 seconds)
- Combined with PgBouncer, this prevents connection exhaustion.

### Read Replicas

**Phase 1 (Launch):** No read replicas. Single primary with built-in PgBouncer handles expected load.

**Phase 2 (Scale):** Add 1-2 read replicas for:
- Audit log queries (analytics, compliance reports)
- Usage aggregation queries (billing calculations)
- Dashboard analytics (org-level usage stats)

Read replicas are configured with Azure PostgreSQL's built-in replication. Application routes read-only queries to replicas via a separate connection string.

### Query Performance Guardrails

1. **Statement timeout:** `SET statement_timeout = '30s'` for application connections. Prevents runaway queries.
2. **`pg_stat_statements` enabled:** Tracks query performance. Alert on queries exceeding 100ms average.
3. **`auto_explain` enabled (staging):** Logs execution plans for queries exceeding 50ms.
4. **No SELECT * in application code.** Drizzle's query builder enforces explicit column selection.

---

## 10. Data Lifecycle

### Session Cleanup

| Session State | Retention | Action |
|---------------|-----------|--------|
| `running` | Indefinite (while active) | Monitor for zombie detection |
| `stopped` (normal) | 7 days | Soft delete, then hard delete |
| `error` | 30 days | Retained for debugging, then hard delete |
| `expired` (timeout) | 3 days | Hard delete |

**Zombie session detection:** A background job checks every 5 minutes for sessions marked `running` with no heartbeat in the last 10 minutes. These are force-stopped and their pods reclaimed.

### Conversation Archival

| Conversation Age | Storage | Access |
|-----------------|---------|--------|
| < 30 days | PostgreSQL (hot) + Blob (for large content) | Full read/write, instant load |
| 30-90 days | PostgreSQL (metadata only) + Blob (all content moved) | Read-only, 1-2 second load |
| 90-365 days | PostgreSQL (metadata only) + Blob (Cool tier) | Read-only, up to 5 second load |
| > 365 days | Blob (Archive tier) only | Read-only, request-based retrieval (hours) |

**Archival process:**
1. Nightly job identifies conversations older than 30 days with no activity.
2. Message content is migrated from PostgreSQL to Blob Storage.
3. PostgreSQL retains metadata (timestamps, token counts, roles) for billing queries.
4. Conversation metadata in PostgreSQL is retained for 365 days, then moved to archive.

### Storage Cost Management

| Strategy | Implementation | Estimated Savings |
|----------|---------------|-------------------|
| Blob lifecycle policies | Auto-tier to Cool after 30 days, Archive after 90 days | 50-70% on old data |
| Snapshot deduplication | Content-addressable storage, only store changed files | 60-80% on snapshots |
| Message content offloading | Move large messages to Blob after 30 days | 40-60% on PostgreSQL storage |
| Audit log partitioning | Drop partitions older than retention period | Predictable storage growth |
| Dependency cache sharing | Shared content-addressable npm/pip cache across orgs | 80%+ on dependency storage |

### GDPR Data Deletion

**Right to Erasure (Article 17) implementation:**

1. **User requests deletion** via account settings or support ticket.
2. **Soft delete immediately:**
   - User record: `deleted_at` set, profile data anonymized (name -> "Deleted User", email -> hash).
   - User's personal org: soft deleted.
   - User's messages: `user_id` anonymized, content retained for org's conversation history (unless user was sole participant).
3. **Hard delete within 30 days:**
   - Automated purge job runs daily.
   - Deletes all soft-deleted records older than 30 days.
   - Removes all Blob Storage data for the user.
   - Removes all Redis cache entries.
4. **Audit trail:**
   - Deletion request logged in audit log (retained for compliance).
   - Confirmation sent to user.
5. **Backup consideration:**
   - Azure PITR backups retain data for up to 35 days.
   - Per EDPB guidance: document that backups may contain deleted data for up to 35 days, data is not actively used, and will naturally expire.

**Organization deletion:**
1. All org members notified.
2. All projects soft deleted (with 30-day grace period for recovery).
3. Subscription cancelled via Stripe API.
4. After 30 days: hard delete all org data from PostgreSQL, Blob Storage, and Redis.
5. Billing records retained for 7 years (legal requirement, anonymized).

---

## Appendix: Quick Reference

### Database Roles

| Role | Permissions | Used By |
|------|------------|---------|
| `bricks_app` | SELECT, INSERT, UPDATE, DELETE on all tables. Subject to RLS. | API application |
| `bricks_migration` | ALL on all tables, schemas. Bypasses RLS. | Migration runner |
| `bricks_readonly` | SELECT on all tables. Subject to RLS. | Read replicas, analytics |
| `bricks_admin` | ALL. Bypasses RLS. | Emergency access only |

### Environment Variables (Database)

```
DATABASE_URL=postgresql://bricks_app:***@bricks-pg.postgres.database.azure.com:6432/bricks?sslmode=require
DATABASE_URL_MIGRATION=postgresql://bricks_migration:***@bricks-pg.postgres.database.azure.com:5432/bricks?sslmode=require
DATABASE_URL_READONLY=postgresql://bricks_readonly:***@bricks-pg-replica.postgres.database.azure.com:6432/bricks?sslmode=require
REDIS_URL=rediss://***@bricks-redis.redis.cache.windows.net:6380
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=bricksstorage;...
```

Note: Port 6432 is PgBouncer. Port 5432 is direct PostgreSQL (for migrations, which need non-pooled connections).
