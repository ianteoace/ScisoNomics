export type CloudUser = {
  id: string;
  email: string;
  display_name?: string | null;
  created_at: string;
  updated_at: string;
};

export type CloudAuthResponse = {
  access_token: string;
  refresh_token?: string | null;
  token_type: string;
  expires_in: number;
  token?: string | null;
  user: CloudUser;
};

export type EmailVerificationRequiredResponse = {
  status: "verification_required";
  code: "email_verification_required";
  email: string;
  verification_token: string;
  verification_expires_in: number;
  resend_available_in: number;
};

export type CloudAuthRegisterOrLoginResponse = CloudAuthResponse | EmailVerificationRequiredResponse;

export type StoredCloudAccount = {
  user: CloudUser;
  addedAt: string;
  lastUsedAt: string;
  storage: "persistent" | "session";
};

export type CloudAuthTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: string;
  tokenType: string;
};

export type StoredAuthState = {
  activeOwnerId: string;
  accounts: StoredCloudAccount[];
};

export type StoredCloudSession = StoredCloudAccount & {
  token: string;
  tokenType: string;
  expiresAt: string;
};
export type CloudTokenSource = "session" | "secure" | "legacy" | "missing";
export type CloudSessionAvailability =
  | "none"
  | "local"
  | "active"
  | "saved_without_token"
  | "session_expired"
  | "refresh_failed"
  | "auth_error"
  | "unknown_error";
export type ActiveCloudAuthState = {
  ownerId: string;
  account: StoredCloudAccount | null;
  session: StoredCloudSession | null;
  availability: CloudSessionAvailability;
  tokenSource: CloudTokenSource;
  secureStorageAvailable: boolean;
  persistenceStatus: "ok" | "failed" | "unknown";
  persistentStorageError: boolean;
  requiresRelogin: boolean;
};

export type CloudAuthDiagnostics = {
  activeOwnerId: string;
  accountId: string | null;
  storage: "persistent" | "session" | "local" | "none";
  availability: CloudSessionAvailability;
  tokenSource: CloudTokenSource;
  secureStorageAvailable: boolean;
  persistenceStatus: "ok" | "failed" | "unknown";
  persistentStorageError: boolean;
  refreshTokenFound: boolean;
  refreshSuccess: boolean | null;
  rotatedRefresh: boolean | null;
  accessTokenValid: boolean;
  accessTokenExpiresAt: string | null;
  lastAuthErrorCode: string | null;
};

export type CloudAuthHydrationState = {
  pending: boolean;
  inProgress: boolean;
  hasHydratedThisBoot: boolean;
  persistentAccounts: number;
  activeOwnerId: string;
};

export type AuthUIState = {
  title: string;
  message: string;
  subtitle: string;
};

type CloudPersistenceStatus = "ok" | "failed" | "unknown";

const LOCAL_OWNER_ID = "local";
const AUTH_STATE_KEY = "scisonomics_cloud_accounts_v1";
const AUTH_STATE_SESSION_KEY = "scisonomics_cloud_accounts_session_v1";
const ACCESS_TOKEN_STATE_SESSION_KEY = "scisonomics_cloud_access_tokens_session_v1";
const TOKEN_KEY = "scisonomics_cloud_access_token";
const USER_KEY = "scisonomics_cloud_user";
export const DEFAULT_REMEMBER_CLOUD_ACCOUNT = true;
export const ACCOUNT_SESSION_CHANGED_EVENT = "scisonomics:account-session-changed";
export const OWNER_CHANGED_EVENT = "scisonomics:owner-changed";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const CLOUD_AUTH_TIMEOUT_MS = 10000;
const CLOUD_EMAIL_FLOW_TIMEOUT_MS = 30000;

type CloudAuthErrorKind = "auth" | "network" | "timeout" | "server" | "unknown";

export class CloudAuthRequestError extends Error {
  statusCode: number | null;
  kind: CloudAuthErrorKind;
  code: string | null;
  verification: EmailVerificationRequiredResponse | null;

  constructor(
    message: string,
    options: {
      statusCode?: number | null;
      kind?: CloudAuthErrorKind;
      code?: string | null;
      verification?: EmailVerificationRequiredResponse | null;
    } = {},
  ) {
    super(message);
    this.name = "CloudAuthRequestError";
    this.statusCode = options.statusCode ?? null;
    this.kind = options.kind || "unknown";
    this.code = options.code ?? null;
    this.verification = options.verification ?? null;
  }
}

export function isCloudAuthRequestError(error: unknown): error is CloudAuthRequestError {
  return error instanceof CloudAuthRequestError;
}

export function isEmailVerificationRequiredResponse(response: CloudAuthRegisterOrLoginResponse): response is EmailVerificationRequiredResponse {
  return (response as EmailVerificationRequiredResponse).status === "verification_required";
}

type PersistedCloudAccount = StoredCloudAccount & { token?: string | null };
type PersistedAuthState = {
  activeOwnerId: string;
  accounts: PersistedCloudAccount[];
};
type StoredRuntimeToken = {
  accessToken: string;
  expiresAt: string;
  tokenType: string;
};
type StoredRuntimeTokenState = Record<string, StoredRuntimeToken>;
type SaveCloudTokenResult = {
  storedSecurely: boolean;
  fallbackUsed: boolean;
  roundtrip: boolean;
  secureStorageAvailable: boolean;
  errorCode?: string | null;
};

type SecureRefreshTokenSaveCommandResult = {
  ok: boolean;
  roundtrip: boolean;
  error_code: string | null;
  service: string;
  account_id_hash: string;
};

type SecureRefreshTokenLoadCommandResult = {
  found: boolean;
  token: string | null;
  error_code: string | null;
  service: string;
  account_id_hash: string;
};

type SecureRefreshTokenDeleteCommandResult = {
  ok: boolean;
  error_code: string | null;
  service: string;
  account_id_hash: string;
};

type AccountAuthStatus = {
  lastAuthErrorCode: string | null;
  lastRefreshSuccess: boolean | null;
  lastRotatedRefresh: boolean | null;
};

type AccountRuntimeAuthState = {
  availability: Exclude<CloudSessionAvailability, "none" | "local">;
  refreshTokenFound: boolean;
  accessTokenValid: boolean;
};

const persistentRefreshTokenCache = new Map<string, string>();
const runtimeAccessTokenCache = new Map<string, StoredRuntimeToken>();
const accountAuthStatusCache = new Map<string, AccountAuthStatus>();
const accountRuntimeAuthStateCache = new Map<string, AccountRuntimeAuthState>();
let persistentTokenHydrationPromise: Promise<void> | null = null;
let legacyTokenMigrationPromise: Promise<void> | null = null;
const activeRefreshPromises = new Map<string, Promise<StoredCloudSession | null>>();
let hasAttemptedSecureTokenMigration = false;
let tokenMaintenanceQueued = false;
let authStateRevision = 0;
let lastHydratedAuthStateRevision = -1;
let isHydratingSecureTokens = false;
let hasHydratedSecureTokensThisBoot = false;
let lastHydrateResult: { loadedAny: boolean; accountsChecked: number; persistentAccounts: number; reason: string } | null = null;
let lastMetadataLoadedLog = "";

function emptyAuthState(): StoredAuthState {
  return { activeOwnerId: LOCAL_OWNER_ID, accounts: [] };
}

function nowIso() {
  return new Date().toISOString();
}

export function getAuthUIState(
  availability: CloudSessionAvailability,
  hasError = false,
  options?: { persistenceStatus?: CloudPersistenceStatus; persistentStorageError?: boolean },
): AuthUIState {
  const persistenceStatus = options?.persistenceStatus ?? getActivePersistenceStatusSnapshot();
  const persistentStorageError = options?.persistentStorageError ?? (persistenceStatus === "failed");
  if (availability === "local") {
    return {
      title: "Modo local",
      message: "",
      subtitle: "Sin sincronización",
    };
  }
  if (availability === "none") {
    return {
      title: "Cuenta guardada",
      message: "",
      subtitle: "Sin sesión",
    };
  }
  if (availability === "active") {
    if (persistentStorageError) {
      return {
        title: "Sesión activa con advertencia",
        message: "La sesión está activa, pero no pudimos guardar Recordar sesión. Iniciá sesión nuevamente para restaurar la persistencia.",
        subtitle: "Recordar sesión pendiente",
      };
    }
    return {
      title: "Sesión iniciada",
      message: "",
      subtitle: "Cuenta sincronizable",
    };
  }
  if (availability === "saved_without_token") {
    return {
      title: "Cuenta guardada",
      message: "Cuenta guardada. Iniciá sesión nuevamente para sincronizar.",
      subtitle: "Cuenta guardada",
    };
  }
  if (
    availability === "session_expired"
    || availability === "refresh_failed"
    || availability === "auth_error"
    || availability === "unknown_error"
    || hasError
  ) {
    if (availability === "session_expired") {
      return {
        title: "Sesión no disponible",
        message: "Sesión vencida o no disponible. Iniciá sesión nuevamente.",
        subtitle: "Sesión vencida",
      };
    }
    if (availability === "refresh_failed") {
      return {
        title: "Sesión no disponible",
        message: "No se pudo renovar la sesión. Probá iniciar sesión nuevamente.",
        subtitle: "No se pudo renovar la sesión",
      };
    }
    if (availability === "auth_error") {
      return {
        title: "Sesión no disponible",
        message: "No pudimos comprobar la sesión. Probá iniciar sesión nuevamente.",
        subtitle: "Error al comprobar la sesión",
      };
    }
    return {
      title: "Sesión no disponible",
      message: "No pudimos comprobar la sesión. Probá iniciar sesión nuevamente.",
      subtitle: "Estado de sesión no disponible",
    };
  }
  return {
    title: "Cuenta guardada",
    message: "",
    subtitle: "Cuenta guardada",
  };
}

