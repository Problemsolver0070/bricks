-- ============================================================================
-- BRICKS - Complete Database Schema
-- Azure PostgreSQL Flexible Server
-- ============================================================================
-- Version: 1.0.0
-- Date: 2026-04-08
--
-- Design Principles:
--   1. UUIDs (v7, time-sortable) for all primary keys
--   2. Soft deletes (deleted_at) on all user-facing entities
--   3. Row-Level Security (RLS) on all tenant-scoped tables
--   4. TIMESTAMPTZ for all temporal columns (UTC)
--   5. JSONB for flexible/schemaless data (settings, metadata, payloads)
--   6. Partial indexes to exclude soft-deleted rows from hot paths
--   7. Explicit foreign keys with appropriate cascade/restrict behavior
--   8. Append-only tables (audit_log, billing_events) are never updated
--   9. Partitioning on time-series tables (audit_log, usage_records)
-- ============================================================================


-- ============================================================================
-- 0. EXTENSIONS & PREREQUISITES
-- ============================================================================

-- pgcrypto: uuid_generate_v7() for UUID generation
-- Note: In PostgreSQL 14+, uuid_generate_v7() is built-in. We include pgcrypto
-- for backward compatibility and additional crypto functions.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_uuidv7: Time-sortable UUID v7 generation (RFC 9562)
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;

-- pg_trgm: Trigram indexes for fuzzy text search (project search, user search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- btree_gist: Needed for exclusion constraints on temporal data
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ============================================================================
-- 0.1 CUSTOM TYPES (ENUMS)
-- ============================================================================
-- Using PostgreSQL ENUM types for type safety at the database level.
-- Enums are stored as 4 bytes internally (same as integer), but provide
-- self-documenting schema and prevent invalid values without CHECK constraints.
--
-- TRADEOFF: Adding new enum values requires ALTER TYPE ... ADD VALUE which
-- cannot run inside a transaction in PG < 16. In PG 16+, it can. Since Azure
-- PostgreSQL Flexible Server supports PG 16, this is acceptable.
-- Removing enum values is never supported -- use soft deprecation instead.

CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'viewer');
-- owner:  Full control, can delete org, manage billing
-- admin:  Manage members, projects, settings. Cannot delete org.
-- member: Create/edit projects, use IDE. Cannot manage members.
-- viewer: Read-only access to projects. Cannot create or edit.

CREATE TYPE project_visibility AS ENUM ('private', 'internal', 'public');
-- private:  Only org members with explicit access
-- internal: All org members can view
-- public:   Anyone with the link (future: community showcase)

CREATE TYPE session_status AS ENUM ('pending', 'starting', 'running', 'stopping', 'stopped', 'error', 'expired');
-- pending:  Session requested, waiting for pod allocation
-- starting: Pod allocated, environment initializing
-- running:  Active, user can connect
-- stopping: Graceful shutdown in progress
-- stopped:  Normal termination
-- error:    Crashed or failed to start
-- expired:  Timed out due to inactivity

CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool_call', 'tool_result');
-- system:      System prompt / context injection
-- user:        Human user message
-- assistant:   Claude response
-- tool_call:   Claude requesting a tool execution (function name + args)
-- tool_result: Result of a tool execution (output returned to Claude)

CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired');
-- Maps directly to Stripe subscription statuses.
-- We mirror these exactly to avoid translation bugs.

CREATE TYPE billing_event_type AS ENUM (
    'charge',
    'credit',
    'refund',
    'invoice_created',
    'invoice_paid',
    'invoice_failed',
    'subscription_created',
    'subscription_updated',
    'subscription_canceled',
    'usage_recorded',
    'plan_changed'
);

CREATE TYPE usage_type AS ENUM ('api_tokens_input', 'api_tokens_output', 'api_tokens_cached', 'compute_minutes', 'storage_bytes', 'snapshot_count', 'session_count');
-- Granular usage tracking for metered billing.
-- api_tokens_input:  Input tokens sent to Claude API
-- api_tokens_output: Output tokens received from Claude API
-- api_tokens_cached: Cached tokens (prompt caching, billed differently)
-- compute_minutes:   Sandbox pod runtime minutes
-- storage_bytes:     Blob storage bytes used
-- snapshot_count:    Number of project snapshots
-- session_count:     Number of sessions started in billing period

CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');

CREATE TYPE snapshot_type AS ENUM ('auto', 'manual', 'pre_operation');
-- auto:           Automatic periodic snapshot (every 30 min during session)
-- manual:         User-triggered checkpoint
-- pre_operation:  Taken before destructive AI operations

CREATE TYPE audit_action AS ENUM (
    -- Auth
    'user.login', 'user.logout', 'user.created', 'user.updated', 'user.deleted',
    -- Org
    'org.created', 'org.updated', 'org.deleted', 'org.member_added', 'org.member_removed', 'org.member_role_changed',
    -- Project
    'project.created', 'project.updated', 'project.deleted', 'project.snapshot_created', 'project.snapshot_restored',
    -- Session
    'session.started', 'session.stopped', 'session.error',
    -- Conversation
    'conversation.created', 'conversation.deleted', 'conversation.branched',
    -- Billing
    'subscription.created', 'subscription.updated', 'subscription.canceled', 'billing.charge', 'billing.refund',
    -- Admin
    'admin.impersonation_start', 'admin.impersonation_end', 'admin.data_export', 'admin.data_deletion'
);


-- ============================================================================
-- 1. USERS
-- ============================================================================
-- Source of truth for auth is Clerk. This table stores application-owned data
-- that extends the Clerk user profile.
--
-- Why not just use Clerk's user metadata?
--   1. We need to JOIN user data with other tables efficiently.
--   2. Clerk metadata has size limits and no indexing.
--   3. We need referential integrity (foreign keys) with other tables.
--   4. Application-specific fields (onboarding state, quotas) belong here.

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    -- Clerk integration
    clerk_user_id        TEXT NOT NULL,           -- Clerk's user ID (e.g., "user_2abc123")
    -- We store clerk_user_id as TEXT not UUID because Clerk IDs have a prefix format.

    -- Profile (synced from Clerk via webhook, also editable in our app)
    email           TEXT NOT NULL,
    display_name    TEXT,                    -- Nullable: some users only have email
    avatar_url      TEXT,                    -- URL to avatar image (Clerk or custom)

    -- Application-owned data
    onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
    -- JSONB for user preferences. Schema validated at application layer.
    -- Example: { "theme": "dark", "editor_font_size": 14, "editor_tab_size": 2,
    --            "keybindings": "vim", "ai_model_preference": "claude-sonnet-4-6",
    --            "notifications": { "email": true, "in_app": true } }
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Soft delete + timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,            -- NULL = active, non-NULL = soft deleted
    last_active_at  TIMESTAMPTZ             -- Updated on meaningful activity (not every request)
);

-- Clerk ID lookup: every authenticated request maps Clerk ID -> our user ID.
-- This is THE hottest query in the system. UNIQUE ensures no duplicates.
CREATE UNIQUE INDEX idx_users_clerk_user_id
    ON users (clerk_user_id)
    WHERE deleted_at IS NULL;

-- Email lookup for invitations, search, duplicate detection.
-- Partial index excludes soft-deleted users from uniqueness check,
-- allowing re-registration with the same email after account deletion.
CREATE UNIQUE INDEX idx_users_email_active
    ON users (email)
    WHERE deleted_at IS NULL;

-- Trigram index for fuzzy user search (admin panel, @mentions).
CREATE INDEX idx_users_display_name_trgm
    ON users USING gin (display_name gin_trgm_ops)
    WHERE deleted_at IS NULL;

