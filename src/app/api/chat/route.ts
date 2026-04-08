export const maxDuration = 120;

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { getClient, MODEL } from "@/lib/ai/client";
import { buildChatMessages, type ChatMessage } from "@/lib/ai/prompts";
import {
  sanitizeStreamChunk,
  sanitizeResponse,
  flushBuffer,
} from "@/lib/ai/sanitizer";
import { buildContentBlocks, summarizeAttachments } from "@/lib/ai/attachments";
import type { Attachment } from "@/lib/types/attachment";
import {
  getUserByClerkId,
  getSubscription,
  createConversation,
  getConversation,
  getMessages,
  createMessage,
  updateConversationTitle,
} from "@/lib/db/queries";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function hasAccess(user: {
  plan: string;
  trialExpiresAt: Date | null;
}): boolean {
  if (user.plan === "pro") return true;
  if (user.plan === "trial" && user.trialExpiresAt) {
    return new Date(user.trialExpiresAt) > new Date();
  }
  return false;
}

// ─── POST /api/chat ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Auth
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. DB user
    const dbUser = await getUserByClerkId(clerkId);
    if (!dbUser) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Access check (trial / subscription)
    if (!hasAccess(dbUser)) {
      const subscription = await getSubscription(dbUser.id);
      if (!subscription || subscription.status !== "active") {
        return new Response(
          JSON.stringify({ error: "Trial expired. Please upgrade." }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 4. Parse body
    const body = await req.json();
    const {
      message,
      conversationId: incomingConversationId,
      mode = "chat",
      attachments: incomingAttachments,
    } = body as {
      message: string;
      conversationId?: string;
      mode?: "chat" | "build";
      attachments?: Attachment[];
    };

    const hasAttachments = incomingAttachments && incomingAttachments.length > 0;
    if ((!message || typeof message !== "string" || message.trim().length === 0) && !hasAttachments) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Conversation — create if needed
    let conversationId = incomingConversationId;
    let isFirstMessage = false;

    if (conversationId) {
      const existing = await getConversation(conversationId, dbUser.id);
      if (!existing) {
        return new Response(
          JSON.stringify({ error: "Conversation not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
    } else {
      const conversation = await createConversation(dbUser.id, mode);
      conversationId = conversation.id;
      isFirstMessage = true;
    }

    // 6. Save user message
    await createMessage(
      conversationId,
      "user",
      message.trim(),
      incomingAttachments?.length ? incomingAttachments : null
    );

    // 7. Load last 50 messages as history
    const allMessages = await getMessages(conversationId, dbUser.id);
    const recentMessages = allMessages.slice(-50);
    // History = all recent messages except the last one (the user message we just saved)
    const history: ChatMessage[] = recentMessages.slice(0, -1).map((m) => ({
      role: m.role as "user" | "assistant",
      content: summarizeAttachments(m.content, m.attachments as Attachment[] | null),
    }));

    // 8. Build prompt
    const { system: systemPrompt, messages: msgs } = buildChatMessages(
      history,
      message.trim(),
      mode,
      { userName: dbUser.name ?? undefined }
    );

    // 8b. Build content blocks for current message's attachments
    if (incomingAttachments?.length) {
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg.role === "user") {
        lastMsg.content = await buildContentBlocks(
          message.trim(),
          incomingAttachments
        );
      }
    }

    // 9. Stream response via SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Send conversation ID immediately
        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "conversation_id", id: conversationId })
          )
        );

        let fullRawContent = "";
        const buffer = { value: "" };

        try {
          const response = getClient().messages.stream({
            model: MODEL,
            max_tokens: mode === "build" ? 100000 : 16000,
            system: systemPrompt,
            messages: msgs,
          });

          for await (const event of response) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const rawChunk = event.delta.text;
              fullRawContent += rawChunk;

              const sanitized = sanitizeStreamChunk(rawChunk, buffer);
              if (sanitized) {
                controller.enqueue(
                  encoder.encode(sseEvent({ type: "text", content: sanitized }))
                );
              }
            }
          }

          // Flush remaining buffer
          const remaining = flushBuffer(buffer);
          if (remaining) {
            controller.enqueue(
              encoder.encode(sseEvent({ type: "text", content: remaining }))
            );
          }

          // Save the full sanitized assistant message to DB
          const sanitizedFull = sanitizeResponse(fullRawContent);
          await createMessage(conversationId!, "assistant", sanitizedFull);

          // Auto-title on first message
          if (isFirstMessage) {
            const trimmed = message.trim();
            const title =
              trimmed.length > 60 ? trimmed.slice(0, 60) + "..." : trimmed;
            await updateConversationTitle(
              conversationId!,
              dbUser.id,
              title
            );
            controller.enqueue(
              encoder.encode(sseEvent({ type: "title", title }))
            );
          }

          controller.enqueue(encoder.encode(sseEvent({ type: "done" })));
        } catch (err) {
          console.error("AI stream error:", err);

          // Flush buffer on error
          flushBuffer(buffer);

          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: "error",
                message: "Something went wrong. Please try again.",
              })
            )
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("Chat API error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