function normalizeEmail(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

function normalizePersistentAccountId(value: string) {
  return String(value || "").trim();
}

function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  const runtimeWindow = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    isTauri?: boolean;
  };
  return Boolean(runtimeWindow.__TAURI_INTERNALS__ || runtimeWindow.__TAURI__ || runtimeWindow.isTauri);
}

function canUseSecurePersistentTokenStorage() {
  return isTauriRuntime();
}

async function invokeCore<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(command, args)) as T;
  } catch (error) {
    console.warn("[auth] secure token command failed", JSON.stringify(sanitizeAuthLogValue({
      command,
      errorType: error instanceof Error ? error.name : typeof error,
    })));
    return null;
  }
}

async function savePersistentCloudTokenSecure(accountId: string, token: string) {
  logAuthLifecycle("secure refresh token save start", {
    accountId: shortAccountId(accountId),
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
  });
  const saved = await invokeCore<SecureRefreshTokenSaveCommandResult>("save_persistent_cloud_refresh_token", { accountId: normalizePersistentAccountId(accountId), token });
  logAuthLifecycle("secure refresh token save end", {
    accountId: shortAccountId(accountId),
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    success: Boolean(saved?.ok),
    roundtrip: Boolean(saved?.roundtrip),
    errorCode: saved?.error_code || null,
    service: saved?.service || null,
    accountIdHash: saved?.account_id_hash || null,
  });
  return saved;
}

async function loadPersistentCloudTokenSecure(accountId: string) {
  const result = await invokeCore<SecureRefreshTokenLoadCommandResult>("load_persistent_cloud_refresh_token", { accountId: normalizePersistentAccountId(accountId) });
  logAuthLifecycle("secure refresh token load", {
    accountId: shortAccountId(accountId),
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    refreshTokenFound: Boolean(result?.found && typeof result.token === "string" && result.token.trim()),
    errorCode: result?.error_code || null,
    service: result?.service || null,
    accountIdHash: result?.account_id_hash || null,
  });
  return result;
}

async function deletePersistentCloudTokenSecure(accountId: string) {
  logAuthLifecycle("secure refresh token delete", {
    accountId: shortAccountId(accountId),
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
  });
  return invokeCore<SecureRefreshTokenDeleteCommandResult>("delete_persistent_cloud_refresh_token", { accountId: normalizePersistentAccountId(accountId) });
}

function notifyAccountSessionChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(ACCOUNT_SESSION_CHANGED_EVENT));
    window.dispatchEvent(new Event(OWNER_CHANGED_EVENT));
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

function readJsonState(storage: Storage, key: string): StoredAuthState | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAuthState;
    return {
      activeOwnerId: typeof parsed.activeOwnerId === "string" ? parsed.activeOwnerId : LOCAL_OWNER_ID,
      accounts: Array.isArray(parsed.accounts)
        ? parsed.accounts
            .filter((account) => account?.user?.id)
            .map((account) => ({
              user: account.user,
              storage: account.storage === "session" ? "session" : "persistent",
              addedAt: account.addedAt || nowIso(),
              lastUsedAt: account.lastUsedAt || account.addedAt || nowIso(),
            }))
        : [],
    };
  } catch {
    return null;
  }
}

function readPersistedAuthStateRaw(storage: Storage, key: string): PersistedAuthState | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedAuthState;
  } catch {
    return null;
  }
}

function writeJsonState(storage: Storage, key: string, state: StoredAuthState) {
  const persistedState: PersistedAuthState = {
    activeOwnerId: state.activeOwnerId,
    accounts: state.accounts.map((account) => ({
      user: account.user,
      storage: account.storage,
      addedAt: account.addedAt,
      lastUsedAt: account.lastUsedAt,
    })),
  };
  storage.setItem(key, JSON.stringify(persistedState));
}

function readRuntimeTokenState(): StoredRuntimeTokenState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(ACCESS_TOKEN_STATE_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<StoredRuntimeToken>>;
    const cleaned: StoredRuntimeTokenState = {};
    for (const [accountId, value] of Object.entries(parsed || {})) {
      if (!accountId || typeof value?.accessToken !== "string" || !value.accessToken.trim() || typeof value?.expiresAt !== "string") continue;
      cleaned[accountId] = {
        accessToken: value.accessToken,
        expiresAt: value.expiresAt,
        tokenType: typeof value?.tokenType === "string" && value.tokenType.trim() ? value.tokenType : "bearer",
      };
    }
    return cleaned;
  } catch {
    return {};
  }
}

function persistRuntimeTokenState() {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.fromEntries(runtimeAccessTokenCache.entries());
    if (Object.keys(entries).length) {
      window.sessionStorage.setItem(ACCESS_TOKEN_STATE_SESSION_KEY, JSON.stringify(entries));
    } else {
      window.sessionStorage.removeItem(ACCESS_TOKEN_STATE_SESSION_KEY);
    }
  } catch {
    // El token de runtime no debe bloquear la app.
  }
}

function hydrateRuntimeTokenCache() {
  if (runtimeAccessTokenCache.size > 0 || typeof window === "undefined") return;
  const state = readRuntimeTokenState();
  for (const [accountId, token] of Object.entries(state)) {
    runtimeAccessTokenCache.set(accountId, token);
  }
}

function setRuntimeAccessToken(accountId: string, token: StoredRuntimeToken | null) {
  const normalizedAccountId = normalizePersistentAccountId(accountId);
  hydrateRuntimeTokenCache();
  if (!normalizedAccountId) return;
  if (!token) runtimeAccessTokenCache.delete(normalizedAccountId);
  else runtimeAccessTokenCache.set(normalizedAccountId, token);
  persistRuntimeTokenState();
}

function getRuntimeAccessToken(accountId: string) {
  hydrateRuntimeTokenCache();
  return runtimeAccessTokenCache.get(normalizePersistentAccountId(accountId)) || null;
}

function removeLegacySessionKeys() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.sessionStorage.removeItem(USER_KEY);
  } catch {
    // La migración de sesión no debe bloquear el uso local.
  }
}

function getLegacyToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function getLegacyUser(): CloudUser | null {
  try {
    const raw = window.localStorage.getItem(USER_KEY) || window.sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as CloudUser) : null;
  } catch {
    return null;
  }
}

function getLegacyStorageMode(): "persistent" | "session" | null {
  try {
    if (window.localStorage.getItem(TOKEN_KEY)) return "persistent";
    if (window.sessionStorage.getItem(TOKEN_KEY)) return "session";
  } catch {
    return null;
  }
  return null;
}

function saveSplitState(state: StoredAuthState) {
  if (typeof window === "undefined") return;
  const persistentAccounts = state.accounts.filter((account) => account.storage === "persistent");
  const sessionAccounts = state.accounts.filter((account) => account.storage === "session");
  try {
    if (persistentAccounts.length || state.activeOwnerId !== LOCAL_OWNER_ID) {
      writeJsonState(window.localStorage, AUTH_STATE_KEY, { activeOwnerId: state.activeOwnerId, accounts: persistentAccounts });
    } else {
      window.localStorage.removeItem(AUTH_STATE_KEY);
    }
    if (sessionAccounts.length) {
      writeJsonState(window.sessionStorage, AUTH_STATE_SESSION_KEY, { activeOwnerId: state.activeOwnerId, accounts: sessionAccounts });
    } else {
      window.sessionStorage.removeItem(AUTH_STATE_SESSION_KEY);
    }
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

function sanitizeAuthLogValue(value: unknown, keyPath = ""): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized.includes("bearer ") || normalized.includes("authorization") || normalized.includes("jwt")) return "[redacted]";
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeAuthLogValue(item, keyPath));

  const entries = Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const isSensitiveKey =
      normalizedKey === "token"
      || normalizedKey === "accesstoken"
      || normalizedKey === "refreshtoken"
      || normalizedKey === "authorization"
      || normalizedKey === "jwt"
      || normalizedKey === "bearer";
    if (isSensitiveKey) return [key, "[redacted]"];
    return [key, sanitizeAuthLogValue(nestedValue, keyPath ? `${keyPath}.${key}` : key)];
  });
  return Object.fromEntries(entries);
}

function logAuthLifecycle(stage: string, details?: Record<string, unknown>) {
  const safeDetails = sanitizeAuthLogValue(details || {}) as Record<string, unknown>;
  const payload = JSON.stringify(safeDetails);
  if (stage === "auth metadata loaded") {
    if (payload === lastMetadataLoadedLog) return;
    lastMetadataLoadedLog = payload;
  }
  console.info(`[auth] ${stage}`, payload);
}

