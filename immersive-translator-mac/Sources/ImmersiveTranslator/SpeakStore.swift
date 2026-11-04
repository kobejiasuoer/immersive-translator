import Foundation
import ReaderCore

/// 口语陪练会话持久化：reader_speak_sessions.json（原子写 + 50 条上限 +
/// schemaVersion 校验）。对齐 Windows speak_store.rs。
///
/// 学习接力接线后（生产恒接线）：写入经 LearningStore.commit——域文件快照与
/// speak-sessions outbox 同一事务（derive 入队完整快照、消失的普通会话转
/// tombstone、practice-task 行由 preserve_practice_tasks 保留），前端不再另行
/// 入队/发 tombstone（Windows 7fc6abd 同口径）。未接线（单测/旧链路）才走
/// syncOutbox 写穿：入队与 tombstone 是纯本地文件操作，零网络。

/// 会话同步 outbox 写穿口（SpeakStore → SpeakRecordsSyncer）。
protocol SpeakSyncOutbox: AnyObject {
    /// 会话入队（fire-and-forget；超限入队失败静默——完整记录保留本机）。
    func enqueueSessionRecordSilently(_ session: SpeakSession)
    /// 删除走 tombstone（fire-and-forget）。
    func deleteSessionRecordSilently(id: String)
}

extension SpeakRecordsSyncer: SpeakSyncOutbox {}

/// 富会话 JSON 超过单条云同步上限（65536 字节）时的提示阈值——Windows
/// SpeakView.persist 的 `new TextEncoder().encode(JSON.stringify(next)).length>65536`
/// 同口径（提示不阻断保存，完整记录保留本机）。
let speakSessionOversizeBytes = 65_536

final class SpeakStore {
    /// 基目录（默认应用支持目录；测试可注入）。
    let baseDirectory: URL
    static let sessionLimit = 50
    /// 同步 outbox（AppDelegate 启动接线 SpeakSyncCenter；nil = 纯本地（测试/未接线））。
    weak var syncOutbox: SpeakSyncOutbox?
    /// 富会话超限提示回调（>65536 字节时每保存一次回调一次；控制器接到 toast）。
    var onOversizeForSync: ((SpeakSession) -> Void)?
    /// 学习接力：接线后域文件读写经 LearningStore（commit 派生 speak-sessions
    /// outbox 单事务；list 时把 practice-task 行排除出普通会话——Windows
    /// speak_store.rs speak_list_sessions 同口径）。
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

    /// 域数据目录（接线 LearningStore 后命名空间感知，与 hydrate 落点一致）。
    private var domainDirectory: URL {
        if let learning, let dir = try? learning.dataDirectory() {
            return dir
        }
        return baseDirectory
    }

    private var fileURL: URL {
        domainDirectory.appendingPathComponent("reader_speak_sessions.json")
    }

    private func readText() -> String? {
        if let learning {
            guard let text = try? learning.readPath(fileURL) else { return nil }
            return text
        }
        return try? String(contentsOf: fileURL, encoding: .utf8)
    }

    private func load() throws -> SpeakSessionsFile {
        guard let text = readText() else {
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
        let data = (try? JSONEncoder().encode(file)) ?? Data()
        if let learning {
            guard let text = String(data: data, encoding: .utf8) else {
                throw NoteStoreError(message: "口语陪练会话序列化失败")
            }
            try learning.commit(fileURL, text)
            return
        }
        try FileManager.default.createDirectory(at: domainDirectory, withIntermediateDirectories: true)
        let tmp = fileURL.appendingPathExtension("tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tmp)
    }

    /// 列出会话（updatedAt 倒序，最近在前）。practice-task 信封的实体行不进
    /// 普通会话列表（它们是练习接力的任务，渲染在 PracticeRelayList）。
    func listSessions() throws -> [SpeakSession] {
        var file = try load()
        file.sessions.sort { $0.updatedAt > $1.updatedAt }
        let taskIds = practiceTaskIds()
        guard !taskIds.isEmpty else { return file.sessions }
        return file.sessions.filter { !taskIds.contains($0.id) }
    }

    /// speak-sessions 集合里 kind==="practice-task" 的行 id（练习接力任务；
    /// hydrate 会把它们投影进 reader_speak_sessions.json，同 speak_store.rs
    /// speak_list_sessions 的 tasks 集合同源）。
    private func practiceTaskIds() -> Set<String> {
        guard let learning else { return [] }
        return Set(
            ((try? learning.list("speak-sessions")) ?? [])
                .filter { !$0.deleted && LearningJSON.string(LearningJSON.object($0.payload)?["kind"]) == "practice-task" }
                .map(\.id)
        )
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
        // 只留最近 50 个（Windows speak_store.rs speak_save_session 同口径：只
        // truncate + commit）。被裁掉的普通会话由 commit 内 derive 的「消失行 →
        // tombstone」传播删除；practice-task 行经 preserve_practice_tasks 放回域
        // 文件，永不进 tombstone 分支——50 条滚动绝不能删练习接力任务。
        var removedIds: [String] = []
        if file.sessions.count > Self.sessionLimit {
            file.sessions.sort { $0.updatedAt > $1.updatedAt }
            let kept = Array(file.sessions.prefix(Self.sessionLimit))
            removedIds = file.sessions.dropFirst(Self.sessionLimit).map(\.id)
            file.sessions = kept
        }
        try write(file)
        if let data = try? JSONEncoder().encode(session), data.count > speakSessionOversizeBytes {
            onOversizeForSync?(session)
        }
        // 学习接力已接线：commit（快照 + outbox 单事务）是 speak-sessions 唯一的
        // 写入方——对齐 Windows 7fc6abd SpeakView.persist 删掉前端
        // enqueueSessionRecordSilently、speak_store 不对裁剪 id 发 tombstone。
        // 前端再写一遍会把 derive 的完整快照覆盖成精简投影，且 500 条滚动 /
        // 裁剪 tombstone 会误删 practice-task 行。
        if learning != nil || syncOutbox == nil { return session }
        // ---- 未接线的旧链路：写穿 outbox（本地已保存；入队静默失败不影响保存结果）----
        let outbox = syncOutbox!
        let taskIds = practiceTaskIds()
        outbox.enqueueSessionRecordSilently(session)
        for id in removedIds where !taskIds.contains(id) {
            outbox.deleteSessionRecordSilently(id: id)
        }
        return session
    }

    @discardableResult
    func deleteSession(id: String) throws -> Bool {
        var file = try load()
        let before = file.sessions.count
        file.sessions.removeAll { $0.id == id }
        guard file.sessions.count != before else { return false }
        try write(file)
        // 接线后删除由 commit 的 derive tombstone 传播（Windows speak_delete_session
        // 只 commit）；未接线才走写穿 tombstone。
        if learning == nil {
            syncOutbox?.deleteSessionRecordSilently(id: id)
        }
        return true
    }
}
