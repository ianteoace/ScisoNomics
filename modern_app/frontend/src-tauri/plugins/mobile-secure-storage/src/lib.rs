use serde_json::{json, Value};
use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, AppHandle, Manager, Runtime, State};

struct SecureStorage<R: Runtime>(PluginHandle<R>);

#[tauri::command]
async fn save<R: Runtime>(_app: AppHandle<R>, state: State<'_, SecureStorage<R>>, account_id: String, token: String) -> Result<Value, String> {
    state.0.run_mobile_plugin("save", json!({ "accountId": account_id, "token": token }))
        .map_err(|_| "mobile_secure_save_failed".into())
}

#[tauri::command]
async fn load<R: Runtime>(_app: AppHandle<R>, state: State<'_, SecureStorage<R>>, account_id: String) -> Result<Value, String> {
    state.0.run_mobile_plugin("load", json!({ "accountId": account_id }))
        .map_err(|_| "mobile_secure_load_failed".into())
}

#[tauri::command]
async fn delete<R: Runtime>(_app: AppHandle<R>, state: State<'_, SecureStorage<R>>, account_id: String) -> Result<Value, String> {
    state.0.run_mobile_plugin("delete", json!({ "accountId": account_id }))
        .map_err(|_| "mobile_secure_delete_failed".into())
}

// Rust-only calls: deliberately absent from invoke_handler and ACL permissions.
// JavaScript can request public identity/proofs, never the private blob.
pub fn identity_load<R: Runtime>(app: &AppHandle<R>, account_key: &str) -> Result<Option<String>, String> {
    let result: Value = app.state::<SecureStorage<R>>().0.run_mobile_plugin("loadIdentity", json!({"accountId": account_key}))
        .map_err(|_| "device_identity_storage_failed".to_string())?;
    Ok(result.get("value").and_then(Value::as_str).map(str::to_owned))
}

pub fn identity_save<R: Runtime>(app: &AppHandle<R>, account_key: &str, value: &str) -> Result<(), String> {
    let result: Value = app.state::<SecureStorage<R>>().0.run_mobile_plugin("saveIdentity", json!({"accountId": account_key, "token": value}))
        .map_err(|_| "device_identity_storage_failed".to_string())?;
    if result.get("ok") == Some(&Value::Bool(true)) { Ok(()) } else { Err("device_identity_storage_failed".into()) }
}

pub fn identity_delete<R: Runtime>(app: &AppHandle<R>, account_key: &str) -> Result<(), String> {
    let _: Value = app.state::<SecureStorage<R>>().0.run_mobile_plugin("deleteIdentity", json!({"accountId": account_key}))
        .map_err(|_| "device_identity_storage_failed".to_string())?;
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![save, load, delete]);
    Builder::new("mobile-secure-storage")
        .invoke_handler(move |invoke| {
            // Block mobile's native-command fallback as well as the ACL.
            match invoke.message.command() {
                "save" | "load" | "delete" => handler(invoke),
                _ => { invoke.resolver.reject("mobile_secure_command_not_available"); true }
            }
        })
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.scisoftware.securestorage", "SecureStoragePlugin")?;
            app.manage(SecureStorage(handle));
            Ok(())
        }).build()
}
