import { API_URL, getLocalRequestHeaders, getLocalRequestSecurity, getLocalRequestSecuritySnapshot, type LocalRequestSecurity } from "./http";
import { getActiveCloudSession, getActiveOwnerId } from "./cloudAuth";

const LAST_SYNC_KEY = "scisonomics_last_manual_sync_at";
const LAST_AUTO_SYNC_KEY = "scisonomics_last_auto_sync_at";
const LAST_SYNC_ERROR_KEY = "scisonomics_last_sync_error";
const LAST_SYNC_ERROR_DETAILS_KEY = "scisonomics_last_sync_error_details";
const LAST_CLOUD_HEALTH_KEY = "scisonomics_last_cloud_health";
const LAST_CLOUD_SESSION_TEST_KEY = "scisonomics_last_cloud_session_test";
const LAST_CLOUD_SYNC_TEST_KEY = "scisonomics_last_cloud_sync_test";
const LAST_SYNC_ATTEMPT_KEY = "scisonomics_last_sync_attempt";
const LAST_LOCAL_PROTECTED_TEST_KEY = "scisonomics_last_local_protected_test";
const LAST_LOCAL_APPLY_CHECK_KEY = "scisonomics_last_local_apply_check";
const AUTO_SYNC_ENABLED_KEY = "scisonomics_auto_sync_enabled";
const AUTO_SYNC_BY_OWNER_KEY = "scisonomics_auto_sync_enabled_by_owner_v1";
const AUTO_SYNC_INTERVAL_BY_OWNER_KEY = "scisonomics_auto_sync_interval_by_owner_v1";
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const LOG_PREFIX = "[manual-sync]";
const CLOUD_SYNC_TIMEOUT_MS = 15000;
export const DATA_CHANGED_EVENT = "scisonomics:data-changed";
export const SYNC_STATE_CHANGED_EVENT = "scisonomics:sync-state-changed";
const SYNC_TABLES = ["categorias", "tags", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos", "movimientos", "movimiento_tags"] as const;
type SyncTable = (typeof SYNC_TABLES)[number];
type SyncPayload = { ok: boolean } & Record<SyncTable, unknown[]>;
type AcceptedPayload = Record<SyncTable, string[]>;
type SyncMode = "manual" | "auto";
export type SyncReason = "manual" | "app_start" | "app_close" | "data_change" | "auto_remote_pull" | "focus" | "interval";
export type SyncErrorType = "network" | "timeout" | "unauthorized" | "forbidden" | "server_error" | "invalid_response" | "unknown";

export type SyncErrorDetails = {
  user_message: string;
  technical_message: string;
  status_code: number | null;
  endpoint: string;
  method: string;
  phase: SyncDiagnosticPhase;
  items_total: number | null;
  payload_bytes: number | null;
  body_constructed: boolean | null;
  owner_used: string | null;
  reason: SyncReason | null;
  pending_counts: Partial<Record<SyncTable, number>> | null;
  local_security: LocalRequestSecurity | null;
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

export type SyncDiagnosticPhase =
  | "local_device_info"
  | "local_pending"
  | "cloud_push"
  | "cloud_pull"
  | "local_apply_remote"
  | "local_mark_synced"
  | "local_integrity"
  | "health"
  | "session"
  | "sync_health"
  | "sync"
  | "unknown";

export type SyncAttemptDetails = {
  phase: SyncDiagnosticPhase;
  endpoint: string;
  method: string;
  status_code: number | null;
  ok: boolean | null;
  owner_used: string | null;
  reason: SyncReason | null;
  pending_counts: Partial<Record<SyncTable, number>> | null;
  items_total: number | null;
  payload_bytes: number | null;
  body_constructed: boolean | null;
  technical_message: string;
  timestamp: string;
};

export type CloudSessionTestResult = {
  ok: boolean;
  endpoint: string;
  method: "GET";
  status_code: number | null;
  type: SyncErrorType | "ok";
  user_message: string;
  technical_message: string;
  timestamp: string;
  user_id?: string | null;
  email?: string | null;
};

export type CloudSyncTestResult = CloudSessionTestResult;

export type LocalProtectedTestResult = {
  ok: boolean;
  endpoint: string;
  method: "GET";
  status_code: number | null;
  user_message: string;
  technical_message: string;
  timestamp: string;
  security: LocalRequestSecurity;
};

export type LocalApplyRemoteCheckResult = {
  ok: boolean;
  endpoint: string;
  method: "POST";
  status_code: number | null;
  user_message: string;
  technical_message: string;
  timestamp: string;
  security: LocalRequestSecurity;
  body_constructed: boolean;
  payload_bytes: number;
  body_parsed: boolean | null;
  remote_total: number;
  counts_by_entity: Record<SyncTable, number>;
};

export type LocalDbIntegrityResult = {
  ok: boolean;
  status: "healthy" | "warning" | "critical";
  issues_count: number;
  warnings_count: number;
  repairable_count: number;
  backup_recommended: boolean;
  schema_version?: string | null;
  expected_schema_version?: string;
  safe_summary: string[];
  issues: Array<{ code: string; severity: "warning" | "critical"; table: string | null; count: number; repairable: boolean }>;
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

function shortIdentifier(value: string) {
  return value ? `${value.slice(0, 6)}...` : "unknown";
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
  method?: string;
  phase?: SyncErrorDetails["phase"];
  itemsTotal?: number | null;
  payloadBytes?: number | null;
  bodyConstructed?: boolean | null;
  ownerUsed?: string | null;
  reason?: SyncReason | null;
  pendingCounts?: Partial<Record<SyncTable, number>> | null;
  localSecurity?: LocalRequestSecurity | null;
}): SyncErrorDetails {
  return {
    user_message: input.userMessage || syncUserMessage(input.type),
    technical_message: safeTechnicalMessage(input.technicalMessage),
    status_code: input.statusCode ?? null,
    endpoint: input.endpoint,
    method: input.method || "GET",
    phase: input.phase || "unknown",
    items_total: input.itemsTotal ?? null,
    payload_bytes: input.payloadBytes ?? null,
    body_constructed: input.bodyConstructed ?? null,
    owner_used: input.ownerUsed ?? null,
    reason: input.reason ?? null,
    pending_counts: input.pendingCounts ?? null,
    local_security: input.localSecurity ?? null,
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
  method?: string;
  phase?: SyncErrorDetails["phase"];
  itemsTotal?: number | null;
  payloadBytes?: number | null;
  bodyConstructed?: boolean | null;
  ownerUsed?: string | null;
  reason?: SyncReason | null;
  pendingCounts?: Partial<Record<SyncTable, number>> | null;
  localSecurity?: LocalRequestSecurity | null;
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

async function parseResponse<T>(
  response: Response,
  fallback: string,
  options: {
    cloud?: boolean;
    method?: string;
    phase?: SyncErrorDetails["phase"];
    itemsTotal?: number | null;
    payloadBytes?: number | null;
    bodyConstructed?: boolean | null;
    ownerUsed?: string | null;
    reason?: SyncReason | null;
    pendingCounts?: Partial<Record<SyncTable, number>> | null;
    localSecurity?: LocalRequestSecurity | null;
  } = {},
): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    console.error(`${LOG_PREFIX} HTTP error`, { endpoint: new URL(response.url).pathname, status: response.status });
    if (!options.cloud) throw new Error(typeof body?.detail === "string" ? body.detail : fallback);
    throw cloudSyncError({
      type: classifyHttpStatus(response.status),
      endpoint: response.url,
      statusCode: response.status,
      technicalMessage: typeof body?.detail === "string" ? body.detail : fallback,
      method: options.method,
      phase: options.phase,
      itemsTotal: options.itemsTotal,
      payloadBytes: options.payloadBytes,
      bodyConstructed: options.bodyConstructed,
      ownerUsed: options.ownerUsed,
      reason: options.reason,
      pendingCounts: options.pendingCounts,
      localSecurity: options.localSecurity,
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
      method: options.method,
      phase: options.phase,
      itemsTotal: options.itemsTotal,
      payloadBytes: options.payloadBytes,
      bodyConstructed: options.bodyConstructed,
      ownerUsed: options.ownerUsed,
      reason: options.reason,
      pendingCounts: options.pendingCounts,
      localSecurity: options.localSecurity,
    });
  }
}

async function localGet<T>(path: string, ownerId?: string, phase?: SyncDiagnosticPhase): Promise<T> {
  const endpoint = `${API_URL}${path}`;
  let security: LocalRequestSecurity | null = null;
  try {
    const request = await getLocalRequestSecurity(undefined, ownerId, Boolean(phase));
    security = request.security;
    const response = await fetch(endpoint, { cache: "no-store", headers: request.headers });
    return parseResponse<T>(response, "No se pudo leer la informacion local para sincronizar.", { cloud: Boolean(phase), method: "GET", phase, ownerUsed: ownerId, localSecurity: security });
  } catch (error) {
    if (!phase) throw error;
    if (error instanceof CloudSyncError) {
      if (error.details.status_code === 401 || error.details.status_code === 403) {
        throw cloudSyncError({ type: error.details.type, endpoint: error.details.endpoint, statusCode: error.details.status_code, technicalMessage: error.details.technical_message, method: error.details.method, phase: error.details.phase, userMessage: "No se pudo autenticar contra el servicio local.", ownerUsed: ownerId, localSecurity: security });
      }
      throw error;
    }
    security ||= getLocalRequestSecuritySnapshot(ownerId);
    throw cloudSyncError({ type: classifyFetchError(error), endpoint, technicalMessage: error, method: "GET", phase, ownerUsed: ownerId, localSecurity: security });
  }
}

async function localPost<T>(path: string, payload: unknown, ownerId?: string, phase?: SyncDiagnosticPhase): Promise<T> {
  const endpoint = `${API_URL}${path}`;
  let security: LocalRequestSecurity | null = null;
  let body: string | null = null;
  let payloadBytes: number | null = null;
  const entityCounts = phase === "local_apply_remote" && typeof payload === "object" && payload !== null
    ? countByTable(payload as Partial<Record<SyncTable, unknown[]>>)
    : null;
  try {
    body = JSON.stringify(payload);
    payloadBytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(body).byteLength : body.length;
    const request = await getLocalRequestSecurity({ "Content-Type": "application/json" }, ownerId, Boolean(phase));
    security = request.security;
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: request.headers,
      body,
    });
    return parseResponse<T>(response, "No se pudo actualizar la informacion local de sincronizacion.", {
      cloud: Boolean(phase),
      method: "POST",
      phase,
      ownerUsed: ownerId,
      localSecurity: security,
      bodyConstructed: true,
      payloadBytes,
      itemsTotal: entityCounts ? totalCount(entityCounts) : null,
      pendingCounts: entityCounts,
    });
  } catch (error) {
    if (!phase) throw error;
    if (error instanceof CloudSyncError) {
      if (error.details.status_code === 401 || error.details.status_code === 403) {
        throw cloudSyncError({ type: error.details.type, endpoint: error.details.endpoint, statusCode: error.details.status_code, technicalMessage: error.details.technical_message, method: error.details.method, phase: error.details.phase, userMessage: "No se pudo autenticar contra el servicio local.", ownerUsed: ownerId, localSecurity: security });
      }
      throw error;
    }
    security ||= getLocalRequestSecuritySnapshot(ownerId);
    const type = classifyFetchError(error);
    throw cloudSyncError({
      type,
      endpoint,
      technicalMessage: error,
      method: "POST",
      phase,
      ownerUsed: ownerId,
      localSecurity: security,
      bodyConstructed: body !== null,
      payloadBytes,
      itemsTotal: entityCounts ? totalCount(entityCounts) : null,
      pendingCounts: entityCounts,
      userMessage: type === "network" && phase === "local_apply_remote"
        ? "La sincronizacion cloud funciono, pero fallo la comunicacion con el servicio local al aplicar datos remotos. Puede ser token local, CORS local o backend local no disponible."
        : undefined,
    });
  }
}