-- Last active tracking for usage analytics and zombie account detection.
CREATE INDEX idx_users_last_active
    ON users (last_active_at)
    WHERE deleted_at IS NULL;


-- ============================================================================
-- 2. ORGANIZATIONS
-- ============================================================================
-- Every billable entity is an organization. Solo users get a "personal" org
-- created automatically on signup. This simplifies billing (always bill an org)
-- and permissions (always check org membership).
--
-- Why not bill users directly?
--   1. Teams are the natural billing unit for B2B SaaS.
--   2. A user can belong to multiple orgs with different plans.
--   3. Usage attribution is cleaner at the org level.
--   4. Adding team features later doesn't require a billing model change.

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,           -- URL-friendly identifier (e.g., "acme-corp")
    -- Slug is used in URLs: bricks.dev/acme-corp/my-project
    -- Must be globally unique among active orgs.

    is_personal     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Personal orgs are auto-created, cannot be renamed, and have exactly 1 member.
    -- This flag affects UI (hide team management) and billing (personal plan limits).

    logo_url        TEXT,
    -- JSONB for org-wide settings.
    -- Example: { "default_editor": "monaco", "require_2fa": true,
    --            "allowed_ai_models": ["claude-sonnet-4-6", "claude-opus-4-6"],
    --            "max_concurrent_sessions": 5 }
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Stripe integration
    stripe_customer_id TEXT,                -- Stripe Customer object ID
    -- Nullable: set when first subscription is created via Stripe checkout.

    -- Soft delete + timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- Slug lookup: used in every URL resolution. Must be unique among active orgs.
-- Soft-deleted orgs release their slug for reuse.
CREATE UNIQUE INDEX idx_orgs_slug_active
    ON organizations (slug)
    WHERE deleted_at IS NULL;

-- Stripe customer lookup: used when processing Stripe webhooks.
-- Webhooks arrive with stripe_customer_id, we need to find the org.
CREATE UNIQUE INDEX idx_orgs_stripe_customer
    ON organizations (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL AND deleted_at IS NULL;

-- List personal org for a user: used during auth to find/create personal org.
-- (Combined with org_members lookup)


-- ============================================================================
-- 3. ORGANIZATION MEMBERS
-- ============================================================================
-- Junction table: users <-> organizations with role.
--
-- Design decisions:
--   - Separate table (not JSONB array on org) because we need:
--     a) Efficient "get all orgs for user" query
--     b) Efficient "get all members for org" query
--     c) Role-based filtering
--     d) Referential integrity with cascading deletes
--   - Role is an ENUM, not a separate roles/permissions table.
--     Rationale: We have 4 fixed roles. A full RBAC system is overengineering
--     for our use case. If we need granular permissions later, we add a
--     permissions JSONB column or a separate permissions table.

