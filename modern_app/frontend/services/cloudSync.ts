import { API_URL, getLocalRequestHeaders } from "./http";
import { getActiveCloudSession, getActiveOwnerId } from "./cloudAuth";

const LAST_SYNC_KEY = "scisonomics_last_manual_sync_at";
const LAST_AUTO_SYNC_KEY = "scisonomics_last_auto_sync_at";
const LAST_SYNC_ERROR_KEY = "scisonomics_last_sync_error";
const LAST_SYNC_ERROR_DETAILS_KEY = "scisonomics_last_sync_error_details";
const LAST_CLOUD_HEALTH_KEY = "scisonomics_last_cloud_health";
const AUTO_SYNC_ENABLED_KEY = "scisonomics_auto_sync_enabled";
const AUTO_SYNC_BY_OWNER_KEY = "scisonomics_auto_sync_enabled_by_owner_v1";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const LOG_PREFIX = "[manual-sync]";
const CLOUD_SYNC_TIMEOUT_MS = 15000;
export const DATA_CHANGED_EVENT = "scisonomics:data-changed";
export const SYNC_STATE_CHANGED_EVENT = "scisonomics:sync-state-changed";
const SYNC_TABLES = ["categorias", "movimientos", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos"] as const;
type SyncTable = (typeof SYNC_TABLES)[number];
type SyncPayload = { ok: boolean } & Record<SyncTable, unknown[]>;
type AcceptedPayload = Record<SyncTable, string[]>;
type SyncMode = "manual" | "auto";
type SyncReason = "manual" | "auto_local_change" | "auto_remote_pull" | "startup" | "focus" | "interval";
export type SyncErrorType = "network" | "timeout" | "unauthorized" | "forbidden" | "server_error" | "invalid_response" | "unknown";

export type SyncErrorDetails = {
  user_message: string;
  technical_message: string;
  status_code: number | null;
  endpoint: string;
  timestamp: string;
  cloud_api_url: string;
  type: SyncErrorType;
};

export type CloudHealthResult = {
  ok: boolean;
  endpoint: string;
  cloud_api_url: string;
  status_code: number | null;
  type: SyncErrorType | "ok";
  user_message: string;
  technical_message: string;
  timestamp: string;
  version?: string | null;
  service?: string | null;
};

export type SyncOverview = {
  ok: boolean;
  version: string;
  owner_user_id: string;
  mode: "cloud" | "local";
  device_id: string;
  device_name: string;
  has_pending: boolean;
  pending_total: number;
  deleted_pending_total: number;
  tables: Record<SyncTable, { total: number; pending: number; deleted_pending: number; missing_sync_id: number }>;
  last_success: SyncHistoryItem | null;
  last_error: SyncHistoryItem | null;
  last_remote_change_at?: string | null;
  conflicts_total: number;
  conflicts_recent: number;
  latest_conflict?: SyncConflictItem | null;
};

export type SyncHistoryItem = {
  sync_id: string;
  device_id: string | null;
  mode: SyncMode;
  status: "success" | "error" | "skipped";
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  pending_total: number;
  pushed_total: number;
  pulled_total: number;
  deleted_total: number;
  conflicts_total?: number;
  remote_changes_total?: number;
  applied_remote_total?: number;
  kept_local_total?: number;
  error_message: string | null;
  details?: Record<string, unknown> | null;
};

export type SyncConflictItem = {
  conflict_id: string;
  table_name: string;
  record_sync_id: string;
  local_updated_at: string | null;
  remote_updated_at: string | null;
  last_synced_at: string | null;
  resolution: "kept_local" | "applied_remote" | "ignored";
  remote_device_id: string | null;
  remote_device_name: string | null;
  detected_at: string;
  resolved_at: string | null;
  details?: Record<string, unknown> | null;
};

export type CloudDevice = {
  device_id: string;
  device_name: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

type DeviceInfo = {
  ok: boolean;
  device_id: string;
  device_name: string;
  app_version: string;
};

type SyncRunSnapshot = {
  ownerId: string;
  token: string;
  cloudApiUrl: string;
  userEmail?: string;
  startedAt: string;
  reason: SyncReason;
};

let syncInFlight = false;

class CloudSyncError extends Error {
  details: SyncErrorDetails;

  constructor(details: SyncErrorDetails) {
    super(details.user_message);
    this.name = "CloudSyncError";
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function getCloudApiUrl() {
  return CLOUD_API_URL;
}

function cloudEndpoint(path: string) {
  return CLOUD_API_URL ? `${CLOUD_API_URL}${path}` : path;
}

function safeTechnicalMessage(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value || "");
  return raw.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").slice(0, 500);
}

function classifyHttpStatus(status: number): SyncErrorType {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status >= 500) return "server_error";
  return "unknown";
}

function syncUserMessage(type: SyncErrorType) {
  if (type === "network") return "No pudimos conectar con el servicio cloud. Revisa internet, firewall o antivirus.";
  if (type === "timeout") return "La conexion con el servicio cloud tardo demasiado.";
  if (type === "unauthorized") return "La sesion vencio o no es valida. Volve a iniciar sesion.";
  if (type === "forbidden") return "No tenes permisos para sincronizar esta cuenta.";
  if (type === "server_error") return "El servicio cloud respondio con un error interno.";
  if (type === "invalid_response") return "El servicio cloud respondio con un formato inesperado.";
  return "No se pudo sincronizar. Tus cambios quedaron guardados localmente.";
}

function classifyFetchError(error: unknown): SyncErrorType {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  const message = safeTechnicalMessage(error).toLowerCase();
  if (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed") ||
    message.includes("err_connection") ||
    message.includes("err_name_not_resolved") ||
    message.includes("err_cert") ||
    message.includes("err_timed_out") ||
    message.includes("cors") ||
    message.includes("preflight")
  ) {
    return "network";
  }
  return "unknown";
}

function makeSyncErrorDetails(input: {
  type: SyncErrorType;
  endpoint: string;
  technicalMessage: unknown;
  statusCode?: number | null;
  userMessage?: string;
}): SyncErrorDetails {
  return {
    user_message: input.userMessage || syncUserMessage(input.type),
    technical_message: safeTechnicalMessage(input.technicalMessage),
    status_code: input.statusCode ?? null,
    endpoint: input.endpoint,
    timestamp: nowIso(),
    cloud_api_url: CLOUD_API_URL || "no configurada",
    type: input.type,
  };
}

function cloudSyncError(input: {
  type: SyncErrorType;
  endpoint: string;
  technicalMessage: unknown;
  statusCode?: number | null;
  userMessage?: string;
}) {
  return new CloudSyncError(makeSyncErrorDetails(input));
}

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

async function parseResponse<T>(response: Response, fallback: string, options: { cloud?: boolean } = {}): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    console.error(`${LOG_PREFIX} HTTP error`, { url: response.url, status: response.status, body });
    if (!options.cloud) throw new Error(typeof body?.detail === "string" ? body.detail : fallback);
    throw cloudSyncError({
      type: classifyHttpStatus(response.status),
      endpoint: response.url,
      statusCode: response.status,
      technicalMessage: typeof body?.detail === "string" ? body.detail : fallback,
    });
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (!options.cloud) throw new Error(fallback);
    throw cloudSyncError({
      type: "invalid_response",
      endpoint: response.url,
      statusCode: response.status,
      technicalMessage: error,
    });
  }
}

