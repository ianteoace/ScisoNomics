"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMobileQuickEntry } from "./useMobileQuickEntry";
import { startQuickEntryBridge } from "../../services/mobileQuickEntry";

export function MobileQuickEntryRouter() {
  const { pending, ready, revision, dialogOpen } = useMobileQuickEntry();
  const pathname = usePathname(), router = useRouter();
  useEffect(startQuickEntryBridge, []);
  useEffect(() => {
    if (pending && ready && pending.expiresAt > Date.now() && !dialogOpen() && pathname !== "/movimientos") router.replace("/movimientos");
  }, [pending, ready, revision, pathname, router]);
  return null;
}
