fn main() {
    tauri_plugin::Builder::new(&["query_products", "purchase", "query_purchases", "manage_subscription", "registerListener", "remove_listener"])
        .android_path("android").build();
}
