"use client";

import { useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";

export default function NewChatPage() {
  const reset = useChatStore((s) => s.reset);

  // Clear messages on mount so it's a fresh conversation
  useEffect(() => {
    reset();
  }, [reset]);

  return (
    <div className="flex h-full flex-col">
      <ChatMessages />
      <ChatInput mode="chat" />
    </div>
  );
}
