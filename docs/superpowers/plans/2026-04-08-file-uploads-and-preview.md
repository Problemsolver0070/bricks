# File Upload System & Full-Tab Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full file upload support (images, PDFs, code/text) with Azure Blob Storage to both chat and build mode, matching Claude.ai's UX, plus a fullscreen preview toggle for build mode.

**Architecture:** Files are uploaded to Azure Blob Storage via a `/api/upload` endpoint, stored as attachment metadata (JSONB) on messages, fetched and converted to Claude content blocks (image/document/text) when building the AI prompt. The frontend uses a shared attachment input component for both chat and build modes.

**Tech Stack:** Azure Blob Storage (`@azure/storage-blob`), Next.js API routes, Anthropic Foundry SDK content blocks, Zustand, React

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `src/lib/types/attachment.ts` | Attachment type definition, category detection, MIME whitelist |
| `src/lib/storage/azure-blob.ts` | Azure Blob Storage client: upload, download, SAS URL generation |
| `src/lib/ai/attachments.ts` | Build Claude content blocks from attachments |
| `src/app/api/upload/route.ts` | File upload endpoint (multipart) |
| `src/app/api/upload/sas/route.ts` | SAS URL generation endpoint |
| `src/components/chat/attachment-button.tsx` | Paperclip button + file picker + drag-drop + paste |
| `src/components/chat/attachment-preview.tsx` | Preview chips row in composer |
| `src/components/chat/message-attachments.tsx` | Attachment rendering in message history |

### Modified Files
| File | Change |
|---|---|
| `src/lib/db/schema.ts` | Add `attachments` JSONB column to messages |
| `src/lib/db/queries.ts` | Update `createMessage` to accept attachments, update `getMessages` return |
| `src/stores/chat-store.ts` | Add `attachments` to `ChatMessageItem` |
| `src/lib/ai/prompts.ts` | Update `ChatMessage` type and `buildChatMessages` for content blocks |
| `src/app/api/chat/route.ts` | Parse attachments, build content blocks, pass to Claude |
| `src/components/chat/chat-input.tsx` | Integrate attachment button/preview, send attachments |
| `src/components/chat/message-bubble.tsx` | Render attachments in messages |
| `src/components/build/build-layout.tsx` | Integrate attachment button/preview, send attachments |
| `src/components/build/preview-panel.tsx` | Add fullscreen toggle |
| `lambda-chat/index.mjs` | Full attachment support (parse, store, fetch blobs, build content blocks) |
| `lambda-chat/package.json` | Add `@azure/storage-blob` |
| `package.json` | Add `@azure/storage-blob` |

---

### Task 1: Azure Blob Storage Setup & Client Library

**Files:**
- Create: `src/lib/types/attachment.ts`
- Create: `src/lib/storage/azure-blob.ts`
- Modify: `package.json` (add dependency)

- [ ] **Step 1: Install `@azure/storage-blob`**

```bash
cd /home/venu/Desktop/Bricks && npm install @azure/storage-blob
```

- [ ] **Step 2: Create the Attachment type and helpers**

Create `src/lib/types/attachment.ts`:

```typescript
export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  blobUrl: string;
  blobKey: string;
  category: "image" | "pdf" | "code" | "text";
}

export interface PendingAttachment {
  id: string;
  file: File;
  filename: string;
  mimeType: string;
  size: number;
  category: "image" | "pdf" | "code" | "text";
  status: "uploading" | "ready" | "error";
  progress: number;
  attachment?: Attachment;
  previewUrl?: string;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const PDF_TYPES = new Set(["application/pdf"]);

const CODE_EXTENSIONS = new Set([
  "js", "ts", "py", "java", "go", "rs", "c", "cpp", "rb", "php",
  "swift", "kt", "css", "html", "jsx", "tsx", "vue", "svelte",
  "json", "yaml", "yml", "xml", "toml", "sql", "sh", "bash", "zsh",
  "dockerfile", "graphql", "proto", "env", "gitignore", "md",
]);

const CODE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-python",
  "application/x-yaml",
]);

const ALLOWED_MIME_PREFIXES = ["image/", "text/", "application/"];

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_FILES_PER_UPLOAD = 10;

export function detectCategory(
  mimeType: string,
  filename: string
): "image" | "pdf" | "code" | "text" {
  if (IMAGE_TYPES.has(mimeType)) return "image";
  if (PDF_TYPES.has(mimeType)) return "pdf";
  if (CODE_MIME_TYPES.has(mimeType)) return "code";

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (mimeType.startsWith("text/")) return "text";

  return "text";
}

export function isAllowedMimeType(mimeType: string): boolean {
  if (IMAGE_TYPES.has(mimeType)) return true;
  if (PDF_TYPES.has(mimeType)) return true;
  if (CODE_MIME_TYPES.has(mimeType)) return true;
  if (mimeType.startsWith("text/")) return true;
  return false;
}
```

- [ ] **Step 3: Create the Azure Blob Storage client**

Create `src/lib/storage/azure-blob.ts`:

