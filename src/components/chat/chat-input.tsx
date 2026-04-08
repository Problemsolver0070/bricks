"use client";

import { useRef, useState, useCallback, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chat-store";
import { AttachmentButton, uploadFile } from "./attachment-button";
import { AttachmentPreview } from "./attachment-preview";
import type { PendingAttachment, Attachment } from "@/lib/types/attachment";
import { detectCategory } from "@/lib/types/attachment";

const CHAT_API_URL =
  process.env.NEXT_PUBLIC_CHAT_API_URL || "/api/chat";

interface ChatInputProps {
  conversationId?: string;
  mode?: "chat" | "build";
  onFilesGenerated?: (files: { path: string; content: string }[]) => void;
}

export function ChatInput({
  conversationId,
  mode = "chat",
  onFilesGenerated,
}: ChatInputProps) {
  const router = useRouter();
  const { getToken } = useAuth();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const isStreaming = useChatStore((s) => s.isStreaming);
  const addMessage = useChatStore((s) => s.addMessage);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const appendStreamContent = useChatStore((s) => s.appendStreamContent);
  const clearStreamContent = useChatStore((s) => s.clearStreamContent);
  const finalizeStream = useChatStore((s) => s.finalizeStream);

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

  const sendMessage = useCallback(async () => {
    const trimmed = value.trim();
    const readyAttachments: Attachment[] = pendingAttachments
      .filter((p) => p.status === "ready" && p.attachment)
      .map((p) => p.attachment!);
    if ((!trimmed && readyAttachments.length === 0) || isStreaming) return;

    // Add user message to store immediately
    const tempUserId = `user-${Date.now()}`;
    addMessage({
      id: tempUserId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      attachments: readyAttachments.length > 0 ? readyAttachments : undefined,
    });

    setValue("");
    setPendingAttachments([]);
    setStreaming(true);
    clearStreamContent();

    // Auto-resize textarea back
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    let fullContent = "";
    let currentConversationId = conversationId;

    try {
      const token = await getToken();
      const res = await fetch(CHAT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: trimmed,
          conversationId,
          mode,
          attachments: readyAttachments.length > 0 ? readyAttachments : undefined,
        }),
      });

      // Handle non-streaming error responses
      if (!res.ok) {
        if (res.status === 402) {
          addMessage({
            id: `error-${Date.now()}`,
            role: "assistant",
            content:
              "Your trial has expired. Please upgrade to continue using The Fixer.",
            createdAt: new Date().toISOString(),
          });
          setStreaming(false);
          return;
        }

        const errorData = await res.json().catch(() => null);
        addMessage({
          id: `error-${Date.now()}`,
          role: "assistant",
          content:
            errorData?.error || "Something went wrong. Please try again.",
          createdAt: new Date().toISOString(),
        });
        setStreaming(false);
        return;
      }

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) {
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(chunk, { stream: true });
        const lines = sseBuffer.split("\n");

        // Keep the last incomplete line in the buffer
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          try {
            const data = JSON.parse(line.slice(6));

            switch (data.type) {
              case "conversation_id":
                currentConversationId = data.id;
                if (!conversationId) {
                  // Navigate to the new conversation URL
                  const basePath = mode === "build" ? "/build" : "/chat";
                  router.replace(`${basePath}/${data.id}`);
                }
                break;

              case "text":
                fullContent += data.content;
                appendStreamContent(data.content);
                break;

              case "title":
                // Title was set server-side; router will refresh layout
                break;

              case "done": {
                const assistantId = `assistant-${Date.now()}`;
                finalizeStream(assistantId);

                // Parse <bricks-files> from full content if in build mode
                if (mode === "build" && onFilesGenerated) {
                  try {
                    let bricksJson: string | undefined;
                    const complete = fullContent.match(
                      /<bricks-files>\s*([\s\S]*?)\s*<\/bricks-files>/
                    );
                    if (complete) {
                      bricksJson = complete[1];
                    } else {
                      // Handle truncated response
                      const incomplete = fullContent.match(/<bricks-files>\s*([\s\S]*)/);
                      if (incomplete) {
                        bricksJson = incomplete[1];
                        const lastObj = bricksJson.lastIndexOf("}");
                        if (lastObj > 0) bricksJson = bricksJson.slice(0, lastObj + 1) + "]";
                      }
                    }
                    if (bricksJson) {
                      const files = JSON.parse(bricksJson);
                      onFilesGenerated(files);
                    }
                  } catch {
                    // JSON parse failed — skip
                  }
                }
                return;
              }

              case "error":
                finalizeStream(`error-${Date.now()}`);
                addMessage({
                  id: `error-${Date.now()}`,
                  role: "assistant",
                  content: data.message,
                  createdAt: new Date().toISOString(),
                });
                return;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // If stream ended without a "done" event, finalize anyway
      if (isStreaming) {
        finalizeStream(`assistant-${Date.now()}`);
      }
    } catch (err) {
      console.error("Chat send error:", err);
      setStreaming(false);
      addMessage({
        id: `error-${Date.now()}`,
        role: "assistant",
        content: "Network error. Please check your connection and try again.",
        createdAt: new Date().toISOString(),
      });
    }
  }, [
    value,
    isStreaming,
    conversationId,
    mode,
    addMessage,
    setStreaming,
    appendStreamContent,
    clearStreamContent,
    finalizeStream,
    onFilesGenerated,
    router,
    getToken,
    pendingAttachments,
  ]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const uploading = pendingAttachments.some((p) => p.status === "uploading");

  return (
    <div
      className="border-t border-border/50 bg-card/50 backdrop-blur-sm"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files.length > 0) {
          const files = Array.from(e.dataTransfer.files);
          const pending: PendingAttachment[] = files.map((file) => ({
            id: crypto.randomUUID(),
            file,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            category: detectCategory(file.type, file.name),
            status: "uploading" as const,
            progress: 0,
            previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          }));
          handleFilesSelected(pending);
        }
      }}
    >
      <div className="mx-auto max-w-3xl p-4">
        <AttachmentPreview
          attachments={pendingAttachments}
          onRemove={removeAttachment}
        />
        <div className="flex items-end gap-2">
          <AttachmentButton
            onFilesSelected={handleFilesSelected}
            disabled={isStreaming}
          />
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData.items);
              const imageFiles = items
                .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null);
              if (imageFiles.length > 0) {
                e.preventDefault();
                const pending: PendingAttachment[] = imageFiles.map((file) => ({
                  id: crypto.randomUUID(),
                  file,
                  filename: file.name || `pasted-image.${file.type.split("/")[1] || "png"}`,
                  mimeType: file.type,
                  size: file.size,
                  category: "image" as const,
                  status: "uploading" as const,
                  progress: 0,
                  previewUrl: URL.createObjectURL(file),
                }));
                handleFilesSelected(pending);
              }
            }}
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
  );
}