function accountTimeValue(value?: string) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function chooseAccountToKeep(current: StoredCloudAccount, incoming: StoredCloudAccount) {
  const currentUsed = accountTimeValue(current.lastUsedAt);
  const incomingUsed = accountTimeValue(incoming.lastUsedAt);
  if (incomingUsed > currentUsed) return incoming;
  if (currentUsed > incomingUsed) return current;
  const currentAdded = accountTimeValue(current.addedAt);
  const incomingAdded = accountTimeValue(incoming.addedAt);
  if (incomingAdded > currentAdded) return incoming;
  return current;
}

function normalizeAccount(account: StoredCloudAccount): StoredCloudAccount {
  return {
    ...account,
    user: { ...account.user, email: normalizeEmail(account.user.email) },
    storage: account.storage || "persistent",
    addedAt: account.addedAt || nowIso(),
    lastUsedAt: account.lastUsedAt || account.addedAt || nowIso(),
  };
}

function maskEmail(value: string) {
  const email = normalizeEmail(value);
  const [localPart, domain = ""] = email.split("@");
  if (!localPart || !domain) return "***";
  return `${localPart.slice(0, 3)}***@${domain}`;
}

function shortUserId(value: string) {
  return value ? `${value.slice(0, 6)}...` : "unknown";
}

function shortAccountId(value: string) {
  const normalized = normalizePersistentAccountId(value);
  return normalized ? `${normalized.slice(0, 6)}...` : "unknown";
}

function emptyAccountAuthStatus(): AccountAuthStatus {
  return {
    lastAuthErrorCode: null,
    lastRefreshSuccess: null,
    lastRotatedRefresh: null,
  };
}

function getAccountAuthStatus(accountId?: string | null): AccountAuthStatus {
  const normalized = normalizePersistentAccountId(String(accountId || ""));
  if (!normalized) return emptyAccountAuthStatus();
  return accountAuthStatusCache.get(normalized) || emptyAccountAuthStatus();
}

function setAccountAuthStatus(accountId: string, patch: Partial<AccountAuthStatus>) {
  const normalized = normalizePersistentAccountId(accountId);
  if (!normalized) return;
  const current = getAccountAuthStatus(normalized);
  accountAuthStatusCache.set(normalized, {
    ...current,
    ...patch,
  });
}

function clearAccountAuthStatus(accountId: string) {
  const normalized = normalizePersistentAccountId(accountId);
  if (!normalized) return;
  accountAuthStatusCache.delete(normalized);
}

function getAccountRuntimeAuthState(accountId?: string | null): AccountRuntimeAuthState | null {
  const normalized = normalizePersistentAccountId(String(accountId || ""));
  if (!normalized) return null;
  return accountRuntimeAuthStateCache.get(normalized) || null;
}

function setAccountRuntimeAuthState(accountId: string, state: AccountRuntimeAuthState) {
  const normalized = normalizePersistentAccountId(accountId);
  if (!normalized) return;
  accountRuntimeAuthStateCache.set(normalized, state);
}

function clearAccountRuntimeAuthState(accountId: string) {
  const normalized = normalizePersistentAccountId(accountId);
  if (!normalized) return;
  accountRuntimeAuthStateCache.delete(normalized);
}

function computeExpiresAt(expiresInSeconds: number | undefined) {
  const safeSeconds = Number.isFinite(expiresInSeconds) && (expiresInSeconds || 0) > 0 ? Number(expiresInSeconds) : 900;
  return new Date(Date.now() + safeSeconds * 1000).toISOString();
}

function isTokenExpiredOrNearExpiry(expiresAt: string, thresholdMs = 60_000) {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs <= Date.now() + thresholdMs;
}

function buildRuntimeToken(response: CloudAuthResponse): StoredRuntimeToken {
  return {
    accessToken: response.access_token,
    expiresAt: computeExpiresAt(response.expires_in),
    tokenType: response.token_type || "bearer",
  };
}

export function getCloudAuthTokens(response: CloudAuthResponse): CloudAuthTokens {
  const runtime = buildRuntimeToken(response);
  return {
    accessToken: runtime.accessToken,
    expiresAt: runtime.expiresAt,
    tokenType: runtime.tokenType,
    refreshToken: response.refresh_token || null,
  };
}

function normalizeState(state: StoredAuthState): StoredAuthState {
  const byId = new Map<string, StoredCloudAccount>();
  const discardedOwnerMap = new Map<string, string>();
  for (const account of state.accounts) {
    if (!account?.user?.id) continue;
    const normalized = normalizeAccount(account);
    const existing = byId.get(normalized.user.id);
    if (!existing) {
      byId.set(normalized.user.id, normalized);
      continue;
    }
    const keep = accountTimeValue(normalized.lastUsedAt) > accountTimeValue(existing.lastUsedAt) ? normalized : existing;
    const discard = keep === normalized ? existing : normalized;
    byId.set(keep.user.id, keep);
    discardedOwnerMap.set(discard.user.id, keep.user.id);
  }

  const byEmail = new Map<string, StoredCloudAccount>();
  for (const account of byId.values()) {
    const emailKey = normalizeEmail(account.user.email);
    if (!emailKey) {
      byEmail.set(account.user.id, account);
      continue;
    }
    const existing = byEmail.get(emailKey);
    if (!existing) {
      byEmail.set(emailKey, account);
      continue;
    }
    const keep = chooseAccountToKeep(existing, account);
    const discard = keep === account ? existing : account;
    byEmail.set(emailKey, keep);
    discardedOwnerMap.set(discard.user.id, keep.user.id);
    logAuthLifecycle("deduped stored account by normalized email", {
      email: maskEmail(emailKey),
      keptUserId: shortUserId(keep.user.id),
      removedUserId: shortUserId(discard.user.id),
    });
  }
  const accounts = Array.from(byEmail.values()).sort((a, b) => accountTimeValue(b.lastUsedAt) - accountTimeValue(a.lastUsedAt));
  const remappedActive = discardedOwnerMap.get(state.activeOwnerId) || state.activeOwnerId;
  const activeOwnerId =
    remappedActive === LOCAL_OWNER_ID || accounts.some((account) => account.user.id === remappedActive)
      ? remappedActive
      : LOCAL_OWNER_ID;
  return { activeOwnerId, accounts };
}

function migrateLegacySessionIfNeeded() {
  if (typeof window === "undefined") return;
  const existingLocal = readJsonState(window.localStorage, AUTH_STATE_KEY);
  const existingSession = readJsonState(window.sessionStorage, AUTH_STATE_SESSION_KEY);
  if ((existingLocal?.accounts.length || 0) + (existingSession?.accounts.length || 0) > 0) return;
  const token = getLegacyToken();
  const user = getLegacyUser();
  if (!token || !user?.id) return;
  const storage = getLegacyStorageMode() || "persistent";
  const account: StoredCloudAccount = { user, storage, addedAt: nowIso(), lastUsedAt: nowIso() };
  saveSplitState({ activeOwnerId: user.id, accounts: [account] });
  setRuntimeAccessToken(user.id, {
    accessToken: token,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    tokenType: "bearer",
  });
  removeLegacySessionKeys();
  logAuthLifecycle("migrated legacy single session", { userId: shortUserId(user.id), email: maskEmail(user.email), storage });
}

function readStoredAuthStateSnapshot(): StoredAuthState {
  if (typeof window === "undefined") return emptyAuthState();
  migrateLegacySessionIfNeeded();
  const localState = readJsonState(window.localStorage, AUTH_STATE_KEY) || emptyAuthState();
  const sessionState = readJsonState(window.sessionStorage, AUTH_STATE_SESSION_KEY) || emptyAuthState();
  const preferredActive = sessionState.activeOwnerId !== LOCAL_OWNER_ID ? sessionState.activeOwnerId : localState.activeOwnerId;
  const merged = normalizeState({ activeOwnerId: preferredActive, accounts: [...sessionState.accounts, ...localState.accounts] });
  const originalCount = (sessionState.accounts.length || 0) + (localState.accounts.length || 0);
  if (merged.activeOwnerId !== preferredActive || merged.accounts.length !== originalCount) saveSplitState(merged);
  const metadataDetails = {
    metadataLoaded: merged.accounts.length > 0,
    loadedMetadataAccounts: merged.accounts.length,
    activeOwnerId: shortAccountId(merged.activeOwnerId),
    activeOwnerMatchesAccount: merged.activeOwnerId === LOCAL_OWNER_ID || merged.accounts.some((account) => account.user.id === merged.activeOwnerId),
    accountsStorageModes: merged.accounts.map((account) => account.storage),
  };
  logAuthLifecycle("auth metadata loaded", metadataDetails);
  return merged;
}

function mergeTokenIntoAccount(account: StoredCloudAccount | null): StoredCloudSession | null {
  if (!account) return null;
  const runtime = getRuntimeAccessToken(account.user.id);
  if (!runtime?.accessToken) return null;
  return { ...account, token: runtime.accessToken, tokenType: runtime.tokenType, expiresAt: runtime.expiresAt };
}

function getStoredTokenSource(account: StoredCloudAccount | null): CloudTokenSource {
  if (!account) return "missing";
  const runtime = getRuntimeAccessToken(account.user.id);
  if (runtime?.accessToken) return account.storage === "session" ? "session" : "secure";
  if (persistentRefreshTokenCache.has(account.user.id)) return "secure";
  return "missing";
}

