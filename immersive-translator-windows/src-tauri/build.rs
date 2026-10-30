fn main() {
    // Tauri 将原始图标缓存后嵌入 EXE；显式追踪资源，避免 dev 复用旧图标。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
