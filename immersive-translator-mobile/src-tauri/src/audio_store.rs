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

/* ---------- iOS 文件保护（录音隐私 P0，native-release-checks 闭环项 1） ----------
   录音目录与全部 partial/.wav.partial(staged)/final(.wav) 文件一律施加：
     1) NSURLIsExcludedFromBackupKey = true —— 录音只留在录制设备，绝不进 iCloud/电脑备份；
     2) NSFileProtectionKey = NSFileProtectionCompleteUntilFirstUserAuthentication
        —— 锁屏即密；首次解锁后可读，与锁屏/后台续录、启动 recover() 兼容。
   实现沿用 lib.rs 的运行时 objc 模式（dlopen Foundation + objc2 msg_send，不引入绑定 crate：
   staticlib 的 -l flag 传不进 Xcode 工程会直接链接失败，见 lib.rs AVFAudio 注释）。
   apply() 施加后立即回读两属性验证，属性设置/验证失败返回可见错误，绝不删改音频数据；
   调用方（begin/finalize/recover）把错误上抛。
   平台口径：生产代码仅在 iOS 编译；macOS 单测也编译相同的 Foundation 读取桥接，
   防止 NSDictionary 返回值与 NSError** 输出参数混淆，单测不声称验证 iOS 保护属性。
   macOS/Windows 上 ensure_protection() 是显式 no-op（那些平台无「设备备份」语义），
   属性的真实性由 iPhone 真机验证（备份排除标记、首次解锁前后读取），mac 检查不能替代。 */
