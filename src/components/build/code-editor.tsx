"use client";

import { useBuildStore } from "@/stores/build-store";
import Editor from "@monaco-editor/react";
import { FileCode2 } from "lucide-react";

const EXT_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  svg: "xml",
  xml: "xml",
};

function getLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE_MAP[ext] ?? "plaintext";
}

export function CodeEditor() {
  const activeFile = useBuildStore((s) => s.activeFile);
  const files = useBuildStore((s) => s.files);
  const updateFile = useBuildStore((s) => s.updateFile);

  if (!activeFile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileCode2 className="h-10 w-10 opacity-40" />
        <p className="text-sm">Select a file to edit</p>
      </div>
    );
  }

  const content = files[activeFile] ?? "";
  const language = getLanguage(activeFile);

  return (
    <div className="flex-1 overflow-hidden">
      <div className="flex h-8 items-center border-b border-border/50 bg-muted/30 px-3">
        <span className="truncate text-xs text-muted-foreground">
          {activeFile}
        </span>
      </div>
      <Editor
        height="calc(100% - 2rem)"
        language={language}
        value={content}
        theme="vs-dark"
        onChange={(value) => {
          if (value !== undefined) {
            updateFile(activeFile, value);
          }
        }}
        options={{
          fontSize: 13,
          minimap: { enabled: false },
          wordWrap: "on",
          tabSize: 2,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          lineNumbersMinChars: 3,
          folding: true,
          bracketPairColorization: { enabled: true },
          renderLineHighlight: "line",
          smoothScrolling: true,
          cursorSmoothCaretAnimation: "on",
        }}
      />
    </div>
  );
}
