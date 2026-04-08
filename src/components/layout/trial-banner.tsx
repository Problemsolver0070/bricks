"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, AlertTriangle } from "lucide-react";

interface TrialBannerProps {
  plan: string;
  trialExpiresAt: string | null;
}

function getTimeRemaining(expiresAt: string): {
  expired: boolean;
  hours: number;
  minutes: number;
  label: string;
} {
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const diff = expires - now;

  if (diff <= 0) {
    return { expired: true, hours: 0, minutes: 0, label: "Trial expired" };
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return {
    expired: false,
    hours,
    minutes,
    label: `${parts.join(" ")} remaining`,
  };
}

export function TrialBanner({ plan, trialExpiresAt }: TrialBannerProps) {
  const [timeState, setTimeState] = useState<ReturnType<
    typeof getTimeRemaining
  > | null>(null);

  useEffect(() => {
    if (plan !== "trial" || !trialExpiresAt) return;

    // Initial calculation
    setTimeState(getTimeRemaining(trialExpiresAt));

    // Update every minute
    const interval = setInterval(() => {
      setTimeState(getTimeRemaining(trialExpiresAt));
    }, 60_000);

    return () => clearInterval(interval);
  }, [plan, trialExpiresAt]);

  // Don't show for non-trial plans
  if (plan !== "trial") return null;

  // Don't render until client-side hydration
  if (!timeState) return null;

  if (timeState.expired) {
    return (
      <div className="flex items-center justify-center gap-2 bg-destructive/10 px-4 py-2 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4" />
        <span>Your trial has expired.</span>
        <Link
          href="/pricing"
          className="font-semibold underline underline-offset-2 hover:text-destructive/80 transition-colors"
        >
          Upgrade now
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-2 bg-primary/10 px-4 py-2 text-sm text-primary">
      <Clock className="h-4 w-4" />
      <span>Free trial: {timeState.label}</span>
      <Link
        href="/pricing"
        className="font-semibold underline underline-offset-2 hover:text-primary/80 transition-colors"
      >
        Upgrade
      </Link>
    </div>
  );
}
