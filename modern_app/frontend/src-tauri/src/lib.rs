use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::hash::{Hash, Hasher};
#[cfg(target_os = "windows")]
use std::ffi::c_void;
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::process::Command;

use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri::Emitter;
use serde::Serialize;

const CLOUD_REFRESH_TOKEN_SERVICE_NAME: &str = "com.scisonomics.desktop.cloud-refresh-token";
const LEGACY_CLOUD_TOKEN_SERVICE_NAME: &str = "com.scisonomics.desktop.cloud-token";

#[derive(Debug, Serialize)]
struct PersistentCloudTokenSaveResult {
  ok: bool,
  roundtrip: bool,
  error_code: Option<String>,
  service: String,
  account_id_hash: String,
}

#[derive(Debug, Serialize)]
struct PersistentCloudTokenLoadResult {
  found: bool,
  token: Option<String>,
  error_code: Option<String>,
  service: String,
  account_id_hash: String,
}

#[derive(Debug, Serialize)]
struct PersistentCloudTokenDeleteResult {
  ok: bool,
  error_code: Option<String>,
  service: String,
  account_id_hash: String,
}

#[derive(Debug, Serialize)]
struct RefreshKeyringDebugStatus {
  service: String,
  account_id_hash: String,
  found: bool,
  error_code: Option<String>,
}

#[derive(Clone)]
struct LocalApiToken(String);

#[derive(Clone)]
struct AppCloseSyncSignal(Arc<(Mutex<AppCloseSyncState>, Condvar)>);

#[derive(Clone, Copy)]
struct AppCloseSyncState {
  completed: bool,
  timeout_ms: u64,
}

const APP_CLOSE_SYNC_REQUESTED_EVENT: &str = "scisonomics://app-close-sync-requested";
const APP_CLOSE_SYNC_TIMEOUT_MS: u64 = 6_000;
const APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS: u64 = 10_000;

#[cfg(target_os = "windows")]
fn fill_random_bytes(bytes: &mut [u8]) -> bool {
  #[link(name = "advapi32")]
  extern "system" {
    fn SystemFunction036(random_buffer: *mut u8, random_buffer_length: u32) -> u8;
  }
  unsafe { SystemFunction036(bytes.as_mut_ptr(), bytes.len() as u32) != 0 }
}

#[cfg(not(target_os = "windows"))]
fn fill_random_bytes(_bytes: &mut [u8]) -> bool {
  false
}

fn generate_local_api_token() -> String {
  let mut bytes = [0u8; 32];
  if fill_random_bytes(&mut bytes) {
    return bytes.iter().map(|byte| format!("{byte:02x}")).collect();
  }
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_nanos())
    .unwrap_or_default();
  format!("sciso-{}-{}-{:p}", std::process::id(), nanos, &bytes)
}

#[tauri::command]
async fn save_binary_file(app: tauri::AppHandle, file_name: String, extension: String, bytes: Vec<u8>) -> Result<bool, String> {
  let allowed_extension = match extension.trim().to_ascii_lowercase().as_str() {
    "db" => "db",
    "xlsx" => "xlsx",
    _ => return Err("Tipo de archivo no permitido.".to_string()),
  };
  let suggested_path = std::path::Path::new(file_name.trim());
  let safe_file_name = suggested_path
    .file_name()
    .and_then(|value| value.to_str())
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "Nombre de archivo invalido.".to_string())?;
  if safe_file_name != file_name.trim() || suggested_path.components().count() != 1 {
    return Err("El nombre de archivo no puede incluir carpetas.".to_string());
  }
  let suggested_extension = suggested_path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .to_ascii_lowercase();
  if suggested_extension != allowed_extension {
    return Err("La extension del archivo no esta permitida.".to_string());
  }
  if bytes.is_empty() {
    return Err("El archivo recibido esta vacio.".to_string());
  }

  let selected = app
    .dialog()
    .file()
    .add_filter("Archivo ScisoNomics", &[allowed_extension])
    .set_file_name(safe_file_name)
    .blocking_save_file();
  let Some(selected) = selected else {
    return Ok(false);
  };
  let output_path = selected
    .into_path()
    .map_err(|_| "La ubicacion seleccionada no es valida.".to_string())?;
  if output_path.exists() && output_path.is_dir() {
    return Err("La ubicacion seleccionada es una carpeta, no un archivo.".to_string());
  }
  let selected_extension = output_path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .to_ascii_lowercase();
  if selected_extension != allowed_extension {
    return Err("La extension seleccionada no esta permitida.".to_string());
  }

  std::fs::write(&output_path, bytes)
    .map_err(|e| format!("No se pudo escribir el archivo seleccionado: {e}"))?;
  Ok(true)
}

