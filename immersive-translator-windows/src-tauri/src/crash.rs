//! panic 崩溃兜底。
//!
//! 默认 panic 行为对 GUI 子系统是黑洞：release 构建带 windows_subsystem="windows"
//! （main.rs），没有控制台，stderr 上的 panic 输出无处显示，用户只看到双击后进程
//! 一闪而过（典型如热键被占导致 setup 返回 Err、run() 末尾 expect panic）。
//! 这里在 main() 第一行装一个钩子做两件事：
//! 1. 把崩溃信息（版本 + 位置 + 消息）追加写 %TEMP%\immersive_translator_crash.log（UTF-8）；
//! 2. release 再用 MessageBoxW 弹原生错误框显示信息与日志路径——调试/测试构建
//!    绝不弹，模态框会卡死 test harness。

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 崩溃日志文件名（位于 %TEMP% 下）。
const CRASH_LOG_FILE: &str = "immersive_translator_crash.log";

/// 在 main() 第一行调用：越早装上，越没有「静默崩溃」的窗口期。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        // payload 现实中只有 &'static str 与 String 两种，其余按占位符记录
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let record = format_panic_record(ts, env!("CARGO_PKG_VERSION"), &location, &message);
        let path = crash_log_path();
        // 先落盘、后弹窗：弹窗会阻塞线程，进程若被用户/系统强杀，日志也已经写好
        append_record(&path, &record);
        // 开发构建保留了控制台，打印一份方便直接看
        eprintln!(
            "[crash] {} crash log: {}",
            record.trim_end(),
            path.display()
        );
        // 原生错误框只在 release 弹：调试/测试构建弹模态框会卡住整个 test harness
        #[cfg(not(debug_assertions))]
        show_crash_dialog(&record, &path);
    }));
}

/// %TEMP%\immersive_translator_crash.log；TEMP 读不到时退回当前目录同名文件，
/// 保证钩子在任何环境下都有可写的候选路径（与 clipboard::diag_log 的兜底思路一致）。
fn crash_log_path() -> PathBuf {
    crash_log_path_under(std::env::var_os("TEMP"))
}

/// crash_log_path 的纯函数部分（TEMP 值由参数传入，便于单测）。
fn crash_log_path_under(temp: Option<OsString>) -> PathBuf {
    match temp {
        Some(dir) => PathBuf::from(dir).join(CRASH_LOG_FILE),
        None => PathBuf::from(CRASH_LOG_FILE),
    }
}

/// 单条崩溃记录。时间戳等全部显式传入，保持纯函数便于单测断言内容；
/// 记录以空行结尾，多次崩溃追加在同一文件里仍可读。
fn format_panic_record(ts_millis: u128, version: &str, location: &str, message: &str) -> String {
    format!(
        "[{ts_millis}] immersive-translator-windows v{version} panicked at {location}\n  panic message: {message}\n\n"
    )
}

/// 追加写崩溃日志。Rust String 本身就是 UTF-8，直接写字节即满足编码要求；
/// 写失败也不能再 panic（钩子里 panic 会直接中止进程），静默放弃。
fn append_record(path: &Path, record: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(record.as_bytes());
    }
}

/// 转 UTF-16 并以 NUL 结尾（MessageBoxW 只吃宽字符串）。
/// 仅 release 弹窗与单元测试用到，门住避免 debug 非 test 构建的 dead_code 告警。
#[cfg(any(not(debug_assertions), test))]
fn wide_null(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Win32 原生错误框（MB_ICONERROR）：GUI 子系统没有控制台，这是用户唯一能看见的
/// 「程序没起来」的提示；模态阻塞正是期望行为——让进程撑到用户读完点掉为止。
#[cfg(not(debug_assertions))]
fn show_crash_dialog(record: &str, log_path: &Path) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR};

    let text = format!("{record}崩溃日志：{}", log_path.display());
    let caption = "沉浸口语：启动失败";
    unsafe {
        // HWND 传 0（不属于任何窗口的独立错误框）；MB_ICONERROR(0x10) 为红叉错误图标
        MessageBoxW(
            std::ptr::null_mut(),
            wide_null(&text).as_ptr(),
            wide_null(caption).as_ptr(),
            MB_ICONERROR,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_log_path_joins_temp_dir_and_falls_back_to_cwd() {
        assert_eq!(
            crash_log_path_under(Some(OsString::from(r"C:\Users\u\AppData\Local\Temp"))),
            PathBuf::from(r"C:\Users\u\AppData\Local\Temp").join(CRASH_LOG_FILE)
        );
        // TEMP 读不到时退回当前目录，钩子永远有可写候选
        assert_eq!(crash_log_path_under(None), PathBuf::from(CRASH_LOG_FILE));
    }

    #[test]
    fn crash_record_carries_version_location_and_message() {
        let record = format_panic_record(
            1729,
            "0.9.0",
            "src/lib.rs:1634:10",
            "error while running tauri application",
        );
        assert!(record.contains("v0.9.0"));
        assert!(record.contains("src/lib.rs:1634:10"));
        assert!(record.contains("error while running tauri application"));
        // 空行分隔多条记录，追加写后仍可读
        assert!(record.ends_with("\n\n"));
    }

    #[test]
    fn wide_null_terminates_utf16() {
        // PCWSTR 必须以 NUL 结尾，漏掉会越界读出乱码
        assert_eq!(wide_null("OK"), vec!['O' as u16, 'K' as u16, 0]);
        // 非 ASCII 字符无损转宽字符（'热' = U+70ED）
        assert_eq!(wide_null("热"), vec![0x70ED, 0]);
    }
}
