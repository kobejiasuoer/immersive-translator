import Combine
import Foundation
import ReaderCore

// ---------------------------------------------------------------------------
// 学习接力触发面（Windows src/lib/learningRelay.ts 的 Swift 等价实现）。
//
// syncLearningRecords：单飞（running 去重）→ 登录前置 → 读协商配置（GET
// /v1/me/config，同时落盘 server_config.json）→ protocolVersion≠2 拒绝 →
// namespace 捕获后两次复核（变了即取消）→ learning_migrate → 按序同步 7 个
// 集合（每个集合只在其 schemaVersions 含 2 时执行，options 携带 namespace +
// sync 顶层参数 + 集合参数）→ 完成后发 learning-sync-complete 通知。
// syncLearningRecordsSilently：吞错打日志（对应 console.error）。
// ---------------------------------------------------------------------------

/// 学习接力同步集合顺序（learningRelay.ts:20 逐字）。
let learningRelayCollections = [
    "reading-articles", "reading-vocab", "notes", "review-events",
    "speak-scenarios", "speak-sessions", "speak-assessments",
]

/// 学习接力协议版本（服务端协商值必须等于 2）。
private let learningRelayProtocolVersion = 2

@MainActor
final class LearningRelaySync {
    static let shared = LearningRelaySync()

    private var running: Task<[SyncSummary], Error>?
    private weak var serverAuth: ServerAuthClient?
    private var learning: LearningStore?
    private var engine: SyncEngine?
    /// 测试注入的协商配置（非 nil 时不走网络拉取 me/config）。
    var stubbedConfig: JSONObject?

    /// 测试实例（生产走 shared）。
    init(testing _: Void) {}
    /// Mac 旧 JSON 同步目录推导（learning_migrate 的 legacy sync 导入段用；
    /// Windows 旧布局是 sync/<collection>.json，Mac JSON 回退布局是
    /// sync/<namespace>/<collection>.json——namespace 与 SQLite 生产同公式：
    /// account-<user.id hex>（syncNamespace(forUserId:)），不是邮箱）。
    private var legacySyncDirectory: URL?

    private init() {}

    /// 启动接线（AppDelegate：serverAuth.bootstrap() 之后调用一次）。
    func configure(serverAuth: ServerAuthClient, learning: LearningStore, engine: SyncEngine) {
        self.serverAuth = serverAuth
        self.learning = learning
        self.engine = engine
        let legacyNamespace = syncNamespace(forUserId: serverAuth.status.user?.id)
        self.legacySyncDirectory = learning.rootDirectory
            .appendingPathComponent("sync", isDirectory: true)
            .appendingPathComponent(legacyNamespace, isDirectory: true)
    }

    /// 静默入口：失败只打日志（Windows syncLearningRecordsSilently 同语义）。
    func syncLearningRecordsSilently() async -> [SyncSummary] {
        do {
            return try await syncLearningRecords()
        } catch {
            DiagnosticLogger.log("[learning-sync] \(error)")
            return []
        }
    }

    /// 用户可见入口：失败抛给调用方展示。
    func syncLearningRecords() async throws -> [SyncSummary] {
        if let running {
            return try await running.value
        }
        let task = Task { [weak self] () throws -> [SyncSummary] in
            guard let self else { return [] }
            defer { self.running = nil }
            return try await self.runRelay()
        }
        running = task
        return try await task.value
    }

    private func runRelay() async throws -> [SyncSummary] {
        guard let serverAuth, let learning, let engine else {
            throw SyncStoreError("登录后才能同步学习资料")
        }
        guard serverAuth.status.loggedIn else {
            throw SyncStoreError("登录后才能同步学习资料")
        }
        let namespace = learning.currentNamespace()
        // 读协商配置（fetchServerConfig 同时落盘 server_config.json；fatal 广播继承）。
        let config: Any
        if let stubbedConfig {
            config = stubbedConfig
        } else {
            config = try await serverAuth.fetchServerConfig()
        }
        let syncConfig = LearningJSON.object(LearningJSON.object(config)?["sync"])
        guard LearningJSON.number(syncConfig?["protocolVersion"]) == Double(learningRelayProtocolVersion) else {
            throw SyncStoreError("服务端尚不支持学习接力协议 v2，请升级后同步")
        }
        guard learning.currentNamespace() == namespace else {
            throw SyncStoreError("账号已切换，同步已取消")
        }
        try learning.migrate(expectedNamespace: namespace, legacySyncDirectory: legacySyncDirectory)
        let collectionsConfig = LearningJSON.object(syncConfig?["collections"]) ?? [:]
        var results: [SyncSummary] = []
        for collection in learningRelayCollections {
            guard let entry = LearningJSON.object(collectionsConfig[collection]),
                  let versions = LearningJSON.array(entry["schemaVersions"]),
                  versions.contains(where: { LearningJSON.number($0) == 2 }) else {
                continue
            }
            guard learning.currentNamespace() == namespace else {
                throw SyncStoreError("账号已切换，同步已取消")
            }
            var options = SyncOptions(namespace: namespace)
            if let maxPullLimit = LearningJSON.int64(syncConfig?["maxPullLimit"]) { options.maxPullLimit = Int(maxPullLimit) }
            if let maxBodyBytes = LearningJSON.int64(syncConfig?["maxBodyBytes"]) { options.maxBodyBytes = Int(maxBodyBytes) }
            if let maxPushEntities = LearningJSON.int64(syncConfig?["maxPushEntities"]) { options.maxPushEntities = Int(maxPushEntities) }
            if let collectionBytes = LearningJSON.int64(entry["maxEntityBytes"]) {
                options.maxEntityBytes = Int(collectionBytes)
            }
            options.schemaVersions = versions.compactMap { LearningJSON.int64($0) }.map(Int.init)
            results.append(await engine.syncNow(collection, options: options))
        }
        // learningRelay.ts:25 `CustomEvent("learning-sync-complete",{detail:results})`：
        // payload 同构——userInfo["results"] 即本轮各集合的 [SyncSummary]。
        NotificationCenter.default.post(
            name: .learningSyncComplete, object: nil,
            userInfo: [learningSyncCompleteResultsKey: results]
        )
        return results
    }
}

/// learning-sync-complete 通知里承载本轮结果（[SyncSummary]）的 userInfo 键。
let learningSyncCompleteResultsKey = "results"

/// 登录态 → 学习接力静默同步的触发口径（ReaderApp.tsx:1899）：账号身份
///（user.id，游客记 "guest"）变化且处于登录态才触发；同账号重复广播早退。
struct LearningRelayLoginTrigger: Equatable {
    let account: String
    let loggedIn: Bool
}

/// 触发管线（App 接线与单测共用）：首个值是订阅时的当前状态（对应挂载时以当前
/// 账号初始化 account），只作基准不触发。
func learningRelayLoginTriggers<P: Publisher>(_ statuses: P) -> AnyPublisher<LearningRelayLoginTrigger, Never>
where P.Output == AuthStatus, P.Failure == Never {
    statuses
        .map { LearningRelayLoginTrigger(account: $0.user?.id ?? "guest", loggedIn: $0.loggedIn) }
        .removeDuplicates { $0.account == $1.account }
        .dropFirst()
        .filter(\.loggedIn)
        .eraseToAnyPublisher()
}
