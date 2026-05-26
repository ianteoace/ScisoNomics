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

export type StoredCloudSession = {
  token: string;
  user: CloudUser;
  storage: "persistent" | "session";
};

const TOKEN_KEY = "scisonomics_cloud_access_token";
const USER_KEY = "scisonomics_cloud_user";
export const ACCOUNT_SESSION_CHANGED_EVENT = "scisonomics:account-session-changed";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const CLOUD_AUTH_TIMEOUT_MS = 10000;

function notifyAccountSessionChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(ACCOUNT_SESSION_CHANGED_EVENT));
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

export function isCloudAuthConfigured() {
  return CLOUD_API_URL.length > 0;
}

export function getStoredToken() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): CloudUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY) || window.sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as CloudUser) : null;
  } catch {
    return null;
  }
}

export function getTokenStorageMode(): "persistent" | "session" | null {
  if (typeof window === "undefined") return null;
  try {
    if (window.localStorage.getItem(TOKEN_KEY)) return "persistent";
    if (window.sessionStorage.getItem(TOKEN_KEY)) return "session";
  } catch {
    return null;
  }
  return null;
}

export function clearStoredSession(options: { notify?: boolean } = {}) {
  if (typeof window === "undefined") return;
  const notify = options.notify ?? true;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.sessionStorage.removeItem(USER_KEY);
    console.info("[auth] clear session");
    if (notify) notifyAccountSessionChanged();
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

export function getStoredSession(): StoredCloudSession | null {
  const token = getStoredToken();
  const user = getStoredUser();
  const storage = getTokenStorageMode();
  if (!token && !user) return null;
  if (!token || !user || !storage) {
    console.warn("[auth] stored session is incomplete; clearing local cloud session");
    clearStoredSession({ notify: false });
    return null;
  }
  return { token, user, storage };
}

export function getActiveOwnerId() {
  return getStoredSession()?.user.id || "local";
}

export const getCurrentOwnerId = getActiveOwnerId;

export function setStoredToken(token: string, remember: boolean) {
  if (typeof window === "undefined") return;
  try {
    // TODO: migrar este token a almacenamiento seguro antes de activar sincronizacion cloud real.
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    if (remember) {
      window.localStorage.setItem(TOKEN_KEY, token);
    } else {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    }
    notifyAccountSessionChanged();
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

export function setStoredSession(token: string, user: CloudUser, remember: boolean, notify = true) {
  if (typeof window === "undefined") return;
  try {
    // TODO: migrar este token a almacenamiento seguro antes de activar sincronizacion cloud real.
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.sessionStorage.removeItem(USER_KEY);
    const target = remember ? window.localStorage : window.sessionStorage;
    const other = remember ? window.sessionStorage : window.localStorage;
    other.removeItem(USER_KEY);
    if (remember) {
      window.localStorage.setItem(TOKEN_KEY, token);
    } else {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    }
    target.setItem(USER_KEY, JSON.stringify(user));
    console.info("[auth] stored session", { userId: user.id, email: user.email, storage: remember ? "persistent" : "session" });
    if (notify) notifyAccountSessionChanged();
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

export function clearStoredToken() {
  clearStoredSession();
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
  if (!isCloudAuthConfigured()) {
    throw new Error("El servicio de cuenta no esta configurado en este entorno.");
  }

  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_AUTH_TIMEOUT_MS);
  try {
    response = await fetch(`${CLOUD_API_URL}${path}`, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    console.error("Cloud auth request failed", { path, error });
    throw new Error(error instanceof DOMException && error.name === "AbortError" ? "No pudimos verificar la sesion. Podes volver a iniciar sesion." : "No se pudo conectar con el servicio de cuenta.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      console.error("Cloud auth session invalid", { path, status: response.status, body });
      throw new Error("Sesion invalida o vencida.");
    }
    const detail = typeof body?.detail === "string" ? body.detail : "No se pudo completar la accion.";
    console.error("Cloud auth HTTP error", { path, status: response.status, body });
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export const cloudAuth = {
  register: (input: { email: string; password: string; display_name?: string | null }) =>
    cloudRequest<CloudAuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  login: (input: { email: string; password: string }) =>
    cloudRequest<CloudAuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  me: (token: string) =>
    cloudRequest<CloudUser>("/auth/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),

  logout: async (token: string | null) => {
    if (token && isCloudAuthConfigured()) {
      await cloudRequest<{ ok: boolean }>("/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch((error) => {
        console.error("Cloud auth logout failed", error);
      });
    }
    clearStoredSession();
  },

  googleStart: () => cloudRequest<{ configured: boolean; authorization_url?: string; message?: string }>("/auth/google/start"),
};

export async function verifyStoredSession(): Promise<StoredCloudSession | null> {
  const session = getStoredSession();
  if (!session) return null;
  console.info("[auth] verify start");
  try {
    const user = await cloudAuth.me(session.token);
    setStoredSession(session.token, user, session.storage === "persistent", false);
    console.info("[auth] verify success", { userId: user.id, email: user.email });
    return { token: session.token, user, storage: session.storage };
  } catch (error) {
    console.warn("[auth] verify failed", error);
    clearStoredSession({ notify: true });
    throw error;
  }
}