```typescript
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";

let _blobServiceClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  if (!_blobServiceClient) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error("AZURE_STORAGE_CONNECTION_STRING not configured");
    }
    _blobServiceClient =
      BlobServiceClient.fromConnectionString(connectionString);
  }
  return _blobServiceClient;
}

function getContainerName(): string {
  return process.env.AZURE_STORAGE_CONTAINER || "uploads";
}

export async function uploadBlob(
  blobKey: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(getContainerName());
  const blockBlob = container.getBlockBlobClient(blobKey);

  await blockBlob.uploadData(data, {
    blobHTTPHeaders: { blobContentType: contentType },
  });

  return blockBlob.url;
}

export async function downloadBlob(blobKey: string): Promise<Buffer> {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(getContainerName());
  const blockBlob = container.getBlockBlobClient(blobKey);

  const response = await blockBlob.download(0);
  const chunks: Buffer[] = [];

  if (response.readableStreamBody) {
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }

  return Buffer.concat(chunks);
}

export function generateSasUrl(blobKey: string): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING!;
  const accountName = connectionString.match(/AccountName=([^;]+)/)?.[1];
  const accountKey = connectionString.match(/AccountKey=([^;]+)/)?.[1];

  if (!accountName || !accountKey) {
    throw new Error("Could not parse storage account credentials");
  }

  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const containerName = getContainerName();

  const expiresOn = new Date();
  expiresOn.setHours(expiresOn.getHours() + 1);

  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobKey,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
      protocol: SASProtocol.Https,
    },
    credential
  ).toString();

  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobKey}?${sas}`;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/types/attachment.ts src/lib/storage/azure-blob.ts package.json package-lock.json
git commit -m "feat: add Attachment types and Azure Blob Storage client"
```

---

### Task 2: Database Schema & Query Updates

**Files:**
- Modify: `src/lib/db/schema.ts:64` (add attachments column)
- Modify: `src/lib/db/queries.ts:134-151` (update createMessage)

- [ ] **Step 1: Add `attachments` column to messages table in schema**

In `src/lib/db/schema.ts`, add a line after `content: text("content").notNull(),` (line 64):

```typescript
    attachments: jsonb("attachments").$type<Attachment[] | null>().default(null),
```

Also add the import at top of file:

```typescript
import type { Attachment } from "@/lib/types/attachment";
```

- [ ] **Step 2: Run the schema migration**

```bash
cd /home/venu/Desktop/Bricks && npx drizzle-kit push
```

This adds the `attachments` JSONB column to the existing `messages` table. Existing rows get `null` as default.

- [ ] **Step 3: Update `createMessage` in queries.ts**

In `src/lib/db/queries.ts`, change the `createMessage` function (lines 134-151):

From:
```typescript
export async function createMessage(
  conversationId: string,
  role: string,
  content: string
): Promise<Message> {
  const [message] = await db
    .insert(messages)
    .values({ conversationId, role, content })
    .returning();
```

To:
```typescript
export async function createMessage(
  conversationId: string,
  role: string,
  content: string,
  attachments?: Attachment[] | null
): Promise<Message> {
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      content,
      ...(attachments ? { attachments } : {}),
    })
    .returning();
```

Add import at top: `import type { Attachment } from "@/lib/types/attachment";`

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.ts src/lib/db/queries.ts
git commit -m "feat: add attachments JSONB column to messages table"
```

---

### Task 3: Upload API Endpoints

**Files:**
- Create: `src/app/api/upload/route.ts`
- Create: `src/app/api/upload/sas/route.ts`

- [ ] **Step 1: Create the upload endpoint**

Create `src/app/api/upload/route.ts`:

```typescript
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getUserByClerkId } from "@/lib/db/queries";
import { uploadBlob } from "@/lib/storage/azure-blob";
import {
  type Attachment,
  detectCategory,
  isAllowedMimeType,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
} from "@/lib/types/attachment";

export async function POST(req: NextRequest) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { error: "No files provided" },
        { status: 400 }
      );
    }

    if (files.length > MAX_FILES_PER_UPLOAD) {
      return NextResponse.json(
        { error: `Maximum ${MAX_FILES_PER_UPLOAD} files per upload` },
        { status: 400 }
      );
    }

    const attachments: Attachment[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File "${file.name}" exceeds 25 MB limit` },
          { status: 413 }
        );
      }

      if (!isAllowedMimeType(file.type)) {
        return NextResponse.json(
          { error: `File type "${file.type}" is not supported` },
          { status: 415 }
        );
      }

      const id = crypto.randomUUID();
      const blobKey = `uploads/${user.id}/${id}/${file.name}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      const blobUrl = await uploadBlob(blobKey, buffer, file.type);
      const category = detectCategory(file.type, file.name);

      attachments.push({
        id,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        blobUrl,
        blobKey,
        category,
      });
    }

    return NextResponse.json({ attachments });
  } catch (error) {
    console.error("POST /api/upload error:", error);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create the SAS URL endpoint**

Create `src/app/api/upload/sas/route.ts`:

```typescript
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getUserByClerkId } from "@/lib/db/queries";
import { generateSasUrl } from "@/lib/storage/azure-blob";

