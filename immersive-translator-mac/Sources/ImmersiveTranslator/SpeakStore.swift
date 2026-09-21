import Foundation
import ReaderCore

/// 口语陪练会话持久化：reader_speak_sessions.json（原子写 + 50 条上限 +
/// schemaVersion 校验）。对齐 Windows speak_store.rs。

final class SpeakStore {
    /// 基目录（默认应用支持目录；测试可注入）。
    let baseDirectory: URL
    static let sessionLimit = 50

    init(baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.baseDirectory = support.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
    }

    private var fileURL: URL {
        baseDirectory.appendingPathComponent("reader_speak_sessions.json")
    }

    private func load() throws -> SpeakSessionsFile {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else {
            return SpeakSessionsFile()
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return SpeakSessionsFile()
        }
        guard let data = text.data(using: .utf8),
              let file = try? JSONDecoder().decode(SpeakSessionsFile.self, from: data) else {
            throw NoteStoreError(message: "口语陪练会话数据损坏")
        }
        guard file.schemaVersion == speakSchemaVersion else {
            throw NoteStoreError(message: "口语陪练数据版本不兼容（文件 v\(file.schemaVersion)，应用 v\(speakSchemaVersion)）。请升级应用后再打开。")
        }
        return file
    }

    private func write(_ file: SpeakSessionsFile) throws {
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        let data = (try? encoder.encode(file)) ?? Data()
        let tmp = fileURL.appendingPathExtension("tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tmp)
    }

    /// 列出会话（updatedAt 倒序，最近在前）。
    func listSessions() throws -> [SpeakSession] {
        var file = try load()
        file.sessions.sort { $0.updatedAt > $1.updatedAt }
        return file.sessions
    }

    /// 新建或整体更新一个会话（每轮对话后自动保存）。
    @discardableResult
    func saveSession(_ session: SpeakSession) throws -> SpeakSession {
        var file = try load()
        file.schemaVersion = speakSchemaVersion
        if let idx = file.sessions.firstIndex(where: { $0.id == session.id }) {
            file.sessions[idx] = session
        } else {
            file.sessions.append(session)
        }
        // 只留最近 50 个
        if file.sessions.count > Self.sessionLimit {
            file.sessions.sort { $0.updatedAt > $1.updatedAt }
            file.sessions = Array(file.sessions.prefix(Self.sessionLimit))
        }
        try write(file)
        return session
    }

    @discardableResult
    func deleteSession(id: String) throws -> Bool {
        var file = try load()
        let before = file.sessions.count
        file.sessions.removeAll { $0.id == id }
        guard file.sessions.count != before else { return false }
        try write(file)
        return true
    }
}
