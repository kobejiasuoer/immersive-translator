fn main() {
    tauri_plugin::Builder::new(&["status", "request", "replace", "take_action", "ack_action", "test"])
        .ios_path("ios")
        .build();
}
