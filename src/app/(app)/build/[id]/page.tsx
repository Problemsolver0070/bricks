"use client";

import { useEffect, useState, use } from "react";
import { useBuildStore } from "@/stores/build-store";
import { BuildLayout } from "@/components/build/build-layout";
import { Loader2 } from "lucide-react";

interface MessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function BuildConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: conversationId } = use(params);
  const reset = useBuildStore((s) => s.reset);

  const [messages, setMessages] = useState<MessageData[]>([]);
  const [files, setFiles] = useState<Record<string, string> | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    reset();

    async function load() {
      try {
        setIsLoading(true);

        // Load conversation messages
        const messagesRes = await fetch(
          `/api/conversations/${conversationId}/messages`
        );
        if (!messagesRes.ok) {
          throw new Error("Failed to load conversation");
        }
        const messagesData: MessageData[] = await messagesRes.json();
        setMessages(messagesData);

        // Try to load linked project files (optional — may not exist yet)
        try {
          const projectRes = await fetch(
            `/api/projects?conversationId=${conversationId}`
          );
          if (projectRes.ok) {
            const projectData = await projectRes.json();
            if (projectData?.files && Object.keys(projectData.files).length > 0) {
              setFiles(projectData.files as Record<string, string>);
            }
          }
        } catch {
          // No project linked yet — that's fine
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to load conversation";
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [conversationId, reset]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm">Loading build session...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <BuildLayout
      conversationId={conversationId}
      initialFiles={files}
      initialMessages={messages}
    />
  );
}