#[tauri::command]
fn get_local_api_token(token: tauri::State<'_, LocalApiToken>) -> String {
  token.0.clone()
}

#[cfg(not(target_os = "windows"))]
fn secure_token_entry(service_name: &str, account_id: &str) -> Result<keyring::Entry, String> {
  #[cfg(target_os = "windows")]
  {
    let target = format!("scisonomics::{service_name}::{account_id}");
    return keyring::Entry::new_with_target(&target, service_name, account_id)
      .map_err(|error| format!("No se pudo preparar el storage seguro: {error}"));
  }
  #[cfg(not(target_os = "windows"))]
  {
    keyring::Entry::new(service_name, account_id).map_err(|error| format!("No se pudo preparar el storage seguro: {error}"))
  }
}

#[cfg(target_os = "windows")]
fn wincred_target_name(service_name: &str, account_id: &str) -> String {
  format!("scisonomics::{service_name}::{account_id}")
}

#[cfg(target_os = "windows")]
fn to_wide(value: &str) -> Vec<u16> {
  value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn wincred_last_error() -> u32 {
  #[link(name = "kernel32")]
  extern "system" {
    fn GetLastError() -> u32;
  }
  unsafe { GetLastError() }
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
#[repr(C)]
struct FileTime {
  dwLowDateTime: u32,
  dwHighDateTime: u32,
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
#[repr(C)]
struct CredentialAttributeW {
  Keyword: *mut u16,
  Flags: u32,
  ValueSize: u32,
  Value: *mut u8,
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
#[repr(C)]
struct CredentialW {
  Flags: u32,
  Type: u32,
  TargetName: *mut u16,
  Comment: *mut u16,
  LastWritten: FileTime,
  CredentialBlobSize: u32,
  CredentialBlob: *mut u8,
  Persist: u32,
  AttributeCount: u32,
  Attributes: *mut CredentialAttributeW,
  TargetAlias: *mut u16,
  UserName: *mut u16,
}

#[cfg(target_os = "windows")]
const CRED_TYPE_GENERIC: u32 = 1;
#[cfg(target_os = "windows")]
const CRED_PERSIST_ENTERPRISE: u32 = 3;
#[cfg(target_os = "windows")]
const ERROR_NOT_FOUND: u32 = 1168;

#[cfg(target_os = "windows")]
#[link(name = "Advapi32")]
extern "system" {
  fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
  fn CredReadW(target_name: *const u16, cred_type: u32, flags: u32, credential: *mut *mut CredentialW) -> i32;
  fn CredDeleteW(target_name: *const u16, cred_type: u32, flags: u32) -> i32;
  fn CredFree(buffer: *mut c_void);
}

#[cfg(target_os = "windows")]
fn wincred_write_refresh_token(service_name: &str, account_id: &str, token: &str) -> Result<(), String> {
  let target = wincred_target_name(service_name, account_id);
  let mut target_name = to_wide(&target);
  let mut username = to_wide(account_id);
  let mut comment = to_wide("ScisoNomics refresh token");
  let mut blob = token.as_bytes().to_vec();
  let mut credential = CredentialW {
    Flags: 0,
    Type: CRED_TYPE_GENERIC,
    TargetName: target_name.as_mut_ptr(),
    Comment: comment.as_mut_ptr(),
    LastWritten: FileTime { dwLowDateTime: 0, dwHighDateTime: 0 },
    CredentialBlobSize: blob.len() as u32,
    CredentialBlob: blob.as_mut_ptr(),
    Persist: CRED_PERSIST_ENTERPRISE,
    AttributeCount: 0,
    Attributes: std::ptr::null_mut(),
    TargetAlias: std::ptr::null_mut(),
    UserName: username.as_mut_ptr(),
  };
  let result = unsafe { CredWriteW(&mut credential, 0) };
  blob.fill(0);
  if result == 0 {
    return Err(format!("wincred_write_failed:{}", wincred_last_error()));
  }
  Ok(())
}

#[cfg(target_os = "windows")]
fn wincred_read_refresh_token(service_name: &str, account_id: &str) -> Result<Option<String>, String> {
  let target = wincred_target_name(service_name, account_id);
  let target_name = to_wide(&target);
  let mut credential_ptr: *mut CredentialW = std::ptr::null_mut();
  let result = unsafe { CredReadW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) };
  if result == 0 {
    let error = wincred_last_error();
    if error == ERROR_NOT_FOUND {
      return Ok(None);
    }
    return Err(format!("wincred_read_failed:{error}"));
  }
  let credential = unsafe { &*credential_ptr };
  let secret = if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
    None
  } else {
    let bytes = unsafe { std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize) };
    Some(String::from_utf8(bytes.to_vec()).map_err(|_| "wincred_invalid_utf8".to_string())?)
  };
  if !credential.CredentialBlob.is_null() && credential.CredentialBlobSize > 0 {
    let bytes = unsafe { std::slice::from_raw_parts_mut(credential.CredentialBlob, credential.CredentialBlobSize as usize) };
    bytes.fill(0);
  }
  unsafe { CredFree(credential_ptr as *mut c_void) };
  Ok(secret.filter(|value| !value.trim().is_empty()))
}

#[cfg(target_os = "windows")]
fn wincred_delete_refresh_token(service_name: &str, account_id: &str) -> Result<(), String> {
  let target = wincred_target_name(service_name, account_id);
  let target_name = to_wide(&target);
  let result = unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) };
  if result == 0 {
    let error = wincred_last_error();
    if error == ERROR_NOT_FOUND {
      return Ok(());
    }
    return Err(format!("wincred_delete_failed:{error}"));
  }
  Ok(())
}

