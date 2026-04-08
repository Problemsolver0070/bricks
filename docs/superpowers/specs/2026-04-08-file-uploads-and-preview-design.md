# File Upload System & Full-Tab Preview — Design Spec

## Goal

Add full file upload support to Bricks chat (images, PDFs, code/text files) with Azure Blob Storage, matching Claude.ai's UX. Plus a full-tab preview mode for build output.

## Scope

- File uploads in both chat mode and build mode
- Azure Blob Storage backend
- Claude content blocks (images, documents, text) for AI processing
- Attachment rendering in message history
- Full-tab preview for build mode
- 25 MB max file size, matching Claude.ai

## Non-Goals

- Video/audio file uploads
- File versioning or editing uploaded files
- Collaborative file sharing between users
- OCR or text extraction from images (Claude handles this natively)

---

## 1. Data Model

### 1.1 Schema Change: `messages.attachments`

Add a nullable JSONB column `attachments` to the existing `messages` table:

```sql
ALTER TABLE messages ADD COLUMN attachments JSONB DEFAULT NULL;
```

Drizzle schema update in `src/lib/db/schema.ts`:

```typescript
attachments: jsonb("attachments").$type<Attachment[] | null>().default(null),
```

### 1.2 Attachment Type

```typescript
// src/lib/types/attachment.ts
export interface Attachment {
  id: string;           // crypto.randomUUID()
  filename: string;     // original filename, e.g. "screenshot.png"
  mimeType: string;     // "image/png", "application/pdf", "text/javascript"
  size: number;         // bytes
  blobUrl: string;      // full Azure Blob URL for retrieval
  blobKey: string;      // storage path: "uploads/{userId}/{attachmentId}/{filename}"
  category: "image" | "pdf" | "code" | "text";
}
```

### 1.3 Category Detection Rules

| MIME type pattern | Category |
|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `image` |
| `application/pdf` | `pdf` |
| `text/*` | `text` or `code` (see below) |
| `application/json`, `application/xml`, `application/javascript`, `application/typescript`, `application/x-python`, `application/x-yaml` | `code` |

Code vs text distinction: files with recognized code extensions (`.js`, `.ts`, `.py`, `.java`, `.go`, `.rs`, `.c`, `.cpp`, `.rb`, `.php`, `.swift`, `.kt`, `.css`, `.html`, `.jsx`, `.tsx`, `.vue`, `.svelte`, `.json`, `.yaml`, `.yml`, `.xml`, `.toml`, `.sql`, `.sh`, `.bash`, `.zsh`, `.dockerfile`, `.graphql`, `.proto`, `.env`, `.gitignore`, `.md`) are `code`. Everything else under `text/*` is `text`.

### 1.4 Store Updates

**Chat store** (`src/stores/chat-store.ts`):

```typescript
export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: Attachment[] | null; // NEW
}
```

**Build layout** (`src/components/build/build-layout.tsx`):

```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[] | null; // NEW
}
```

---

## 2. Azure Blob Storage

### 2.1 Resource Setup

- Storage account: `bricksuploadstore` (or similar, LRS redundancy)
- Container: `uploads`
- Access level: Private (all access via SAS tokens or server-side SDK)
- Region: Same as Azure AI Foundry resource (for low latency when Lambda fetches blobs)

### 2.2 Blob Organization

```
uploads/
  {userId}/
    {attachmentId}/
      {filename}
```

Example: `uploads/a6bafc2c-8a46-4fec-afcc-e2a6f2769551/f47ac10b-58cc-4372-a567-0e02b2c3d479/screenshot.png`

### 2.3 Access Pattern

- **Upload:** Server-side via `@azure/storage-blob` SDK (in `/api/upload` route)
- **Read (for Claude):** Server-side download in Lambda/API route when building message content blocks
- **Read (for UI):** SAS URL with read permission, short expiry (1 hour), generated on-demand when loading messages

### 2.4 Environment Variables

```
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=bricksuploadstore;AccountKey=...;EndpointSuffix=core.windows.net
AZURE_STORAGE_CONTAINER=uploads
```

Both the Next.js app and the Lambda need these.

---

## 3. Upload API

### 3.1 Endpoint: `POST /api/upload`

**File:** `src/app/api/upload/route.ts`

**Request:** `multipart/form-data` with one or more files (field name: `files`)

**Auth:** Clerk JWT required

**Validation:**
- Max file size: 25 MB per file
- Max files per request: 10
- MIME type whitelist (see section 1.3)
- Reject with 413 (too large) or 415 (unsupported type)

**Response (200):**

```json
{
  "attachments": [
    {
      "id": "f47ac10b-...",
      "filename": "screenshot.png",
      "mimeType": "image/png",
      "size": 245000,
      "blobUrl": "https://bricksuploadstore.blob.core.windows.net/uploads/...",
      "blobKey": "uploads/{userId}/{id}/screenshot.png",
      "category": "image"
    }
  ]
}
```

