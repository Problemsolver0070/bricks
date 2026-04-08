# Bricks -- Frontend Architecture

> Version 1.0 | 2026-04-08 | Production-Ready Specification
>
> Built with: Next.js 16.2, Monaco Editor, xterm.js, Tailwind CSS, shadcn/ui, Zustand v5, React Query

---

## Table of Contents

1. [Application Structure & Routing](#1-application-structure--routing)
2. [Workspace Layout -- IDE Mode](#2-workspace-layout--ide-mode)
3. [Workspace Layout -- Builder Mode](#3-workspace-layout--builder-mode)
4. [State Management Architecture](#4-state-management-architecture)
5. [Monaco Editor Integration](#5-monaco-editor-integration)
6. [Terminal Integration](#6-terminal-integration)
7. [AI Chat Panel](#7-ai-chat-panel)
8. [App Preview Panel](#8-app-preview-panel)
9. [Performance Strategy](#9-performance-strategy)
10. [Offline & Degraded Experience](#10-offline--degraded-experience)
11. [Theming System](#11-theming-system)
12. [Keyboard Shortcuts](#12-keyboard-shortcuts)
13. [Onboarding Experience](#13-onboarding-experience)
14. [Component Tree Reference](#14-component-tree-reference)
15. [Key Technical Decisions Summary](#15-key-technical-decisions-summary)

---

## 1. Application Structure & Routing

### 1.1 Route Map

```
/                                 -- Landing page (SSR, public)
/pricing                          -- Pricing page (SSR, public)
/blog                             -- Blog listing (SSR, ISR, public)
/blog/[slug]                      -- Blog post (SSR, ISR, public)
/docs                             -- Documentation (SSR, ISR, public)
/docs/[...slug]                   -- Doc page (SSR, ISR, public)
/changelog                        -- Changelog (SSR, ISR, public)

/sign-in                          -- Clerk sign-in (CSR, public)
/sign-up                          -- Clerk sign-up (CSR, public)
/sign-in/sso-callback             -- SSO callback (CSR, public)

/dashboard                        -- Project dashboard (CSR, protected)
/dashboard/templates              -- Template gallery (SSR+CSR, protected)
/dashboard/settings               -- User settings (CSR, protected)
/dashboard/settings/profile       -- Profile settings
/dashboard/settings/appearance    -- Theme, editor preferences
/dashboard/settings/keys          -- API key management
/dashboard/billing                -- Billing & usage (CSR, protected)
/dashboard/billing/plans          -- Plan selection
/dashboard/billing/invoices       -- Invoice history

/team                             -- Team management (CSR, protected)
/team/[teamId]                    -- Team overview
/team/[teamId]/members            -- Member management
/team/[teamId]/settings           -- Team settings
/team/[teamId]/billing            -- Team billing

/w/[projectId]                    -- Workspace (CSR, protected, heavy)
/w/[projectId]/ide                -- IDE Mode workspace
/w/[projectId]/builder            -- Builder Mode workspace
/w/[projectId]/settings           -- Project settings

/admin                            -- Admin panel (CSR, protected, role-gated)
/admin/users                      -- User management
/admin/projects                   -- Project management
/admin/analytics                  -- Platform analytics
/admin/system                     -- System health

/api/...                          -- API routes (server, not rendered)
```

### 1.2 Layout Hierarchy

```
app/
  layout.tsx                      -- Root layout: providers, fonts, analytics
  (marketing)/
    layout.tsx                    -- Marketing shell: navbar, footer
    page.tsx                      -- Landing page
    pricing/page.tsx
    blog/...
    docs/...
    changelog/page.tsx
  (auth)/
    layout.tsx                    -- Centered card layout, no navbar
    sign-in/[[...sign-in]]/page.tsx
    sign-up/[[...sign-up]]/page.tsx
  (app)/
    layout.tsx                    -- App shell: sidebar nav, auth guard
    dashboard/
      layout.tsx                  -- Dashboard layout: project list sidebar
      page.tsx                    -- Project grid/list
      templates/page.tsx
      settings/
        layout.tsx                -- Settings tabs layout
        profile/page.tsx
        appearance/page.tsx
        keys/page.tsx
      billing/
        layout.tsx
        plans/page.tsx
        invoices/page.tsx
    team/
      [teamId]/
        layout.tsx                -- Team layout: team sidebar
        page.tsx
        members/page.tsx
        settings/page.tsx
        billing/page.tsx
  (workspace)/
    layout.tsx                    -- Minimal chrome: no sidebar, no footer
    w/[projectId]/
      layout.tsx                  -- Workspace shell: connection manager, providers
      ide/page.tsx                -- IDE Mode (full panel workspace)
      builder/page.tsx            -- Builder Mode (chat-driven)
      settings/page.tsx           -- Project settings modal/page
  (admin)/
    layout.tsx                    -- Admin layout: admin sidebar
    admin/
      page.tsx
      users/page.tsx
      projects/page.tsx
      analytics/page.tsx
      system/page.tsx
```

### 1.3 Rendering Strategy

| Route Group | Rendering | Rationale |
|---|---|---|
| Marketing (`/`, `/pricing`, `/blog`, `/docs`) | SSR + ISR (revalidate 3600s) | SEO-critical, cacheable, rarely changes |
| Auth (`/sign-in`, `/sign-up`) | CSR | Clerk handles rendering, no SEO value |
| Dashboard (`/dashboard/*`) | CSR with server components for data fetching | Dynamic per-user content, React Query hydration |
| Workspace (`/w/*`) | CSR only | Extremely interactive, no SSR benefit, heavy client libs |
| Admin (`/admin/*`) | CSR, role-gated | Internal only, no SEO, real-time data |

### 1.4 Route Protection

```typescript
// middleware.ts -- Clerk middleware at the edge
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/pricing',
  '/blog(.*)',
  '/docs(.*)',
  '/changelog',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
]);

const isAdminRoute = createRouteMatcher(['/admin(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isAdminRoute(req)) {
    const { sessionClaims } = await auth();
    if (sessionClaims?.metadata?.role !== 'admin') {
      return new Response('Forbidden', { status: 403 });
    }
  }
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});
```

### 1.5 API Routes

```
app/api/
  webhooks/
    clerk/route.ts               -- Clerk webhook (user events)
    stripe/route.ts              -- Stripe webhook (billing events)
  projects/
    route.ts                     -- GET (list), POST (create)
    [projectId]/
      route.ts                   -- GET, PATCH, DELETE
      sandbox/route.ts           -- POST (provision), DELETE (teardown)
  ai/
    chat/route.ts                -- POST (streaming AI response)
    apply/route.ts               -- POST (apply AI-suggested changes)
  templates/
    route.ts                     -- GET (list templates)
  teams/
    route.ts                     -- GET, POST
    [teamId]/
      members/route.ts           -- GET, POST, DELETE
  admin/
    users/route.ts
    analytics/route.ts
```

---

## 2. Workspace Layout -- IDE Mode

### 2.1 Panel Architecture

The IDE workspace uses a nested `react-resizable-panels` layout to achieve a VS Code-like experience. All panels are resizable, collapsible, and their positions are persisted.

```
+------------------------------------------------------------------+
| Toolbar (fixed height: 40px)                                      |
|  [Mode Toggle] [Project Name] [Branch] [Run] [Deploy] [Share]    |
+--------+-----------------------------------------+----------------+
|        |                                         |                |
| Left   |  Center Area                            | Right          |
| Side-  |  +-----------------------------------+  | Side-          |
| bar    |  | Tab Bar (open files)               |  | bar            |
| (48px  |  +-----------------------------------+  | (collapsible)  |
| icons) |  |                                   |  |                |
|        |  | Monaco Editor                     |  | AI Chat        |
| [Files]|  | (active file)                     |  | Panel          |
| [Srch] |  |                                   |  |                |
| [Git]  |  |                                   |  | OR             |
| [Ext]  |  |                                   |  |                |
| [AI]   |  |                                   |  | Preview        |
|        |  +-----------------------------------+  | Panel          |
|        |  | Bottom Panel (collapsible)        |  |                |
|        |  | [Terminal] [Problems] [Output]     |  |                |
|        |  |                                   |  |                |
|        |  +-----------------------------------+  |                |
+--------+-----------------------------------------+----------------+
| Status Bar (fixed height: 24px)                                   |
|  [Branch] [Errors] [Warnings] [Ln:Col] [Language] [Connection]    |
+------------------------------------------------------------------+
```

### 2.2 Panel Definitions

| Panel | Default Size | Min Size | Collapsible | Collapse To |
|---|---|---|---|---|
| Activity Bar (left icons) | 48px fixed | -- | No | -- |
| Primary Sidebar (file explorer etc.) | 20% | 160px equiv | Yes | Activity bar icon |
| Editor Area | Fills remaining | 30% | No | -- |
| Right Sidebar (AI/Preview) | 25% | 240px equiv | Yes | Toolbar icon |
| Bottom Panel (terminal/problems) | 25% of center | 100px equiv | Yes | Status bar icon |

Note: react-resizable-panels uses percentage-based sizing. The "px equiv" values above are approximate and enforced as percentage minimums calculated on mount.

### 2.3 Panel Nesting Structure

```tsx
// Outer horizontal group: [ActivityBar] [PrimarySidebar] [CenterAndBottom] [RightSidebar]
<ResizablePanelGroup direction="horizontal" autoSaveId="workspace-main">
  <ActivityBar />  {/* Fixed 48px, not a resizable panel */}
  
  <ResizablePanel defaultSize={20} minSize={10} collapsible collapsedSize={0}>
    <PrimarySidebar activeView={sidebarView} />
  </ResizablePanel>
  <ResizableHandle withHandle />
  
  {/* Center: vertical split between editor and bottom panel */}
  <ResizablePanel defaultSize={55} minSize={30}>
    <ResizablePanelGroup direction="vertical" autoSaveId="workspace-center">
      <ResizablePanel defaultSize={70} minSize={30}>
        <EditorArea />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={30} minSize={10} collapsible collapsedSize={0}>
        <BottomPanel activeTab={bottomTab} />
      </ResizablePanel>
    </ResizablePanelGroup>
  </ResizablePanel>
  <ResizableHandle withHandle />
  
  <ResizablePanel defaultSize={25} minSize={15} collapsible collapsedSize={0}>
    <RightSidebar activeView={rightView} />
  </ResizablePanel>
</ResizablePanelGroup>
```

### 2.4 Layout Persistence

```typescript
// Layout persistence strategy:
// 1. react-resizable-panels autoSaveId -> localStorage (panel sizes)
// 2. Zustand persist middleware -> localStorage (which panels are open, active views)
// 3. Server sync on blur/close -> API (cross-device persistence)

interface WorkspaceLayoutState {
  // Panel visibility
  primarySidebarOpen: boolean;
  primarySidebarView: 'files' | 'search' | 'git' | 'extensions';
  rightSidebarOpen: boolean;
  rightSidebarView: 'ai-chat' | 'preview' | 'outline';
  bottomPanelOpen: boolean;
  bottomPanelTab: 'terminal' | 'problems' | 'output' | 'debug';
  
  // Actions
  togglePrimarySidebar: () => void;
  setPrimarySidebarView: (view: string) => void;
  toggleRightSidebar: () => void;
  setRightSidebarView: (view: string) => void;
  toggleBottomPanel: () => void;
  setBottomPanelTab: (tab: string) => void;
}
```

### 2.5 Primary Sidebar Views

| View | Icon | Contents |
|---|---|---|
| **File Explorer** | Files icon | Tree view of project files. Context menu (new file, rename, delete, copy path). Drag-and-drop reorder. File icons by extension (via `material-icon-theme` or `seti-ui` mapping). Inline rename. |
| **Search** | Magnifying glass | Search across files (regex, case-sensitive, whole word). Search and replace. File/folder include/exclude filters. Results grouped by file with line previews. |
| **Git** | Branch icon | Changed files list (staged/unstaged). Inline diff preview. Commit message input. Branch selector dropdown. Push/pull/sync. Merge conflict markers. |
| **Extensions** | Puzzle icon | Installed extensions list. Marketplace search. Extension settings. (Phase 2 feature) |

### 2.6 Responsive Design

The full IDE layout targets screens 1024px and wider. Below that:

| Breakpoint | Behavior |
|---|---|
| >= 1440px | Full layout, all panels can be open simultaneously |
| 1024-1439px | Right sidebar defaults to overlay mode (slides over editor) |
| 768-1023px | Primary sidebar becomes overlay. Bottom panel becomes overlay. Single panel visible at a time with tab switching |
| < 768px | Builder Mode only. Full-width stacked layout. Preview and Code views as fullscreen overlays. IDE Mode is not available. |

For tablet users who insist on IDE Mode, use a simplified two-panel layout: editor + one sidebar (switchable).

---

## 3. Workspace Layout -- Builder Mode

### 3.1 Philosophy

Builder Mode is for users who describe what they want in natural language and watch the AI build it. The code exists but is secondary. The experience is **chat-first, preview-prominent**.

### 3.2 Layout

```
+------------------------------------------------------------------+
| Toolbar (fixed height: 48px)                                      |
|  [Bricks Logo] [Project Name] [<> View Code] [Deploy] [Share]    |
+---------------------------+--------------------------------------+
|                           |                                      |
| AI Conversation           | Live Preview                         |
| (40% width)               | (60% width)                          |
|                           |                                      |
| +-------------------------+ | +----------------------------------+ |
| | Conversation History    | | | Device Frame Selector            | |
| | (collapsible sidebar)   | | | [Mobile] [Tablet] [Desktop]      | |
| +-------------------------+ | +----------------------------------+ |
| |                         | | |                                  | |
| | [AI Message]            | | |                                  | |
| | "I've created a         | | |    Live iframe preview           | |
| |  landing page with..."  | | |    of the running app            | |
| |                         | | |                                  | |
| | [User Message]          | | |                                  | |
| | "Add a hero section     | | |                                  | |
| |  with a gradient..."    | | |                                  | |
| |                         | | |                                  | |
| | [AI Working...]         | | |                                  | |
| | > Creating hero.tsx     | | |                                  | |
| | > Installing deps...    | | |                                  | |
| | > Running dev server    | | |                                  | |
| |                         | | |                                  | |
| +-------------------------+ | +----------------------------------+ |
| |                         | | | Console (collapsible, 20%)       | |
| | [Message Input]         | | | Errors shown in plain language   | |
| | [Attach] [Voice?]       | | |                                  | |
| +-------------------------+ | +----------------------------------+ |
+---------------------------+--------------------------------------+
```

### 3.3 Builder Mode Interactions

**How the user interacts with code they do not understand:**

1. **They do not see code by default.** The chat + preview is the entire experience.
2. **"View Code" button** in the toolbar opens a read-only code viewer (simplified Monaco, no LSP) as an overlay. This is for curious users, not required.
3. **AI explains changes in plain language**: Instead of showing diffs, the AI says "I added a hero section with a gradient background and a call-to-action button."
4. **Error translation**: Build errors are caught and re-interpreted by the AI. Instead of `TypeError: Cannot read properties of undefined (reading 'map')`, the user sees: "There's an issue with the data loading. I'm fixing it now..." followed by the AI auto-fixing.
5. **Progress indicators**:
   - Animated steps: "Creating files..." -> "Installing packages..." -> "Starting app..." -> "Ready!"
   - Each step has a spinner that becomes a checkmark.
   - File changes shown as a collapsible list: "Modified 3 files" (expandable to see filenames, not code).

### 3.4 Builder Mode Undo

Filesystem snapshot is taken before every AI turn. An "Undo last turn" button is always visible in Builder Mode, allowing the user to revert the entire set of file changes from the AI's last action. Snapshots are stored as lightweight diffs in memory (last 10 turns) and in the sandbox's persistent storage (full history). This is critical for non-technical users who cannot manually revert file changes.

### 3.5 Builder Mode Components

```
<BuilderWorkspace>
  <BuilderToolbar />
  <ResizablePanelGroup direction="horizontal">
    <ResizablePanel defaultSize={40}>
      <BuilderChat>
        <ConversationHistory />        -- Sidebar of past conversations
        <MessageList>
          <AIMessage />                -- Markdown rendered, no raw code
          <UserMessage />
          <AIWorkingIndicator />       -- Step-by-step progress
          <ErrorExplanation />         -- Plain language error
        </MessageList>
        <BuilderInput>
          <TextArea />
          <AttachButton />             -- Upload images/screenshots
          <TemplateChips />            -- Quick action suggestions
        </BuilderInput>
      </BuilderChat>
    </ResizablePanel>
    <ResizableHandle />
    <ResizablePanel defaultSize={60}>
      <PreviewPanel>
        <DeviceFrameSelector />
        <PreviewIframe />
        <BuilderConsole />             -- Simplified, auto-hides when no errors
      </PreviewPanel>
    </ResizablePanel>
  </ResizablePanelGroup>
</BuilderWorkspace>
```

### 3.6 Builder to IDE Mode Transition

Users can switch modes at any time via the toolbar toggle. When switching:
- Builder -> IDE: The full IDE layout loads. All files are visible. The AI chat moves to the right sidebar. No data is lost.
- IDE -> Builder: The preview and chat take over. Editor panels collapse. The user is warned if they have unsaved changes.

The mode preference is stored per-project in the project settings.

---

## 4. State Management Architecture

### 4.1 State Classification

```
+-------------------------------------------------------------------+
|                    State Classification                             |
+-------------------------------------------------------------------+
|                                                                     |
|  URL State (searchParams, pathname)                                 |
|    - Current project ID (/w/[projectId])                           |
|    - Current mode (ide/builder)                                     |
|    - Deep links (file path, line number)                           |
|                                                                     |
|  Server State (React Query / TanStack Query)                       |
|    - Project list, project metadata                                |
|    - Team data, billing data                                       |
|    - Template catalog                                              |
|    - User profile, preferences (server-synced)                     |
|    - Git status, branches, commit history                          |
|                                                                     |
|  Client State (Zustand stores -- sliced)                           |
|    - Editor state (open tabs, active file, cursor positions)       |
|    - Terminal state (instances, active terminal)                    |
|    - AI state (conversations, streaming, tool execution)           |
|    - UI/Layout state (panel sizes, active views, theme)            |
|    - Session state (WebSocket connection, sandbox info)            |
|    - File tree state (expanded nodes, selection)                   |
|                                                                     |
|  Ephemeral State (React local state / refs)                        |
|    - Hover tooltips                                                |
|    - Dropdown open/close                                           |
|    - Drag-and-drop tracking                                        |
|    - Input field values before submission                          |
|    - Animation state                                               |
|                                                                     |
|  Derived State (Computed from above, never stored)                 |
|    - "Has unsaved changes" (derived from dirty flags)              |
|    - "Can deploy" (derived from build status + git status)         |
|    - Problem count (derived from diagnostics)                      |
|                                                                     |
+-------------------------------------------------------------------+
```

### 4.2 Zustand Store Architecture (Slice Pattern)

Each domain gets its own Zustand store. They do NOT share a single monolithic store. Cross-store communication happens through subscriptions or explicit calls.

```typescript
// stores/editor-store.ts
interface EditorTab {
  fileId: string;
  filePath: string;
  language: string;
  isDirty: boolean;
  viewState: monaco.editor.ICodeEditorViewState | null; // cursor, scroll, selections
}

interface EditorStore {
  // State
  tabs: EditorTab[];
  activeTabId: string | null;
  tabOrder: string[];            // Allows reordering
  diffMode: boolean;
  diffOriginal: string | null;   // For AI-suggested changes
  diffModified: string | null;
  
  // Actions
  openFile: (filePath: string, content: string) => void;
  closeTab: (fileId: string) => void;
  closeOtherTabs: (fileId: string) => void;
  closeTabsToRight: (fileId: string) => void;
  setActiveTab: (fileId: string) => void;
  markDirty: (fileId: string) => void;
  markClean: (fileId: string) => void;
  updateViewState: (fileId: string, viewState: any) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  enterDiffMode: (original: string, modified: string) => void;
  exitDiffMode: () => void;
}

export const useEditorStore = create<EditorStore>()(
  persist(
    devtools(
      (set, get) => ({
        // ... implementation
      }),
      { name: 'editor-store' }
    ),
    {
      name: 'bricks-editor',
      partialize: (state) => ({
        // Only persist tab metadata (path, cursor position), NOT file contents or view states
        tabs: state.tabs.map(t => ({ fileId: t.fileId, filePath: t.filePath, language: t.language })),
        tabOrder: state.tabOrder,
        activeTabId: state.activeTabId,
      }),
    }
  )
);
```

```typescript
// stores/terminal-store.ts
interface TerminalInstance {
  id: string;
  name: string;                    // "bash", "node", custom name
  shellType: 'bash' | 'zsh' | 'sh';
  isConnected: boolean;
  // NOTE: Scroll history lives in the xterm.js instance, NOT in Zustand.
  // We only track metadata here.
}

interface TerminalStore {
  instances: TerminalInstance[];
  activeInstanceId: string | null;
  splitDirection: 'horizontal' | 'vertical' | null;
  
  createTerminal: (name?: string) => string; // returns id
  closeTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  renameTerminal: (id: string, name: string) => void;
  setConnectionStatus: (id: string, connected: boolean) => void;
}
```

```typescript
// stores/ai-store.ts
interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;                 // Markdown
  timestamp: number;
  toolCalls?: ToolCall[];          // File edits, terminal commands, etc.
  status: 'complete' | 'streaming' | 'error';
  parentId?: string;               // For conversation branching
}

interface ToolCall {
  id: string;
  type: 'file_edit' | 'terminal_command' | 'file_create' | 'file_delete' | 'search';
  description: string;             // "Editing src/components/Hero.tsx"
  status: 'pending' | 'running' | 'complete' | 'error';
  result?: string;
  diff?: { original: string; modified: string; filePath: string };
  accepted?: boolean;              // User accepted/rejected the change
}

interface AIStore {
  conversations: Record<string, AIMessage[]>; // projectId -> messages (Record for JSON serialization)
  activeConversationId: string | null;
  isStreaming: boolean;
  streamingContent: string;        // Partial content during streaming
  activeToolCalls: ToolCall[];     // Currently executing tool calls
  
  sendMessage: (content: string, attachments?: File[]) => Promise<void>;
  acceptChange: (toolCallId: string) => void;
  rejectChange: (toolCallId: string) => void;
  branchConversation: (messageId: string) => void; // Go back to this point
  clearConversation: () => void;
}
```

```typescript
// stores/session-store.ts
interface SessionStore {
  // Connection
  wsStatus: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  wsLatency: number;               // ms, measured via ping/pong
  lastConnectedAt: number | null;
  reconnectAttempts: number;
  
  // Sandbox
  sandboxId: string | null;
  sandboxStatus: 'provisioning' | 'ready' | 'suspended' | 'error';
  sandboxUrl: string | null;       // Base URL for preview iframe
  sandboxRegion: string;
  
  // Actions
  connect: (projectId: string) => Promise<void>;
  disconnect: () => void;
  handleReconnect: () => void;
}
```

**WebSocket authentication:** Every WebSocket message includes the current `sessionToken` in the message envelope. Channel-level permissions are enforced server-side -- the server validates that the user has access to the specific project/session referenced in each message. Token refresh is handled via the heartbeat cycle (see WebSocket architecture doc).

```typescript
// stores/file-tree-store.ts
interface FileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  isLoaded: boolean;               // For lazy-loaded directories
}

interface FileTreeStore {
  root: FileNode | null;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  
  setTree: (tree: FileNode) => void;
  toggleExpand: (path: string) => void;
  expandToPath: (path: string) => void;  // Expand all ancestors
  selectFile: (path: string) => void;
  
  // Mutations (these trigger WebSocket calls to the sandbox)
  createFile: (parentPath: string, name: string) => Promise<void>;
  createDirectory: (parentPath: string, name: string) => Promise<void>;
  renameNode: (oldPath: string, newName: string) => Promise<void>;
  deleteNode: (path: string) => Promise<void>;
  moveNode: (sourcePath: string, targetPath: string) => Promise<void>;
  
  // File watcher updates (from sandbox via WebSocket)
  handleFileCreated: (path: string, type: 'file' | 'directory') => void;
  handleFileDeleted: (path: string) => void;
  handleFileRenamed: (oldPath: string, newPath: string) => void;
}
```

```typescript
// stores/layout-store.ts -- covered in section 2.4
// stores/project-store.ts -- thin, mostly delegates to React Query
```

### 4.3 Cross-Store Communication

Stores communicate through three patterns:

**Pattern 1: mitt event bus (preferred for cross-store communication)**
```typescript
// lib/event-bus.ts -- typed event bus using mitt
import mitt from 'mitt';

type WorkspaceEvents = {
  'file:open': { path: string; line?: number };
  'file:changed-external': { path: string };
  'file:apply-diff': { filePath: string; modified: string };
  'sandbox:ready': { url: string };
  'ai:apply-changes': { changes: FileChange[] };
  'connection:status-changed': { sandbox: string; core: string };
  'terminal:mark-all-disconnected': void;
};

export const bus = mitt<WorkspaceEvents>();

// In AI store, after accepting a file change:
acceptChange: (toolCallId: string) => {
  const toolCall = get().activeToolCalls.find(tc => tc.id === toolCallId);
  if (toolCall?.diff) {
    bus.emit('file:apply-diff', { filePath: toolCall.diff.filePath, modified: toolCall.diff.modified });
  }
}

// In editor store, listen for apply-diff events:
// (initialized in useEffect, not at module scope)
bus.on('file:apply-diff', ({ filePath, modified }) => {
  useEditorStore.getState().applyDiff(filePath, modified);
});
```

Note: `applyDiff` must exist on the editor store -- this is the method that applies AI-suggested changes to the Monaco model.

**Pattern 2: Zustand subscribe (reactive, same-store effects only)**
```typescript
// Use subscribe only for reacting to changes WITHIN the same store
// or for simple derived state. For cross-store effects, use the mitt event bus.
```

**Pattern 3: Direct getState() (ONLY for reading, never for triggering side effects)**
```typescript
// Acceptable: reading a value from another store
const isConnected = useSessionStore.getState().wsStatus === 'connected';

// NOT acceptable: calling actions on another store (use event bus instead)
```

### 4.4 SSR/Hydration Safety

ALL Zustand stores are client-only. The workspace route uses `'use client'` at the layout level (`(workspace)/layout.tsx`). Stores initialize in `useEffect`, not during render. This prevents hydration mismatches where server-rendered HTML does not match client state. No store is ever read during SSR -- the workspace shell renders as a skeleton on the server and hydrates with real state on the client.

### 4.5 Preventing State Tangles

Rules enforced by code review and conventions:

1. **Stores never import each other's hooks.** Cross-store side effects use the mitt event bus. `getState()` is allowed only for reads.
2. **No derived state stored.** Use selectors: `const hasUnsaved = useEditorStore(s => s.tabs.some(t => t.isDirty))`.
3. **Server state lives in React Query only.** Zustand never caches API responses.
4. **Persisted state is minimal.** Never persist file content, terminal history, or AI streaming state.
5. **Type-safe actions.** All store actions are typed, no `any` escape hatches.
6. **`useShallow` everywhere multi-value selectors are used**, preventing re-renders when unrelated fields change.

---

## 5. Monaco Editor Integration

### 5.1 Loading Strategy

Monaco is large (5-10MB). It must be code-split and lazily loaded.

```typescript
// components/editor/MonacoEditor.tsx
'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

// Dynamic import -- Monaco is only loaded when the editor component mounts
const MonacoEditorCore = dynamic(
  () => import('./MonacoEditorCore'),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-background">
        <Skeleton className="w-full h-full" />
      </div>
    ),
  }
);
```

Monaco workers are loaded via `monaco-editor/esm/vs/editor/editor.worker` and language-specific workers. Configure via `MonacoEnvironment`:

```typescript
// lib/monaco-env.ts
self.MonacoEnvironment = {
  getWorker(_, label) {
    switch (label) {
      case 'json':
        return new Worker(
          new URL('monaco-editor/esm/vs/language/json/json.worker', import.meta.url)
        );
      case 'css':
      case 'scss':
      case 'less':
        return new Worker(
          new URL('monaco-editor/esm/vs/language/css/css.worker', import.meta.url)
        );
      case 'html':
      case 'handlebars':
      case 'razor':
        return new Worker(
          new URL('monaco-editor/esm/vs/language/html/html.worker', import.meta.url)
        );
      case 'typescript':
      case 'javascript':
        return new Worker(
          new URL('monaco-editor/esm/vs/language/typescript/ts.worker', import.meta.url)
        );
      default:
        return new Worker(
          new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url)
        );
    }
  },
};
```

### 5.2 Multi-File Tab System

```
+--------------------------------------------------------------------+
| [x] index.tsx | [*] Hero.tsx | [ ] globals.css | [+]               |
+--------------------------------------------------------------------+
| [x] = clean, closeable                                              |
| [*] = dirty (unsaved changes), dot indicator                        |
| [+] = new tab button                                                |
| Tabs are drag-reorderable (via @dnd-kit/sortable)                  |
| Middle-click closes tab                                             |
| Right-click shows context menu (Close, Close Others, Close to Right)|
| Tab overflow: horizontal scroll with arrow buttons                  |
+--------------------------------------------------------------------+
```

```typescript
// components/editor/EditorTabs.tsx
interface EditorTabsProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  onTabReorder: (fromIndex: number, toIndex: number) => void;
}

// Each tab renders:
// - File icon (mapped from extension via file-icons library)
// - File name (with parent dir if ambiguous, e.g., "index.tsx - components")
// - Dirty indicator (dot replacing close icon)
// - Close button (appears on hover if clean, always visible if dirty)
```

### 5.3 LSP Integration

Language intelligence (autocomplete, go-to-definition, hover, diagnostics) comes from language servers running inside the cloud sandbox, connected via WebSocket.

```
Browser                              Cloud Sandbox (Firecracker/Docker)
+------------------+                 +---------------------------+
| Monaco Editor    |                 | Language Server (e.g.     |
|                  |  WebSocket      | typescript-language-server,|
| MonacoLanguage   | <============> | pyright, gopls, etc.)     |
| Client           |  JSON-RPC       |                           |
| (via monaco-     |  (vscode-ws-    | node-pty (terminals)      |
|  languageclient) |   jsonrpc)      | chokidar (file watcher)   |
+------------------+                 +---------------------------+
```

```typescript
// lib/lsp-client.ts
import { MonacoLanguageClient } from 'monaco-languageclient';
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter }
  from 'vscode-ws-jsonrpc';

// LSP is tunneled through the sandbox WebSocket connection, not a separate WS.
export function createLanguageClient(
  wsUrl: string,
  languageId: string
): Promise<MonacoLanguageClient> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(wsUrl);
    
    // 10-second timeout for LSP connection
    const timeout = setTimeout(() => {
      webSocket.close();
      reject(new Error(`LSP connection timeout for ${languageId}`));
    }, 10_000);

    webSocket.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error(`LSP WebSocket error for ${languageId}: ${err}`));
    };

    webSocket.onopen = () => {
      clearTimeout(timeout);
      const socket = toSocket(webSocket);
      const reader = new WebSocketMessageReader(socket);
      const writer = new WebSocketMessageWriter(socket);
      
      const client = new MonacoLanguageClient({
        name: `${languageId}-client`,
        clientOptions: {
          documentSelector: [{ language: languageId }],
          workspaceFolder: {
            uri: monaco.Uri.parse('file:///workspace'),
            name: 'workspace',
            index: 0,
          },
        },
        messageTransports: { reader, writer },
      });
      
      client.start();
      resolve(client);
    };
  });
}

// Dispose LSP client on cleanup
export function disposeLSPClient(client: MonacoLanguageClient): void {
  client.stop();
  client.dispose();
}
```

**LSP lifecycle:**
1. When the workspace loads and sandbox is ready, connect to the LSP WebSocket endpoint.
2. The sandbox runs one language server per detected language (based on project files).
3. `textDocument/didOpen` sent when a file tab is opened.
4. `textDocument/didChange` sent on each edit (debounced by Monaco's internal buffer).
5. Diagnostics received via `textDocument/publishDiagnostics` -> shown as squiggly lines + Problems panel.
6. On disconnect, LSP features degrade gracefully (syntax highlighting still works, no IntelliSense).

### 5.4 Diff View for AI Changes

When the AI suggests code changes, we show a side-by-side diff using Monaco's built-in diff editor:

```typescript
// components/editor/DiffViewer.tsx
import * as monaco from 'monaco-editor';

interface DiffViewerProps {
  original: string;
  modified: string;
  language: string;
  filePath: string;
  onAccept: () => void;
  onReject: () => void;
}

// Uses monaco.editor.createDiffEditor()
// Shows inline decorations for additions (green) and deletions (red)
// Floating action bar: [Accept Changes] [Reject Changes] [Accept Partial...]
// Accept applies the modified version to the file
// Reject discards it and returns to the original
```

### 5.5 Editor Features Configuration

```typescript
// lib/monaco-config.ts
export const defaultEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  // Core
  theme: 'bricks-dark',           // Custom theme (see Theming section)
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  fontLigatures: true,
  tabSize: 2,
  insertSpaces: true,
  
  // UI
  minimap: { enabled: true, maxColumn: 80 },
  breadcrumbs: { enabled: true },
  lineNumbers: 'on',
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  
  // Git decorations
  glyphMargin: true,               // Space for git gutter icons
  
  // Performance
  largeFileOptimizations: true,    // Disables features for files >2MB
  maxTokenizationLineLength: 20000,
  
  // Accessibility
  accessibilitySupport: 'auto',
  ariaLabel: 'Code Editor',
};
```

### 5.6 Handling Large and Binary Files

| File Size | Behavior |
|---|---|
| < 1 MB | Full editor with all features |
| 1-5 MB | Editor with `largeFileOptimizations: true` (no tokenization, no minimap, no word wrap computation) |
| 5-50 MB | Warning dialog: "This file is large. Open anyway?" If yes, read-only with basic highlighting |
| > 50 MB | Refuse to open. Show file size. Suggest terminal commands (`head`, `less`) |

| File Type | Behavior |
|---|---|
| Text files | Normal editor |
| Images (png, jpg, svg, gif, webp) | Image preview component (zoomable, with metadata) |
| PDF | PDF viewer (embed or link to download) |
| Binary (exe, wasm, .o, etc.) | "Binary file - cannot display" with hex preview option |
| Fonts (ttf, woff, woff2) | Font preview with sample text |
| Markdown | Split view: editor + rendered preview |

### 5.7 Search Across Files

Global search uses the sandbox's `ripgrep` (if available) or a WebSocket-based file search API:

```typescript
// The search panel sends a request to the sandbox:
ws.send(JSON.stringify({
  type: 'search',
  payload: {
    query: 'useState',
    isRegex: false,
    isCaseSensitive: false,
    isWholeWord: false,
    includePattern: '**/*.{ts,tsx}',
    excludePattern: '**/node_modules/**',
    maxResults: 1000,
  },
}));

// Results streamed back as they're found:
// { type: 'search-result', payload: { file: 'src/App.tsx', line: 3, column: 10, preview: '...' } }
// { type: 'search-complete', payload: { totalResults: 47 } }
```

---

## 6. Terminal Integration

### 6.1 Architecture

```
Browser                              Cloud Sandbox
+------------------+                 +------------------+
| xterm.js         |                 | node-pty         |
| (frontend        |  WebSocket      | (PTY process     |
|  rendering)      | <============> |  manager)         |
|                  |  binary frames  |                  |
| + FitAddon       |                 | /bin/bash or     |
| + WebglAddon     |                 | /bin/zsh per     |
| + SearchAddon    |                 | terminal instance|
| + WebLinksAddon  |                 |                  |
+------------------+                 +------------------+
```

### 6.2 Terminal Component

```typescript
// components/terminal/TerminalPanel.tsx
'use client';

import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';

interface TerminalInstanceProps {
  instanceId: string;
  wsUrl: string;
  isActive: boolean;
}

function TerminalInstance({ instanceId, wsUrl, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: "'JetBrains Mono', monospace",
      theme: getXtermTheme(),     // Synced with app theme
      allowProposedApi: true,
      scrollback: 10000,          // 10K lines of history
    });
    
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();
    const clipboardAddon = new ClipboardAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(clipboardAddon);
    
    term.open(containerRef.current);
    
    // Try WebGL renderer, fall back to DOM
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        // Falls back to DOM renderer automatically
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, DOM renderer is fine
    }
    
    fitAddon.fit();
    
    // WebSocket connection to sandbox PTY
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
      // Send initial terminal size
      ws.send(JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }));
      useTerminalStore.getState().setConnectionStatus(instanceId, true);
    };
    
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        term.write(event.data);
      }
    };
    
    ws.onclose = () => {
      useTerminalStore.getState().setConnectionStatus(instanceId, false);
      term.write('\r\n\x1b[31m[Disconnected]\x1b[0m\r\n');
    };
    
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
    
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
    
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    wsRef.current = ws;
    
    return () => {
      ws.close();
      term.dispose();
    };
  }, [instanceId, wsUrl]);
  
  // Refit when panel resizes or tab becomes active
  useEffect(() => {
    if (isActive && fitAddonRef.current) {
      // Small delay to ensure container has finished resizing
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    }
  }, [isActive]);
  
  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: isActive ? 'block' : 'none' }}
      // Keep DOM alive but hidden for inactive terminals to preserve scroll history
    />
  );
}
```

### 6.3 Multiple Terminals

```
+--------------------------------------------------------------------+
| [Terminal 1: bash] [Terminal 2: node] [+] [Split] [Kill]           |
+--------------------------------------------------------------------+
|                                                                      |
|  $ npm run dev                                                       |
|  > bricks-app@0.1.0 dev                                            |
|  > next dev                                                          |
|                                                                      |
|  Ready on http://localhost:3000                                      |
|                                                                      |
+--------------------------------------------------------------------+
```

- Each terminal tab maps to a separate PTY process in the sandbox.
- Maximum per tier: Free 4, Pro 8, Team 16 terminal instances.
- Terminal names are editable (double-click tab to rename).
- Split view: horizontal split within the terminal panel, showing two terminal instances side-by-side.
- The sandbox's default shell is configurable (bash/zsh) in project settings.

### 6.4 Terminal Features

| Feature | Implementation |
|---|---|
| Copy | Ctrl/Cmd+C (when text selected), right-click context menu |
| Paste | Ctrl/Cmd+V, right-click context menu |
| Search | Ctrl/Cmd+F opens search bar within terminal (SearchAddon) |
| Links | URLs auto-detected and clickable (WebLinksAddon) |
| Clear | Ctrl+L or `clear` command |
| Resize | Automatic via FitAddon on panel resize |
| Scroll | Mouse wheel, Shift+PageUp/PageDown |
| Font size | Ctrl/Cmd + +/- (synced with editor font size preference) |

### 6.5 Terminal on Reconnect

When the WebSocket disconnects and reconnects:

1. The terminal instance shows `[Disconnected]` in red.
2. On reconnect, a new PTY is spawned (the old process may have died).
3. The terminal shows `[Reconnected - new session]`.
4. **Scroll history from the previous session is preserved in the xterm.js buffer** (since the buffer lives client-side).
5. The working directory is restored to the project root (or last known `cwd` if tracked).
6. If the previous session had a long-running process (e.g., `npm run dev`), the user must restart it. We show a hint: "Your previous terminal session ended. You may need to restart running processes."

---

## 7. AI Chat Panel

### 7.1 Message Rendering

```typescript
// components/ai/AIMessage.tsx
interface AIMessageProps {
  message: AIMessage;
  mode: 'ide' | 'builder';
}

// Rendering pipeline:
// 1. Parse markdown (via react-markdown or mdx-remote)
// 2. Code blocks: syntax highlighted via shiki (lighter than Monaco for read-only)
//    - "Copy" button on hover
//    - "Apply to file" button if the code block has a filename annotation
// 3. Inline code: monospace styled
// 4. Inline diffs: custom component showing red/green lines
// 5. File references: clickable links that open the file in the editor
// 6. Tool calls: rendered as status cards (see 7.3)
```

### 7.2 Streaming Token Display

```typescript
// components/ai/StreamingMessage.tsx
// Uses Server-Sent Events or WebSocket for streaming

function StreamingMessage() {
  const { isStreaming, streamingContent } = useAIStore(
    useShallow(s => ({ isStreaming: s.isStreaming, streamingContent: s.streamingContent }))
  );
  
  if (!isStreaming) return null;
  
  return (
    <div className="animate-in fade-in">
      {/* Render partial markdown as it arrives */}
      <MarkdownRenderer content={streamingContent} />
      {/* Blinking cursor at the end */}
      <span className="inline-block w-2 h-4 bg-primary animate-pulse" />
    </div>
  );
}

// Streaming implementation:
// - AI API returns a ReadableStream
// - Client reads chunks via fetch + ReadableStream or EventSource
// - Each chunk is appended to streamingContent in the AI store
// - React re-renders with the new content
// - On stream complete, the full message is moved to the conversation history
// - Debounce markdown parsing to avoid re-parsing on every token (parse every 100ms)
```

### 7.3 Tool Execution Visualization

When the AI executes tools (editing files, running commands), each action is shown as a status card:

```
+----------------------------------------------------------+
| AI is working...                                          |
|                                                           |
| [checkmark] Reading src/App.tsx                           |
| [spinner]   Editing src/components/Hero.tsx               |
|             +------------------------------------------+  |
|             | - import { useState } from 'react';      |  |
|             | + import { useState, useEffect } from... |  |
|             +------------------------------------------+  |
| [pending]   Running npm install framer-motion            |
|                                                           |
| [Accept All Changes] [Review Changes] [Reject All]       |
+----------------------------------------------------------+
```

```typescript
// components/ai/ToolCallCard.tsx
interface ToolCallCardProps {
  toolCall: ToolCall;
  onAccept: () => void;
  onReject: () => void;
  onViewDiff: () => void;
}

// Status icons:
// pending  -> gray circle
// running  -> animated spinner
// complete -> green checkmark
// error    -> red X with error message

// For file_edit type:
// - Shows a compact inline diff (first 5 changed lines)
// - "Expand" button to see full diff
// - "Open in Diff View" button to see side-by-side in Monaco diff editor

// For terminal_command type:
// - Shows the command being run
// - Shows truncated output (last 10 lines)
// - "View Full Output" expands or switches to terminal tab
```

### 7.4 Accept/Reject Flow

```
User sends message
  -> AI streams response with tool calls
    -> Each file change shown as a pending diff
      -> User can:
         [Accept] -> Apply change to file, mark tab dirty, show in editor
         [Reject] -> Discard change, AI acknowledges
         [Accept All] -> Apply all pending changes
         [Edit] -> Open in diff editor for manual modification before accepting
```

Changes are NOT auto-applied. The user always has control. In Builder Mode, the default behavior is auto-accept (the AI is trusted), but the user can toggle "Review changes before applying" in settings.

### 7.5 Conversation History & Branching

```
Sidebar (collapsible):
+---------------------------+
| Conversations              |
+---------------------------+
| [*] Current conversation   |
|     "Add auth system"      |
|     12 messages, 2m ago    |
+---------------------------+
| [ ] Previous conversation  |
|     "Set up project"       |
|     8 messages, 1h ago     |
+---------------------------+
| [ ] Previous conversation  |
|     "Fix navigation bug"   |
|     5 messages, 3h ago     |
+---------------------------+
| [+ New Conversation]       |
+---------------------------+
```

**Branching:**
- Right-click any AI message -> "Try a different approach from here"
- This creates a branch: all messages after the selected one are moved to a "branch"
- The user types a new instruction, creating a new path
- Branches are visually indicated and navigable (tree view in conversation detail)
- Implementation: Each message has a `parentId`. Branching creates a new message with the same `parentId` as the branched-from message.

### 7.6 IDE Mode vs Builder Mode AI Panel

| Aspect | IDE Mode | Builder Mode |
|---|---|---|
| Position | Right sidebar panel (collapsible) | Left panel, 40% width (primary) |
| Size | 25% of viewport width | 40% of viewport width |
| Code display | Full syntax-highlighted code blocks, diffs | Minimal code, plain language explanations |
| Tool calls | Shown with file paths and diffs | Shown as progress steps ("Creating files...") |
| Auto-apply | Off by default | On by default |
| Input | Text input with slash commands | Text input with suggestions/chips |
| Conversation history | Sidebar within panel | Dedicated sidebar |

---

## 8. App Preview Panel

### 8.1 Architecture

The preview panel shows the user's running application in an iframe. The app runs inside the cloud sandbox and is accessible via a unique URL.

```
Sandbox provides:
  https://{sandboxId}.bricks-preview.dev:{port}/

This URL is:
  - Unique per sandbox instance
  - Accessible only by the authenticated user (cookie-based or token-based auth)
  - Proxied through our edge (Cloudflare/Vercel) for HTTPS and auth
```

### 8.2 Preview Panel Component

```
+------------------------------------------------------------------+
| [< >] [URL bar: /about          ] [Reload] [New Tab]             |
| [Mobile] [Tablet] [Desktop] [Responsive] | [Console] [Network]   |
+------------------------------------------------------------------+
|                                                                    |
|  +--------------------------------------------+                   |
|  |  (Device frame - optional visual chrome)    |                   |
|  |                                              |                   |
|  |   iframe: sandboxUrl + path                  |                   |
|  |                                              |                   |
|  |   Hot-reloads automatically when             |                   |
|  |   files change in the sandbox                |                   |
|  |                                              |                   |
|  |                                              |                   |
|  +--------------------------------------------+                   |
|                                                                    |
+------------------------------------------------------------------+
| Console output (collapsible)                                       |
| > [info] Compiled successfully                                     |
| > [warn] React Hook useEffect has missing dependency...            |
| > [error] TypeError: Cannot read property 'map' of undefined      |
+------------------------------------------------------------------+
```

### 8.3 Device Frame Options

| Mode | Width | Description |
|---|---|---|
| Mobile | 375px | iPhone SE/14 width, with phone frame chrome |
| Tablet | 768px | iPad width, with tablet frame chrome |
| Desktop | 100% | Full panel width, no frame |
| Responsive | Resizable | Free-form resize with dimension display (e.g., "1024 x 768") |

Device frames are CSS-only decorations (rounded corners, notch, home bar) that wrap the iframe. They are optional and togglable.

### 8.4 Hot Reload

Hot reload works through the framework's built-in HMR:

1. User edits file in Monaco -> file saved to sandbox via WebSocket.
2. The sandbox's dev server (Next.js, Vite, etc.) detects the file change.
3. The dev server pushes an HMR update to the iframe.
4. The iframe re-renders. No manual reload needed.

If HMR fails (full reload needed), the iframe refreshes automatically. The URL bar reflects the current path.

### 8.5 Console Output

The preview panel can capture console output from the iframe using a message bridge:

```typescript
// Injected into the preview iframe via a service worker or proxy:
// This script forwards console messages to the parent window.

// In the preview panel:
window.addEventListener('message', (event) => {
  if (event.data?.type === 'bricks-console') {
    const { level, args, stack } = event.data;
    addConsoleMessage({ level, args, stack, timestamp: Date.now() });
  }
});
```

Console messages are shown in a collapsible panel below the iframe with filtering (info/warn/error) and clear button.

### 8.6 CORS and Authentication

**CORS:** The preview iframe runs on a different subdomain (`*.bricks-preview.dev`) than the main app (`app.bricks.dev`). This is intentional isolation. Communication between the parent and iframe uses `postMessage` with origin verification.

**Authentication in previewed apps:** If the user's app requires authentication (e.g., OAuth callbacks), the sandbox provides a mock environment or the callback URLs can be configured to point to the sandbox's preview URL. This is documented in the "Preview Settings" section of project configuration.

**Cookie isolation:** The preview iframe has its own cookie jar (different domain). The parent app's auth cookies are not accessible to the preview, and vice versa. This prevents the user's app from accidentally accessing Bricks platform cookies.

### 8.7 Content Security Policy

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-eval' https://clerk.bricks.dev;
  style-src 'self' 'unsafe-inline';
  frame-src https://*.bricks-preview.dev;
  connect-src 'self' wss://ws.bricks.dev wss://api.bricks.dev https://api.clerk.dev;
  img-src 'self' data: https:;
  font-src 'self' data:;
```

Preview iframe MUST use `bricks-preview.dev` (separate domain from main app) for full origin isolation. User-generated content in AI chat markdown is sanitized via `rehype-sanitize` to prevent XSS through markdown injection.

---

## 9. Performance Strategy

### 9.1 Bundle Strategy

| Chunk | Contents | Size Target | Loading |
|---|---|---|---|
| `main` | Next.js runtime, React, Tailwind, core UI | < 150 KB gzipped | Immediate |
| `dashboard` | Dashboard components, project grid | < 50 KB gzipped | Route-based split |
| `monaco` | Monaco editor core + workers | ~2 MB gzipped | Dynamic import on workspace load |
| `xterm` | xterm.js + addons | ~200 KB gzipped | Dynamic import when terminal opens |
| `ai-chat` | Markdown renderer, diff viewer, chat UI | ~100 KB gzipped | Dynamic import when AI panel opens |
| `preview` | Device frames, console bridge | ~30 KB gzipped | Dynamic import when preview opens |
| `collaboration` | Y.js, awareness, WebSocket provider | ~80 KB gzipped | Dynamic import on collaboration init |

### 9.2 Load Sequence for Workspace

```
TTI Targets (honest numbers):

Cold start (new sandbox provisioning):    < 8 seconds
Warm sandbox + no client cache:           < 4 seconds
Warm sandbox + cached client assets:      < 2 seconds
Returning user (warm sandbox + cached):   < 1.5 seconds

Typical warm load sequence:
T+0ms      Navigate to /w/[projectId]/ide
T+50ms     Workspace layout shell renders (skeleton)
T+200ms    WebSocket connections initiated (sandbox + core)
T+500ms    File tree loaded (first WebSocket message)
T+800ms    Monaco chunk starts loading (dynamic import)
T+1500ms   Sandbox status: ready
T+2000ms   Monaco loaded, editor renders with last-open file
T+2500ms   LSP connection established
T+3000ms   Terminal chunk loaded (if bottom panel is open)
T+3500ms   AI chat chunk loaded (if right panel is open)

Total time to interactive editor: ~2s (warm sandbox, cached assets)
Total time to full workspace: ~3.5s (warm sandbox, cached assets)
```

### 9.3 WebSocket Connection Architecture

Two WebSocket connections per user session, managed by a `ConnectionManager`:

```typescript
// lib/ws-connection-manager.ts

class SandboxConnection {
  // Connects to the user's sandbox pod (direct pod IP via router)
  // Channels: file, terminal, lsp, preview, search
  // Independent reconnection with full jitter backoff
  private ws: WebSocket;
  readonly status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  connect(sandboxUrl: string): void;
  disconnect(): void;
  send(message: WSMessage): void;
}

class CoreConnection {
  // Connects to the Core API cluster (load-balanced)
  // Channels: ai streaming, project management, presence, session control
  // Independent reconnection with full jitter backoff
  private ws: WebSocket;
  readonly status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  connect(coreUrl: string): void;
  disconnect(): void;
  send(message: WSMessage): void;
}

class ConnectionManager {
  readonly sandbox: SandboxConnection;
  readonly core: CoreConnection;
  // Unified status reporting to UI
  readonly status: 'all-connected' | 'partial' | 'disconnected';
  // Emits events for per-connection status changes
  onStatusChange(callback: (status: ConnectionStatus) => void): void;
}

// All messages share a common envelope:
interface WSMessage {
  channel: 'file' | 'terminal' | 'lsp' | 'preview' | 'search' | 'system' | 'ai' | 'presence';
  type: string;
  payload: unknown;
  requestId?: string;   // For request/response correlation
}

// Sandbox channels:
// file:     file CRUD, file watch events, bulk file sync
// terminal: PTY data (binary), resize, create/destroy
// lsp:      JSON-RPC messages for language server
// preview:  preview URL, port forwarding events
// search:   search queries and results
// system:   sandbox status, heartbeat, metrics

// Core channels:
// ai:       AI streaming, submit, cancel, feedback
// presence: user presence, typing indicators
// system:   session lifecycle, project management
```

Two connections provide independent failure domains: sandbox pod crashes do not affect AI streaming, and Core API redeploys do not affect terminal/editor.

### 9.4 Slow Connection Handling

| Scenario | Detection | Response |
|---|---|---|
| High latency (>200ms) | WebSocket ping/pong measurement | Show latency indicator in status bar. Increase debounce on file saves |
| Packet loss | Message sequence gaps | Request retransmission. Buffer outgoing messages |
| Very slow (<100 Kbps) | Transfer rate measurement | Disable minimap, reduce LSP features, warn user |
| Offline | WebSocket close event | Enter offline mode (see section 10) |

### 9.5 Memory Management

| Concern | Mitigation |
|---|---|
| 20+ open editor tabs | Max 10 active Monaco models with LRU eviction. When a tab is evicted from the active set, its model is disposed and re-fetched on focus. Persist tab metadata only (path, cursor position), not file contents. |
| Terminal scroll history | Cap scrollback at 10,000 lines per instance. Max per tier: Free 4, Pro 8, Team 16 |
| AI conversation history | Keep only the last 100 messages in memory. Older messages lazy-loaded from server on scroll |
| File tree | Lazy-load directory children on expand. Do not load entire tree upfront for large projects |
| Monaco models | Dispose models when tabs are closed. LRU eviction at max 10 active models. Re-fetch from sandbox on re-focus |
| WebGL context | Monitor for context loss. Fall back to DOM renderer. Only one WebGL terminal at a time (the active one) |

### 9.6 Backgrounded Tab Behavior

When the browser tab is backgrounded (visibilitychange event):

1. **Reduce WebSocket heartbeat** from 15s to 60s.
2. **Pause LSP diagnostics updates** (no visible UI to update).
3. **Continue terminal data flow** (background processes keep running, data is buffered).
4. **Pause AI streaming UI updates** (accumulate tokens, render all at once when tab is foregrounded).
5. **Do NOT disconnect** the WebSocket. Browsers throttle but rarely kill WebSocket connections.
6. On tab foreground: re-fit terminal, re-render pending updates, resume normal heartbeat.

---

## 10. Offline & Degraded Experience

### 10.1 Disconnection Handling

```
Connection Status State Machine:

[connected] --ws close--> [disconnected] --auto retry (backoff)--> [reconnecting]
[reconnecting] --ws open--> [connected]
[reconnecting] --max retries--> [failed]
[failed] --user click "Retry"--> [reconnecting]
```

### 10.2 What Happens When WebSocket Disconnects

| Component | Behavior | Data Preserved |
|---|---|---|
| **Editor** | KEEPS WORKING. All open files are in Monaco's in-memory models. User can type, navigate, undo/redo. Saves are queued and flushed on reconnect | Yes -- all edits preserved |
| **Terminal** | Shows `[Disconnected]`. User cannot type. Scroll history preserved | Scroll history yes, PTY process no |
| **AI Chat** | Shows "Connection lost" banner. Cannot send new messages. Conversation history preserved in Zustand store | Yes -- all messages preserved |
| **File Tree** | Frozen at last-known state. File operations (create, delete, rename) are queued | Partially -- queued ops |
| **Preview** | iframe keeps running if the sandbox is still alive (it may be). Shows "Connection to workspace lost" overlay | Depends on sandbox health |
| **LSP** | All IntelliSense stops. Syntax highlighting (client-side) continues | No LSP state preserved |
| **Git** | Operations unavailable. Show cached status | Cached status only |

### 10.3 Reconnection UI

```
+----------------------------------------------------------+
| [!] Connection lost. Reconnecting... (attempt 3/10)      |
|     [Retry Now] [Dismiss]                                 |
+----------------------------------------------------------+

// Shows as a toast/banner at the top of the workspace
// Non-blocking: user can continue editing
// After successful reconnect:

+----------------------------------------------------------+
| [checkmark] Reconnected. Syncing changes...              |
|     2 files saved. Terminal restarted.                    |
+----------------------------------------------------------+
```

### 10.4 Reconnection Sync Protocol

On reconnect:

1. **File sync**: Client sends a manifest of all open files with their content hashes. Server compares with disk. **Last-write-wins** -- the sandbox filesystem is the source of truth. On conflict, a banner notification is shown ("File was changed on disk. Reloaded."). No merge dialog for v1.
2. **Terminal**: New PTY spawned. Old terminal buffer preserved client-side, new session starts below it.
3. **LSP**: Language client reconnects and re-initializes. May take a few seconds for diagnostics to reappear.
4. **Queued operations**: File creates/deletes/renames that were queued offline are replayed in order. Conflicts (file already exists/already deleted) are reported to the user.

### 10.5 Sandbox Death vs. WebSocket Disconnect

These are different scenarios:

| Scenario | WebSocket | Sandbox | Recovery |
|---|---|---|---|
| Network blip | Disconnects, reconnects | Still running | Automatic, fast |
| User's internet drops | Disconnects | Still running (for idle timeout period) | Automatic when internet returns |
| Sandbox killed (idle timeout) | Disconnects | Dead | Need to re-provision. All unsaved work at risk |
| Sandbox crashed | Disconnects | Dead | Re-provision. Persistent storage survives |

To protect against sandbox death:
- **Auto-save every 30 seconds** to the sandbox's persistent storage.
- **Critical files saved on every edit** (debounced 2 seconds).
- **Sandbox idle timeout warning**: "Your workspace will shut down in 5 minutes due to inactivity. [Keep Alive]"

---

## 11. Theming System

### 11.1 Architecture

Three systems must be themed consistently:

1. **Application UI** (Tailwind + shadcn/ui) -- CSS variables
2. **Monaco Editor** -- Monaco theme API
3. **xterm.js** -- xterm theme object

All three derive from a single source of truth: CSS custom properties.

### 11.2 CSS Variable Foundation

```css
/* globals.css */
@layer base {
  :root {
    /* Core palette -- light mode */
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;
    --primary: 240 5.9% 10%;
    --primary-foreground: 0 0% 98%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 240 5.9% 10%;
    
    /* Editor-specific tokens */
    --editor-background: 0 0% 100%;
    --editor-foreground: 240 10% 3.9%;
    --editor-line-highlight: 240 5% 96%;
    --editor-selection: 214 100% 90%;
    --editor-gutter: 0 0% 97%;
    --editor-line-number: 240 3.8% 60%;
    --editor-active-line-number: 240 10% 3.9%;
    
    /* Terminal-specific tokens */
    --terminal-background: 240 10% 4%;
    --terminal-foreground: 0 0% 90%;
    --terminal-cursor: 0 0% 90%;
    --terminal-black: 240 10% 10%;
    --terminal-red: 0 72% 51%;
    --terminal-green: 142 71% 45%;
    --terminal-yellow: 48 96% 53%;
    --terminal-blue: 217 91% 60%;
    --terminal-magenta: 292 84% 61%;
    --terminal-cyan: 188 95% 43%;
    --terminal-white: 0 0% 90%;
  }

  .dark {
    /* Dark mode overrides */
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    /* ... full dark palette ... */
    
    --editor-background: 240 10% 6%;
    --editor-foreground: 0 0% 90%;
    --editor-line-highlight: 240 5% 10%;
    --editor-selection: 214 50% 25%;
    /* ... */
  }
}
```

### 11.3 Monaco Theme Generation

```typescript
// lib/theme/monaco-theme.ts
import * as monaco from 'monaco-editor';

function getCSSVar(name: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();
  return hslToHex(value); // Monaco needs hex colors
}

export function registerBricksTheme() {
  monaco.editor.defineTheme('bricks-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Syntax highlighting rules
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'function', foreground: 'DCDCAA' },
      // ... comprehensive token rules
    ],
    colors: {
      'editor.background': getCSSVar('editor-background'),
      'editor.foreground': getCSSVar('editor-foreground'),
      'editor.lineHighlightBackground': getCSSVar('editor-line-highlight'),
      'editor.selectionBackground': getCSSVar('editor-selection'),
      'editorLineNumber.foreground': getCSSVar('editor-line-number'),
      'editorLineNumber.activeForeground': getCSSVar('editor-active-line-number'),
      'editorGutter.background': getCSSVar('editor-gutter'),
      // ... complete color mapping
    },
  });
  
  monaco.editor.defineTheme('bricks-light', {
    base: 'vs',
    inherit: true,
    rules: [/* light mode syntax tokens */],
    colors: {/* mapped from CSS vars */},
  });
}
```

### 11.4 xterm.js Theme Sync

```typescript
// lib/theme/xterm-theme.ts
export function getXtermTheme(): ITheme {
  return {
    background: getCSSVar('terminal-background'),
    foreground: getCSSVar('terminal-foreground'),
    cursor: getCSSVar('terminal-cursor'),
    cursorAccent: getCSSVar('terminal-background'),
    selectionBackground: getCSSVar('editor-selection'),
    black: getCSSVar('terminal-black'),
    red: getCSSVar('terminal-red'),
    green: getCSSVar('terminal-green'),
    yellow: getCSSVar('terminal-yellow'),
    blue: getCSSVar('terminal-blue'),
    magenta: getCSSVar('terminal-magenta'),
    cyan: getCSSVar('terminal-cyan'),
    white: getCSSVar('terminal-white'),
    brightBlack: getCSSVar('terminal-bright-black'),
    brightRed: getCSSVar('terminal-bright-red'),
    // ... all 16 ANSI colors + bright variants
  };
}
```

### 11.5 Theme Switching

```typescript
// Theme switch flow:
// 1. User toggles theme in settings or via Cmd+Shift+T
// 2. next-themes updates <html> class (dark/light/system)
// 3. CSS variables update automatically via Tailwind dark: variant
// 4. Monaco theme re-applied: monaco.editor.setTheme('bricks-dark' | 'bricks-light')
// 5. xterm theme updated: terminal.options.theme = getXtermTheme()
// 6. All components re-render with new CSS variable values

// Listener for system theme changes:
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
mediaQuery.addEventListener('change', handleThemeChange);
```

---

## 12. Keyboard Shortcuts

### 12.1 Shortcut Map

```typescript
// lib/shortcuts.ts
type ShortcutScope = 'global' | 'editor' | 'terminal' | 'ai-chat' | 'file-tree';

interface Shortcut {
  id: string;
  keys: string;                    // e.g., "Mod+S" (Mod = Cmd on Mac, Ctrl on Win/Linux)
  macKeys?: string;                // Override for Mac if different
  description: string;
  scope: ShortcutScope;
  action: () => void;
  when?: () => boolean;            // Condition for shortcut to be active
}
```

| Category | Shortcut (Mac / Win) | Action |
|---|---|---|
| **File** | Cmd+S / Ctrl+S | Save current file |
| | Cmd+Shift+S / Ctrl+Shift+S | Save all files |
| | Cmd+W / Ctrl+W | Close current tab |
| | Cmd+Shift+W / Ctrl+Shift+W | Close all tabs |
| | Cmd+N / Ctrl+N | New file (intercepted from browser) |
| **Navigation** | Cmd+P / Ctrl+P | Quick file open (fuzzy search) |
| | Cmd+Shift+P / Ctrl+Shift+P | Command palette |
| | Cmd+Shift+E / Ctrl+Shift+E | Focus file explorer |
| | Cmd+Shift+F / Ctrl+Shift+F | Focus global search |
| | Cmd+Shift+G / Ctrl+Shift+G | Focus git panel |
| | Cmd+B / Ctrl+B | Toggle primary sidebar |
| | Cmd+J / Ctrl+J | Toggle bottom panel |
| | Cmd+Shift+J / Ctrl+Shift+J | Toggle right sidebar (AI/Preview) |
| **Editor** | Cmd+D / Ctrl+D | Select next occurrence |
| | Cmd+Shift+L / Ctrl+Shift+L | Select all occurrences |
| | Alt+Up / Alt+Down | Move line up/down |
| | Cmd+/ / Ctrl+/ | Toggle line comment |
| | Cmd+Shift+K / Ctrl+Shift+K | Delete line |
| | Cmd+G / Ctrl+G | Go to line |
| | F12 | Go to definition |
| | Shift+F12 | Find all references |
| | F2 | Rename symbol |
| **Terminal** | Ctrl+` (backtick) | Toggle terminal / focus terminal |
| | Cmd+Shift+` / Ctrl+Shift+` | New terminal |
| **AI** | Cmd+L / Ctrl+L | Focus AI chat input |
| | Cmd+Shift+L / Ctrl+Shift+L | Send selected code to AI chat |
| | Escape | Close AI panel (when focused) |

### 12.2 Browser Shortcut Conflicts

Problem: Browser shortcuts (Cmd+N new window, Cmd+W close tab, Cmd+T new tab) overlap with IDE shortcuts.

Solution:

```typescript
// We intercept specific shortcuts at the document level:
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  
  // Save: prevent browser "Save As" dialog
  if (mod && e.key === 's') {
    e.preventDefault();
    handleSave();
  }
  
  // Quick open: prevent browser "Print" or other Ctrl+P behavior
  if (mod && e.key === 'p') {
    e.preventDefault();
    openQuickFileSearch();
  }
  
  // New file: prevent browser "New Window"
  if (mod && e.key === 'n' && !e.shiftKey) {
    e.preventDefault();
    createNewFile();
  }
  
  // Close tab: prevent browser "Close Tab"
  if (mod && e.key === 'w') {
    e.preventDefault();
    closeCurrentEditorTab();
  }
});

// NOTE: Some shortcuts CANNOT be intercepted (e.g., Cmd+Q on Mac).
// For these, we do not try. We also never intercept Cmd+T (new browser tab)
// because users need that escape hatch.
```

### 12.3 Command Palette

The command palette (Cmd+Shift+P) provides a searchable list of ALL available actions:

```
+---------------------------------------------------------+
| > Search commands...                                     |
+---------------------------------------------------------+
| File: Save                               Cmd+S          |
| File: Save All                           Cmd+Shift+S    |
| View: Toggle Terminal                    Ctrl+`          |
| View: Toggle Sidebar                     Cmd+B          |
| Git: Commit                              Cmd+Enter      |
| Theme: Toggle Dark/Light                 Cmd+Shift+T    |
| AI: New Conversation                                     |
| AI: Clear Conversation                                   |
| Terminal: New Terminal                    Cmd+Shift+`    |
| Editor: Format Document                  Shift+Alt+F    |
| Editor: Change Language Mode                             |
| ... (filterable, keyboard navigable)                     |
+---------------------------------------------------------+
```

Implementation: shadcn/ui `<CommandDialog>` (built on cmdk) with custom command registration.

### 12.4 Shortcut Discoverability

1. **Command palette**: Shows shortcuts next to each command.
2. **Tooltip hints**: Hovering toolbar buttons shows the keyboard shortcut.
3. **Keyboard shortcuts panel**: Settings > Keyboard Shortcuts shows all shortcuts in a searchable, categorized table.
4. **First-session overlay**: On first visit, a quick "Essential shortcuts" card shows the top 5.
5. **Cheat sheet**: Cmd+K Cmd+S opens a printable shortcut reference (like VS Code).

### 12.5 Custom Keybindings

Users can override any keybinding in Settings > Keyboard Shortcuts:

```typescript
// Stored in user preferences (server-synced)
interface CustomKeybinding {
  commandId: string;
  keys: string;          // New keybinding
  when?: string;         // Context condition
}

// Applied on workspace load, overriding defaults
```

---

## 13. Onboarding Experience

### 13.1 First Visit (Unauthenticated)

```
Landing page -> Sign Up (Clerk)
  -> Onboarding wizard (3 steps):
     
     Step 1: "What best describes you?"
       [ ] I'm a developer (IDE Mode default)
       [ ] I'm building something (Builder Mode default)
       [ ] I'm exploring (Builder Mode default)
     
     Step 2: "What do you want to build?"
       [ ] Web app (React/Next.js)
       [ ] API / Backend
       [ ] Mobile app
       [ ] Something else
       (This influences template suggestions and default AI context)
     
     Step 3: "Start from..."
       [ ] A template (gallery of starters: blank, Next.js, Express, Python Flask, etc.)
       [ ] An existing repository (GitHub import)
       [ ] Scratch (empty project)
       [ ] Describe your idea (Builder Mode: AI creates from description)
```

### 13.2 First Workspace Visit -- IDE Mode

```
+------------------------------------------------------------------+
|                                                                    |
|  Welcome to Bricks IDE                                            |
|                                                                    |
|  Essential shortcuts:                                              |
|  Cmd+P        Quick file open                                     |
|  Cmd+Shift+P  Command palette                                     |
|  Cmd+S        Save file                                           |
|  Ctrl+`       Toggle terminal                                     |
|  Cmd+L        Ask AI                                              |
|                                                                    |
|  [x] Don't show again    [Got it, let's code]                     |
|                                                                    |
+------------------------------------------------------------------+
```

Additionally:
- **Pulsing indicators** on the AI chat icon (right sidebar) with tooltip "Need help? Ask AI anything."
- The terminal auto-opens with the dev server starting (if template includes one).
- The preview panel auto-opens if the template has a frontend.
- A "Getting Started" file (README.md or GETTING_STARTED.md) is open in the editor by default.

### 13.3 First Workspace Visit -- Builder Mode

```
+------------------------------------------------------------------+
|                                                                    |
|  AI Assistant:                                                     |
|  "Hi! I've set up a Next.js project for you. You can see the     |
|   preview on the right. Tell me what you'd like to build or       |
|   change!"                                                         |
|                                                                    |
|  Suggested prompts:                                                |
|  [Add a navigation bar]                                           |
|  [Create a landing page]                                          |
|  [Connect a database]                                             |
|  [Deploy my app]                                                  |
|                                                                    |
+------------------------------------------------------------------+
```

The AI proactively greets the user and suggests first actions. The preview shows the running template app immediately.

### 13.4 Template Gallery

```
/dashboard/templates

+-----------+  +-----------+  +-----------+  +-----------+
|           |  |           |  |           |  |           |
| [preview] |  | [preview] |  | [preview] |  | [preview] |
|           |  |           |  |           |  |           |
+-----------+  +-----------+  +-----------+  +-----------+
| Next.js   |  | Express   |  | Python    |  | Blank     |
| Starter   |  | API       |  | FastAPI   |  | Project   |
| React,    |  | Node.js,  |  | Python,   |  | Choose    |
| Tailwind, |  | TypeScript|  | SQLAlchemy|  | your own  |
| shadcn/ui |  | Prisma    |  | Alembic   |  | stack     |
|           |  |           |  |           |  |           |
| [Use]     |  | [Use]     |  | [Use]     |  | [Use]     |
+-----------+  +-----------+  +-----------+  +-----------+

Categories: [All] [Frontend] [Backend] [Full-Stack] [AI/ML] [Data]

Search: [Search templates...]
```

Each template includes:
- Screenshot/preview
- Tech stack badges
- Brief description
- "Use this template" creates a new project from it

---

## 14. Component Tree Reference

```
<RootLayout>                                   -- app/layout.tsx
  <ThemeProvider>                               -- next-themes
  <ClerkProvider>                               -- Auth context
  <QueryClientProvider>                         -- React Query
  <TooltipProvider>                             -- shadcn tooltips
  <Toaster />                                  -- shadcn sonner
    
    <!-- Marketing pages -->
    <MarketingLayout>                          -- (marketing)/layout.tsx
      <Navbar />
      <main>{children}</main>
      <Footer />
    </MarketingLayout>

    <!-- Auth pages -->
    <AuthLayout>                               -- (auth)/layout.tsx
      <div className="centered">
        {children}                             -- Clerk components
      </div>
    </AuthLayout>

    <!-- App pages -->
    <AppLayout>                                -- (app)/layout.tsx
      <AppSidebar />                           -- Navigation sidebar
      <main>{children}</main>
    </AppLayout>

    <!-- Workspace pages -->
    <WorkspaceLayout>                          -- (workspace)/layout.tsx
      <WorkspaceProviders projectId={id}>      -- WebSocket, stores init
        <SessionProvider>                      -- Connection management
        <FileSystemProvider>                   -- File operations context
        
          <!-- IDE Mode -->
          <WorkspaceErrorBoundary fallback="Workspace failed to load. Reload page.">
          <IDEWorkspace>                       -- w/[projectId]/ide/page.tsx
            <WorkspaceToolbar />
            <ResizablePanelGroup>              -- Main horizontal split
              <ActivityBar />
              <EditorPanelBoundary fallback="Editor crashed. Click to reload panel.">
              <PrimarySidebar>
                <FileExplorer />
                <SearchPanel />
                <GitPanel />
              </PrimarySidebar>
              <CenterArea>
                <ResizablePanelGroup>          -- Vertical split
                  <EditorArea>
                    <EditorTabs />
                    <MonacoEditor />
                    <DiffViewer />             -- Conditional
                    <BreadcrumbBar />
                  </EditorArea>
                  </EditorPanelBoundary>
                  <TerminalPanelBoundary fallback="Terminal crashed. Click to restart.">
                  <BottomPanel>
                    <TerminalPanel>
                      <TerminalTabs />
                      <TerminalInstance />     -- Multiple
                    </TerminalPanel>
                    <ProblemsPanel />
                    <OutputPanel />
                  </BottomPanel>
                  </TerminalPanelBoundary>
                </ResizablePanelGroup>
              </CenterArea>
              <RightSidebar>
                <AIChatBoundary fallback="AI chat crashed. Click to reload.">
                <AIChatPanel>
                  <ConversationHistory />
                  <MessageList>
                    <AIMessage />
                    <UserMessage />
                    <ToolCallCard />
                    <StreamingMessage />
                  </MessageList>
                  <ChatInput />
                </AIChatPanel>
                </AIChatBoundary>
                <PreviewPanelBoundary fallback="Preview crashed. Click to reload.">
                <PreviewPanel>
                  <PreviewToolbar />
                  <DeviceFrame />
                  <PreviewIframe />
                  <PreviewConsole />
                </PreviewPanel>
                </PreviewPanelBoundary>
              </RightSidebar>
            </ResizablePanelGroup>
            <StatusBar />
          </IDEWorkspace>
          </WorkspaceErrorBoundary>

          <!-- Builder Mode -->
          <BuilderWorkspace>                   -- w/[projectId]/builder/page.tsx
            <BuilderToolbar />
            <ResizablePanelGroup>
              <BuilderChat>
                <ConversationHistory />
                <MessageList />
                <BuilderInput />
              </BuilderChat>
              <PreviewPanel />
            </ResizablePanelGroup>
          </BuilderWorkspace>

        </FileSystemProvider>
        </SessionProvider>
      </WorkspaceProviders>
    </WorkspaceLayout>
```

---

## 15. Key Technical Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16.2 (App Router) | Largest ecosystem, SSR for marketing, CSR for workspace, Turbopack for dev speed |
| Editor | Monaco Editor | Closest to VS Code, best IntelliSense, diff editor built-in, massive adoption |
| Terminal | xterm.js + @xterm/addon-webgl | Industry standard, GPU-accelerated, battle-tested |
| State management | Zustand v5 (sliced stores) | Lightweight, concurrent-mode safe, slice pattern scales well |
| Server state | TanStack Query (React Query) v5 | Best server state cache, deduplication, optimistic updates |
| Resizable panels | react-resizable-panels v4 (via shadcn/ui) | Layout persistence, nested groups, collapsible, accessible |
| UI components | shadcn/ui (Radix primitives) | Copy-paste ownership, full customization, excellent defaults |
| Styling | Tailwind CSS v4 | Utility-first, design tokens via CSS variables, tree-shakes perfectly |
| LSP | monaco-languageclient v10 + vscode-ws-jsonrpc | Mature WebSocket LSP bridge, VS Code API compat |
| Auth | Clerk | Best Next.js integration, SOC2, Stripe billing built-in |
| Billing | Stripe | Industry standard, Clerk zero-integration |
| Real-time collab (Phase 2) | Y.js | CRDT-based, Monaco bindings, offline-first |
| Markdown rendering | react-markdown + shiki | Lightweight, syntax highlighting via shiki (same engine as VS Code) |
| Drag and drop | @dnd-kit/sortable | Tab reordering, file tree DnD, accessible |
| Command palette | cmdk (via shadcn/ui) | Fast, accessible, composable |
| Icons | Lucide React (UI) + material-icon-theme mapping (file icons) | Consistent, complete |
| WebSocket protocol | Two connections (Sandbox + Core) with channel multiplexing | Independent failure domains, separate reconnection |
| Monaco loading | Dynamic import, ssr: false | Code-split the ~5MB bundle, never SSR |
| Theme | CSS variables -> Monaco theme + xterm theme | Single source of truth for all three systems |
| Error boundaries | Per-panel error boundaries (5 concrete boundaries) | One panel crashing doesn't take down the workspace |

### Anti-Patterns Deliberately Avoided

1. **No Redux.** Zustand's slice pattern is sufficient. Redux's boilerplate and middleware complexity is unnecessary for this application size.
2. **No global event emitter spaghetti.** The mitt event bus is typed, scoped, and is the primary mechanism for cross-store communication (replacing direct `getState()` calls for side effects).
3. **No "god store".** Each domain has its own store. Cross-store side effects use the mitt event bus. Direct `getState()` is only for reading, never for triggering actions across stores.
4. **No localStorage for file content.** File content lives in Monaco models (memory) and the sandbox (disk). localStorage is only for UI preferences and layout state.
5. **No polling.** All real-time communication uses WebSocket push. The only poll is the heartbeat/ping.
6. **No full-page loading spinners.** Every panel has its own skeleton/loading state. The workspace shell renders immediately.
7. **No client-side routing for marketing pages.** Marketing pages are SSR/ISR for SEO. The workspace is CSR.

---

## Appendix A: Package Dependencies

```json
{
  "dependencies": {
    "next": "^16.2.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    
    "monaco-editor": "^0.52.0",
    "monaco-languageclient": "^10.7.0",
    "vscode-ws-jsonrpc": "^3.5.0",
    "@typefox/monaco-editor-react": "^7.7.0",
    
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/addon-search": "^0.15.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/addon-clipboard": "^0.1.0",
    
    "zustand": "^5.0.0",
    "@tanstack/react-query": "^5.60.0",
    
    "tailwindcss": "^4.0.0",
    "radix-ui": "^1.2.0",
    "@dnd-kit/core": "^6.3.0",
    "@dnd-kit/sortable": "^9.0.0",
    "cmdk": "^1.1.0",
    "react-resizable-panels": "^4.9.0",
    "next-themes": "^0.4.0",
    "lucide-react": "^0.470.0",
    "react-markdown": "^9.0.0",
    "shiki": "^3.0.0",
    "sonner": "^2.0.0",
    "mitt": "^3.0.0",
    "rehype-sanitize": "^6.0.0",
    
    "@clerk/nextjs": "^6.10.0",
    
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "biome": "^2.0.0"
  }
}
```

## Appendix B: Directory Structure

```
src/
  app/
    layout.tsx
    (marketing)/
    (auth)/
    (app)/
    (workspace)/
    (admin)/
    api/
  
  components/
    ui/                          -- shadcn/ui components (button, dialog, etc.)
    layout/
      AppSidebar.tsx
      Navbar.tsx
      Footer.tsx
      StatusBar.tsx
    editor/
      MonacoEditor.tsx
      MonacoEditorCore.tsx       -- Dynamic import target
      EditorTabs.tsx
      DiffViewer.tsx
      BreadcrumbBar.tsx
      FilePreview.tsx            -- Image/binary/font preview
    terminal/
      TerminalPanel.tsx
      TerminalInstance.tsx
      TerminalTabs.tsx
    ai/
      AIChatPanel.tsx
      BuilderChat.tsx
      MessageList.tsx
      AIMessage.tsx
      UserMessage.tsx
      StreamingMessage.tsx
      ToolCallCard.tsx
      ChatInput.tsx
      BuilderInput.tsx
      ConversationHistory.tsx
    preview/
      PreviewPanel.tsx
      PreviewToolbar.tsx
      DeviceFrame.tsx
      PreviewConsole.tsx
    workspace/
      IDEWorkspace.tsx
      BuilderWorkspace.tsx
      WorkspaceToolbar.tsx
      BuilderToolbar.tsx
      ActivityBar.tsx
      PrimarySidebar.tsx
      RightSidebar.tsx
      BottomPanel.tsx
    file-explorer/
      FileTree.tsx
      FileTreeNode.tsx
      FileContextMenu.tsx
    search/
      SearchPanel.tsx
      SearchResults.tsx
    git/
      GitPanel.tsx
      BranchSelector.tsx
      DiffList.tsx
    problems/
      ProblemsPanel.tsx
    output/
      OutputPanel.tsx
    onboarding/
      OnboardingWizard.tsx
      ShortcutOverlay.tsx
    settings/
      SettingsLayout.tsx
      AppearanceSettings.tsx
      KeybindingSettings.tsx
    command-palette/
      CommandPalette.tsx
      QuickFileOpen.tsx

  stores/
    editor-store.ts
    terminal-store.ts
    ai-store.ts
    session-store.ts
    file-tree-store.ts
    layout-store.ts
    project-store.ts

  lib/
    ws-client.ts                 -- WebSocket client + reconnection
    ws-protocol.ts               -- Message types and serialization
    lsp-client.ts                -- Monaco LSP client factory
    monaco-env.ts                -- Monaco worker configuration
    monaco-config.ts             -- Editor default options
    event-bus.ts                 -- Typed event bus
    shortcuts.ts                 -- Keyboard shortcut registry
    file-icons.ts                -- Extension -> icon mapping
    utils.ts                     -- cn(), formatters, etc.

  lib/theme/
    monaco-theme.ts              -- Monaco theme registration
    xterm-theme.ts               -- xterm theme generation
    tokens.ts                    -- Shared theme token utilities

  hooks/
    use-workspace-connection.ts  -- WebSocket lifecycle hook
    use-file-operations.ts       -- File CRUD via WebSocket
    use-terminal.ts              -- Terminal instance management
    use-shortcut.ts              -- Register keyboard shortcuts
    use-command-palette.ts       -- Command palette state
    use-media-query.ts           -- Responsive breakpoints
    use-debounce.ts

  providers/
    WorkspaceProviders.tsx       -- Composes all workspace providers
    SessionProvider.tsx          -- WebSocket connection context
    FileSystemProvider.tsx       -- File operation context
```

---

*This architecture document is a living specification. It should be updated as implementation decisions are made and new requirements emerge.*