#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
#[cfg_attr(all(test, target_os = "macos"), allow(dead_code))]
pub(crate) mod apple_protection {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, NSObject};
    use std::{ffi::CStr, path::Path, sync::OnceLock};

    extern "C" {
        fn dlopen(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> *mut std::ffi::c_void;
        fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    }

    struct Symbols {
        nsstring: &'static AnyClass,
        nsnumber: &'static AnyClass,
        nsdictionary: &'static AnyClass,
        nsfilemanager: &'static AnyClass,
        nsurl: &'static AnyClass,
        /// extern NSString 常量经 dlsym 取地址再解一次引用（同 lib.rs:715 的
        /// UIApplicationOpenSettingsURLString 口径）。
        backup_key: *mut NSObject,
        file_protection_key: *mut NSObject,
        protection_until_first_auth: *mut NSObject,
    }

    unsafe impl Sync for Symbols {}
    unsafe impl Send for Symbols {}

    fn symbols() -> Option<&'static Symbols> {
        static SYMBOLS: OnceLock<Option<Symbols>> = OnceLock::new();
        SYMBOLS
            .get_or_init(|| {
                // RTLD_NOW(0x2) | RTLD_GLOBAL(0x100)，darwin 值
                let handle = unsafe {
                    dlopen(
                        c"/System/Library/Frameworks/Foundation.framework/Foundation".as_ptr(),
                        0x102,
                    )
                };
                if handle.is_null() {
                    return None;
                }
                let class_of = |name: &std::ffi::CStr| AnyClass::get(name);
                let sym = |name: &std::ffi::CStr| -> *mut NSObject {
                    let p = unsafe { dlsym(handle, name.as_ptr()) };
                    if p.is_null() {
                        std::ptr::null_mut()
                    } else {
                        unsafe { *(p as *mut *mut NSObject) }
                    }
                };
                // 类与常量缺一不可（任一缺失都返回 None → apply 报可见错误）
                let (Some(nsstring), Some(nsnumber), Some(nsdictionary), Some(nsfilemanager), Some(nsurl)) = (
                    class_of(c"NSString"),
                    class_of(c"NSNumber"),
                    class_of(c"NSDictionary"),
                    class_of(c"NSFileManager"),
                    class_of(c"NSURL"),
                ) else {
                    return None;
                };
                Some(Symbols {
                    nsstring,
                    nsnumber,
                    nsdictionary,
                    nsfilemanager,
                    nsurl,
                    backup_key: sym(c"NSURLIsExcludedFromBackupKey"),
                    file_protection_key: sym(c"NSFileProtectionKey"),
                    protection_until_first_auth: sym(c"NSFileProtectionCompleteUntilFirstUserAuthentication"),
                })
            })
            .as_ref()
    }

    fn ns_string(s: &str) -> *mut NSObject {
        let Some(symbols) = symbols() else {
            return std::ptr::null_mut();
        };
        let ptr = match std::ffi::CString::new(s) {
            Ok(p) => p,
            Err(_) => return std::ptr::null_mut(),
        };
        unsafe { msg_send![symbols.nsstring, stringWithUTF8String: ptr.as_ptr()] }
    }

    /// 路径的文件 URL（目录与文件同型调用；isDirectory 只影响补斜杠语义，此处无感）。
    fn file_url(path: &Path) -> *mut NSObject {
        let Some(symbols) = symbols() else {
            return std::ptr::null_mut();
        };
        let p = ns_string(&path.to_string_lossy());
        if p.is_null() {
            return std::ptr::null_mut();
        }
        unsafe { msg_send![symbols.nsurl, fileURLWithPath: p] }
    }

    fn set_excluded_from_backup(path: &Path) -> Result<(), String> {
        let symbols = symbols().ok_or("FILE_PROTECTION: Foundation 不可用")?;
        if symbols.backup_key.is_null() {
            return Err("FILE_PROTECTION: NSURLIsExcludedFromBackupKey 符号缺失".into());
        }
        let url = file_url(path);
        if url.is_null() {
            return Err("FILE_PROTECTION: 路径无法转成文件 URL".into());
        }
        let yes: *mut NSObject = unsafe { msg_send![symbols.nsnumber, numberWithBool: true] };
        let ok: bool = unsafe {
            msg_send![url, setResourceValue: yes, forKey: symbols.backup_key, error: std::ptr::null_mut::<*mut NSObject>()]
        };
        if ok {
            Ok(())
        } else {
            Err(format!("FILE_PROTECTION: 备份排除设置失败：{}", path.display()))
        }
    }

    fn is_excluded_from_backup(path: &Path) -> Result<bool, String> {
        let symbols = symbols().ok_or("FILE_PROTECTION: Foundation 不可用")?;
        if symbols.backup_key.is_null() {
            return Err("FILE_PROTECTION: NSURLIsExcludedFromBackupKey 符号缺失".into());
        }
        let url = file_url(path);
        if url.is_null() {
            return Err("FILE_PROTECTION: 路径无法转成文件 URL".into());
        }
        let mut out: *mut NSObject = std::ptr::null_mut();
        let ok: bool = unsafe {
            msg_send![url, getResourceValue: &mut out, forKey: symbols.backup_key, error: std::ptr::null_mut::<*mut NSObject>()]
        };
        if !ok {
            return Err(format!("FILE_PROTECTION: 备份排除读取失败：{}", path.display()));
        }
        let flag: bool = if out.is_null() {
            false
        } else {
            unsafe { msg_send![out, boolValue] }
        };
        Ok(flag)
    }

    fn set_protection_class(path: &Path) -> Result<(), String> {
        let symbols = symbols().ok_or("FILE_PROTECTION: Foundation 不可用")?;
        if symbols.file_protection_key.is_null() || symbols.protection_until_first_auth.is_null() {
            return Err("FILE_PROTECTION: NSFileProtection 符号缺失".into());
        }
        let fm: *mut NSObject = unsafe { msg_send![symbols.nsfilemanager, defaultManager] };
        if fm.is_null() {
            return Err("FILE_PROTECTION: NSFileManager 不可用".into());
        }
        let key = symbols.file_protection_key;
        let value = symbols.protection_until_first_auth;
        let objects: [*mut NSObject; 1] = [value];
        let keys: [*mut NSObject; 1] = [key];
        let dict: *mut NSObject = unsafe {
            msg_send![symbols.nsdictionary, dictionaryWithObjects: objects.as_ptr(), forKeys: keys.as_ptr(), count: 1usize]
        };
        if dict.is_null() {
            return Err("FILE_PROTECTION: 属性字典构建失败".into());
        }
        let p = ns_string(&path.to_string_lossy());
        if p.is_null() {
            return Err("FILE_PROTECTION: 路径字符串构建失败".into());
        }
        let ok: bool = unsafe {
            msg_send![fm, setAttributes: dict, ofItemAtPath: p, error: std::ptr::null_mut::<*mut NSObject>()]
        };
        if ok {
            Ok(())
        } else {
            Err(format!("FILE_PROTECTION: 文件保护设置失败：{}", path.display()))
        }
    }

    fn protection_class(path: &Path) -> Result<String, String> {
        let symbols = symbols().ok_or("FILE_PROTECTION: Foundation 不可用")?;
        if symbols.file_protection_key.is_null() {
            return Err("FILE_PROTECTION: NSFileProtectionKey 符号缺失".into());
        }
        let fm: *mut NSObject = unsafe { msg_send![symbols.nsfilemanager, defaultManager] };
        let p = ns_string(&path.to_string_lossy());
        if fm.is_null() || p.is_null() {
            return Err("FILE_PROTECTION: 文件管理器/路径不可用".into());
        }
        // 此方法返回 NSDictionary*；error: 是 NSError**，成功时保持 nil。
        // 把返回值当 BOOL、把 error 输出当字典，会让每次正常读取都误报失败。
        let attrs: *mut NSObject = unsafe {
            msg_send![fm, attributesOfItemAtPath: p, error: std::ptr::null_mut::<*mut NSObject>()]
        };
        if attrs.is_null() {
            return Err(format!("FILE_PROTECTION: 文件属性读取失败：{}", path.display()));
        }
        let value: *mut NSObject = unsafe { msg_send![attrs, objectForKey: symbols.file_protection_key] };
        if value.is_null() {
            return Ok(String::new());
        }
        let cstr: *const std::ffi::c_char = unsafe { msg_send![value, UTF8String] };
        if cstr.is_null() {
            return Ok(String::new());
        }
        Ok(unsafe { CStr::from_ptr(cstr).to_string_lossy().into_owned() })
    }

    /// 施加并回读验证两个属性（幂等：重复调用结果一致）。失败返回可见错误，不动文件内容。
    pub fn apply(path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Err(format!("FILE_PROTECTION: 路径不存在：{}", path.display()));
        }
        set_excluded_from_backup(path)?;
        set_protection_class(path)?;
        // 回读验证：两个属性都要确认真实生效
        if !is_excluded_from_backup(path)? {
            return Err(format!("FILE_PROTECTION: 备份排除验证失败：{}", path.display()));
        }
        const WANT: &str = "NSFileProtectionCompleteUntilFirstUserAuthentication";
        let got = protection_class(path)?;
        if got != WANT {
            return Err(format!(
                "FILE_PROTECTION: 文件保护验证失败：{}（got {got:?}）",
                path.display()
            ));
        }
        Ok(())
    }

    /// 测试与迁移用的只读探针：备份排除是否生效。
    #[cfg(test)]
    pub fn excluded(path: &Path) -> Result<bool, String> {
        is_excluded_from_backup(path)
    }

    /// 在 Apple 主机上实际调用相同的 Foundation 桥接，捕获返回类型/输出参数错误。
    /// macOS 可能没有文件保护属性；这里仅验证文件属性读取成功及不存在路径的失败。
    #[test]
    fn file_attribute_bridge_reads_existing_file_and_rejects_missing_file() {
        let root = std::env::temp_dir().join(format!(
            "ita-attributes-{}-{}",
            std::process::id(),
            crate::persistence::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("recording.wav");
        let bytes = b"recording must remain unchanged";
        std::fs::write(&file, bytes).unwrap();
        objc2::rc::autoreleasepool(|_| {
            assert!(protection_class(&root).is_ok());
            assert!(protection_class(&file).is_ok());
            let error = protection_class(&root.join("missing.wav")).unwrap_err();
            assert!(error.contains("文件属性读取失败"));
        });
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// 目录/文件统一入口；iOS 走真实属性施加，其他平台显式 no-op（属性不存在，行为与旧版一致）。
fn ensure_protection(path: &std::path::Path) -> StorageResult<()> {
    #[cfg(target_os = "ios")]
    return apple_protection::apply(path).map_err(err);
    #[cfg(not(target_os = "ios"))]
    {
        let _ = path;
        Ok(())
    }
}
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
    // 目录新建时立即施加保护；已存在目录的幂等迁移统一走 recover()（启动时），
    // 避免每条分块 append 都重复施加属性。
    let created = !dir.exists();
    std::fs::create_dir_all(&dir).map_err(err)?;
    if created {
        ensure_protection(&dir)?;
    }
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
    // 属性失败即整体失败（错误上抛、录音数据不动）：空 part 未纳管，下次 begin() 会按
    // 「空且无主」清理，不会留下不可见的不保护文件。
    ensure_protection(&part)?;
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
        ensure_protection(&staged)?;
        std::fs::rename(&staged, &ready).map_err(err)?;
        // rename 会改变/暴露属性：落到最终路径后再次施加并回读验证（mac-handoff P0）
        ensure_protection(&ready)?;
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
    // 升级迁移（幂等）：旧版本创建的录音目录在首次启动时补齐属性；目录不存在时不创建
    let audio_dir = db.directory.join("audio");
    if audio_dir.exists() {
        ensure_protection(&audio_dir)?;
    }
    let mut recovered = Vec::new();
    for id in ids {
        let current = manifest(db, &id)?.ok_or("CLIP_NOT_FOUND")?;
        let (part, ready) = paths(db, &id)?;
        // 旧版本升级迁移（幂等）：该 clip 名下所有现存文件（partial / final /
        // 遗留 staged）先补齐属性再走恢复分支；失败上抛、不删改任何音频数据
        let staged = ready.with_extension("wav.partial");
        for existing in [&part, &ready, &staged] {
            if existing.exists() {
                ensure_protection(existing)?;
            }
        }
        if ready.exists() && validate_wav(&ready, current.byte_length).is_ok() {
            db.connection
                .execute(
                    "UPDATE audio_clips SET status='ready' WHERE clip_id=?",
                    [&id],
                )
                .map_err(err)?;
            for leftover in [&part, &staged] {
                if leftover.exists() {
                    std::fs::remove_file(leftover).map_err(err)?;
                }
            }
        } else if part.exists() {
            let file = OpenOptions::new().write(true).open(&part).map_err(err)?;
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

    /* iOS 属性互操作测试：objc2 依赖只声明在 iOS target，这些用例在 iOS 测试构建中编译
       （可随 `cargo test --target aarch64-apple-ios` 在越狱/模拟执行环境跑）；本机 macOS
       门禁不编译。属性真实生效以 iPhone 真机验证为准（mac-handoff P0 完成标准）。 */
    #[test]
    #[cfg(all(test, target_os = "ios"))]
    fn protection_applies_and_survives_finalize_rename() {
        let root = std::env::temp_dir().join(format!(
            "ita-protect-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let db = Store::open(&root, "guest").unwrap();
        // 施加是幂等的：同一路径重复 apply 结果一致
        apple_protection::apply(&root).unwrap();
        apple_protection::apply(&root).unwrap();
        assert!(apple_protection::excluded(&root).unwrap());
        begin(&db, "clip", Value::Null).unwrap();
        append(&db, "clip", 0, &STANDARD.encode([1, 0])).unwrap();
        finalize(&db, "clip").unwrap();
        let (_, ready) = paths(&db, "clip").unwrap();
        // rename 落到最终路径后重施加过：final wav 必须带备份排除
        assert!(apple_protection::excluded(&ready).unwrap());
        // 目录与文件全在排除名单（目录由 paths() 新建时施加）
        assert!(apple_protection::excluded(&db.directory.join("audio")).unwrap());
        // 不存在的路径必须报错（不静默成功）
        assert!(apple_protection::apply(&root.join("nope")).is_err());
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(all(test, target_os = "ios"))]
    fn recover_migrates_preexisting_files_without_data_loss() {
        let root = std::env::temp_dir().join(format!(
            "ita-protect-mig-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let db = Store::open(&root, "guest").unwrap();
        begin(&db, "clip", Value::Null).unwrap();
        append(&db, "clip", 0, &STANDARD.encode([3, 0])).unwrap();
        finalize(&db, "clip").unwrap();
        let (_, ready) = paths(&db, "clip").unwrap();
        // 模拟旧版本产物：直接抹掉备份排除标记后走 recover 的幂等迁移
        clear_backup_exclusion(&ready);
        assert!(!apple_protection::excluded(&ready).unwrap());
        assert_eq!(recover(&db).unwrap()[0].status, "ready");
        assert!(apple_protection::excluded(&ready).unwrap());
        // 迁移不能动音频字节
        assert_eq!(
            STANDARD
                .decode(read(&db, "clip").unwrap().wav_b64)
                .unwrap()
                .len(),
            46
        );
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 把 NSURLIsExcludedFromBackupKey 重置回 false（模拟旧版本未设置属性的文件）。
    #[cfg(all(test, target_os = "ios"))]
    fn clear_backup_exclusion(path: &std::path::Path) {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, NSObject};

        extern "C" {
            fn dlopen(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> *mut std::ffi::c_void;
            fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::ffi::c_char) -> *mut std::ffi::c_void;
        }
        let (Some(nsstring), Some(nsnumber), Some(nsurl)) = (
            AnyClass::get(c"NSString"),
            AnyClass::get(c"NSNumber"),
            AnyClass::get(c"NSURL"),
        ) else {
            panic!("Foundation 类不可用");
        };
        unsafe {
            let h = dlopen(
                c"/System/Library/Frameworks/Foundation.framework/Foundation".as_ptr(),
                0x102,
            );
            assert!(!h.is_null());
            let sym = dlsym(h, c"NSURLIsExcludedFromBackupKey".as_ptr());
            assert!(!sym.is_null());
            let key: *mut NSObject = *(sym as *mut *mut NSObject);
            let cpath = std::ffi::CString::new(path.to_string_lossy().into_owned()).unwrap();
            let p: *mut NSObject = msg_send![nsstring, stringWithUTF8String: cpath.as_ptr()];
            let url: *mut NSObject = msg_send![nsurl, fileURLWithPath: p];
            let no: *mut NSObject = msg_send![nsnumber, numberWithBool: false];
            let ok: bool = msg_send![
                url,
                setResourceValue: no forKey: key error: std::ptr::null_mut::<*mut NSObject>()
            ];
            assert!(ok);
        }
    }
}