type CloudRequestMetadata = {
  phase?: SyncDiagnosticPhase;
  itemsTotal?: number | null;
  ownerUsed?: string | null;
  reason?: SyncReason | null;
  pendingCounts?: Partial<Record<SyncTable, number>> | null;
};

const MAX_SYNC_PAYLOAD_BYTES = 5 * 1024 * 1024;

function validateJsonSafeValue(value: unknown, seen: WeakSet<object>) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("El payload contiene un numero no finito.");
  if (typeof value === "undefined") throw new Error("El payload contiene un valor undefined.");
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("El payload contiene una fecha invalida.");
    return;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) throw new Error("El payload contiene un archivo no permitido.");
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new Error("El payload contiene una referencia circular.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJsonSafeValue(item, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) validateJsonSafeValue(item, seen);
}

function serializeCloudPayload(path: string, payload: unknown, metadata: CloudRequestMetadata) {
  let payloadBytes: number | null = null;
  try {
    validateJsonSafeValue(payload, new WeakSet<object>());
    const body = JSON.stringify(payload);
    if (typeof body !== "string") throw new Error("No se pudo construir el body JSON.");
    payloadBytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(body).byteLength : body.length;
    if (payloadBytes > MAX_SYNC_PAYLOAD_BYTES) throw new Error(`El payload supera el limite seguro de ${MAX_SYNC_PAYLOAD_BYTES} bytes.`);
    return { body, payloadBytes };
  } catch (error) {
    setLastSyncAttemptDetails({
      phase: metadata.phase || "unknown",
      endpoint: cloudEndpoint(path),
      method: "POST",
      status_code: null,
      ok: false,
      owner_used: metadata.ownerUsed ?? null,
      reason: metadata.reason ?? null,
      pending_counts: metadata.pendingCounts ?? null,
      items_total: metadata.itemsTotal ?? null,
      payload_bytes: payloadBytes,
      body_constructed: false,
      technical_message: safeTechnicalMessage(error),
      timestamp: nowIso(),
    });
    throw cloudSyncError({
      type: "invalid_response",
      endpoint: cloudEndpoint(path),
      technicalMessage: error,
      userMessage: "No pudimos preparar los cambios locales para sincronizar. Tus datos siguen guardados en este dispositivo.",
      method: "POST",
      phase: metadata.phase,
      itemsTotal: metadata.itemsTotal,
      payloadBytes,
      bodyConstructed: false,
      ownerUsed: metadata.ownerUsed,
      reason: metadata.reason,
      pendingCounts: metadata.pendingCounts,
    });
  }
}

