"use client";

import { useEffect, useState, use } from "react";
import { useBuildStore } from "@/stores/build-store";
import { BuildLayout } from "@/components/build/build-layout";
import { Loader2 } from "lucide-react";

interface ProjectData {
  id: string;
  name: string;
  conversationId: string | null;
  files: Record<string, string>;
}

interface MessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function BuildProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const reset = useBuildStore((s) => s.reset);

  const [project, setProject] = useState<ProjectData | null>(null);
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    reset();

    async function loadProject() {
      try {
        setIsLoading(true);

        // Fetch project
        const projectRes = await fetch(`/api/projects/${id}`);
        if (!projectRes.ok) {
          throw new Error("Failed to load project");
        }
        const projectData: ProjectData = await projectRes.json();
        setProject(projectData);

        // Fetch messages if there's a conversation
        if (projectData.conversationId) {
          try {
            const messagesRes = await fetch(
              `/api/conversations/${projectData.conversationId}/messages`
            );
            if (messagesRes.ok) {
              const messagesData: MessageData[] = await messagesRes.json();
              setMessages(messagesData);
            }
          } catch {
            // Messages are optional — don't fail the whole page
            console.warn("Could not load conversation messages");
          }
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to load project";
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    }

    loadProject();
  }, [id, reset]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm">Loading project...</p>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <p className="text-sm text-destructive">
            {error ?? "Project not found"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <BuildLayout
      conversationId={project.conversationId ?? undefined}
      initialFiles={project.files}
      initialMessages={messages}
    />
  );
}
