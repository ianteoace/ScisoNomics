export type CloudUser = {
  id: string;
  email: string;
  display_name?: string | null;
  created_at: string;
  updated_at: string;
};

export type CloudAuthResponse = {
  access_token: string;
  token_type: string;
  user: CloudUser;
};

export type StoredCloudAccount = {
  user: CloudUser;
  token: string;
  addedAt: string;
  lastUsedAt: string;
  storage: "persistent" | "session";
};

export type StoredAuthState = {
  activeOwnerId: string;
  accounts: StoredCloudAccount[];
};

export type StoredCloudSession = StoredCloudAccount;

const LOCAL_OWNER_ID = "local";
const AUTH_STATE_KEY = "scisonomics_cloud_accounts_v1";
const AUTH_STATE_SESSION_KEY = "scisonomics_cloud_accounts_session_v1";
const TOKEN_KEY = "scisonomics_cloud_access_token";
const USER_KEY = "scisonomics_cloud_user";
export const ACCOUNT_SESSION_CHANGED_EVENT = "scisonomics:account-session-changed";
export const OWNER_CHANGED_EVENT = "scisonomics:owner-changed";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const CLOUD_AUTH_TIMEOUT_MS = 10000;

function emptyAuthState(): StoredAuthState {
  return { activeOwnerId: LOCAL_OWNER_ID, accounts: [] };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value?: string | null) {
  return String(value || "").trim().toLowerCase();
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
    const parsed = JSON.parse(raw) as StoredAuthState;
    return {
      activeOwnerId: typeof parsed.activeOwnerId === "string" ? parsed.activeOwnerId : LOCAL_OWNER_ID,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter((account) => account?.token && account?.user?.id) : [],
    };
  } catch {
    return null;
  }
}

function writeJsonState(storage: Storage, key: string, state: StoredAuthState) {
  storage.setItem(key, JSON.stringify(state));
}

