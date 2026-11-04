import Foundation
import ReaderCore

/// 场景目录装载器（升级计划 A1 §2.1/§2.2）：启动装载 + 拉取官方目录。
/// 对齐 Windows src/lib/scenarioCatalog.ts（Tauri 三命令在 Mac 单进程里合并为本服务
/// 直接调 ServerAuth / ScenarioCacheStore / SyncStore，对外行为——路由、缓存文件形状、
/// 静默语义——不变）。
///
/// - preloadScenarioCatalog：单飞 once（装载失败也只发生一次，之后保持空注册表），
///   官方缓存（ScenarioCacheStore）+ 本地用户场景（SyncStore "speak-scenarios"）→
///   speakLogic 内存注册表。任一来源失败只清空本桶（=只剩内置 4 场景），永不 throw。
/// - refreshOfficialScenarioCatalog：单飞；每次进入口语视图都拉一次
///   GET /v1/scenarios（管理后台上下架/改版后重进即可见，**无节流**）→ 校验 → 有更新
///   才写缓存并重装载。离线、首启、未登录、接口失败、垃圾 body 全路径静默降级，
///   绝不影响 UI 主流程；in-flight 期并发调用共享同一次请求。
@MainActor
final class ScenarioCatalogService: ObservableObject {
    /// 外部依赖（生产走 ServerAuth/ScenarioCacheStore/SyncStore；测试注入 mock）。
    struct Dependencies {
        /// 读官方目录缓存（JSON 值数组；失败 throw 由本服务 catch 成空）。
        var cacheRead: () async throws -> [Any]
        /// 整体替换官方目录缓存（载荷 = 过滤后数组的 JSON 文本）。
        var cacheWrite: (String) async throws -> Void
        /// GET /v1/scenarios：非 2xx 是协议数据原样带回；仅网络/致命鉴权错误 throw。
        var fetchOfficial: () async throws -> AuthHttpResponse
        /// 本地 speak-scenarios 集合实体（含 tombstone，本服务过滤）。
        var syncStoreList: () async throws -> [StoredSyncEntity]

        /// 未接线（单测/极早期）：一切来源为空、拉取抛错——注册表只剩内置。
        static let unconfigured = Dependencies(
            cacheRead: { [] },
            cacheWrite: { _ in },
            fetchOfficial: { throw AuthError.local("scenario_catalog_unconfigured", "场景目录服务未接线") },
            syncStoreList: { [] }
        )

        /// 生产接线：缓存走 ScenarioCacheStore（文件 IO 下放后台线程）、拉取走
        /// ServerAuth.authorizedRequest（Bearer + 401 单飞刷新继承）、用户场景走
        /// 账号命名空间隔离的 SyncStore。
        static func production(
            serverAuth: ServerAuthClient,
            cacheStore: ScenarioCacheStore,
            syncStore: SyncStore?
        ) -> Dependencies {
            Dependencies(
                cacheRead: {
                    try await Task.detached(priority: .utility) { try cacheStore.read() }.value
                },
                cacheWrite: { json in
                    try await Task.detached(priority: .utility) { try cacheStore.write(scenariosJson: json) }.value
                },
                fetchOfficial: {
                    try await serverAuth.authorizedRequest(method: "GET", path: "/v1/scenarios", body: nil)
                },
                syncStoreList: {
                    guard let syncStore else { return [] }
                    return try await Task.detached(priority: .utility) { try syncStore.list(userScenarioCollection) }.value
                }
            )
        }
    }

    static let shared = ScenarioCatalogService()

    /// 当前官方目录来源（三态徽标；SwiftUI 观察它重渲染）。
    @Published private(set) var officialSource: OfficialCatalogSource = .fallback

    private var deps: Dependencies
    /// preload 单飞缓存（once 语义）。
    private var preloadTask: Task<Void, Never>?
    /// refresh 单飞（in-flight 期并发调用共享同一次请求）。
    private var refreshTask: Task<Void, Never>?
    /// 已装载的官方目录（过滤后规范化 JSON 串；「有更新才替换缓存」的比较基准）。
    private var loadedOfficialJson = ""

    init(dependencies: Dependencies = .unconfigured) {
        deps = dependencies
    }

    /// 启动接线（AppDelegate.applicationDidFinishLaunching，SpeakSyncCenter 配置之后）。
    func configure(_ dependencies: Dependencies) {
        deps = dependencies
    }

    /// 启动装载场景目录（SpeakView 出现时触发；单飞、全静默、永不 throw）。
    func preloadScenarioCatalog() async {
        if preloadTask == nil {
            preloadTask = Task { await self.loadScenarioCatalogOnce() }
        }
        await preloadTask?.value
    }

    /// 启动装载（只跑一次）：官方缓存 + 同步的用户场景 → 注册表。各来源独立
    /// 降级（catch→空列表）——装载失败=注册表空=只剩内置。
    private func loadScenarioCatalogOnce() async {
        // 官方目录缓存（空数组=无缓存；未知形状逐项被 isSpeakScenarioLike 过滤）
        let cached: [Any] = (try? await deps.cacheRead()) ?? []
        let official = cached.compactMap { item -> [String: Any]? in
            isSpeakScenarioLike(item) ? item as? [String: Any] : nil
        }
        registerOfficialScenarios(official.compactMap { SpeakScenario(jsonObject: $0) })
        loadedOfficialJson = officialScenariosJSON(official)
        // 缓存读失败被 catch 成 [] → 官方桶空 → fallback（三态不变式）。
        officialSource = official.isEmpty ? .fallback : .cache
        // 本地用户场景（A0 同步实体；tombstone 跳过）
        let stored: [StoredSyncEntity] = (try? await deps.syncStoreList()) ?? []
        let user = stored
            .filter { !$0.deleted }
            .compactMap { SpeakScenario(jsonObject: $0.payload) }
        registerUserScenarios(user)
    }

    /// 拉取官方目录（单飞）：先复用 preload 单飞保证缓存已装载，再拉
    /// GET /v1/scenarios；2xx 且过滤后内容有变化才写缓存并重装载注册表。
    /// 每次进入口语视图都调用（无节流）；in-flight 期并发调用共享同一次请求。
    /// 404（端点未上线）/ 断网 / 未登录 / 垃圾 body 全静默，永不 throw。
    func refreshOfficialScenarioCatalog() async {
        if let inFlight = refreshTask {
            await inFlight.value
            return
        }
        let task = Task { await self.refreshOfficialScenarioCatalogOnce() }
        refreshTask = task
        await task.value
    }

    private func refreshOfficialScenarioCatalogOnce() async {
        defer { refreshTask = nil }
        await preloadScenarioCatalog()
        do {
            let res = try await deps.fetchOfficial()
            guard (200..<300).contains(res.status) else { return }
            guard let list = parseOfficialScenariosBody(res.body) else { return }
            // 2xx 即视为已与云端同步（内容==缓存也算 server）；2xx 但目录为空 →
            // 桶空 → fallback（不变式保持）。404/断网/reject 不改状态（保留 cache）。
            officialSource = list.isEmpty ? .fallback : .server
            let json = officialScenariosJSON(list)
            if json != loadedOfficialJson {
                try? await deps.cacheWrite(json)
                registerOfficialScenarios(list.compactMap { SpeakScenario(jsonObject: $0) })
                loadedOfficialJson = json
            }
        } catch {
            // 断网/未登录（fetch 抛错）：静默，保留已装载的缓存结果
        }
    }
}