async function cloudGet<T>(
  path: string,
  token: string,
  metadata: CloudRequestMetadata = {},
): Promise<T> {
  if (!CLOUD_API_URL) throw cloudSyncError({ type: "unknown", endpoint: path, technicalMessage: "Cloud API URL vacia.", userMessage: "No hay URL cloud configurada en esta instalacion." });
  const response = await cloudFetch(path, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  }, { method: "GET", phase: metadata.phase, itemsTotal: metadata.itemsTotal, ownerUsed: metadata.ownerUsed, reason: metadata.reason, pendingCounts: metadata.pendingCounts });
  return parseResponse<T>(response, "No se pudo obtener informacion desde el servicio cloud.", {
    cloud: true,
    method: "GET",
    phase: metadata.phase,
    itemsTotal: metadata.itemsTotal,
    ownerUsed: metadata.ownerUsed,
    reason: metadata.reason,
    pendingCounts: metadata.pendingCounts,
  });
}

async function cloudPost<T>(
  path: string,
  token: string,
  payload: unknown,
  metadata: CloudRequestMetadata = {},
): Promise<T> {
  if (!CLOUD_API_URL) throw cloudSyncError({ type: "unknown", endpoint: path, technicalMessage: "Cloud API URL vacia.", userMessage: "No hay URL cloud configurada en esta instalacion." });
  const { body, payloadBytes } = serializeCloudPayload(path, payload, metadata);
  setLastSyncAttemptDetails({
    phase: metadata.phase || "unknown",
    endpoint: cloudEndpoint(path),
    method: "POST",
    status_code: null,
    ok: null,
    owner_used: metadata.ownerUsed ?? null,
    reason: metadata.reason ?? null,
    pending_counts: metadata.pendingCounts ?? null,
    items_total: metadata.itemsTotal ?? null,
    payload_bytes: payloadBytes,
    body_constructed: true,
    technical_message: "Body JSON construido. Esperando respuesta HTTP.",
    timestamp: nowIso(),
  });
  const response = await cloudFetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  }, { method: "POST", phase: metadata.phase, itemsTotal: metadata.itemsTotal, payloadBytes, bodyConstructed: true, ownerUsed: metadata.ownerUsed, reason: metadata.reason, pendingCounts: metadata.pendingCounts });
  setLastSyncAttemptDetails({
    phase: metadata.phase || "unknown",
    endpoint: response.url || cloudEndpoint(path),
    method: "POST",
    status_code: response.status,
    ok: response.ok,
    owner_used: metadata.ownerUsed ?? null,
    reason: metadata.reason ?? null,
    pending_counts: metadata.pendingCounts ?? null,
    items_total: metadata.itemsTotal ?? null,
    payload_bytes: payloadBytes,
    body_constructed: true,
    technical_message: response.ok ? "Respuesta HTTP recibida correctamente." : `Respuesta HTTP ${response.status}.`,
    timestamp: nowIso(),
  });
  return parseResponse<T>(response, "No se pudo enviar informacion al servicio cloud.", {
    cloud: true,
    method: "POST",
    phase: metadata.phase,
    itemsTotal: metadata.itemsTotal,
    payloadBytes,
    bodyConstructed: true,
    ownerUsed: metadata.ownerUsed,
    reason: metadata.reason,
    pendingCounts: metadata.pendingCounts,
  });
}

