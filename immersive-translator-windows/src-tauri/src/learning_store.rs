//! SQLite is authoritative; legacy JSON/Markdown files remain readable exports.
//! A domain file snapshot and its outbox changes commit in one transaction.
use crate::sync::StoredSyncEntity;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
static LOCK: Mutex<()> = Mutex::new(());
static APP: OnceLock<AppHandle> = OnceLock::new();
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}
pub fn read_path(path: &Path) -> Result<String, std::io::Error> {
    if let Some(app) = APP.get() {
        read(app, path)
    } else {
        std::fs::read_to_string(path)
    }
}
pub fn list_paths(app: &AppHandle, dir: &Path) -> Result<Vec<PathBuf>, String> {
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    verify_path(app, dir, &namespace())?;
    let db = connection(app)?;
    let mut result = std::collections::BTreeSet::new();
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            result.insert(entry.map_err(|e| e.to_string())?.path());
        }
    }
    let mut stmt = db
        .prepare("SELECT path,content FROM files WHERE namespace=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([namespace()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, content) = row.map_err(|e| e.to_string())?;
        let path = PathBuf::from(path);
        if path.parent() == Some(dir) {
            if content.is_some() {
                result.insert(path);
            } else {
                result.remove(&path);
            }
        }
    }
    Ok(result.into_iter().collect())
}
pub fn write_path(path: &Path, content: &str) -> Result<(), String> {
    if let Some(app) = APP.get() {
        commit(app, path, Some(content))
    } else {
        std::fs::write(path, content).map_err(|e| e.to_string())
    }
}
static NAMESPACE: OnceLock<Mutex<String>> = OnceLock::new();
pub fn set_account(user: Option<&str>) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let name = user
        .map(|s| {
            format!(
                "account-{}",
                s.as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            )
        })
        .unwrap_or_else(|| "guest".into());
    if let Ok(mut ns) = NAMESPACE.get_or_init(|| Mutex::new("guest".into())).lock() {
        *ns = name;
    }
}
pub fn account_namespace(user: &str) -> String {
    format!(
        "account-{}",
        user.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
pub fn verify_namespace(expected: Option<&str>) -> Result<(), String> {
    if expected.is_some_and(|value| value != namespace()) {
        return Err("账号已切换，本次操作已取消".into());
    }
    Ok(())
}
#[tauri::command]
pub fn learning_namespace() -> String {
    namespace()
}
pub fn namespace() -> String {
    NAMESPACE
        .get_or_init(|| Mutex::new("guest".into()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_dir_for(app, &namespace())
}
fn data_dir_for(app: &AppHandle, ns: &str) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = if ns == "guest" {
        root
    } else {
        root.join("learning").join(ns)
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn verify_path(app: &AppHandle, path: &Path, ns: &str) -> Result<(), String> {
    let root = data_dir_for(app, ns)?;
    if !path.starts_with(&root)
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || ns == "guest" && path.starts_with(root.join("learning"))
    {
        return Err("账号已切换，原学习路径的操作已取消".into());
    }
    Ok(())
}
fn connection(app: &AppHandle) -> Result<Connection, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    open(&root.join("learning.sqlite3"))
}
fn open(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS files(namespace TEXT NOT NULL,path TEXT NOT NULL,content TEXT,PRIMARY KEY(namespace,path)); CREATE TABLE IF NOT EXISTS entities(namespace TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,collection,id)); CREATE TABLE IF NOT EXISTS cursors(namespace TEXT NOT NULL,collection TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(namespace,collection));").map_err(|e|e.to_string())?;
    Ok(db)
}
fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
pub fn read(app: &AppHandle, path: &Path) -> Result<String, std::io::Error> {
    let _guard = LOCK
        .lock()
        .map_err(|_| std::io::Error::other("learning lock"))?;
    verify_path(app, path, &namespace()).map_err(std::io::Error::other)?;
    let db = connection(app).map_err(std::io::Error::other)?;
    let mut stmt = db
        .prepare("SELECT content FROM files WHERE namespace=?1 AND path=?2")
        .map_err(std::io::Error::other)?;
    let mut rows = stmt
        .query(params![namespace(), key(path)])
        .map_err(std::io::Error::other)?;
    if let Some(row) = rows.next().map_err(std::io::Error::other)? {
        return row
            .get::<_, Option<String>>(0)
            .map_err(std::io::Error::other)?
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound));
    }
    std::fs::read_to_string(path)
}
pub fn device_id(app: &AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("learning_device_id");
    match std::fs::read_to_string(&path) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        Ok(_) => Err("Empty device id".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = format!("windows-{:x}-{:x}", std::process::id(), now());
            std::fs::write(path, &id).map_err(|e| e.to_string())?;
            Ok(id)
        }
        Err(e) => Err(e.to_string()),
    }
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn preserve_practice_tasks(old: &Value, next: &mut Value) {
    if let (Some(before), Some(after)) = (
        old.get("sessions").and_then(Value::as_array),
        next.get_mut("sessions").and_then(Value::as_array_mut),
    ) {
        for task in before
            .iter()
            .filter(|row| row.get("kind").and_then(Value::as_str) == Some("practice-task"))
        {
            if !after.iter().any(|row| row.get("id") == task.get("id")) {
                after.push(task.clone());
            }
        }
    }
}
fn merge_unknown(old: &Value, new: &mut Value) {
    match (old, new) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                if let Some(n) = b.get_mut(k) {
                    merge_unknown(v, n)
                } else {
                    b.insert(k.clone(), v.clone());
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for n in b {
                let found = a.iter().find(|o| {
                    o.get("id").is_some() && o.get("id") == n.get("id")
                        || o.get("idx").is_some() && o.get("idx") == n.get("idx")
                });
                if let Some(o) = found {
                    merge_unknown(o, n);
                }
            }
        }
        _ => {}
    }
}
fn practice_time(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0).max(0)
}
type PracticeRegisters = std::collections::BTreeMap<String, (i64, Option<Value>)>;
fn practice_escape(key: &str) -> String { key.replace('~', "~0").replace('/', "~1") }
fn practice_parts(path: &str) -> Vec<String> { path[1..].split('/').map(|p| p.replace("~1", "/").replace("~0", "~")).collect() }
fn practice_flatten(row: &Value) -> std::collections::BTreeMap<String, Value> {
    fn visit(value: &Value, path: String, out: &mut std::collections::BTreeMap<String, Value>) {
        if let Some(fields) = value.as_object().filter(|o| !o.is_empty()) {
            for (key, value) in fields { visit(value, format!("{}/{}", path, practice_escape(key)), out); }
        } else { out.insert(path, value.clone()); }
    }
    let mut out = std::collections::BTreeMap::new();
    if let Some(fields) = row.as_object() { for (key, value) in fields {
        if !matches!(key.as_str(), "updatedAt" | "fieldUpdatedAt" | "fieldShadow" | "attempts" | "removedAttemptIds") { visit(value, format!("/{}", practice_escape(key)), &mut out); }
    } }
    out
}
fn practice_registers(row: &Value, fallback: i64) -> PracticeRegisters {
    let mut values = practice_flatten(row);
    if let Some(shadows) = row.get("fieldShadow").and_then(Value::as_object) {
        for (path, value) in shadows { if path.starts_with('/') { values.insert(path.clone(), value.clone()); } }
    }
    let clocks = row.get("fieldUpdatedAt").and_then(Value::as_object);
    let mut result = PracticeRegisters::new();
    for (path, value) in values {
        let root = practice_parts(&path)[0].clone();
        let explicit = practice_time(clocks.and_then(|c| c.get(&path)));
        let legacy = practice_time(clocks.and_then(|c| c.get(&root)));
        result.insert(path, (if explicit > 0 { explicit } else if legacy > 0 { legacy } else { fallback }, Some(value)));
    }
    if let Some(clocks) = clocks { for (key, at) in clocks {
        let path = if key.starts_with('/') { key.clone() } else { format!("/{}", practice_escape(key)) };
        if !result.contains_key(&path) && (key.starts_with('/') || row.get(key).is_none()) { result.insert(path, (practice_time(Some(at)), None)); }
    } }
    result
}
fn practice_rank(a: &(i64, Option<Value>), b: &(i64, Option<Value>)) -> std::cmp::Ordering {
    a.0.cmp(&b.0).then_with(|| a.1.as_ref().map(canonical).unwrap_or_else(|| "􏿿".into()).cmp(&b.1.as_ref().map(canonical).unwrap_or_else(|| "􏿿".into())))
}
fn practice_materialize(regs: &PracticeRegisters, updated_at: i64) -> Value {
    let blocked = |path: &str, reg: &(i64, Option<Value>)| regs.iter().any(|(p,r)| path.starts_with(&format!("{}/", p)) && !practice_rank(r,reg).is_lt());
    let mut visible = std::collections::BTreeMap::new();
    for (path, reg) in regs {
        if reg.1.is_none() || blocked(path,reg) { continue; }
        let descendant = regs.iter().any(|(p,r)| p.starts_with(&format!("{}/",path)) && r.1.is_some() && practice_rank(r,reg).is_gt() && !blocked(p,r));
        if !descendant { visible.insert(path.clone(), reg.1.as_ref().unwrap().clone()); }
    }
    let mut result = json!({});
    for (path,value) in &visible {
        let parts = practice_parts(path); let mut target = &mut result;
        for key in &parts[..parts.len()-1] {
            if !target.is_object() { *target = json!({}); }
            if !target.get(key).map(Value::is_object).unwrap_or(false) { target[key] = json!({}); }
            target = &mut target[key];
        }
        target[&parts[parts.len()-1]] = value.clone();
    }
    let mut clocks = serde_json::Map::new(); let mut shadows = serde_json::Map::new(); let mut latest = updated_at;
    for (path, (at, value)) in regs {
        clocks.insert(path.clone(), json!(at)); latest = latest.max(*at);
        if !visible.contains_key(path) { if let Some(value) = value { shadows.insert(path.clone(), value.clone()); } }
    }
    result["updatedAt"] = json!(latest); result["fieldUpdatedAt"] = Value::Object(clocks);
    if !shadows.is_empty() { result["fieldShadow"] = Value::Object(shadows); }
    result
}
fn merge_practice_fields(a: &Value, b: &Value, ta: i64, tb: i64) -> Value {
    let mut regs = practice_registers(a, ta);
    for (path, reg) in practice_registers(b, tb) {
        if regs.get(&path).map(|old| practice_rank(&reg,old).is_gt()).unwrap_or(true) { regs.insert(path, reg); }
    }
    practice_materialize(&regs,ta.max(tb).max(practice_time(a.get("updatedAt"))).max(practice_time(b.get("updatedAt"))))
}
fn merge_practice_payload(a: &Value, b: &Value) -> Option<Value> {
    if a.get("kind").and_then(Value::as_str) != Some("practice-task")
        || b.get("kind").and_then(Value::as_str) != Some("practice-task") { return None; }
    let (left, right) = (a.get("task")?, b.get("task")?);
    let id = left.get("id")?.as_str()?;
    if right.get("id").and_then(Value::as_str) != Some(id) { return None; }
    let ta = practice_time(left.get("updatedAt"));
    let tb = practice_time(right.get("updatedAt"));
    let mut task = merge_practice_fields(left, right, ta, tb);
    let mut removed = std::collections::BTreeSet::<String>::new();
    for row in [left, right] {
        if let Some(ids) = row.get("removedAttemptIds").and_then(Value::as_array) {
            removed.extend(ids.iter().filter_map(Value::as_str).map(String::from));
        }
    }
    let mut attempts = std::collections::BTreeMap::<String, Value>::new();
    for (row, fallback) in [(left, ta), (right, tb)] {
        if let Some(rows) = row.get("attempts").and_then(Value::as_array) { for attempt in rows {
            let Some(id) = attempt.get("id").and_then(Value::as_str) else { continue; };
            if removed.contains(id) { continue; }
            let at = practice_time(attempt.get("updatedAt"));
            let at = if at > 0 { at } else { fallback };
            let normalized = merge_practice_fields(attempt, attempt, at, at);
            let merged = attempts.get(id).map(|old| merge_practice_fields(old, &normalized, practice_time(old.get("updatedAt")), practice_time(normalized.get("updatedAt")))).unwrap_or(normalized);
            attempts.insert(id.to_string(), merged);
        } }
    }
    let mut rows = attempts.into_values().collect::<Vec<_>>();
    rows.sort_by(|a, b| practice_time(a.get("createdAt")).cmp(&practice_time(b.get("createdAt"))).then_with(|| a.get("id").and_then(Value::as_str).cmp(&b.get("id").and_then(Value::as_str))));
    task["attempts"] = Value::Array(rows);
    if !removed.is_empty() { task["removedAttemptIds"] = json!(removed); }
    let ea = practice_time(a.get("updatedAt"));
    let eb = practice_time(b.get("updatedAt"));
    let mut envelope_a = a.clone(); let mut envelope_b = b.clone();
    envelope_a.as_object_mut()?.remove("task"); envelope_b.as_object_mut()?.remove("task");
    envelope_a["endedAt"] = json!(ea.max(eb)); envelope_b["endedAt"] = json!(ea.max(eb));
    let mut result = merge_practice_fields(&envelope_a,&envelope_b,ea,eb);
    result["updatedAt"] = json!(ea.max(eb).max(practice_time(task.get("updatedAt"))));
    result["endedAt"] = result["updatedAt"].clone();
    result["task"] = task;
    Some(result)
}
fn merge_practice_entity(old: &StoredSyncEntity, incoming: &StoredSyncEntity) -> Option<StoredSyncEntity> {
    let is_task = |e: &StoredSyncEntity| e.payload.as_ref().and_then(|p| p.get("kind")).and_then(Value::as_str) == Some("practice-task");
    if !is_task(old) && !is_task(incoming) { return None; }
    let mut result = incoming.clone();
    if incoming.deleted { return Some(result); }
    if old.deleted { result = old.clone(); result.base_version = old.base_version.max(incoming.base_version); result.dirty = true; return Some(result); }
    let payload = merge_practice_payload(old.payload.as_ref()?, incoming.payload.as_ref()?)?;
    result.dirty = incoming.dirty || incoming.payload.as_ref() != Some(&payload);
    result.payload = Some(payload);
    result.updated_at = old.updated_at.max(incoming.updated_at);
    result.base_version = old.base_version.max(incoming.base_version);
    Some(result)
}
pub fn list(
    app: &AppHandle,
    collection: &str,
    expected_namespace: Option<&str>,
) -> Result<Vec<StoredSyncEntity>, String> {
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    verify_namespace(expected_namespace)?;
    list_db(&connection(app)?, &namespace(), collection)
}
fn list_db(db: &Connection, ns: &str, collection: &str) -> Result<Vec<StoredSyncEntity>, String> {
    let mut stmt = db
        .prepare("SELECT body FROM entities WHERE namespace=?1 AND collection=?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![ns, collection], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
fn put_db(
    db: &Connection,
    ns: &str,
    collection: &str,
    entity: &StoredSyncEntity,
) -> Result<(), String> {
    db.execute("INSERT INTO entities(namespace,collection,id,body) VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,collection,id) DO UPDATE SET body=excluded.body",params![ns,collection,entity.id,serde_json::to_string(entity).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
fn snapshot(db: &Connection, ns: &str, path: &Path, value: &Value) -> Result<(), String> {
    db.execute("INSERT INTO files VALUES(?1,?2,?3) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",params![ns,key(path),serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
fn ensure_baseline(word: &mut Value) {
    if word.get("baseline").is_none() {
        word["baseline"] = word
            .get("srs")
            .cloned()
            .unwrap_or(json!({"ease":2.5,"intervalDays":0,"reps":0,"lapses":0,"dueAt":0}));
    }
    if word.get("baselineRecall").is_none() {
        word["baselineRecall"] = word
            .get("recall")
            .cloned()
            .unwrap_or(json!({"total":{"pass":0,"wrong":0,"trap":0},"byMode":{}}));
    }
    if word.get("generation").is_none() {
        word["generation"] = json!(format!(
            "legacy-{}",
            word.get("addedAt")
                .or_else(|| word.get("createdAt"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
        ));
    }
}
fn active_events(mut events: Vec<Value>) -> Vec<Value> {
    events.sort_by(|a, b| {
        a.get("reviewedAt")
            .and_then(Value::as_i64)
            .cmp(&b.get("reviewedAt").and_then(Value::as_i64))
            .then_with(|| {
                a.get("id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("id").and_then(Value::as_str))
            })
    });
    let mut disabled = std::collections::HashSet::new();
    for (i, event) in events.iter().enumerate().rev() {
        let id = event.get("id").and_then(Value::as_str).unwrap_or("");
        if disabled.contains(id) {
            continue;
        }
        let target = event
            .get(
                if event.get("kind").and_then(Value::as_str) == Some("undo") {
                    "reversesEventId"
                } else {
                    "supersedesEventId"
                },
            )
            .and_then(Value::as_str);
        if let Some(target) = target {
            if events[..i].iter().any(|p| {
                p.get("id").and_then(Value::as_str) == Some(target)
                    && p.get("kind").and_then(Value::as_str) == Some("grade")
                    && p.get("wordId") == event.get("wordId")
                    && generations_match(p.get("generation"), event.get("generation"))
            }) {
                disabled.insert(target.to_owned());
            }
        }
    }
    let mut roots = std::collections::HashMap::<String, String>::new();
    let mut winners = std::collections::HashMap::<String, Value>::new();
    for event in events {
        if event.get("kind").and_then(Value::as_str) != Some("grade") {
            continue;
        }
        let id = event
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let root = event
            .get("supersedesEventId")
            .and_then(Value::as_str)
            .and_then(|p| roots.get(p))
            .cloned()
            .unwrap_or(id.clone());
        roots.insert(id.clone(), root.clone());
        if !disabled.contains(&id) {
            winners.insert(root, event);
        }
    }
    let mut result: Vec<_> = winners.into_values().collect();
    result.sort_by(|a, b| {
        a.get("reviewedAt")
            .and_then(Value::as_i64)
            .cmp(&b.get("reviewedAt").and_then(Value::as_i64))
            .then_with(|| {
                a.get("id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("id").and_then(Value::as_str))
            })
    });
    result
}
fn generations_match(a: Option<&Value>, b: Option<&Value>) -> bool {
    a == b
        || a.is_none()
            && b.and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("legacy-"))
        || b.is_none()
            && a.and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("legacy-"))
}
fn reduce_word(word: &mut Value, events: &[Value]) {
    ensure_baseline(word);
    let mut srs = word["baseline"].clone();
    let mut recall = word["baselineRecall"].clone();
    if !recall.is_object() {
        recall = json!({"total":{"pass":0,"wrong":0,"trap":0},"byMode":{}});
    }
    let selected = events
        .iter()
        .filter(|event| {
            event.get("wordId") == word.get("id")
                && generations_match(event.get("generation"), word.get("generation"))
        })
        .cloned()
        .collect();
    for event in active_events(selected) {
        let grade = event.get("grade").and_then(Value::as_str).unwrap_or("");
        let (time, days, delta) = match grade {
            "forgot" => (600_000, 0.0, -0.2),
            "hard" => (86_400_000, 1.0, -0.15),
            "good" => (259_200_000, 3.0, 0.0),
            "easy" => (604_800_000, 7.0, 0.15),
            _ => continue,
        };
        srs["ease"] =
            json!((srs.get("ease").and_then(Value::as_f64).unwrap_or(2.5) + delta).clamp(1.3, 2.8));
        srs["intervalDays"] = json!(if grade == "forgot" {
            0.0
        } else {
            srs.get("intervalDays")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(days)
        });
        srs["reps"] = json!(srs.get("reps").and_then(Value::as_u64).unwrap_or(0) + 1);
        srs["lapses"] = json!(
            srs.get("lapses").and_then(Value::as_u64).unwrap_or(0) + u64::from(grade == "forgot")
        );
        srs["dueAt"] = json!(event.get("reviewedAt").and_then(Value::as_i64).unwrap_or(0) + time);
        if let (Some(bucket), Some(mode)) = (
            event.pointer("/recall/bucket").and_then(Value::as_str),
            event.get("mode").and_then(Value::as_str),
        ) {
            if matches!(bucket, "pass" | "wrong" | "trap") {
                if recall.get("total").is_none() {
                    recall["total"] = json!({});
                }
                if recall.get("byMode").is_none() {
                    recall["byMode"] = json!({});
                }
                if recall["byMode"].get(mode).is_none() {
                    recall["byMode"][mode] = json!({});
                }
                recall["total"][bucket] = json!(
                    recall["total"]
                        .get(bucket)
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + 1
                );
                recall["byMode"][mode][bucket] = json!(
                    recall["byMode"][mode]
                        .get(bucket)
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + 1
                );
                recall["lastAt"] = event["reviewedAt"].clone();
            }
        }
    }
    word["srs"] = srs;
    word["recall"] = recall;
}
fn hydrate_reviews(db: &Connection, ns: &str, app: &AppHandle) -> Result<(), String> {
    let path = data_dir_for(app, ns)?.join("reader_vocab.json");
    let Some(raw) = read_file_db(db, ns, &path)? else {
        return Ok(());
    };
    let mut file: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if file.get("baselineReviewLog").is_none() {
        file["baselineReviewLog"] = file
            .get("reviewLog")
            .cloned()
            .unwrap_or(json!({"schemaVersion":1,"days":[]}));
    }
    let events: Vec<_> = list_db(db, ns, "review-events")?
        .into_iter()
        .filter(|e| !e.deleted)
        .filter_map(|e| e.payload)
        .collect();
    if let Some(words) = file.get_mut("words").and_then(Value::as_array_mut) {
        for word in words {
            reduce_word(word, &events);
            if let Some(mut stored) = list_db(db, ns, "reading-vocab")?
                .into_iter()
                .find(|e| Some(e.id.as_str()) == word.get("id").and_then(Value::as_str))
            {
                stored.payload = Some(word.clone());
                put_db(db, ns, "reading-vocab", &stored)?;
            }
        }
    }
    let mut counts = std::collections::BTreeMap::<String, u64>::new();
    if let Some(days) = file
        .pointer("/baselineReviewLog/days")
        .and_then(Value::as_array)
    {
        for day in days {
            if let Some(key) = day.get("day").and_then(Value::as_str) {
                counts.insert(
                    key.to_owned(),
                    day.get("count").and_then(Value::as_u64).unwrap_or(0),
                );
            }
        }
    }
    for event in active_events(events) {
        if let Some(day) = event.get("day").and_then(Value::as_str) {
            *counts.entry(day.to_owned()).or_default() += 1;
        }
    }
    file["reviewLog"] = json!({"schemaVersion":1,"days":counts.into_iter().map(|(day,count)|json!({"day":day,"count":count})).collect::<Vec<_>>()});
    snapshot(db, ns, &path, &file)
}
fn hydrate(db: &Connection, ns: &str, app: &AppHandle, collection: &str) -> Result<(), String> {
    let dir = data_dir_for(app, ns)?;
    let all = list_db(db, ns, collection)?;
    let live: Vec<_> = all.iter().filter(|e| !e.deleted).collect();
    if collection == "reading-vocab" {
        let path = dir.join("reader_vocab.json");
        let mut file:Value=read_file_db(db,ns,&path)?.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(json!({"schemaVersion":1,"reviewLog":{"schemaVersion":1,"days":[]},"readingLog":[]}));
        file["words"] = Value::Array(live.iter().filter_map(|e| e.payload.clone()).collect());
        snapshot(db, ns, &path, &file)?;
        hydrate_reviews(db, ns, app)?;
    } else if collection == "review-events" {
        hydrate_reviews(db, ns, app)?;
    } else if collection == "reading-articles" {
        let mut articles = Vec::new();
        let mut books = Vec::new();
        for e in &live {
            let Some(p) = e.payload.as_ref() else {
                continue;
            };
            if p.get("kind").and_then(Value::as_str) == Some("book") {
                let mut b = p.clone();
                if let Some(chapters) = b.get_mut("chapters").and_then(Value::as_array_mut) {
                    for c in chapters {
                        if c.get("id").is_none() {
                            c["id"] = c.get("articleId").cloned().unwrap_or(Value::Null);
                        }
                    }
                }
                books.push(b);
                continue;
            }
            if p.get("kind").and_then(Value::as_str) != Some("article") {
                if p.get("sentences").is_some() {
                    articles.push(p.clone());
                }
                continue;
            }
            let Some(ids) = p.get("chunkIds").and_then(Value::as_array) else {
                continue;
            };
            let mut rows = Vec::new();
            let mut complete = true;
            for cid in ids {
                let chunk = live
                    .iter()
                    .find(|c| Some(c.id.as_str()) == cid.as_str())
                    .and_then(|c| c.payload.as_ref());
                match chunk {
                    Some(c) if c.get("contentRevision") == p.get("contentRevision") => {
                        if let Some(s) = c.get("sentences").and_then(Value::as_array) {
                            rows.extend(s.iter().cloned())
                        } else {
                            complete = false;
                        }
                    }
                    _ => complete = false,
                }
            }
            if !complete {
                let old_path = if let Some(book_id) = p.get("bookId").and_then(Value::as_str) {
                    dir.join("books").join(format!("{book_id}.json"))
                } else {
                    dir.join("reader_articles.json")
                };
                if let Some(raw) = read_file_db(db, ns, &old_path)? {
                    if let Ok(old) = serde_json::from_str::<Value>(&raw) {
                        if let Some(previous) = old
                            .get("articles")
                            .and_then(Value::as_array)
                            .and_then(|rows| {
                                rows.iter().find(|a| {
                                    a.get("id").and_then(Value::as_str) == Some(e.id.as_str())
                                })
                            })
                        {
                            articles.push(previous.clone());
                        }
                    }
                }
                continue;
            }
            let mut a = p.clone();
            let revision = p.get("contentRevision");
            let latest = live
                .iter()
                .filter_map(|c| c.payload.as_ref())
                .filter(|c| {
                    c.get("kind").and_then(Value::as_str) == Some("progress")
                        && c.get("articleId").and_then(Value::as_str) == Some(e.id.as_str())
                        && c.get("contentRevision") == revision
                })
                .max_by_key(|c| c.get("lastReadAt").and_then(Value::as_i64).unwrap_or(0));
            let locator = latest.and_then(|p| p.pointer("/locator/sentenceId"));
            let idx = rows
                .iter()
                .position(|s| s.get("id") == locator && locator.is_some())
                .unwrap_or(0);
            a["sentences"] = json!(rows);
            a["lastReadAt"] = latest
                .and_then(|p| p.get("lastReadAt"))
                .cloned()
                .unwrap_or(json!(0));
            a["progress"] = json!({"sentenceIdx":idx,"percent":latest.and_then(|p|p.get("percent")).cloned().unwrap_or(json!(0)),"secondsListened":latest.and_then(|p|p.get("secondsListened")).cloned().unwrap_or(json!(0))});
            articles.push(a);
        }
        let shorts: Vec<_> = articles
            .iter()
            .filter(|a| a.get("bookId").is_none() || a.get("bookId") == Some(&Value::Null))
            .cloned()
            .collect();
        snapshot(
            db,
            ns,
            &dir.join("reader_articles.json"),
            &json!({"schemaVersion":1,"articles":shorts}),
        )?;
        for b in &books {
            if let Some(id) = b.get("id").and_then(Value::as_str) {
                let chapters: Vec<_> = articles
                    .iter()
                    .filter(|a| a.get("bookId").and_then(Value::as_str) == Some(id))
                    .cloned()
                    .collect();
                let book_dir = dir.join("books");
                std::fs::create_dir_all(&book_dir).map_err(|e| e.to_string())?;
                snapshot(
                    db,
                    ns,
                    &book_dir.join(format!("{id}.json")),
                    &json!({"schemaVersion":1,"articles":chapters}),
                )?;
            }
        }
        snapshot(
            db,
            ns,
            &dir.join("reader_books.json"),
            &json!({"schemaVersion":1,"books":books}),
        )?;
    } else if collection == "notes" {
        for e in &all {
            if e.id.contains('/') || e.id.contains('\\') || e.id.contains(':') {
                continue;
            }
            let file = dir.join("notes").join(&e.id);
            if e.deleted {
                db.execute("INSERT INTO files VALUES(?1,?2,NULL) ON CONFLICT(namespace,path) DO UPDATE SET content=NULL",params![ns,key(&file)]).map_err(|e|e.to_string())?;
            } else if let Some(p) = e.payload.as_ref() {
                if let (Some(meta), Some(content)) =
                    (p.get("meta"), p.get("content").and_then(Value::as_str))
                {
                    let raw = format!(
                        "---\n{}\n---\n{content}",
                        serde_json::to_string(meta).map_err(|e| e.to_string())?
                    );
                    db.execute("INSERT INTO files VALUES(?1,?2,?3) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",params![ns,key(&file),raw]).map_err(|e|e.to_string())?;
                }
            }
        }
    } else if collection == "speak-sessions" {
        let sessions: Vec<Value> = live
            .iter()
            .filter_map(|e| e.payload.clone())
            .map(|mut p| {
                if p.get("createdAt").is_none() {
                    p["createdAt"] = p.get("startedAt").cloned().unwrap_or(json!(0));
                }
                if p.get("updatedAt").is_none() {
                    p["updatedAt"] = p.get("endedAt").cloned().unwrap_or(json!(0));
                }
                p
            })
            .collect();
        snapshot(
            db,
            ns,
            &dir.join("reader_speak_sessions.json"),
            &json!({"schemaVersion":1,"sessions":sessions}),
        )?;
    }
    Ok(())
}
fn read_file_db(db: &Connection, ns: &str, path: &Path) -> Result<Option<String>, String> {
    match db.query_row(
        "SELECT content FROM files WHERE namespace=?1 AND path=?2",
        params![ns, key(path)],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => match std::fs::read_to_string(path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}
fn merge_domain_files(existing: Option<&str>, incoming: &str) -> Result<String, String> {
    let Some(old) = existing else {
        return Ok(incoming.into());
    };
    let (Ok(mut result), Ok(value)) = (
        serde_json::from_str::<Value>(old),
        serde_json::from_str::<Value>(incoming),
    ) else {
        return Ok(incoming.into());
    };
    for field in ["articles", "words", "books", "sessions"] {
        if let Some(rows) = value.get(field).and_then(Value::as_array) {
            if result.get(field).is_none() {
                result[field] = json!([]);
            }
            if let Some(target) = result.get_mut(field).and_then(Value::as_array_mut) {
                for row in rows {
                    if let Some(existing) = target.iter_mut().find(|r| r.get("id") == row.get("id"))
                    {
                        let before = existing
                            .get("updatedAt")
                            .or_else(|| existing.get("lastReadAt"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        let after = row
                            .get("updatedAt")
                            .or_else(|| row.get("lastReadAt"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        if after > before {
                            let mut next = row.clone();
                            merge_unknown(existing, &mut next);
                            *existing = next;
                        }
                    } else {
                        target.push(row.clone());
                    }
                }
            }
        }
    }
    serde_json::to_string(&result).map_err(|e| e.to_string())
}
/// Consume only the active guest library. Switching from account A never adopts A into B.
pub fn adopt_guest(app: &AppHandle, user: &str) -> Result<(), String> {
    if namespace() != "guest" {
        return Ok(());
    }
    learning_migrate(app.clone(), Some("guest".into()))?;
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    if namespace() != "guest" {
        return Ok(());
    }
    let mut db = connection(app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let target = account_namespace(user);
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let destination = root.join("learning").join(&target);
    let device = device_id(app)?;
    let files = {
        let mut query = tx
            .prepare(
                "SELECT path,content FROM files WHERE namespace='guest' AND content IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (path, body) in files {
        let source = PathBuf::from(&path);
        let relative = source
            .strip_prefix(&root)
            .map_err(|_| "Guest library path outside application data")?;
        let mut dest = destination.join(relative);
        let old = read_file_db(&tx, &target, &dest)?;
        if source.extension().and_then(|s| s.to_str()) == Some("md")
            && old.as_ref().is_some_and(|old| old != &body)
        {
            let name = source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("note");
            dest = dest.with_file_name(format!("{name}-guest-{}.md", now()));
        }
        let merged = merge_domain_files(old.as_deref(), &body)?;
        derive(&tx, &target, &dest, old.as_deref(), Some(&merged), &device)?;
        tx.execute("INSERT INTO files VALUES(?1,?2,?3) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",params![target,key(&dest),merged]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE files SET content=NULL WHERE namespace='guest' AND path=?",
            [path],
        )
        .map_err(|e| e.to_string())?;
    }
    let collections = {
        let mut query = tx
            .prepare("SELECT DISTINCT collection FROM entities WHERE namespace='guest'")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for collection in collections {
        for mut entity in list_db(&tx, "guest", &collection)? {
            if entity.deleted {
                continue;
            }
            if let Some(old) = list_db(&tx, &target, &collection)?
                .into_iter()
                .find(|e| e.id == entity.id)
            {
                if old.updated_at >= entity.updated_at {
                    continue;
                }
                entity.base_version = old.base_version;
            } else {
                entity.base_version = 0;
            }
            entity.dirty = true;
            put_db(&tx, &target, &collection, &entity)?;
        }
    }
    tx.execute("DELETE FROM entities WHERE namespace='guest'", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM cursors WHERE namespace='guest'", [])
        .map_err(|e| e.to_string())?;
    let audio_exists: bool = tx
        .query_row(
            "SELECT count(*)>0 FROM sqlite_master WHERE type='table' AND name='audio_clips'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if audio_exists {
        tx.execute(
            "UPDATE audio_clips SET namespace=? WHERE namespace='guest'",
            [&target],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE audio_chunks SET namespace=? WHERE namespace='guest'",
            [&target],
        )
        .map_err(|e| e.to_string())?;
    }
    for collection in [
        "reading-articles",
        "reading-vocab",
        "review-events",
        "notes",
        "speak-sessions",
    ] {
        hydrate(&tx, &target, app, collection)?;
    }
    tx.commit().map_err(|e| e.to_string())
}
pub fn put(
    app: &AppHandle,
    collection: &str,
    entities: Vec<StoredSyncEntity>,
    replace: bool,
    cursor: Option<i64>,
    expected_namespace: Option<&str>,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    verify_namespace(expected_namespace)?;
    let mut db = connection(app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let ns = namespace();
    let current = list_db(&tx, &ns, collection)?;
    let pending = if replace {
        current.iter().cloned()
            .filter(|e| e.dirty)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    if replace {
        tx.execute(
            "DELETE FROM entities WHERE namespace=?1 AND collection=?2",
            params![ns, collection],
        )
        .map_err(|e| e.to_string())?;
    }
    for e in &entities {
        let mut incoming = e.clone();
        if let Some(old) = current.iter().find(|old| old.id == incoming.id) {
            if collection == "review-events" && old.payload != incoming.payload {
                return Err("Immutable review event conflict".into());
            }
            if let Some(merged) = (collection == "speak-sessions").then(|| merge_practice_entity(old, &incoming)).flatten() {
                incoming = merged;
            } else if old.dirty
                && (old.updated_at > incoming.updated_at
                    || old.updated_at == incoming.updated_at
                        && (old.payload != incoming.payload || old.deleted != incoming.deleted))
            {
                incoming = old.clone();
                incoming.base_version = incoming.base_version.max(e.base_version);
            }
        }
        put_db(&tx, &ns, collection, &incoming)?;
    }
    for mut e in pending {
        if let Some(server) = entities.iter().find(|s| s.id == e.id) {
            if collection == "speak-sessions" && merge_practice_entity(&e, server).is_some() { continue; }
            e.base_version = server.base_version;
        } else {
            e.base_version = 0;
        }
        put_db(&tx, &ns, collection, &e)?;
    }
    if let Some(c) = cursor {
        tx.execute("INSERT INTO cursors VALUES(?1,?2,?3) ON CONFLICT(namespace,collection) DO UPDATE SET cursor=excluded.cursor",params![ns,collection,c]).map_err(|e|e.to_string())?;
    }
    if !entities.is_empty() || replace {
        hydrate(&tx, &ns, app, collection)?;
    }
    tx.commit().map_err(|e| e.to_string())
}
pub fn cursor(
    app: &AppHandle,
    collection: &str,
    expected_namespace: Option<&str>,
) -> Result<i64, String> {
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    verify_namespace(expected_namespace)?;
    let db = connection(app)?;
    let result = db.query_row(
        "SELECT cursor FROM cursors WHERE namespace=?1 AND collection=?2",
        params![namespace(), collection],
        |r| r.get(0),
    );
    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(e) => Err(e.to_string()),
    }
}
fn enqueue(
    db: &Connection,
    ns: &str,
    collection: &str,
    id: &str,
    payload: Value,
    updated_at: i64,
    device: &str,
) -> Result<(), String> {
    let old = list_db(db, ns, collection)?
        .into_iter()
        .find(|e| e.id == id);
    let mut payload = payload;
    if let Some(p) = old.as_ref().and_then(|e| e.payload.as_ref()) {
        merge_unknown(p, &mut payload);
    }
    if old
        .as_ref()
        .is_some_and(|e| !e.deleted && e.payload.as_ref() == Some(&payload))
    {
        return Ok(());
    }
    let e = StoredSyncEntity {
        id: id.into(),
        base_version: old.as_ref().map(|e| e.base_version).unwrap_or(0),
        updated_at: updated_at.max(old.as_ref().map(|e| e.updated_at + 1).unwrap_or(0)),
        deleted: false,
        schema_version: 2,
        origin_device: Some(device.into()),
        payload: Some(payload),
        dirty: true,
    };
    put_db(db, ns, collection, &e)
}
fn tombstone(
    db: &Connection,
    ns: &str,
    collection: &str,
    id: &str,
    device: &str,
) -> Result<(), String> {
    let old = list_db(db, ns, collection)?
        .into_iter()
        .find(|e| e.id == id);
    let mut e = old.unwrap_or(StoredSyncEntity {
        id: id.into(),
        base_version: 0,
        updated_at: 0,
        deleted: false,
        schema_version: 2,
        origin_device: None,
        payload: None,
        dirty: true,
    });
    e.deleted = true;
    e.payload = None;
    e.updated_at = now().max(e.updated_at + 1);
    e.dirty = true;
    e.origin_device = Some(device.into());
    put_db(db, ns, collection, &e)
}
fn private_audio_key(key: &str) -> bool {
    let private = |part: &str| matches!(part.to_lowercase().as_str(), "audio" | "audiobase64" | "audiob64" | "pcmb64" | "wavb64" | "audio_base64" | "pcm" | "pcm_base64" | "wav" | "blob" | "audiofile" | "audiopath" | "localpath");
    private(key) || key.starts_with('/') && practice_parts(key).iter().any(|part| private(part))
}
fn scrub(value: &Value) -> Value {
    match value {
        Value::Array(rows) => Value::Array(rows.iter().map(scrub).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(k, _)| !private_audio_key(k))
                .map(|(k, v)| (k.clone(), scrub(v)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(rows) => format!(
            "[{}]",
            rows.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(fields) => {
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical(&fields[*k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}
fn revision_value(value: &Value) -> String {
    let text = canonical(value);
    let mut h = 2166136261u32;
    for c in text.encode_utf16() {
        h ^= u32::from(c);
        h = h.wrapping_mul(16777619);
    }
    base36(h)
}
fn revision(rows: &[Value]) -> String {
    let rows: Vec<_> = rows
        .iter()
        .map(|row| {
            let mut content = scrub(row);
            if let Some(object) = content.as_object_mut() {
                object.remove("id");
            }
            content
        })
        .collect();
    revision_value(&json!(rows))
}
fn base36(mut n: u32) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut s = String::new();
    while n > 0 {
        s.insert(0, char::from_digit(n % 36, 36).unwrap());
        n /= 36;
    }
    s
}
fn project_article(db: &Connection, ns: &str, a: &Value, device: &str) -> Result<(), String> {
    let id = a.get("id").and_then(Value::as_str).ok_or("article id")?;
    let rows = a
        .get("sentences")
        .and_then(Value::as_array)
        .ok_or("article sentences")?;
    let rev = revision(rows);
    let mut chunks = Vec::new();
    let mut batch = Vec::new();
    let flush = |batch: &mut Vec<Value>, chunks: &mut Vec<String>| -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let cid = format!("chunk:{id}:{rev}:{}", revision_value(&json!(batch)));
        enqueue(
            db,
            ns,
            "reading-articles",
            &cid,
            json!({"v":2,"kind":"content-chunk","articleId":id,"contentRevision":rev,"sentences":batch}),
            now(),
            device,
        )?;
        chunks.push(cid);
        batch.clear();
        Ok(())
    };
    for s in rows {
        let mut s = scrub(s);
        let idx = s
            .get("idx")
            .and_then(Value::as_u64)
            .unwrap_or(batch.len() as u64);
        if s.get("id").is_none() {
            s["id"] = json!(format!("{id}:s{idx}"));
        }
        if !batch.is_empty()
            && serde_json::to_vec(&batch).map_err(|e| e.to_string())?.len()
                + serde_json::to_vec(&s).map_err(|e| e.to_string())?.len()
                > 262144
        {
            flush(&mut batch, &mut chunks)?;
        }
        if serde_json::to_vec(&s).map_err(|e| e.to_string())?.len() > 262144 {
            return Err("Single sentence exceeds sync chunk limit".into());
        }
        batch.push(s);
    }
    flush(&mut batch, &mut chunks)?;
    let mut manifest = scrub(a);
    let obj = manifest.as_object_mut().ok_or("article object")?;
    obj.remove("sentences");
    obj.remove("progress");
    obj.insert("v".into(), json!(2));
    obj.insert("kind".into(), json!("article"));
    obj.insert("contentRevision".into(), json!(rev));
    obj.insert("chunkIds".into(), json!(chunks));
    enqueue(db, ns, "reading-articles", id, manifest, now(), device)?;
    let idx = a
        .pointer("/progress/sentenceIdx")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let last = a.get("lastReadAt").and_then(Value::as_i64).unwrap_or(0);
    let mut p = a.get("progress").cloned().unwrap_or(json!({}));
    p["v"] = json!(2);
    p["kind"] = json!("progress");
    p["articleId"] = json!(id);
    p["deviceId"] = json!(device);
    p["contentRevision"] = json!(rev);
    p["locator"] = json!({"sentenceId":rows.get(idx as usize).and_then(|s|s.get("id")).cloned().unwrap_or(json!(format!("{id}:s{idx}")))});
    p["lastReadAt"] = json!(last);
    enqueue(
        db,
        ns,
        "reading-articles",
        &format!("progress:{id}:{device}"),
        p,
        last,
        device,
    )
}
fn derive(
    db: &Connection,
    ns: &str,
    path: &Path,
    old: Option<&str>,
    content: Option<&str>,
    device: &str,
) -> Result<(), String> {
    let name = path.file_name().and_then(|p| p.to_str()).unwrap_or("");
    let before: Value = old
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!({}));
    let value: Value = content
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!({}));
    if let Some(articles) = value.get("articles").and_then(Value::as_array) {
        for a in articles {
            project_article(db, ns, a, device)?;
        }
    }
    if let Some(words) = value.get("words").and_then(Value::as_array) {
        for w in words {
            if let Some(id) = w.get("id").and_then(Value::as_str) {
                let mut w = w.clone();
                ensure_baseline(&mut w);
                enqueue(db, ns, "reading-vocab", id, w, now(), device)?;
            }
        }
    }
    if let Some(books) = value.get("books").and_then(Value::as_array) {
        for b in books {
            if let Some(id) = b.get("id").and_then(Value::as_str) {
                let mut p = b.clone();
                p["v"] = json!(2);
                p["kind"] = json!("book");
                p["contentRevision"] = json!(format!(
                    "book-{}",
                    b.get("createdAt").and_then(Value::as_i64).unwrap_or(0)
                ));
                if let Some(cs) = p.get_mut("chapters").and_then(Value::as_array_mut) {
                    for c in cs {
                        c["articleId"] = c.get("id").cloned().unwrap_or(Value::Null);
                    }
                }
                enqueue(db, ns, "reading-articles", id, p, now(), device)?;
            }
        }
    }
    if let Some(sessions) = value.get("sessions").and_then(Value::as_array) {
        for s in sessions {
            if let Some(id) = s.get("id").and_then(Value::as_str) {
                let mut p = scrub(s);
                p["v"] = json!(2);
                p["startedAt"] = s.get("createdAt").cloned().unwrap_or(json!(0));
                p["endedAt"] = s.get("updatedAt").cloned().unwrap_or(json!(0));
                // Persist the complete snapshot and pending entity together. The sync engine
                // reports size limits without preventing a local save or trimming attempts.
                enqueue(
                    db,
                    ns,
                    "speak-sessions",
                    id,
                    p,
                    s.get("updatedAt")
                        .and_then(Value::as_i64)
                        .unwrap_or_else(now),
                    device,
                )?;
            }
        }
    }
    for (field, collection) in [
        ("articles", "reading-articles"),
        ("books", "reading-articles"),
        ("words", "reading-vocab"),
        ("sessions", "speak-sessions"),
    ] {
        if let Some(rows) = before.get(field).and_then(Value::as_array) {
            for row in rows {
                if let Some(id) = row.get("id").and_then(Value::as_str) {
                    if !value.get(field).and_then(Value::as_array).is_some_and(|a| {
                        a.iter()
                            .any(|v| v.get("id").and_then(Value::as_str) == Some(id))
                    }) {
                        tombstone(db, ns, collection, id, device)?;
                    }
                }
            }
        }
    }
    if name.ends_with(".md") {
        if let Some(raw) = content {
            let mut it = raw.splitn(4, '\n');
            if it.next() == Some("---") {
                if let Some(meta) = it.next() {
                    if let Ok(m) = serde_json::from_str::<Value>(meta) {
                        let body = it.nth(1).unwrap_or("");
                        enqueue(
                            db,
                            ns,
                            "notes",
                            name,
                            json!({"v":2,"id":name,"meta":m,"content":body}),
                            now(),
                            device,
                        )?;
                    }
                }
            }
        } else {
            tombstone(db, ns, "notes", name, device)?;
        }
    }
    Ok(())
}
pub fn commit(app: &AppHandle, path: &Path, content: Option<&str>) -> Result<(), String> {
    commit_many(app, &[(path.to_path_buf(), content.map(str::to_owned))])
}
pub fn commit_many(app: &AppHandle, writes: &[(PathBuf, Option<String>)]) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    let mut db = connection(app)?;
    let ns = namespace();
    let device = device_id(app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut exports = Vec::new();
    for (path, content) in writes {
        verify_path(app, path, &ns)?;
        let old = read_file_db(&tx, &ns, path)?;
        let mut body = content.clone();
        if let (Some(old), Some(body)) = (&old, &mut body) {
            if let (Ok(previous), Ok(mut next)) = (
                serde_json::from_str::<Value>(old),
                serde_json::from_str::<Value>(body),
            ) {
                preserve_practice_tasks(&previous, &mut next);
                merge_unknown(&previous, &mut next);
                *body = serde_json::to_string(&next).map_err(|e| e.to_string())?;
            }
        }
        derive(&tx, &ns, path, old.as_deref(), body.as_deref(), &device)?;
        tx.execute("INSERT INTO files VALUES(?1,?2,?3) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",params![ns,key(path),body]).map_err(|e|e.to_string())?;
        exports.push((path.clone(), body));
    }
    tx.commit().map_err(|e| e.to_string())?;
    for (path, body) in exports {
        let exported = (|| -> Result<(), String> {
            if let Some(body) = body {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let tmp = path.with_extension("learning.tmp");
                std::fs::write(&tmp, body)
                    .map_err(|e| format!("学习已保存，兼容文件导出失败: {e}"))?;
                std::fs::rename(tmp, &path)
                    .map_err(|e| format!("学习已保存，兼容文件替换失败: {e}"))?;
            } else {
                match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            Ok(())
        })();
        if let Err(error) = exported {
            eprintln!("Learning snapshot committed; compatibility export failed: {error}");
            let _ = app.emit("learning-export-warning", json!({"message":"学习记录已保存，兼容文件导出失败，可稍后重试导出","path":key(&path)}));
        }
    }
    Ok(())
}
#[tauri::command]
pub fn learning_device_id(app: AppHandle) -> Result<String, String> {
    device_id(&app)
}
/// PCM chunks are committed locally before cloud processing. No audio enters the outbox.
#[tauri::command]
pub fn learning_audio(
    app: AppHandle,
    action: String,
    clip_id: String,
    sequence: Option<i64>,
    data: Option<String>,
    metadata: Option<Value>,
    expected_namespace: Option<String>,
) -> Result<Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if clip_id.is_empty() || clip_id.len() > 512 {
        return Err("Invalid clip id".into());
    }
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    verify_namespace(expected_namespace.as_deref())?;
    let mut db = connection(&app)?;
    let ns = namespace();
    db.execute_batch("CREATE TABLE IF NOT EXISTS audio_clips(namespace TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(namespace,id)); CREATE TABLE IF NOT EXISTS audio_chunks(namespace TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,pcm BLOB NOT NULL,PRIMARY KEY(namespace,id,sequence));").map_err(|e|e.to_string())?;
    let get = |db: &Connection| -> Result<Option<(String, Value)>, String> {
        match db.query_row(
            "SELECT status,metadata FROM audio_clips WHERE namespace=? AND id=?",
            params![ns, clip_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        ) {
            Ok((status, raw)) => Ok(Some((
                status,
                serde_json::from_str(&raw).map_err(|e| e.to_string())?,
            ))),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    };
    if action == "begin" {
        let value = metadata.unwrap_or(Value::Null);
        if let Some((_, old)) = get(&db)? {
            if old != value {
                return Err("Clip id collision".into());
            }
        } else {
            db.execute(
                "INSERT INTO audio_clips VALUES(?,?,'recording',?)",
                params![ns, clip_id, value.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(json!({"clipId":clip_id}));
    }
    let (status, meta) = get(&db)?.ok_or("原录音仅保存在录制它的设备，这台设备没有原声")?;
    if action == "append" {
        let index = sequence
            .filter(|s| *s >= 0)
            .ok_or("Invalid audio sequence")?;
        let bytes = STANDARD
            .decode(data.ok_or("Missing audio chunk")?)
            .map_err(|e| e.to_string())?;
        if bytes.is_empty() || bytes.len() % 2 != 0 || bytes.len() > 1_048_576 {
            return Err("Invalid audio chunk".into());
        }
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let(count,total):(i64,i64)=tx.query_row("SELECT count(*),coalesce(sum(length(pcm)),0) FROM audio_chunks WHERE namespace=? AND id=?",params![ns,clip_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        if index < count {
            let old: Vec<u8> = tx
                .query_row(
                    "SELECT pcm FROM audio_chunks WHERE namespace=? AND id=? AND sequence=?",
                    params![ns, clip_id, index],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if old != bytes {
                return Err("Audio sequence collision".into());
            }
        } else {
            if index != count || status != "recording" {
                return Err("Audio sequence or status conflict".into());
            }
            if total + bytes.len() as i64 > 20 * 1024 * 1024 {
                return Err("Recording exceeds 20 MiB".into());
            }
            tx.execute(
                "INSERT INTO audio_chunks VALUES(?,?,?,?)",
                params![ns, clip_id, index, bytes],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(json!({"clipId":clip_id,"nextSequence":count.max(index+1)}));
    }
    if action == "delete" {
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM audio_chunks WHERE namespace=? AND id=?",
            params![ns, clip_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM audio_clips WHERE namespace=? AND id=?",
            params![ns, clip_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    let mut stmt = db
        .prepare("SELECT pcm FROM audio_chunks WHERE namespace=? AND id=? ORDER BY sequence")
        .map_err(|e| e.to_string())?;
    let chunks = stmt
        .query_map(params![ns, clip_id], |r| r.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?;
    let mut pcm = Vec::new();
    for chunk in chunks {
        pcm.extend(chunk.map_err(|e| e.to_string())?);
    }
    drop(stmt);
    if pcm.is_empty() {
        return Err("没有录到有效声音，已保留当前记录".into());
    }
    if action == "finalize" {
        db.execute(
            "UPDATE audio_clips SET status='ready' WHERE namespace=? AND id=?",
            params![ns, clip_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(json!({"clipId":clip_id,"status":"ready","byteLength":pcm.len()}));
    }
    if action != "read" {
        return Err("Unknown audio action".into());
    }
    let length = pcm.len() as u32;
    let mut wav = Vec::new();
    wav.extend(b"RIFF");
    wav.extend((length + 36).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16u32.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(16000u32.to_le_bytes());
    wav.extend(32000u32.to_le_bytes());
    wav.extend(2u16.to_le_bytes());
    wav.extend(16u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend(length.to_le_bytes());
    wav.extend(&pcm);
    Ok(
        json!({"clipId":clip_id,"status":status,"metadata":meta,"durationMs":length as u64*1000/32000,"pcmB64":STANDARD.encode(pcm),"wavB64":STANDARD.encode(wav)}),
    )
}
#[tauri::command]
pub fn learning_commit_review(
    app: AppHandle,
    word: Value,
    event: Value,
    expected_namespace: Option<String>,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "learning lock")?;
    verify_namespace(expected_namespace.as_deref())?;
    let mut db = connection(&app)?;
    let ns = namespace();
    let device = device_id(&app)?;
    let id = word
        .get("id")
        .and_then(Value::as_str)
        .ok_or("word id")?
        .to_owned();
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .ok_or("event id")?
        .to_owned();
    if event.get("v").and_then(Value::as_i64) != Some(2)
        || event.get("wordId").and_then(Value::as_str) != Some(id.as_str())
    {
        return Err("Invalid review event".into());
    }
    let path = data_dir(&app)?.join("reader_vocab.json");
    let mut file: Value = read_file_db(&db, &ns, &path)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("Vocabulary not found")?;
    let words = file
        .get_mut("words")
        .and_then(Value::as_array_mut)
        .ok_or("words")?;
    let position = words
        .iter()
        .position(|w| w.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .ok_or("Word no longer exists")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if let Some(previous) = list_db(&tx, &ns, "review-events")?
        .into_iter()
        .find(|e| e.id == event_id)
    {
        if previous.payload.as_ref() == Some(&event) {
            return Ok(());
        }
        return Err("Immutable review event conflict".into());
    }
    let mut word = word;
    merge_unknown(&words[position], &mut word);
    ensure_baseline(&mut word);
    let mut events: Vec<_> = list_db(&tx, &ns, "review-events")?
        .into_iter()
        .filter(|e| !e.deleted)
        .filter_map(|e| e.payload)
        .collect();
    events.push(event.clone());
    reduce_word(&mut word, &events);
    words[position] = word.clone();
    snapshot(&tx, &ns, &path, &file)?;
    enqueue(&tx, &ns, "reading-vocab", &id, word, now(), &device)?;
    enqueue(&tx, &ns, "review-events", &event_id, event, now(), &device)?;
    hydrate_reviews(&tx, &ns, &app)?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn learning_migrate(app: AppHandle, expected_namespace: Option<String>) -> Result<(), String> {
    verify_namespace(expected_namespace.as_deref())?;
    let initial_namespace = namespace();
    let dir = data_dir(&app)?;
    for name in [
        "reader_articles.json",
        "reader_books.json",
        "reader_vocab.json",
        "reader_speak_sessions.json",
    ] {
        let path = dir.join(name);
        if path.exists() {
            let text = match read(&app, &path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            commit(&app, &path, Some(&text))?;
        }
    }
    for sub in ["books", "notes"] {
        let folder = dir.join(sub);
        if folder.exists() {
            for item in std::fs::read_dir(folder).map_err(|e| e.to_string())? {
                let p = item.map_err(|e| e.to_string())?.path();
                if p.is_file() {
                    let text = match read(&app, &p) {
                        Ok(text) => text,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error.to_string()),
                    };
                    commit(&app, &p, Some(&text))?;
                }
            }
        }
    }
    {
        let _guard = LOCK.lock().map_err(|_| "learning lock")?;
        verify_namespace(Some(&initial_namespace))?;
        let mut db = connection(&app)?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let ns = namespace();
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let folder = if ns == "guest" {
            root.join("sync")
        } else {
            dir.join("sync")
        };
        for collection in [
            "history",
            "reading-articles",
            "reading-vocab",
            "notes",
            "glossary",
            "settings",
            "speak-scenarios",
            "speak-sessions",
            "speak-assessments",
            "review-events",
        ] {
            let path = folder.join(format!("{collection}.json"));
            if !path.exists() {
                continue;
            }
            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if let Some(rows) = value.get("entities").and_then(Value::as_array) {
                let existing = list_db(&tx, &ns, collection)?;
                for row in rows {
                    let entity: StoredSyncEntity =
                        serde_json::from_value(row.clone()).map_err(|e| e.to_string())?;
                    if !existing.iter().any(|old| old.id == entity.id) {
                        put_db(&tx, &ns, collection, &entity)?;
                    }
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn practice_fixture(at: i64, attempts: Value) -> Value {
        json!({"kind":"practice-task","id":"task","updatedAt":at,"task":{"id":"task","updatedAt":at,"draft":"","attempts":attempts}})
    }
    fn practice_entity(payload: Option<Value>, deleted: bool, dirty: bool) -> StoredSyncEntity {
        StoredSyncEntity { id: "task".into(), base_version: 1, updated_at: 20, deleted, schema_version: 2, origin_device: None, payload, dirty }
    }
    #[test]
    fn practice_merge_keeps_offline_attempts_feedback_and_ise() {
        let a = practice_fixture(20, json!([{"id":"same","text":"a","createdAt":1,"feedback":{"message":"Good","future":true}},{"id":"windows","createdAt":2}]));
        let b = practice_fixture(30, json!([{"id":"same","text":"b","createdAt":1,"pronunciation":{"total":4.5}},{"id":"phone","createdAt":3}]));
        let merged = merge_practice_payload(&a, &b).unwrap();
        assert_eq!(merged, merge_practice_payload(&b, &a).unwrap());
        assert_eq!(merged, merge_practice_payload(&merged, &merged).unwrap());
        assert_eq!(merged["task"]["attempts"].as_array().unwrap().len(), 3);
        assert_eq!(merged["task"]["attempts"][0]["feedback"]["message"], "Good");
        assert_eq!(merged["task"]["attempts"][0]["pronunciation"]["total"], 4.5);
        assert_eq!(merged["task"]["attempts"][0]["text"], "b");
    }
    #[test]
    fn practice_removal_ids_and_entity_tombstones_prevent_resurrection() {
        let live = practice_fixture(30, json!([{"id":"cancelled","clipId":"local"}]));
        let mut canceled = practice_fixture(20, json!([]));
        canceled["task"]["removedAttemptIds"] = json!(["cancelled"]);
        let merged = merge_practice_payload(&live, &canceled).unwrap();
        assert_eq!(merged["task"]["attempts"], json!([]));
        assert_eq!(merged["task"]["removedAttemptIds"], json!(["cancelled"]));
        let old = practice_entity(Some(live), false, true);
        let mut removed = practice_entity(None, true, false);
        removed.base_version = 9;
        assert!(merge_practice_entity(&old, &removed).unwrap().deleted);
        let restored = merge_practice_entity(&removed, &old).unwrap();
        assert!(restored.deleted); assert!(restored.dirty); assert_eq!(restored.base_version, 9);
    }
    #[test]
    fn practice_clocks_preserve_independent_fields_and_explicit_clears() {
        let a = json!({"updatedAt":20,"draft":"phone","step":0,"fieldUpdatedAt":{"draft":20,"step":10,"error":20}});
        let b = json!({"updatedAt":30,"draft":"","step":1,"error":"old","fieldUpdatedAt":{"draft":10,"step":30,"error":10}});
        let merged = merge_practice_fields(&a, &b, 20, 30);
        assert_eq!(merged["draft"], "phone"); assert_eq!(merged["step"], 1); assert!(merged.get("error").is_none());
        assert_eq!(merged, merge_practice_fields(&b, &a, 30, 20));
    }
    #[test]
    fn practice_nested_leaf_registers_are_associative() {
        let a = json!({"future":{"x":"A","z":0},"updatedAt":10});
        let b = json!({"future":{"x":"B","y":0},"updatedAt":10});
        let c = json!({"future":{"x":"C","a":0},"updatedAt":10});
        let left = merge_practice_fields(&merge_practice_fields(&a,&b,10,10),&c,10,10);
        let right = merge_practice_fields(&a,&merge_practice_fields(&b,&c,10,10),10,10);
        assert_eq!(left,right); assert_eq!(left["future"]["x"],"C");
        let a=json!({"feedback":{"message":"newer"},"updatedAt":20});
        let b=json!({"feedback":{"future":{"version":2}},"updatedAt":30});
        let c=json!({"feedback":{"message":"older"},"updatedAt":10});
        let left=merge_practice_fields(&merge_practice_fields(&a,&b,20,30),&c,30,10);
        let right=merge_practice_fields(&a,&merge_practice_fields(&b,&c,30,10),20,30);
        assert_eq!(left,right);assert_eq!(left["feedback"]["message"],"newer");
        assert_eq!(left["feedback"]["future"]["version"],2);
    }
    #[test]
    fn practice_type_changes_retain_shadow_registers_to_converge() {
        let a=json!({"future":{"x":1},"updatedAt":10});
        let b=json!({"future":0,"updatedAt":20});
        let c=json!({"future":{"y":2},"updatedAt":30});
        let left=merge_practice_fields(&merge_practice_fields(&a,&b,10,20),&c,20,30);
        let right=merge_practice_fields(&a,&merge_practice_fields(&b,&c,20,30),10,30);
        assert_eq!(left,right);assert_eq!(left["future"],json!({"y":2}));
        assert_eq!(left,merge_practice_fields(&left,&left,30,30));
    }
    #[test]
    fn practice_shadow_metadata_cannot_transport_private_audio() {
        let input=json!({"clipId":"local","fieldShadow":{"/audioB64":"secret","/future/pcm":"secret","/future/data":{"audio":"secret","safe":true},"/clipId":"local"},"fieldUpdatedAt":{"/audioB64":10,"/clipId":10}});
        assert_eq!(scrub(&input),json!({"clipId":"local","fieldShadow":{"/future/data":{"safe":true},"/clipId":"local"},"fieldUpdatedAt":{"/clipId":10}}));
    }
    #[test]
    fn practice_transaction_merge_marks_union_dirty_and_ack_clears_it() {
        let local = practice_entity(Some(practice_fixture(20, json!([{"id":"windows"}]))), false, true);
        let mut remote = practice_entity(Some(practice_fixture(30, json!([{"id":"phone"}]))), false, false);
        remote.base_version = 8;
        let merged = merge_practice_entity(&local, &remote).unwrap();
        assert!(merged.dirty); assert_eq!(merged.base_version, 8);
        assert_eq!(merged.payload.as_ref().unwrap()["task"]["attempts"].as_array().unwrap().len(), 2);
        let mut accepted = merged.clone(); accepted.dirty = false; accepted.base_version = 9;
        let ack = merge_practice_entity(&merged, &accepted).unwrap();
        assert!(!ack.dirty); assert_eq!(ack.base_version, 9);
    }
    #[test]
    fn account_names_are_isolated_and_path_safe() {
        set_account(Some("../a"));
        let a = namespace();
        set_account(Some("b"));
        assert_ne!(a, namespace());
        assert!(!a.contains('/'));
        set_account(None);
    }
    #[test]
    fn failure_rolls_back_snapshot_and_outbox() {
        let path = std::env::temp_dir().join(format!("learning-txn-{}.db", std::process::id()));
        let mut db = open(&path).unwrap();
        {
            let tx = db.transaction().unwrap();
            tx.execute("INSERT INTO files VALUES('guest','x','{}')", [])
                .unwrap();
            tx.execute("INSERT INTO entities VALUES('guest','notes','x','{}')", [])
                .unwrap();
        }
        let count: i64 = db
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let count: i64 = db
            .query_row("SELECT count(*) FROM entities", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(db);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn unknown_fields_survive_legacy_writes() {
        let old = json!({"id":"x","task":{"source":"reader"},"turns":[{"id":"t","audioDevice":"phone","text":"old"}]});
        let mut next = json!({"id":"x","turns":[{"id":"t","text":"new"}]});
        merge_unknown(&old, &mut next);
        assert_eq!(next["task"]["source"], "reader");
        assert_eq!(next["turns"][0]["audioDevice"], "phone");
        assert_eq!(next["turns"][0]["text"], "new");
    }
    #[test]
    fn legacy_session_retention_never_deletes_practice_tasks() {
        let old = json!({"sessions":[{"id":"practice","kind":"practice-task","task":{"draft":"saved","attempts":[{"id":"try","feedback":{"message":"retained"}}]}}]});
        let mut next = json!({"sessions":[{"id":"normal","turns":[]}]});
        preserve_practice_tasks(&old, &mut next);
        preserve_practice_tasks(&old, &mut next);
        assert_eq!(next["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(next["sessions"][1]["task"]["draft"], "saved");
    }
    #[test]
    fn utf16_revision_matches_typescript_fixture() {
        let rows = vec![json!({"idx":0,"paragraphIdx":0,"en":"😀","zh":null,"zhState":"pending"})];
        assert_eq!(revision(&rows), "1mzjf0s");
        let mut changed = rows.clone();
        changed[0]["zh"] = json!("中文");
        assert_ne!(revision(&rows), revision(&changed));
    }
    #[test]
    fn legacy_events_replay_without_modifying_immutable_payloads() {
        let old = json!({"v":2,"id":"old","wordId":"w","deviceId":"phone","reviewedAt":10,"kind":"grade","grade":"good","mode":"cloze","recall":{"bucket":"pass"}});
        let baseline = json!({"ease":2.5,"intervalDays":0,"reps":5,"lapses":0,"dueAt":0});
        let mut word = json!({"id":"w","addedAt":1,"baseline":baseline,"baselineRecall":{"total":{"pass":4,"wrong":2,"trap":0},"byMode":{}},"generation":"legacy-1"});
        reduce_word(&mut word, &[old.clone()]);
        assert_eq!(word["srs"]["reps"], 6);
        assert_eq!(word["recall"]["total"]["pass"], 5);
        let undo = json!({"id":"undo","wordId":"w","generation":"legacy-1","reviewedAt":20,"kind":"undo","reversesEventId":"old"});
        reduce_word(&mut word, &[old.clone(), undo]);
        assert_eq!(word["srs"]["reps"], 5);
        assert_eq!(word["recall"]["total"]["pass"], 4);
        word["generation"] = json!("new-generation");
        reduce_word(&mut word, &[old.clone()]);
        assert_eq!(word["srs"]["reps"], 5);
        assert!(old.get("generation").is_none());
    }
    #[test]
    fn oversized_sessions_remain_whole_in_snapshot_and_outbox() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE entities(namespace TEXT,collection TEXT,id TEXT,body TEXT,PRIMARY KEY(namespace,collection,id));").unwrap();
        let payload = json!({"sessions":[{"id":"large","createdAt":1,"updatedAt":2,"scenario":"practice","difficulty":"medium","turns":[{"role":"user","text":"x".repeat(70000),"at":2}]}]});
        derive(
            &db,
            "guest",
            Path::new("reader_speak_sessions.json"),
            None,
            Some(&payload.to_string()),
            "windows",
        )
        .unwrap();
        let rows = list_db(&db, "guest", "speak-sessions").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].dirty);
        assert_eq!(
            rows[0].payload.as_ref().unwrap()["turns"][0]["text"]
                .as_str()
                .unwrap()
                .len(),
            70000
        );
    }
}