async function localGet<T>(path: string, ownerId?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store", headers: await getLocalRequestHeaders(undefined, ownerId) });
  return parseResponse<T>(response, "No se pudo leer la informacion local para sincronizar.");
}

async function localPost<T>(path: string, payload: unknown, ownerId?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: await getLocalRequestHeaders({ "Content-Type": "application/json" }, ownerId),
    body: JSON.stringify(payload),
  });
  return parseResponse<T>(response, "No se pudo actualizar la informacion local de sincronizacion.");
}

async function cloudGet<T>(path: string, token: string): Promise<T> {
  if (!CLOUD_API_URL) throw cloudSyncError({ type: "unknown", endpoint: path, technicalMessage: "Cloud API URL vacia.", userMessage: "No hay URL cloud configurada en esta instalacion." });
  const response = await cloudFetch(path, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseResponse<T>(response, "No se pudo obtener informacion desde el servicio cloud.", { cloud: true });
}

async function cloudPost<T>(path: string, token: string, payload: unknown): Promise<T> {
  if (!CLOUD_API_URL) throw cloudSyncError({ type: "unknown", endpoint: path, technicalMessage: "Cloud API URL vacia.", userMessage: "No hay URL cloud configurada en esta instalacion." });
  const response = await cloudFetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return parseResponse<T>(response, "No se pudo enviar informacion al servicio cloud.", { cloud: true });
}

async function cloudFetch(path: string, options: RequestInit = {}) {
  const endpoint = cloudEndpoint(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_SYNC_TIMEOUT_MS);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } catch (error) {
    throw cloudSyncError({
      type: classifyFetchError(error),
      endpoint,
      technicalMessage: error,
    });
  } finally {
    clearTimeout(timeout);
  }
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

export function getLastSyncErrorDetails(): SyncErrorDetails | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_SYNC_ERROR_DETAILS_KEY);
    return raw ? (JSON.parse(raw) as SyncErrorDetails) : null;
  } catch {
    return null;
  }
}

