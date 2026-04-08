"use client";

import { useRef, useCallback } from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type PendingAttachment,
  type Attachment,
  detectCategory,
  isAllowedFile,
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
        if (!isAllowedFile(file.type, file.name)) {
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
