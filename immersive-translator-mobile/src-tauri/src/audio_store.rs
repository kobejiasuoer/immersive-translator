//! Local-only PCM/WAV files. Paths are derived from identifiers, never supplied by callers.
use crate::persistence::{now_ms, validate_key, StorageResult, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};
const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_CHUNK: usize = 1024 * 1024;
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioManifest {
    pub clip_id: String,
    pub status: String,
    pub byte_length: u64,
    pub next_sequence: i64,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub metadata: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRead {
    pub manifest: AudioManifest,
    pub wav_b64: String,
}
fn err(e: impl std::fmt::Display) -> String {
    format!("AUDIO_STORAGE: {e}")
}
fn paths(db: &Store, id: &str) -> StorageResult<(PathBuf, PathBuf)> {
    validate_key(id, "CLIP_ID")?;
    let key: String = Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let dir = db.directory.join("audio");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok((
        dir.join(format!("{key}.pcm.partial")),
        dir.join(format!("{key}.wav")),
    ))
}
pub fn manifest(db: &Store, id: &str) -> StorageResult<Option<AudioManifest>> {
    db.connection
        .query_row(
            "SELECT status,byte_length,next_sequence,metadata FROM audio_clips WHERE clip_id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(err)?
        .map(|(status, byte_length, next_sequence, metadata)| {
            Ok(AudioManifest {
                clip_id: id.into(),
                status,
                byte_length,
                next_sequence,
                duration_ms: byte_length * 1000 / 32000,
                sample_rate: 16000,
                channels: 1,
                metadata: serde_json::from_str(&metadata).map_err(err)?,
            })
        })
        .transpose()
}
pub fn begin(db: &Store, id: &str, metadata: Value) -> StorageResult<AudioManifest> {
    let (part, _) = paths(db, id)?;
    if let Some(prior) = manifest(db, id)? {
        if prior.metadata != metadata {
            return Err("CLIP_ID_COLLISION".into());
        }
        return Ok(prior);
    }
    // A crash after create_new but before INSERT can leave an empty, unowned part.
    // Nonempty unowned audio is never discarded implicitly.
    if part.exists() {
        if std::fs::metadata(&part).map_err(err)?.len() != 0 {
            return Err("AUDIO_ORPHAN_REQUIRES_RECOVERY".into());
        }
        std::fs::remove_file(&part).map_err(err)?;
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(err)?;
    file.sync_all().map_err(err)?;
    if let Err(e) = db.connection.execute(
        "INSERT INTO audio_clips(clip_id,status,metadata,updated_at) VALUES(?,'recording',?,?)",
        params![id, metadata.to_string(), now_ms()],
    ) {
        let _ = std::fs::remove_file(&part);
        return Err(err(e));
    }
    manifest(db, id)?.ok_or_else(|| "AUDIO_MANIFEST_MISSING".into())
}
pub fn append(db: &Store, id: &str, sequence: i64, pcm_b64: &str) -> StorageResult<AudioManifest> {
    let mut current = manifest(db, id)?.ok_or("CLIP_NOT_FOUND")?;
    if sequence < 0 {
        return Err("INVALID_AUDIO_SEQUENCE".into());
    }
    if pcm_b64.len() > MAX_CHUNK * 4 / 3 + 8 {
        return Err("AUDIO_CHUNK_TOO_LARGE".into());
    }
    let data = STANDARD.decode(pcm_b64).map_err(err)?;
    if data.len() > MAX_CHUNK {
        return Err("AUDIO_CHUNK_TOO_LARGE".into());
    }
    if data.is_empty() || data.len() % 2 != 0 {
        return Err("INVALID_PCM16_LENGTH".into());
    }
    let digest: String = Sha256::digest(&data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if sequence < current.next_sequence {
        let old: String = db
            .connection
            .query_row(
                "SELECT digest FROM audio_chunks WHERE clip_id=? AND sequence=?",
                params![id, sequence],
                |r| r.get(0),
            )
            .map_err(err)?;
        if old != digest {
            return Err("AUDIO_SEQUENCE_COLLISION".into());
        }
        return Ok(current);
    }
    if current.status != "recording" {
        return Err("AUDIO_NOT_RECORDING".into());
    }
    if sequence != current.next_sequence {
        return Err(format!("AUDIO_SEQUENCE_CONFLICT:{}", current.next_sequence));
    }
    if current.byte_length + data.len() as u64 > MAX_BYTES {
        return Err("AUDIO_LENGTH_LIMIT: maximum 20 MiB".into());
    }
    let (part, _) = paths(db, id)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(part)
        .map_err(err)?;
    if file.metadata().map_err(err)?.len() < current.byte_length {
        return Err("AUDIO_FILE_TRUNCATED".into());
    }
    file.set_len(current.byte_length).map_err(err)?;
    file.seek(SeekFrom::Start(current.byte_length))
        .map_err(err)?;
    if let Err(e) = file.write_all(&data).and_then(|_| file.sync_all()) {
        let _ = file.set_len(current.byte_length);
        return Err(err(e));
    }
    let result = (|| -> StorageResult<()> {
        let tx = db.connection.unchecked_transaction().map_err(err)?;
        tx.execute(
            "INSERT INTO audio_chunks(clip_id,sequence,byte_length,digest) VALUES(?,?,?,?)",
            params![id, sequence, data.len() as i64, digest],
        )
        .map_err(err)?;
        tx.execute("UPDATE audio_clips SET byte_length=?,next_sequence=next_sequence+1,updated_at=? WHERE clip_id=?",params![current.byte_length+data.len() as u64,now_ms(),id]).map_err(err)?;
        tx.commit().map_err(err)
    })();
    if let Err(e) = result {
        file.set_len(current.byte_length).map_err(err)?;
        file.sync_all().map_err(err)?;
        return Err(e);
    }
    current.byte_length += data.len() as u64;
    current.next_sequence += 1;
    current.duration_ms = current.byte_length * 1000 / 32000;
    Ok(current)
}
fn wav_header(length: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(length + 36).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&1u16.to_le_bytes());
    h[24..28].copy_from_slice(&16000u32.to_le_bytes());
    h[28..32].copy_from_slice(&32000u32.to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&length.to_le_bytes());
    h
}
pub fn finalize(db: &Store, id: &str) -> StorageResult<AudioManifest> {
    let mut current = manifest(db, id)?.ok_or("CLIP_NOT_FOUND")?;
    let (part, ready) = paths(db, id)?;
    if current.status == "ready" {
        validate_wav(&ready, current.byte_length)?;
        return Ok(current);
    }
    if current.status == "missing" {
        return Err("AUDIO_FILE_MISSING".into());
    }
    if current.byte_length == 0 {
        return Err("AUDIO_EMPTY".into());
    }
    let staged = ready.with_extension("wav.partial");
    if !ready.exists() {
        let mut source = File::open(&part).map_err(err)?;
        if source.metadata().map_err(err)?.len() < current.byte_length {
            return Err("AUDIO_FILE_TRUNCATED".into());
        }
        let mut target = File::create(&staged).map_err(err)?;
        target
            .write_all(&wav_header(current.byte_length as u32))
            .map_err(err)?;
        std::io::copy(
            &mut Read::by_ref(&mut source).take(current.byte_length),
            &mut target,
        )
        .map_err(err)?;
        target.sync_all().map_err(err)?;
        std::fs::rename(&staged, &ready).map_err(err)?;
    }
    validate_wav(&ready, current.byte_length)?;
    db.connection
        .execute(
            "UPDATE audio_clips SET status='ready',updated_at=? WHERE clip_id=?",
            params![now_ms(), id],
        )
        .map_err(err)?;
    if part.exists() {
        std::fs::remove_file(part).map_err(err)?;
    }
    current.status = "ready".into();
    Ok(current)
}
pub fn read(db: &Store, id: &str) -> StorageResult<AudioRead> {
    let current = manifest(db, id)?.ok_or("CLIP_NOT_FOUND")?;
    if current.status != "ready" {
        return Err(format!("AUDIO_NOT_READY:{}", current.status));
    }
    let (_, ready) = paths(db, id)?;
    validate_wav(&ready, current.byte_length)?;
    let bytes = std::fs::read(ready).map_err(err)?;
    Ok(AudioRead {
        manifest: current,
        wav_b64: STANDARD.encode(bytes),
    })
}
pub fn delete(db: &Store, id: &str) -> StorageResult<()> {
    let (part, ready) = paths(db, id)?;
    for path in [part, ready.clone(), ready.with_extension("wav.partial")] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
    }
    db.connection
        .execute("DELETE FROM audio_clips WHERE clip_id=?", [id])
        .map_err(err)?;
    Ok(())
}
pub fn recover(db: &Store) -> StorageResult<Vec<AudioManifest>> {
    let ids: Vec<String> = {
        let mut q = db
            .connection
            .prepare("SELECT clip_id FROM audio_clips")
            .map_err(err)?;
        let rows = q.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    let mut recovered = Vec::new();
    for id in ids {
        let current = manifest(db, &id)?.ok_or("CLIP_NOT_FOUND")?;
        let (part, ready) = paths(db, &id)?;
        if ready.exists() && validate_wav(&ready, current.byte_length).is_ok() {
            db.connection
                .execute(
                    "UPDATE audio_clips SET status='ready' WHERE clip_id=?",
                    [&id],
                )
                .map_err(err)?;
            for leftover in [&part, &ready.with_extension("wav.partial")] {
                if leftover.exists() {
                    std::fs::remove_file(leftover).map_err(err)?;
                }
            }
        } else if part.exists() {
            let file = OpenOptions::new().write(true).open(part).map_err(err)?;
            let actual = file.metadata().map_err(err)?.len();
            if actual >= current.byte_length {
                file.set_len(current.byte_length).map_err(err)?;
                file.sync_all().map_err(err)?;
                db.connection
                    .execute(
                        "UPDATE audio_clips SET status='interrupted' WHERE clip_id=?",
                        [&id],
                    )
                    .map_err(err)?;
            } else {
                db.connection
                    .execute(
                        "UPDATE audio_clips SET status='missing' WHERE clip_id=?",
                        [&id],
                    )
                    .map_err(err)?;
            }
        } else {
            db.connection
                .execute(
                    "UPDATE audio_clips SET status='missing' WHERE clip_id=?",
                    [&id],
                )
                .map_err(err)?;
        }
        recovered.push(manifest(db, &id)?.ok_or("CLIP_NOT_FOUND")?);
    }
    Ok(recovered)
}
fn validate_wav(path: &std::path::Path, length: u64) -> StorageResult<()> {
    let mut file = File::open(path).map_err(err)?;
    if length > MAX_BYTES || file.metadata().map_err(err)?.len() != length + 44 {
        return Err("AUDIO_FILE_LENGTH_MISMATCH".into());
    }
    let mut header = [0u8; 44];
    file.read_exact(&mut header).map_err(err)?;
    if header != wav_header(length as u32) {
        return Err("AUDIO_FILE_HEADER_INVALID".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn clips_are_isolated_idempotent_and_readable() {
        let root =
            std::env::temp_dir().join(format!("ita-audio-{}-{}", std::process::id(), now_ms()));
        let db = Store::open(&root, "guest").unwrap();
        begin(&db, "../clip", json!({"turnId":"t"})).unwrap();
        let pcm = STANDARD.encode([1, 0, 2, 0]);
        assert_eq!(append(&db, "../clip", 0, &pcm).unwrap().byte_length, 4);
        assert_eq!(append(&db, "../clip", 0, &pcm).unwrap().byte_length, 4);
        assert!(append(&db, "../clip", 2, &pcm).is_err());
        finalize(&db, "../clip").unwrap();
        let bytes = STANDARD
            .decode(read(&db, "../clip").unwrap().wav_b64)
            .unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(bytes.len(), 48);
        let other = Store::open(&root, "user").unwrap();
        assert!(manifest(&other, "../clip").unwrap().is_none());
        delete(&db, "../clip").unwrap();
        delete(&db, "../clip").unwrap();
        drop(other);
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn interrupted_append_is_recoverable() {
        let root =
            std::env::temp_dir().join(format!("ita-recovery-{}-{}", std::process::id(), now_ms()));
        let db = Store::open(&root, "guest").unwrap();
        begin(&db, "clip", Value::Null).unwrap();
        append(&db, "clip", 0, &STANDARD.encode([1, 0])).unwrap();
        assert_eq!(recover(&db).unwrap()[0].status, "interrupted");
        assert!(append(&db, "clip", 1, &STANDARD.encode([2, 0])).is_err());
        assert_eq!(finalize(&db, "clip").unwrap().status, "ready");
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn recovery_truncates_uncommitted_audio_and_detects_missing_ready_file() {
        let root =
            std::env::temp_dir().join(format!("ita-truncate-{}-{}", std::process::id(), now_ms()));
        let db = Store::open(&root, "guest").unwrap();
        begin(&db, "clip", Value::Null).unwrap();
        append(&db, "clip", 0, &STANDARD.encode([1, 0])).unwrap();
        let (part, ready) = paths(&db, "clip").unwrap();
        OpenOptions::new()
            .append(true)
            .open(&part)
            .unwrap()
            .write_all(&[99, 0])
            .unwrap();
        assert_eq!(recover(&db).unwrap()[0].status, "interrupted");
        assert_eq!(std::fs::metadata(&part).unwrap().len(), 2);
        finalize(&db, "clip").unwrap();
        std::fs::remove_file(ready).unwrap();
        assert_eq!(recover(&db).unwrap()[0].status, "missing");
        assert_eq!(finalize(&db, "clip").unwrap_err(), "AUDIO_FILE_MISSING");
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn startup_recovers_finalization_before_manifest_commit() {
        let root =
            std::env::temp_dir().join(format!("ita-finalize-{}-{}", std::process::id(), now_ms()));
        let db = Store::open(&root, "guest").unwrap();
        begin(&db, "clip", Value::Null).unwrap();
        append(&db, "clip", 0, &STANDARD.encode([1, 0])).unwrap();
        let (part, ready) = paths(&db, "clip").unwrap();
        let mut bytes = wav_header(2).to_vec();
        bytes.extend([1, 0]);
        std::fs::write(&ready, bytes).unwrap();
        assert_eq!(recover(&db).unwrap()[0].status, "ready");
        assert!(!part.exists());
        assert!(read(&db, "clip").is_ok());
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
}
