fn main() {
  println!("cargo:rerun-if-changed=icons/icon.ico");
  println!("cargo:rerun-if-changed=icons/icon.png");
  println!("cargo:rerun-if-changed=icons/tray.ico");
  println!("cargo:rerun-if-changed=icons/tray.png");

  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(tauri_build::AppManifest::new().commands(&["send_native_notification"])),
  )
  .expect("failed to run tauri build script")
}
