import { getRuntimePlatformSync } from "./platform";

export const DESKTOP_AUTH_EVENTS = ["storage_availability", "save_start", "save_end", "load_start", "load_end", "delete_start", "delete_end", "hydration_start", "hydration_account", "hydration_end", "refresh_start", "refresh_end", "auth_state"] as const;
export const DESKTOP_AUTH_CODES = ["none", "unknown_error", "supabase_not_configured", "wincred_no_logon_session", "wincred_access_denied", "wincred_storage_failed", "supabase_secure_storage_failed", "supabase_secure_unavailable", "secure_refresh_load_failed", "secure_refresh_save_failed", "refresh_token_missing", "refresh_rejected", "network_error", "device_revoked", "device_verification_required", "device_proof_invalid", "internal_identity_mismatch", "account_deleted"] as const;
type Metadata = {
  ownerId?: string; project_tag?: string; secureStorageAvailable?: boolean; found?: boolean; success?: boolean;
  persistentAccounts?: number; duration_ms?: number; refreshTokenFound?: boolean; refreshSuccess?: boolean;
  rotatedRefresh?: boolean; rotatedSaveSuccess?: boolean; persistentStorageError?: boolean;
  errorCode?: string | null; lastAuthErrorCode?: string | null; availability?: string; persistenceStatus?: string;
  reason?: string;
  phase?: "load" | "refresh" | "save" | "device";
};
export function isDesktopAuthRuntime() { return typeof window !== "undefined" && getRuntimePlatformSync() === "desktop"; }
export function safeDesktopAuthCode(code?: string | null) { return DESKTOP_AUTH_CODES.includes(code as typeof DESKTOP_AUTH_CODES[number]) ? code! : "unknown_error"; }

// Both JS and native boundaries filter by schema. Never serialize an exception,
// a token, a native command result, or caller-supplied arbitrary string.
export function logDesktopAuthDiagnostic(event: typeof DESKTOP_AUTH_EVENTS[number], metadata: Metadata = {}) {
  if (!isDesktopAuthRuntime() || !DESKTOP_AUTH_EVENTS.includes(event)) return;
  const row: Record<string, string | number | boolean> = { event, platform: "desktop", namespace: "supabase_refresh_v1" };
  if (typeof metadata.ownerId === "string" && /^[A-Za-z0-9_-]{7,120}$/.test(metadata.ownerId)) row.owner_tag = metadata.ownerId.slice(0, 6) + "...";
  if (typeof metadata.project_tag === "string" && /^[a-f0-9]{12}$/.test(metadata.project_tag)) row.project_tag = metadata.project_tag;
  for (const key of ["secureStorageAvailable", "found", "success", "refreshTokenFound", "refreshSuccess", "rotatedRefresh", "rotatedSaveSuccess", "persistentStorageError"] as const) {
    if (typeof metadata[key] === "boolean") row[key] = metadata[key]!;
  }
  for (const key of ["duration_ms", "persistentAccounts"] as const) {
    const value = metadata[key]; if (Number.isInteger(value) && value! >= 0 && value! <= 86400000) row[key] = value!;
  }
  for (const key of ["errorCode", "lastAuthErrorCode"] as const) if (metadata[key] !== undefined) row[key] = safeDesktopAuthCode(metadata[key] || "none");
  if (["active", "local", "none", "saved_without_token", "session_expired", "refresh_failed", "unknown_error", "auth_error"].includes(metadata.availability || "")) row.availability = metadata.availability!;
  if (["ok", "failed", "unknown"].includes(metadata.persistenceStatus || "")) row.persistenceStatus = metadata.persistenceStatus!;
  if (["temporary_login", "logout_or_remove", "auth_rejected"].includes(metadata.reason || "")) row.reason = metadata.reason!;
  if (["load", "refresh", "save", "device"].includes(metadata.phase || "")) row.phase = metadata.phase!;
  console.info("[auth]", JSON.stringify(row));
  // Diagnostic delivery never decides whether authentication/storage succeeds.
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("log_desktop_auth_diagnostic", { payload: row })).catch(() => {});
}
