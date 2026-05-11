use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      log::info!("Intentando iniciar sidecar backend: scisonomics-backend");
      let sidecar_command = match app.shell().sidecar("scisonomics-backend") {
        Ok(command) => command,
        Err(error) => {
          log::error!("No se pudo preparar el comando del sidecar: {error}");
          return Ok(());
        }
      };

      match sidecar_command.spawn() {
        Ok((mut rx, child)) => {
          log::info!("Sidecar backend iniciado. PID: {}", child.pid());
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
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
