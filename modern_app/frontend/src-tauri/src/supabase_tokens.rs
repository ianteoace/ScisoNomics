use super::{hashed_account_id, PersistentCloudTokenSaveResult, PersistentCloudTokenLoadResult, PersistentCloudTokenDeleteResult};
use zeroize::Zeroizing;

pub const SERVICE: &str = "scisonomics-supabase-refresh-token";

fn valid_key(key: &str) -> bool {
  let Some((project, owner)) = key.split_once("::") else { return false; };
  project.len() == 64 && project.bytes().all(|b| b.is_ascii_hexdigit())
    && !owner.is_empty() && owner.len() <= 120 && owner != "local"
    && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn read(key: &str) -> Result<Option<String>, String> {
  #[cfg(target_os = "windows")]
  { super::wincred_read_secret(SERVICE, key) }
  #[cfg(not(target_os = "windows"))]
  {
    let entry = super::secure_token_entry(SERVICE, key)?;
    match entry.get_password() {
      Ok(token) => Ok(Some(token)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(_) => Err("supabase_secure_read_failed".to_string()),
    }
  }
}

#[tauri::command]
pub fn save_persistent_supabase_refresh_token(account_id: String, token: String) -> Result<PersistentCloudTokenSaveResult, String> {
  let token = Zeroizing::new(token);
  if !valid_key(&account_id) || token.is_empty() || token.len() > 4096 || token.chars().any(char::is_whitespace) {
    return Err("invalid_supabase_storage_input".to_string());
  }
  #[cfg(target_os = "windows")]
  super::wincred_write_secret(SERVICE, &account_id, &token, "ScisoNomics Supabase refresh token")
    .map_err(|_| "supabase_secure_write_failed".to_string())?;
  #[cfg(not(target_os = "windows"))]
  super::secure_token_entry(SERVICE, &account_id)?.set_password(&token)
    .map_err(|_| "supabase_secure_write_failed".to_string())?;
  // Verify the exact secret, not merely a nonempty credential.
  let roundtrip = read(&account_id)?.map(Zeroizing::new).is_some_and(|saved| *saved == *token);
  Ok(PersistentCloudTokenSaveResult {
    ok: roundtrip, roundtrip,
    error_code: if roundtrip { None } else { Some("supabase_secure_roundtrip_failed".to_string()) },
    service: SERVICE.to_string(), account_id_hash: hashed_account_id(&account_id),
  })
}

#[tauri::command]
pub fn load_persistent_supabase_refresh_token(account_id: String) -> Result<PersistentCloudTokenLoadResult, String> {
  if !valid_key(&account_id) { return Err("invalid_supabase_storage_input".to_string()); }
  // Raw keyring exception messages never cross into JS/logs.
  let token = read(&account_id).map_err(|_| "supabase_secure_read_failed".to_string())?
    .filter(|value| !value.is_empty());
  Ok(PersistentCloudTokenLoadResult {
    found: token.is_some(), token, error_code: None, service: SERVICE.to_string(),
    account_id_hash: hashed_account_id(&account_id),
  })
}

#[tauri::command]
pub fn delete_persistent_supabase_refresh_token(account_id: String) -> Result<PersistentCloudTokenDeleteResult, String> {
  if !valid_key(&account_id) { return Err("invalid_supabase_storage_input".to_string()); }
  #[cfg(target_os = "windows")]
  super::wincred_delete_secret(SERVICE, &account_id).map_err(|_| "supabase_secure_delete_failed".to_string())?;
  #[cfg(not(target_os = "windows"))]
  match super::secure_token_entry(SERVICE, &account_id)?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {},
    Err(_) => return Err("supabase_secure_delete_failed".to_string()),
  }
  // Deliberately never delete credentials from either legacy service.
  Ok(PersistentCloudTokenDeleteResult {
    ok: true, error_code: None, service: SERVICE.to_string(), account_id_hash: hashed_account_id(&account_id),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn validates_project_and_internal_owner_keys() {
    assert!(valid_key(&format!("{}::sciso-owner-42", "a".repeat(64))));
    for invalid in ["local", "sub", "project::owner", ""] { assert!(!valid_key(invalid)); }
    assert!(!valid_key(&format!("{}::local", "a".repeat(64))));
  }

  #[test]
  fn native_roundtrip_rotation_and_legacy_isolation() {
    // Unique dummy credentials only. Cleanup on assertion failures as well.
    let key = format!("{}::auth-test-{}-{}", "a".repeat(64), std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    struct Cleanup(String);
    impl Drop for Cleanup {
      fn drop(&mut self) {
        let _ = delete_persistent_supabase_refresh_token(self.0.clone());
        let _ = super::super::delete_persistent_cloud_refresh_token(self.0.clone());
      }
    }
    let _cleanup = Cleanup(key.clone());
    assert!(super::super::save_persistent_cloud_refresh_token(key.clone(), "legacy-dummy".into()).unwrap().roundtrip);
    for token in ["supabase-dummy", "supabase-rotated-dummy"] {
      assert!(save_persistent_supabase_refresh_token(key.clone(), token.into()).unwrap().roundtrip);
      assert_eq!(load_persistent_supabase_refresh_token(key.clone()).unwrap().token.as_deref(), Some(token));
    }
    assert!(delete_persistent_supabase_refresh_token(key.clone()).unwrap().ok);
    assert!(!load_persistent_supabase_refresh_token(key.clone()).unwrap().found);
    assert_eq!(super::super::load_persistent_cloud_refresh_token(key).unwrap().token.as_deref(), Some("legacy-dummy"));
  }
}
