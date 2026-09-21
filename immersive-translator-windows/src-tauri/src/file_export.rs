//! 前端文本导出：原生「另存为」对话框 + 写 UTF-8 文件。
//!
//! 供复习笔记导出 .md 等场景复用；用户取消返回 None（不是错误）。

/// 弹原生保存对话框并写入文本。返回保存路径；用户取消返回 None。
#[tauri::command]
pub async fn save_text_file(
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("Markdown", &["md"])
        .add_filter("文本文件", &["txt"])
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let p = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&p, contents))
        .await
        .map_err(|e| format!("写入任务失败: {e}"))?
        .map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
