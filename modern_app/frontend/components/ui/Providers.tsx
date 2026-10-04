"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SupabaseOAuthListener } from "../account/SupabaseOAuthListener";
import { MobileStartupGate, StartupScreen } from "../app/BackendStartupGate";
import { getRuntimePlatformSync } from "../../services/platform";

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function Providers({ children }: { children: React.ReactNode }) {
  const platform = getRuntimePlatformSync();
  // This only keeps desktop/browser hydration consistent with static HTML;
  // mobile selects its screen immediately, even before the client snapshot.
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
    try {
      window.localStorage.removeItem("theme");
      window.localStorage.removeItem("scisonomics-theme");
      window.localStorage.removeItem("next-theme");
    } catch {
      // El tema fijo no debe bloquear la app si localStorage no esta disponible.
    }
  }, []);

  if (platform === "android" || platform === "ios") return <MobileStartupGate />;
  if (!hydrated) return <StartupScreen title="Iniciando ScisoNomics" />;
  return <><SupabaseOAuthListener />{children}</>;
}
