use serde_json::Value;

const MAX_BYTES: usize = 768;
const EVENTS: &[&str] = &[
  "oauth_callback_invalid", "oauth_pending_missing", "oauth_pending_expired", "oauth_pending_invalid",
  "oauth_pending_delete_failed", "oauth_exchange_failed", "oauth_session_invalid", "oauth_bootstrap_failed",
  "oauth_device_auth_failed", "oauth_session_store_failed",
];
const ERRORS: &[&str] = &[
  "unknown", "pkce_verifier_missing", "pkce_verifier_mismatch", "flow_state_expired", "flow_state_not_found",
  "invalid_grant", "invalid_credentials", "over_request_rate_limit", "supabase_auth_failed",
  "supabase_oauth_storage_failed", "supabase_secure_storage_failed", "supabase_secure_unavailable",
  "supabase_not_configured", "supabase_session_missing", "identity_unconfirmed",
  "internal_account_required", "internal_identity_invalid", "internal_identity_mismatch", "account_deleted",
  "auth_provider_conflict", "device_storage_failed", "device_storage_unavailable", "device_revoked",
  "device_verification_unavailable", "device_verification_required", "device_otp_invalid", "supabase_login_replaced",
];
const AUTH_CODES: &[&str] = &[
  "bad_code_verifier", "bad_oauth_callback", "bad_oauth_state", "bad_jwt", "invalid_credentials",
  "validation_failed", "unexpected_failure", "flow_state_expired", "flow_state_not_found", "other",
];

// This is a logging boundary, not an auth decision. Rejections are deliberately
// opaque and never contain caller keys, values, credentials or exceptions.
pub fn validate(payload: Value) -> Result<Value, &'static str> {
  let reject = "oauth_diagnostic_unavailable";
  if payload.to_string().len() > MAX_BYTES { return Err(reject); }
  let row = payload.as_object().ok_or(reject)?;
  let fields = ["event", "platform", "mode", "origin", "duration_ms", "http_status", "error_code", "auth_error_code"];
  if row.keys().any(|key| !fields.contains(&key.as_str())) { return Err(reject); }
  let text = |key: &str| row.get(key).and_then(Value::as_str);
  if !EVENTS.contains(&text("event").ok_or(reject)?) || text("platform") != Some("android")
    || !["warm", "cold"].contains(&text("mode").ok_or(reject)?)
    || !["onOpenUrl", "getCurrent"].contains(&text("origin").ok_or(reject)?) { return Err(reject); }
  if let Some(value) = row.get("duration_ms") { if value.as_u64().filter(|n| *n <= 86400000).is_none() { return Err(reject); } }
  if let Some(value) = row.get("http_status") { if value.as_u64().filter(|n| (100..=599).contains(n)).is_none() { return Err(reject); } }
  if row.contains_key("error_code") && !ERRORS.contains(&text("error_code").ok_or(reject)?) { return Err(reject); }
  if row.contains_key("auth_error_code") && (text("event") != Some("oauth_exchange_failed")
    || text("error_code") != Some("supabase_auth_failed") || !AUTH_CODES.contains(&text("auth_error_code").ok_or(reject)?)) { return Err(reject); }
  Ok(payload)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  fn valid() -> Value { json!({"event":"oauth_exchange_failed","platform":"android","mode":"warm","origin":"onOpenUrl","duration_ms":123,"http_status":401,"error_code":"supabase_auth_failed","auth_error_code":"bad_code_verifier"}) }
  #[test] fn valid_failure_is_unchanged() { let value = valid(); assert_eq!(validate(value.clone()), Ok(value)); }
  #[test] fn unknown_or_sensitive_fields_are_rejected() {
    for key in ["message", "body", "headers", "url", "state", "access_token", "refresh_token", "verifier", "email", "user_id"] {
      let mut value = valid(); value[key] = json!("fixture-private"); assert_eq!(validate(value), Err("oauth_diagnostic_unavailable"));
    }
  }
  #[test] fn oversize_is_rejected() { let mut value = valid(); value["error_code"] = json!("x".repeat(MAX_BYTES)); assert!(validate(value).is_err()); }
  #[test] fn success_noise_and_arbitrary_text_are_rejected() {
    for (key, text) in [("event","oauth_completed"),("event","oauth_callback_busy"),("mode","fixture-private"),("origin","fixture-private"),("platform","ios"),("error_code","fixture-private"),("auth_error_code","fixture-private")] {
      let mut value = valid(); value[key] = json!(text); assert!(validate(value).is_err());
    }
  }
  #[test] fn invalid_numbers_and_null_are_rejected() {
    for (key, number) in [("duration_ms",json!(-1)),("duration_ms",json!(1.5)),("duration_ms",json!(86400001)),("http_status",json!(99)),("http_status",json!(600)),("error_code",Value::Null)] {
      let mut value = valid(); value[key] = number; assert!(validate(value).is_err());
    }
  }
  #[test] fn auth_code_requires_exchange_failure() { let mut value = valid(); value["event"] = json!("oauth_bootstrap_failed"); assert!(validate(value).is_err()); }
}
