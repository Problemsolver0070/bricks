"use client";

import { useEffect, useRef, useCallback } from "react";
import { useBuildStore } from "@/stores/build-store";
import { Loader2, RefreshCw, Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── WebContainer Types ──────────────────────────────────────────────────────
// We import dynamically to avoid SSR issues, but define the shape for typing.
type WebContainer = Awaited<
  ReturnType<typeof import("@webcontainer/api").then>
>["WebContainer"] extends { boot(): Promise<infer T> }
  ? T
  : never;

interface FileNode {
  file: { contents: string };
}

interface DirectoryNode {
  directory: Record<string, FileNode | DirectoryNode>;
}

type MountTree = Record<string, FileNode | DirectoryNode>;

// ─── Singleton Container ─────────────────────────────────────────────────────

let containerInstance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;

async function getContainer(): Promise<WebContainer> {
  if (containerInstance) return containerInstance;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    const { WebContainer } = await import("@webcontainer/api");
    const instance = await WebContainer.boot();
    containerInstance = instance;
    return instance;
  })();

  return bootPromise;
}

// ─── File Conversion ─────────────────────────────────────────────────────────

/**
 * Converts a flat Record<string, string> (e.g. { "src/App.tsx": "..." })
 * into the nested mount tree format WebContainers expects.
 */
function filesToMountTree(files: Record<string, string>): MountTree {
  const tree: MountTree = {};

  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split("/");
    let current: MountTree = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        current[part] = { file: { contents } };
      } else {
        if (!current[part]) {
          current[part] = { directory: {} };
        }
        current = (current[part] as DirectoryNode).directory;
      }
    }
  }

  return tree;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PreviewPanel() {
  const files = useBuildStore((s) => s.files);
  const previewUrl = useBuildStore((s) => s.previewUrl);
  const isBooting = useBuildStore((s) => s.isBooting);
  const isRunning = useBuildStore((s) => s.isRunning);
  const setPreviewUrl = useBuildStore((s) => s.setPreviewUrl);
  const setBooting = useBuildStore((s) => s.setBooting);
  const setRunning = useBuildStore((s) => s.setRunning);
  const appendTerminalOutput = useBuildStore((s) => s.appendTerminalOutput);
  const clearTerminalOutput = useBuildStore((s) => s.clearTerminalOutput);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasRunRef = useRef(false);
  const isRunningRef = useRef(false);

  const runProject = useCallback(async () => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;

    const currentFiles = useBuildStore.getState().files;
    if (Object.keys(currentFiles).length === 0) {
      isRunningRef.current = false;
      return;
    }

    try {
      setBooting(true);
      setPreviewUrl(null);
      clearTerminalOutput();
      appendTerminalOutput("Booting WebContainer...\n");

      const container = await getContainer();

      appendTerminalOutput("Mounting files...\n");
      const mountTree = filesToMountTree(currentFiles);
      await container.mount(mountTree);
      appendTerminalOutput("Files mounted.\n");

      // npm install
      appendTerminalOutput("\n$ npm install\n");
      const installProcess = await container.spawn("npm", ["install"]);

      installProcess.output.pipeTo(
        new WritableStream({
          write(data) {
            appendTerminalOutput(data);
          },
        })
      );

      const installExitCode = await installProcess.exit;
      if (installExitCode !== 0) {
        appendTerminalOutput(
          `\nnpm install failed with exit code ${installExitCode}\n`
        );
        setBooting(false);
        isRunningRef.current = false;
        return;
      }

      appendTerminalOutput("\nnpm install complete.\n");
      setBooting(false);
      setRunning(true);

      // npm run dev
      appendTerminalOutput("\n$ npm run dev\n");
      const devProcess = await container.spawn("npm", ["run", "dev"]);

      devProcess.output.pipeTo(
        new WritableStream({
          write(data) {
            appendTerminalOutput(data);
          },
        })
      );

      // Listen for server-ready event
      container.on("server-ready", (_port: number, url: string) => {
        appendTerminalOutput(`\nServer ready at ${url}\n`);
        setPreviewUrl(url);
      });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Unknown error occurred";
      appendTerminalOutput(`\nError: ${msg}\n`);
      setBooting(false);
      setRunning(false);
      isRunningRef.current = false;
    }
  }, [
    setBooting,
    setPreviewUrl,
    setRunning,
    appendTerminalOutput,
    clearTerminalOutput,
  ]);

  // Auto-run on first file mount
  useEffect(() => {
    if (Object.keys(files).length > 0 && !hasRunRef.current) {
      hasRunRef.current = true;
      runProject();
    }
  }, [files, runProject]);

  const handleRefresh = () => {
    if (iframeRef.current && previewUrl) {
      iframeRef.current.src = previewUrl;
    }
  };

  const hasFiles = Object.keys(files).length > 0;
  const isLoading = isBooting || (isRunning && !previewUrl);

  // ─── Empty State ─────────────────────────────────────────────────────────
  if (!hasFiles && !isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Hammer className="h-10 w-10 opacity-40" />
        <p className="text-sm">Ask The Fixer to build something</p>
      </div>
    );
  }

  // ─── Loading State ───────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 items-center justify-between border-b border-border/50 bg-muted/30 px-3">
          <span className="text-xs text-muted-foreground">Preview</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm">
            {isBooting ? "Installing dependencies..." : "Starting dev server..."}
          </p>
        </div>
      </div>
    );
  }

  // ─── Preview ─────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center justify-between border-b border-border/50 bg-muted/30 px-3">
        <span className="truncate text-xs text-muted-foreground">
          {previewUrl ?? "Preview"}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {previewUrl && (
        <iframe
          ref={iframeRef}
          src={previewUrl}
          title="Live Preview"
          className="flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          allow="cross-origin-isolated"
        />
      )}
    </div>
  );
}
