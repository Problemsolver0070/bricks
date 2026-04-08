"use client";

import { useEffect } from "react";
import { useBuildStore } from "@/stores/build-store";
import { BuildLayout } from "@/components/build/build-layout";

export default function BuildPage() {
  const reset = useBuildStore((s) => s.reset);

  // Clear state on mount so we start fresh
  useEffect(() => {
    reset();
  }, [reset]);

  return <BuildLayout />;
}
