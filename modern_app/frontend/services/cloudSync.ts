import { API_URL } from "./http";

const LAST_SYNC_KEY = "scisonomics_last_manual_sync_at";
const CLOUD_API_URL = (process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL || "").replace(/\/$/, "");
const LOG_PREFIX = "[manual-sync]";

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

function setLastManualSyncAt(value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SYNC_KEY, value);
  } catch {
    // La fecha de sync no debe bloquear la sincronizacion.
  }
}

export async function getLocalPending() {
  return localGet<{ ok: boolean; categorias: unknown[]; movimientos: unknown[] }>("/sync/pending");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export async function runManualSync(token: string, userEmail?: string) {
  if (!token) throw new Error("Inicia sesion para sincronizar.");
  if (!CLOUD_API_URL) throw new Error("El servicio cloud no esta configurado en este entorno.");

  console.info(`${LOG_PREFIX} start`, {
    cloudApiUrl: CLOUD_API_URL,
    hasToken: Boolean(token),
    user: userEmail || "usuario autenticado",
  });

  const pending = await getLocalPending();
  const pendingCategorias = pending.categorias.length;
  const pendingMovimientos = pending.movimientos.length;
  console.info(`${LOG_PREFIX} pending`, {
    user: userEmail || "usuario autenticado",
    categorias: pendingCategorias,
    movimientos: pendingMovimientos,
  });

  const pushResult = await cloudPost<{
    ok: boolean;
    accepted: { categorias: unknown; movimientos: unknown };
    ignored: { categorias: number; movimientos: number };
    counts?: {
      categorias_received: number;
      categorias_saved: number;
      movimientos_received: number;
      movimientos_saved: number;
    };
  }>("/sync/push", token, {
    categorias: pending.categorias,
    movimientos: pending.movimientos,
  });

  const accepted = {
    categorias: asStringArray(pushResult.accepted?.categorias),
    movimientos: asStringArray(pushResult.accepted?.movimientos),
  };
  const counts = pushResult.counts || {
    categorias_received: -1,
    categorias_saved: -1,
    movimientos_received: -1,
    movimientos_saved: -1,
  };
  console.info(`${LOG_PREFIX} push result`, {
    user: userEmail || "usuario autenticado",
    counts,
    acceptedCounts: { categorias: accepted.categorias.length, movimientos: accepted.movimientos.length },
  });

  if (!pushResult.ok) {
    throw new Error("No se pudo confirmar la sincronizacion con la nube. No se modifico el estado local.");
  }
  if (
    accepted.categorias.length !== pendingCategorias ||
    accepted.movimientos.length !== pendingMovimientos ||
    counts.categorias_received !== pendingCategorias ||
    counts.categorias_saved !== pendingCategorias ||
    counts.movimientos_received !== pendingMovimientos ||
    counts.movimientos_saved !== pendingMovimientos
  ) {
    console.error(`${LOG_PREFIX} cloud confirmation mismatch`, {
      pending: { categorias: pendingCategorias, movimientos: pendingMovimientos },
      accepted: { categorias: accepted.categorias.length, movimientos: accepted.movimientos.length },
      counts,
    });
    throw new Error("No se pudo confirmar la sincronizacion con la nube. No se modifico el estado local.");
  }

  let markSyncedExecuted = false;
  if (accepted.categorias.length || accepted.movimientos.length) {
    await localPost("/sync/mark-synced", accepted);
    markSyncedExecuted = true;
    console.info(`${LOG_PREFIX} mark-synced`, {
      executed: true,
      categorias: accepted.categorias.length,
      movimientos: accepted.movimientos.length,
    });
  }
  if (!markSyncedExecuted) {
    console.info(`${LOG_PREFIX} mark-synced`, { executed: false, categorias: 0, movimientos: 0 });
  }

  const remote = await cloudGet<{ ok: boolean; categorias: unknown[]; movimientos: unknown[] }>("/sync/pull", token);
  console.info(`${LOG_PREFIX} pull`, {
    categorias: remote.categorias.length,
    movimientos: remote.movimientos.length,
  });
  const applyResult = await localPost<{ ok: boolean; result: Record<string, number> }>("/sync/apply-remote", remote);
  console.info(`${LOG_PREFIX} apply-remote`, { result: applyResult.result });

  const syncedAt = new Date().toISOString();
  setLastManualSyncAt(syncedAt);

  return {
    syncedAt,
    uploaded: {
      categorias: accepted.categorias.length,
      movimientos: accepted.movimientos.length,
    },
    ignored: pushResult.ignored,
    applied: applyResult.result,
  };
}