async function hydratePersistentTokens() {
  if (persistentTokenHydrationPromise) return persistentTokenHydrationPromise;
  if (isHydratingSecureTokens) return Promise.resolve();
  persistentTokenHydrationPromise = (async () => {
    if (typeof window === "undefined" || !canUseSecurePersistentTokenStorage()) {
      logAuthLifecycle("secure token hydrate skipped", { secureStorageAvailable: false });
      return;
    }
    const state = readStoredAuthStateSnapshot();
    const persistentAccounts = state.accounts.filter((account) => account.storage === "persistent");
    isHydratingSecureTokens = true;
    logAuthLifecycle("secure token hydrate start", {
      loadedAny: false,
      accountsChecked: 0,
      persistentAccounts: persistentAccounts.length,
      reason: "hydrate_requested",
    });
    let accountsChecked = 0;
    let loadedAny = false;
    for (const account of persistentAccounts) {
      if (persistentRefreshTokenCache.has(account.user.id)) continue;
      accountsChecked += 1;
      const token = await loadPersistentCloudTokenSecure(account.user.id);
      const value = token?.found && typeof token.token === "string" && token.token.trim() ? token.token : null;
      if (value) {
        persistentRefreshTokenCache.set(account.user.id, value);
        loadedAny = true;
      }
    }
    if (loadedAny) notifyAccountSessionChanged();
    hasHydratedSecureTokensThisBoot = true;
    lastHydratedAuthStateRevision = authStateRevision;
    const hydrateReason = loadedAny
      ? "hydrated_refresh_tokens"
      : accountsChecked > 0
        ? "no_refresh_tokens_found"
        : "already_cached_or_no_persistent_accounts";
    lastHydrateResult = {
      loadedAny,
      accountsChecked,
      persistentAccounts: persistentAccounts.length,
      reason: hydrateReason,
    };
    if (!loadedAny && accountsChecked > 0) {
      logAuthLifecycle("secure token hydrate end", {
        loadedAny: false,
        reason: "no_refresh_tokens_found",
        accountsChecked,
        persistentAccounts: persistentAccounts.length,
        availability: persistentAccounts.length > 0 ? "saved_without_token" : "none",
      });
      return;
    }
    logAuthLifecycle("secure token hydrate end", {
      loadedAny,
      reason: hydrateReason,
      accountsChecked,
      persistentAccounts: persistentAccounts.length,
    });
  })().finally(() => {
    isHydratingSecureTokens = false;
    persistentTokenHydrationPromise = null;
  });
  return persistentTokenHydrationPromise;
}

export async function migrateLegacyLocalStorageTokens() {
  if (hasAttemptedSecureTokenMigration) return;
  if (legacyTokenMigrationPromise) return legacyTokenMigrationPromise;
  legacyTokenMigrationPromise = (async () => {
    if (typeof window === "undefined") return;
    hasAttemptedSecureTokenMigration = true;
    logAuthLifecycle("secure token migration start");
    const state = readStoredAuthStateSnapshot();
    let changed = false;
    const persistedState = readPersistedAuthStateRaw(window.localStorage, AUTH_STATE_KEY);
    const persistedAccounts = persistedState?.accounts || [];
    const migratedAccounts = persistedAccounts.map((account) => {
      const legacyToken = typeof (account as PersistedCloudAccount).token === "string" && (account as PersistedCloudAccount).token?.trim()
        ? ((account as PersistedCloudAccount).token as string)
        : null;
      if (!legacyToken) return account;
      setRuntimeAccessToken(account.user.id, {
        accessToken: legacyToken,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        tokenType: "bearer",
      });
      changed = true;
      return { ...account, token: null };
    });
    if (changed) {
      window.localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({ activeOwnerId: state.activeOwnerId, accounts: migratedAccounts }));
      logAuthLifecycle("migrated legacy access tokens out of localStorage", { migratedAccounts: migratedAccounts.length });
      notifyAccountSessionChanged();
    }
    logAuthLifecycle("secure token migration end", { changed });
  })().finally(() => {
    legacyTokenMigrationPromise = null;
  });
  return legacyTokenMigrationPromise;
}

function queueTokenMigration() {
  if (typeof window === "undefined" || tokenMaintenanceQueued) return;
  tokenMaintenanceQueued = true;
  queueMicrotask(() => {
    tokenMaintenanceQueued = false;
    void migrateLegacyLocalStorageTokens();
    const shouldHydrate =
      canUseSecurePersistentTokenStorage() &&
      !isHydratingSecureTokens &&
      (!hasHydratedSecureTokensThisBoot || lastHydratedAuthStateRevision !== authStateRevision);
    if (shouldHydrate) {
      void hydratePersistentTokens();
    }
  });
}

export function isCloudAuthConfigured() {
  return CLOUD_API_URL.length > 0;
}

export function getStoredAuthState(): StoredAuthState {
  const merged = readStoredAuthStateSnapshot();
  queueTokenMigration();
  return merged;
}

export function getCloudAuthHydrationState(): CloudAuthHydrationState {
  const state = readStoredAuthStateSnapshot();
  const persistentAccounts = state.accounts.filter((account) => account.storage === "persistent").length;
  const pending = canUseSecurePersistentTokenStorage()
    && persistentAccounts > 0
    && (isHydratingSecureTokens || !hasHydratedSecureTokensThisBoot || lastHydratedAuthStateRevision !== authStateRevision);
  return {
    pending,
    inProgress: isHydratingSecureTokens,
    hasHydratedThisBoot: hasHydratedSecureTokensThisBoot,
    persistentAccounts,
    activeOwnerId: state.activeOwnerId,
  };
}

export function saveStoredAuthState(state: StoredAuthState, options: { notify?: boolean } = {}) {
  const normalized = normalizeState(state);
  saveSplitState(normalized);
  authStateRevision += 1;
  logAuthLifecycle("auth metadata saved", {
    loadedMetadataAccounts: normalized.accounts.length,
    activeOwnerId: shortUserId(normalized.activeOwnerId),
    persistentAccounts: normalized.accounts.filter((account) => account.storage === "persistent").length,
    sessionAccounts: normalized.accounts.filter((account) => account.storage === "session").length,
  });
  removeLegacySessionKeys();
  if (options.notify ?? true) notifyAccountSessionChanged();
}

export function getStoredAccounts() {
  return getStoredAuthState().accounts;
}

export function getActiveOwnerId() {
  return getStoredAuthState().activeOwnerId || LOCAL_OWNER_ID;
}

export const getCurrentOwnerId = getActiveOwnerId;

export function isCloudOwner(ownerId: string | null | undefined) {
  const value = String(ownerId || "");
  return value.length > 0 && value !== LOCAL_OWNER_ID;
}

export function getActiveAccount() {
  const state = getStoredAuthState();
  return state.accounts.find((account) => account.user.id === state.activeOwnerId) || null;
}

export function getActiveCloudSession(): StoredCloudSession | null {
  return mergeTokenIntoAccount(getActiveAccount());
}

export async function getActiveCloudSessionAsync(): Promise<StoredCloudSession | null> {
  const state = await getActiveCloudAuthState();
  return state.session;
}

export function getStoredSession(): StoredCloudSession | null {
  return getActiveCloudSession();
}

export async function getStoredSessionAsync(): Promise<StoredCloudSession | null> {
  return getActiveCloudSessionAsync();
}

export function getStoredToken() {
  return getActiveCloudSession()?.token || null;
}

export async function getStoredTokenAsync() {
  return (await getActiveCloudSessionAsync())?.token || null;
}

export function getStoredUser(): CloudUser | null {
  return getActiveAccount()?.user || null;
}

export function getTokenStorageMode(): "persistent" | "session" | null {
  return getActiveAccount()?.storage || null;
}