export async function GET(req: NextRequest) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const blobKey = req.nextUrl.searchParams.get("blobKey");
    if (!blobKey) {
      return NextResponse.json(
        { error: "blobKey parameter required" },
        { status: 400 }
      );
    }

    // Security: verify the blob belongs to this user
    if (!blobKey.startsWith(`uploads/${user.id}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = generateSasUrl(blobKey);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("GET /api/upload/sas error:", error);
    return NextResponse.json(
      { error: "Failed to generate SAS URL" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/upload/route.ts src/app/api/upload/sas/route.ts
git commit -m "feat: add /api/upload and /api/upload/sas endpoints"
```

---

### Task 4: Claude Content Block Builder

**Files:**
- Create: `src/lib/ai/attachments.ts`
- Modify: `src/lib/ai/prompts.ts:60-90`

- [ ] **Step 1: Create the content block builder**

Create `src/lib/ai/attachments.ts`:

```typescript
import type { Attachment } from "@/lib/types/attachment";
import { downloadBlob } from "@/lib/storage/azure-blob";

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
    };

export async function buildContentBlocks(
  text: string,
  attachments: Attachment[] | null | undefined
): Promise<string | ContentBlock[]> {
  if (!attachments || attachments.length === 0) return text;

  const blocks: ContentBlock[] = [];

  for (const att of attachments) {
    const data = await downloadBlob(att.blobKey);

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
      const fileContent = data.toString("utf-8");
      const ext = att.filename.split(".").pop() || "";
      blocks.push({
        type: "text",
        text: `File: ${att.filename}\n\`\`\`${ext}\n${fileContent}\n\`\`\``,
      });
    }
  }

  if (text.trim()) {
    blocks.push({ type: "text", text });
  }

  return blocks;
}

/**
 * For history messages, we include a text summary of attachments
 * instead of re-fetching the full blob content. Only the current
 * message gets full content blocks.
 */
export function summarizeAttachments(
  text: string,
  attachments: Attachment[] | null | undefined
): string {
  if (!attachments || attachments.length === 0) return text;

  const summaries = attachments.map((att) => {
    if (att.category === "image") {
      return `[Attached image: ${att.filename}]`;
    } else if (att.category === "pdf") {
      return `[Attached PDF: ${att.filename}]`;
    } else {
      return `[Attached file: ${att.filename}]`;
    }
  });

  return [...summaries, text].filter(Boolean).join("\n");
}
```

- [ ] **Step 2: Update `buildChatMessages` in prompts.ts**

In `src/lib/ai/prompts.ts`, update the `ChatMessage` type (lines 60-63) and function:

Change the `ChatMessage` interface from:
```typescript
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
```
To:
```typescript
interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}
```

Add import at top of file:
```typescript
import type { ContentBlock } from "@/lib/ai/attachments";
```

The `buildChatMessages` function signature and body stay the same — content block construction happens in the API route before calling this function. The type change just allows the function to accept pre-built content blocks.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/attachments.ts src/lib/ai/prompts.ts
git commit -m "feat: Claude content block builder for file attachments"
```

---

### Task 5: Update Chat Store

**Files:**
- Modify: `src/stores/chat-store.ts:3-8`

- [ ] **Step 1: Add attachments to ChatMessageItem**

In `src/stores/chat-store.ts`, change lines 3-8:

From:
```typescript
export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
```

To:
```typescript
import type { Attachment } from "@/lib/types/attachment";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: Attachment[] | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/chat-store.ts
git commit -m "feat: add attachments to ChatMessageItem type"
```

---

### Task 6: Next.js Chat API — Handle Attachments

**Files:**
- Modify: `src/app/api/chat/route.ts`

- [ ] **Step 1: Update the chat route to parse and pass attachments**

In `src/app/api/chat/route.ts`:

Add imports at top:
```typescript
import { buildContentBlocks, summarizeAttachments } from "@/lib/ai/attachments";
import type { Attachment } from "@/lib/types/attachment";
```

Update the body destructuring (around line 77) from:
```typescript
      const {
        message,
        conversationId: incomingConversationId,
        mode = "chat",
      } = body as {
        message?: string;
        conversationId?: string;
        mode?: "chat" | "build";
      };
```
To:
```typescript
      const {
        message,
        conversationId: incomingConversationId,
        mode = "chat",
        attachments: incomingAttachments,
      } = body as {
        message?: string;
        conversationId?: string;
        mode?: "chat" | "build";
        attachments?: Attachment[];
      };
```

Update the `createMessage` call (around line 110) from:
```typescript
      await createMessage(conversationId!, "user", message.trim());
```
To:
```typescript
      await createMessage(
        conversationId!,
        "user",
        message.trim(),
        incomingAttachments?.length ? incomingAttachments : null
      );
```

Update history message mapping (around lines 113-119). Change the `.map` from:
```typescript
      const history = recentMessages.slice(0, -1).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
```
To:
```typescript
      const history = recentMessages.slice(0, -1).map((m) => ({
        role: m.role as "user" | "assistant",
        content: summarizeAttachments(m.content, m.attachments as Attachment[] | null),
      }));
```

