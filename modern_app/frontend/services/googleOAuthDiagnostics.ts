import { getRuntimePlatformSync } from "./platform";
import { isAuthApiError } from "@supabase/supabase-js";

export const GOOGLE_OAUTH_FAILURE_EVENTS = [
  "oauth_callback_invalid", "oauth_pending_missing", "oauth_pending_expired", "oauth_pending_invalid",
  "oauth_pending_delete_failed", "oauth_exchange_failed", "oauth_session_invalid", "oauth_bootstrap_failed",
  "oauth_device_auth_failed", "oauth_session_store_failed",
] as const;
export const GOOGLE_OAUTH_DIAGNOSTIC_EVENTS = GOOGLE_OAUTH_FAILURE_EVENTS;
export type GoogleOAuthDiagnosticEvent = typeof GOOGLE_OAUTH_DIAGNOSTIC_EVENTS[number];
export type GoogleOAuthDiagnosticContext = { mode: "warm" | "cold"; origin: "onOpenUrl" | "getCurrent" };
type Metadata = GoogleOAuthDiagnosticContext & { durationMs?: number; httpStatus?: number; errorCode?: string; authErrorCode?: string };
export const GOOGLE_OAUTH_AUTH_ERROR_CODES = [
  "bad_code_verifier", "bad_oauth_callback", "bad_oauth_state", "bad_jwt",
  "invalid_credentials", "validation_failed", "unexpected_failure", "flow_state_expired", "flow_state_not_found",
] as const;
const authCodes = new Set<string>(GOOGLE_OAUTH_AUTH_ERROR_CODES);
const authErrors = new WeakMap<object, { status: number; code: string }>();
function authApiDiagnostic(error: unknown) {
  if (!isAuthApiError(error)) return undefined;
  return { status: error.status, code: typeof error.code === "string" && authCodes.has(error.code) ? error.code : "other" };
}
// Preserve only public, allowlisted diagnostics when the friendly error is
// mapped. Never retain the SDK exception, response, message or raw unknown code.
export function retainGoogleOAuthAuthError(mapped: object, original: unknown) {
  try { const value = authApiDiagnostic(original); if (value) authErrors.set(mapped, value); } catch { /* Diagnostics only. */ }
}
const failures = new Set<string>(GOOGLE_OAUTH_FAILURE_EVENTS);
const errors = new Set([
  "unknown", "pkce_verifier_missing", "pkce_verifier_mismatch", "flow_state_expired", "flow_state_not_found",
  "invalid_grant", "invalid_credentials", "over_request_rate_limit", "supabase_auth_failed",
  "supabase_oauth_storage_failed", "supabase_secure_storage_failed", "supabase_secure_unavailable",
  "supabase_not_configured", "supabase_session_missing", "identity_unconfirmed",
  "internal_account_required", "internal_identity_invalid", "internal_identity_mismatch", "account_deleted",
  "auth_provider_conflict", "device_storage_failed", "device_storage_unavailable", "device_revoked",
  "device_verification_unavailable", "device_verification_required", "device_otp_invalid", "supabase_login_replaced",
]);
function normalizedErrorCode(code: unknown) {
  if (code === "pkce_code_verifier_not_found") return "pkce_verifier_missing";
  if (code === "bad_code_verifier") return "pkce_verifier_mismatch";
  if (code === "supabase_email_unconfirmed" || code === "email_not_confirmed") return "identity_unconfirmed";
  return typeof code === "string" && errors.has(code) ? code : "unknown";
}

// Android-only operational failures. Never serialize caller objects,
// exception messages/stacks, callback parameters or arbitrary provider codes.
export function logGoogleOAuthDiagnostic(event: GoogleOAuthDiagnosticEvent, metadata: Metadata) {
  if (getRuntimePlatformSync() !== "android" || !failures.has(event)
    || !["warm", "cold"].includes(metadata.mode) || !["onOpenUrl", "getCurrent"].includes(metadata.origin)) return;
  const row: Record<string, string | number> = { event, platform: "android", mode: metadata.mode, origin: metadata.origin };
  if (Number.isFinite(metadata.durationMs) && metadata.durationMs! >= 0 && metadata.durationMs! <= 86400000) row.duration_ms = Math.round(metadata.durationMs!);
  if (Number.isInteger(metadata.httpStatus) && metadata.httpStatus! >= 100 && metadata.httpStatus! <= 599) row.http_status = metadata.httpStatus!;
  if (metadata.errorCode !== undefined) row.error_code = normalizedErrorCode(metadata.errorCode);
  if (event === "oauth_exchange_failed" && metadata.authErrorCode !== undefined) {
    row.auth_error_code = authCodes.has(metadata.authErrorCode) ? metadata.authErrorCode : "other";
    row.error_code = "supabase_auth_failed";
  }
  try { console.info(`[google-oauth] ${JSON.stringify(row)}`); } catch { /* Diagnostics cannot interrupt authentication. */ }
  // Wry suppresses its console-to-logcat forwarding in release builds. The
  // Android sink validates again and logs only in release (no debug duplicates).
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("log_google_oauth_diagnostic", { payload: row }))
    .catch(() => { /* Missing diagnostic transport never changes login. */ });
}

export type GoogleOAuthTrace = {
  failure?: GoogleOAuthDiagnosticEvent;
  emit(event: GoogleOAuthDiagnosticEvent, error?: unknown, durationMs?: number): void;
  fail(event: GoogleOAuthDiagnosticEvent, error?: unknown, durationMs?: number): void;
  step<T>(failure: GoogleOAuthDiagnosticEvent, action: () => Promise<T>): Promise<T>;
};

export function createGoogleOAuthTrace(context: GoogleOAuthDiagnosticContext): GoogleOAuthTrace {
  return {
    emit(event, error, durationMs) {
      try {
        const value = error && typeof error === "object" ? error as { code?: unknown; statusCode?: unknown; status?: unknown } : null;
        // The SDK assigns status=400 to a missing verifier locally, without
        // sending HTTP. Do not report that synthetic status as a provider response.
        const status = value?.code === "pkce_code_verifier_not_found" ? undefined : value?.statusCode ?? value?.status;
        const auth = event === "oauth_exchange_failed" && error && typeof error === "object"
          ? authErrors.get(error) ?? authApiDiagnostic(error) : undefined;
        logGoogleOAuthDiagnostic(event, { ...context, durationMs,
          httpStatus: auth?.status ?? (typeof status === "number" ? status : undefined),
          errorCode: error === undefined ? undefined : normalizedErrorCode(value?.code), authErrorCode: auth?.code });
      } catch { /* Inspecting an unusual exception cannot affect authentication. */ }
    },
    fail(event, error, durationMs) { this.failure = event; this.emit(event, error, durationMs); },
    async step(failure, action) {
      const start = Date.now();
      try {
        return await action();
      } catch (error) { this.fail(failure, error, Date.now() - start); throw error; }
    },
  };
}
