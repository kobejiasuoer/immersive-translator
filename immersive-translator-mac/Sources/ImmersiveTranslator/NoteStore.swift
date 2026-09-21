import Foundation
import ReaderCore

/// 笔记库持久化：notes/ 目录下的 .md 文件（JSON frontmatter + 正文）。
/// 对齐 Windows reader_store.rs 的 note_save / note_list / note_read /
/// note_write_replay / note_delete：
/// - 同名不覆盖：base.md 存在则依次尝试 base-2.md、base-3.md……
/// - 防路径穿越：只允许纯文件名（与读删入口同一判法）。
/// - 复盘写回只改 meta.replay / updatedAt，正文不动。

struct NoteStoreError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class NoteStore {
    /// 基目录（默认应用支持目录；测试可注入临时目录）。
    let baseDirectory: URL

    init(baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.baseDirectory = support.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
    }

    private var notesDirectory: URL {
        let dir = baseDirectory.appendingPathComponent("notes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
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
        finalMeta.file = dedupedFileName(base: base)
        if finalMeta.updatedAt > 0 {
            finalMeta.updatedAt = meta.updatedAt
        } else {
            finalMeta.updatedAt = meta.createdAt
        }
        let path = try pathForFile(finalMeta.file)
        try Self.noteWithFrontmatter(meta: finalMeta, body: content)
            .data(using: .utf8)?
            .write(to: path, options: .atomic)
        return finalMeta
    }

    /// 同名不覆盖：base.md 存在则依次尝试 base-2.md、base-3.md……
    private func dedupedFileName(base: String) -> String {
        let fm = FileManager.default
        var n = 1
        while fm.fileExists(atPath: notesDirectory.appendingPathComponent(n == 1 ? "\(base).md" : "\(base)-\(n).md").path) {
            n += 1
        }
        return n == 1 ? "\(base).md" : "\(base)-\(n).md"
    }

    /// 列出全部笔记（按创建时间倒序；损坏的 frontmatter 跳过）。
    func list() throws -> [NoteMeta] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: notesDirectory, includingPropertiesForKeys: nil) else {
            return []
        }
        var metas: [NoteMeta] = []
        for path in entries where path.pathExtension.lowercased() == "md" {
            guard let text = try? String(contentsOf: path, encoding: .utf8) else { continue }
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
        guard let text = try? String(contentsOf: path, encoding: .utf8) else { return nil }
        let (meta, body) = splitNoteFrontmatter(text)
        guard var meta else { return nil }
        meta.file = file
        return (meta, body)
    }

    /// 写回 AI 复盘结果（只改 meta.replay / updatedAt，正文不动）。
    @discardableResult
    func writeReplay(file: String, replay: NoteReplay, rounds: Int, nowMs: Int64) throws -> NoteMeta {
        let path = try pathForFile(file)
        guard let text = try? String(contentsOf: path, encoding: .utf8) else {
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
        try Self.noteWithFrontmatter(meta: meta, body: body)
            .data(using: .utf8)?
            .write(to: path, options: .atomic)
        return meta
    }

    /// 删除一篇笔记。
    @discardableResult
    func delete(file: String) throws -> Bool {
        let path = try pathForFile(file)
        return (try? FileManager.default.removeItem(at: path)) != nil
    }
}