export async function saveCloudToken(accountId: string, tokens: CloudAuthTokens, mode: "persistent" | "session"): Promise<SaveCloudTokenResult> {
  const normalizedAccountId = normalizePersistentAccountId(accountId);
  setRuntimeAccessToken(normalizedAccountId, {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType || "bearer",
  });
  if (mode === "session") {
    await deletePersistentCloudTokenSecure(normalizedAccountId).catch(() => null);
    persistentRefreshTokenCache.delete(normalizedAccountId);
    clearAccountAuthStatus(normalizedAccountId);
    setAccountRuntimeAuthState(normalizedAccountId, {
      availability: "active",
      refreshTokenFound: false,
      accessTokenValid: !isTokenExpiredOrNearExpiry(tokens.expiresAt, 0),
    });
    return { storedSecurely: false, fallbackUsed: false, roundtrip: false, secureStorageAvailable: canUseSecurePersistentTokenStorage() };
  }
  if (!canUseSecurePersistentTokenStorage()) {
    logAuthLifecycle("secure token save skipped", {
      accountId: shortAccountId(normalizedAccountId),
      storage: mode,
      secureStorageAvailable: false,
      errorCode: "secure_storage_unavailable",
    });
    setAccountAuthStatus(normalizedAccountId, {
      lastAuthErrorCode: "secure_storage_unavailable",
      lastRefreshSuccess: false,
      lastRotatedRefresh: false,
    });
    setAccountRuntimeAuthState(normalizedAccountId, {
      availability: "active",
      refreshTokenFound: false,
      accessTokenValid: !isTokenExpiredOrNearExpiry(tokens.expiresAt, 0),
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: false };
  }
  if (!tokens.refreshToken) {
    logAuthLifecycle("secure token save skipped", {
      accountId: shortAccountId(normalizedAccountId),
      storage: mode,
      secureStorageAvailable: true,
      reason: "missing_refresh_token",
      errorCode: "missing_refresh_token",
    });
    setAccountAuthStatus(normalizedAccountId, {
      lastAuthErrorCode: "missing_refresh_token",
      lastRefreshSuccess: false,
      lastRotatedRefresh: false,
    });
    setAccountRuntimeAuthState(normalizedAccountId, {
      availability: "active",
      refreshTokenFound: false,
      accessTokenValid: !isTokenExpiredOrNearExpiry(tokens.expiresAt, 0),
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: true };
  }
  logAuthLifecycle("secure token save start", {
    accountId: shortAccountId(normalizedAccountId),
    storage: mode,
    secureStorageAvailable: true,
    refreshTokenLength: tokens.refreshToken.length,
  });
  const saved = await savePersistentCloudTokenSecure(normalizedAccountId, tokens.refreshToken);
  if (!saved?.ok) {
    persistentRefreshTokenCache.delete(normalizedAccountId);
    setAccountAuthStatus(normalizedAccountId, {
      lastAuthErrorCode: saved?.error_code || "secure_refresh_save_failed",
      lastRefreshSuccess: false,
      lastRotatedRefresh: false,
    });
    setAccountRuntimeAuthState(normalizedAccountId, {
      availability: "active",
      refreshTokenFound: false,
      accessTokenValid: !isTokenExpiredOrNearExpiry(tokens.expiresAt, 0),
    });
    logAuthLifecycle("secure token save end", {
      accountId: shortAccountId(normalizedAccountId),
      storage: mode,
      success: false,
      roundtrip: false,
      errorCode: saved?.error_code || "secure_refresh_save_failed",
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: true, errorCode: saved?.error_code || "secure_refresh_save_failed" };
  }
  if (!saved.roundtrip) {
    persistentRefreshTokenCache.delete(normalizedAccountId);
    await deletePersistentCloudTokenSecure(normalizedAccountId).catch(() => null);
    setAccountAuthStatus(normalizedAccountId, {
      lastAuthErrorCode: saved.error_code || "keyring_roundtrip_failed",
      lastRefreshSuccess: false,
      lastRotatedRefresh: false,
    });
    setAccountRuntimeAuthState(normalizedAccountId, {
      availability: "active",
      refreshTokenFound: false,
      accessTokenValid: !isTokenExpiredOrNearExpiry(tokens.expiresAt, 0),
    });
    logAuthLifecycle("secure token save end", {
      accountId: shortAccountId(normalizedAccountId),
      storage: mode,
      success: false,
      roundtrip: false,
      errorCode: saved.error_code || "keyring_roundtrip_failed",
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: true, errorCode: saved.error_code || "keyring_roundtrip_failed" };
  }
  persistentRefreshTokenCache.set(normalizedAccountId, tokens.refreshToken);
  clearAccountAuthStatus(normalizedAccountId);
  setAccountRuntimeAuthState(normalizedAccountId, {
    availability: "active",
    refreshTokenFound: true,
    accessTokenValid: !isTokenExpiredOrNearExpiry(tokens.expiresAt, 0),
  });
  logAuthLifecycle("secure token save end", {
    accountId: shortAccountId(normalizedAccountId),
    secureStorageAvailable: true,
    storage: mode,
    success: true,
    roundtrip: true,
    errorCode: null,
  });
  return { storedSecurely: true, fallbackUsed: false, roundtrip: true, secureStorageAvailable: true, errorCode: null };
}

export async function loadCloudToken(accountId: string) {
  const normalizedAccountId = normalizePersistentAccountId(accountId);
  if (persistentRefreshTokenCache.has(normalizedAccountId)) {
    logAuthLifecycle("secure token load cache hit", {
      accountId: shortAccountId(normalizedAccountId),
      storage: "persistent",
      refreshTokenFound: true,
      tokenSource: "secure",
      secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    });
    return persistentRefreshTokenCache.get(normalizedAccountId) || null;
  }
  if (!canUseSecurePersistentTokenStorage()) {
    logAuthLifecycle("secure token load skipped", {
      accountId: shortAccountId(normalizedAccountId),
      storage: "persistent",
      secureStorageAvailable: false,
    });
    return null;
  }
  logAuthLifecycle("secure token load start", {
    accountId: shortAccountId(normalizedAccountId),
    storage: "persistent",
    secureStorageAvailable: true,
  });
  const token = await loadPersistentCloudTokenSecure(normalizedAccountId);
  logAuthLifecycle("secure token load end", {
    accountId: shortAccountId(normalizedAccountId),
    storage: "persistent",
    secureStorageAvailable: true,
    refreshTokenFound: Boolean(token?.found && typeof token.token === "string" && token.token.trim()),
    tokenSource: token?.found ? "secure" : "missing",
    errorCode: token?.error_code || null,
  });
  const value = token?.found && typeof token.token === "string" && token.token.trim() ? token.token : null;
  if (value) persistentRefreshTokenCache.set(normalizedAccountId, value);
  return value;
}

export async function deleteCloudToken(accountId: string) {
  const normalizedAccountId = normalizePersistentAccountId(accountId);
  logAuthLifecycle("secure token delete start", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
  });
  persistentRefreshTokenCache.delete(normalizedAccountId);
  setRuntimeAccessToken(normalizedAccountId, null);
  clearAccountAuthStatus(normalizedAccountId);
  clearAccountRuntimeAuthState(normalizedAccountId);
  if (!canUseSecurePersistentTokenStorage()) return { ok: true, secureStorageAvailable: false, errorCode: null as string | null };
  const result = await deletePersistentCloudTokenSecure(normalizedAccountId);
  if (!result?.ok) {
    console.warn("[auth] secure token delete incomplete", JSON.stringify(sanitizeAuthLogValue({
      accountId: shortAccountId(normalizedAccountId),
      secureStorageAvailable: true,
      errorCode: result?.error_code || "secure_refresh_delete_failed",
    })));
    return {
      ok: false,
      secureStorageAvailable: true,
      errorCode: result?.error_code || "secure_refresh_delete_failed",
    };
  }
  logAuthLifecycle("secure token delete end", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: true,
    success: true,
  });
  return { ok: true, secureStorageAvailable: true, errorCode: null as string | null };
}

async function resolveCloudSessionForAccount(account: StoredCloudAccount | null): Promise<{ session: StoredCloudSession | null; tokenSource: CloudTokenSource }> {
  if (!account) return { session: null, tokenSource: "missing" };
  const runtime = mergeTokenIntoAccount(account);
  if (runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt)) {
    return { session: runtime, tokenSource: account.storage === "session" ? "session" : "secure" };
  }
  const refreshed = await getValidAccessToken(account.user.id);
  if (!refreshed) return { session: null, tokenSource: account.storage === "persistent" ? "missing" : "missing" };
  return { session: refreshed, tokenSource: account.storage === "persistent" ? "secure" : "session" };
}

function isSessionExpiredAuthCode(code: string | null) {
  return code === "refresh_http_401"
    || code === "refresh_http_403"
    || code === "refresh_auth"
    || code === "verify_http_401"
    || code === "verify_http_403"
    || code === "verify_auth";
}

function isRefreshFailureCode(code: string | null) {
  return code === "refresh_network"
    || code === "refresh_timeout"
    || code === "refresh_server"
    || code === "refresh_unknown"
    || code === "refresh_http_429"
    || code === "refresh_http_500"
    || code === "refresh_http_502"
    || code === "refresh_http_503"
    || code === "refresh_http_504";
}

function isAuthSubsystemErrorCode(code: string | null) {
  return code === "secure_storage_unavailable"
    || code === "secure_refresh_save_failed"
    || code === "keyring_roundtrip_failed"
    || code === "missing_refresh_token";
}

function isPersistenceFailureCode(code: string | null) {
  return code === "secure_storage_unavailable"
    || code === "secure_refresh_save_failed"
    || code === "keyring_roundtrip_failed";
}

function resolvePersistenceStatus(
  account: StoredCloudAccount | null,
  options?: {
    authStatus?: AccountAuthStatus | null;
    refreshTokenFound?: boolean;
  },
): CloudPersistenceStatus {
  if (!account || account.storage !== "persistent") return "unknown";
  const authStatus = options?.authStatus || getAccountAuthStatus(account.user.id);
  if (isPersistenceFailureCode(authStatus.lastAuthErrorCode)) return "failed";
  if (options?.refreshTokenFound) return "ok";
  if (persistentRefreshTokenCache.has(account.user.id)) return "ok";
  return "unknown";
}

function getActivePersistenceStatusSnapshot(): CloudPersistenceStatus {
  const account = getActiveAccount();
  if (!account) return "unknown";
  return resolvePersistenceStatus(account);
}

async function resolveCloudAvailability(
  account: StoredCloudAccount,
  session: StoredCloudSession | null,
): Promise<{ availability: CloudSessionAvailability; refreshTokenFound: boolean }> {
  const runtimeSessionValid = Boolean(session?.token);
  const runtimeState = getAccountRuntimeAuthState(account.user.id);
  if (runtimeSessionValid) {
    return {
      availability: "active",
      refreshTokenFound: account.storage === "persistent"
        ? Boolean(runtimeState?.refreshTokenFound)
        : false,
    };
  }
  if (runtimeState) {
    return {
      availability: runtimeState.availability,
      refreshTokenFound: runtimeState.refreshTokenFound,
    };
  }
  if (account.storage !== "persistent") {
    return { availability: "session_expired", refreshTokenFound: false };
  }
  const refreshTokenFound = Boolean(persistentRefreshTokenCache.get(account.user.id) || (await loadCloudToken(account.user.id)));
  if (!refreshTokenFound) {
    return { availability: "saved_without_token", refreshTokenFound: false };
  }
  return { availability: session ? "active" : "unknown_error", refreshTokenFound: true };
}

async function refreshAccessTokenForAccount(account: StoredCloudAccount): Promise<StoredCloudSession | null> {
  if (account.storage !== "persistent") return mergeTokenIntoAccount(account);
  const refreshToken = await loadCloudToken(account.user.id);
  if (!refreshToken) {
    setAccountAuthStatus(account.user.id, {
      lastAuthErrorCode: "refresh_token_missing",
      lastRefreshSuccess: false,
      lastRotatedRefresh: false,
    });
    setAccountRuntimeAuthState(account.user.id, {
      availability: "saved_without_token",
      refreshTokenFound: false,
      accessTokenValid: false,
    });
    logAuthLifecycle("refresh skipped", {
      accountId: shortAccountId(account.user.id),
      storage: account.storage,
      tokenSource: "missing",
      refreshTokenFound: false,
      refreshSuccess: false,
      rotatedRefresh: false,
      reason: "refresh_token_missing",
      availability: "saved_without_token",
      secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    });
    return null;
  }
  logAuthLifecycle("refresh start", {
    accountId: shortAccountId(account.user.id),
    storage: account.storage,
    tokenSource: "secure",
    refreshTokenFound: true,
    reason: "access_token_missing_or_expired",
  });
  try {
    const response = await cloudAuth.refresh(refreshToken);
    const runtime = buildRuntimeToken(response);
    const rotatedRefresh = Boolean(response.refresh_token && response.refresh_token !== refreshToken);
    const secureResult = await saveCloudToken(
      account.user.id,
      {
        accessToken: runtime.accessToken,
        refreshToken: response.refresh_token || refreshToken,
        expiresAt: runtime.expiresAt,
        tokenType: runtime.tokenType,
      },
      "persistent",
    );
    if (!secureResult.storedSecurely) {
      const updatedAccount: StoredCloudAccount = {
        ...account,
        user: response.user,
        lastUsedAt: nowIso(),
        storage: "persistent",
      };
      const state = getStoredAuthState();
      saveStoredAuthState(
        {
          activeOwnerId: state.activeOwnerId === account.user.id ? account.user.id : state.activeOwnerId,
          accounts: [updatedAccount, ...state.accounts.filter((item) => item.user.id !== account.user.id)],
        },
        { notify: false },
      );
      setAccountAuthStatus(account.user.id, {
        lastAuthErrorCode: secureResult.errorCode || "secure_refresh_save_failed",
        lastRefreshSuccess: false,
        lastRotatedRefresh: rotatedRefresh,
      });
      setAccountRuntimeAuthState(account.user.id, {
        availability: "active",
        refreshTokenFound: false,
        accessTokenValid: true,
      });
      logAuthLifecycle("refresh end", {
        accountId: shortAccountId(account.user.id),
        storage: account.storage,
        tokenSource: "secure",
        refreshTokenFound: true,
        refreshSuccess: false,
        rotatedRefresh,
        reason: "refresh_persist_failed",
        statusCode: null,
        availability: "auth_error",
        errorCode: secureResult.errorCode || "secure_refresh_save_failed",
      });
      return {
        ...updatedAccount,
        token: runtime.accessToken,
        tokenType: runtime.tokenType,
        expiresAt: runtime.expiresAt,
      };
    }
    const updatedAccount: StoredCloudAccount = {
      ...account,
      user: response.user,
      lastUsedAt: nowIso(),
      storage: "persistent",
    };
    const state = getStoredAuthState();
    saveStoredAuthState(
      {
        activeOwnerId: state.activeOwnerId === account.user.id ? account.user.id : state.activeOwnerId,
        accounts: [updatedAccount, ...state.accounts.filter((item) => item.user.id !== account.user.id)],
      },
      { notify: false },
    );
    setAccountAuthStatus(account.user.id, {
      lastAuthErrorCode: null,
      lastRefreshSuccess: true,
      lastRotatedRefresh: rotatedRefresh,
    });
    setAccountRuntimeAuthState(account.user.id, {
      availability: "active",
      refreshTokenFound: true,
      accessTokenValid: true,
    });
    logAuthLifecycle("refresh end", {
      accountId: shortAccountId(account.user.id),
      storage: updatedAccount.storage,
      tokenSource: updatedAccount.storage === "persistent" ? "secure" : "session",
      refreshTokenFound: true,
      refreshSuccess: true,
      rotatedRefresh,
      reason: "refresh_completed",
      statusCode: 200,
      availability: "active",
    });
    return { ...updatedAccount, token: runtime.accessToken, tokenType: runtime.tokenType, expiresAt: runtime.expiresAt };
  } catch (error) {
    const errorCode =
      error instanceof CloudAuthRequestError
        ? error.statusCode
          ? `refresh_http_${error.statusCode}`
          : `refresh_${error.kind}`
        : "refresh_unknown";
    const availability = isSessionExpiredAuthCode(errorCode)
      ? "session_expired"
      : isRefreshFailureCode(errorCode)
        ? "refresh_failed"
        : isAuthSubsystemErrorCode(errorCode)
          ? "auth_error"
          : "unknown_error";
    setAccountAuthStatus(account.user.id, {
      lastAuthErrorCode: errorCode,
      lastRefreshSuccess: false,
      lastRotatedRefresh: false,
    });
    setAccountRuntimeAuthState(account.user.id, {
      availability,
      refreshTokenFound: true,
      accessTokenValid: false,
    });
    logAuthLifecycle("refresh end", {
      accountId: shortAccountId(account.user.id),
      storage: account.storage,
      tokenSource: "secure",
      refreshTokenFound: true,
      refreshSuccess: false,
      rotatedRefresh: false,
      reason: error instanceof CloudAuthRequestError ? `refresh_${error.kind}` : "refresh_unknown",
      statusCode: error instanceof CloudAuthRequestError ? error.statusCode : null,
      availability,
      errorCode,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    setRuntimeAccessToken(account.user.id, null);
    return null;
  }
}

export async function getValidAccessToken(ownerId?: string): Promise<StoredCloudSession | null> {
  const state = getStoredAuthState();
  const account =
    ownerId && ownerId !== LOCAL_OWNER_ID
      ? state.accounts.find((item) => item.user.id === ownerId) || null
      : getActiveAccount();
  logAuthLifecycle("getValidAccessToken start", {
    accountId: account ? shortAccountId(account.user.id) : null,
    storage: account?.storage || "none",
    accessTokenValidBefore: false,
    refreshAttempted: false,
  });
  if (!account) {
    logAuthLifecycle("getValidAccessToken end", {
      accountId: null,
      accessTokenValidBefore: false,
      refreshAttempted: false,
      tokenAvailable: false,
      reason: "no_account",
    });
    return null;
  }
  const runtime = mergeTokenIntoAccount(account);
  const accessTokenValidBefore = Boolean(runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt));
  if (runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt)) {
    setAccountRuntimeAuthState(account.user.id, {
      availability: "active",
      refreshTokenFound: account.storage === "persistent" ? Boolean(persistentRefreshTokenCache.get(account.user.id)) : false,
      accessTokenValid: true,
    });
    logAuthLifecycle("getValidAccessToken end", {
      accountId: shortAccountId(account.user.id),
      accessTokenValidBefore: true,
      refreshAttempted: false,
      tokenAvailable: true,
      reason: "runtime_token_valid",
    });
    return runtime;
  }
  if (account.storage === "session") {
    if (runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt, 0)) {
      setAccountRuntimeAuthState(account.user.id, {
        availability: "active",
        refreshTokenFound: false,
        accessTokenValid: true,
      });
      logAuthLifecycle("getValidAccessToken end", {
        accountId: shortAccountId(account.user.id),
        accessTokenValidBefore: false,
        refreshAttempted: false,
        tokenAvailable: true,
        reason: "runtime_token_still_usable",
      });
      return runtime;
    }
    setRuntimeAccessToken(account.user.id, null);
    setAccountRuntimeAuthState(account.user.id, {
      availability: "session_expired",
      refreshTokenFound: false,
      accessTokenValid: false,
    });
    logAuthLifecycle("getValidAccessToken end", {
      accountId: shortAccountId(account.user.id),
      accessTokenValidBefore: false,
      refreshAttempted: false,
      tokenAvailable: false,
      reason: "session_token_missing_or_expired",
    });
    return null;
  }
  if (!activeRefreshPromises.has(account.user.id)) {
    activeRefreshPromises.set(
      account.user.id,
      refreshAccessTokenForAccount(account).finally(() => {
        activeRefreshPromises.delete(account.user.id);
      }),
    );
  }
  const refreshed = (await activeRefreshPromises.get(account.user.id)) || null;
  logAuthLifecycle("getValidAccessToken end", {
    accountId: shortAccountId(account.user.id),
    accessTokenValidBefore,
    refreshAttempted: true,
    tokenAvailable: Boolean(refreshed?.token),
    reason: refreshed?.token ? "refresh_result" : "refresh_failed_or_missing",
  });
  return refreshed;
}

