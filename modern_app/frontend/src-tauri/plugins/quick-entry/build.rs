fn main() {
    tauri_plugin::Builder::new(&["peek_pending", "consume_pending", "request_add_tile", "get_info", "registerListener", "remove_listener"])
        .android_path("android").build();
}
