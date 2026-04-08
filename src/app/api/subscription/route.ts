import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getUserByClerkId, getSubscription } from "@/lib/db/queries";

export async function GET() {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserByClerkId(clerkId);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const subscription = await getSubscription(user.id);

    return NextResponse.json({
      plan: user.plan,
      trialExpiresAt: user.trialExpiresAt?.toISOString() ?? null,
      subscription: subscription
        ? {
            id: subscription.id,
            paypalSubscriptionId: subscription.paypalSubscriptionId,
            plan: subscription.plan,
            status: subscription.status,
            currentPeriodStart:
              subscription.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd:
              subscription.currentPeriodEnd?.toISOString() ?? null,
            createdAt: subscription.createdAt.toISOString(),
          }
        : null,
    });
  } catch (err) {
    console.error("Subscription API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
