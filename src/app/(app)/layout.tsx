export const dynamic = "force-dynamic";

import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getUserByClerkId } from "@/lib/db/queries";
import { getConversations } from "@/lib/db/queries";
import { AppLayoutClient } from "./app-layout-client";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const clerkUser = await currentUser();
  const dbUser = await getUserByClerkId(clerkId);

  // If the webhook hasn't fired yet, the user won't exist in our DB.
  // Redirect to a holding state — the webhook will create them shortly.
  if (!dbUser) {
    // In production, you might show a brief loading screen.
    // For now, we'll still render the shell with safe defaults.
    return (
      <AppLayoutClient
        plan="trial"
        trialExpiresAt={null}
        conversations={[]}
      >
        {children}
      </AppLayoutClient>
    );
  }

  const conversations = await getConversations(dbUser.id);

  const serializedConversations = conversations.map((c) => ({
    id: c.id,
    title: c.title,
    mode: c.mode,
    updatedAt: c.updatedAt.toISOString(),
  }));

  return (
    <AppLayoutClient
      plan={dbUser.plan}
      trialExpiresAt={dbUser.trialExpiresAt?.toISOString() ?? null}
      conversations={serializedConversations}
    >
      {children}
    </AppLayoutClient>
  );
}
