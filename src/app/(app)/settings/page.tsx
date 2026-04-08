import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getUserByClerkId, getSubscription } from "@/lib/db/queries";
import {
  User,
  CreditCard,
  Crown,
  Clock,
  ChevronRight,
  Mail,
} from "lucide-react";

export const metadata = {
  title: "Settings - Bricks",
  description: "Manage your Bricks account settings",
};

export default async function SettingsPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const clerkUser = await currentUser();
  const dbUser = await getUserByClerkId(clerkId);
  const subscription = dbUser ? await getSubscription(dbUser.id) : null;

  const plan = dbUser?.plan ?? "trial";
  const isPro = plan === "pro";
  const email = clerkUser?.emailAddresses?.[0]?.emailAddress ?? "Not available";
  const fullName =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") ||
    "Not set";
  const avatarUrl = clerkUser?.imageUrl;

  return (
    <div className="flex flex-1 justify-center overflow-y-auto p-6">
      <div className="w-full max-w-2xl space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your account and subscription
          </p>
        </div>

        {/* Profile Section */}
        <div className="rounded-xl border border-border bg-card p-6 ring-1 ring-foreground/5">
          <div className="mb-4 flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">Profile</h2>
          </div>

          <div className="flex items-center gap-4">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={fullName}
                className="h-14 w-14 rounded-full ring-2 ring-border"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground">
                {fullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{fullName}</p>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Mail className="h-3.5 w-3.5" />
                {email}
              </div>
            </div>
          </div>
        </div>

        {/* Subscription Section */}
        <div className="rounded-xl border border-border bg-card p-6 ring-1 ring-foreground/5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-base font-semibold text-foreground">
                Subscription
              </h2>
            </div>
            {isPro ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                <Crown className="h-3 w-3" />
                Pro
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                <Clock className="h-3 w-3" />
                Trial
              </span>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Current plan</span>
              <span className="font-medium text-foreground capitalize">
                {plan}
              </span>
            </div>

            {subscription && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span
                  className={`font-medium capitalize ${
                    subscription.status === "active"
                      ? "text-green-600 dark:text-green-400"
                      : "text-yellow-600 dark:text-yellow-400"
                  }`}
                >
                  {subscription.status}
                </span>
              </div>
            )}

            {!isPro && dbUser?.trialExpiresAt && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Trial expires</span>
                <span className="font-medium text-foreground">
                  {new Date(dbUser.trialExpiresAt).toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric", year: "numeric" }
                  )}
                </span>
              </div>
            )}
          </div>

          {/* Billing Link */}
          <div className="mt-4 border-t border-border pt-4">
            <Link
              href="/settings/billing"
              className="flex items-center justify-between rounded-lg p-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <span>Manage billing</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>

            {!isPro && (
              <Link
                href="/pricing"
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Crown className="h-4 w-4" />
                Upgrade to Pro
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
