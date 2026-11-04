import Foundation

/// 官方口语场景目录的本地全量缓存：official_speak_scenarios.json（Application
/// Support/ImmersiveTranslator/，与 SpeakStore 同基目录）。对齐 Windows
/// src-tauri/src/scenario_catalog.rs：
/// - 顶层 `{ schemaVersion: 1, scenarios: [...] }`（camelCase）；scenarios 以 JSON
///   值原样存取、不解释业务字段（字段解释权在契约与前端过滤）。
/// - 只豁免文件不存在与空文件（首启/从未拉取过）；损坏 → Err「官方口语场景缓存
///   损坏」；schemaVersion 不匹配 → Err「…版本不兼容…请升级应用后再打开」，不静默
///   清空。缓存本就是全量替换物、下一次成功拉取整体重写，读侧失败由上层降级为
///   只用内置+用户场景。
/// - 写盘 tmp+原子替换，串行锁包住读-改-写全程（Windows CACHE_LOCK 对应物）。
public struct ScenarioCacheStoreError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }

    public init(_ message: String) {
        self.message = message
    }
}

public let scenarioCacheSchemaVersion: Int64 = 1

public final class ScenarioCacheStore {
    /// 基目录（默认应用支持目录；测试可注入临时目录）。
    public let baseDirectory: URL
    /// 写盘串行锁（与 SpeakStore/SyncStore 同模式）。
    private let lock = NSLock()

    public init(baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.baseDirectory = support.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
    }

    /// 缓存文件路径（official_speak_scenarios.json；测试断言文件名/残留用）。
    public var fileURL: URL {
        baseDirectory.appendingPathComponent("official_speak_scenarios.json")
    }

    /// 读本地缓存：NotFound/空文件 → 空数组；损坏/版本不符抛错（上层 catch 降级）。
    /// 返回 JSON 值数组（原样，不解释业务字段）。
    public func read() throws -> [Any] {
        lock.lock()
        defer { lock.unlock() }
        return try readFromURL(fileURL)
    }

    /// 整体替换本地缓存（全量快照，无合并逻辑）。scenariosJson 必须是 JSON 数组
    /// 文本；数组内每项的形状由上层按契约过滤。
    public func write(scenariosJson: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let array = try Self.parseScenariosPayload(scenariosJson)
        try writeToURL(array, at: fileURL)
    }

    /// 写入载荷校验（纯逻辑，便于直测）：必须是 JSON 数组。
    public static func parseScenariosPayload(_ scenariosJson: String) throws -> [Any] {
        guard let data = scenariosJson.data(using: .utf8),
              let array = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else {
            throw ScenarioCacheStoreError("场景目录载荷必须是 JSON 数组")
        }
        return array
    }

    /// 纯逻辑（可直测）：从指定路径读缓存文件。
    func readFromURL(_ url: URL) throws -> [Any] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let text: String
        do {
            text = try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw ScenarioCacheStoreError("读取官方口语场景缓存 \(url.path) 失败: \(error.localizedDescription)")
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return []
        }
        guard let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw ScenarioCacheStoreError("官方口语场景缓存损坏: 无法解析 JSON")
        }
        let fileVersion = (object["schemaVersion"] as? NSNumber)?.int64Value ?? 0
        guard fileVersion == scenarioCacheSchemaVersion else {
            throw ScenarioCacheStoreError(
                "官方口语场景缓存版本不兼容（文件 v\(fileVersion)，应用 v\(scenarioCacheSchemaVersion)）。请升级应用后再打开。"
            )
        }
        return object["scenarios"] as? [Any] ?? []
    }

    /// 纯逻辑（可直测）：原子写（tmp + rename；写后同目录无 .tmp 残留）。
    func writeToURL(_ scenarios: [Any], at url: URL) throws {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
        } catch {
            throw ScenarioCacheStoreError("无法创建数据目录: \(error.localizedDescription)")
        }
        let object: [String: Any] = [
            "schemaVersion": scenarioCacheSchemaVersion,
            "scenarios": scenarios,
        ]
        guard JSONSerialization.isValidJSONObject(object),
              let body = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else {
            throw ScenarioCacheStoreError("序列化官方口语场景缓存失败")
        }
        let tmp = url.appendingPathExtension("tmp")
        do {
            try body.write(to: tmp, options: .atomic)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } catch {
            throw ScenarioCacheStoreError("写入 \(tmp.path) 失败: \(error.localizedDescription)")
        }
    }
}
