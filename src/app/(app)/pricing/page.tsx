import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getOrCreateUserByClerkId, getSubscription } from "@/lib/db/queries";
import { PricingClient } from "./pricing-client";

export const metadata = {
  title: "Pricing - Bricks",
  description: "Upgrade to Bricks Pro for unlimited access",
};

export default async function PricingPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const user = await getOrCreateUserByClerkId(clerkId);

  // If user doesn't exist in DB yet (webhook pending), show pricing with no plan
  const plan = user?.plan ?? "trial";
  const dbUserId = user?.id ?? "";
  const subscription = user ? await getSubscription(user.id) : null;

  return (
    <PricingClient
      plan={plan}
      userId={dbUserId}
      subscriptionStatus={subscription?.status ?? null}
    />
  );
}