async function cloudFetch(
  path: string,
  options: RequestInit = {},
  metadata: {
    method?: string;
    phase?: SyncErrorDetails["phase"];
    itemsTotal?: number | null;
    payloadBytes?: number | null;
    bodyConstructed?: boolean | null;
    ownerUsed?: string | null;
    reason?: SyncReason | null;
    pendingCounts?: Partial<Record<SyncTable, number>> | null;
  } = {},
) {
  const endpoint = cloudEndpoint(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_SYNC_TIMEOUT_MS);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } catch (error) {
    if (metadata.phase === "cloud_push") {
      setLastSyncAttemptDetails({
        phase: metadata.phase,
        endpoint,
        method: metadata.method || String(options.method || "GET"),
        status_code: null,
        ok: false,
        owner_used: metadata.ownerUsed ?? null,
        reason: metadata.reason ?? null,
        pending_counts: metadata.pendingCounts ?? null,
        items_total: metadata.itemsTotal ?? null,
        payload_bytes: metadata.payloadBytes ?? null,
        body_constructed: metadata.bodyConstructed ?? null,
        technical_message: safeTechnicalMessage(error),
        timestamp: nowIso(),
      });
    }
    throw cloudSyncError({
      type: classifyFetchError(error),
      endpoint,
      technicalMessage: error,
      method: metadata.method || String(options.method || "GET"),
      phase: metadata.phase,
      itemsTotal: metadata.itemsTotal,
      payloadBytes: metadata.payloadBytes,
      bodyConstructed: metadata.bodyConstructed,
      ownerUsed: metadata.ownerUsed,
      reason: metadata.reason,
      pendingCounts: metadata.pendingCounts,
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

export function getLastCloudSessionTestResult(): CloudSessionTestResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_CLOUD_SESSION_TEST_KEY);
    return raw ? (JSON.parse(raw) as CloudSessionTestResult) : null;
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
      const rawIntervals = window.localStorage.getItem(AUTO_SYNC_INTERVAL_BY_OWNER_KEY);
      const intervals = rawIntervals ? (JSON.parse(rawIntervals) as Record<string, number>) : {};
      delete intervals[ownerId];
      window.localStorage.setItem(AUTO_SYNC_INTERVAL_BY_OWNER_KEY, JSON.stringify(intervals));
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

export function getLastCloudSyncTestResult(): CloudSyncTestResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_CLOUD_SYNC_TEST_KEY);
    return raw ? (JSON.parse(raw) as CloudSyncTestResult) : null;
  } catch {
    return null;
  }
}

