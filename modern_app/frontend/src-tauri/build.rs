fn main() {
  println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
  let android_dev_override = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
    && tauri_build::is_dev()
    && std::env::var("TAURI_CONFIG")
      .map(|config| config.contains("\"android-dev-localhost\""))
      .unwrap_or(false);
  if android_dev_override {
    // Kept outside permissions/: desktop and bundled Android retain their ACL.
    // Do not autogenerate command permissions into the shared permissions folder.
    println!("cargo:rerun-if-changed=dev-permissions/android-native.toml");
    tauri_build::try_build(
      tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new()
          .permissions_path_pattern("./dev-permissions/android-native.toml"),
      ),
    ).expect("Android development permissions could not be configured");
  } else {
    tauri_build::build();
  }
}
