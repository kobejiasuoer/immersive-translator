import Foundation
import ReaderCore

/// 笔记库持久化：notes/ 目录下的 .md 文件（JSON frontmatter + 正文）。
/// 对齐 Windows reader_store.rs 的 note_save / note_list / note_read /
/// note_write_replay / note_delete：
/// - 同名不覆盖：base.md 存在则依次尝试 base-2.md、base-3.md……
/// - 防路径穿越：只允许纯文件名（与读删入口同一判法）。
/// - 复盘写回只改 meta.replay / updatedAt，正文不动。
/// - 学习接力接线后（生产恒接线）：读写全部经 LearningStore——写入走 commit
///   （files 表 + derive 派生 `notes` 实体 + 导出兼容 .md，单事务）、删除走
///   commit(nil)（tombstone 随同步传播）、读与列表 files 表优先（同步拉下来尚未
///   导出到磁盘的笔记也可见）；笔记目录随账号命名空间切换（data_dir/notes）。
///   未接线（单测）= 纯文件 IO。

struct NoteStoreError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class NoteStore {
    /// 基目录（默认应用支持目录；测试可注入临时目录）。
    let baseDirectory: URL
    /// 学习存储（nil = 纯文件 IO；生产经 ReaderViewModel 注入 LearningStore.shared）。
    let learning: LearningStore?

    init(baseDirectory: URL? = nil, learning: LearningStore? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.baseDirectory = support.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
        self.learning = learning
    }

    /// 笔记目录（Windows notes_dir = data_dir/notes：接线后命名空间感知）。
    private var notesDirectory: URL {
        let base = learning.flatMap { try? $0.dataDirectory() } ?? baseDirectory
        let dir = base.appendingPathComponent("notes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 读笔记文本（Rust read_path：files 表优先、磁盘兜底）。
    /// NotFound（文件不存在）→ nil；其余读错误抛出（BUG-029：吞成 nil 会让
    /// 调用方当空文件、下一次保存静默覆盖，对齐 LearningStore.readFileDB 只
    /// 豁免 NotFound 的既定策略）。
    private func readText(_ path: URL) throws -> String? {
        if let learning {
            do {
                return try learning.readPath(path)
            } catch is LearningFileNotFoundError {
                return nil
            }
        }
        do {
            return try String(contentsOf: path, encoding: .utf8)
        } catch let error as NSError {
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
            throw error
        }
    }

    /// 写笔记文本（Rust write_path：接线后 commit 派生 notes 实体）。
    private func writeText(_ text: String, to path: URL) throws {
        if let learning {
            try learning.commit(path, text)
            return
        }
        try text.data(using: .utf8)?.write(to: path, options: .atomic)
    }

    // MARK: - frontmatter

    static func noteWithFrontmatter(meta: NoteMeta, body: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(meta)) ?? Data("{}".utf8)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return "---\n\(json)\n---\n\(body)"
    }

    // MARK: - 纯文件名校验（防路径穿越）

    private static func isPureFileName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("/")
    }

    private func pathForFile(_ file: String) throws -> URL {
        guard Self.isPureFileName(file) else {
            throw NoteStoreError(message: "无效的笔记文件名")
        }
        return notesDirectory.appendingPathComponent(file)
    }

    // MARK: - CRUD

    /// 保存一篇新笔记（永不覆盖已有文件），返回带最终文件名的元数据。
    @discardableResult
    func save(baseName: String, content: String, meta: NoteMeta) throws -> NoteMeta {
        var base = baseName.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix(".md") { base = String(base.dropLast(3)) }
        base = base.trimmingCharacters(in: .whitespaces)
        guard Self.isPureFileName(base) else {
            throw NoteStoreError(message: "无效的笔记文件名")
        }
        var finalMeta = meta
        finalMeta.file = try dedupedFileName(base: base)
        if finalMeta.updatedAt > 0 {
            finalMeta.updatedAt = meta.updatedAt
        } else {
            finalMeta.updatedAt = meta.createdAt
        }
        let path = try pathForFile(finalMeta.file)
        do {
            try writeText(Self.noteWithFrontmatter(meta: finalMeta, body: content), to: path)
        } catch {
            // reader_store.rs note_save：`map_err(|e| format!("写入笔记失败: {e}"))`
            throw NoteStoreError(message: "写入笔记失败: \(noteErrorText(error))")
        }
        return finalMeta
    }

