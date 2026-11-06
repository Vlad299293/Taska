mod cowork;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .manage(cowork::CoworkState::default())
    .invoke_handler(tauri::generate_handler![
      cowork::cowork_host_start,
      cowork::cowork_host_stop,
      cowork::cowork_send,
      cowork::cowork_kick,
      cowork::cowork_scan,
      cowork::cowork_local_addresses
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
