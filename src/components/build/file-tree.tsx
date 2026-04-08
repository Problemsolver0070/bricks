"use client";

import { useBuildStore } from "@/stores/build-store";
import { FileJson, FileCode, FileText, File } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
]);
const JSON_EXTENSIONS = new Set(["json", "jsonc"]);
const CONFIG_EXTENSIONS = new Set(["yml", "yaml", "toml", "env", "lock"]);

function getFileIcon(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  if (CODE_EXTENSIONS.has(ext)) {
    return <FileCode className="h-3.5 w-3.5 shrink-0 text-blue-400" />;
  }
  if (JSON_EXTENSIONS.has(ext)) {
    return <FileJson className="h-3.5 w-3.5 shrink-0 text-yellow-400" />;
  }
  if (ext === "css" || ext === "scss" || ext === "less") {
    return <FileText className="h-3.5 w-3.5 shrink-0 text-pink-400" />;
  }
  if (ext === "html" || ext === "svg" || ext === "xml") {
    return <FileText className="h-3.5 w-3.5 shrink-0 text-orange-400" />;
  }
  if (ext === "md" || ext === "mdx") {
    return <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />;
  }
  if (CONFIG_EXTENSIONS.has(ext)) {
    return <File className="h-3.5 w-3.5 shrink-0 text-gray-500" />;
  }

  return <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function FileTree() {
  const files = useBuildStore((s) => s.files);
  const activeFile = useBuildStore((s) => s.activeFile);
  const setActiveFile = useBuildStore((s) => s.setActiveFile);

  const paths = Object.keys(files).sort();

  if (paths.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-3">
        <p className="text-xs text-muted-foreground/60">No files yet</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col py-1">
        {paths.map((path) => {
          const isActive = path === activeFile;
          return (
            <button
              key={path}
              onClick={() => setActiveFile(path)}
              className={cn(
                "flex items-center gap-2 px-3 py-1 text-left text-xs transition-colors",
                "hover:bg-muted/60",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground"
              )}
              title={path}
            >
              {getFileIcon(path)}
              <span className="truncate">{getFileName(path)}</span>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
