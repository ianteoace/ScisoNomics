use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone)]
struct LocalApiToken(String);

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
fn save_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
  if path.trim().is_empty() {
    return Err("Ruta de archivo invalida.".to_string());
  }
  if bytes.is_empty() {
    return Err("El archivo recibido esta vacio.".to_string());
  }

  let output_path = std::path::Path::new(&path);
  if output_path.exists() && output_path.is_dir() {
    return Err("La ubicacion seleccionada es una carpeta, no un archivo.".to_string());
  }

  if let Some(parent) = output_path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| format!("No se pudo preparar la carpeta destino: {e}"))?;
  }

  std::fs::write(output_path, bytes)
    .map_err(|e| format!("No se pudo escribir el archivo seleccionado: {e}"))
}

#[tauri::command]
fn get_local_api_token(token: tauri::State<'_, LocalApiToken>) -> String {
  token.0.clone()
}

type BackendChild = Arc<Mutex<Option<CommandChild>>>;

fn stop_backend_sidecar(backend_child: &BackendChild) {
  let child = match backend_child.lock() {
    Ok(mut guard) => guard.take(),
    Err(error) => {
      log::error!("No se pudo bloquear el handle del sidecar para cerrarlo: {error}");
      None
    }
  };

  if let Some(child) = child {
    let pid = child.pid();
    match child.kill() {
      Ok(()) => log::info!("Sidecar backend cerrado correctamente. PID: {pid}"),
      Err(error) => log::error!("No se pudo cerrar el sidecar backend PID {pid}: {error}"),
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let backend_child: BackendChild = Arc::new(Mutex::new(None));
  let local_api_token = generate_local_api_token();
  let setup_backend_child = Arc::clone(&backend_child);
  let close_backend_child = Arc::clone(&backend_child);
  let exit_backend_child = Arc::clone(&backend_child);

  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(LocalApiToken(local_api_token.clone()))
    .invoke_handler(tauri::generate_handler![save_binary_file, get_local_api_token])
    .setup(move |app| {
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

      match sidecar_command.env("SCISONOMICS_LOCAL_TOKEN", local_api_token.clone()).spawn() {
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
    .on_window_event(move |_window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        stop_backend_sidecar(&close_backend_child);
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(move |_app_handle, event| {
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        stop_backend_sidecar(&exit_backend_child);
      }
    });
}
