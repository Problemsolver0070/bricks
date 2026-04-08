import { create } from "zustand";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface ChatState {
  messages: ChatMessageItem[];
  isStreaming: boolean;
  streamingContent: string;

  // Actions
  setMessages: (messages: ChatMessageItem[]) => void;
  addMessage: (message: ChatMessageItem) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamContent: (chunk: string) => void;
  clearStreamContent: () => void;
  finalizeStream: (id: string) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  streamingContent: "",

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  setStreaming: (isStreaming) => set({ isStreaming }),

  appendStreamContent: (chunk) =>
    set((state) => ({ streamingContent: state.streamingContent + chunk })),

  clearStreamContent: () => set({ streamingContent: "" }),

  finalizeStream: (id) => {
    const { streamingContent } = get();
    if (streamingContent) {
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id,
            role: "assistant" as const,
            content: streamingContent,
            createdAt: new Date().toISOString(),
          },
        ],
        streamingContent: "",
        isStreaming: false,
      }));
    } else {
      set({ isStreaming: false });
    }
  },

  reset: () => set({ messages: [], isStreaming: false, streamingContent: "" }),
}));
