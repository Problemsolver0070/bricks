import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getUserByClerkId, getMessages } from "@/lib/db/queries";

type RouteContext = { params: Promise<{ id: string }> };

// ─── GET /api/conversations/:id/messages ─────────────────────────────────────

export async function GET(_req: NextRequest, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await getUserByClerkId(clerkId);
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { id } = await context.params;
  const messages = await getMessages(id, dbUser.id);

  return NextResponse.json(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }))
  );
}
