import { getSupabaseProjectUrl } from "../lib/supabase";
import { CloudAuthRequestError } from "./cloudAuth";
import { getRuntimePlatformSync } from "./platform";
import { getSecureTokenStorage } from "./secureTokenStorage";
import { GOOGLE_OAUTH_TTL_MS, GOOGLE_PKCE_STORAGE_KEY } from "./supabaseOAuthCallback";
import type { GoogleOAuthTrace } from "./googleOAuthDiagnostics";

export type PendingGoogleOAuth = { expiresAt: number; remember: boolean; storageKey: string; storage: Record<string, string> };
let operations: Promise<unknown> = Promise.resolve();

function storageFailure() {
  return new CloudAuthRequestError("No pudimos acceder al estado seguro de Google. Volvé a intentar.", { code: "supabase_oauth_storage_failed" });
}

async function command<T>(name: string, extra: { payload?: string } = {}): Promise<T> {
  const pending = operations.catch(() => {}).then(async () => {
    try {
      const android = getRuntimePlatformSync() === "android";
      // Separate namespace from refresh tokens; desktop retains its WinCred key.
      const scope = (android ? "oauth-pkce:" : "") + getSupabaseProjectUrl();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
      const projectId = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      if (android) {
        const storage = getSecureTokenStorage();
        const accountId = `${projectId}::pending_google`;
        if (name.startsWith("save_")) {
          // Native token slots reject whitespace. Encoding is not encryption:
          // Keystore AES-GCM protects this entire payload on disk.
          const bytes = new TextEncoder().encode(extra.payload!);
          const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const result = await storage.save(accountId, encoded);
          if (!result.ok || !result.roundtrip) throw storageFailure();
          return true as T;
        }
        if (name.startsWith("delete_")) {
          if (!(await storage.delete(accountId)).ok) throw storageFailure();
          return undefined as T;
        }
        const result = await storage.load(accountId);
        if (result.error_code) throw storageFailure();
        if (!result.found) return null as T;
        if (!result.token) throw storageFailure();
        const bytes = Uint8Array.from(atob(result.token.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes) as T;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<T>(name, { projectId, ...extra });
    } catch { throw storageFailure(); }
  });
  operations = pending;
  return pending;
}

export async function savePendingGoogleOAuth(value: PendingGoogleOAuth) {
  validatePending(value);
  if (await command<boolean>("save_pending_supabase_oauth", { payload: JSON.stringify(value) }) !== true) throw storageFailure();
}

export async function deletePendingGoogleOAuth() {
  await command<void>("delete_pending_supabase_oauth");
}

export async function loadPendingGoogleOAuth(trace?: GoogleOAuthTrace, expiredInMemory = false): Promise<PendingGoogleOAuth | null> {
  const load = () => command<string | null>("load_pending_supabase_oauth");
  const payload = trace ? await trace.step("oauth_pending_invalid", load) : await load();
  if (!payload) { trace?.fail(expiredInMemory ? "oauth_pending_expired" : "oauth_pending_missing"); return null; }
  let value: PendingGoogleOAuth;
  try {
    value = JSON.parse(payload);
    validatePending(value, false);
  } catch {
    trace?.fail("oauth_pending_invalid");
    const remove = () => deletePendingGoogleOAuth();
    if (trace) await trace.step("oauth_pending_delete_failed", remove); else await remove();
    return null;
  }
  if (value.expiresAt <= Date.now()) {
    trace?.fail("oauth_pending_expired");
    const remove = () => deletePendingGoogleOAuth();
    if (trace) await trace.step("oauth_pending_delete_failed", remove); else await remove();
    return null;
  }
  return value;
}

function validatePending(value: PendingGoogleOAuth, checkExpiry = true) {
  if (!value || !Number.isFinite(value.expiresAt) || (checkExpiry && value.expiresAt <= Date.now())
    || value.expiresAt > Date.now() + GOOGLE_OAUTH_TTL_MS + 5000 || typeof value.remember !== "boolean"
    || Object.keys(value).some((key) => !["expiresAt", "remember", "storageKey", "storage"].includes(key))
    || typeof value.storageKey !== "string" || !new RegExp(`^${GOOGLE_PKCE_STORAGE_KEY}-[a-f0-9-]{36}$`).test(value.storageKey)
    || !value.storage || Object.keys(value.storage).length === 0 || Object.keys(value.storage).length > 4
    || !Object.entries(value.storage).every(([key, item]) => key.startsWith(`${value.storageKey}-`)
      && key.endsWith("-code-verifier") && typeof item === "string" && item.length > 0 && item.length <= 512)
    || JSON.stringify(value).length > 3000) throw storageFailure();
}