export function getLastCloudHealthResult(): CloudHealthResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_CLOUD_HEALTH_KEY);
    return raw ? (JSON.parse(raw) as CloudHealthResult) : null;
  } catch {
    return null;
  }
}

export function isAutoSyncEnabled() {
  if (typeof window === "undefined") return false;
  try {
    const owner = getActiveOwnerId();
    if (owner === "local") return false;
    const raw = window.localStorage.getItem(AUTO_SYNC_BY_OWNER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return Boolean(parsed[owner]);
    }
    return window.localStorage.getItem(AUTO_SYNC_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoSyncEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    const owner = getActiveOwnerId();
    if (owner !== "local") {
      const raw = window.localStorage.getItem(AUTO_SYNC_BY_OWNER_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (enabled) parsed[owner] = true;
      else delete parsed[owner];
      window.localStorage.setItem(AUTO_SYNC_BY_OWNER_KEY, JSON.stringify(parsed));
    }
    if (!enabled) window.localStorage.removeItem(AUTO_SYNC_ENABLED_KEY);
  } catch {
    // La preferencia no debe bloquear el modo local.
  }
  emitSyncStateChanged();
  if (enabled) notifyDataChanged();
}

export function clearAutoSyncPreference(ownerId: string) {
  if (typeof window === "undefined" || !ownerId || ownerId === "local") return;
  try {
    const raw = window.localStorage.getItem(AUTO_SYNC_BY_OWNER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    delete parsed[ownerId];
    window.localStorage.setItem(AUTO_SYNC_BY_OWNER_KEY, JSON.stringify(parsed));
  } catch {
    // La preferencia no debe bloquear el modo local.
  }
  emitSyncStateChanged();
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

function setLastSyncErrorDetails(value: SyncErrorDetails | null) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(LAST_SYNC_ERROR_DETAILS_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(LAST_SYNC_ERROR_DETAILS_KEY);
  } catch {
    // El detalle del error de sync no debe bloquear el modo local.
  }
  emitSyncStateChanged();
}

function setLastCloudHealthResult(value: CloudHealthResult) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CLOUD_HEALTH_KEY, JSON.stringify(value));
  } catch {
    // El diagnostico cloud no debe bloquear la app.
  }
  emitSyncStateChanged();
}

