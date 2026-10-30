use crate::{
    audio_store,
    persistence::{
        Commit, CommitResult, Event, Migration, MigrationResult, OutboxItem, Record, Snapshot,
        Store,
    },
};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
// Serializes file + manifest operations; SQLite additionally guards database revisions.
static STORAGE_LOCK: Mutex<()> = Mutex::new(());
static INITIALIZED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
fn with_store<T>(
    app: &tauri::AppHandle,
    identity: &str,
    f: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "STORAGE_LOCK_UNAVAILABLE")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("STORAGE_ROOT: {e}"))?;
    let mut db = Store::open(&root, identity)?;
    f(&mut db)
}
#[tauri::command]
pub fn persistence_initialize(app: tauri::AppHandle, identity: String) -> Result<Snapshot, String> {
    with_store(&app, &identity, |db| {
        let mut initialized = INITIALIZED
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| "STORAGE_INITIALIZATION_LOCK_UNAVAILABLE")?;
        if !initialized.contains(&db.directory) {
            audio_store::recover(db)?;
            initialized.insert(db.directory.clone());
        }
        db.snapshot()
    })
}
#[tauri::command]
pub fn persistence_load(app: tauri::AppHandle, identity: String) -> Result<Snapshot, String> {
    with_store(&app, &identity, |db| db.snapshot())
}
#[tauri::command]
pub fn persistence_commit(
    app: tauri::AppHandle,
    identity: String,
    input: Commit,
) -> Result<CommitResult, String> {
    with_store(&app, &identity, |db| db.commit(input))
}
#[tauri::command]
pub fn persistence_migrate(
    app: tauri::AppHandle,
    identity: String,
    input: Migration,
) -> Result<MigrationResult, String> {
    with_store(&app, &identity, |db| db.migrate(input))
}
#[tauri::command]
pub fn persistence_record(
    app: tauri::AppHandle,
    identity: String,
    collection: String,
    id: String,
) -> Result<Option<Record>, String> {
    with_store(&app, &identity, |db| db.record(&collection, &id))
}
#[tauri::command]
pub fn persistence_records(
    app: tauri::AppHandle,
    identity: String,
    collection: String,
) -> Result<Vec<Record>, String> {
    with_store(&app, &identity, |db| db.list_records(&collection))
}
#[tauri::command]
pub fn persistence_events(app: tauri::AppHandle, identity: String) -> Result<Vec<Event>, String> {
    with_store(&app, &identity, |db| db.events())
}
#[tauri::command]
pub fn persistence_outbox(
    app: tauri::AppHandle,
    identity: String,
    limit: Option<usize>,
) -> Result<Vec<OutboxItem>, String> {
    with_store(&app, &identity, |db| db.outbox(limit.unwrap_or(100)))
}
#[tauri::command]
pub fn persistence_ack_outbox(
    app: tauri::AppHandle,
    identity: String,
    ids: Vec<String>,
) -> Result<(), String> {
    with_store(&app, &identity, |db| db.ack_outbox(&ids))
}
#[tauri::command]
pub fn audio_clip_begin(
    app: tauri::AppHandle,
    identity: String,
    clip_id: String,
    metadata: Value,
) -> Result<audio_store::AudioManifest, String> {
    with_store(&app, &identity, |db| {
        audio_store::begin(db, &clip_id, metadata)
    })
}
#[tauri::command]
pub fn audio_clip_append(
    app: tauri::AppHandle,
    identity: String,
    clip_id: String,
    sequence: i64,
    pcm_b64: String,
) -> Result<audio_store::AudioManifest, String> {
    with_store(&app, &identity, |db| {
        audio_store::append(db, &clip_id, sequence, &pcm_b64)
    })
}
#[tauri::command]
pub fn audio_clip_finalize(
    app: tauri::AppHandle,
    identity: String,
    clip_id: String,
) -> Result<audio_store::AudioManifest, String> {
    with_store(&app, &identity, |db| audio_store::finalize(db, &clip_id))
}
#[tauri::command]
pub fn audio_clip_read(
    app: tauri::AppHandle,
    identity: String,
    clip_id: String,
) -> Result<audio_store::AudioRead, String> {
    with_store(&app, &identity, |db| audio_store::read(db, &clip_id))
}
#[tauri::command]
pub fn audio_clip_delete(
    app: tauri::AppHandle,
    identity: String,
    clip_id: String,
) -> Result<(), String> {
    with_store(&app, &identity, |db| audio_store::delete(db, &clip_id))
}
#[tauri::command]
pub fn audio_clip_manifest(
    app: tauri::AppHandle,
    identity: String,
    clip_id: String,
) -> Result<Option<audio_store::AudioManifest>, String> {
    with_store(&app, &identity, |db| audio_store::manifest(db, &clip_id))
}