export async function forceRefreshActiveCloudSession(): Promise<StoredCloudSession | null> {
  const account = getActiveAccount();
  if (!account) return null;
  if (account.storage !== "persistent") return getValidAccessToken(account.user.id);
  if (!activeRefreshPromises.has(account.user.id)) {
    activeRefreshPromises.set(
      account.user.id,
      refreshAccessTokenForAccount(account).finally(() => {
        activeRefreshPromises.delete(account.user.id);
      }),
    );
  }
  return activeRefreshPromises.get(account.user.id) || null;
}

export async function getActiveCloudAuthState(): Promise<ActiveCloudAuthState> {
  const ownerId = getActiveOwnerId();
  const account = getActiveAccount();
  const secureStorageAvailable = canUseSecurePersistentTokenStorage();
  if (ownerId === LOCAL_OWNER_ID) {
    return {
      ownerId,
      account: null,
      session: null,
      availability: "local",
      tokenSource: "missing",
      secureStorageAvailable,
      persistenceStatus: "unknown",
      persistentStorageError: false,
      requiresRelogin: false,
    };
  }
  if (!account) {
    return {
      ownerId,
      account: null,
      session: null,
      availability: "none",
      tokenSource: "missing",
      secureStorageAvailable,
      persistenceStatus: "unknown",
      persistentStorageError: false,
      requiresRelogin: false,
    };
  }
  const { session, tokenSource } = await resolveCloudSessionForAccount(account);
  const { availability, refreshTokenFound } = await resolveCloudAvailability(account, session);
  const runtime = getRuntimeAccessToken(account.user.id);
  const authStatus = getAccountAuthStatus(account.user.id);
  const persistenceStatus = resolvePersistenceStatus(account, { authStatus, refreshTokenFound });
  const persistentStorageError = persistenceStatus === "failed";
  const requiresRelogin = availability !== "active" || persistentStorageError;
  logAuthLifecycle("active cloud auth state", {
    accountId: shortAccountId(account.user.id),
    storage: account.storage,
    tokenSource,
    refreshTokenFound,
    accessTokenValid: Boolean(runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt, 0)),
    lastAuthErrorCode: authStatus.lastAuthErrorCode,
    secureStorageAvailable,
    availability,
    persistenceStatus,
    persistentStorageError,
    requiresRelogin,
  });
  return {
    ownerId,
    account,
    session,
    availability,
    tokenSource,
    secureStorageAvailable,
    persistenceStatus,
    persistentStorageError,
    requiresRelogin,
  };
}

