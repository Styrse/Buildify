#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::{
  io::Write,
  net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
  path::{Component, PathBuf},
  thread,
};

use tauri::{
  menu::{Menu, MenuItem},
  AppHandle, Emitter, Manager, WindowEvent,
};

#[cfg(windows)]
const WINDOWS_APP_ID: &str = "com.github.buildnotifier";
const SINGLE_INSTANCE_PORT: u16 = 45_873;

struct SingleInstanceGuard {
  #[allow(dead_code)]
  listener: TcpListener,
}

fn single_instance_addr() -> SocketAddrV4 {
  SocketAddrV4::new(Ipv4Addr::LOCALHOST, SINGLE_INSTANCE_PORT)
}

fn signal_existing_instance() -> Result<(), String> {
  let mut stream = TcpStream::connect(single_instance_addr()).map_err(|error| error.to_string())?;
  stream.write_all(b"show").map_err(|error| error.to_string())
}

fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn create_single_instance_guard(app: &AppHandle) -> Result<SingleInstanceGuard, String> {
  let listener = match TcpListener::bind(single_instance_addr()) {
    Ok(listener) => listener,
    Err(_) => {
      let _ = signal_existing_instance();
      return Err("Buildify is already running".to_string());
    }
  };

  let listener_for_thread = listener.try_clone().map_err(|error| error.to_string())?;
  let app_handle = app.clone();
  thread::spawn(move || {
    for stream in listener_for_thread.incoming() {
      if stream.is_ok() {
        show_main_window(&app_handle);
      }
    }
  });

  Ok(SingleInstanceGuard { listener })
}

#[cfg(windows)]
fn register_windows_app_identity(icon_path: Option<PathBuf>) -> Result<(), String> {
  use winreg::{enums::HKEY_CURRENT_USER, RegKey};

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let (key, _) = hkcu
    .create_subkey(format!(r"SOFTWARE\Classes\AppUserModelId\{WINDOWS_APP_ID}"))
    .map_err(|error| error.to_string())?;

  key.set_value("DisplayName", &"Buildify")
    .map_err(|error| error.to_string())?;
  key.set_value("IconBackgroundColor", &"0")
    .map_err(|error| error.to_string())?;

  if let Some(icon_path) = icon_path {
    key.set_value("IconUri", &icon_path.display().to_string())
      .map_err(|error| error.to_string())?;
  }

  Ok(())
}

#[cfg(not(windows))]
fn register_windows_app_identity(_icon_path: Option<PathBuf>) -> Result<(), String> {
  Ok(())
}

fn safe_asset_path(path: &str) -> Result<PathBuf, String> {
  let trimmed = path.trim().trim_start_matches(['/', '\\']);
  if trimmed.is_empty() || trimmed.contains(':') {
    return Err("Invalid notification icon path".to_string());
  }

  let mut normalized = PathBuf::new();
  for component in PathBuf::from(trimmed).components() {
    match component {
      Component::Normal(part) => normalized.push(part),
      _ => return Err("Invalid notification icon path".to_string()),
    }
  }

  Ok(normalized)
}

fn asset_file_path(app: &AppHandle, asset_path: &str) -> Result<PathBuf, String> {
  let normalized = safe_asset_path(asset_path)?;
  let current_dir = std::env::current_dir().map_err(|error| error.to_string())?;
  let current_parent = current_dir.parent().map(PathBuf::from);

  let mut candidates = vec![
    current_dir.join("public").join(&normalized),
    current_dir.join("dist").join(&normalized),
  ];

  if let Some(parent) = current_parent {
    candidates.push(parent.join("public").join(&normalized));
    candidates.push(parent.join("dist").join(&normalized));
  }

  if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
    return Ok(path);
  }

  let asset_key = normalized.to_string_lossy().replace('\\', "/");
  let asset = app
    .asset_resolver()
    .get(asset_key.clone())
    .ok_or_else(|| format!("Notification icon asset was not found: {asset_key}"))?;

  let cache_dir = app
    .path()
    .app_cache_dir()
    .map_err(|error| error.to_string())?
    .join("notification-icons");
  std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;

  let file_name = normalized
    .file_name()
    .ok_or_else(|| "Notification icon path has no file name".to_string())?;
  let cached_path = cache_dir.join(file_name);
  std::fs::write(&cached_path, asset.bytes).map_err(|error| error.to_string())?;

  Ok(cached_path)
}

#[tauri::command]
fn send_native_notification(
  app: AppHandle,
  title: String,
  body: String,
  url: Option<String>,
  icon: Option<String>,
) -> Result<(), String> {
  #[cfg(windows)]
  {
    use tauri_plugin_opener::OpenerExt;
    use tauri_winrt_notification::{Duration, IconCrop, Toast};

    let icon_path = icon
      .as_deref()
      .map(|path| asset_file_path(&app, path))
      .transpose()?;
    let app_icon_path = asset_file_path(&app, "favicon.png").ok();

    register_windows_app_identity(app_icon_path)?;

    let app_for_click = app.clone();
    let click_url = url.clone();
    let mut toast = Toast::new(WINDOWS_APP_ID)
      .title(&title)
      .text1(&body)
      .duration(Duration::Short);

    if let Some(icon_path) = icon_path {
      toast = toast.icon(&icon_path, IconCrop::Square, &title);
    }

    toast
      .on_activated(move |_| {
        if let Some(url) = &click_url {
          let _ = app_for_click.opener().open_url(url, None::<&str>);
        }
        Ok(())
      })
      .show()
      .map_err(|error| error.to_string())
  }

  #[cfg(not(windows))]
  {
    let _ = (app, title, body, url, icon);
    Err("Native status-icon notifications are only implemented on Windows".to_string())
  }
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![send_native_notification])
    .setup(|app| {
      let single_instance_guard = create_single_instance_guard(app.handle())?;
      app.manage(single_instance_guard);

      let app_icon_path = asset_file_path(app.handle(), "favicon.png").ok();
      let _ = register_windows_app_identity(app_icon_path);

      let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
      let check_now = MenuItem::with_id(app, "check_now", "Check now", true, None::<&str>)?;
      let pause_resume =
        MenuItem::with_id(app, "pause_resume", "Pause / Resume", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

      let tray_menu = Menu::with_items(app, &[&open, &check_now, &pause_resume, &quit])?;
      if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(tray_menu))?;
      }

      if std::env::var("BUILDIFY_START_MINIMIZED").as_deref() == Ok("1") {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.hide();
        }
      }

      Ok(())
    })
    .on_menu_event(|app, event| match event.id().as_ref() {
      "open" => {
        show_main_window(app);
      }
      "check_now" => {
        let _ = app.emit("tray-check-now", ());
      }
      "pause_resume" => {
        let _ = app.emit("tray-toggle-pause", ());
      }
      "quit" => {
        app.exit(0);
      }
      _ => {}
    })
    .on_window_event(|window, event| match event {
      WindowEvent::CloseRequested { api, .. } => {
        api.prevent_close();
        let _ = window.hide();
      }
      _ => {}
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