**Implementation notes:**
- Use Next.js built-in `request.formData()` for parsing (no external multipart library needed)
- Upload to Azure Blob via `@azure/storage-blob` `BlockBlobClient.uploadData()`
- Set `Content-Type` on the blob matching the file's MIME type

### 3.2 SAS URL Generation: `GET /api/upload/sas?blobKey=...`

**File:** `src/app/api/upload/sas/route.ts`

Returns a time-limited read-only SAS URL for a given blob key. Used by the frontend to display images and download files.

**Response:**

```json
{
  "url": "https://bricksuploadstore.blob.core.windows.net/uploads/...?sv=...&se=...&sr=b&sp=r&sig=..."
}
```

**Expiry:** 1 hour. Frontend caches these and re-fetches when expired.

---

## 4. Chat API Changes

### 4.1 Updated Request Payload

Both chat paths (Next.js `/api/chat` and Lambda) accept an extended payload:

```json
{
  "message": "What's in this screenshot?",
  "conversationId": "uuid or null",
  "mode": "chat",
  "attachments": [
    {
      "id": "f47ac10b-...",
      "filename": "screenshot.png",
      "mimeType": "image/png",
      "size": 245000,
      "blobUrl": "https://...",
      "blobKey": "uploads/{userId}/{id}/screenshot.png",
      "category": "image"
    }
  ]
}
```

The `attachments` field is optional. When absent, behavior is unchanged.

### 4.2 Message Storage

When saving the user message to DB:

```javascript
await createMessage(conversationId, "user", message.trim(), attachments || null);
```

The `createMessage` function gets an optional `attachments` parameter.

### 4.3 Claude Content Block Building

New function `buildContentBlocks(text, attachments)` in `src/lib/ai/attachments.ts` (and mirrored in Lambda):

```typescript
async function buildContentBlocks(
  text: string,
  attachments: Attachment[] | null
): Promise<string | ContentBlock[]> {
  // No attachments — return plain string (backwards compatible)
  if (!attachments || attachments.length === 0) return text;

  const blocks: ContentBlock[] = [];

  for (const att of attachments) {
    const data = await downloadBlob(att.blobKey); // returns Buffer

    if (att.category === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: att.mimeType,
          data: data.toString("base64"),
        },
      });
    } else if (att.category === "pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: data.toString("base64"),
        },
      });
    } else {
      // code/text — inline as text with filename header
      const fileContent = data.toString("utf-8");
      const ext = att.filename.split(".").pop() || "";
      blocks.push({
        type: "text",
        text: `File: ${att.filename}\n\`\`\`${ext}\n${fileContent}\n\`\`\``,
      });
    }
  }

  // Add the user's text message last
  if (text.trim()) {
    blocks.push({ type: "text", text });
  }

  return blocks;
}
```

### 4.4 History Reconstruction

When loading message history from DB, messages with attachments need their `content` rebuilt as content blocks for Claude. The `buildChatMessages` function is updated to handle this:

- Messages with `attachments: null` → `content: string` (as today)
- Messages with `attachments: [...]` → `content: ContentBlock[]` (fetch blob content, build blocks)

**Optimization:** For history messages (not the current message), we can skip re-fetching images from blob storage and instead just include the text content. Claude doesn't need to re-see old images to maintain context in most cases. Only the **current** message's attachments are fully materialized. This keeps latency low.

If the user explicitly references an old image ("go back to that screenshot"), Claude will still have the text context from when it was first sent.

---

## 5. Frontend: Chat Input with Attachments

### 5.1 Attachment State

New Zustand store slice or local state in the input component:

```typescript
interface PendingAttachment {
  id: string;           // temp ID
  file: File;           // browser File object
  filename: string;
  mimeType: string;
  size: number;
  category: "image" | "pdf" | "code" | "text";
  status: "uploading" | "ready" | "error";
  progress: number;     // 0-100
  attachment?: Attachment; // populated after upload completes
  previewUrl?: string;  // local object URL for image preview
}
```

### 5.2 Shared Attachment Input Component

**File:** `src/components/chat/attachment-input.tsx`

A reusable component used by both `chat-input.tsx` and `build-layout.tsx`:

- Paperclip button that opens a file picker (multi-select)
- Handles drag-and-drop events
- Handles clipboard paste (images)
- Validates file size and type client-side before upload
- Shows upload progress
- Renders attachment previews above the textarea
- Provides `pendingAttachments` and `removeAttachment` to the parent

### 5.3 Attachment Preview Chips (in composer)

**File:** `src/components/chat/attachment-preview.tsx`

Renders the row of attachment previews above the textarea:

- **Images:** 48x48 thumbnail with rounded corners, X button overlay
- **PDFs:** PDF icon + filename (truncated), X button
- **Code/text:** Code file icon + filename (truncated), X button
- Upload spinner overlay while `status === "uploading"`
- Error state with retry option

### 5.4 Message Attachment Display (in history)

**File:** `src/components/chat/message-attachments.tsx`

Renders attachments within a message bubble:

- **Images:** Rendered inline, max-width 400px, rounded corners, clickable to open full-size in a lightbox/modal
- **PDFs:** Download chip with PDF icon and filename
- **Code/text:** Collapsible code block with syntax-highlighted content (filename as header)

This component fetches SAS URLs on mount via `/api/upload/sas?blobKey=...` for secure access.

### 5.5 Updated Chat Input Flow

1. User clicks paperclip / drops files / pastes image
2. Files are validated client-side (size, type)
3. Each file uploads to `POST /api/upload` immediately
4. Preview chips appear above textarea with upload progress
5. User types message text
6. User hits Send → payload includes `message` + `attachments` array (only `ready` attachments)
7. Send button disabled while any attachment is still `uploading`

### 5.6 Build Layout Integration

The `build-layout.tsx` inline chat gets the same attachment support by importing `AttachmentInput` and `AttachmentPreview`. The `handleSend` function is updated to include attachments in the payload.

---

## 6. Full-Tab Preview

### 6.1 Component Update

**File:** `src/components/build/preview-panel.tsx`

Add an expand/maximize button to the preview toolbar (next to the refresh button):

```tsx
<Button variant="ghost" size="icon-xs" onClick={() => setFullscreen(true)}>
  <Maximize2 className="h-3.5 w-3.5" />
