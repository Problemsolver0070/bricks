"use client";

import { useRouter } from "next/navigation";
import { Check, Crown, Zap } from "lucide-react";
import { PayPalSubscribeButton } from "@/components/billing/paypal-button";

interface PricingClientProps {
  plan: string;
  userId: string;
  subscriptionStatus: string | null;
}

const PRO_FEATURES = [
  "Unlimited AI chat conversations",
  "Unlimited app builds",
  "Live preview in browser",
  "Persistent project storage",
  "Priority support",
  "Early access to new features",
];

export function PricingClient({
  plan,
  userId,
  subscriptionStatus,
}: PricingClientProps) {
  const router = useRouter();
  const isPro = plan === "pro" && subscriptionStatus === "active";
  const planId = process.env.NEXT_PUBLIC_PAYPAL_PLAN_ID ?? "";

  function handleSuccess(subscriptionId: string) {
    console.log("Subscription created:", subscriptionId);
    router.push("/chat");
    router.refresh();
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Upgrade to Pro
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Unlock the full power of Bricks with unlimited access.
          </p>
        </div>

        {/* Pricing Card */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
          {/* Plan Header */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Crown className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold text-foreground">Pro</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Everything you need to build
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold tracking-tight text-foreground">
                $20
              </div>
              <div className="text-sm text-muted-foreground">/month</div>
            </div>
          </div>

          {/* Divider */}
          <div className="mb-6 border-t border-border" />

          {/* Features List */}
          <ul className="mb-6 space-y-3">
            {PRO_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-3">
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Check className="h-3 w-3 text-primary" />
                </div>
                <span className="text-sm text-foreground">{feature}</span>
              </li>
            ))}
          </ul>

          {/* Divider */}
          <div className="mb-6 border-t border-border" />

          {/* Action Area */}
          {isPro ? (
            <div className="flex items-center justify-center gap-2 rounded-lg bg-primary/10 p-4">
              <Crown className="h-5 w-5 text-primary" />
              <span className="text-sm font-semibold text-primary">
                You&apos;re already on Pro!
              </span>
            </div>
          ) : (
            <div>
              {!userId ? (
                <div className="rounded-lg bg-muted/50 p-4 text-center text-sm text-muted-foreground">
                  Setting up your account... Please refresh in a moment.
                </div>
              ) : (
                <PayPalSubscribeButton
                  planId={planId}
                  userId={userId}
                  onSuccess={handleSuccess}
                />
              )}
            </div>
          )}
        </div>

        {/* Footer Note */}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Cancel anytime from your PayPal account. No questions asked.
        </p>
      </div>
    </div>
  );
}
