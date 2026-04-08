"use client";

import { useState } from "react";
import { NavBar } from "@/components/layout/nav-bar";
import { TrialBanner } from "@/components/layout/trial-banner";
import {
  AppSidebar,
  type SidebarConversation,
} from "@/components/layout/app-sidebar";

interface AppLayoutClientProps {
  plan: string;
  trialExpiresAt: string | null;
  conversations: SidebarConversation[];
  children: React.ReactNode;
}

export function AppLayoutClient({
  plan,
  trialExpiresAt,
  conversations,
  children,
}: AppLayoutClientProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TrialBanner plan={plan} trialExpiresAt={trialExpiresAt} />
      <NavBar onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />
      <div className="flex flex-1 overflow-hidden">
        <AppSidebar
          conversations={conversations}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
