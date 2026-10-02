import { getSupabaseProjectUrl } from "../lib/supabase";
import { CloudAuthRequestError } from "./cloudAuth";
const operations = new Map<string, Promise<unknown>>();

export function isSupabaseSecureStorageAvailable() {
  if (typeof window === "undefined") return false;
  const runtime = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown; isTauri?: boolean };
  return Boolean(runtime.__TAURI_INTERNALS__ || runtime.__TAURI__ || runtime.isTauri);
}

async function storageKey(ownerId: string) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(ownerId) || ownerId === "local") {
    throw new CloudAuthRequestError("La cuenta interna no es válida.", { code: "internal_identity_invalid", kind: "auth" });
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(getSupabaseProjectUrl()));
  const project = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${project}::${ownerId}`;
}

async function invokeCommand<T>(name: string, ownerId: string, extra = {}): Promise<T> {
  if (!isSupabaseSecureStorageAvailable()) throw new CloudAuthRequestError(
    "El almacenamiento seguro requiere la app de escritorio. Usá una sesión temporal.", { code: "supabase_secure_unavailable" });
  try {
    const accountId = await storageKey(ownerId);
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(name, { accountId, ...extra });
  } catch (error) {
    if (error instanceof CloudAuthRequestError) throw error;
    throw new CloudAuthRequestError("No pudimos acceder al almacenamiento seguro. Intentá nuevamente.", { code: "supabase_secure_storage_failed" });
  }
}

function command<T>(name: string, ownerId: string, extra = {}): Promise<T> {
  // A delete waits for any pending save, so a late rotation cannot restore a
  // credential that was just removed. Each internal account has its own queue.
  const previous = operations.get(ownerId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => invokeCommand<T>(name, ownerId, extra));
  operations.set(ownerId, pending);
  void pending.finally(() => { if (operations.get(ownerId) === pending) operations.delete(ownerId); }).catch(() => {});
  return pending;
}

export async function saveSupabaseRefreshToken(ownerId: string, token: string) {
  const result = await command<{ ok: boolean; roundtrip: boolean }>("save_persistent_supabase_refresh_token", ownerId, { token });
  if (!result?.ok || !result.roundtrip) throw new CloudAuthRequestError(
    "No pudimos verificar el guardado seguro de la sesión.", { code: "supabase_secure_storage_failed" });
}

export async function loadSupabaseRefreshToken(ownerId: string): Promise<string | null> {
  const result = await command<{ found: boolean; token: string | null; error_code?: string | null }>("load_persistent_supabase_refresh_token", ownerId);
  if (result?.error_code) throw new CloudAuthRequestError("No pudimos leer la sesión guardada.", { code: "supabase_secure_storage_failed" });
  return result?.found && result.token ? result.token : null;
}

export async function deleteSupabaseRefreshToken(ownerId: string) {
  if (!isSupabaseSecureStorageAvailable()) return { ok: true };
  try {
    const result = await command<{ ok: boolean }>("delete_persistent_supabase_refresh_token", ownerId);
    return { ok: result?.ok === true };
  } catch { return { ok: false }; }
}