After building `msgs` from `buildChatMessages`, replace the last user message content with full content blocks. Add this before the `getClient().messages.stream()` call:

```typescript
      // Build content blocks for the current message's attachments
      if (incomingAttachments?.length) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.role === "user") {
          lastMsg.content = await buildContentBlocks(
            message.trim(),
            incomingAttachments
          );
        }
      }
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/chat/route.ts
git commit -m "feat: handle file attachments in chat API route"
```

---

### Task 7: Attachment UI Components

**Files:**
- Create: `src/components/chat/attachment-button.tsx`
- Create: `src/components/chat/attachment-preview.tsx`
- Create: `src/components/chat/message-attachments.tsx`

- [ ] **Step 1: Create the attachment button component**

Create `src/components/chat/attachment-button.tsx`:

```tsx
"use client";

import { useRef, useCallback } from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type PendingAttachment,
  type Attachment,
  detectCategory,
  isAllowedMimeType,
  MAX_FILE_SIZE,
} from "@/lib/types/attachment";

interface AttachmentButtonProps {
  onFilesSelected: (pending: PendingAttachment[]) => void;
  disabled?: boolean;
}

export function AttachmentButton({
  onFilesSelected,
  disabled,
}: AttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      const pending: PendingAttachment[] = [];

      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          alert(`"${file.name}" exceeds 25 MB limit`);
          continue;
        }
        if (!isAllowedMimeType(file.type) && !file.name.match(/\.\w+$/)) {
          alert(`"${file.name}" is not a supported file type`);
          continue;
        }

        const id = crypto.randomUUID();
        const category = detectCategory(file.type, file.name);

        pending.push({
          id,
          file,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          category,
          status: "uploading",
          progress: 0,
          previewUrl:
            category === "image" ? URL.createObjectURL(file) : undefined,
        });
      }

      if (pending.length > 0) onFilesSelected(pending);
    },
    [onFilesSelected]
  );

  const handleClick = () => inputRef.current?.click();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleChange}
        accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.c,.cpp,.rb,.php,.css,.html,.vue,.svelte,.yaml,.yml,.xml,.toml,.sql,.sh,.env,.csv"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleClick}
        disabled={disabled}
        className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
        title="Attach files"
      >
        <Paperclip className="h-4 w-4" />
      </Button>
    </>
  );
}

/**
 * Upload a PendingAttachment to the server.
 * Returns the server Attachment metadata on success.
 */
export async function uploadFile(
  file: File,
  token: string | null
): Promise<Attachment> {
  const formData = new FormData();
  formData.append("files", file);

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Upload failed");
  }

  const data = await res.json();
  return data.attachments[0];
}
```

- [ ] **Step 2: Create the attachment preview component**

Create `src/components/chat/attachment-preview.tsx`:

```tsx
"use client";

import { X, FileText, FileCode, FileImage, Loader2 } from "lucide-react";
import type { PendingAttachment } from "@/lib/types/attachment";

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentPreview({
  attachments,
  onRemove,
}: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group relative flex items-center gap-2 rounded-lg border border-border/50 bg-muted/50 px-3 py-2 text-sm"
        >
          {/* Icon / Thumbnail */}
          {att.category === "image" && att.previewUrl ? (
            <img
              src={att.previewUrl}
              alt={att.filename}
              className="h-10 w-10 rounded object-cover"
            />
          ) : att.category === "pdf" ? (
            <FileText className="h-5 w-5 text-red-400" />
          ) : att.category === "code" ? (
            <FileCode className="h-5 w-5 text-blue-400" />
          ) : (
            <FileImage className="h-5 w-5 text-muted-foreground" />
          )}

          {/* Filename */}
          <span className="max-w-[120px] truncate text-xs text-foreground">
            {att.filename}
          </span>

          {/* Upload spinner */}
          {att.status === "uploading" && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}

          {/* Error indicator */}
          {att.status === "error" && (
            <span className="text-xs text-destructive">Failed</span>
          )}

          {/* Remove button */}
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            className="ml-1 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create the message attachments display component**

Create `src/components/chat/message-attachments.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { FileText, FileCode, Download } from "lucide-react";
import type { Attachment } from "@/lib/types/attachment";

interface MessageAttachmentsProps {
  attachments: Attachment[];
}

// Simple SAS URL cache to avoid re-fetching
const sasCache = new Map<string, { url: string; expiresAt: number }>();

