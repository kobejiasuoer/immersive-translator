// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 崩溃钩子必须在任何启动逻辑之前装好：run() 的 setup 里一旦 panic
    // （热键被占、图标缺失等），先经过这里才有落盘与弹窗兜底，
    // 晚一步就退化回 release 下的「双击秒退黑洞」。
    immersive_translator_windows_lib::install_panic_hook();
    immersive_translator_windows_lib::run()
}