export function getLastSyncAttemptDetails(): SyncAttemptDetails | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_SYNC_ATTEMPT_KEY);
    return raw ? (JSON.parse(raw) as SyncAttemptDetails) : null;
  } catch {
    return null;
  }
}

export function getLastLocalProtectedTestResult(): LocalProtectedTestResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_LOCAL_PROTECTED_TEST_KEY);
    return raw ? (JSON.parse(raw) as LocalProtectedTestResult) : null;
  } catch {
    return null;
  }
}

export function getLastLocalApplyRemoteCheckResult(): LocalApplyRemoteCheckResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_LOCAL_APPLY_CHECK_KEY);
    return raw ? (JSON.parse(raw) as LocalApplyRemoteCheckResult) : null;
  } catch {
    return null;
  }
}

function setLastCloudSessionTestResult(value: CloudSessionTestResult) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CLOUD_SESSION_TEST_KEY, JSON.stringify(value));
  } catch {
    // El diagnostico cloud no debe bloquear la app.
  }
  emitSyncStateChanged();
}

export function getAutoSyncIntervalMs() {
  if (typeof window === "undefined") return DEFAULT_AUTO_SYNC_INTERVAL_MS;
  try {
    const owner = getActiveOwnerId();
    if (owner === "local") return DEFAULT_AUTO_SYNC_INTERVAL_MS;
    const raw = window.localStorage.getItem(AUTO_SYNC_INTERVAL_BY_OWNER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    const value = Number(parsed[owner]);
    return Number.isFinite(value) && value >= 60_000 ? value : DEFAULT_AUTO_SYNC_INTERVAL_MS;
  } catch {
    return DEFAULT_AUTO_SYNC_INTERVAL_MS;
  }
}

export function setAutoSyncIntervalMs(intervalMs: number) {
  if (typeof window === "undefined" || !Number.isFinite(intervalMs) || intervalMs < 60_000) return;
  try {
    const owner = getActiveOwnerId();
    if (owner === "local") return;
    const raw = window.localStorage.getItem(AUTO_SYNC_INTERVAL_BY_OWNER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    parsed[owner] = intervalMs;
    window.localStorage.setItem(AUTO_SYNC_INTERVAL_BY_OWNER_KEY, JSON.stringify(parsed));
  } catch {
    // La preferencia no debe bloquear el modo local.
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
    const response = await cloudFetch("/health", { cache: "no-store" }, { method: "GET", phase: "health" });
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

function setLastCloudSyncTestResult(value: CloudSyncTestResult) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CLOUD_SYNC_TEST_KEY, JSON.stringify(value));
  } catch {
    // El diagnostico cloud no debe bloquear la app.
  }
  emitSyncStateChanged();
}

function setLastSyncAttemptDetails(value: SyncAttemptDetails) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SYNC_ATTEMPT_KEY, JSON.stringify(value));
  } catch {
    // El diagnostico de sync no debe bloquear la sincronizacion.
  }
  emitSyncStateChanged();
}

function setLastLocalProtectedTestResult(value: LocalProtectedTestResult) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_LOCAL_PROTECTED_TEST_KEY, JSON.stringify(value));
  } catch {
    // El diagnostico local no debe bloquear la app.
  }
  emitSyncStateChanged();
}

function setLastLocalApplyRemoteCheckResult(value: LocalApplyRemoteCheckResult) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_LOCAL_APPLY_CHECK_KEY, JSON.stringify(value));
  } catch {
    // El diagnostico local no debe bloquear la app.
  }
  emitSyncStateChanged();
}