export async function testCloudHealth(): Promise<CloudHealthResult> {
  const timestamp = nowIso();
  if (!CLOUD_API_URL) {
    const result: CloudHealthResult = {
      ok: false,
      endpoint: "/health",
      cloud_api_url: "no configurada",
      status_code: null,
      type: "unknown",
      user_message: "No hay URL cloud configurada en esta instalacion.",
      technical_message: "NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL esta vacia.",
      timestamp,
    };
    setLastCloudHealthResult(result);
    return result;
  }

  const endpoint = cloudEndpoint("/health");
  try {
    const response = await cloudFetch("/health", { cache: "no-store" });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      const result: CloudHealthResult = {
        ok: false,
        endpoint,
        cloud_api_url: CLOUD_API_URL,
        status_code: response.status,
        type: "invalid_response",
        user_message: syncUserMessage("invalid_response"),
        technical_message: safeTechnicalMessage(error),
        timestamp,
      };
      setLastCloudHealthResult(result);
      return result;
    }

    const ok = response.ok && Boolean(body?.ok);
    const errorType = classifyHttpStatus(response.status);
    const result: CloudHealthResult = {
      ok,
      endpoint,
      cloud_api_url: CLOUD_API_URL,
      status_code: response.status,
      type: ok ? "ok" : errorType,
      user_message: ok ? "Conexion cloud OK." : syncUserMessage(errorType),
      technical_message: ok ? "Cloud /health respondio correctamente." : safeTechnicalMessage(body?.detail || body?.message || text || `HTTP ${response.status}`),
      timestamp,
      version: typeof body?.version === "string" ? body.version : null,
      service: typeof body?.service === "string" ? body.service : null,
    };
    setLastCloudHealthResult(result);
    return result;
  } catch (error) {
    const details = error instanceof CloudSyncError
      ? error.details
      : makeSyncErrorDetails({ type: "unknown", endpoint, technicalMessage: error });
    const result: CloudHealthResult = {
      ok: false,
      endpoint: details.endpoint,
      cloud_api_url: details.cloud_api_url,
      status_code: details.status_code,
      type: details.type,
      user_message: details.user_message,
      technical_message: details.technical_message,
      timestamp: details.timestamp,
    };
    setLastCloudHealthResult(result);
    return result;
  }
}

export async function getLocalPending() {
  return localGet<SyncPayload>("/sync/pending");
}

export async function getDeviceInfo() {
  return localGet<DeviceInfo>("/device/info");
}

export async function getSyncOverview() {
  return localGet<SyncOverview>("/sync/overview");
}

export async function getSyncHistory(limit = 10) {
  return localGet<{ ok: boolean; items: SyncHistoryItem[] }>(`/sync/history?limit=${limit}`);
}

async function recordSyncHistory(payload: {
  sync_id: string;
  device_id?: string;
  mode: SyncMode;
  status: "success" | "error" | "skipped";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  pending_total: number;
  pushed_total: number;
  pulled_total: number;
  deleted_total: number;
  conflicts_total?: number;
  remote_changes_total?: number;
  applied_remote_total?: number;
  kept_local_total?: number;
  error_message?: string | null;
  details?: Record<string, unknown>;
}, ownerId?: string) {
  try {
    await localPost("/sync/history", payload, ownerId);
  } catch (error) {
    console.warn(`${LOG_PREFIX} no se pudo registrar historial local`, error);
  }
}

export async function getSyncConflicts(limit = 10) {
  return localGet<{ ok: boolean; items: SyncConflictItem[] }>(`/sync/conflicts?limit=${limit}`);
}

export async function getLocalSessionContext() {
  return localGet<{
    ok: boolean;
    owner_user_id: string;
    mode: "cloud" | "local";
    has_local_data: boolean;
    has_unassigned_data: boolean;
    local_counts: Record<SyncTable, number>;
    local_claimable_total: number;
    visible_data: Record<SyncTable, number>;
  }>("/local-session/context");
}

export async function claimLocalData(ownerUserId: string) {
  return localPost<{ ok: boolean; owner_user_id: string; claimed: Record<SyncTable, number>; claimed_total: number; claimable_total: number }>("/local-session/claim-local-data", {
    target_owner_user_id: ownerUserId,
  });
}

export async function getCloudDevices(token: string) {
  return cloudGet<{ ok: boolean; devices: CloudDevice[] }>("/sync/devices", token);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function countByTable(payload: Partial<Record<SyncTable, unknown[]>>) {
  return Object.fromEntries(SYNC_TABLES.map((table) => [table, Array.isArray(payload[table]) ? payload[table]!.length : 0])) as Record<SyncTable, number>;
}

function countDeletedByTable(payload: Partial<Record<SyncTable, unknown[]>>) {
  return Object.fromEntries(
    SYNC_TABLES.map((table) => [
      table,
      Array.isArray(payload[table])
        ? payload[table]!.filter((item) => typeof item === "object" && item !== null && Boolean((item as { deleted_at?: unknown }).deleted_at)).length
        : 0,
    ]),
  ) as Record<SyncTable, number>;
}

function totalCount(counts: Record<SyncTable, number>) {
  return Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
}

function makeSyncId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function friendlySyncError(error: unknown) {
  if (error instanceof CloudSyncError) return error.details.user_message;
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("load failed") ||
    normalized.includes("err_connection") ||
    normalized.includes("err_name_not_resolved") ||
    normalized.includes("err_cert") ||
    normalized.includes("err_timed_out") ||
    normalized.includes("cors") ||
    normalized.includes("preflight")
  ) return syncUserMessage("network");
  if (normalized.includes("curso")) return "Hay otra sincronizacion en curso.";
  if (normalized.includes("sesion")) return "No hay sesion iniciada.";
  if (normalized.includes("confirmar") || normalized.includes("nube")) return "No se pudo confirmar la sincronizacion con la nube.";
  if (normalized.includes("configurado")) return "No hay URL cloud configurada en esta instalacion.";
  return "No se pudo sincronizar. Tus cambios quedaron guardados localmente.";
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
  const reason: SyncReason = mode === "manual" ? "manual" : "auto_remote_pull";
  return runSyncWithReason(token, userEmail, mode, reason);
}