</Button>
```

### 6.2 Fullscreen Overlay

When fullscreen is active, render a fixed overlay:

```tsx
{isFullscreen && (
  <div className="fixed inset-0 z-50 bg-background">
    <div className="flex h-10 items-center justify-between border-b px-4">
      <span className="text-sm font-medium">Preview</span>
      <div className="flex gap-2">
        <Button variant="ghost" size="icon-xs" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setFullscreen(false)}>
          <Minimize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
    <iframe ... className="flex-1 w-full h-[calc(100vh-40px)]" />
  </div>
)}
```

- ESC key closes fullscreen (`useEffect` with `keydown` listener)
- Same iframe content (static srcdoc or WebContainer URL)

---

## 7. Lambda Updates

The Lambda handler (`lambda-chat/index.mjs`) needs:

1. **`@azure/storage-blob` dependency** added to `lambda-chat/package.json`
2. **`AZURE_STORAGE_CONNECTION_STRING`** and **`AZURE_STORAGE_CONTAINER`** env vars
3. **Parse `attachments`** from the request body
4. **`buildContentBlocks()`** function (mirrored from the Next.js side)
5. **`downloadBlob()`** helper to fetch file content from Azure Blob
6. **Updated `createMessage()`** to accept and store attachments
7. **Updated message history loading** to pass attachments when building Claude messages

The Lambda's message-building logic must handle both formats:
- `content: string` for messages without attachments (backwards compatible)
- `content: ContentBlock[]` for messages with attachments

---

## 8. Migration & Backwards Compatibility

- The `attachments` column is nullable with a default of null — no impact on existing messages
- The `buildChatMessages` and `buildContentBlocks` functions handle both `null` and populated attachments
- The chat UI renders messages without attachments exactly as before
- No data migration needed — existing conversations continue to work unchanged

---

## 9. File & Dependency Summary

### New Files
- `src/lib/types/attachment.ts` — Attachment type definition
- `src/lib/storage/azure-blob.ts` — Azure Blob Storage client (upload, download, SAS generation)
- `src/app/api/upload/route.ts` — Upload endpoint
- `src/app/api/upload/sas/route.ts` — SAS URL generation endpoint
- `src/lib/ai/attachments.ts` — Content block builder for Claude
- `src/components/chat/attachment-input.tsx` — File picker, drag-and-drop, paste handler
- `src/components/chat/attachment-preview.tsx` — Preview chips in composer
- `src/components/chat/message-attachments.tsx` — Attachment rendering in message history

### Modified Files
- `src/lib/db/schema.ts` — Add `attachments` JSONB column to messages
- `src/lib/db/queries.ts` — Update `createMessage` to accept attachments
- `src/stores/chat-store.ts` — Add `attachments` to `ChatMessageItem`
- `src/components/chat/chat-input.tsx` — Integrate attachment input, update send payload
- `src/components/chat/message-bubble.tsx` — Render attachments in messages
- `src/components/build/build-layout.tsx` — Integrate attachment input, update send payload
- `src/components/build/preview-panel.tsx` — Add fullscreen toggle
- `src/app/api/chat/route.ts` — Handle attachments in request, build content blocks
- `src/lib/ai/prompts.ts` — Update buildChatMessages for content block arrays
- `lambda-chat/index.mjs` — Full attachment support (parse, store, fetch, build blocks)
- `lambda-chat/package.json` — Add `@azure/storage-blob`

### New Dependencies
- `@azure/storage-blob` (both main app and Lambda)
