use serde::Deserialize;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const SERVICE: &str = "scisonomics-supabase-pending-pkce";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
  expires_at: u64,
  remember: bool,
  storage_key: String,
  storage: BTreeMap<String, String>,
}

fn valid_project(project: &str) -> bool {
  project.len() == 64 && project.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_payload(payload: &str) -> bool {
  if payload.len() > 2400 { return false; }
  let Ok(pending) = serde_json::from_str::<Pending>(payload) else { return false; };
  let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
  let _ = pending.remember;
  pending.expires_at > now && pending.expires_at <= now + 305_000
    && pending.storage_key.starts_with("scisonomics-supabase-google-pkce-") && pending.storage_key.len() <= 100
    && !pending.storage.is_empty() && pending.storage.len() <= 4
    && pending.storage.iter().all(|(key, value)| key.starts_with(&format!("{}-", pending.storage_key))
      && key.ends_with("-code-verifier") && key.len() <= 160 && value.len() <= 512)
}

fn read(project: &str) -> Result<Option<String>, String> {
  #[cfg(windows)]
  { super::wincred_read_secret(SERVICE, project).map_err(|_| "oauth_secure_read_failed".into()) }
  #[cfg(not(windows))]
  {
    match super::secure_token_entry(SERVICE, project)?.get_password() {
      Ok(value) => Ok(Some(value)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(_) => Err("oauth_secure_read_failed".into()),
    }
  }
}

#[tauri::command]
pub fn save_pending_supabase_oauth(project_id: String, payload: String) -> Result<bool, String> {
  let payload = Zeroizing::new(payload);
  if !valid_project(&project_id) || !valid_payload(&payload) { return Err("invalid_pending_oauth".into()); }
  #[cfg(windows)]
  super::wincred_write_secret(SERVICE, &project_id, &payload, "ScisoNomics pending Google PKCE")
    .map_err(|_| "oauth_secure_write_failed".to_string())?;
  #[cfg(not(windows))]
  super::secure_token_entry(SERVICE, &project_id)?.set_password(&payload).map_err(|_| "oauth_secure_write_failed".to_string())?;
  Ok(read(&project_id)?.map(Zeroizing::new).is_some_and(|saved| *saved == *payload))
}

#[tauri::command]
pub fn load_pending_supabase_oauth(project_id: String) -> Result<Option<String>, String> {
  if !valid_project(&project_id) { return Err("invalid_pending_oauth".into()); }
  let value = read(&project_id)?;
  if value.as_ref().is_some_and(|payload| !valid_payload(payload)) {
    delete_pending_supabase_oauth(project_id)?;
    return Ok(None);
  }
  Ok(value)
}

#[tauri::command]
pub fn delete_pending_supabase_oauth(project_id: String) -> Result<(), String> {
  if !valid_project(&project_id) { return Err("invalid_pending_oauth".into()); }
  #[cfg(windows)]
  super::wincred_delete_secret(SERVICE, &project_id).map_err(|_| "oauth_secure_delete_failed".to_string())?;
  #[cfg(not(windows))]
  match super::secure_token_entry(SERVICE, &project_id)?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {},
    Err(_) => return Err("oauth_secure_delete_failed".into()),
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  fn payload() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    serde_json::json!({"expiresAt": now + 60_000, "remember": true,
      "storageKey": "scisonomics-supabase-google-pkce-dummy",
      "storage": {"scisonomics-supabase-google-pkce-dummy-code-verifier": "\"dummy-pkce\""}}).to_string()
  }
  #[test]
  fn rejects_tokens_and_expired_or_arbitrary_payloads() {
    assert!(valid_payload(&payload()));
    assert!(!valid_payload(r#"{"access_token":"secret"}"#));
    assert!(!valid_payload(r#"{"expiresAt":0,"remember":true,"storage":{}}"#));
    assert!(!valid_project("local"));
  }
  #[test]
  fn native_pending_pkce_roundtrip_and_cleanup() {
    use sha2::{Digest, Sha256};
    let project = format!("{:x}", Sha256::digest(format!("oauth-test-{}-{:?}", std::process::id(), std::time::SystemTime::now())));
    struct Cleanup(String);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = delete_pending_supabase_oauth(self.0.clone()); } }
    let _cleanup = Cleanup(project.clone());
    let dummy = payload();
    assert!(save_pending_supabase_oauth(project.clone(), dummy.clone()).unwrap());
    assert_eq!(load_pending_supabase_oauth(project.clone()).unwrap().as_deref(), Some(dummy.as_str()));
    delete_pending_supabase_oauth(project.clone()).unwrap();
    assert!(load_pending_supabase_oauth(project).unwrap().is_none());
  }
}