function removeLegacySessionKeys() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.sessionStorage.removeItem(USER_KEY);
  } catch {
    // La migracion de sesion no debe bloquear el uso local.
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

function accountTimeValue(value?: string) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function chooseAccountToKeep(current: StoredCloudAccount, incoming: StoredCloudAccount) {
  const currentAdded = accountTimeValue(current.addedAt);
  const incomingAdded = accountTimeValue(incoming.addedAt);
  if (currentAdded && incomingAdded && incomingAdded < currentAdded) return incoming;
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

function normalizeState(state: StoredAuthState): StoredAuthState {
  const byId = new Map<string, StoredCloudAccount>();
  const discardedOwnerMap = new Map<string, string>();
  for (const account of state.accounts) {
    if (!account?.user?.id || !account.token) continue;
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
      email: emailKey,
      keptUserId: keep.user.id,
      removedUserId: discard.user.id,
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
  const account: StoredCloudAccount = { token, user, storage, addedAt: nowIso(), lastUsedAt: nowIso() };
  saveSplitState({ activeOwnerId: user.id, accounts: [account] });
  removeLegacySessionKeys();
  console.info("[auth] migrated legacy single session", { userId: user.id, email: user.email, storage });
}

export function isCloudAuthConfigured() {
  return CLOUD_API_URL.length > 0;
}

export function getStoredAuthState(): StoredAuthState {
  if (typeof window === "undefined") return emptyAuthState();
  migrateLegacySessionIfNeeded();
  const localState = readJsonState(window.localStorage, AUTH_STATE_KEY) || emptyAuthState();
  const sessionState = readJsonState(window.sessionStorage, AUTH_STATE_SESSION_KEY) || emptyAuthState();
  const preferredActive = sessionState.activeOwnerId !== LOCAL_OWNER_ID ? sessionState.activeOwnerId : localState.activeOwnerId;
  const merged = normalizeState({ activeOwnerId: preferredActive, accounts: [...sessionState.accounts, ...localState.accounts] });
  const originalCount = (sessionState.accounts.length || 0) + (localState.accounts.length || 0);
  if (merged.activeOwnerId !== preferredActive || merged.accounts.length !== originalCount) saveSplitState(merged);
  return merged;
}

export function saveStoredAuthState(state: StoredAuthState, options: { notify?: boolean } = {}) {
  saveSplitState(normalizeState(state));
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
  return getActiveAccount();
}

export function getStoredSession(): StoredCloudSession | null {
  return getActiveCloudSession();
}

export function getStoredToken() {
  return getActiveCloudSession()?.token || null;
}

export function getStoredUser(): CloudUser | null {
  return getActiveCloudSession()?.user || null;
}

export function getTokenStorageMode(): "persistent" | "session" | null {
  return getActiveCloudSession()?.storage || null;
}

export function addOrUpdateAccount(session: { token: string; user: CloudUser }, options: { remember?: boolean; makeActive?: boolean; notify?: boolean } = {}) {
  const state = getStoredAuthState();
  const storage: "persistent" | "session" = options.remember === false ? "session" : "persistent";
  const existing = state.accounts.find((account) => account.user.id === session.user.id);
  const account: StoredCloudAccount = {
    token: session.token,
    user: session.user,
    storage,
    addedAt: existing?.addedAt || nowIso(),
    lastUsedAt: nowIso(),
  };
  const accounts = [account, ...state.accounts.filter((item) => item.user.id !== session.user.id)];
  saveStoredAuthState({ activeOwnerId: options.makeActive === false ? state.activeOwnerId : session.user.id, accounts }, { notify: options.notify });
  console.info("[auth] account stored", { userId: session.user.id, email: session.user.email, storage });
}

export function switchActiveOwner(ownerId: string) {
  const state = getStoredAuthState();
  const nextOwner = ownerId === LOCAL_OWNER_ID || state.accounts.some((account) => account.user.id === ownerId) ? ownerId : LOCAL_OWNER_ID;
  const accounts = state.accounts.map((account) => (account.user.id === nextOwner ? { ...account, lastUsedAt: nowIso() } : account));
  saveStoredAuthState({ activeOwnerId: nextOwner, accounts });
  console.info("[owner] active owner changed", { ownerId: nextOwner });
}

export function switchToLocalMode() {
  switchActiveOwner(LOCAL_OWNER_ID);
}

export function removeAccount(ownerId: string) {
  const state = getStoredAuthState();
  const accounts = state.accounts.filter((account) => account.user.id !== ownerId);
  const activeOwnerId = state.activeOwnerId === ownerId ? LOCAL_OWNER_ID : state.activeOwnerId;
  saveStoredAuthState({ activeOwnerId, accounts });
}

export function clearAllAccounts() {
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

export function setStoredSession(token: string, user: CloudUser, remember: boolean, notify = true) {
  addOrUpdateAccount({ token, user }, { remember, makeActive: true, notify });
}

export function setStoredToken(token: string, remember: boolean) {
  const active = getActiveAccount();
  if (active) addOrUpdateAccount({ token, user: active.user }, { remember, makeActive: true });
}

export function clearStoredToken() {
  clearActiveAccountSession();
}

export const getCloudToken = getStoredToken;
export const saveCloudToken = (token: string) => setStoredToken(token, true);
export const clearCloudToken = clearStoredToken;

export function subscribeAuthChanges(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, listener);
}

async function cloudRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!isCloudAuthConfigured()) throw new Error("El servicio de cuenta no esta configurado en este entorno.");
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
    console.error("Cloud auth request failed", { path, error });
    throw new Error(error instanceof DOMException && error.name === "AbortError" ? "No pudimos verificar la sesion. Podes volver a iniciar sesion." : "No se pudo conectar con el servicio de cuenta.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw new Error("Sesion invalida o vencida.");
    throw new Error(typeof body?.detail === "string" ? body.detail : "No se pudo completar la accion.");
  }
  return response.json() as Promise<T>;
}

export const cloudAuth = {
  register: (input: { email: string; password: string; display_name?: string | null }) =>
    cloudRequest<CloudAuthResponse>("/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    cloudRequest<CloudAuthResponse>("/auth/login", { method: "POST", body: JSON.stringify(input) }),
  me: (token: string) =>
    cloudRequest<CloudUser>("/auth/me", { method: "GET", headers: { Authorization: `Bearer ${token}` } }),
  logout: async (token: string | null) => {
    if (token && isCloudAuthConfigured()) {
      await cloudRequest<{ ok: boolean }>("/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch((error) => {
        console.error("Cloud auth logout failed", error);
      });
    }
  },
  googleStart: () =>
    cloudRequest<{ configured: boolean; login_request_id: string; auth_url: string }>("/auth/google/start", { method: "POST" }),
  googleStatus: (loginRequestId: string) =>
    cloudRequest<
      | { status: "pending" }
      | { status: "expired" | "error"; message?: string }
      | { status: "completed"; access_token: string; user: CloudUser }
    >(`/auth/google/status/${encodeURIComponent(loginRequestId)}`, { method: "GET" }),
};

export async function verifyStoredSession(ownerId?: string): Promise<StoredCloudSession | null> {
  const state = getStoredAuthState();
  const session = ownerId ? state.accounts.find((account) => account.user.id === ownerId) || null : getActiveCloudSession();
  if (!session) return null;
  console.info("[auth] verify start", { userId: session.user.id, email: session.user.email });
  try {
    const user = await cloudAuth.me(session.token);
    addOrUpdateAccount({ token: session.token, user }, { remember: session.storage === "persistent", makeActive: state.activeOwnerId === session.user.id, notify: false });
    console.info("[auth] verify success", { userId: user.id, email: user.email });
    return { ...session, user };
  } catch (error) {
    console.warn("[auth] verify failed", error);
    removeAccount(session.user.id);
    throw error;
  }
}
