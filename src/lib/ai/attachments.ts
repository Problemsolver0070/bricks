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
 * For history messages, include a text summary of attachments
 * instead of re-fetching full blob content.
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
