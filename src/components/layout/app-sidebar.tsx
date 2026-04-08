"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Plus,
  X,
  MessageSquare,
  Hammer,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface SidebarConversation {
  id: string;
  title: string;
  mode: string;
  updatedAt: string;
}

interface AppSidebarProps {
  conversations: SidebarConversation[];
  isOpen: boolean;
  onClose: () => void;
}

export function AppSidebar({
  conversations,
  isOpen,
  onClose,
}: AppSidebarProps) {
  const pathname = usePathname();

  const chats = conversations.filter((c) => c.mode === "chat");
  const builds = conversations.filter((c) => c.mode === "build");

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border/50 bg-card transition-transform duration-200 md:static md:z-0 md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-border/50 px-4">
          <span className="text-sm font-semibold text-foreground">
            Conversations
          </span>
          <div className="flex items-center gap-1">
            <Link
              href="/chat"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="New conversation"
            >
              <Plus className="h-4 w-4" />
            </Link>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors md:hidden"
              aria-label="Close sidebar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {chats.length > 0 && (
            <ConversationGroup
              label="Chats"
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              items={chats}
              currentPath={pathname}
            />
          )}

          {builds.length > 0 && (
            <ConversationGroup
              label="Builds"
              icon={<Hammer className="h-3.5 w-3.5" />}
              items={builds}
              currentPath={pathname}
            />
          )}

          {conversations.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">
              No conversations yet. Start one!
            </p>
          )}
        </div>
      </aside>
    </>
  );
}

function ConversationGroup({
  label,
  icon,
  items,
  currentPath,
}: {
  label: string;
  icon: React.ReactNode;
  items: SidebarConversation[];
  currentPath: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const href =
            item.mode === "build"
              ? `/build/${item.id}`
              : `/chat/${item.id}`;
          const isActive = currentPath === href;

          return (
            <li key={item.id}>
              <Link
                href={href}
                className={cn(
                  "flex items-center rounded-lg px-2 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                <span className="truncate">{item.title}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
