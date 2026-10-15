fn main() {
    tauri_plugin::Builder::new(&["save", "load", "delete"])
        .android_path("android")
        .build();
}