export async function getCloudAuthDiagnostics(): Promise<CloudAuthDiagnostics> {
  const state = await getActiveCloudAuthState();
  const ownerId = state.ownerId;
  const account = state.account;
  const secureStorageAvailable = state.secureStorageAvailable;
  const runtimeToken = state.session
    ? {
        accessToken: state.session.token,
        expiresAt: state.session.expiresAt,
        tokenType: state.session.tokenType,
      }
    : account
    ? getRuntimeAccessToken(account.user.id)
    : null;
  const authStatus = account ? getAccountAuthStatus(account.user.id) : emptyAccountAuthStatus();
  const refreshTokenFound = account
    ? Boolean(
        persistentRefreshTokenCache.get(account.user.id)
        || (account.storage === "persistent" ? await loadCloudToken(account.user.id) : null),
      )
    : false;
  return {
    activeOwnerId: shortAccountId(ownerId),
    accountId: account ? shortAccountId(account.user.id) : null,
    storage: ownerId === LOCAL_OWNER_ID ? "local" : account?.storage || "none",
    availability: state.availability,
    tokenSource: state.tokenSource,
    secureStorageAvailable,
    persistenceStatus: state.persistenceStatus,
    persistentStorageError: state.persistentStorageError,
    refreshTokenFound,
    refreshSuccess: authStatus.lastRefreshSuccess,
    rotatedRefresh: authStatus.lastRotatedRefresh,
    accessTokenValid: Boolean(runtimeToken && !isTokenExpiredOrNearExpiry(runtimeToken.expiresAt, 0)),
    accessTokenExpiresAt: runtimeToken?.expiresAt || null,
    lastAuthErrorCode: authStatus.lastAuthErrorCode,
  };
}

export async function addOrUpdateAccount(session: { user: CloudUser; tokens: CloudAuthTokens }, options: { remember?: boolean; makeActive?: boolean; notify?: boolean } = {}) {
  const state = getStoredAuthState();
  const requestedStorage: "persistent" | "session" = options.remember === false ? "session" : "persistent";
  const existing = state.accounts.find((account) => account.user.id === session.user.id);
  logAuthLifecycle("account store request", {
    accountId: shortAccountId(session.user.id),
    remember: options.remember !== false,
    requestedStorage,
    refreshTokenPresent: Boolean(session.tokens.refreshToken),
    refreshTokenLength: session.tokens.refreshToken?.length || 0,
  });
  const secureResult = await saveCloudToken(session.user.id, session.tokens, requestedStorage);
  const storage: "persistent" | "session" = requestedStorage;
  const account: StoredCloudAccount = {
    user: session.user,
    storage,
    addedAt: existing?.addedAt || nowIso(),
    lastUsedAt: nowIso(),
  };
  const accounts = [account, ...state.accounts.filter((item) => item.user.id !== session.user.id)];
  saveStoredAuthState({ activeOwnerId: options.makeActive === false ? state.activeOwnerId : session.user.id, accounts }, { notify: options.notify });
  const persistedLocalState = typeof window !== "undefined" ? readPersistedAuthStateRaw(window.localStorage, AUTH_STATE_KEY) : null;
  const metadataPersisted = Boolean(persistedLocalState?.accounts?.some((item) => item.user?.id === session.user.id && item.storage === "persistent"));
  logAuthLifecycle("auth metadata persisted", {
    accountId: shortAccountId(session.user.id),
    email: maskEmail(session.user.email),
    storage,
    requestedStorage,
    secure: requestedStorage === "persistent" ? secureResult.storedSecurely : false,
    fallbackUsed: secureResult.fallbackUsed,
    roundtrip: secureResult.roundtrip,
    metadataPersisted,
    accountsPersisted: persistedLocalState?.accounts?.length || 0,
    activeOwnerId: shortAccountId(options.makeActive === false ? state.activeOwnerId : session.user.id),
    localStorageHasToken: false,
    finalStorage: storage,
  });
  return {
    requestedStorage,
    finalStorage: storage,
    secureResult,
  };
}

export function switchActiveOwner(ownerId: string) {
  const state = getStoredAuthState();
  const nextOwner = ownerId === LOCAL_OWNER_ID || state.accounts.some((account) => account.user.id === ownerId) ? ownerId : LOCAL_OWNER_ID;
  const accounts = state.accounts.map((account) => (account.user.id === nextOwner ? { ...account, lastUsedAt: nowIso() } : account));
  saveStoredAuthState({ activeOwnerId: nextOwner, accounts });
  console.info("[owner] active owner changed", { mode: nextOwner === LOCAL_OWNER_ID ? "local" : "cloud" });
}

export function switchToLocalMode() {
  switchActiveOwner(LOCAL_OWNER_ID);
}

export async function removeAccount(ownerId: string) {
  const state = getStoredAuthState();
  const accounts = state.accounts.filter((account) => account.user.id !== ownerId);
  const activeOwnerId = state.activeOwnerId === ownerId ? LOCAL_OWNER_ID : state.activeOwnerId;
  const deleteResult = await deleteCloudToken(ownerId);
  saveStoredAuthState({ activeOwnerId, accounts });
  if (!deleteResult.ok) {
    console.warn("[auth] account removed with partial cleanup", JSON.stringify(sanitizeAuthLogValue({
      accountId: shortAccountId(ownerId),
      errorCode: deleteResult.errorCode,
    })));
  }
  return deleteResult;
}

export async function logoutAccount(ownerId: string) {
  const state = getStoredAuthState();
  const account = state.accounts.find((item) => item.user.id === ownerId) || null;
  if (!account) return;
  const refreshToken = account.storage === "persistent" ? await loadCloudToken(ownerId) : null;
  await cloudAuth.logout(refreshToken);
  return removeAccount(ownerId);
}

export async function clearAllAccounts() {
  const state = getStoredAuthState();
  const results = await Promise.all(state.accounts.map((account) => deleteCloudToken(account.user.id)));
  saveStoredAuthState(emptyAuthState());
  if (results.some((result) => !result.ok)) {
    console.warn("[auth] clear all accounts incomplete", JSON.stringify(sanitizeAuthLogValue({
      affectedAccounts: state.accounts.length,
      failedDeletes: results.filter((result) => !result.ok).length,
    })));
  }
  return {
    ok: results.every((result) => result.ok),
    failedDeletes: results.filter((result) => !result.ok).length,
  };
}

