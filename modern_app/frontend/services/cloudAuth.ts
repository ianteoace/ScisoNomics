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
export type CloudSessionAvailability = "local" | "none" | "saved_without_token" | "session_expired" | "refresh_failed" | "active";
export type ActiveCloudAuthState = {
  ownerId: string;
  account: StoredCloudAccount | null;
  session: StoredCloudSession | null;
  availability: CloudSessionAvailability;
  tokenSource: CloudTokenSource;
  secureStorageAvailable: boolean;
  requiresRelogin: boolean;
};

const LOCAL_OWNER_ID = "local";
const AUTH_STATE_KEY = "scisonomics_cloud_accounts_v1";
const AUTH_STATE_SESSION_KEY = "scisonomics_cloud_accounts_session_v1";
const ACCESS_TOKEN_STATE_SESSION_KEY = "scisonomics_cloud_access_tokens_session_v1";
const TOKEN_KEY = "scisonomics_cloud_access_token";
const USER_KEY = "scisonomics_cloud_user";
export const DEFAULT_REMEMBER_CLOUD_ACCOUNT = false;
export const ACCOUNT_SESSION_CHANGED_EVENT = "scisonomics:account-session-changed";
export const OWNER_CHANGED_EVENT = "scisonomics:owner-changed";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const CLOUD_AUTH_TIMEOUT_MS = 10000;

type CloudAuthErrorKind = "auth" | "network" | "timeout" | "server" | "unknown";

class CloudAuthRequestError extends Error {
  statusCode: number | null;
  kind: CloudAuthErrorKind;

  constructor(message: string, options: { statusCode?: number | null; kind?: CloudAuthErrorKind } = {}) {
    super(message);
    this.name = "CloudAuthRequestError";
    this.statusCode = options.statusCode ?? null;
    this.kind = options.kind || "unknown";
  }
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
};

const persistentRefreshTokenCache = new Map<string, string>();
const runtimeAccessTokenCache = new Map<string, StoredRuntimeToken>();
let persistentTokenHydrationPromise: Promise<void> | null = null;
let legacyTokenMigrationPromise: Promise<void> | null = null;
const activeRefreshPromises = new Map<string, Promise<StoredCloudSession | null>>();
let hasAttemptedSecureTokenMigration = false;
let tokenMaintenanceQueued = false;

function emptyAuthState(): StoredAuthState {
  return { activeOwnerId: LOCAL_OWNER_ID, accounts: [] };
}