export async function testCloudSession(): Promise<CloudSessionTestResult> {
  const timestamp = nowIso();
  const session = getActiveCloudSession();
  const endpoint = cloudEndpoint("/auth/me");
  if (!CLOUD_API_URL) {
    const result: CloudSessionTestResult = {
      ok: false,
      endpoint: "/auth/me",
      method: "GET",
      status_code: null,
      type: "unknown",
      user_message: "No hay URL cloud configurada en esta instalacion.",
      technical_message: "NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL esta vacia.",
      timestamp,
    };
    setLastCloudSessionTestResult(result);
    return result;
  }
  if (!session?.token || !session.user?.id) {
    const result: CloudSessionTestResult = {
      ok: false,
      endpoint,
      method: "GET",
      status_code: null,
      type: "unauthorized",
      user_message: "No hay una cuenta cloud activa para verificar.",
      technical_message: "No active cloud session.",
      timestamp,
    };
    setLastCloudSessionTestResult(result);
    return result;
  }

  try {
    const response = await cloudFetch("/auth/me", {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "X-Scisonomics-Owner-Id": session.user.id,
      },
    }, { method: "GET", phase: "session" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const type = classifyHttpStatus(response.status);
      const result: CloudSessionTestResult = {
        ok: false,
        endpoint,
        method: "GET",
        status_code: response.status,
        type,
        user_message: syncUserMessage(type),
        technical_message: safeTechnicalMessage(body?.detail || `HTTP ${response.status}`),
        timestamp,
      };
      setLastCloudSessionTestResult(result);
      return result;
    }
    const result: CloudSessionTestResult = {
      ok: true,
      endpoint,
      method: "GET",
      status_code: response.status,
      type: "ok",
      user_message: "Sesion cloud OK.",
      technical_message: "Cloud /auth/me respondio correctamente.",
      timestamp,
      user_id: typeof body?.user_id === "string" ? body.user_id : typeof body?.id === "string" ? body.id : null,
      email: typeof body?.email === "string" ? body.email : null,
    };
    setLastCloudSessionTestResult(result);
    return result;
  } catch (error) {
    const details = error instanceof CloudSyncError
      ? error.details
      : makeSyncErrorDetails({ type: "unknown", endpoint, technicalMessage: error, method: "GET", phase: "session" });
    const result: CloudSessionTestResult = {
      ok: false,
      endpoint: details.endpoint,
      method: "GET",
      status_code: details.status_code,
      type: details.type,
      user_message: details.user_message,
      technical_message: details.technical_message,
      timestamp: details.timestamp,
    };
    setLastCloudSessionTestResult(result);
    return result;
  }
}

export async function testCloudSync(): Promise<CloudSyncTestResult> {
  const timestamp = nowIso();
  const session = getActiveCloudSession();
  const endpoint = cloudEndpoint("/sync/health");
  if (!CLOUD_API_URL) {
    const result: CloudSyncTestResult = {
      ok: false,
      endpoint: "/sync/health",
      method: "GET",
      status_code: null,
      type: "unknown",
      user_message: "No hay URL cloud configurada en esta instalacion.",
      technical_message: "NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL esta vacia.",
      timestamp,
    };
    setLastCloudSyncTestResult(result);
    return result;
  }
  if (!session?.token || !session.user?.id) {
    const result: CloudSyncTestResult = {
      ok: false,
      endpoint,
      method: "GET",
      status_code: null,
      type: "unauthorized",
      user_message: "No hay una cuenta cloud activa para verificar.",
      technical_message: "No active cloud session.",
      timestamp,
    };
    setLastCloudSyncTestResult(result);
    return result;
  }

  try {
    const response = await cloudFetch("/sync/health", {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "X-Scisonomics-Owner-Id": session.user.id,
      },
    }, { method: "GET", phase: "sync_health", ownerUsed: session.user.id });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const type = classifyHttpStatus(response.status);
      const result: CloudSyncTestResult = {
        ok: false,
        endpoint,
        method: "GET",
        status_code: response.status,
        type,
        user_message: syncUserMessage(type),
        technical_message: safeTechnicalMessage(body?.detail || `HTTP ${response.status}`),
        timestamp,
      };
      setLastCloudSyncTestResult(result);
      return result;
    }
    const result: CloudSyncTestResult = {
      ok: true,
      endpoint,
      method: "GET",
      status_code: response.status,
      type: "ok",
      user_message: "Sync cloud OK.",
      technical_message: "Cloud /sync/health respondio correctamente.",
      timestamp,
      user_id: typeof body?.user_id === "string" ? body.user_id : null,
    };
    setLastCloudSyncTestResult(result);
    return result;
  } catch (error) {
    const details = error instanceof CloudSyncError
      ? error.details
      : makeSyncErrorDetails({ type: "unknown", endpoint, technicalMessage: error, method: "GET", phase: "sync_health", ownerUsed: session.user.id });
    const result: CloudSyncTestResult = {
      ok: false,
      endpoint: details.endpoint,
      method: "GET",
      status_code: details.status_code,
      type: details.type,
      user_message: details.user_message,
      technical_message: details.technical_message,
      timestamp: details.timestamp,
    };
    setLastCloudSyncTestResult(result);
    return result;
  }
}

export async function testLocalProtectedService(): Promise<LocalProtectedTestResult> {
  const timestamp = nowIso();
  const endpoint = `${API_URL}/local/auth-check`;
  const ownerId = getActiveOwnerId();
  let security = getLocalRequestSecuritySnapshot(ownerId);
  try {
    const request = await getLocalRequestSecurity(undefined, ownerId, true);
    security = request.security;
    const response = await fetch(endpoint, { cache: "no-store", headers: request.headers });
    const body = await response.json().catch(() => null);
    const result: LocalProtectedTestResult = {
      ok: response.ok && Boolean(body?.ok),
      endpoint,
      method: "GET",
      status_code: response.status,
      user_message: response.ok ? "Servicio local protegido OK." : response.status === 401 || response.status === 403
        ? "No se pudo autenticar contra el servicio local."
        : "El servicio local respondio con un error.",
      technical_message: response.ok ? "Local /local/auth-check respondio correctamente." : safeTechnicalMessage(body?.detail || `HTTP ${response.status}`),
      timestamp,
      security,
    };
    setLastLocalProtectedTestResult(result);
    return result;
  } catch (error) {
    security = getLocalRequestSecuritySnapshot(ownerId);
    const result: LocalProtectedTestResult = {
      ok: false,
      endpoint,
      method: "GET",
      status_code: null,
      user_message: safeTechnicalMessage(error).includes("autenticar")
        ? "No se pudo autenticar contra el servicio local."
        : "No pudimos conectar con el servicio local protegido. Puede ser token local, CORS local o backend local no disponible.",
      technical_message: safeTechnicalMessage(error),
      timestamp,
      security,
    };
    setLastLocalProtectedTestResult(result);
    return result;
  }
}

