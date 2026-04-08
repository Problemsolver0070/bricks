import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateUserByClerkId,
  getConversations,
  createConversation,
} from "@/lib/db/queries";

// ─── GET /api/conversations ──────────────────────────────────────────────────

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await getOrCreateUserByClerkId(clerkId);
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const conversations = await getConversations(dbUser.id);

  return NextResponse.json(
    conversations.map((c) => ({
      id: c.id,
      title: c.title,
      mode: c.mode,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  );
}

// ─── POST /api/conversations ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await getOrCreateUserByClerkId(clerkId);
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const { mode = "chat", title } = body as {
    mode?: string;
    title?: string;
  };

  const conversation = await createConversation(dbUser.id, mode, title);

  return NextResponse.json(
    {
      id: conversation.id,
      title: conversation.title,
      mode: conversation.mode,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    },
    { status: 201 }
  );
}
