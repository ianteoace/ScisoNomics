import { API_URL } from "./http";

const LAST_SYNC_KEY = "scisonomics_last_manual_sync_at";
const LAST_AUTO_SYNC_KEY = "scisonomics_last_auto_sync_at";
const LAST_SYNC_ERROR_KEY = "scisonomics_last_sync_error";
const AUTO_SYNC_ENABLED_KEY = "scisonomics_auto_sync_enabled";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const LOG_PREFIX = "[manual-sync]";
export const DATA_CHANGED_EVENT = "scisonomics:data-changed";
export const SYNC_STATE_CHANGED_EVENT = "scisonomics:sync-state-changed";
const SYNC_TABLES = ["categorias", "movimientos", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos"] as const;
type SyncTable = (typeof SYNC_TABLES)[number];
type SyncPayload = { ok: boolean } & Record<SyncTable, unknown[]>;
type AcceptedPayload = Record<SyncTable, string[]>;
type SyncMode = "manual" | "auto";

let syncInFlight = false;

function emitSyncStateChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(SYNC_STATE_CHANGED_EVENT));
  } catch {
    // El estado de sincronizacion no debe bloquear la app.
  }
}

export function notifyDataChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
  } catch {
    // La sync automatica no debe bloquear una accion local.
  }
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    console.error(`${LOG_PREFIX} HTTP error`, { url: response.url, status: response.status, body });
    throw new Error(typeof body?.detail === "string" ? body.detail : fallback);
  }
  return response.json() as Promise<T>;
}

async function localGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  return parseResponse<T>(response, "No se pudo leer la informacion local para sincronizar.");
}

async function localPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseResponse<T>(response, "No se pudo actualizar la informacion local de sincronizacion.");
}

async function cloudGet<T>(path: string, token: string): Promise<T> {
  if (!CLOUD_API_URL) throw new Error("El servicio cloud no esta configurado en este entorno.");
  const response = await fetch(`${CLOUD_API_URL}${path}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseResponse<T>(response, "No se pudo obtener informacion desde el servicio cloud.");
}

async function cloudPost<T>(path: string, token: string, payload: unknown): Promise<T> {
  if (!CLOUD_API_URL) throw new Error("El servicio cloud no esta configurado en este entorno.");
  const response = await fetch(`${CLOUD_API_URL}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return parseResponse<T>(response, "No se pudo enviar informacion al servicio cloud.");
}

export function getLastManualSyncAt() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

export function getLastAutoSyncAt() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_AUTO_SYNC_KEY);
  } catch {
    return null;
  }
}

export function getLastSyncError() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_SYNC_ERROR_KEY);
  } catch {
    return null;
  }
}

export function isAutoSyncEnabled() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTO_SYNC_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoSyncEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(AUTO_SYNC_ENABLED_KEY, "1");
    else window.localStorage.removeItem(AUTO_SYNC_ENABLED_KEY);
  } catch {
    // La preferencia no debe bloquear el modo local.
  }
  emitSyncStateChanged();
  if (enabled) notifyDataChanged();
}

function setLastManualSyncAt(value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SYNC_KEY, value);
  } catch {
    // La fecha de sync no debe bloquear la sincronizacion.
  }
}

function setLastAutoSyncAt(value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_AUTO_SYNC_KEY, value);
  } catch {
    // La fecha de sync no debe bloquear la sincronizacion.
  }
}

function setLastSyncError(value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(LAST_SYNC_ERROR_KEY, value);
    else window.localStorage.removeItem(LAST_SYNC_ERROR_KEY);
  } catch {
    // El error de sync no debe bloquear el modo local.
  }
  emitSyncStateChanged();
}