fn hashed_account_id(account_id: &str) -> String {
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  account_id.hash(&mut hasher);
  format!("{:016x}", hasher.finish())
}

#[tauri::command]
fn save_persistent_cloud_refresh_token(account_id: String, token: String) -> Result<PersistentCloudTokenSaveResult, String> {
  let normalized_account_id = account_id.trim();
  let normalized_token = token.trim();
  let account_id_hash = hashed_account_id(normalized_account_id);
  if normalized_account_id.is_empty() || normalized_token.is_empty() {
    return Ok(PersistentCloudTokenSaveResult {
      ok: false,
      roundtrip: false,
      error_code: Some("invalid_account_id".to_string()),
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
    });
  }
  #[cfg(target_os = "windows")]
  let write_result = wincred_write_refresh_token(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id, normalized_token);
  #[cfg(not(target_os = "windows"))]
  let write_result = {
    let entry = secure_token_entry(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id)?;
    entry
      .set_password(normalized_token)
      .map_err(|error| format!("No se pudo guardar el refresh token persistente: {error}"))
  };
  write_result?;
  #[cfg(target_os = "windows")]
  let roundtrip = match wincred_read_refresh_token(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id) {
    Ok(Some(saved_token)) => !saved_token.trim().is_empty(),
    Ok(None) => false,
    Err(_) => false,
  };
  #[cfg(not(target_os = "windows"))]
  let roundtrip = {
    let entry = secure_token_entry(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id)?;
    match entry.get_password() {
      Ok(saved_token) => !saved_token.trim().is_empty(),
      Err(keyring::Error::NoEntry) => false,
      Err(_) => false,
    }
  };
  Ok(PersistentCloudTokenSaveResult {
    ok: true,
    roundtrip,
    error_code: if roundtrip { None } else { Some("keyring_roundtrip_failed".to_string()) },
    service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
    account_id_hash,
  })
}

