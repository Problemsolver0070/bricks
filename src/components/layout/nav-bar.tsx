"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { Menu, MessageSquare, Hammer } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavBarProps {
  onToggleSidebar: () => void;
}

export function NavBar({ onToggleSidebar }: NavBarProps) {
  const pathname = usePathname();

  const isChat = pathname.startsWith("/chat");
  const isBuild = pathname.startsWith("/build");

  return (
    <nav className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 bg-background px-4">
      {/* Left: Menu + Logo */}
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link
          href="/chat"
          className="text-lg font-bold tracking-tight text-foreground"
        >
          Bricks
        </Link>
      </div>

      {/* Center: Mode Toggle */}
      <div className="flex items-center gap-1 rounded-lg border border-border/50 bg-muted/50 p-1">
        <Link
          href="/chat"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            isChat
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </Link>
        <Link
          href="/build"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            isBuild
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Hammer className="h-3.5 w-3.5" />
          Build
        </Link>
      </div>

      {/* Right: Pricing + User */}
      <div className="flex items-center gap-3">
        <Link
          href="/pricing"
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Pricing
        </Link>
        <UserButton
          appearance={{
            elements: {
              avatarBox: "h-8 w-8",
            },
          }}
        />
      </div>
    </nav>
  );
}