async function runSyncWithReason(token: string, userEmail: string | undefined, mode: SyncMode, reason: SyncReason) {
  const session = getActiveCloudSession();
  if (!session?.token || !session.user?.id) {
    console.info(`${LOG_PREFIX} skipped: no cloud session`, { mode, reason });
    throw new Error("Inicia sesion para sincronizar.");
  }
  const snapshot: SyncRunSnapshot = {
    ownerId: session.user.id,
    token: session.token,
    cloudApiUrl: CLOUD_API_URL,
    userEmail: userEmail || session.user.email,
    startedAt: nowIso(),
    reason,
  };
  token = snapshot.token;
  userEmail = snapshot.userEmail;
  if (!CLOUD_API_URL) throw cloudSyncError({ type: "unknown", endpoint: "/sync", technicalMessage: "Cloud API URL vacia.", userMessage: "No hay URL cloud configurada en esta instalacion." });
  if (syncInFlight) throw new Error("Ya hay una sincronizacion en curso.");

  syncInFlight = true;
  emitSyncStateChanged();
  const historySyncId = makeSyncId();
  const startedAt = new Date();
  let deviceInfo: DeviceInfo | null = null;
  let pendingCounts = Object.fromEntries(SYNC_TABLES.map((table) => [table, 0])) as Record<SyncTable, number>;
  let deletedCounts = Object.fromEntries(SYNC_TABLES.map((table) => [table, 0])) as Record<SyncTable, number>;

  console.info(`${LOG_PREFIX} start`, {
    cloudApiUrl: snapshot.cloudApiUrl,
    hasToken: Boolean(token),
    user: userEmail || "usuario autenticado",
    mode,
    reason,
    ownerId: snapshot.ownerId,
  });

  try {
    deviceInfo = await localGet<DeviceInfo>("/device/info", snapshot.ownerId);
    const pending = await localGet<SyncPayload>("/sync/pending", snapshot.ownerId);
    pendingCounts = countByTable(pending);
    deletedCounts = countDeletedByTable(pending);
    console.info(`${LOG_PREFIX} pending`, { user: userEmail || "usuario autenticado", mode, reason, device: deviceInfo.device_id, ...pendingCounts });

    const pushResult = await cloudPost<{
      ok: boolean;
      accepted: Partial<Record<SyncTable, unknown>>;
      ignored: Record<SyncTable, number>;
      counts?: Record<string, number>;
    }>("/sync/push", token, {
      device_id: deviceInfo.device_id,
      device_name: deviceInfo.device_name,
      ...emptyPayloadFromPending(pending),
    });

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

    const remote = await cloudGet<SyncPayload>("/sync/pull", token);
    const pulledCounts = countByTable(remote);
    console.info(`${LOG_PREFIX} pull`, { mode, ...pulledCounts });
    const applyResult = await localPost<{
      ok: boolean;
      result: Record<string, number>;
      applied?: Record<SyncTable, number>;
      kept_local?: Record<SyncTable, number>;
      conflicts?: { total: number; by_table: Record<string, number> };
      remote_changes_total?: number;
      applied_remote_total?: number;
      kept_local_total?: number;
    }>("/sync/apply-remote", remote, snapshot.ownerId);
    console.info(`${LOG_PREFIX} apply-remote`, { mode, result: applyResult.result });
    const conflictsTotal = Number(applyResult.conflicts?.total || 0);
    const remoteChangesTotal = Number(applyResult.remote_changes_total || totalCount(pulledCounts));
    const appliedRemoteTotal = Number(applyResult.applied_remote_total || 0);
    const keptLocalTotal = Number(applyResult.kept_local_total || 0);

    let markSyncedExecuted = false;
    if (SYNC_TABLES.some((table) => accepted[table].length > 0)) {
      await localPost("/sync/mark-synced", accepted, snapshot.ownerId);
      markSyncedExecuted = true;
      console.info(`${LOG_PREFIX} mark-synced`, { executed: true, mode, ...acceptedCounts });
    }
    if (!markSyncedExecuted) {
      console.info(`${LOG_PREFIX} mark-synced`, { executed: false, mode, ...Object.fromEntries(SYNC_TABLES.map((table) => [table, 0])) });
    }

    const syncedAt = new Date().toISOString();
    const ownerStillActive = getActiveOwnerId() === snapshot.ownerId;
    if (ownerStillActive) {
      if (mode === "auto") setLastAutoSyncAt(syncedAt);
      else setLastManualSyncAt(syncedAt);
      setLastSyncError(null);
      setLastSyncErrorDetails(null);
    } else {
      console.info(`${LOG_PREFIX} finished for previous owner`, { ownerId: snapshot.ownerId, activeOwnerId: getActiveOwnerId(), mode, reason });
    }
    await recordSyncHistory({
      sync_id: historySyncId,
      device_id: deviceInfo.device_id,
      mode,
      status: "success",
      started_at: startedAt.toISOString(),
      finished_at: syncedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      pending_total: totalCount(pendingCounts),
      pushed_total: totalCount(acceptedCounts),
      pulled_total: totalCount(pulledCounts),
      deleted_total: totalCount(deletedCounts),
      conflicts_total: conflictsTotal,
      remote_changes_total: remoteChangesTotal,
      applied_remote_total: appliedRemoteTotal,
      kept_local_total: keptLocalTotal,
      error_message: null,
      details: {
        pending: pendingCounts,
        pushed: acceptedCounts,
        pulled: pulledCounts,
        deleted: deletedCounts,
        applied: applyResult.result,
        conflicts: applyResult.conflicts,
        kept_local: applyResult.kept_local,
        reason,
        owner_id: snapshot.ownerId,
        owner_changed_during_sync: !ownerStillActive,
      },
    }, snapshot.ownerId);

    return {
      syncedAt,
      uploaded: acceptedCounts,
      ignored: pushResult.ignored,
      applied: applyResult.result,
      pulled: pulledCounts,
      conflictsTotal,
      remoteChangesTotal,
      appliedRemoteTotal,
      keptLocalTotal,
      reason,
      ownerChangedDuringSync: !ownerStillActive,
    };
  } catch (error) {
    const friendly = friendlySyncError(error);
    const cloudError = error instanceof CloudSyncError
      ? error.details
      : makeSyncErrorDetails({ type: "unknown", endpoint: "/sync", technicalMessage: error, userMessage: friendly });
    if (getActiveOwnerId() === snapshot.ownerId) {
      setLastSyncError(friendly);
      setLastSyncErrorDetails(cloudError);
    }
    await recordSyncHistory({
      sync_id: historySyncId,
      device_id: deviceInfo?.device_id,
      mode,
      status: "error",
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      pending_total: totalCount(pendingCounts),
      pushed_total: 0,
      pulled_total: 0,
      deleted_total: totalCount(deletedCounts),
      error_message: friendly,
      details: {
        pending: pendingCounts,
        deleted: deletedCounts,
        reason,
        owner_id: snapshot.ownerId,
        cloud_error: cloudError,
      },
    }, snapshot.ownerId);
    throw new Error(friendly);
  } finally {
    syncInFlight = false;
    emitSyncStateChanged();
  }
}

export async function runManualSync(token: string, userEmail?: string) {
  return runSync(token, userEmail, "manual");
}

export async function runAutoSync(token: string, userEmail?: string, reason: Exclude<SyncReason, "manual"> = "auto_remote_pull") {
  return runSyncWithReason(token, userEmail, "auto", reason);
}
