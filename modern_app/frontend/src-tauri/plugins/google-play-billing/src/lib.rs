use serde_json::{json,Value};
use tauri::{plugin::{Builder,PluginHandle,TauriPlugin},AppHandle,Manager,Runtime,State};

struct Billing<R:Runtime>(PluginHandle<R>);

#[tauri::command]
async fn query_products<R:Runtime>(_app:AppHandle<R>,state:State<'_,Billing<R>>,product_ids:Vec<String>,base_plan_ids:Vec<String>) -> Result<Value,String> {
    state.0.run_mobile_plugin("queryProducts",json!({"productIds":product_ids,"basePlanIds":base_plan_ids}))
        .map_err(|_|"google_play_query_failed".to_string())
}
#[tauri::command]
async fn purchase<R:Runtime>(_app:AppHandle<R>,state:State<'_,Billing<R>>,product_id:String,offer_token:String,obfuscated_account_id:String) -> Result<Value,String> {
    state.0.run_mobile_plugin("purchase",json!({"productId":product_id,"offerToken":offer_token,"obfuscatedAccountId":obfuscated_account_id}))
        .map_err(|_|"google_play_purchase_failed".to_string())
}
#[tauri::command]
async fn query_purchases<R:Runtime>(_app:AppHandle<R>,state:State<'_,Billing<R>>) -> Result<Value,String> {
    state.0.run_mobile_plugin("queryPurchases",json!({})).map_err(|_|"google_play_restore_failed".to_string())
}
#[tauri::command]
async fn manage_subscription<R:Runtime>(_app:AppHandle<R>,state:State<'_,Billing<R>>,product_id:String) -> Result<Value,String> {
    state.0.run_mobile_plugin("manageSubscription",json!({"productId":product_id})).map_err(|_|"google_play_management_failed".to_string())
}

pub fn init<R:Runtime>() -> TauriPlugin<R> {
    let handler:Box<dyn Fn(tauri::ipc::Invoke<R>)->bool+Send+Sync>=Box::new(tauri::generate_handler![query_products,purchase,query_purchases,manage_subscription,remove_listener]);
    Builder::new("google-play-billing")
        .invoke_handler(move |invoke| match invoke.message.command() {
            "query_products"|"purchase"|"query_purchases"|"manage_subscription"|"remove_listener"=>handler(invoke),
            "registerListener"=>false,
            _=>{invoke.resolver.reject("google_play_command_not_available");true}
        })
        .setup(|app,api|{let handle=api.register_android_plugin("com.scisoftware.billing","GooglePlayBillingPlugin")?;
            app.manage(Billing(handle));Ok(())}).build()
}

#[tauri::command]
async fn remove_listener<R:Runtime>(_app:AppHandle<R>,state:State<'_,Billing<R>>,event:String,channel_id:u32) -> Result<Value,String> {
    state.0.run_mobile_plugin("removeListener",json!({"event":event,"channelId":channel_id}))
        .map_err(|_|"google_play_listener_failed".to_string())
}