function nowIso() {
  return new Date().toISOString();
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
    console.warn("[auth] secure token command failed", {
      command,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

async function savePersistentCloudTokenSecure(accountId: string, token: string) {
  const saved = await invokeCore<boolean>("save_persistent_cloud_refresh_token", { accountId: normalizePersistentAccountId(accountId), token });
  return saved === true;
}

async function loadPersistentCloudTokenSecure(accountId: string) {
  const token = await invokeCore<string | null>("load_persistent_cloud_refresh_token", { accountId: normalizePersistentAccountId(accountId) });
  return typeof token === "string" && token.trim() ? token : null;
}

async function deletePersistentCloudTokenSecure(accountId: string) {
  await invokeCore<boolean>("delete_persistent_cloud_refresh_token", { accountId: normalizePersistentAccountId(accountId) });
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

function logAuthLifecycle(stage: string, details?: Record<string, unknown>) {
  console.info("[auth]", stage, details || {});
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
    console.info("[auth] deduped stored account by normalized email", {
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
  console.info("[auth] migrated legacy single session", { userId: shortUserId(user.id), email: maskEmail(user.email), storage });
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
  logAuthLifecycle("auth metadata loaded", {
    loadedMetadataAccounts: merged.accounts.length,
    activeOwnerId: shortUserId(merged.activeOwnerId),
  });
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
  persistentTokenHydrationPromise = (async () => {
    if (typeof window === "undefined" || !canUseSecurePersistentTokenStorage()) {
      logAuthLifecycle("secure token hydrate skipped", { secureStorageAvailable: false });
      return;
    }
    logAuthLifecycle("secure token hydrate start");
    const state = readStoredAuthStateSnapshot();
    let loadedAny = false;
    for (const account of state.accounts) {
      if (account.storage !== "persistent" || persistentRefreshTokenCache.has(account.user.id)) continue;
      const token = await loadPersistentCloudTokenSecure(account.user.id);
      if (token) {
        persistentRefreshTokenCache.set(account.user.id, token);
        loadedAny = true;
      }
    }
    if (loadedAny) notifyAccountSessionChanged();
    logAuthLifecycle("secure token hydrate end", { loadedAny });
  })().finally(() => {
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
      console.info("[auth] migrated legacy access tokens out of localStorage", { migratedAccounts: migratedAccounts.length });
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
    void hydratePersistentTokens();
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

export function saveStoredAuthState(state: StoredAuthState, options: { notify?: boolean } = {}) {
  const normalized = normalizeState(state);
  saveSplitState(normalized);
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
    return { storedSecurely: false, fallbackUsed: false, roundtrip: false, secureStorageAvailable: canUseSecurePersistentTokenStorage() };
  }
  if (!canUseSecurePersistentTokenStorage()) {
    logAuthLifecycle("secure token save skipped", {
      userId: shortUserId(normalizedAccountId),
      storageMode: mode,
      secureStorageAvailable: false,
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: false };
  }
  if (!tokens.refreshToken) {
    logAuthLifecycle("secure token save skipped", {
      userId: shortUserId(normalizedAccountId),
      storageMode: mode,
      secureStorageAvailable: true,
      reason: "missing_refresh_token",
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: true };
  }
  logAuthLifecycle("secure token save start", {
    userId: shortUserId(normalizedAccountId),
    storageMode: mode,
    secureStorageAvailable: true,
  });
  const saved = await savePersistentCloudTokenSecure(normalizedAccountId, tokens.refreshToken);
  if (!saved) {
    persistentRefreshTokenCache.delete(normalizedAccountId);
    logAuthLifecycle("secure token save end", {
      userId: shortUserId(normalizedAccountId),
      storageMode: mode,
      success: false,
      roundtrip: false,
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: true };
  }
  const loaded = await loadPersistentCloudTokenSecure(normalizedAccountId);
  const roundtripOk = loaded === tokens.refreshToken;
  if (!roundtripOk) {
    persistentRefreshTokenCache.delete(normalizedAccountId);
    await deletePersistentCloudTokenSecure(normalizedAccountId).catch(() => null);
    logAuthLifecycle("secure token save end", {
      userId: shortUserId(normalizedAccountId),
      storageMode: mode,
      success: false,
      roundtrip: false,
    });
    return { storedSecurely: false, fallbackUsed: true, roundtrip: false, secureStorageAvailable: true };
  }
  persistentRefreshTokenCache.set(normalizedAccountId, tokens.refreshToken);
  logAuthLifecycle("secure token save end", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: true,
    storageMode: mode,
    success: true,
    roundtrip: true,
  });
  return { storedSecurely: true, fallbackUsed: false, roundtrip: true, secureStorageAvailable: true };
}

export async function loadCloudToken(accountId: string) {
  const normalizedAccountId = normalizePersistentAccountId(accountId);
  if (persistentRefreshTokenCache.has(normalizedAccountId)) {
    logAuthLifecycle("secure token load cache hit", {
      userId: shortUserId(normalizedAccountId),
      tokenFound: true,
      tokenSource: "secure",
      secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    });
    return persistentRefreshTokenCache.get(normalizedAccountId) || null;
  }
  if (!canUseSecurePersistentTokenStorage()) {
    logAuthLifecycle("secure token load skipped", {
      userId: shortUserId(normalizedAccountId),
      secureStorageAvailable: false,
    });
    return null;
  }
  logAuthLifecycle("secure token load start", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: true,
  });
  const token = await loadPersistentCloudTokenSecure(normalizedAccountId);
  logAuthLifecycle("secure token load end", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: true,
    tokenFound: Boolean(token),
    tokenSource: token ? "secure" : "missing",
  });
  if (token) persistentRefreshTokenCache.set(normalizedAccountId, token);
  return token;
}

export async function deleteCloudToken(accountId: string) {
  const normalizedAccountId = normalizePersistentAccountId(accountId);
  logAuthLifecycle("secure token delete start", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: canUseSecurePersistentTokenStorage(),
  });
  persistentRefreshTokenCache.delete(normalizedAccountId);
  setRuntimeAccessToken(normalizedAccountId, null);
  if (!canUseSecurePersistentTokenStorage()) return;
  await deletePersistentCloudTokenSecure(normalizedAccountId);
  logAuthLifecycle("secure token delete end", {
    userId: shortUserId(normalizedAccountId),
    secureStorageAvailable: true,
    success: true,
  });
}

async function resolveCloudSessionForAccount(account: StoredCloudAccount | null): Promise<{ session: StoredCloudSession | null; tokenSource: CloudTokenSource }> {
  if (!account) return { session: null, tokenSource: "missing" };
  const runtime = mergeTokenIntoAccount(account);
  if (runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt)) return { session: runtime, tokenSource: account.storage === "session" ? "session" : "session" };
  const refreshed = await getValidAccessToken(account.user.id);
  if (!refreshed) return { session: null, tokenSource: account.storage === "persistent" ? "missing" : "missing" };
  return { session: refreshed, tokenSource: account.storage === "persistent" ? "secure" : "session" };
}

async function refreshAccessTokenForAccount(account: StoredCloudAccount): Promise<StoredCloudSession | null> {
  if (account.storage !== "persistent") return mergeTokenIntoAccount(account);
  const refreshToken = await loadCloudToken(account.user.id);
  if (!refreshToken) {
    logAuthLifecycle("refresh skipped", {
      userId: shortUserId(account.user.id),
      storageMode: account.storage,
      tokenSource: "missing",
      secureStorageAvailable: canUseSecurePersistentTokenStorage(),
    });
    return null;
  }
  logAuthLifecycle("refresh start", {
    userId: shortUserId(account.user.id),
    storageMode: account.storage,
    tokenSource: "secure",
  });
  try {
    const response = await cloudAuth.refresh(refreshToken);
    const runtime = buildRuntimeToken(response);
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
    const updatedAccount: StoredCloudAccount = {
      ...account,
      user: response.user,
      lastUsedAt: nowIso(),
      storage: secureResult.storedSecurely ? "persistent" : "session",
    };
    const state = getStoredAuthState();
    saveStoredAuthState(
      {
        activeOwnerId: state.activeOwnerId === account.user.id ? account.user.id : state.activeOwnerId,
        accounts: [updatedAccount, ...state.accounts.filter((item) => item.user.id !== account.user.id)],
      },
      { notify: false },
    );
    logAuthLifecycle("refresh end", {
      userId: shortUserId(account.user.id),
      success: true,
      storageMode: updatedAccount.storage,
    });
    return { ...updatedAccount, token: runtime.accessToken, tokenType: runtime.tokenType, expiresAt: runtime.expiresAt };
  } catch (error) {
    logAuthLifecycle("refresh end", {
      userId: shortUserId(account.user.id),
      success: false,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    setRuntimeAccessToken(account.user.id, null);
    if (error instanceof CloudAuthRequestError && error.kind === "auth") {
      await deleteCloudToken(account.user.id).catch(() => null);
    }
    return null;
  }
}

export async function getValidAccessToken(ownerId?: string): Promise<StoredCloudSession | null> {
  const state = getStoredAuthState();
  const account =
    ownerId && ownerId !== LOCAL_OWNER_ID
      ? state.accounts.find((item) => item.user.id === ownerId) || null
      : getActiveAccount();
  if (!account) return null;
  const runtime = mergeTokenIntoAccount(account);
  if (runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt)) return runtime;
  if (account.storage === "session") {
    if (runtime && !isTokenExpiredOrNearExpiry(runtime.expiresAt, 0)) return runtime;
    setRuntimeAccessToken(account.user.id, null);
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
  return activeRefreshPromises.get(account.user.id) || null;
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
      requiresRelogin: false,
    };
  }
  const { session, tokenSource } = await resolveCloudSessionForAccount(account);
  const availability: CloudSessionAvailability = session
    ? "active"
    : account.storage === "persistent"
      ? "saved_without_token"
      : "session_expired";
  logAuthLifecycle("active cloud auth state", {
    userId: shortUserId(account.user.id),
    storageMode: account.storage,
    tokenSource,
    secureStorageAvailable,
    availability,
  });
  return {
    ownerId,
    account,
    session,
    availability,
    tokenSource,
    secureStorageAvailable,
    requiresRelogin: !session,
  };
}

export async function addOrUpdateAccount(session: { user: CloudUser; tokens: CloudAuthTokens }, options: { remember?: boolean; makeActive?: boolean; notify?: boolean } = {}) {
  const state = getStoredAuthState();
  const requestedStorage: "persistent" | "session" = options.remember === false ? "session" : "persistent";
  const existing = state.accounts.find((account) => account.user.id === session.user.id);
  const secureResult = await saveCloudToken(session.user.id, session.tokens, requestedStorage);
  const storage: "persistent" | "session" =
    requestedStorage === "persistent" && !secureResult.storedSecurely ? "session" : requestedStorage;
  const account: StoredCloudAccount = {
    user: session.user,
    storage,
    addedAt: existing?.addedAt || nowIso(),
    lastUsedAt: nowIso(),
  };
  const accounts = [account, ...state.accounts.filter((item) => item.user.id !== session.user.id)];
  saveStoredAuthState({ activeOwnerId: options.makeActive === false ? state.activeOwnerId : session.user.id, accounts }, { notify: options.notify });
  console.info("[auth] account stored", {
    userId: shortUserId(session.user.id),
    email: maskEmail(session.user.email),
    storage,
    requestedStorage,
    secure: requestedStorage === "persistent" ? secureResult.storedSecurely : false,
    fallbackUsed: secureResult.fallbackUsed,
    roundtrip: secureResult.roundtrip,
    savedMetadata: true,
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

export function removeAccount(ownerId: string) {
  const state = getStoredAuthState();
  const accounts = state.accounts.filter((account) => account.user.id !== ownerId);
  const activeOwnerId = state.activeOwnerId === ownerId ? LOCAL_OWNER_ID : state.activeOwnerId;
  saveStoredAuthState({ activeOwnerId, accounts });
  void deleteCloudToken(ownerId);
}

export async function logoutAccount(ownerId: string) {
  const state = getStoredAuthState();
  const account = state.accounts.find((item) => item.user.id === ownerId) || null;
  if (!account) return;
  const refreshToken = account.storage === "persistent" ? await loadCloudToken(ownerId) : null;
  await cloudAuth.logout(refreshToken);
  removeAccount(ownerId);
}

export function clearAllAccounts() {
  const state = getStoredAuthState();
  for (const account of state.accounts) void deleteCloudToken(account.user.id);
  saveStoredAuthState(emptyAuthState());
}

export function clearActiveAccountSession() {
  const active = getActiveOwnerId();
  if (active === LOCAL_OWNER_ID) switchToLocalMode();
  else removeAccount(active);
}

export function clearStoredSession() {
  clearActiveAccountSession();
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

export function clearStoredToken() {
  clearActiveAccountSession();
}

export const getCloudToken = getStoredToken;
export const saveCloudTokenForActiveAccount = (token: string) => setStoredToken(token, DEFAULT_REMEMBER_CLOUD_ACCOUNT);
export const clearCloudToken = clearStoredToken;

export function subscribeAuthChanges(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, listener);
}

async function cloudRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!isCloudAuthConfigured()) throw new CloudAuthRequestError("El servicio de cuenta no está configurado en este entorno.", { kind: "unknown" });
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_AUTH_TIMEOUT_MS);
  try {
    response = await fetch(`${CLOUD_API_URL}${path}`, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (error) {
    console.error("Cloud auth request failed", { path, errorType: error instanceof Error ? error.name : typeof error });
    const isTimeout = error instanceof DOMException && error.name === "AbortError";
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
    if (response.status === 401 || response.status === 403) {
      throw new CloudAuthRequestError("Sesión inválida o vencida.", { statusCode: response.status, kind: "auth" });
    }
    throw new CloudAuthRequestError(typeof body?.detail === "string" ? body.detail : "No se pudo completar la acción.", {
      statusCode: response.status,
      kind: response.status >= 500 ? "server" : "unknown",
    });
  }
  return response.json() as Promise<T>;
}

export const cloudAuth = {
  register: (input: { email: string; password: string; display_name?: string | null }) =>
    cloudRequest<CloudAuthResponse>("/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    cloudRequest<CloudAuthResponse>("/auth/login", { method: "POST", body: JSON.stringify(input) }),
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
  googleStatus: (loginRequestId: string) =>
    cloudRequest<
      | { status: "pending" }
      | { status: "expired" | "error" | "consumed"; message?: string }
      | ({ status: "completed" } & CloudAuthResponse)
    >(`/auth/google/status/${encodeURIComponent(loginRequestId)}`, { method: "GET" }),
};

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
  console.info("[auth] verify start", { userId: shortUserId(session.user.id), email: maskEmail(session.user.email) });
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
    console.info("[auth] verify success", { userId: shortUserId(user.id), email: maskEmail(user.email) });
    return { ...session, user };
  } catch (error) {
    console.warn("[auth] verify failed", { errorType: error instanceof Error ? error.name : typeof error });
    if (error instanceof CloudAuthRequestError && error.kind === "auth") {
      setRuntimeAccessToken(session.user.id, null);
      if (session.storage === "persistent") {
        await deleteCloudToken(session.user.id).catch(() => null);
      } else {
        removeAccount(session.user.id);
      }
    }
    throw error;
  }
}
