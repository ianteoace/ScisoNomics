use serde_json::{json, Value};
use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, AppHandle, Manager, Runtime, State};

struct QuickEntry<R: Runtime>(PluginHandle<R>);

#[tauri::command]
async fn peek_pending<R: Runtime>(_app: AppHandle<R>, state: State<'_, QuickEntry<R>>) -> Result<Value, String> {
    state.0.run_mobile_plugin("peekPending", json!({})).map_err(|_| "quick_entry_unavailable".into())
}
#[tauri::command]
async fn consume_pending<R: Runtime>(_app: AppHandle<R>, state: State<'_, QuickEntry<R>>, id: String) -> Result<Value, String> {
    state.0.run_mobile_plugin("consumePending", json!({"id":id})).map_err(|_| "quick_entry_unavailable".into())
}
#[tauri::command]
async fn request_add_tile<R: Runtime>(_app: AppHandle<R>, state: State<'_, QuickEntry<R>>, kind: String) -> Result<Value, String> {
    if !["income", "expense"].contains(&kind.as_str()) { return Err("quick_entry_invalid_type".into()); }
    state.0.run_mobile_plugin("requestAddTile", json!({"type":kind})).map_err(|_| "quick_entry_unavailable".into())
}
#[tauri::command]
async fn get_info<R: Runtime>(_app: AppHandle<R>, state: State<'_, QuickEntry<R>>) -> Result<Value, String> {
    state.0.run_mobile_plugin("getInfo", json!({})).map_err(|_| "quick_entry_unavailable".into())
}
#[tauri::command]
async fn remove_listener<R: Runtime>(_app: AppHandle<R>, state: State<'_, QuickEntry<R>>, event: String, channel_id: u32) -> Result<Value, String> {
    if event != "pending" { return Err("quick_entry_invalid_event".into()); }
    state.0.run_mobile_plugin("removeListener", json!({"event":event,"channelId":channel_id})).map_err(|_| "quick_entry_unavailable".into())
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![peek_pending, consume_pending, request_add_tile, get_info, remove_listener]);
    Builder::new("quick-entry")
        .invoke_handler(move |invoke| match invoke.message.command() {
            "peek_pending" | "consume_pending" | "request_add_tile" | "get_info" | "remove_listener" => handler(invoke),
            "registerListener" => false,
            _ => { invoke.resolver.reject("quick_entry_command_not_available"); true }
        })
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.scisoftware.quickentry", "QuickEntryPlugin")?;
            app.manage(QuickEntry(handle)); Ok(())
        }).build()
}