async function getSasUrl(blobKey: string): Promise<string> {
  const cached = sasCache.get(blobKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const res = await fetch(
    `/api/upload/sas?blobKey=${encodeURIComponent(blobKey)}`
  );
  if (!res.ok) throw new Error("Failed to get SAS URL");
  const { url } = await res.json();

  // Cache for 50 minutes (SAS expires in 60)
  sasCache.set(blobKey, { url, expiresAt: Date.now() + 50 * 60 * 1000 });
  return url;
}

function ImageAttachment({ att }: { att: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    getSasUrl(att.blobKey).then(setUrl).catch(() => {});
  }, [att.blobKey]);

  if (!url) return <div className="h-32 w-48 animate-pulse rounded-lg bg-muted" />;

  return (
    <>
      <img
        src={url}
        alt={att.filename}
        className="max-w-[400px] cursor-pointer rounded-lg border border-border/30 transition-transform hover:scale-[1.02]"
        onClick={() => setExpanded(true)}
      />
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setExpanded(false)}
        >
          <img
            src={url}
            alt={att.filename}
            className="max-h-[90vh] max-w-[90vw] rounded-lg"
          />
        </div>
      )}
    </>
  );
}

function FileAttachment({ att }: { att: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    getSasUrl(att.blobKey).then(setUrl).catch(() => {});
  }, [att.blobKey]);

  const Icon = att.category === "pdf" ? FileText : FileCode;

  return (
    <a
      href={url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/60"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="max-w-[200px] truncate">{att.filename}</span>
      <Download className="h-3 w-3 text-muted-foreground" />
    </a>
  );
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter((a) => a.category === "image");
  const files = attachments.filter((a) => a.category !== "image");

  return (
    <div className="flex flex-col gap-2">
      {/* Image grid */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((att) => (
            <ImageAttachment key={att.id} att={att} />
          ))}
        </div>
      )}

      {/* File chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((att) => (
            <FileAttachment key={att.id} att={att} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/attachment-button.tsx src/components/chat/attachment-preview.tsx src/components/chat/message-attachments.tsx
git commit -m "feat: attachment UI components (button, preview, message display)"
```

---

### Task 8: Integrate Attachments into Chat Input

**Files:**
- Modify: `src/components/chat/chat-input.tsx`
- Modify: `src/components/chat/message-bubble.tsx`

- [ ] **Step 1: Update chat-input.tsx with attachment support**

In `src/components/chat/chat-input.tsx`, add these imports at the top (after existing imports):

```typescript
import { AttachmentButton, uploadFile } from "./attachment-button";
import { AttachmentPreview } from "./attachment-preview";
import type { PendingAttachment, Attachment } from "@/lib/types/attachment";
```

Add state for pending attachments inside the component (after the existing state declarations around line 29):

```typescript
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
```

Add the file selection handler and upload logic (after the state declarations):

```typescript
  const handleFilesSelected = useCallback(
    async (newPending: PendingAttachment[]) => {
      setPendingAttachments((prev) => [...prev, ...newPending]);

      const token = await getToken();
      for (const pending of newPending) {
        try {
          const attachment = await uploadFile(pending.file, token);
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.id === pending.id
                ? { ...p, status: "ready" as const, attachment }
                : p
            )
          );
        } catch {
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.id === pending.id ? { ...p, status: "error" as const } : p
            )
          );
        }
      }
    },
    [getToken]
  );

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((p) => p.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);
```

Update the `sendMessage` callback:

1. Collect ready attachments at the top of `sendMessage`:
```typescript
    const readyAttachments: Attachment[] = pendingAttachments
      .filter((p) => p.status === "ready" && p.attachment)
      .map((p) => p.attachment!);
```

2. Include attachments in `addMessage` call (after the user message creation):
```typescript
    addMessage({
      id: tempUserId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      attachments: readyAttachments.length > 0 ? readyAttachments : undefined,
    });
```

3. Clear pending attachments after adding the message:
```typescript
    setPendingAttachments([]);
```

4. Update the fetch body to include attachments:
```typescript
        body: JSON.stringify({
          message: trimmed,
          conversationId,
          mode,
          attachments: readyAttachments.length > 0 ? readyAttachments : undefined,
        }),
```

5. Add `pendingAttachments` and `handleFilesSelected` to the dependency array.

Update the send button disabled check to also block while uploads are in progress:

```typescript
  const uploading = pendingAttachments.some((p) => p.status === "uploading");
```

Update the JSX to include the attachment button and preview. Change the return JSX to:

```tsx
    <div className="border-t border-border/50 bg-card/50 backdrop-blur-sm">
      <div className="mx-auto max-w-3xl p-4">
        {/* Attachment previews */}
        <AttachmentPreview
          attachments={pendingAttachments}
          onRemove={removeAttachment}
        />
        <div className="flex items-end gap-2">
          {/* Attachment button */}
          <AttachmentButton
            onFilesSelected={handleFilesSelected}
            disabled={isStreaming}
          />
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "build"
                ? "Describe what you want to build..."
                : "Ask The Fixer anything..."
            }
            disabled={isStreaming}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-input bg-background px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
            style={{ minHeight: "48px", maxHeight: "200px" }}
          />
          <Button
            onClick={sendMessage}
            disabled={isStreaming || (value.trim().length === 0 && pendingAttachments.length === 0) || uploading}
            size="icon"
            className="h-12 w-12 shrink-0 rounded-xl"
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
```

Also add drag-and-drop support by wrapping the outer div with `onDragOver` and `onDrop`:

```tsx
    <div
      className="border-t border-border/50 bg-card/50 backdrop-blur-sm"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files.length > 0) {
          handleFilesSelected(
            Array.from(e.dataTransfer.files).map((file) => ({
              id: crypto.randomUUID(),
              file,
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              size: file.size,
              category: detectCategory(file.type, file.name) as PendingAttachment["category"],
              status: "uploading" as const,
              progress: 0,
              previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
            }))
          );
        }
      }}
    >