#[tauri::command]
fn load_persistent_cloud_refresh_token(account_id: String) -> Result<PersistentCloudTokenLoadResult, String> {
  let normalized_account_id = account_id.trim();
  let account_id_hash = hashed_account_id(normalized_account_id);
  if normalized_account_id.is_empty() {
    return Ok(PersistentCloudTokenLoadResult {
      found: false,
      token: None,
      error_code: Some("invalid_account_id".to_string()),
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
    });
  }
  #[cfg(target_os = "windows")]
  let load_result = wincred_read_refresh_token(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id);
  #[cfg(not(target_os = "windows"))]
  let load_result = {
    let entry = secure_token_entry(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id)?;
    match entry.get_password() {
      Ok(token) if !token.trim().is_empty() => Ok(Some(token)),
      Ok(_) => Ok(None),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(error) => Err(format!("keyring_error:{error}")),
    }
  };
  match load_result {
    Ok(Some(token)) => Ok(PersistentCloudTokenLoadResult {
      found: true,
      token: Some(token),
      error_code: None,
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
    }),
    Ok(None) => Ok(PersistentCloudTokenLoadResult {
      found: false,
      token: None,
      error_code: Some("no_entry".to_string()),
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
    }),
    Err(error) => Ok(PersistentCloudTokenLoadResult {
      found: false,
      token: None,
      error_code: Some(error),
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
    }),
  }
}

#[tauri::command]
fn delete_persistent_cloud_refresh_token(account_id: String) -> Result<PersistentCloudTokenDeleteResult, String> {
  let normalized_account_id = account_id.trim();
  let account_id_hash = hashed_account_id(normalized_account_id);
  if normalized_account_id.is_empty() {
    return Ok(PersistentCloudTokenDeleteResult {
      ok: false,
      error_code: Some("invalid_account_id".to_string()),
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
    });
  }
  #[cfg(target_os = "windows")]
  {
    wincred_delete_refresh_token(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id)?;
    wincred_delete_refresh_token(LEGACY_CLOUD_TOKEN_SERVICE_NAME, normalized_account_id)?;
  }
  #[cfg(not(target_os = "windows"))]
  {
    let entry = secure_token_entry(CLOUD_REFRESH_TOKEN_SERVICE_NAME, normalized_account_id)?;
    match entry.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => {}
      Err(error) => return Err(format!("No se pudo borrar el refresh token persistente: {error}")),
    }
    let legacy_entry = secure_token_entry(LEGACY_CLOUD_TOKEN_SERVICE_NAME, normalized_account_id)?;
    match legacy_entry.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => {}
      Err(error) => return Err(format!("No se pudo borrar el refresh token persistente legacy: {error}")),
    }
  }
  Ok(PersistentCloudTokenDeleteResult {
    ok: true,
    error_code: None,
    service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
    account_id_hash,
  })
}

#[tauri::command]
fn save_persistent_cloud_token(account_id: String, token: String) -> Result<PersistentCloudTokenSaveResult, String> {
  save_persistent_cloud_refresh_token(account_id, token)
}

#[tauri::command]
fn load_persistent_cloud_token(account_id: String) -> Result<PersistentCloudTokenLoadResult, String> {
  load_persistent_cloud_refresh_token(account_id)
}

