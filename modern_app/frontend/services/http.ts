import { getActiveOwnerId } from "./cloudAuth";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const LOCAL_TOKEN_HEADER = "X-Scisonomics-Local-Token";
let cachedLocalApiToken: string | null = null;
let localApiTokenPromise: Promise<string | null> | null = null;

export type LocalRequestSecurity = {
  token_available: boolean;
  token_header_added: boolean;
  owner_header_added: boolean;
  running_in_tauri: boolean;
};

function isRunningInTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadLocalApiToken(): Promise<string | null> {
  if (cachedLocalApiToken) return cachedLocalApiToken;
  if (typeof window === "undefined") return null;
  if (!isRunningInTauri()) return null;
  if (localApiTokenPromise) return localApiTokenPromise;
  localApiTokenPromise = import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<string>("get_local_api_token"))
    .then((token) => {
      cachedLocalApiToken = typeof token === "string" && token.trim() ? token : null;
      return cachedLocalApiToken;
    })
    .catch(() => null)
    .finally(() => {
      localApiTokenPromise = null;
    });
  return localApiTokenPromise;
}

export function localOwnerHeaders(extra?: HeadersInit, ownerId?: string): HeadersInit {
  const headers: Record<string, string> = {
    ...((extra as Record<string, string>) || {}),
    "X-Scisonomics-Owner-Id": ownerId || getActiveOwnerId(),
  };
  if (cachedLocalApiToken) headers[LOCAL_TOKEN_HEADER] = cachedLocalApiToken;
  return headers;
}

export async function getLocalRequestHeaders(extra?: HeadersInit, ownerId?: string, requireToken = false): Promise<HeadersInit> {
  const token = await loadLocalApiToken();
  if (requireToken && !token) {
    throw new Error(isRunningInTauri()
      ? "No se pudo autenticar contra el servicio local."
      : "El servicio local protegido solo está disponible dentro de la app de escritorio.");
  }
  const headers: Record<string, string> = {
    ...((extra as Record<string, string>) || {}),
    "X-Scisonomics-Owner-Id": ownerId || getActiveOwnerId(),
  };
  if (token) headers[LOCAL_TOKEN_HEADER] = token;
  return headers;
}

export async function getLocalRequestSecurity(extra?: HeadersInit, ownerId?: string, requireToken = false): Promise<{ headers: HeadersInit; security: LocalRequestSecurity }> {
  const headers = await getLocalRequestHeaders(extra, ownerId, requireToken);
  const normalized = headers as Record<string, string>;
  return {
    headers,
    security: {
      token_available: Boolean(cachedLocalApiToken),
      token_header_added: Boolean(normalized[LOCAL_TOKEN_HEADER]),
      owner_header_added: Boolean(normalized["X-Scisonomics-Owner-Id"]),
      running_in_tauri: isRunningInTauri(),
    },
  };
}

export function getLocalRequestSecuritySnapshot(ownerId?: string): LocalRequestSecurity {
  return {
    token_available: Boolean(cachedLocalApiToken),
    token_header_added: Boolean(cachedLocalApiToken),
    owner_header_added: Boolean(ownerId || getActiveOwnerId()),
    running_in_tauri: isRunningInTauri(),
  };
}

function toConnectionError(error: unknown) {
  console.error("HTTP request could not reach local API", error);
  return new Error("No se pudo conectar con ScisoNomics. Intentá nuevamente.");
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    console.error("HTTP request failed", { endpoint: new URL(res.url).pathname, status: res.status });
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {}

    if (res.status === 401 || res.status === 403) throw new Error("No se pudo validar la conexión local de ScisoNomics. Cerrá la app y volvé a abrirla.");
    if (res.status === 402) {
      const detail = parsed?.detail;
      const premiumMessage = typeof detail?.message === "string"
        ? detail.message
        : typeof parsed?.message === "string"
          ? parsed.message
          : "";
      throw new Error(premiumMessage.trim() || "Esta función está disponible en ScisoNomics Premium.");
    }
    if (res.status === 404) throw new Error("No se pudo encontrar la información solicitada.");
    if (res.status === 422) {
      const detail = Array.isArray(parsed?.detail) ? parsed.detail[0] : parsed?.detail;
      const msg = typeof detail?.msg === "string" ? detail.msg : "";
      const detailText = typeof detail === "string" ? detail : "";
      const combined = `${msg} ${detailText}`.toLowerCase();
      if (combined.includes("greater than 0") || combined.includes("mayor a 0")) throw new Error("Ingresá un monto mayor a 0.");
      throw new Error("Revisá los datos ingresados.");
    }
    if (res.status >= 500) throw new Error("Ocurrió un error inesperado.");

    const backendMessage = parsed?.detail || parsed?.message || text || `HTTP ${res.status}`;
    if (backendMessage && typeof backendMessage === "object" && typeof backendMessage.message === "string" && backendMessage.message.trim()) {
      throw new Error(backendMessage.message.trim());
    }
    if (typeof backendMessage === "string" && backendMessage.toLowerCase().includes("foreign key constraint failed")) {
      throw new Error("La categoría seleccionada no existe o no es válida. Volvé a seleccionar una categoría.");
    }
    if (typeof backendMessage === "string" && backendMessage.trim()) throw new Error(backendMessage.trim());
    throw new Error("No se pudo completar la operación.");
  }
  return (await res.json()) as T;
}

export async function getJSON<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", headers: await getLocalRequestHeaders() });
  } catch (error) {
    throw toConnectionError(error);
  }
  return parse<T>(res);
}

export async function sendJSON<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: await getLocalRequestHeaders({ "Content-Type": "application/json" }),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw toConnectionError(error);
  }
  return parse<T>(res);
}