```

Add `detectCategory` to the imports from `@/lib/types/attachment`.

- [ ] **Step 2: Update message-bubble.tsx to render attachments**

In `src/components/chat/message-bubble.tsx`, add import:

```typescript
import { MessageAttachments } from "./message-attachments";
import type { Attachment } from "@/lib/types/attachment";
```

Update the props interface:
```typescript
interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  attachments?: Attachment[] | null;
}
```

Update the component signature to destructure `attachments`:
```typescript
export function MessageBubble({
  role,
  content,
  isStreaming = false,
  attachments,
}: MessageBubbleProps) {
```

Add attachments rendering inside the message bubble, before the text content:

For user messages (line ~65), change:
```tsx
            <p className="whitespace-pre-wrap">{content}</p>
```
To:
```tsx
            <>
              {attachments && <MessageAttachments attachments={attachments} />}
              <p className="whitespace-pre-wrap">{content}</p>
            </>
```

For assistant messages (the ReactMarkdown section), no attachment rendering needed — assistants don't have attachments.

- [ ] **Step 3: Update chat-messages.tsx to pass attachments**

In `src/components/chat/chat-messages.tsx`, update the `MessageBubble` usage (around line 42-46):

From:
```tsx
          <MessageBubble
            key={msg.id}
            role={msg.role}
            content={msg.content}
          />
```
To:
```tsx
          <MessageBubble
            key={msg.id}
            role={msg.role}
            content={msg.content}
            attachments={msg.attachments}
          />
```

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/chat-input.tsx src/components/chat/message-bubble.tsx src/components/chat/chat-messages.tsx
git commit -m "feat: integrate file attachments into chat input and message display"
```

---

### Task 9: Integrate Attachments into Build Layout

**Files:**
- Modify: `src/components/build/build-layout.tsx`

- [ ] **Step 1: Add attachment support to build-layout.tsx**

Add imports at top:
```typescript
import { AttachmentButton, uploadFile } from "@/components/chat/attachment-button";
import { AttachmentPreview } from "@/components/chat/attachment-preview";
import { MessageAttachments } from "@/components/chat/message-attachments";
import type { PendingAttachment, Attachment } from "@/lib/types/attachment";
import { detectCategory } from "@/lib/types/attachment";
```

Update the `ChatMessage` interface:
```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[] | null;
}
```

Add state inside the component (after existing state declarations):
```typescript
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
```

Add handlers (same pattern as chat-input):
```typescript
  const handleFilesSelected = useCallback(
    async (newPending: PendingAttachment[]) => {
      setPendingAttachments((prev) => [...prev, ...newPending]);
      const token = await getToken();
      for (const pending of newPending) {
        try {
          const attachment = await uploadFile(pending.file, token);
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.id === pending.id
                ? { ...p, status: "ready" as const, attachment }
                : p
            )
          );
        } catch {
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.id === pending.id ? { ...p, status: "error" as const } : p
            )
          );
        }
      }
    },
    [getToken]
  );

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((p) => p.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);
```

In `handleSend`, collect ready attachments and include in the message and fetch body (same pattern as Task 8).

Update the input area JSX to include the attachment button and preview — same layout as Task 8 but using the build mode's textarea styling.

Update the message rendering to show attachments — add `<MessageAttachments>` before the message content text for user messages.

- [ ] **Step 2: Commit**

```bash
git add src/components/build/build-layout.tsx
git commit -m "feat: integrate file attachments into build mode chat"
```

---

### Task 10: Lambda — Azure Blob & Attachment Support

**Files:**
- Modify: `lambda-chat/package.json`
- Modify: `lambda-chat/index.mjs`

- [ ] **Step 1: Install `@azure/storage-blob` in Lambda**

```bash
cd /home/venu/Desktop/Bricks/lambda-chat && npm install @azure/storage-blob
```

- [ ] **Step 2: Add Azure Blob download function to Lambda**

At the top of `lambda-chat/index.mjs`, add import:

```javascript
import { BlobServiceClient } from "@azure/storage-blob";
```

Add the blob download helper (after the existing singletons section):

```javascript
let _blobServiceClient = null;

function getBlobServiceClient() {
  if (!_blobServiceClient) {
    _blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING
    );
  }
  return _blobServiceClient;
}

async function downloadBlob(blobKey) {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(
    process.env.AZURE_STORAGE_CONTAINER || "uploads"
  );
  const blockBlob = container.getBlockBlobClient(blobKey);
  const response = await blockBlob.download(0);
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
```

- [ ] **Step 3: Add content block builder to Lambda**

Add after the `downloadBlob` function:

```javascript
async function buildContentBlocks(text, attachments) {
  if (!attachments || attachments.length === 0) return text;

  const blocks = [];

  for (const att of attachments) {
    const data = await downloadBlob(att.blobKey);

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
      const fileContent = data.toString("utf-8");
      const ext = att.filename.split(".").pop() || "";
      blocks.push({
        type: "text",
        text: `File: ${att.filename}\n\`\`\`${ext}\n${fileContent}\n\`\`\``,
      });
    }
  }

  if (text.trim()) {
    blocks.push({ type: "text", text });
  }

  return blocks;
}

