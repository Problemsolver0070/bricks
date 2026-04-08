"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useChatStore, type ChatMessageItem } from "@/stores/chat-store";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const conversationId = params.id;
  const setMessages = useChatStore((s) => s.setMessages);
  const reset = useChatStore((s) => s.reset);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    reset();

    async function loadMessages() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`/api/conversations/${conversationId}/messages`);
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError(data?.error || "Failed to load conversation.");
          return;
        }

        const data: ChatMessageItem[] = await res.json();
        setMessages(data);
      } catch {
        setError("Failed to load conversation. Please try again.");
      } finally {
        setLoading(false);
      }
    }

    if (conversationId) {
      loadMessages();
    }
  }, [conversationId, setMessages, reset]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Loading conversation...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatMessages />
      <ChatInput conversationId={conversationId} mode="chat" />
    </div>
  );
}