export async function getLocalPending() {
  return localGet<SyncPayload>("/sync/pending");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function countByTable(payload: Partial<Record<SyncTable, unknown[]>>) {
  return Object.fromEntries(SYNC_TABLES.map((table) => [table, Array.isArray(payload[table]) ? payload[table]!.length : 0])) as Record<SyncTable, number>;
}

function acceptedByTable(value: Partial<Record<SyncTable, unknown>>) {
  return Object.fromEntries(SYNC_TABLES.map((table) => [table, asStringArray(value[table])])) as AcceptedPayload;
}

function emptyPayloadFromPending(pending: SyncPayload) {
  return Object.fromEntries(SYNC_TABLES.map((table) => [table, pending[table] || []])) as Record<SyncTable, unknown[]>;
}

export function isSyncInFlight() {
  return syncInFlight;
}

export async function runSync(token: string, userEmail?: string, mode: SyncMode = "manual") {
  if (!token) throw new Error("Inicia sesion para sincronizar.");
  if (!CLOUD_API_URL) throw new Error("El servicio cloud no esta configurado en este entorno.");
  if (syncInFlight) throw new Error("Ya hay una sincronizacion en curso.");

  syncInFlight = true;
  emitSyncStateChanged();

  console.info(`${LOG_PREFIX} start`, {
    cloudApiUrl: CLOUD_API_URL,
    hasToken: Boolean(token),
    user: userEmail || "usuario autenticado",
    mode,
  });

  try {
    const pending = await getLocalPending();
    const pendingCounts = countByTable(pending);
    console.info(`${LOG_PREFIX} pending`, { user: userEmail || "usuario autenticado", mode, ...pendingCounts });

    const pushResult = await cloudPost<{
      ok: boolean;
      accepted: Partial<Record<SyncTable, unknown>>;
      ignored: Record<SyncTable, number>;
      counts?: Record<string, number>;
    }>("/sync/push", token, emptyPayloadFromPending(pending));

    const accepted = acceptedByTable(pushResult.accepted || {});
    const counts = pushResult.counts || {};
    const acceptedCounts = Object.fromEntries(SYNC_TABLES.map((table) => [table, accepted[table].length])) as Record<SyncTable, number>;
    console.info(`${LOG_PREFIX} push result`, {
      user: userEmail || "usuario autenticado",
      mode,
      counts,
      acceptedCounts,
    });

    if (!pushResult.ok) {
      throw new Error("No se pudo confirmar la sincronizacion con la nube. No se modifico el estado local.");
    }
    const hasMismatch = SYNC_TABLES.some((table) => {
      const pendingCount = pendingCounts[table];
      return (
        accepted[table].length !== pendingCount ||
        counts[`${table}_received`] !== pendingCount ||
        counts[`${table}_saved`] !== pendingCount
      );
    });
    if (hasMismatch) {
      console.error(`${LOG_PREFIX} cloud confirmation mismatch`, {
        pending: pendingCounts,
        accepted: acceptedCounts,
        counts,
        mode,
      });
      throw new Error("No se pudo confirmar la sincronizacion con la nube. No se modifico el estado local.");
    }

    let markSyncedExecuted = false;
    if (SYNC_TABLES.some((table) => accepted[table].length > 0)) {
      await localPost("/sync/mark-synced", accepted);
      markSyncedExecuted = true;
      console.info(`${LOG_PREFIX} mark-synced`, { executed: true, mode, ...acceptedCounts });
    }
    if (!markSyncedExecuted) {
      console.info(`${LOG_PREFIX} mark-synced`, { executed: false, mode, ...Object.fromEntries(SYNC_TABLES.map((table) => [table, 0])) });
    }

    const remote = await cloudGet<SyncPayload>("/sync/pull", token);
    console.info(`${LOG_PREFIX} pull`, { mode, ...countByTable(remote) });
    const applyResult = await localPost<{ ok: boolean; result: Record<string, number> }>("/sync/apply-remote", remote);
    console.info(`${LOG_PREFIX} apply-remote`, { mode, result: applyResult.result });

    const syncedAt = new Date().toISOString();
    if (mode === "auto") setLastAutoSyncAt(syncedAt);
    else setLastManualSyncAt(syncedAt);
    setLastSyncError(null);

    return {
      syncedAt,
      uploaded: acceptedCounts,
      ignored: pushResult.ignored,
      applied: applyResult.result,
    };
  } catch (error) {
    if (mode === "auto") setLastSyncError(error instanceof Error ? error.message : "No se pudo sincronizar automaticamente.");
    throw error;
  } finally {
    syncInFlight = false;
    emitSyncStateChanged();
  }
}

export async function runManualSync(token: string, userEmail?: string) {
  return runSync(token, userEmail, "manual");
}

export async function runAutoSync(token: string, userEmail?: string) {
  return runSync(token, userEmail, "auto");
}
