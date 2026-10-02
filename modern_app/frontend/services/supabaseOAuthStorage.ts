import { getSupabaseProjectUrl } from "../lib/supabase";
import { CloudAuthRequestError } from "./cloudAuth";
import { GOOGLE_OAUTH_TTL_MS, GOOGLE_PKCE_STORAGE_KEY } from "./supabaseOAuthCallback";

export type PendingGoogleOAuth = { expiresAt: number; remember: boolean; storageKey: string; storage: Record<string, string> };
let operations: Promise<unknown> = Promise.resolve();

function storageFailure() {
  return new CloudAuthRequestError("No pudimos acceder al estado seguro de Google. Volvé a intentar.", { code: "supabase_oauth_storage_failed" });
}

async function command<T>(name: string, extra = {}): Promise<T> {
  const pending = operations.catch(() => {}).then(async () => {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(getSupabaseProjectUrl()));
      const projectId = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<T>(name, { projectId, ...extra });
    } catch { throw storageFailure(); }
  });
  operations = pending;
  return pending;
}

export async function savePendingGoogleOAuth(value: PendingGoogleOAuth) {
  if (await command<boolean>("save_pending_supabase_oauth", { payload: JSON.stringify(value) }) !== true) throw storageFailure();
}

export async function deletePendingGoogleOAuth() {
  await command<void>("delete_pending_supabase_oauth");
}

export async function loadPendingGoogleOAuth(): Promise<PendingGoogleOAuth | null> {
  const payload = await command<string | null>("load_pending_supabase_oauth");
  if (!payload) return null;
  let value: PendingGoogleOAuth;
  try {
    value = JSON.parse(payload);
    if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
      || value.expiresAt > Date.now() + GOOGLE_OAUTH_TTL_MS + 5000 || typeof value.remember !== "boolean"
      || typeof value.storageKey !== "string" || !new RegExp(`^${GOOGLE_PKCE_STORAGE_KEY}-[a-f0-9-]{36}$`).test(value.storageKey)
      || !value.storage || Object.keys(value.storage).length === 0 || Object.keys(value.storage).length > 4
      || !Object.entries(value.storage).every(([key, item]) => key.startsWith(`${value.storageKey}-`)
        && key.endsWith("-code-verifier") && typeof item === "string" && item.length <= 512)) throw storageFailure();
  } catch {
    await deletePendingGoogleOAuth();
    return null;
  }
  return value;
}
