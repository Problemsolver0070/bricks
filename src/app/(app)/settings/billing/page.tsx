import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getUserByClerkId, getSubscription } from "@/lib/db/queries";
import {
  CreditCard,
  Crown,
  Calendar,
  Hash,
  ArrowLeft,
  ExternalLink,
} from "lucide-react";

export const metadata = {
  title: "Billing - Bricks",
  description: "Manage your Bricks subscription billing",
};

export default async function BillingPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const dbUser = await getUserByClerkId(clerkId);
  const subscription = dbUser ? await getSubscription(dbUser.id) : null;

  const plan = dbUser?.plan ?? "trial";
  const isPro = plan === "pro";

  return (
    <div className="flex flex-1 justify-center overflow-y-auto p-6">
      <div className="w-full max-w-2xl space-y-6">
        {/* Back Link + Header */}
        <div>
          <Link
            href="/settings"
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to settings
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Billing
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View and manage your subscription details
          </p>
        </div>

        {/* Current Plan Card */}
        <div className="rounded-xl border border-border bg-card p-6 ring-1 ring-foreground/5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-base font-semibold text-foreground">
                Current Plan
              </h2>
            </div>
            {isPro ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                <Crown className="h-3 w-3" />
                Pro - $20/mo
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                Free Trial
              </span>
            )}
          </div>

          {subscription ? (
            <div className="space-y-3">
              {/* Status */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span
                  className={`inline-flex items-center gap-1.5 font-medium capitalize ${
                    subscription.status === "active"
                      ? "text-green-600 dark:text-green-400"
                      : subscription.status === "cancelled"
                        ? "text-red-500 dark:text-red-400"
                        : "text-yellow-600 dark:text-yellow-400"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      subscription.status === "active"
                        ? "bg-green-500"
                        : subscription.status === "cancelled"
                          ? "bg-red-500"
                          : "bg-yellow-500"
                    }`}
                  />
                  {subscription.status}
                </span>
              </div>

              {/* Plan */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Plan</span>
                <span className="font-medium text-foreground capitalize">
                  {subscription.plan}
                </span>
              </div>

              {/* PayPal Subscription ID */}
              {subscription.paypalSubscriptionId && (
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Hash className="h-3.5 w-3.5" />
                    Subscription ID
                  </span>
                  <span className="font-mono text-xs text-foreground">
                    {subscription.paypalSubscriptionId}
                  </span>
                </div>
              )}

              {/* Current Period */}
              {subscription.currentPeriodStart && (
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" />
                    Current period
                  </span>
                  <span className="font-medium text-foreground">
                    {new Date(
                      subscription.currentPeriodStart
                    ).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                    {subscription.currentPeriodEnd && (
                      <>
                        {" - "}
                        {new Date(
                          subscription.currentPeriodEnd
                        ).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* Renewal Date */}
              {subscription.currentPeriodEnd &&
                subscription.status === "active" && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Next renewal</span>
                    <span className="font-medium text-foreground">
                      {new Date(
                        subscription.currentPeriodEnd
                      ).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </div>
                )}

              {/* PayPal Management Link */}
              <div className="mt-4 border-t border-border pt-4">
                <a
                  href="https://www.paypal.com/myaccount/autopay/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
                >
                  Manage on PayPal
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You don&apos;t have an active subscription. Upgrade to Pro to
                unlock unlimited access.
              </p>
              <Link
                href="/pricing"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Crown className="h-4 w-4" />
                Upgrade to Pro
              </Link>
            </div>
          )}
        </div>

        {/* FAQ / Info */}
        <div className="rounded-xl border border-border bg-card p-6 ring-1 ring-foreground/5">
          <h2 className="mb-3 text-base font-semibold text-foreground">
            Billing FAQ
          </h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <div>
              <p className="font-medium text-foreground">
                How do I cancel my subscription?
              </p>
              <p className="mt-1">
                You can cancel anytime through your PayPal account under
                automatic payments. Your access continues until the end of the
                billing period.
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground">
                What happens when my trial expires?
              </p>
              <p className="mt-1">
                You&apos;ll need to upgrade to Pro to continue using Bricks.
                Your conversations and projects are preserved.
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground">
                Can I get a refund?
              </p>
              <p className="mt-1">
                Contact us within 7 days of a charge and we&apos;ll process a
                full refund. No questions asked.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