function summarizeAttachments(text, attachments) {
  if (!attachments || attachments.length === 0) return text;
  const summaries = attachments.map((att) => {
    if (att.category === "image") return `[Attached image: ${att.filename}]`;
    if (att.category === "pdf") return `[Attached PDF: ${att.filename}]`;
    return `[Attached file: ${att.filename}]`;
  });
  return [...summaries, text].filter(Boolean).join("\n");
}
```

- [ ] **Step 4: Update Lambda's messages schema to include attachments**

In the Lambda's mirrored schema (around line 37-43), add the attachments column:

```javascript
const messages = pgTable("messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  attachments: jsonb("attachments"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 5: Update Lambda's `createMessage` to accept attachments**

Change the `createMessage` function:

```javascript
async function createMessage(conversationId, role, content, attachments = null) {
  const db = getDb();
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      content,
      ...(attachments ? { attachments } : {}),
    })
    .returning();
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
  return message;
}
```

- [ ] **Step 6: Update Lambda handler to parse and use attachments**

In the body parsing section, update the destructuring:

```javascript
const { message, conversationId: incomingConversationId, mode = "chat", attachments: incomingAttachments } = body;
```

Update the user message save:

```javascript
await createMessage(conversationId, "user", message.trim(), incomingAttachments?.length ? incomingAttachments : null);
```

Update the history mapping:

```javascript
const history = recentMessages.slice(0, -1).map((m) => ({
  role: m.role,
  content: summarizeAttachments(m.content, m.attachments),
}));
```

After building `msgs` from `buildChatMessages`, add content block construction for the current message:

```javascript
if (incomingAttachments?.length) {
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg.role === "user") {
    lastMsg.content = await buildContentBlocks(message.trim(), incomingAttachments);
  }
}
```

- [ ] **Step 7: Add Azure Blob env vars to Lambda**

```bash
aws lambda update-function-configuration \
  --function-name bricks-chat-stream \
  --environment "Variables={
    AZURE_AI_API_KEY=$(aws lambda get-function-configuration --function-name bricks-chat-stream --query 'Environment.Variables.AZURE_AI_API_KEY' --output text),
    AZURE_AI_RESOURCE=$(aws lambda get-function-configuration --function-name bricks-chat-stream --query 'Environment.Variables.AZURE_AI_RESOURCE' --output text),
    CLERK_SECRET_KEY=$(aws lambda get-function-configuration --function-name bricks-chat-stream --query 'Environment.Variables.CLERK_SECRET_KEY' --output text),
    DATABASE_URL=$(aws lambda get-function-configuration --function-name bricks-chat-stream --query 'Environment.Variables.DATABASE_URL' --output text),
    CLERK_PUBLISHABLE_KEY=$(aws lambda get-function-configuration --function-name bricks-chat-stream --query 'Environment.Variables.CLERK_PUBLISHABLE_KEY' --output text),
    ALLOWED_ORIGIN=$(aws lambda get-function-configuration --function-name bricks-chat-stream --query 'Environment.Variables.ALLOWED_ORIGIN' --output text),
    AZURE_STORAGE_CONNECTION_STRING=<connection-string>,
    AZURE_STORAGE_CONTAINER=uploads
  }"
```

(Replace `<connection-string>` with the actual Azure Storage connection string after creating the storage account.)

- [ ] **Step 8: Deploy Lambda**

```bash
cd /home/venu/Desktop/Bricks/lambda-chat && rm -f /tmp/lambda-chat.zip && zip -r /tmp/lambda-chat.zip . -x "node_modules/.package-lock.json" && aws lambda update-function-code --function-name bricks-chat-stream --zip-file fileb:///tmp/lambda-chat.zip
```

- [ ] **Step 9: Commit**

```bash
cd /home/venu/Desktop/Bricks && git add lambda-chat/
git commit -m "feat: Lambda attachment support — Azure Blob download, content blocks"
```

---

### Task 11: Full-Tab Preview

**Files:**
- Modify: `src/components/build/preview-panel.tsx`

- [ ] **Step 1: Add fullscreen state and toggle**

In `src/components/build/preview-panel.tsx`, add `Maximize2` and `Minimize2` to the lucide-react import:

```typescript
import { Loader2, RefreshCw, Hammer, Maximize2, Minimize2 } from "lucide-react";
```

Add state inside the component:

```typescript
  const [isFullscreen, setIsFullscreen] = useState(false);
```

Add ESC key handler:

```typescript
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);
```

Add the `useState` import if not already present.

- [ ] **Step 2: Add maximize button to both preview toolbars**

In the static HTML preview toolbar section (around line 295-299), add the maximize button next to the refresh button:

```tsx
<div className="flex gap-1">
  <Button variant="ghost" size="icon-xs" onClick={handleRefresh}>
    <RefreshCw className="h-3.5 w-3.5" />
  </Button>
  <Button variant="ghost" size="icon-xs" onClick={() => setIsFullscreen(true)}>
    <Maximize2 className="h-3.5 w-3.5" />
  </Button>
</div>
```

Do the same for the WebContainer preview toolbar (around line 319-321).

- [ ] **Step 3: Add the fullscreen overlay**

Add this JSX at the very end of the component, right before the final closing of the last return statement (render a portal-like overlay):

```tsx
{isFullscreen && (
  <div className="fixed inset-0 z-50 flex flex-col bg-background">
    <div className="flex h-10 items-center justify-between border-b border-border/50 px-4">
      <span className="text-sm font-medium text-foreground">Preview</span>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon-xs" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setIsFullscreen(false)}>
          <Minimize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
    {staticHtml !== null ? (
      <iframe
        srcDoc={staticHtml}
        title="Live Preview"
        className="flex-1 border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    ) : previewUrl ? (
      <iframe
        src={previewUrl}
        title="Live Preview"
        className="flex-1 border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        allow="cross-origin-isolated"
      />
    ) : null}
  </div>
)}
```

Since each render path returns early, the fullscreen overlay should be rendered as a sibling. Refactor the component to use a wrapper pattern: wrap all returns in a fragment and always render the fullscreen overlay when active.

The cleanest approach: extract the fullscreen overlay into its own section that renders at the end of every return branch. Since each branch returns a `<div>`, wrap it:

```tsx
return (
  <>
    <div className="flex h-full flex-col">
      {/* ...existing content... */}
    </div>
    {isFullscreen && (
      <div className="fixed inset-0 z-50 ...">
        {/* fullscreen content */}
      </div>
    )}
  </>
);
```

This requires combining the three early-return branches (empty, loading, preview) into a single return with conditional content. The fullscreen overlay always renders when `isFullscreen` is true regardless of which state the panel is in.

- [ ] **Step 4: Commit**

```bash
git add src/components/build/preview-panel.tsx
git commit -m "feat: full-tab preview with maximize/minimize and ESC to close"
```

---

### Task 12: Azure Blob Storage Resource Setup

**Files:** None (infrastructure setup)

- [ ] **Step 1: Create Azure Storage Account**

```bash
az storage account create \
  --name bricksuploadstore \
  --resource-group rg-venu_kumar_azzure-2038 \
  --location eastus2 \
  --sku Standard_LRS \
  --kind StorageV2
```

- [ ] **Step 2: Create the uploads container**

```bash
az storage container create \
  --name uploads \
  --account-name bricksuploadstore \
  --auth-mode login
```

- [ ] **Step 3: Get the connection string**

```bash
az storage account show-connection-string \
  --name bricksuploadstore \
  --resource-group rg-venu_kumar_azzure-2038 \
  --output tsv
```

- [ ] **Step 4: Add env vars to Amplify**

Add `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_STORAGE_CONTAINER=uploads` to the Amplify app environment variables.

- [ ] **Step 5: Add env vars to Lambda**

Update Lambda environment with the connection string (use the command from Task 10 Step 7).

- [ ] **Step 6: Update `amplify.yml` to include new env vars in `.env.production`**

In `amplify.yml`, update the `printenv | grep` line to include the new vars:

```yaml
- |
  printenv | grep -E '^(NEXT_PUBLIC_|CLERK_SECRET_KEY|CLERK_WEBHOOK_SIGNING_SECRET|DATABASE_URL|AZURE_AI_API_KEY|AZURE_AI_RESOURCE|AZURE_STORAGE_CONNECTION_STRING|AZURE_STORAGE_CONTAINER|PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID)' > .env.production || true
```

---

### Task 13: End-to-End Testing & Push

- [ ] **Step 1: Test locally**

```bash
cd /home/venu/Desktop/Bricks && npm run dev
```

Test in browser:
- Chat mode: attach an image, send message, verify AI sees it
- Chat mode: attach a PDF, send message, verify AI references it
- Chat mode: attach a .js file, send message, verify AI reads the code
- Build mode: same tests
- Verify attachments display correctly in message history
- Verify fullscreen preview toggle works

- [ ] **Step 2: Push to Amplify**

```bash
git push old-amplify main
```

- [ ] **Step 3: Deploy Lambda**

```bash
cd /home/venu/Desktop/Bricks/lambda-chat && rm -f /tmp/lambda-chat.zip && zip -r /tmp/lambda-chat.zip . -x "node_modules/.package-lock.json" && aws lambda update-function-code --function-name bricks-chat-stream --zip-file fileb:///tmp/lambda-chat.zip
```

- [ ] **Step 4: Test in production**

Test the same scenarios on thefixer.in.
