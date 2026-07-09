"use client";

import { useEffect, useRef } from "react";

import { ACCOUNT_SESSION_CHANGED_EVENT, getActiveCloudAuthState, getActiveCloudSessionAsync, getActiveOwnerId, getCloudAuthHydrationState } from "../../services/cloudAuth";
import {
  DATA_CHANGED_EVENT,
  SYNC_STATE_CHANGED_EVENT,
  getAutoSyncIntervalMs,
  getSyncRuntimeState,
  isAutoSyncEnabled,
  isSyncInFlight,
  runAutoSync,
  type SyncReason,
} from "../../services/cloudSync";

const AUTO_SYNC_DEBOUNCE_MS = 7000;
const STARTUP_SYNC_DELAY_MS = 1500;
const STARTUP_SYNC_RETRY_MS = 60 * 1000;
const FOCUS_AUTO_SYNC_MIN_MS = 60 * 1000;
const AUTO_SYNC_ERROR_RETRY_MS = 5 * 60 * 1000;
const APP_CLOSE_SYNC_TIMEOUT_MS = 6000;
const APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS = 10000;
const APP_CLOSE_SYNC_EVENT = "scisonomics://app-close-sync-requested";
const STARTUP_AUTH_RECHECK_DELAY_MS = 2000;
const startupSyncedOwners = new Set<string>();
type AutoSyncReason = Exclude<SyncReason, "manual">;
type ExecuteSyncOutcome =
  | "success"
  | "failed"
  | "skipped_disabled"
  | "skipped_no_session"
  | "skipped_db_critical";

