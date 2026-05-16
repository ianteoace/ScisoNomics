"use client";

import { useEffect, useRef } from "react";

import { ACCOUNT_SESSION_CHANGED_EVENT, getStoredToken } from "../../services/cloudAuth";
import { DATA_CHANGED_EVENT, isAutoSyncEnabled, isSyncInFlight, runAutoSync } from "../../services/cloudSync";

const AUTO_SYNC_DEBOUNCE_MS = 7000;
const STARTUP_AUTO_SYNC_DELAY_MS = 1500;
const PERIODIC_AUTO_SYNC_MS = 15 * 60 * 1000;

export function AutoSyncProvider({ children }: { children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastErrorNotifiedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const executeAutoSync = async () => {
      if (!isAutoSyncEnabled() || isSyncInFlight()) return;
      const token = getStoredToken();
      if (!token) return;
      try {
        await runAutoSync(token);
        lastErrorNotifiedRef.current = false;
      } catch (error) {
        if (!lastErrorNotifiedRef.current) {
          console.warn("[manual-sync] auto sync failed; changes remain local", error);
          lastErrorNotifiedRef.current = true;
        }
      }
    };

    const scheduleAutoSync = (delay = AUTO_SYNC_DEBOUNCE_MS) => {
      clearTimer();
      if (!isAutoSyncEnabled()) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void executeAutoSync();
      }, delay);
    };

    const onDataChanged = () => scheduleAutoSync();
    const onSessionChanged = () => scheduleAutoSync(STARTUP_AUTO_SYNC_DELAY_MS);
    window.addEventListener(DATA_CHANGED_EVENT, onDataChanged);
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, onSessionChanged);

    scheduleAutoSync(STARTUP_AUTO_SYNC_DELAY_MS);
    const interval = window.setInterval(() => scheduleAutoSync(), PERIODIC_AUTO_SYNC_MS);

    return () => {
      clearTimer();
      window.clearInterval(interval);
      window.removeEventListener(DATA_CHANGED_EVENT, onDataChanged);
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, onSessionChanged);
    };
  }, []);

  return <>{children}</>;
}
