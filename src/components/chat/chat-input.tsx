"use client";

import { useRef, useState, useCallback, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chat-store";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  const isStreaming = useChatStore((s) => s.isStreaming);
  const addMessage = useChatStore((s) => s.addMessage);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const appendStreamContent = useChatStore((s) => s.appendStreamContent);
  const clearStreamContent = useChatStore((s) => s.clearStreamContent);
  const finalizeStream = useChatStore((s) => s.finalizeStream);

  const sendMessage = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;

    // Add user message to store immediately
    const tempUserId = `user-${Date.now()}`;
    addMessage({
      id: tempUserId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
    });

    setValue("");
    setStreaming(true);
    clearStreamContent();

    // Auto-resize textarea back
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    let fullContent = "";
    let currentConversationId = conversationId;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          conversationId,
          mode,
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
                  const filesMatch = fullContent.match(
                    /<bricks-files>\s*([\s\S]*?)\s*<\/bricks-files>/
                  );
                  if (filesMatch) {
                    try {
                      const files = JSON.parse(filesMatch[1]);
                      onFilesGenerated(files);
                    } catch {
                      // JSON parse failed — skip
                    }
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

  return (
    <div className="border-t border-border/50 bg-card/50 backdrop-blur-sm">
      <div className="mx-auto flex max-w-3xl items-end gap-2 p-4">
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
          disabled={isStreaming || value.trim().length === 0}
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
  );
}
