use serde_json::Value;

pub fn validate(payload: Value) -> Result<Value, &'static str> {
  let reject = "auth_diagnostic_unavailable";
  if payload.to_string().len() > 1024 { return Err(reject); }
  let row = payload.as_object().ok_or(reject)?;
  let text = |key: &str| row.get(key).and_then(Value::as_str);
  let booleans = ["secureStorageAvailable", "found", "success", "refreshTokenFound", "refreshSuccess", "rotatedRefresh", "rotatedSaveSuccess", "persistentStorageError"];
  let codes = ["none", "unknown_error", "supabase_not_configured", "wincred_no_logon_session", "wincred_access_denied", "wincred_storage_failed", "supabase_secure_storage_failed", "supabase_secure_unavailable", "secure_refresh_load_failed", "secure_refresh_save_failed", "refresh_token_missing", "refresh_rejected", "network_error", "device_revoked", "device_verification_required", "device_proof_invalid", "internal_identity_mismatch", "account_deleted"];
  let fields = ["event", "platform", "namespace", "owner_tag", "project_tag", "duration_ms", "persistentAccounts", "errorCode", "lastAuthErrorCode", "availability", "persistenceStatus", "reason", "phase"];
  if row.keys().any(|key| !fields.contains(&key.as_str()) && !booleans.contains(&key.as_str())) { return Err(reject); }
  if text("platform") != Some("desktop") || text("namespace") != Some("supabase_refresh_v1")
    || !["storage_availability", "save_start", "save_end", "load_start", "load_end", "delete_start", "delete_end", "hydration_start", "hydration_account", "hydration_end", "refresh_start", "refresh_end", "auth_state"].contains(&text("event").ok_or(reject)?) { return Err(reject); }
  for key in booleans { if row.contains_key(key) && !row[key].is_boolean() { return Err(reject); } }
  for key in ["duration_ms", "persistentAccounts"] { if row.contains_key(key) && row[key].as_u64().filter(|n| *n <= 86400000).is_none() { return Err(reject); } }
  for key in ["errorCode", "lastAuthErrorCode"] { if row.contains_key(key) && !codes.contains(&text(key).ok_or(reject)?) { return Err(reject); } }
  if row.contains_key("owner_tag") {
    let value = text("owner_tag").ok_or(reject)?;
    if value.len() != 9 || !value.ends_with("...") || !value.as_bytes()[..6].iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_') { return Err(reject); }
  }
  if row.contains_key("project_tag") {
    let value = text("project_tag").ok_or(reject)?;
    if value.len() != 12 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(reject); }
  }
  for (key, values) in [
    ("availability", &["active", "local", "none", "saved_without_token", "session_expired", "refresh_failed", "unknown_error", "auth_error"][..]),
    ("persistenceStatus", &["ok", "failed", "unknown"][..]),
    ("reason", &["temporary_login", "logout_or_remove", "auth_rejected"][..]),
    ("phase", &["load", "refresh", "save", "device"][..]),
  ] { if row.contains_key(key) && !values.contains(&text(key).ok_or(reject)?) { return Err(reject); } }
  Ok(payload)
}

#[cfg(windows)]
pub fn storage_failure(operation: &str, key: &str, error: &str) {
  let event = match operation { "save" => "save_end", "load" => "load_end", "delete" => "delete_end", _ => return };
  let error_code = if error.ends_with(":1312") { "wincred_no_logon_session" }
    else if error.ends_with(":5") { "wincred_access_denied" } else { "wincred_storage_failed" };
  let mut row = serde_json::json!({"event":event,"platform":"desktop","namespace":"supabase_refresh_v1","success":false,"errorCode":error_code});
  if let Some((project, owner)) = key.split_once("::") {
    if project.len() >= 12 && project.is_ascii() { row["project_tag"] = serde_json::json!(&project[..12]); }
    if owner.len() >= 7 && owner.is_ascii() { row["owner_tag"] = serde_json::json!(format!("{}...", &owner[..6])); }
  }
  if let Ok(row) = validate(row) { log::warn!(target: "desktop_auth", "[auth] {}", row); }
}

// Compiled on Windows in both profiles, installed only by release setup.
#[cfg(windows)]
pub fn release_logger() -> tauri::plugin::TauriPlugin<tauri::Wry> {
  tauri_plugin_log::Builder::default()
    .level(log::LevelFilter::Off)
    .level_for("desktop_auth", log::LevelFilter::Info)
    .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("auth-diagnostics".into()) })])
    .max_file_size(256_000)
    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  #[test] fn permits_only_sanitized_rows() {
    let row = json!({"event":"load_end","platform":"desktop","namespace":"supabase_refresh_v1","owner_tag":"abcdef...","found":true});
    assert!(validate(row.clone()).is_ok());
    for key in ["token", "refresh_token", "email", "headers", "message", "stack", "proof", "private_key"] {
      let mut value = row.clone(); value[key] = json!("secret-fixture"); assert!(validate(value).is_err());
    }
    for (key, value) in [("owner_tag","full-owner-secret"),("errorCode","secret-fixture"),("event","arbitrary"),("project_tag","https://secret.test")] {
      let mut changed = row.clone(); changed[key] = json!(value); assert!(validate(changed).is_err());
    }
  }
}
