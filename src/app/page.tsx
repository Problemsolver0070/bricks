import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { MessageSquare, Hammer, Rocket } from "lucide-react";

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect("/chat");

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <span className="text-xl font-bold tracking-tight text-foreground">
          Bricks
        </span>
        <div className="flex items-center gap-3">
          <Link
            href="/sign-in"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* ─── Hero ────────────────────────────────────────────────────────── */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary mb-8">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          48 hours free — no credit card required
        </div>

        <h1 className="max-w-3xl text-5xl font-bold tracking-tight text-foreground sm:text-6xl lg:text-7xl">
          Build anything with{" "}
          <span className="text-primary">The Fixer</span>
        </h1>

        <p className="mt-6 max-w-xl text-lg text-muted-foreground leading-relaxed">
          Describe what you want. The Fixer writes the code, previews it live,
          and ships it — all from one conversation.
        </p>

        <div className="mt-10 flex flex-col gap-4 sm:flex-row">
          <Link
            href="/sign-up"
            className="rounded-lg bg-primary px-8 py-3 text-base font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Start Building
          </Link>
          <Link
            href="/pricing"
            className="rounded-lg border border-border px-8 py-3 text-base font-semibold text-foreground hover:bg-muted transition-colors"
          >
            View Pricing
          </Link>
        </div>

        {/* ─── Feature Cards ───────────────────────────────────────────── */}
        <div className="mt-24 grid w-full max-w-4xl gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={<MessageSquare className="h-6 w-6 text-primary" />}
            title="Chat"
            description="Brainstorm, debug, and plan with The Fixer in natural conversation."
          />
          <FeatureCard
            icon={<Hammer className="h-6 w-6 text-primary" />}
            title="Build"
            description="Generate full web apps with live preview. Edit with words, not code."
          />
          <FeatureCard
            icon={<Rocket className="h-6 w-6 text-primary" />}
            title="Ship"
            description="One-click deploy. Go from idea to live URL in minutes."
          />
        </div>
      </main>

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-border/50 px-6 py-8 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} Bricks. All rights reserved.</p>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-border/50 bg-card p-8 text-center transition-colors hover:border-primary/30">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
        {icon}
      </div>
      <h3 className="mb-2 text-lg font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {description}
      </p>
    </div>
  );
}