export async function testLocalApplyRemote(): Promise<LocalApplyRemoteCheckResult> {
  const timestamp = nowIso();
  const endpoint = `${API_URL}/sync/apply-remote/check`;
  const ownerId = getActiveOwnerId();
  const counts = Object.fromEntries(SYNC_TABLES.map((table) => [table, 0])) as Record<SyncTable, number>;
  const payload = Object.fromEntries(SYNC_TABLES.map((table) => [table, []])) as unknown as Record<SyncTable, unknown[]>;
  const body = JSON.stringify(payload);
  const payloadBytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(body).byteLength : body.length;
  let security = getLocalRequestSecuritySnapshot(ownerId);
  try {
    const request = await getLocalRequestSecurity({ "Content-Type": "application/json" }, ownerId, true);
    security = request.security;
    const response = await fetch(endpoint, { method: "POST", cache: "no-store", headers: request.headers, body });
    const responseBody = await response.json().catch(() => null);
    const result: LocalApplyRemoteCheckResult = {
      ok: response.ok && Boolean(responseBody?.ok),
      endpoint,
      method: "POST",
      status_code: response.status,
      user_message: response.ok ? "Apply remoto local protegido OK." : response.status === 401 || response.status === 403
        ? "No se pudo autenticar contra el servicio local."
        : "El servicio local no pudo validar el POST de apply remoto.",
      technical_message: response.ok ? safeTechnicalMessage(responseBody?.message || "Local apply remote check OK.") : safeTechnicalMessage(responseBody?.detail || `HTTP ${response.status}`),
      timestamp,
      security,
      body_constructed: true,
      payload_bytes: payloadBytes,
      body_parsed: typeof responseBody?.body_parsed === "boolean" ? responseBody.body_parsed : null,
      remote_total: Number(responseBody?.remote_total || 0),
      counts_by_entity: (responseBody?.counts_by_entity || counts) as Record<SyncTable, number>,
    };
    setLastLocalApplyRemoteCheckResult(result);
    return result;
  } catch (error) {
    security = getLocalRequestSecuritySnapshot(ownerId);
    const result: LocalApplyRemoteCheckResult = {
      ok: false,
      endpoint,
      method: "POST",
      status_code: null,
      user_message: "No pudimos completar el POST local de apply remoto. Puede ser CORS local, token local o backend local no disponible.",
      technical_message: safeTechnicalMessage(error),
      timestamp,
      security,
      body_constructed: true,
      payload_bytes: payloadBytes,
      body_parsed: null,
      remote_total: 0,
      counts_by_entity: counts,
    };
    setLastLocalApplyRemoteCheckResult(result);
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
  if (error instanceof CloudSyncError) {
    if (error.details.phase === "local_apply_remote") {
      return "No pudimos completar la sincronizacion porque encontramos un problema con los datos locales. Tus datos siguen guardados en este dispositivo. Proba reparar los datos locales y sincroniza nuevamente.";
    }
    return error.details.user_message;
  }
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (normalized.includes("datos locales necesitan una revision")) return message;
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

function normalizedSyncPayload(payload: Partial<Record<SyncTable, unknown[]>>): SyncPayload {
  return {
    ok: true,
    ...Object.fromEntries(SYNC_TABLES.map((table) => [table, Array.isArray(payload[table]) ? payload[table] : []])),
  } as SyncPayload;
}

export function isSyncInFlight() {
  return syncInFlight;
}

export async function waitForSyncIdle(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (syncInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !syncInFlight;
}

export async function getLocalDbIntegrity(ownerId?: string) {
  return localGet<LocalDbIntegrityResult>("/local/db-integrity", ownerId, "local_integrity");
}

export async function createLocalBackup() {
  return localPost<{ ok: boolean; backup_path: string; created_at: string }>("/local/backup", {});
}

export async function repairLocalDb() {
  return localPost<{ ok: boolean; backup_created: boolean; backup_path?: string; repaired_count: number; unresolved_count: number; safe_summary: string[] }>("/local/db-repair", {});
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
    hasUser: Boolean(userEmail),
    mode,
    reason,
    ownerId: shortIdentifier(snapshot.ownerId),
  });

  try {
    const integrity = await getLocalDbIntegrity(snapshot.ownerId);
    if (integrity.status === "critical") {
      console.warn(`${LOG_PREFIX} blocked: local integrity critical`, { issueCodes: integrity.issues.map((issue) => issue.code) });
      throw new Error("No pudimos sincronizar porque tus datos locales necesitan una revision. Crea un backup y ejecuta la reparacion automatica.");
    }
    if (integrity.status === "warning") {
      console.warn(`${LOG_PREFIX} local integrity warning`, { issueCodes: integrity.issues.map((issue) => issue.code) });
    }
    deviceInfo = await localGet<DeviceInfo>("/device/info", snapshot.ownerId, "local_device_info");
    const pending = await localGet<SyncPayload>("/sync/pending", snapshot.ownerId, "local_pending");
    pendingCounts = countByTable(pending);
    deletedCounts = countDeletedByTable(pending);
    console.info(`${LOG_PREFIX} pending`, { hasUser: Boolean(userEmail), mode, reason, device: shortIdentifier(deviceInfo.device_id), ...pendingCounts });

    const pushResult = await cloudPost<{
      ok: boolean;
      accepted: Partial<Record<SyncTable, unknown>>;
      ignored: Record<SyncTable, number>;
      conflicts?: Record<SyncTable, number>;
      counts?: Record<string, number>;
    }>("/sync/push", token, {
      device_id: deviceInfo.device_id,
      device_name: deviceInfo.device_name,
      ...emptyPayloadFromPending(pending),
    }, {
      phase: "cloud_push",
      itemsTotal: totalCount(pendingCounts),
      ownerUsed: snapshot.ownerId,
      reason,
      pendingCounts,
    });

    const accepted = acceptedByTable(pushResult.accepted || {});
    const counts = pushResult.counts || {};
    const acceptedCounts = Object.fromEntries(SYNC_TABLES.map((table) => [table, accepted[table].length])) as Record<SyncTable, number>;
    console.info(`${LOG_PREFIX} push result`, {
      hasUser: Boolean(userEmail),
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
        accepted[table].length + Number(pushResult.ignored?.[table] || 0) !== pendingCount ||
        counts[`${table}_received`] !== pendingCount ||
        counts[`${table}_saved`] !== accepted[table].length
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

    const cursorState = await localGet<{ ok: boolean; cursor: string | null }>("/sync/cursor", snapshot.ownerId, "local_pending");
    const pullCursor = cursorState.cursor;
    const pullPath = pullCursor ? `/sync/pull?since=${encodeURIComponent(pullCursor)}` : "/sync/pull";
    const remoteResponse = await cloudGet<SyncPayload & { cursor?: string | null }>(pullPath, token, {
      phase: "cloud_pull",
      itemsTotal: 0,
      ownerUsed: snapshot.ownerId,
      reason,
      pendingCounts,
    });
    const remote = normalizedSyncPayload(remoteResponse);
    const pulledCounts = countByTable(remote);
    console.info(`${LOG_PREFIX} pull`, { mode, ...pulledCounts });
    type ApplyRemoteResult = {
      ok: boolean;
      result: Record<string, number>;
      applied?: Record<SyncTable, number>;
      kept_local?: Record<SyncTable, number>;
      conflicts?: { total: number; by_table: Record<string, number> };
      remote_changes_total?: number;
      applied_remote_total?: number;
      kept_local_total?: number;
    };
    const pulledTotal = totalCount(pulledCounts);
    const applyResult: ApplyRemoteResult = pulledTotal > 0
      ? await localPost<ApplyRemoteResult>("/sync/apply-remote", remote, snapshot.ownerId, "local_apply_remote")
      : {
          ok: true,
          result: {},
          remote_changes_total: 0,
          applied_remote_total: 0,
          kept_local_total: 0,
        };
    if (pulledTotal === 0) console.info(`${LOG_PREFIX} apply-remote skipped`, { mode, reason: "empty_remote_payload" });
    console.info(`${LOG_PREFIX} apply-remote`, { mode, result: applyResult.result });
    const conflictsTotal = Number(applyResult.conflicts?.total || 0);
    const remoteChangesTotal = Number(applyResult.remote_changes_total || totalCount(pulledCounts));
    const appliedRemoteTotal = Number(applyResult.applied_remote_total || 0);
    const keptLocalTotal = Number(applyResult.kept_local_total || 0);

    let markSyncedExecuted = false;
    if (SYNC_TABLES.some((table) => accepted[table].length > 0)) {
      await localPost("/sync/mark-synced", accepted, snapshot.ownerId, "local_mark_synced");
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
      console.info(`${LOG_PREFIX} finished for previous owner`, {
        ownerId: shortIdentifier(snapshot.ownerId),
        activeOwnerId: shortIdentifier(getActiveOwnerId()),
        mode,
        reason,
      });
    }
    if (remoteResponse.cursor) {
      await localPost("/sync/cursor", { cursor: remoteResponse.cursor }, snapshot.ownerId, "local_mark_synced");
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
      : makeSyncErrorDetails({
        type: "unknown",
        endpoint: "/sync",
        technicalMessage: error,
        userMessage: friendly,
        method: "UNKNOWN",
        phase: "sync",
        itemsTotal: totalCount(pendingCounts),
        ownerUsed: snapshot.ownerId,
        reason,
        pendingCounts,
      });
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