export async function clearActiveAccountSession() {
  const active = getActiveOwnerId();
  if (active === LOCAL_OWNER_ID) switchToLocalMode();
  else return removeAccount(active);
  return { ok: true, secureStorageAvailable: false, errorCode: null as string | null };
}

export async function clearStoredSession() {
  return clearActiveAccountSession();
}

export async function setStoredSession(token: string, user: CloudUser, remember: boolean, notify = true) {
  await addOrUpdateAccount({
    user,
    tokens: {
      accessToken: token,
      expiresAt: computeExpiresAt(900),
      tokenType: "bearer",
      refreshToken: null,
    },
  }, { remember, makeActive: true, notify });
}

export async function setStoredToken(token: string, remember: boolean) {
  const active = getActiveAccount();
  if (active) {
    await addOrUpdateAccount({
      user: active.user,
      tokens: {
        accessToken: token,
        expiresAt: computeExpiresAt(900),
        tokenType: "bearer",
        refreshToken: null,
      },
    }, { remember, makeActive: true });
  }
}

export async function clearStoredToken() {
  return clearActiveAccountSession();
}

export const getCloudToken = getStoredToken;
export const saveCloudTokenForActiveAccount = (token: string) => setStoredToken(token, DEFAULT_REMEMBER_CLOUD_ACCOUNT);
export const clearCloudToken = clearStoredToken;

export function subscribeAuthChanges(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, listener);
}

async function cloudRequest<T>(path: string, options: RequestInit = {}, timeoutMs = CLOUD_AUTH_TIMEOUT_MS): Promise<T> {
  if (!isCloudAuthConfigured()) throw new CloudAuthRequestError("El servicio de cuenta no está configurado en este entorno.", { kind: "unknown" });
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetch(`${CLOUD_API_URL}${path}`, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (error) {
    console.error("Cloud auth request failed", { path, errorType: error instanceof Error ? error.name : typeof error });
    const isTimeout = error instanceof Error && error.name === "AbortError";
    throw new CloudAuthRequestError(
      isTimeout
        ? "No pudimos verificar la cuenta por un problema de conexión. La cuenta no fue eliminada."
        : "No se pudo conectar con el servicio de cuenta.",
      { kind: isTimeout ? "timeout" : "network" },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const detailCode = typeof detail?.code === "string" ? detail.code : null;
    const verification = detail?.verification;
    const recovery =
      verification?.status === "verification_required" &&
      typeof verification?.verification_token === "string" &&
      typeof verification?.email === "string"
        ? (verification as EmailVerificationRequiredResponse)
        : null;
    const detailMessage =
      typeof detail === "string"
        ? detail
        : typeof detail?.message === "string"
          ? detail.message
          : "No se pudo completar la acción.";
    if (path === "/auth/refresh") {
      logAuthLifecycle("refresh response", {
        status: response.status,
        refreshSuccess: false,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new CloudAuthRequestError(detailMessage, {
        statusCode: response.status,
        kind: "auth",
        code: detailCode,
        verification: recovery,
      });
    }
    throw new CloudAuthRequestError(detailMessage, {
      statusCode: response.status,
      kind: response.status >= 500 ? "server" : "unknown",
      code: detailCode,
      verification: recovery,
    });
  }
  if (path === "/auth/refresh") {
    logAuthLifecycle("refresh response", {
      status: response.status,
      refreshSuccess: true,
    });
  }
  return response.json() as Promise<T>;
}

export const cloudAuth = {
  register: async (input: { email: string; password: string; display_name?: string | null }) => {
    const response = await cloudRequest<CloudAuthRegisterOrLoginResponse>(
      "/auth/register",
      { method: "POST", body: JSON.stringify(input) },
      CLOUD_EMAIL_FLOW_TIMEOUT_MS,
    );
    if (isEmailVerificationRequiredResponse(response)) {
      logAuthLifecycle("register verification required", {
        email: response.email,
        expiresIn: response.verification_expires_in,
      });
      return response;
    }
    logAuthLifecycle("register response", {
      accountId: shortAccountId(response.user.id),
      accessTokenPresent: Boolean(response.access_token),
      refreshTokenPresent: Boolean(response.refresh_token),
      expiresIn: response.expires_in,
    });
    return response;
  },
  login: async (input: { email: string; password: string }) => {
    const response = await cloudRequest<CloudAuthRegisterOrLoginResponse>("/auth/login", { method: "POST", body: JSON.stringify(input) });
    if (isEmailVerificationRequiredResponse(response)) {
      logAuthLifecycle("login verification required", {
        email: response.email,
        expiresIn: response.verification_expires_in,
      });
      return response;
    }
    logAuthLifecycle("login response", {
      accountId: shortAccountId(response.user.id),
      accessTokenPresent: Boolean(response.access_token),
      refreshTokenPresent: Boolean(response.refresh_token),
      expiresIn: response.expires_in,
    });
    return response;
  },
  verifyEmail: (input: { verification_token: string; code: string }) =>
    cloudRequest<CloudAuthResponse>("/auth/verify-email", { method: "POST", body: JSON.stringify(input) }),
  resendEmailVerification: (input: { verification_token: string }) =>
    cloudRequest<EmailVerificationRequiredResponse>(
      "/auth/resend-email-verification",
      { method: "POST", body: JSON.stringify(input) },
      CLOUD_EMAIL_FLOW_TIMEOUT_MS,
    ),
  refresh: (refreshToken: string) =>
    cloudRequest<CloudAuthResponse>("/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) }),
  me: (token: string) =>
    cloudRequest<CloudUser>("/auth/me", { method: "GET", headers: { Authorization: `Bearer ${token}` } }),
  logout: async (refreshToken: string | null) => {
    if (refreshToken && isCloudAuthConfigured()) {
      await cloudRequest<{ ok: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) }).catch((error) => {
        console.error("Cloud auth logout failed", { errorType: error instanceof Error ? error.name : typeof error });
      });
    }
  },
  googleStart: () =>
    cloudRequest<{ configured: boolean; login_request_id: string; auth_url: string }>("/auth/google/start", { method: "POST" }),
  googleStatus: async (loginRequestId: string) => {
    const response = await cloudRequest<
      | { status: "pending" }
      | { status: "expired" | "error" | "consumed"; message?: string }
      | ({ status: "completed" } & CloudAuthResponse)
    >(`/auth/google/status/${encodeURIComponent(loginRequestId)}`, { method: "GET" });
    if (response.status === "completed") {
      logAuthLifecycle("google status response", {
        accountId: shortAccountId(response.user.id),
        accessTokenPresent: Boolean(response.access_token),
        refreshTokenPresent: Boolean(response.refresh_token),
        expiresIn: response.expires_in,
      });
    }
    return response;
  },
};

// Not a UI source of truth. UI must consume getActiveCloudAuthState() + getAuthUIState().
export async function verifyStoredSession(ownerId?: string): Promise<StoredCloudSession | null> {
  const state = getStoredAuthState();
  const account = ownerId
    ? state.accounts.find((account) => account.user.id === ownerId) || null
    : getActiveAccount();
  const { session, tokenSource } = await resolveCloudSessionForAccount(account);
  logAuthLifecycle("verify stored session", {
    userId: account?.user?.id ? shortUserId(account.user.id) : "unknown",
    storageMode: account?.storage || "none",
    tokenSource,
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    hasSession: Boolean(session),
  });
  if (!session) return null;
  logAuthLifecycle("verify start", { userId: shortUserId(session.user.id), email: maskEmail(session.user.email) });
  try {
    const user = await cloudAuth.me(session.token);
    await addOrUpdateAccount({
      user,
      tokens: {
        accessToken: session.token,
        expiresAt: session.expiresAt,
        tokenType: session.tokenType,
        refreshToken: session.storage === "persistent" ? await loadCloudToken(session.user.id) : null,
      },
    }, { remember: session.storage === "persistent", makeActive: state.activeOwnerId === session.user.id, notify: false });
    logAuthLifecycle("verify success", { userId: shortUserId(user.id), email: maskEmail(user.email) });
    return { ...session, user };
  } catch (error) {
    console.warn("[auth] verify failed", JSON.stringify(sanitizeAuthLogValue({ errorType: error instanceof Error ? error.name : typeof error })));
    if (error instanceof CloudAuthRequestError && error.kind === "auth") {
      setRuntimeAccessToken(session.user.id, null);
      if (session.storage === "persistent") {
        const refreshTokenFound = Boolean(persistentRefreshTokenCache.get(session.user.id) || (await loadCloudToken(session.user.id)));
        setAccountAuthStatus(session.user.id, {
          lastAuthErrorCode: error.statusCode ? `verify_http_${error.statusCode}` : "verify_auth",
          lastRefreshSuccess: false,
          lastRotatedRefresh: false,
        });
        setAccountRuntimeAuthState(session.user.id, {
          availability: "session_expired",
          refreshTokenFound,
          accessTokenValid: false,
        });
      } else {
        await removeAccount(session.user.id);
      }
    }
    throw error;
  }
}
