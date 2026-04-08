"use client";

import { useState, useEffect } from "react";
import { FileText, FileCode, Download } from "lucide-react";
import type { Attachment } from "@/lib/types/attachment";

interface MessageAttachmentsProps {
  attachments: Attachment[];
}

const sasCache = new Map<string, { url: string; expiresAt: number }>();

async function getSasUrl(blobKey: string): Promise<string> {
  const cached = sasCache.get(blobKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const res = await fetch(
    `/api/upload/sas?blobKey=${encodeURIComponent(blobKey)}`
  );
  if (!res.ok) throw new Error("Failed to get SAS URL");
  const { url } = await res.json();

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
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((att) => (
            <ImageAttachment key={att.id} att={att} />
          ))}
        </div>
      )}

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
