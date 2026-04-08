"use client";

import { X, FileText, FileCode, Loader2 } from "lucide-react";
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
            <FileText className="h-5 w-5 text-muted-foreground" />
          )}

          <span className="max-w-[120px] truncate text-xs text-foreground">
            {att.filename}
          </span>

          {att.status === "uploading" && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}

          {att.status === "error" && (
            <span className="text-xs text-destructive">Failed</span>
          )}

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
