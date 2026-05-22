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

const TOKEN_KEY = "scisonomics_cloud_access_token";
const USER_KEY = "scisonomics_cloud_user";
export const ACCOUNT_SESSION_CHANGED_EVENT = "scisonomics:account-session-changed";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");

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

export function getCurrentOwnerId() {
  return getStoredUser()?.id || "local";
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

export function setStoredSession(token: string, user: CloudUser, remember: boolean) {
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
    notifyAccountSessionChanged();
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

export function clearStoredToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.sessionStorage.removeItem(USER_KEY);
    notifyAccountSessionChanged();
  } catch {
    // La cuenta opcional no debe bloquear el uso local de la app.
  }
}

export const getCloudToken = getStoredToken;
export const saveCloudToken = (token: string) => setStoredToken(token, true);
export const clearCloudToken = clearStoredToken;

async function cloudRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!isCloudAuthConfigured()) {
    throw new Error("El servicio de cuenta no esta configurado en este entorno.");
  }

  let response: Response;
  try {
    response = await fetch(`${CLOUD_API_URL}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    console.error("Cloud auth request failed", { path, error });
    throw new Error("No se pudo conectar con el servicio de cuenta.");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
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
    clearStoredToken();
  },

  googleStart: () => cloudRequest<{ configured: boolean; authorization_url?: string; message?: string }>("/auth/google/start"),
};