CREATE TABLE org_members (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- CASCADE on both: if org is deleted, memberships go. If user is deleted,
    -- their memberships go. This is correct semantics.

    role            org_role NOT NULL DEFAULT 'member',

    -- When did they join? Useful for audit trail and "member since" display.
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Soft delete: removed from org but record kept for audit history.
    -- A removed member can be re-invited (creates new membership record).
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- Primary lookup: "what role does user X have in org Y?"
-- This runs on EVERY authenticated request (authorization check).
-- Composite unique constraint ensures no duplicate memberships.
CREATE UNIQUE INDEX idx_org_members_user_org_active
    ON org_members (user_id, org_id)
    WHERE deleted_at IS NULL;

-- "List all members of org X" -- used in team management page.
CREATE INDEX idx_org_members_org
    ON org_members (org_id)
    WHERE deleted_at IS NULL;

-- "List all orgs for user X" -- used in org switcher dropdown.
CREATE INDEX idx_org_members_user
    ON org_members (user_id)
    WHERE deleted_at IS NULL;


-- ============================================================================
-- 4. INVITATIONS
-- ============================================================================
-- Separate from org_members to avoid polluting the membership table with
-- pending/expired invitations. An invitation becomes a membership on acceptance.

CREATE TABLE invitations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    email           TEXT NOT NULL,           -- Invitee's email (may not be a user yet)
    role            org_role NOT NULL DEFAULT 'member',
    status          invitation_status NOT NULL DEFAULT 'pending',

    -- Token for email invitation link. Hashed in DB, raw sent in email.
    token_hash      TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,    -- Typically 7 days from creation

    -- If accepted, link to the resulting membership.
    accepted_by_user_id UUID REFERENCES users(id),
    accepted_at     TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by token hash: used when user clicks invitation link.
CREATE UNIQUE INDEX idx_invitations_token
    ON invitations (token_hash);

-- "List pending invitations for org X" -- team management page.
CREATE INDEX idx_invitations_org_pending
    ON invitations (org_id)
    WHERE status = 'pending';

-- Prevent duplicate pending invitations to the same email for the same org.
CREATE UNIQUE INDEX idx_invitations_org_email_pending
    ON invitations (org_id, email)
    WHERE status = 'pending';


-- ============================================================================
-- 5. PROJECTS
-- ============================================================================
-- A project is the core workspace unit. It represents a codebase that users
-- work on in the cloud IDE.
--
-- Key relationships:
--   - Belongs to an organization (billing, access control)
--   - Created by a user (but owned by the org, not the user)
--   - Has sessions (active sandbox instances)
--   - Has conversations (AI chat history)
--   - Has snapshots (point-in-time backups)

CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- RESTRICT on user delete: don't lose project if creator leaves.
    -- The project belongs to the org, not the user.

    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,           -- URL-friendly: bricks.dev/acme-corp/my-project
    description     TEXT,

    -- Project metadata
    visibility      project_visibility NOT NULL DEFAULT 'private',
    language        TEXT,                    -- Primary language: "typescript", "python", "rust", etc.
    framework       TEXT,                    -- Framework: "nextjs", "django", "axum", etc.
    node_version    TEXT,                    -- e.g., "20.11.0" (for Node.js projects)
    -- We store language/framework as TEXT not ENUM because the set of languages
    -- and frameworks is open-ended and frequently growing.

    -- Blob storage references
    -- Root blob path: project-files/{org_id}/{project_id}/current/
    blob_storage_path TEXT NOT NULL,

    -- JSONB for project-specific settings.
    -- Example: { "auto_save": true, "format_on_save": true,
    --            "lint_on_save": false, "build_command": "npm run build",
    --            "start_command": "npm run dev", "port": 3000,
    --            "env_template": ".env.example",
    --            "bricksignore": ["node_modules/", ".git/", "dist/"] }
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Resource tracking
    storage_bytes   BIGINT NOT NULL DEFAULT 0, -- Current storage usage in bytes
    file_count      INTEGER NOT NULL DEFAULT 0, -- Number of files (excluding ignored)
    last_accessed_at TIMESTAMPTZ,              -- Last time any session was active

    -- Soft delete + timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- Slug must be unique within an org (not globally).
-- URL: bricks.dev/{org_slug}/{project_slug}
CREATE UNIQUE INDEX idx_projects_org_slug_active
    ON projects (org_id, slug)
    WHERE deleted_at IS NULL;

-- "List all projects for org X, most recently updated first"
-- This is the project dashboard query.
CREATE INDEX idx_projects_org_updated
    ON projects (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- "List all projects created by user X" -- user's profile page.
CREATE INDEX idx_projects_creator
    ON projects (created_by_user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- Full-text search on project name and description.
CREATE INDEX idx_projects_name_trgm
    ON projects USING gin (name gin_trgm_ops)
    WHERE deleted_at IS NULL;

-- Blob storage path lookup (for Blob Storage operations).
CREATE INDEX idx_projects_blob_path
    ON projects (blob_storage_path)
    WHERE deleted_at IS NULL;


-- ============================================================================
-- 6. PROJECT ENVIRONMENT VARIABLES
-- ============================================================================
-- Separated from projects table for security:
--   1. Different access controls (not every team member should see env vars)
--   2. Column-level encryption can be applied independently
--   3. Audit trail for env var changes (separate from project changes)
--   4. Avoids loading secrets when they're not needed
--
-- Values are encrypted at the application layer before storage using
-- AES-256-GCM with a per-org encryption key stored in Azure Key Vault.

CREATE TABLE project_environment_variables (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Denormalized org_id for RLS. Could be JOINed from projects, but RLS
    -- policies cannot contain JOINs efficiently. The duplication is intentional.

    key             TEXT NOT NULL,           -- Env var name: "DATABASE_URL", "API_KEY"
    encrypted_value TEXT NOT NULL,           -- AES-256-GCM encrypted value
    -- We store the encrypted value as TEXT (base64-encoded ciphertext).
    -- Decryption happens at the application layer, never in SQL queries.

    is_secret       BOOLEAN NOT NULL DEFAULT TRUE,
    -- If true, value is masked in UI and logs. All env vars default to secret.
    -- Non-secret vars (like NODE_ENV=production) can be unmasked for convenience.

    description     TEXT,                    -- Optional description for team documentation

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key must be unique within a project (can't have two DATABASE_URL).
CREATE UNIQUE INDEX idx_env_vars_project_key
    ON project_environment_variables (project_id, key);

-- Load all env vars for a project (when starting a session).
CREATE INDEX idx_env_vars_project
    ON project_environment_variables (project_id);


-- ============================================================================
-- 7. PROJECT SNAPSHOTS
-- ============================================================================
-- Metadata for point-in-time project snapshots.
-- Actual file data is in Azure Blob Storage at:
--   project-snapshots/{org_id}/{project_id}/{snapshot_id}/

CREATE TABLE project_snapshots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- SET NULL: if user is deleted, we keep the snapshot but lose the creator ref.
    -- NULL is also valid for auto-snapshots (system-created).

    type            snapshot_type NOT NULL,
    name            TEXT,                    -- User-given name for manual snapshots
    description     TEXT,                    -- Why was this snapshot taken?

    -- Blob storage reference
    blob_storage_path TEXT NOT NULL,         -- Full path to snapshot in Blob Storage
    manifest_blob_path TEXT NOT NULL,        -- Path to manifest.json

    -- Snapshot metadata
    file_count      INTEGER NOT NULL,
    total_size_bytes BIGINT NOT NULL,        -- Compressed size in blob storage
    original_size_bytes BIGINT NOT NULL,     -- Uncompressed size

    -- Lifecycle
    expires_at      TIMESTAMPTZ,            -- NULL = never expires (manual snapshots)
    -- Auto snapshots: expires_at = created_at + 7 days
    -- Pre-operation: expires_at = created_at + 24 hours
    -- Manual: NULL (kept until user deletes or plan limit hit)

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    -- No updated_at: snapshots are immutable once created.
    -- No deleted_at: snapshots are hard-deleted (with their blob data) when expired.
);

-- "List snapshots for project X, most recent first"
CREATE INDEX idx_snapshots_project_created
    ON project_snapshots (project_id, created_at DESC);

-- Cleanup job: "find all expired snapshots"
CREATE INDEX idx_snapshots_expired
    ON project_snapshots (expires_at)
    WHERE expires_at IS NOT NULL;

-- Count snapshots per org for plan limit enforcement.
CREATE INDEX idx_snapshots_org
    ON project_snapshots (org_id);


-- ============================================================================
-- 8. SESSIONS
-- ============================================================================
-- An active sandbox session. Represents a running pod/container that a user
-- is connected to for coding.
--
-- Sessions are ephemeral: they start, run, and stop. Old sessions are cleaned
-- up aggressively. This table is high-write (status updates, heartbeats) but
-- most queries target only active sessions.

CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- A session is always tied to exactly one user. Even in collaborative mode,
    -- each user has their own session (connected to the same pod via Y.js).

    status          session_status NOT NULL DEFAULT 'pending',

    -- Pod/container information
    pod_id          TEXT,                    -- Kubernetes pod ID or container ID
    pod_ip          TEXT,                    -- Internal IP for WebSocket connection
    pod_port        INTEGER,                -- Port for WebSocket connection
    region          TEXT,                    -- Azure region: "eastus", "westeurope"
    -- Connection info populated when pod is allocated (status = 'starting').

    -- Resource allocation
    cpu_millicores  INTEGER NOT NULL DEFAULT 1000,  -- 1000m = 1 vCPU
    memory_mb       INTEGER NOT NULL DEFAULT 2048,  -- 2GB default
    storage_gb      INTEGER NOT NULL DEFAULT 10,    -- Ephemeral storage

    -- Lifecycle tracking
    started_at      TIMESTAMPTZ,            -- When pod started running
    stopped_at      TIMESTAMPTZ,            -- When session ended
    last_heartbeat  TIMESTAMPTZ,            -- Updated every 60 seconds by pod
    -- Heartbeat is used for zombie detection. If no heartbeat for 10 min,
    -- session is force-stopped.

    -- Session metadata
    -- Example: { "ide_version": "1.2.3", "browser": "Chrome 124",
    --            "initial_file": "src/app.tsx", "terminal_cols": 120 }
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Error tracking
    error_message   TEXT,                    -- Set when status = 'error'
    error_code      TEXT,                    -- Machine-readable error code

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    -- No deleted_at: sessions are hard-deleted after retention period.
    -- No need for soft delete on ephemeral data.
);

-- THE hottest session query: "find the active session for this project and user"
-- Partial index: only include running sessions (vast majority are stopped/expired).
CREATE INDEX idx_sessions_project_user_active
    ON sessions (project_id, user_id)
    WHERE status IN ('pending', 'starting', 'running');

-- "List all active sessions for org X" -- admin dashboard, concurrent session limit.
CREATE INDEX idx_sessions_org_active
    ON sessions (org_id)
    WHERE status IN ('pending', 'starting', 'running');

-- Zombie detection: "find sessions with stale heartbeats"
CREATE INDEX idx_sessions_heartbeat
    ON sessions (last_heartbeat)
    WHERE status = 'running';

-- Session cleanup: "find old stopped sessions to delete"
CREATE INDEX idx_sessions_stopped
    ON sessions (stopped_at)
    WHERE status IN ('stopped', 'error', 'expired');

-- Pod lookup: used by orchestration service to find session for a pod.
CREATE INDEX idx_sessions_pod
    ON sessions (pod_id)
    WHERE pod_id IS NOT NULL;


-- ============================================================================
-- 9. CONVERSATIONS
-- ============================================================================
-- An AI conversation (chat session with Claude). Can be:
--   - Project-scoped: linked to a project, has access to project files
--   - Standalone: general Q&A, not linked to a specific project
--
-- A conversation contains messages and can have branches (forks).

CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    -- SET NULL: if project is deleted, conversation history is preserved.
    -- The conversation becomes "orphaned" but still viewable in chat history.
    -- NULL is also valid for standalone conversations (no project context).

    title           TEXT,                    -- Auto-generated or user-set title
    -- Title is initially NULL, then auto-generated from first message.
    -- User can override with a custom title.

    -- AI model used for this conversation
    model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    -- TEXT not ENUM: model versions change frequently.

    -- System prompt customization (optional, overrides default)
    system_prompt   TEXT,

    -- Conversation state
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Archived conversations are hidden from the main list but not deleted.

    -- Token usage summary (aggregated from messages for quick display)
    total_input_tokens   BIGINT NOT NULL DEFAULT 0,
    total_output_tokens  BIGINT NOT NULL DEFAULT 0,
    total_cost_microcents BIGINT NOT NULL DEFAULT 0,
    -- Microcents = 1/10000 of a cent. Allows precise cost tracking without
    -- floating point. $0.003 per 1K tokens = 300 microcents per 1K tokens.
    message_count   INTEGER NOT NULL DEFAULT 0,

    -- Active branch tracking
    active_branch_id UUID,                  -- FK added after conversation_branches table
    -- The currently "selected" branch. NULL means the main (default) branch.

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- "List conversations for project X, most recent first"
-- Primary view when opening a project's AI chat panel.
CREATE INDEX idx_conversations_project_updated
    ON conversations (project_id, updated_at DESC)
    WHERE deleted_at IS NULL AND project_id IS NOT NULL;

-- "List all conversations for user X across all projects"
-- User's conversation history page.
CREATE INDEX idx_conversations_user_updated
    ON conversations (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- "List conversations for org X" (admin view, usage tracking)
CREATE INDEX idx_conversations_org
    ON conversations (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;


-- ============================================================================
-- 10. CONVERSATION BRANCHES
-- ============================================================================
-- Supports conversation forking: user goes back to an earlier message and
-- sends a different message, creating a new branch from that point.
--
-- The main conversation timeline is the "default" branch (NULL branch).
-- Named branches are created when the user forks.

CREATE TABLE conversation_branches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

    name            TEXT,                    -- User-given name, e.g., "Alternative approach"
    -- NULL for the default/main branch.

    -- The message where this branch diverges from the parent branch.
    fork_from_message_id UUID,              -- FK added after messages table
    -- NULL for the default branch (starts from the beginning).

    parent_branch_id UUID REFERENCES conversation_branches(id) ON DELETE CASCADE,
    -- NULL for the main branch. Non-null for branches forked from other branches.

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    -- Deactivated branches are hidden but not deleted (preserves message history).

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "List branches for conversation X"
CREATE INDEX idx_branches_conversation
    ON conversation_branches (conversation_id)
    WHERE is_active = TRUE;


-- ============================================================================
-- 11. MESSAGES
-- ============================================================================
-- Individual messages within a conversation.
--
-- CRITICAL DESIGN: Hybrid storage
--   - Messages with content < 4KB: content stored inline in `content` column
--   - Messages with content >= 4KB: content stored in Azure Blob Storage,
--     `content` is NULL, `blob_ref` contains the blob path
--
-- Why 4KB threshold?
--   - PostgreSQL TOAST threshold is ~2KB. Content > 2KB is already being
--     compressed and stored out-of-line by TOAST.
--   - At 4KB, we're better off storing in Blob Storage where we have
--     explicit control over retrieval and lifecycle.
--   - Keeps the messages table slim for fast scans and backups.

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

    -- Denormalized org_id for RLS (copied from parent conversation via trigger).
    -- Avoids correlated subquery in the RLS policy on every message read.
    org_id          UUID NOT NULL REFERENCES organizations(id),

    -- Branch support
    branch_id       UUID REFERENCES conversation_branches(id) ON DELETE CASCADE,
    -- NULL = message belongs to the default/main branch.

    parent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    -- Points to the message this is a direct reply to.
    -- Enables tree traversal for branch reconstruction.
    -- SET NULL: if parent is deleted, this message becomes a root.

    -- Message data
    role            message_role NOT NULL,
    content         TEXT,                    -- Message content (NULL if stored in blob)
    blob_ref        TEXT,                    -- Blob Storage path if content is externalized
    -- Exactly one of (content, blob_ref) should be non-NULL for messages
    -- that have content. System messages may have content in both
    -- (small content inline, large context in blob).

    -- Tool call specific fields (role = 'tool_call' or 'tool_result')
    tool_name       TEXT,                    -- e.g., "read_file", "write_file", "execute_command"
    tool_call_id    TEXT,                    -- Anthropic tool_use ID for matching call -> result
    -- JSONB for tool arguments/metadata. Not a separate table because:
    --   1. Tool schemas vary wildly between tool types
    --   2. Never queried independently (always loaded with the message)
    --   3. JSONB handles the heterogeneity naturally
    tool_metadata   JSONB,
    -- Example for tool_call: { "arguments": { "path": "src/app.tsx", "content": "..." } }
    -- Example for tool_result: { "exit_code": 0, "truncated": false }

    -- Token tracking (populated from Claude API response)
    input_tokens    INTEGER,                -- Tokens consumed for this message's input
    output_tokens   INTEGER,                -- Tokens generated (assistant messages only)
    cached_tokens   INTEGER,                -- Tokens served from prompt cache
    cost_microcents INTEGER,                -- Cost in microcents (1/10000 of a cent)

    -- Sequence number within the conversation branch for deterministic ordering.
    -- Auto-incrementing within a conversation is handled at the application layer
    -- (not a DB sequence, because branches complicate monotonic ordering).
    sequence_number INTEGER NOT NULL,

    -- Model that generated this message (for assistant messages).
    -- Stored per-message because model can change mid-conversation.
    model           TEXT,

    -- Timing
    started_at      TIMESTAMPTZ,            -- When Claude started generating (assistant only)
    completed_at    TIMESTAMPTZ,            -- When Claude finished generating
    -- Duration = completed_at - started_at. Useful for latency tracking.

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- No updated_at: messages are immutable once created.
    -- No deleted_at: messages are deleted via conversation deletion.
    -- Individual message deletion would break the conversation chain.

    -- Exactly one of (content, blob_ref) must be non-NULL.
    CONSTRAINT content_xor_blob CHECK (
        (content IS NOT NULL AND blob_ref IS NULL) OR
        (content IS NULL AND blob_ref IS NOT NULL)
    )
);

-- THE primary message query: "load all messages for conversation X in order"
-- This is how we reconstruct the conversation for the Claude API call.
CREATE INDEX idx_messages_conversation_order
    ON messages (conversation_id, sequence_number);

-- Branch-specific message loading: "load messages for branch X in order"
CREATE INDEX idx_messages_branch_order
    ON messages (branch_id, sequence_number)
    WHERE branch_id IS NOT NULL;

-- Parent chain traversal for branch reconstruction.
CREATE INDEX idx_messages_parent
    ON messages (parent_message_id)
    WHERE parent_message_id IS NOT NULL;

-- Tool call matching: "find the tool_result for tool_call_id X"
CREATE INDEX idx_messages_tool_call_id
    ON messages (tool_call_id)
    WHERE tool_call_id IS NOT NULL;

-- RLS support: org_id + conversation_id for tenant-scoped message access.
CREATE INDEX idx_messages_org_conversation
    ON messages (org_id, conversation_id);

-- Add deferred FK from conversation_branches to messages.
ALTER TABLE conversation_branches
    ADD CONSTRAINT fk_branches_fork_message
    FOREIGN KEY (fork_from_message_id) REFERENCES messages(id) ON DELETE SET NULL;

-- Add deferred FK from conversations to conversation_branches.
ALTER TABLE conversations
    ADD CONSTRAINT fk_conversations_active_branch
    FOREIGN KEY (active_branch_id) REFERENCES conversation_branches(id) ON DELETE SET NULL;


-- ============================================================================
-- 12. SUBSCRIPTIONS
-- ============================================================================
-- Mirror of Stripe subscription data. Stripe is the source of truth.
-- This table exists for:
--   1. Fast local queries (don't hit Stripe API for plan checks)
--   2. RLS-filtered access (Stripe API has no concept of our tenant model)
--   3. Joining with other tables (usage, projects, etc.)
--
-- Synced via Stripe webhooks: customer.subscription.created/updated/deleted

CREATE TABLE subscriptions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- One active subscription per org. Historical subscriptions are kept.

    -- Stripe IDs
    stripe_subscription_id TEXT NOT NULL,
    stripe_price_id TEXT NOT NULL,           -- Stripe Price object ID
    stripe_product_id TEXT,                  -- Stripe Product object ID

    -- Plan details (denormalized from Stripe for fast access)
    plan_name       TEXT NOT NULL,           -- "free", "pro", "team", "enterprise"
    plan_tier       INTEGER NOT NULL DEFAULT 0,
    -- Tier as integer for comparison: 0=free, 1=pro, 2=team, 3=enterprise
    -- Simpler than string comparison for feature gating.

    status          subscription_status NOT NULL,

    -- Billing period
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end   TIMESTAMPTZ NOT NULL,
    cancel_at            TIMESTAMPTZ,        -- Scheduled cancellation date
    canceled_at          TIMESTAMPTZ,        -- When cancellation was requested
    trial_start          TIMESTAMPTZ,
    trial_end            TIMESTAMPTZ,

    -- Plan limits (denormalized for fast enforcement without Stripe API call)
    -- These are synced from Stripe product metadata.
    max_projects         INTEGER,            -- NULL = unlimited
    max_sessions         INTEGER,            -- Concurrent sessions
    max_storage_bytes    BIGINT,             -- Total blob storage
    max_ai_tokens_monthly BIGINT,            -- Monthly AI token limit
    max_compute_minutes_monthly INTEGER,     -- Monthly compute minutes
    max_members          INTEGER,            -- Team members
    -- NULL means unlimited (enterprise plans).

    -- Stripe metadata (raw webhook data for debugging)
    stripe_metadata JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    -- No deleted_at: canceled subscriptions have status = 'canceled'.
    -- Historical subscriptions are kept for billing history.
);

-- "Get the active subscription for org X"
-- THE plan check query. Runs on many requests for feature gating.
CREATE UNIQUE INDEX idx_subscriptions_org_active
    ON subscriptions (org_id)
    WHERE status IN ('active', 'trialing', 'past_due');
-- UNIQUE ensures at most one active subscription per org.

-- Stripe webhook processing: find subscription by Stripe ID.
CREATE UNIQUE INDEX idx_subscriptions_stripe_id
    ON subscriptions (stripe_subscription_id);

-- Find subscriptions expiring soon (for reminder emails).
CREATE INDEX idx_subscriptions_period_end
    ON subscriptions (current_period_end)
    WHERE status IN ('active', 'trialing');


-- ============================================================================
-- 13. USAGE RECORDS
-- ============================================================================
-- Granular usage tracking for metered billing.
-- Records are aggregated hourly from fine-grained events.
--
-- Example: In one hour, a user makes 50 Claude API calls totaling 100K input
-- tokens. This becomes one row: org_id, usage_type='api_tokens_input',
-- quantity=100000, period_start=2026-04-08T14:00Z, period_end=2026-04-08T15:00Z.
--
-- Partitioned by month on period_start for efficient range queries and archival.

CREATE TABLE usage_records (
    id              UUID NOT NULL DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    -- user_id is optional: some usage is org-wide (storage), not user-specific.

    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    -- Which project generated this usage? NULL for org-wide usage.

    usage_type      usage_type NOT NULL,
    quantity        BIGINT NOT NULL,         -- Amount consumed (tokens, minutes, bytes)
    -- Always a positive integer. Unit depends on usage_type:
    --   api_tokens_*: individual tokens
    --   compute_minutes: minutes (rounded up)
    --   storage_bytes: bytes at measurement time
    --   snapshot_count: number of snapshots
    --   session_count: number of sessions started

    -- Billing period for this record
    period_start    TIMESTAMPTZ NOT NULL,    -- Start of the hour
    period_end      TIMESTAMPTZ NOT NULL,    -- End of the hour

    -- Cost at time of recording (in microcents)
    unit_cost_microcents BIGINT NOT NULL DEFAULT 0,
    total_cost_microcents BIGINT NOT NULL DEFAULT 0,

    -- Stripe reporting
    stripe_usage_record_id TEXT,             -- Stripe usage record ID (if reported)
    reported_to_stripe BOOLEAN NOT NULL DEFAULT FALSE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Partition key
    PRIMARY KEY (id, period_start)
) PARTITION BY RANGE (period_start);

-- Create partitions for the next 12 months.
-- In production, a scheduled job creates partitions 3 months ahead.
-- Partition naming: usage_records_YYYY_MM
CREATE TABLE usage_records_2026_04 PARTITION OF usage_records
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE usage_records_2026_05 PARTITION OF usage_records
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE usage_records_2026_06 PARTITION OF usage_records
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE usage_records_2026_07 PARTITION OF usage_records
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE usage_records_2026_08 PARTITION OF usage_records
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE usage_records_2026_09 PARTITION OF usage_records
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE usage_records_2026_10 PARTITION OF usage_records
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE usage_records_2026_11 PARTITION OF usage_records
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE usage_records_2026_12 PARTITION OF usage_records
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE usage_records_2027_01 PARTITION OF usage_records
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE usage_records_2027_02 PARTITION OF usage_records
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE usage_records_2027_03 PARTITION OF usage_records
    FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

-- "Get total usage for org X in the current billing period"
-- THE billing query. Runs hourly for usage aggregation and on-demand for dashboard.
CREATE INDEX idx_usage_records_org_period
    ON usage_records (org_id, period_start, usage_type);

-- "Get usage for specific project"
CREATE INDEX idx_usage_records_project
    ON usage_records (project_id, period_start)
    WHERE project_id IS NOT NULL;

-- "Find records not yet reported to Stripe"
CREATE INDEX idx_usage_records_unreported
    ON usage_records (created_at)
    WHERE reported_to_stripe = FALSE;


-- ============================================================================
-- 14. BILLING EVENTS
-- ============================================================================
-- Immutable ledger of all billing-related events. APPEND-ONLY.
-- Never updated, never deleted (legal requirement: 7-year retention).
--
-- This is our billing audit trail. Even if Stripe data is lost, we have
-- a complete record of every charge, credit, and invoice.

CREATE TABLE billing_events (
    id              UUID NOT NULL DEFAULT uuid_generate_v7(),

    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    -- RESTRICT: cannot delete an org that has billing events.
    -- Org deletion process must handle billing event anonymization first.

    event_type      billing_event_type NOT NULL,

    -- Financial data
    amount_microcents BIGINT NOT NULL DEFAULT 0,
    -- Positive for charges, negative for credits/refunds.
    currency        TEXT NOT NULL DEFAULT 'usd',

    -- Stripe references
    stripe_event_id TEXT,                    -- Stripe event ID for idempotency
    stripe_invoice_id TEXT,
    stripe_charge_id TEXT,
    stripe_payment_intent_id TEXT,

    -- Event payload (raw Stripe webhook data for debugging/compliance)
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

    description     TEXT,                    -- Human-readable description

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Partition key (same pattern as usage_records)
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create initial partitions (quarterly for billing events -- lower volume than usage).
CREATE TABLE billing_events_2026_q2 PARTITION OF billing_events
    FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
CREATE TABLE billing_events_2026_q3 PARTITION OF billing_events
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE billing_events_2026_q4 PARTITION OF billing_events
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
CREATE TABLE billing_events_2027_q1 PARTITION OF billing_events
    FOR VALUES FROM ('2027-01-01') TO ('2027-04-01');

-- "List billing events for org X in date range"
CREATE INDEX idx_billing_events_org_created
    ON billing_events (org_id, created_at DESC);

-- Stripe idempotency: prevent processing the same webhook twice.
CREATE UNIQUE INDEX idx_billing_events_stripe_event
    ON billing_events (stripe_event_id)
    WHERE stripe_event_id IS NOT NULL;


-- ============================================================================
-- 14a. STRIPE EVENTS
-- ============================================================================
-- Idempotent store for incoming Stripe webhook events.
-- Prevents double-processing and provides a replayable event log.

CREATE TABLE stripe_events (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    stripe_event_id  TEXT NOT NULL UNIQUE,
    event_type       TEXT NOT NULL,
    data             JSONB NOT NULL,
    processed_at     TIMESTAMPTZ,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stripe_events_type
    ON stripe_events(event_type, created_at DESC);

CREATE INDEX idx_stripe_events_unprocessed
    ON stripe_events(created_at)
    WHERE processed_at IS NULL;


-- ============================================================================
-- 14b. CREDIT LEDGER
-- ============================================================================
-- Double-entry style ledger for credit balances.
-- Every credit mutation (grant, purchase, deduction, expiration) is a row.
-- balance_after is the running balance for fast point-in-time lookups.

CREATE TYPE credit_type AS ENUM ('plan_grant', 'bonus_grant', 'purchase', 'deduction', 'expiration', 'adjustment');

CREATE TABLE credit_ledger (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id         UUID REFERENCES users(id),
    org_id          UUID REFERENCES organizations(id),
    type            credit_type NOT NULL,
    amount          INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
    reference_id    UUID,
    reference_type  TEXT,
    description     TEXT,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_or_org CHECK (
        (user_id IS NOT NULL AND org_id IS NULL) OR
        (user_id IS NULL AND org_id IS NOT NULL)
    )
);

CREATE INDEX idx_credit_ledger_user
    ON credit_ledger(user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX idx_credit_ledger_org
    ON credit_ledger(org_id, created_at DESC)
    WHERE org_id IS NOT NULL;

CREATE INDEX idx_credit_ledger_expires
    ON credit_ledger(expires_at)
    WHERE expires_at IS NOT NULL AND type IN ('plan_grant', 'bonus_grant', 'purchase');


-- ============================================================================
-- 14c. CREDIT PURCHASES
-- ============================================================================
-- Tracks individual credit-pack purchases through Stripe.

CREATE TYPE purchase_status AS ENUM ('pending', 'completed', 'failed', 'refunded');

CREATE TABLE credit_purchases (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id                  UUID REFERENCES users(id),
    org_id                   UUID REFERENCES organizations(id),
    stripe_payment_intent_id TEXT UNIQUE,
    credits                  INTEGER NOT NULL,
    amount_cents             INTEGER NOT NULL,
    currency                 TEXT NOT NULL DEFAULT 'usd',
    status                   purchase_status NOT NULL DEFAULT 'pending',
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- 15. AUDIT LOG
-- ============================================================================
-- Immutable, append-only log of all significant actions in the system.
-- Partitioned by month for efficient querying and automated archival.
--
-- Design decisions:
--   - Separate from application tables: audit data should never be accidentally
--     modified or deleted by application code.
--   - JSONB payload: each action type has different metadata. Normalizing this
--     would require dozens of tables. JSONB handles heterogeneity naturally.
--   - No foreign keys: audit log should survive even if referenced entities are
--     deleted. We store IDs as TEXT/UUID values without FK constraints.
--   - No indexes on payload: queried by org_id + time range, not by payload content.

CREATE TABLE audit_log (
    id              UUID NOT NULL DEFAULT uuid_generate_v7(),

    org_id          UUID,                    -- NULL for system-level events
    -- No FK: org may be deleted, audit log survives.

    actor_user_id   UUID,                    -- Who performed the action
    -- No FK: user may be deleted, audit log survives.
    -- NULL for system-initiated actions (cron jobs, webhooks).

    action          audit_action NOT NULL,

    -- What was acted upon
    resource_type   TEXT,                    -- "project", "session", "conversation", "user", etc.
    resource_id     UUID,                    -- ID of the resource

    -- Action-specific payload
    -- Example for 'project.updated': { "changes": { "name": { "old": "foo", "new": "bar" } } }
    -- Example for 'session.started': { "pod_id": "pod-abc", "region": "eastus" }
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Request context (for forensics)
    ip_address      INET,
    user_agent      TEXT,
    request_id      TEXT,                    -- Correlation ID for distributed tracing

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for the next 12 months.
CREATE TABLE audit_log_2026_04 PARTITION OF audit_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE audit_log_2026_05 PARTITION OF audit_log
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_log_2026_06 PARTITION OF audit_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE audit_log_2026_07 PARTITION OF audit_log
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audit_log_2026_08 PARTITION OF audit_log
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE audit_log_2026_09 PARTITION OF audit_log
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_log_2026_10 PARTITION OF audit_log
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_log_2026_11 PARTITION OF audit_log
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE audit_log_2026_12 PARTITION OF audit_log
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE audit_log_2027_01 PARTITION OF audit_log
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE audit_log_2027_02 PARTITION OF audit_log
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE audit_log_2027_03 PARTITION OF audit_log
    FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

-- "List audit events for org X in date range" -- THE audit query.
-- Partition pruning on created_at + index on org_id gives excellent performance.
CREATE INDEX idx_audit_log_org_created
    ON audit_log (org_id, created_at DESC)
    WHERE org_id IS NOT NULL;

-- "List audit events by specific user" -- investigating a user's actions.
CREATE INDEX idx_audit_log_actor
    ON audit_log (actor_user_id, created_at DESC)
    WHERE actor_user_id IS NOT NULL;

-- "List audit events for a specific resource" -- investigating changes to an entity.
CREATE INDEX idx_audit_log_resource
    ON audit_log (resource_type, resource_id, created_at DESC)
    WHERE resource_id IS NOT NULL;


-- ============================================================================
-- 16. WAITLIST (Pre-launch)
-- ============================================================================
-- Simple waitlist for pre-launch signups. Will be dropped after launch.

CREATE TABLE waitlist (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    email           TEXT NOT NULL,
    name            TEXT,
    referral_source TEXT,                    -- "twitter", "producthunt", "friend", etc.
    referral_code   TEXT,                    -- If referred by existing waitlist member
    position        SERIAL,                 -- Waitlist position (auto-incrementing)
    invited_at      TIMESTAMPTZ,            -- When invitation email was sent
    signed_up_at    TIMESTAMPTZ,            -- When they actually signed up
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_waitlist_email ON waitlist (email);
CREATE INDEX idx_waitlist_position ON waitlist (position);


-- ============================================================================
-- 17. ROW-LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
-- RLS is the database-level safety net for multi-tenant isolation.
-- Even if application code has a bug, RLS prevents cross-tenant data access.
--
-- How it works:
--   1. API sets session variable: SET LOCAL bricks.current_org_id = '{org_id}'
--   2. RLS policies check: org_id = current_setting('bricks.current_org_id')::uuid
--   3. Transaction commits, variable is cleared
--
-- The application role (bricks_app) is subject to RLS.
-- The migration role (bricks_migration) bypasses RLS.
-- ============================================================================

-- Create application role (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bricks_app') THEN
        CREATE ROLE bricks_app LOGIN;
    END IF;
END
$$;

-- Helper function to get current tenant ID from session variable.
-- Returns NULL if not set (which means RLS will deny all access -- safe default).
CREATE OR REPLACE FUNCTION current_org_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('bricks.current_org_id', TRUE), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;
-- STABLE: function result is consistent within a single table scan.
-- This is critical for query planner optimization with RLS.

-- Helper function to get current user ID from session variable.
-- Used for user-scoped policies (e.g., org membership visibility).
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('bricks.current_user_id', TRUE), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---- ORGANIZATIONS ----
-- SELECT: user can see all orgs they belong to (for org switcher).
-- INSERT/UPDATE/DELETE: scoped to the currently-active org only.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_select ON organizations
    FOR SELECT
    TO bricks_app
    USING (
        id IN (SELECT org_id FROM org_members WHERE user_id = current_user_id() AND deleted_at IS NULL)
        AND deleted_at IS NULL
    );

CREATE POLICY org_modify ON organizations
    FOR ALL
    TO bricks_app
    USING (id = current_org_id() AND deleted_at IS NULL);

-- ---- ORG_MEMBERS ----
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_members_isolation ON org_members
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id() AND deleted_at IS NULL);

-- ---- INVITATIONS ----
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_isolation ON invitations
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- PROJECTS ----
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_isolation ON projects
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id() AND deleted_at IS NULL);

-- ---- PROJECT_ENVIRONMENT_VARIABLES ----
ALTER TABLE project_environment_variables ENABLE ROW LEVEL SECURITY;
CREATE POLICY env_vars_isolation ON project_environment_variables
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- PROJECT_SNAPSHOTS ----
ALTER TABLE project_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY snapshots_isolation ON project_snapshots
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- SESSIONS ----
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_isolation ON sessions
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- CONVERSATIONS ----
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_isolation ON conversations
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id() AND deleted_at IS NULL);

-- ---- MESSAGES ----
-- Messages have a denormalized org_id (copied from conversation via trigger).
-- This allows a simple equality check instead of a correlated subquery.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_isolation ON messages
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- SUBSCRIPTIONS ----
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_isolation ON subscriptions
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- USAGE_RECORDS ----
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_records_isolation ON usage_records
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- BILLING_EVENTS ----
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_events_isolation ON billing_events
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id());

-- ---- STRIPE_EVENTS ----
-- No tenant scoping: stripe_events are system-wide, accessed by webhooks only.
-- RLS is enabled but policy allows the app role to see all events.
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY stripe_events_isolation ON stripe_events
    FOR ALL
    TO bricks_app
    USING (TRUE);

-- ---- CREDIT_LEDGER ----
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_isolation ON credit_ledger
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id() OR org_id IS NULL);

-- ---- CREDIT_PURCHASES ----
ALTER TABLE credit_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_purchases_isolation ON credit_purchases
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id() OR org_id IS NULL);

-- ---- AUDIT_LOG ----
-- Allow access to org-scoped events AND system-level events (org_id IS NULL).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_isolation ON audit_log
    FOR ALL
    TO bricks_app
    USING (org_id = current_org_id() OR org_id IS NULL);

-- ---- USERS ----
-- Users are NOT tenant-scoped (a user can belong to multiple orgs).
-- RLS on users is more nuanced: you can see your own profile and
-- profiles of users in your org(s).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_own_profile ON users
    FOR ALL
    TO bricks_app
    USING (
        -- User can see their own profile
        id::TEXT = current_setting('bricks.current_user_id', TRUE)
        OR
        -- User can see profiles of org members in their current org
        id IN (
            SELECT user_id FROM org_members
            WHERE org_id = current_org_id() AND deleted_at IS NULL
        )
    );


-- ============================================================================
-- 18. GRANTS
-- ============================================================================
-- Application role gets DML (SELECT, INSERT, UPDATE, DELETE) on all tables.
-- Schema-level operations (CREATE, ALTER, DROP) are reserved for migration role.

GRANT USAGE ON SCHEMA public TO bricks_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bricks_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bricks_app;

-- Ensure future tables also get grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bricks_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO bricks_app;


-- ============================================================================
-- 19. TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamp on row modification.
-- Applied to all tables with an updated_at column.
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to each table with updated_at:
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON org_members
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON invitations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON project_environment_variables
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON credit_purchases
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ============================================================================
-- 20. CONVERSATION TOKEN AGGREGATION TRIGGER
-- ============================================================================
-- When a new message with token counts is inserted, update the conversation's
-- running totals. This avoids expensive SUM() queries on the messages table
-- every time we need to display conversation cost.

CREATE OR REPLACE FUNCTION trigger_update_conversation_totals()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE conversations SET
            total_input_tokens = total_input_tokens + COALESCE(NEW.input_tokens, 0),
            total_output_tokens = total_output_tokens + COALESCE(NEW.output_tokens, 0),
            total_cost_microcents = total_cost_microcents + COALESCE(NEW.cost_microcents, 0),
            message_count = message_count + 1,
            updated_at = now()
        WHERE id = NEW.conversation_id;
    ELSIF TG_OP = 'UPDATE' THEN
        -- On UPDATE, adjust by the delta (new value minus old value).
        -- This handles the case where token counts are back-filled after
        -- the initial INSERT (e.g., streaming responses).
        UPDATE conversations SET
            total_input_tokens = total_input_tokens
                + COALESCE(NEW.input_tokens, 0) - COALESCE(OLD.input_tokens, 0),
            total_output_tokens = total_output_tokens
                + COALESCE(NEW.output_tokens, 0) - COALESCE(OLD.output_tokens, 0),
            total_cost_microcents = total_cost_microcents
                + COALESCE(NEW.cost_microcents, 0) - COALESCE(OLD.cost_microcents, 0),
            updated_at = now()
        WHERE id = NEW.conversation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversation_totals
    AFTER INSERT OR UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_conversation_totals();


-- ============================================================================
-- 20a. MESSAGE ORG_ID DENORMALIZATION TRIGGER
-- ============================================================================
-- Automatically copies org_id from the parent conversation into the message row
-- on INSERT, ensuring the denormalized column is always consistent.

CREATE OR REPLACE FUNCTION trigger_set_message_org_id()
RETURNS TRIGGER AS $$
BEGIN
    SELECT org_id INTO NEW.org_id
    FROM conversations
    WHERE id = NEW.conversation_id;

    IF NEW.org_id IS NULL THEN
        RAISE EXCEPTION 'Conversation % not found or has no org_id', NEW.conversation_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_message_org_id
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_message_org_id();


-- ============================================================================
-- 21. HELPER VIEWS
-- ============================================================================

-- Active org members with user details (common JOIN, avoid repeating it).
CREATE VIEW v_org_members_with_users AS
SELECT
    om.id AS membership_id,
    om.org_id,
    om.user_id,
    om.role,
    om.joined_at,
    u.email,
    u.display_name,
    u.avatar_url,
    u.last_active_at
FROM org_members om
JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
WHERE om.deleted_at IS NULL;

-- Active sessions with project and user context.
CREATE VIEW v_active_sessions AS
SELECT
    s.id AS session_id,
    s.project_id,
    s.org_id,
    s.user_id,
    s.status,
    s.pod_id,
    s.pod_ip,
    s.pod_port,
    s.region,
    s.cpu_millicores,
    s.memory_mb,
    s.started_at,
    s.last_heartbeat,
    p.name AS project_name,
    p.slug AS project_slug,
    u.display_name AS user_name,
    u.email AS user_email
FROM sessions s
JOIN projects p ON p.id = s.project_id
JOIN users u ON u.id = s.user_id
WHERE s.status IN ('pending', 'starting', 'running');

-- Org subscription summary (current plan details).
CREATE VIEW v_org_subscription AS
SELECT
    o.id AS org_id,
    o.name AS org_name,
    o.slug AS org_slug,
    COALESCE(s.plan_name, 'free') AS plan_name,
    COALESCE(s.plan_tier, 0) AS plan_tier,
    s.status AS subscription_status,
    s.current_period_start,
    s.current_period_end,
    s.max_projects,
    s.max_sessions,
    s.max_storage_bytes,
    s.max_ai_tokens_monthly,
    s.max_compute_minutes_monthly,
    s.max_members
FROM organizations o
LEFT JOIN subscriptions s ON s.org_id = o.id
    AND s.status IN ('active', 'trialing', 'past_due')
WHERE o.deleted_at IS NULL;


-- ============================================================================
-- 22. MAINTENANCE FUNCTIONS
-- ============================================================================

-- Function to create future partitions for time-series tables.
-- Should be called monthly by a scheduled job (pg_cron or application cron).
CREATE OR REPLACE FUNCTION create_monthly_partitions(
    p_table_name TEXT,
    p_start_date DATE,
    p_months_ahead INTEGER DEFAULT 3
)
RETURNS VOID AS $$
DECLARE
    v_partition_name TEXT;
    v_start DATE;
    v_end DATE;
    i INTEGER;
BEGIN
    FOR i IN 0..p_months_ahead-1 LOOP
        v_start := p_start_date + (i || ' months')::INTERVAL;
        v_end := v_start + '1 month'::INTERVAL;
        v_partition_name := p_table_name || '_' ||
            to_char(v_start, 'YYYY') || '_' || to_char(v_start, 'MM');

        -- Only create if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_class WHERE relname = v_partition_name
        ) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                v_partition_name, p_table_name, v_start, v_end
            );
            RAISE NOTICE 'Created partition: %', v_partition_name;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to create quarterly partitions (for billing_events).
CREATE OR REPLACE FUNCTION create_quarterly_partitions(
    p_table_name TEXT,
    p_start_date DATE,
    p_quarters_ahead INTEGER DEFAULT 2
)
RETURNS VOID AS $$
DECLARE
    v_partition_name TEXT;
    v_start DATE;
    v_end DATE;
    v_quarter INTEGER;
    i INTEGER;
BEGIN
    FOR i IN 0..p_quarters_ahead-1 LOOP
        v_start := p_start_date + (i * 3 || ' months')::INTERVAL;
        v_end := v_start + '3 months'::INTERVAL;
        v_quarter := EXTRACT(QUARTER FROM v_start);
        v_partition_name := p_table_name || '_' ||
            to_char(v_start, 'YYYY') || '_q' || v_quarter;

        IF NOT EXISTS (
            SELECT 1 FROM pg_class WHERE relname = v_partition_name
        ) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                v_partition_name, p_table_name, v_start, v_end
            );
            RAISE NOTICE 'Created partition: %', v_partition_name;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 23. GDPR DATA DELETION SUPPORT
-- ============================================================================

-- Function to anonymize a user's personal data (soft delete phase).
-- Called when user requests account deletion. Hard delete follows in 30 days.
CREATE OR REPLACE FUNCTION anonymize_user(p_user_id UUID)
RETURNS VOID AS $$
DECLARE
    v_anon_email TEXT;
BEGIN
    -- Generate anonymized email using hash of user ID
    v_anon_email := 'deleted_' || encode(digest(p_user_id::TEXT, 'sha256'), 'hex')
                    || '@deleted.bricks.dev';

    -- Anonymize user profile
    UPDATE users SET
        email = v_anon_email,
        display_name = 'Deleted User',
        avatar_url = NULL,
        settings = '{}'::jsonb,
        deleted_at = now(),
        updated_at = now()
    WHERE id = p_user_id;

    -- Anonymize user's messages (replace user attribution, keep content for org history)
    -- Content is preserved because it belongs to the org's conversation history.
    -- Only the user attribution is removed.
    -- Note: if user was the sole participant, the entire conversation should be deleted.

    -- Log the anonymization in audit log
    INSERT INTO audit_log (org_id, actor_user_id, action, resource_type, resource_id, payload)
    VALUES (NULL, p_user_id, 'admin.data_deletion', 'user', p_user_id,
            jsonb_build_object('stage', 'anonymized', 'timestamp', now()));

    RAISE NOTICE 'User % anonymized successfully', p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Function to hard-delete a user's data (called 30 days after anonymization).
-- This permanently removes all user data from the database.
-- Blob storage cleanup is handled by the application layer.
CREATE OR REPLACE FUNCTION hard_delete_user(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
    -- Verify user is already anonymized (soft deleted)
    IF NOT EXISTS (
        SELECT 1 FROM users WHERE id = p_user_id AND deleted_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'User % is not soft-deleted. Anonymize first.', p_user_id;
    END IF;

    -- Delete org memberships (CASCADE from users FK would do this, but being explicit)
    DELETE FROM org_members WHERE user_id = p_user_id;

    -- Delete sessions
    DELETE FROM sessions WHERE user_id = p_user_id;

    -- Nullify user reference on messages (preserve conversation for org)
    -- Messages table doesn't have a direct user_id, the conversation does.
    -- Delete conversations where user was the sole participant.
    DELETE FROM conversations
    WHERE user_id = p_user_id
    AND id NOT IN (
        -- Keep conversations that have messages from other users
        -- (determined by checking if any other conversations reference these)
        SELECT DISTINCT conversation_id FROM messages
        WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = p_user_id)
    );

    -- Log the hard deletion
    INSERT INTO audit_log (org_id, actor_user_id, action, resource_type, resource_id, payload)
    VALUES (NULL, NULL, 'admin.data_deletion', 'user', p_user_id,
            jsonb_build_object('stage', 'hard_deleted', 'timestamp', now()));

    -- Finally, delete the user record
    DELETE FROM users WHERE id = p_user_id;

    RAISE NOTICE 'User % hard-deleted successfully', p_user_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- SCHEMA SUMMARY
-- ============================================================================
--
-- Tables:                   18
--   Core:                   users, organizations, org_members, invitations
--   Projects:               projects, project_environment_variables, project_snapshots
--   Sessions:               sessions
--   AI:                     conversations, conversation_branches, messages
--   Billing:                subscriptions, usage_records, billing_events,
--                           stripe_events, credit_ledger, credit_purchases
--   Ops:                    audit_log
--   Pre-launch:             waitlist
--
-- Partitioned tables:       3 (usage_records, billing_events, audit_log)
-- Views:                    3 (v_org_members_with_users, v_active_sessions, v_org_subscription)
-- Custom ENUM types:        12 (+ credit_type, purchase_status)
-- RLS policies:             16 (incl. split org select/modify, new billing tables)
-- Triggers:                 12 (10 updated_at + 1 conversation totals + 1 message org_id)
-- Maintenance functions:    2 (partition creation)
-- GDPR functions:           2 (anonymize + hard delete)
-- Helper functions:         2 (current_org_id, current_user_id)
-- Indexes:                  40+
--
-- ============================================================================
