import { create } from "zustand";

interface BuildState {
  // ─── State ───────────────────────────────────────────────────────────────────
  files: Record<string, string>;
  activeFile: string | null;
  previewUrl: string | null;
  isBooting: boolean;
  isRunning: boolean;
  terminalOutput: string;

  // ─── Actions ─────────────────────────────────────────────────────────────────
  setFiles: (files: Record<string, string>) => void;
  updateFile: (path: string, content: string) => void;
  setActiveFile: (path: string | null) => void;
  setPreviewUrl: (url: string | null) => void;
  setBooting: (booting: boolean) => void;
  setRunning: (running: boolean) => void;
  appendTerminalOutput: (text: string) => void;
  clearTerminalOutput: () => void;
  reset: () => void;
}

/**
 * Auto-selects the best initial file when files are set.
 * Priority: first .tsx → first .ts → first file with "App" in the name → first file
 */
function pickInitialFile(files: Record<string, string>): string | null {
  const paths = Object.keys(files).sort();
  if (paths.length === 0) return null;

  const tsx = paths.find((p) => p.endsWith(".tsx"));
  if (tsx) return tsx;

  const ts = paths.find((p) => p.endsWith(".ts"));
  if (ts) return ts;

  const app = paths.find((p) => /app/i.test(p));
  if (app) return app;

  return paths[0];
}

export const useBuildStore = create<BuildState>((set) => ({
  // ─── Initial State ─────────────────────────────────────────────────────────
  files: {},
  activeFile: null,
  previewUrl: null,
  isBooting: false,
  isRunning: false,
  terminalOutput: "",

  // ─── Actions ─────────────────────────────────────────────────────────────────
  setFiles: (files) =>
    set({
      files,
      activeFile: pickInitialFile(files),
    }),

  updateFile: (path, content) =>
    set((state) => ({
      files: { ...state.files, [path]: content },
    })),

  setActiveFile: (path) => set({ activeFile: path }),

  setPreviewUrl: (url) => set({ previewUrl: url }),

  setBooting: (booting) => set({ isBooting: booting }),

  setRunning: (running) => set({ isRunning: running }),

  appendTerminalOutput: (text) =>
    set((state) => ({
      terminalOutput: state.terminalOutput + text,
    })),

  clearTerminalOutput: () => set({ terminalOutput: "" }),

  reset: () =>
    set({
      files: {},
      activeFile: null,
      previewUrl: null,
      isBooting: false,
      isRunning: false,
      terminalOutput: "",
    }),
}));
