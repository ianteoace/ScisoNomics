"use client";

import { useEffect, useRef } from "react";

import { ACCOUNT_SESSION_CHANGED_EVENT, getActiveCloudSession } from "../../services/cloudAuth";
import {
  DATA_CHANGED_EVENT,
  SYNC_STATE_CHANGED_EVENT,
  getAutoSyncIntervalMs,
  isAutoSyncEnabled,
  isSyncInFlight,
  runAutoSync,
  waitForSyncIdle,
  type SyncReason,
} from "../../services/cloudSync";

const AUTO_SYNC_DEBOUNCE_MS = 7000;
const STARTUP_SYNC_DELAY_MS = 1500;
const FOCUS_AUTO_SYNC_MIN_MS = 60 * 1000;
const AUTO_SYNC_ERROR_RETRY_MS = 5 * 60 * 1000;
const APP_CLOSE_SYNC_TIMEOUT_MS = 4500;
const APP_CLOSE_SYNC_EVENT = "scisonomics://app-close-sync-requested";
const startupSyncedOwners = new Set<string>();
type AutoSyncReason = Exclude<SyncReason, "manual">;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export function AutoSyncProvider({ children }: { children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<number | null>(null);
  const pendingAfterCurrentRef = useRef<AutoSyncReason | null>(null);
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

    const clearStartupTimer = () => {
      if (startupTimerRef.current) {
        clearTimeout(startupTimerRef.current);
        startupTimerRef.current = null;
      }
    };

    const executeSync = async (reason: AutoSyncReason, force = false) => {
      if (!force && !isAutoSyncEnabled()) return;
      const session = getActiveCloudSession();
      if (!session?.token || !session.user?.id) return;
      if (isSyncInFlight()) {
        pendingAfterCurrentRef.current = reason;
        return;
      }
      const now = Date.now();
      if (!force && lastErrorAtRef.current && now - lastErrorAtRef.current < AUTO_SYNC_ERROR_RETRY_MS && reason !== "data_change") return;
      lastAttemptAtRef.current = now;
      try {
        await runAutoSync(session.token, session.user.email, reason);
        lastErrorNotifiedRef.current = false;
        lastErrorAtRef.current = 0;
      } catch (error) {
        lastErrorAtRef.current = Date.now();
        if (!lastErrorNotifiedRef.current) {
          console.warn("[auto-sync] sync failed; changes remain local", {
            reason,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          lastErrorNotifiedRef.current = true;
        }
      } finally {
        const pendingReason = pendingAfterCurrentRef.current;
        pendingAfterCurrentRef.current = null;
        if (pendingReason && pendingReason !== "app_close") void executeSync(pendingReason, pendingReason === "app_start");
      }
    };

    const scheduleSync = (
      delay = AUTO_SYNC_DEBOUNCE_MS,
      reason: AutoSyncReason = "data_change",
      force = false,
    ) => {
      clearTimer();
      if (!force && !isAutoSyncEnabled()) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void executeSync(reason, force);
      }, delay);
    };

    const scheduleAppStart = () => {
      const ownerId = getActiveCloudSession()?.user.id;
      if (!ownerId || startupSyncedOwners.has(ownerId)) return;
      clearStartupTimer();
      startupTimerRef.current = setTimeout(() => {
        startupTimerRef.current = null;
        if (startupSyncedOwners.has(ownerId)) return;
        startupSyncedOwners.add(ownerId);
        void executeSync("app_start", true);
      }, STARTUP_SYNC_DELAY_MS);
    };

    const resetInterval = () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = window.setInterval(() => scheduleSync(0, "interval"), getAutoSyncIntervalMs());
    };

    const onDataChanged = () => scheduleSync(AUTO_SYNC_DEBOUNCE_MS, "data_change");
    const onSessionChanged = () => {
      clearTimer();
      clearStartupTimer();
      pendingAfterCurrentRef.current = null;
      lastErrorNotifiedRef.current = false;
      lastErrorAtRef.current = 0;
      resetInterval();
      scheduleAppStart();
    };
    const onFocus = () => {
      if (Date.now() - lastAttemptAtRef.current < FOCUS_AUTO_SYNC_MIN_MS) return;
      scheduleSync(250, "focus");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onFocus();
    };

    let unlistenClose: (() => void) | null = null;
    if ("__TAURI_INTERNALS__" in window) {
      void Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")])
        .then(async ([{ listen }, { invoke }]) => {
          unlistenClose = await listen(APP_CLOSE_SYNC_EVENT, async () => {
            clearTimer();
            try {
              await withTimeout(
                (async () => {
                  if (await waitForSyncIdle(1000)) await executeSync("app_close", true);
                })(),
                APP_CLOSE_SYNC_TIMEOUT_MS,
              );
            } finally {
              await invoke("complete_app_close_sync").catch(() => null);
            }
          });
        })
        .catch((error) => {
          console.warn("[auto-sync] app_close listener unavailable", { errorType: error instanceof Error ? error.name : typeof error });
        });
    }

    window.addEventListener(DATA_CHANGED_EVENT, onDataChanged);
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, onSessionChanged);
    window.addEventListener(SYNC_STATE_CHANGED_EVENT, resetInterval);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    resetInterval();
    scheduleAppStart();

    return () => {
      clearTimer();
      clearStartupTimer();
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      unlistenClose?.();
      window.removeEventListener(DATA_CHANGED_EVENT, onDataChanged);
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, onSessionChanged);
      window.removeEventListener(SYNC_STATE_CHANGED_EVENT, resetInterval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return <>{children}</>;
}
