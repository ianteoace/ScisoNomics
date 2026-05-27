"use client";

import { useEffect, useRef } from "react";

import { ACCOUNT_SESSION_CHANGED_EVENT, getActiveCloudSession } from "../../services/cloudAuth";
import { DATA_CHANGED_EVENT, isAutoSyncEnabled, isSyncInFlight, runAutoSync } from "../../services/cloudSync";

const AUTO_SYNC_DEBOUNCE_MS = 7000;
const STARTUP_AUTO_SYNC_DELAY_MS = 1500;
const PERIODIC_AUTO_SYNC_MS = 30 * 1000;
const FOCUS_AUTO_SYNC_MIN_MS = 60 * 1000;
const AUTO_SYNC_ERROR_RETRY_MS = 5 * 60 * 1000;

export function AutoSyncProvider({ children }: { children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastErrorNotifiedRef = useRef(false);
  const lastAttemptAtRef = useRef(0);
  const lastErrorAtRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const executeAutoSync = async (reason: "startup" | "auto_local_change" | "interval" | "focus") => {
      if (!isAutoSyncEnabled() || isSyncInFlight()) return;
      const session = getActiveCloudSession();
      if (!session?.token || !session.user?.id) return;
      const now = Date.now();
      if (lastErrorAtRef.current && now - lastErrorAtRef.current < AUTO_SYNC_ERROR_RETRY_MS && reason !== "auto_local_change") return;
      lastAttemptAtRef.current = now;
      try {
        await runAutoSync(session.token, session.user.email, reason);
        lastErrorNotifiedRef.current = false;
        lastErrorAtRef.current = 0;
      } catch (error) {
        lastErrorAtRef.current = Date.now();
        if (!lastErrorNotifiedRef.current) {
          console.warn("[manual-sync] auto sync failed; changes remain local", { reason, error });
          lastErrorNotifiedRef.current = true;
        }
      }
    };

    const scheduleAutoSync = (delay = AUTO_SYNC_DEBOUNCE_MS, reason: "startup" | "auto_local_change" | "interval" | "focus" = "auto_local_change") => {
      clearTimer();
      if (!isAutoSyncEnabled()) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void executeAutoSync(reason);
      }, delay);
    };

    const onDataChanged = () => scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS, "auto_local_change");
    const onSessionChanged = () => {
      const session = getActiveCloudSession();
      if (!session) {
        clearTimer();
        lastErrorNotifiedRef.current = false;
        lastErrorAtRef.current = 0;
        return;
      }
      scheduleAutoSync(STARTUP_AUTO_SYNC_DELAY_MS, "startup");
    };
    const onFocus = () => {
      if (Date.now() - lastAttemptAtRef.current < FOCUS_AUTO_SYNC_MIN_MS) return;
      scheduleAutoSync(250, "focus");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener(DATA_CHANGED_EVENT, onDataChanged);
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, onSessionChanged);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    scheduleAutoSync(STARTUP_AUTO_SYNC_DELAY_MS, "startup");
    const interval = window.setInterval(() => scheduleAutoSync(0, "interval"), PERIODIC_AUTO_SYNC_MS);

    return () => {
      clearTimer();
      window.clearInterval(interval);
      window.removeEventListener(DATA_CHANGED_EVENT, onDataChanged);
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, onSessionChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return <>{children}</>;
}