export function AutoSyncProvider({ children }: { children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<number | null>(null);
  const pendingAfterCurrentRef = useRef<AutoSyncReason | null>(null);
  const lastErrorNotifiedRef = useRef(false);
  const lastAttemptAtRef = useRef(0);
  const lastErrorAtRef = useRef(0);
  const startupSyncFailedOwnersRef = useRef(new Set<string>());
  const startupHydrationRetriesRef = useRef(new Map<string, number>());

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

    const isDbCriticalError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error || "");
      const normalized = message.toLowerCase();
      return normalized.includes("datos locales necesitan una revision")
        || normalized.includes("reparacion automatica")
        || normalized.includes("db critical");
    };

    const executeSync = async (reason: AutoSyncReason, force = false): Promise<ExecuteSyncOutcome> => {
      if (!force && !isAutoSyncEnabled()) return "skipped_disabled";
      const session = await getActiveCloudSessionAsync();
      if (!session?.token || !session.user?.id) return "skipped_no_session";
      if (isSyncInFlight()) {
        pendingAfterCurrentRef.current = reason;
        return "failed";
      }
      const now = Date.now();
      if (!force && lastErrorAtRef.current && now - lastErrorAtRef.current < AUTO_SYNC_ERROR_RETRY_MS && reason !== "data_change") return "failed";
      lastAttemptAtRef.current = now;
      try {
        await runAutoSync(session.user.email, reason);
        lastErrorNotifiedRef.current = false;
        lastErrorAtRef.current = 0;
        return "success";
      } catch (error) {
        lastErrorAtRef.current = Date.now();
        const runtimeState = getSyncRuntimeState();
        if (reason === "app_start" && isDbCriticalError(error)) {
          console.warn("[auto-sync] startup sync skipped until DB state changes", {
            reason,
            status: "skipped_db_critical",
            phase: runtimeState.phase || "unknown",
            ownerId: `${session.user.id.slice(0, 6)}...`,
          });
          return "skipped_db_critical";
        }
        if (!lastErrorNotifiedRef.current) {
          console.warn("[auto-sync] sync failed; changes remain local", {
            reason,
            status: "failed",
            phase: runtimeState.phase || "unknown",
            errorType: error instanceof Error ? error.name : typeof error,
            ownerId: `${session.user.id.slice(0, 6)}...`,
          });
          lastErrorNotifiedRef.current = true;
        }
        return "failed";
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

    const scheduleAppStart = (delay = STARTUP_SYNC_DELAY_MS) => {
      const ownerId = getActiveOwnerId();
      if (!ownerId || ownerId === "local") return;
      if (startupSyncedOwners.has(ownerId)) return;
      clearStartupTimer();
      startupTimerRef.current = setTimeout(() => {
        startupTimerRef.current = null;
        if (startupSyncedOwners.has(ownerId)) return;
        const hydrationState = getCloudAuthHydrationState();
        void getActiveCloudAuthState().then((authState) => {
          const retryCount = startupHydrationRetriesRef.current.get(ownerId) || 0;

          if (hydrationState.pending && authState.availability !== "active" && retryCount < 1) {
            startupHydrationRetriesRef.current.set(ownerId, retryCount + 1);
            scheduleAppStart(STARTUP_AUTH_RECHECK_DELAY_MS);
            return;
          }

          if (authState.availability !== "active") {
            console.info("[auto-sync] skipped", {
              reason: authState.availability === "local" ? "local_mode" : authState.availability === "none" ? "no_account" : authState.availability,
              ownerId: `${ownerId.slice(0, 6)}...`,
              requiresRelogin: authState.requiresRelogin,
            });
          }

          return executeSync("app_start", true).then((outcome) => {
            startupHydrationRetriesRef.current.delete(ownerId);
            if (outcome === "success" || outcome === "skipped_no_session" || outcome === "skipped_db_critical") {
              startupSyncedOwners.add(ownerId);
              startupSyncFailedOwnersRef.current.delete(ownerId);
              return;
            }
            startupSyncFailedOwnersRef.current.add(ownerId);
            if (getActiveOwnerId() === ownerId && outcome === "failed") {
              scheduleAppStart(STARTUP_SYNC_RETRY_MS);
            }
          }).catch((error) => {
            console.warn("[auto-sync] execute failed", {
              reason: "app_start",
              ownerId: `${ownerId.slice(0, 6)}...`,
              errorType: error instanceof Error ? error.name : typeof error,
            });
          });
        }).catch((error) => {
          console.warn("[auto-sync] execute failed", {
            reason: "startup_check",
            ownerId: `${ownerId.slice(0, 6)}...`,
            errorType: error instanceof Error ? error.name : typeof error,
          });
        });
      }, delay);
    };

    const waitForSyncShutdownWindow = async (onTick?: () => void | Promise<void>) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS) {
        const state = getSyncRuntimeState();
        if (onTick) await onTick();
        if (!state.inFlight) {
          return { idle: true, state };
        }
        const elapsed = Date.now() - startedAt;
        const maxWait = state.criticalSection ? APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS : APP_CLOSE_SYNC_TIMEOUT_MS;
        if (elapsed >= maxWait) {
          return { idle: false, state };
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return { idle: false, state: getSyncRuntimeState() };
    };

    const runAppCloseSyncWithBudget = async (onTick?: () => void | Promise<void>): Promise<ExecuteSyncOutcome | null> => {
      const startedAt = Date.now();
      let resolved = false;
      let outcome: ExecuteSyncOutcome | null = null;
      void executeSync("app_close", true).then((value) => {
        resolved = true;
        outcome = value;
      });

      while (Date.now() - startedAt < APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS) {
        if (onTick) await onTick();
        if (resolved) return outcome;
        const state = getSyncRuntimeState();
        const maxWait = state.criticalSection ? APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS : APP_CLOSE_SYNC_TIMEOUT_MS;
        if (Date.now() - startedAt >= maxWait) return null;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return resolved ? outcome : null;
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
      startupSyncFailedOwnersRef.current.clear();
      const activeOwnerId = getActiveOwnerId();
      startupSyncedOwners.delete(activeOwnerId);
      startupHydrationRetriesRef.current.delete(activeOwnerId);
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
          const updateCloseTimeoutBudget = async () => {
            const state = getSyncRuntimeState();
            const timeoutMs = state.criticalSection ? APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS : APP_CLOSE_SYNC_TIMEOUT_MS;
            await invoke("set_app_close_sync_timeout", { timeoutMs }).catch(() => null);
          };

          unlistenClose = await listen(APP_CLOSE_SYNC_EVENT, async () => {
            clearTimer();
            clearStartupTimer();
            try {
              await updateCloseTimeoutBudget();
              const idleBeforeClose = await waitForSyncShutdownWindow(updateCloseTimeoutBudget);
              if (!idleBeforeClose.idle) {
                const state = idleBeforeClose.state;
                console.warn("[auto-sync] app_close sync interrupted", {
                  reason: "app_close",
                  status: state.criticalSection ? "aborted_critical_timeout" : "aborted_safe",
                  phase: state.phase || "unknown",
                  ownerId: state.ownerId ? `${state.ownerId.slice(0, 6)}...` : "unknown",
                });
                return;
              }

              await updateCloseTimeoutBudget();
              const outcome = await runAppCloseSyncWithBudget(updateCloseTimeoutBudget);
              if (outcome === null) {
                const state = getSyncRuntimeState();
                console.warn("[auto-sync] app_close sync timed out", {
                  reason: "app_close",
                  status: state.criticalSection ? "aborted_critical_timeout" : "aborted_safe",
                  phase: state.phase || "unknown",
                  ownerId: state.ownerId ? `${state.ownerId.slice(0, 6)}...` : "unknown",
                });
              } else {
                await updateCloseTimeoutBudget();
                console.info("[auto-sync] app_close sync finished", {
                  reason: "app_close",
                  status: outcome,
                  phase: getSyncRuntimeState().phase || "completed",
                  ownerId: getActiveOwnerId() !== "local" ? `${getActiveOwnerId().slice(0, 6)}...` : "unknown",
                });
              }
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
