"use client";

import { User, Bot } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { MessageAttachments } from "./message-attachments";
import type { Attachment } from "@/lib/types/attachment";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  attachments?: Attachment[] | null;
}

export function MessageBubble({
  role,
  content,
  isStreaming = false,
  attachments,
}: MessageBubbleProps) {
  const isUser = role === "user";

  // Strip <bricks-files> blocks from displayed content
  const displayContent =
    !isUser
      ? content
          .replace(/<bricks-files>[\s\S]*?<\/bricks-files>/g, "")
          .replace(/<bricks-files>[\s\S]*/g, "")
          .trim()
      : content;

  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-4",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      {/* Assistant avatar */}
      {!isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      )}

      <div
        className={cn(
          "flex max-w-[75%] flex-col gap-1",
          isUser ? "items-end" : "items-start"
        )}
      >
        {/* Name label */}
        <span className="px-1 text-xs font-medium text-muted-foreground">
          {isUser ? "You" : "The Fixer"}
        </span>

        {/* Message content */}
        <div
          className={cn(
            "rounded-2xl px-4 py-3 text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground rounded-br-md"
              : "bg-muted text-foreground rounded-bl-md"
          )}
        >
          {isUser ? (
            <>
              {attachments && <MessageAttachments attachments={attachments} />}
              <p className="whitespace-pre-wrap">{content}</p>
            </>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-pre:my-2 prose-pre:rounded-lg prose-pre:bg-background/50 prose-code:rounded prose-code:bg-background/50 prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
              {isStreaming && (
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary" />
              )}
            </div>
          )}
        </div>
      </div>

      {/* User avatar */}
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