#[tauri::command]
fn delete_persistent_cloud_token(account_id: String) -> Result<PersistentCloudTokenDeleteResult, String> {
  delete_persistent_cloud_refresh_token(account_id)
}

#[tauri::command]
fn debug_refresh_keyring_status(account_id: String) -> Result<RefreshKeyringDebugStatus, String> {
  let normalized_account_id = account_id.trim();
  let account_id_hash = hashed_account_id(normalized_account_id);
  if normalized_account_id.is_empty() {
    return Ok(RefreshKeyringDebugStatus {
      service: CLOUD_REFRESH_TOKEN_SERVICE_NAME.to_string(),
      account_id_hash,
      found: false,
      error_code: Some("invalid_account_id".to_string()),
    });
  }
  let load_result = load_persistent_cloud_refresh_token(normalized_account_id.to_string())?;
  Ok(RefreshKeyringDebugStatus {
    service: load_result.service,
    account_id_hash: load_result.account_id_hash,
    found: load_result.found,
    error_code: load_result.error_code,
  })
}

#[tauri::command]
fn complete_app_close_sync(signal: tauri::State<'_, AppCloseSyncSignal>) {
  let (lock, condition) = &*signal.0;
  if let Ok(mut state) = lock.lock() {
    state.completed = true;
    condition.notify_all();
  }
}

#[tauri::command]
fn set_app_close_sync_timeout(signal: tauri::State<'_, AppCloseSyncSignal>, timeout_ms: u64) {
  let bounded = timeout_ms.clamp(APP_CLOSE_SYNC_TIMEOUT_MS, APP_CLOSE_SYNC_CRITICAL_TIMEOUT_MS);
  let (lock, condition) = &*signal.0;
  if let Ok(mut state) = lock.lock() {
    state.timeout_ms = bounded;
    condition.notify_all();
  }
}

type BackendChild = Arc<Mutex<Option<CommandChild>>>;

fn reset_app_close_sync(signal: &AppCloseSyncSignal) {
  let (lock, _) = &*signal.0;
  if let Ok(mut state) = lock.lock() {
    state.completed = false;
    state.timeout_ms = APP_CLOSE_SYNC_TIMEOUT_MS;
  }
}

fn wait_for_app_close_sync(signal: &AppCloseSyncSignal) -> bool {
  let (lock, condition) = &*signal.0;
  let Ok(mut state) = lock.lock() else {
    return false;
  };
  let started_at = Instant::now();
  loop {
    if state.completed {
      return true;
    }
    let timeout = Duration::from_millis(state.timeout_ms);
    if started_at.elapsed() >= timeout {
      return false;
    }
    let remaining = timeout.saturating_sub(started_at.elapsed());
    let wait_step = remaining.min(Duration::from_millis(100));
    match condition.wait_timeout(state, wait_step) {
      Ok((next_state, _)) => state = next_state,
      Err(_) => return false,
    }
  }
}

fn local_backend_address() -> SocketAddr {
  "127.0.0.1:8000".parse().expect("valid local backend address")
}

fn local_port_is_open() -> bool {
  TcpStream::connect_timeout(&local_backend_address(), Duration::from_millis(150)).is_ok()
}

fn wait_for_local_port_release(timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  while local_port_is_open() {
    if Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  true
}

fn request_cooperative_backend_shutdown(local_api_token: &str) -> bool {
  let Ok(mut stream) = TcpStream::connect_timeout(&local_backend_address(), Duration::from_millis(250)) else {
    return false;
  };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
  let request = format!(
    "POST /internal/shutdown HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nX-Scisonomics-Local-Token: {local_api_token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
  );
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }
  let mut response = [0u8; 256];
  match stream.read(&mut response) {
    Ok(size) if size > 0 => {
      let status_line = String::from_utf8_lossy(&response[..size]);
      status_line.starts_with("HTTP/1.1 200") || status_line.starts_with("HTTP/1.0 200")
    }
    _ => false,
  }
}

