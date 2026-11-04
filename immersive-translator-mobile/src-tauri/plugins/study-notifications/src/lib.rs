use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_study_notifications);

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn status() -> serde_json::Value {
    serde_json::json!({ "supported": false, "permission": "unavailable", "scheduled": 0 })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("study-notifications");
    #[cfg(not(target_os = "ios"))]
    let builder = builder.invoke_handler(tauri::generate_handler![status]);
    builder.setup(|_app, _api| {
        #[cfg(target_os = "ios")]
        _api.register_ios_plugin(init_plugin_study_notifications)?;
        Ok(())
    }).build()
}
