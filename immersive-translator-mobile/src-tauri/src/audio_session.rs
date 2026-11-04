//! iOS playback-session setup and readback. The app display name never enters these diagnostics.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioPlaybackState {
    pub category: String,
    pub output_volume: f32,
    pub outputs: Vec<String>,
}

#[cfg(target_os = "ios")]
mod ios {
    use super::AudioPlaybackState;
    use objc2::{
        msg_send,
        runtime::{AnyClass, NSObject},
    };
    use std::{
        ffi::{c_char, c_int, c_void, CStr},
        sync::OnceLock,
    };

    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    fn framework() -> Result<*mut c_void, String> {
        // Keep the framework loaded for the process lifetime, without a new dlopen ref per click.
        static HANDLE: OnceLock<Result<usize, String>> = OnceLock::new();
        let handle = HANDLE.get_or_init(|| {
            let handle = unsafe {
                dlopen(c"/System/Library/Frameworks/AVFAudio.framework/AVFAudio".as_ptr(), 0x102)
            };
            if handle.is_null() {
                Err("音频播放框架加载失败".into())
            } else {
                Ok(handle as usize)
            }
        });
        handle
            .as_ref()
            .map(|&handle| handle as *mut c_void)
            .map_err(Clone::clone)
    }

    /// Copy NSString content immediately; getters and exported constants have +0 ownership.
    unsafe fn string_value(value: *mut NSObject) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let ptr: *const c_char = msg_send![&*value, UTF8String];
        if ptr.is_null() {
            None
        } else {
            Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
        }
    }

    unsafe fn failure(stage: &str, error: *mut NSObject) -> String {
        if error.is_null() {
            return format!("{stage}（系统未返回错误信息）");
        }
        let domain: *mut NSObject = msg_send![&*error, domain];
        let code: isize = msg_send![&*error, code];
        let description: *mut NSObject = msg_send![&*error, localizedDescription];
        format!(
            "{stage}（{} / {}）：{}",
            string_value(domain).unwrap_or_else(|| "AVAudioSession".into()),
            code,
            string_value(description).unwrap_or_else(|| "音频会话操作失败".into()),
        )
    }

    /// Called on the main queue before playback or after microphone teardown, never to deactivate IO.
    pub(super) fn configure() -> Result<AudioPlaybackState, String> {
        let handle = framework()?;
        let cls = AnyClass::get(c"AVAudioSession").ok_or("音频播放会话类缺失")?;
        unsafe {
            // This exported NSString constant is not the Web Audio short value "playback".
            let symbol = dlsym(handle, c"AVAudioSessionCategoryPlayback".as_ptr());
            if symbol.is_null() {
                return Err("音频播放类别常量缺失".into());
            }
            let playback = *(symbol as *const *mut NSObject);
            if playback.is_null() {
                return Err("音频播放类别常量为空".into());
            }
            let session: *mut NSObject = msg_send![cls, sharedInstance];
            if session.is_null() {
                return Err("音频播放会话不可用".into());
            }
            let session = &*session;
            let mut error: *mut NSObject = std::ptr::null_mut();
            let ok: bool = msg_send![
                session,
                setCategory: &*playback,
                withOptions: 1usize, // AVAudioSessionCategoryOptionMixWithOthers
                error: &mut error
            ];
            if !ok {
                return Err(failure("音频播放类别设置失败", error));
            }
            error = std::ptr::null_mut();
            // AVAudioSession has setActive:error:, not a one-argument setActive: selector.
            let active: bool = msg_send![session, setActive: true, error: &mut error];
            if !active {
                return Err(failure("音频播放会话激活失败", error));
            }

            let category: *mut NSObject = msg_send![session, category];
            if category.is_null() {
                return Err("音频播放类别读取失败".into());
            }
            let matches: bool = msg_send![&*category, isEqual: &*playback];
            if !matches {
                return Err(format!(
                    "音频播放类别设置未生效（{}）",
                    string_value(category).unwrap_or_default(),
                ));
            }
            let output_volume: f32 = msg_send![session, outputVolume];
            let route: *mut NSObject = msg_send![session, currentRoute];
            let mut outputs = Vec::new();
            if !route.is_null() {
                let ports: *mut NSObject = msg_send![&*route, outputs];
                if !ports.is_null() {
                    let count: usize = msg_send![&*ports, count];
                    for index in 0..count {
                        let port: *mut NSObject = msg_send![&*ports, objectAtIndex: index];
                        if !port.is_null() {
                            // Port types only; never include a user's headphone/Bluetooth device name.
                            let kind: *mut NSObject = msg_send![&*port, portType];
                            if let Some(kind) = string_value(kind) {
                                outputs.push(kind);
                            }
                        }
                    }
                }
            }
            Ok(AudioPlaybackState {
                category: string_value(category).ok_or("音频播放类别读取失败")?,
                output_volume,
                outputs,
            })
        }
    }
}

#[cfg(target_os = "ios")]
pub(crate) fn enable_playback_audio_session() -> Result<AudioPlaybackState, String> {
    ios::configure()
}
