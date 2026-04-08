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

export function isAllowedFile(mimeType: string, filename: string): boolean {
  if (IMAGE_TYPES.has(mimeType)) return true;
  if (PDF_TYPES.has(mimeType)) return true;
  if (CODE_MIME_TYPES.has(mimeType)) return true;
  if (mimeType.startsWith("text/")) return true;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_EXTENSIONS.has(ext)) return true;
  return false;
}