#[cfg(target_os = "windows")]
fn backend_process_is_running(pid: u32) -> bool {
  use std::ffi::c_void;

  const SYNCHRONIZE: u32 = 0x0010_0000;
  const WAIT_TIMEOUT: u32 = 258;

  #[link(name = "kernel32")]
  extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
  }

  unsafe {
    let handle = OpenProcess(SYNCHRONIZE, 0, pid);
    if handle.is_null() {
      return false;
    }
    let result = WaitForSingleObject(handle, 0);
    CloseHandle(handle);
    result == WAIT_TIMEOUT
  }
}

#[cfg(not(target_os = "windows"))]
fn backend_process_is_running(_pid: u32) -> bool {
  false
}

fn wait_for_backend_exit(pid: u32) {
  let deadline = Instant::now() + Duration::from_secs(3);
  while backend_process_is_running(pid) {
    if Instant::now() >= deadline {
      log::warn!("El sidecar backend PID {pid} no termino dentro del timeout de cierre.");
      return;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
}

#[cfg(target_os = "windows")]
fn safe_stale_sidecar_pids() -> Vec<u32> {
  let app_root = std::env::current_exe()
    .ok()
    .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
    .unwrap_or_default();
  let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$names = @('scisonomics-backend.exe', 'scisonomics-backend-x86_64-pc-windows-msvc.exe')
$root = [Environment]::GetEnvironmentVariable('SCISONOMICS_APP_ROOT')
$listenerPids = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8000 -State Listen | Select-Object -ExpandProperty OwningProcess)
Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | ForEach-Object {
  $path = [string]$_.ExecutablePath
  $underRoot = $path -and $root -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
  $ownsPort = $listenerPids -contains [uint32]$_.ProcessId
  if ($underRoot -or $ownsPort) { [Console]::WriteLine($_.ProcessId) }
}
"#;
  let Ok(output) = Command::new("powershell.exe")
    .args(["-NoProfile", "-NonInteractive", "-Command", script])
    .env("SCISONOMICS_APP_ROOT", app_root)
    .output()
  else {
    return Vec::new();
  };
  String::from_utf8_lossy(&output.stdout)
    .lines()
    .filter_map(|line| line.trim().parse::<u32>().ok())
    .filter(|pid| *pid != std::process::id())
    .collect()
}

#[cfg(target_os = "windows")]
fn terminate_stale_sidecars() -> usize {
  let mut terminated = 0;
  for pid in safe_stale_sidecar_pids() {
    match Command::new("taskkill.exe")
      .args(["/F", "/T", "/PID", &pid.to_string()])
      .output()
    {
      Ok(output) if output.status.success() => {
        terminated += 1;
        log::warn!("Se cerro un sidecar local anterior de ScisoNomics. PID: {pid}");
      }
      Ok(_) => log::warn!("No se pudo cerrar el sidecar local anterior de ScisoNomics. PID: {pid}"),
      Err(error) => log::warn!("No se pudo ejecutar taskkill para el sidecar PID {pid}: {error}"),
    }
  }
  terminated
}

#[cfg(not(target_os = "windows"))]
fn terminate_stale_sidecars() -> usize {
  0
}

fn prepare_local_port_for_sidecar() -> bool {
  if !local_port_is_open() {
    return true;
  }
  log::warn!("El puerto local 8000 ya estaba ocupado antes de iniciar el sidecar.");
  if terminate_stale_sidecars() > 0 && wait_for_local_port_release(Duration::from_secs(1)) {
    return true;
  }
  log::error!("El puerto local de ScisoNomics esta ocupado por otro proceso.");
  false
}

fn fallback_close_stale_sidecars() {
  log::warn!("Aplicando fallback seguro para cerrar sidecars locales anteriores.");
  terminate_stale_sidecars();
  if !wait_for_local_port_release(Duration::from_secs(3)) {
    log::error!("El puerto local 8000 sigue ocupado despues del cierre del sidecar.");
  }
}

fn stop_backend_sidecar(backend_child: &BackendChild, local_api_token: &str) {
  let child = match backend_child.lock() {
    Ok(mut guard) => guard.take(),
    Err(error) => {
      log::error!("No se pudo bloquear el handle del sidecar para cerrarlo: {error}");
      None
    }
  };

  if let Some(child) = child {
    let pid = child.pid();
    if request_cooperative_backend_shutdown(local_api_token) {
      log::info!("Shutdown cooperativo solicitado al backend local. PID: {pid}");
    }
    if wait_for_local_port_release(Duration::from_secs(1)) {
      wait_for_backend_exit(pid);
      log::info!("Sidecar backend cerrado cooperativamente. PID: {pid}");
      return;
    }
    log::warn!("El sidecar backend no respondio al cierre cooperativo. Aplicando kill. PID: {pid}");
    match child.kill() {
      Ok(()) => {
        wait_for_backend_exit(pid);
        log::info!("Sidecar backend cerrado correctamente. PID: {pid}");
      }
      Err(error) => log::error!("No se pudo cerrar el sidecar backend PID {pid}: {error}"),
    }
    if !wait_for_local_port_release(Duration::from_millis(500)) {
      log::warn!("El puerto 8000 sigue ocupado tras child.kill(). Aplicando fallback Windows seguro.");
      fallback_close_stale_sidecars();
    }
  } else if local_port_is_open() {
    log::warn!("No hay handle del sidecar, pero el puerto local sigue ocupado.");
    request_cooperative_backend_shutdown(local_api_token);
    if !wait_for_local_port_release(Duration::from_secs(1)) {
      fallback_close_stale_sidecars();
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let backend_child: BackendChild = Arc::new(Mutex::new(None));
  let app_close_sync_signal = AppCloseSyncSignal(Arc::new((Mutex::new(AppCloseSyncState {
    completed: false,
    timeout_ms: APP_CLOSE_SYNC_TIMEOUT_MS,
  }), Condvar::new())));
  let close_in_progress = Arc::new(AtomicBool::new(false));
  let local_api_token = generate_local_api_token();
  let setup_backend_child = Arc::clone(&backend_child);
  let close_backend_child = Arc::clone(&backend_child);
  let exit_backend_child = Arc::clone(&backend_child);
  let close_app_sync_signal = app_close_sync_signal.clone();
  let close_in_progress_for_window = Arc::clone(&close_in_progress);
  let close_local_api_token = local_api_token.clone();
  let exit_local_api_token = local_api_token.clone();

  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(LocalApiToken(local_api_token.clone()))
    .manage(app_close_sync_signal)
    .invoke_handler(tauri::generate_handler![
      save_binary_file,
      get_local_api_token,
      save_persistent_cloud_token,
      load_persistent_cloud_token,
      delete_persistent_cloud_token,
      save_persistent_cloud_refresh_token,
      load_persistent_cloud_refresh_token,
      delete_persistent_cloud_refresh_token,
      debug_refresh_keyring_status,
      complete_app_close_sync,
      set_app_close_sync_timeout
    ])
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      if !prepare_local_port_for_sidecar() {
        app
          .dialog()
          .message("El puerto local de ScisoNomics esta ocupado por otro proceso. Cerra otras instancias de ScisoNomics o el servicio que usa el puerto 8000 y volve a abrir la app.")
          .title("No se pudo iniciar ScisoNomics")
          .blocking_show();
        return Ok(());
      }

      log::info!("Intentando iniciar sidecar backend: scisonomics-backend");
      let sidecar_command = match app.shell().sidecar("scisonomics-backend") {
        Ok(command) => command,
        Err(error) => {
          log::error!("No se pudo preparar el comando del sidecar: {error}");
          return Ok(());
        }
      };

      match sidecar_command
        .env("SCISONOMICS_LOCAL_TOKEN", local_api_token.clone())
        .env("SCISONOMICS_PARENT_PID", std::process::id().to_string())
        .spawn() {
        Ok((mut rx, child)) => {
          log::info!("Sidecar backend iniciado. PID: {}", child.pid());
          match setup_backend_child.lock() {
            Ok(mut guard) => {
              *guard = Some(child);
            }
            Err(error) => {
              log::error!("No se pudo guardar el handle del sidecar: {error}");
            }
          }
          tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
              match event {
                CommandEvent::Stdout(line) => {
                  let line = String::from_utf8_lossy(&line);
                  log::info!("[sidecar][stdout] {}", line.trim_end());
                }
                CommandEvent::Stderr(line) => {
                  let line = String::from_utf8_lossy(&line);
                  log::error!("[sidecar][stderr] {}", line.trim_end());
                }
                CommandEvent::Error(error) => {
                  log::error!("[sidecar][error] {error}");
                }
                CommandEvent::Terminated(payload) => {
                  log::warn!(
                    "[sidecar][terminated] code={:?} signal={:?}",
                    payload.code,
                    payload.signal
                  );
                }
                _ => {}
              }
            }
          });
        }
        Err(error) => {
          log::error!("Fallo al arrancar el sidecar backend: {error}");
        }
      }

      Ok(())
    })
    .on_window_event(move |window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if close_in_progress_for_window.swap(true, Ordering::SeqCst) {
          return;
        }
        api.prevent_close();
        reset_app_close_sync(&close_app_sync_signal);
        let sync_signal = close_app_sync_signal.clone();
        let backend_child = Arc::clone(&close_backend_child);
        let local_api_token = close_local_api_token.clone();
        let window = window.clone();
        if let Err(error) = window.emit(APP_CLOSE_SYNC_REQUESTED_EVENT, ()) {
          log::warn!("No se pudo solicitar sync app_close al frontend: {error}");
        }
        std::thread::spawn(move || {
          if !wait_for_app_close_sync(&sync_signal) {
            log::warn!("Timeout esperando sync app_close; continuando cierre seguro.");
          }
          stop_backend_sidecar(&backend_child, &local_api_token);
          if let Err(error) = window.close() {
            log::error!("No se pudo cerrar la ventana despues del shutdown seguro: {error}");
          }
        });
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(move |_app_handle, event| {
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        stop_backend_sidecar(&exit_backend_child, &exit_local_api_token);
      }
    });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn keyring_refresh_token_roundtrip_dummy() {
    let account_id = "debug-keyring-test";
    let token = "dummy-refresh-token";

    let _ = delete_persistent_cloud_refresh_token(account_id.to_string());

    let save_result = save_persistent_cloud_refresh_token(account_id.to_string(), token.to_string())
      .expect("save command should return a structured result");
    println!("save_result={save_result:?}");
    assert!(save_result.ok, "save should report ok=true");
    assert!(save_result.roundtrip, "save should report roundtrip=true");

    let load_result = load_persistent_cloud_refresh_token(account_id.to_string())
      .expect("load command should return a structured result");
    println!(
      "load_result={{ found: {}, error_code: {:?}, service: {}, account_id_hash: {} }}",
      load_result.found,
      load_result.error_code,
      load_result.service,
      load_result.account_id_hash
    );
    assert!(load_result.found, "load should report found=true");
    assert!(load_result.token.is_some(), "load should return the dummy token");

    let delete_result = delete_persistent_cloud_refresh_token(account_id.to_string())
      .expect("delete command should return a structured result");
    assert!(delete_result.ok, "delete should report ok=true");

    let final_load = load_persistent_cloud_refresh_token(account_id.to_string())
      .expect("final load should return a structured result");
    assert!(!final_load.found, "load after delete should report found=false");
  }
}