    /// 同名不覆盖：base.md 存在则依次尝试 base-2.md、base-3.md……（Rust
    /// dedup_note_path 以 read_path 成功判「已存在」：files 表里同步来的笔记也算）。
    /// 探测中的真实读错误向上抛（BUG-029）：吞掉会把已占用名判成空闲、直接覆盖它。
    private func dedupedFileName(base: String) throws -> String {
        let candidate = { (n: Int) in n == 1 ? "\(base).md" : "\(base)-\(n).md" }
        var n = 1
        while (try readText(notesDirectory.appendingPathComponent(candidate(n)))) != nil {
            n += 1
        }
        return candidate(n)
    }

    /// 列出全部笔记（按创建时间倒序；损坏的 frontmatter 跳过）。接线后清单 =
    /// 磁盘项 ∪ files 表行（Rust list_paths），已删除（NULL）的行剔除。
    func list() throws -> [NoteMeta] {
        let entries: [URL]
        if let learning {
            entries = (try? learning.listPaths(notesDirectory)) ?? []
        } else {
            guard let found = try? FileManager.default.contentsOfDirectory(at: notesDirectory, includingPropertiesForKeys: nil) else {
                return []
            }
            entries = found
        }
        var metas: [NoteMeta] = []
        for path in entries where path.pathExtension.lowercased() == "md" {
            // 单篇读不动（无权限等）只跳过该篇（与损坏 frontmatter 跳过同口径），
            // 不炸整个清单；写路径（save 去重/writeReplay/delete）则照常抛出保护数据。
            guard let text = try? readText(path) else { continue }
            let (meta, _) = splitNoteFrontmatter(text)
            if var meta {
                meta.file = path.lastPathComponent
                metas.append(meta)
            }
        }
        metas.sort { $0.createdAt > $1.createdAt }
        return metas
    }

    /// 读取一篇笔记；文件不存在返回 nil。
    func read(file: String) throws -> (meta: NoteMeta, content: String)? {
        let path = try pathForFile(file)
        guard let text = try readText(path) else { return nil }
        let (meta, body) = splitNoteFrontmatter(text)
        guard var meta else { return nil }
        meta.file = file
        return (meta, body)
    }

    /// 写回 AI 复盘结果（只改 meta.replay / updatedAt，正文不动）。
    @discardableResult
    func writeReplay(file: String, replay: NoteReplay, rounds: Int, nowMs: Int64) throws -> NoteMeta {
        let path = try pathForFile(file)
        guard let text = try readText(path) else {
            throw NoteStoreError(message: "读取笔记失败")
        }
        let (metaOpt, body) = splitNoteFrontmatter(text)
        guard var meta = metaOpt else {
            throw NoteStoreError(message: "笔记缺少元数据")
        }
        var updated = replay
        updated.rounds = rounds
        updated.lastAt = nowMs
        meta.replay = updated
        meta.updatedAt = nowMs
        do {
            try writeText(Self.noteWithFrontmatter(meta: meta, body: body), to: path)
        } catch {
            // reader_store.rs note_write_replay：`format!("写入笔记失败: {e}")`
            throw NoteStoreError(message: "写入笔记失败: \(noteErrorText(error))")
        }
        return meta
    }

    /// 删除一篇笔记（reader_store.rs note_delete：不存在返回 false；存在则
    /// 接线后走 commit(nil)——files 置 NULL + notes 实体 tombstone + 删导出文件）。
    /// 存在性与 read/list 同口径（files 表优先、磁盘兜底）：同步拉下来只进 files 表、
    /// 尚未导出到磁盘的笔记同样要能删（QA BUG-004：旧判法只看磁盘 → 纯云端笔记返回
    /// false、无 tombstone 无推送，重启后复活）。磁盘有副本的维持原判照删。
    @discardableResult
    func delete(file: String) throws -> Bool {
        let path = try pathForFile(file)
        guard let learning else {
            return (try? FileManager.default.removeItem(at: path)) != nil
        }
        guard try FileManager.default.fileExists(atPath: path.path) || readText(path) != nil else { return false }
        try learning.commit(path, nil)
        return true
    }
}

/// 错误 → 文本（LearningStoreError.message / LocalizedError 优先）。
private func noteErrorText(_ error: Error) -> String {
    if let storeError = error as? LearningStoreError { return storeError.message }
    return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
