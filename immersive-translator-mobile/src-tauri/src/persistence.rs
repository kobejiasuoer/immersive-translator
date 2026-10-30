//! Account-isolated durable storage. This module has no WebView/Tauri dependency.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub type StorageResult<T> = Result<T, String>;
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn db_err(e: impl std::fmt::Display) -> String {
    format!("STORAGE: {e}")
}
pub fn validate_key(value: &str, kind: &str) -> StorageResult<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(format!("INVALID_{kind}"));
    }
    Ok(())
}
pub fn identity_directory(root: &Path, identity: &str) -> StorageResult<PathBuf> {
    validate_key(identity, "IDENTITY")?;
    let digest = Sha256::digest(identity.as_bytes());
    let key: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(root.join("profiles").join(key))
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: i64,
    pub state: Option<Value>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub collection: String,
    pub id: String,
    pub payload: Option<Value>,
    pub version: i64,
    pub deleted: bool,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordWrite {
    pub collection: String,
    pub id: String,
    pub payload: Option<Value>,
    pub expected_version: Option<i64>,
    #[serde(default)]
    pub deleted: bool,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub payload: Value,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub id: String,
    pub payload: Value,
    #[serde(default)]
    pub created_at: i64,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub expected_revision: i64,
    pub state: Option<Value>,
    #[serde(default)]
    pub records: Vec<RecordWrite>,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub outbox: Vec<OutboxItem>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub revision: i64,
    pub already_applied: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    pub migration_id: String,
    pub entries: BTreeMap<String, Option<String>>,
    pub state: Value,
    #[serde(default)]
    pub records: Vec<RecordWrite>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub revision: i64,
    pub migrated: bool,
}

pub struct Store {
    pub connection: Connection,
    pub directory: PathBuf,
}
impl Store {
    pub fn open(root: &Path, identity: &str) -> StorageResult<Self> {
        let directory = identity_directory(root, identity)?;
        std::fs::create_dir_all(&directory).map_err(db_err)?;
        let connection = Connection::open(directory.join("state.sqlite3")).map_err(db_err)?;
        let schema: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(db_err)?;
        if schema > 1 {
            return Err(format!("STORAGE_SCHEMA_TOO_NEW:{schema}"));
        }
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_err)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT);
            INSERT OR IGNORE INTO snapshot(id,revision,state) VALUES(1,0,NULL);
            CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL,id TEXT NOT NULL,payload TEXT,version INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(collection,id));
            CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY,completed_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS migration_backups (migration_id TEXT NOT NULL,entry_key TEXT NOT NULL,raw_value TEXT,PRIMARY KEY(migration_id,entry_key));
            CREATE TABLE IF NOT EXISTS audio_clips (clip_id TEXT PRIMARY KEY,status TEXT NOT NULL,byte_length INTEGER NOT NULL DEFAULT 0,next_sequence INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL,updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS audio_chunks (clip_id TEXT NOT NULL,sequence INTEGER NOT NULL,byte_length INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(clip_id,sequence),FOREIGN KEY(clip_id) REFERENCES audio_clips(clip_id) ON DELETE CASCADE);
            PRAGMA user_version=1;").map_err(db_err)?;
        Ok(Self {
            connection,
            directory,
        })
    }
    pub fn snapshot(&self) -> StorageResult<Snapshot> {
        let (revision, state): (i64, Option<String>) = self
            .connection
            .query_row("SELECT revision,state FROM snapshot WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(db_err)?;
        Ok(Snapshot {
            revision,
            state: state
                .map(|s| serde_json::from_str(&s).map_err(db_err))
                .transpose()?,
        })
    }
    pub fn commit(&mut self, input: Commit) -> StorageResult<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let revision: i64 = tx
            .query_row("SELECT revision FROM snapshot WHERE id=1", [], |r| r.get(0))
            .map_err(db_err)?;
        let mut duplicate = 0;
        for event in &input.events {
            validate_key(&event.event_id, "EVENT_ID")?;
            if let Some(prior) = tx
                .query_row(
                    "SELECT payload FROM events WHERE event_id=?",
                    [&event.event_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(db_err)?
            {
                if serde_json::from_str::<Value>(&prior).map_err(db_err)? != event.payload {
                    return Err("EVENT_ID_COLLISION".into());
                }
                duplicate += 1;
            }
        }
        if duplicate > 0 {
            if duplicate != input.events.len() {
                return Err("MIXED_EVENT_RETRY: submit each event separately".into());
            }
            return Ok(CommitResult {
                revision,
                already_applied: true,
            });
        }
        if revision != input.expected_revision {
            return Err(format!("REVISION_CONFLICT:{revision}"));
        }
        for record in &input.records {
            write_record(&tx, record)?;
        }
        for event in &input.events {
            tx.execute(
                "INSERT INTO events(event_id,payload) VALUES(?,?)",
                params![event.event_id, event.payload.to_string()],
            )
            .map_err(db_err)?;
        }
        for item in &input.outbox {
            validate_key(&item.id, "OUTBOX_ID")?;
            let prior: Option<String> = tx
                .query_row("SELECT payload FROM outbox WHERE id=?", [&item.id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(db_err)?;
            if let Some(prior) = prior {
                if serde_json::from_str::<Value>(&prior).map_err(db_err)? != item.payload {
                    return Err("OUTBOX_ID_COLLISION".into());
                }
            } else {
                tx.execute(
                    "INSERT INTO outbox(id,payload,created_at) VALUES(?,?,?)",
                    params![
                        item.id,
                        item.payload.to_string(),
                        if item.created_at == 0 {
                            now_ms()
                        } else {
                            item.created_at
                        }
                    ],
                )
                .map_err(db_err)?;
            }
        }
        let next = revision.checked_add(1).ok_or("REVISION_OVERFLOW")?;
        if let Some(state) = input.state {
            tx.execute(
                "UPDATE snapshot SET revision=?,state=? WHERE id=1",
                params![next, state.to_string()],
            )
            .map_err(db_err)?;
        } else {
            tx.execute("UPDATE snapshot SET revision=? WHERE id=1", [next])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(CommitResult {
            revision: next,
            already_applied: false,
        })
    }
    pub fn record(&self, collection: &str, id: &str) -> StorageResult<Option<Record>> {
        self.connection
            .query_row(
                "SELECT payload,version,deleted FROM records WHERE collection=? AND id=?",
                params![collection, id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?
            .map(|(payload, version, deleted)| {
                Ok(Record {
                    collection: collection.into(),
                    id: id.into(),
                    payload: payload
                        .map(|p| serde_json::from_str(&p).map_err(db_err))
                        .transpose()?,
                    version,
                    deleted,
                })
            })
            .transpose()
    }
    pub fn list_records(&self, collection: &str) -> StorageResult<Vec<Record>> {
        let mut query = self
            .connection
            .prepare(
                "SELECT id,payload,version,deleted FROM records WHERE collection=? ORDER BY id",
            )
            .map_err(db_err)?;
        let rows = query
            .query_map([collection], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, payload, version, deleted) = row.map_err(db_err)?;
            out.push(Record {
                collection: collection.into(),
                id,
                payload: payload
                    .map(|p| serde_json::from_str(&p).map_err(db_err))
                    .transpose()?,
                version,
                deleted,
            });
        }
        Ok(out)
    }
    pub fn events(&self) -> StorageResult<Vec<Event>> {
        let mut q = self
            .connection
            .prepare("SELECT event_id,payload FROM events ORDER BY event_id")
            .map_err(db_err)?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(db_err)?;
        rows.map(|row| {
            let (event_id, payload) = row.map_err(db_err)?;
            Ok(Event {
                event_id,
                payload: serde_json::from_str(&payload).map_err(db_err)?,
            })
        })
        .collect()
    }
    pub fn outbox(&self, limit: usize) -> StorageResult<Vec<OutboxItem>> {
        let mut q = self
            .connection
            .prepare("SELECT id,payload,created_at FROM outbox ORDER BY created_at,id LIMIT ?")
            .map_err(db_err)?;
        let rows = q
            .query_map([limit.min(1000) as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(db_err)?;
        rows.map(|row| {
            let (id, payload, created_at) = row.map_err(db_err)?;
            Ok(OutboxItem {
                id,
                payload: serde_json::from_str(&payload).map_err(db_err)?,
                created_at,
            })
        })
        .collect()
    }
    pub fn ack_outbox(&mut self, ids: &[String]) -> StorageResult<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        for id in ids {
            tx.execute("DELETE FROM outbox WHERE id=?", [id])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }
    pub fn migrate(&mut self, input: Migration) -> StorageResult<MigrationResult> {
        validate_key(&input.migration_id, "MIGRATION_ID")?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let revision: i64 = tx
            .query_row("SELECT revision FROM snapshot WHERE id=1", [], |r| r.get(0))
            .map_err(db_err)?;
        if tx
            .query_row(
                "SELECT 1 FROM migrations WHERE id=?",
                [&input.migration_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(db_err)?
            .is_some()
        {
            return Ok(MigrationResult {
                revision,
                migrated: false,
            });
        }
        if revision != 0 {
            return Err("MIGRATION_TARGET_NOT_EMPTY".into());
        }
        for (key, value) in input.entries {
            tx.execute(
                "INSERT INTO migration_backups(migration_id,entry_key,raw_value) VALUES(?,?,?)",
                params![input.migration_id, key, value],
            )
            .map_err(db_err)?;
        }
        for record in &input.records {
            write_record(&tx, record)?;
        }
        tx.execute(
            "UPDATE snapshot SET revision=1,state=? WHERE id=1",
            [input.state.to_string()],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO migrations(id,completed_at) VALUES(?,?)",
            params![input.migration_id, now_ms()],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(MigrationResult {
            revision: 1,
            migrated: true,
        })
    }
}
fn write_record(tx: &rusqlite::Transaction<'_>, record: &RecordWrite) -> StorageResult<()> {
    validate_key(&record.collection, "COLLECTION")?;
    validate_key(&record.id, "RECORD_ID")?;
    let version: i64 = tx
        .query_row(
            "SELECT version FROM records WHERE collection=? AND id=?",
            params![record.collection, record.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?
        .unwrap_or(0);
    if let Some(expected) = record.expected_version {
        if expected != version {
            return Err(format!("RECORD_VERSION_CONFLICT:{version}"));
        }
    }
    tx.execute("INSERT INTO records(collection,id,payload,version,deleted) VALUES(?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,version=excluded.version,deleted=excluded.deleted",params![record.collection,record.id,record.payload.as_ref().map(Value::to_string),version+1,record.deleted]).map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn root() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "ita-db-test-{}-{}-{}",
            std::process::id(),
            now_ms(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    fn commit(rev: i64) -> Commit {
        Commit {
            expected_revision: rev,
            state: Some(json!({"words":[1]})),
            records: vec![],
            events: vec![],
            outbox: vec![],
        }
    }
    #[test]
    fn identity_and_revision_are_isolated() {
        let root = root();
        let mut guest = Store::open(&root, "guest").unwrap();
        guest.commit(commit(0)).unwrap();
        assert!(guest
            .commit(commit(0))
            .unwrap_err()
            .starts_with("REVISION_CONFLICT"));
        assert!(Store::open(&root, "user/../different")
            .unwrap()
            .snapshot()
            .unwrap()
            .state
            .is_none());
        drop(guest);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn event_retry_is_idempotent_and_atomic() {
        let root = root();
        let mut db = Store::open(&root, "user").unwrap();
        let mut input = commit(0);
        input.events.push(Event {
            event_id: "event-1".into(),
            payload: json!({"grade":"good"}),
        });
        input.outbox.push(OutboxItem {
            id: "event-1".into(),
            payload: json!({"a":1}),
            created_at: 1,
        });
        assert_eq!(db.commit(input.clone()).unwrap().revision, 1);
        assert!(db.commit(input).unwrap().already_applied);
        assert_eq!(db.events().unwrap().len(), 1);
        assert_eq!(db.outbox(10).unwrap().len(), 1);
        let mut bad = commit(1);
        bad.records.push(RecordWrite {
            collection: "notes".into(),
            id: "n".into(),
            payload: Some(json!(1)),
            expected_version: Some(9),
            deleted: false,
        });
        assert!(db.commit(bad).is_err());
        assert_eq!(db.snapshot().unwrap().revision, 1);
        assert!(db.record("notes", "n").unwrap().is_none());
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn migration_is_atomic_and_repeatable() {
        let root = root();
        let mut db = Store::open(&root, "guest").unwrap();
        let input = || Migration {
            migration_id: "v3".into(),
            entries: BTreeMap::from([("old".into(), Some("raw".into()))]),
            state: json!({"dueAt":42}),
            records: vec![],
        };
        assert!(db.migrate(input()).unwrap().migrated);
        assert!(!db.migrate(input()).unwrap().migrated);
        assert_eq!(db.snapshot().unwrap().state.unwrap()["dueAt"], 42);
        let count: i64 = db
            .connection
            .query_row("SELECT COUNT(*) FROM migration_backups", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn late_transaction_failure_rolls_back_all_mutations() {
        let root = root();
        let mut db = Store::open(&root, "user").unwrap();
        let mut first = commit(0);
        first.outbox.push(OutboxItem {
            id: "queued".into(),
            payload: json!(1),
            created_at: 1,
        });
        db.commit(first).unwrap();
        let mut bad = commit(1);
        bad.records.push(RecordWrite {
            collection: "notes".into(),
            id: "new".into(),
            payload: Some(json!(2)),
            expected_version: None,
            deleted: false,
        });
        bad.events.push(Event {
            event_id: "event-new".into(),
            payload: json!(3),
        });
        bad.outbox.push(OutboxItem {
            id: "queued".into(),
            payload: json!(4),
            created_at: 1,
        });
        assert_eq!(db.commit(bad).unwrap_err(), "OUTBOX_ID_COLLISION");
        assert!(db.record("notes", "new").unwrap().is_none());
        assert!(db.events().unwrap().is_empty());
        assert_eq!(db.snapshot().unwrap().revision, 1);
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn failed_migration_does_not_leave_backup_or_completion_marker() {
        let root = root();
        let mut db = Store::open(&root, "guest").unwrap();
        let input = Migration {
            migration_id: "bad".into(),
            entries: BTreeMap::from([("old".into(), Some("raw".into()))]),
            state: json!(1),
            records: vec![RecordWrite {
                collection: "".into(),
                id: "n".into(),
                payload: None,
                expected_version: None,
                deleted: false,
            }],
        };
        assert!(db.migrate(input).is_err());
        assert_eq!(db.snapshot().unwrap().revision, 0);
        for table in ["migrations", "migration_backups", "records"] {
            let count: i64 = db
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0);
        }
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn newer_schema_is_rejected_without_downgrade() {
        let root = root();
        let db = Store::open(&root, "user").unwrap();
        db.connection
            .pragma_update(None, "user_version", 9)
            .unwrap();
        drop(db);
        assert!(
            matches!(Store::open(&root, "user"), Err(error) if error == "STORAGE_SCHEMA_TOO_NEW:9")
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
