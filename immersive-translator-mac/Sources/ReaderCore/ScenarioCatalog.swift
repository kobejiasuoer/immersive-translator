import Foundation

/// 官方场景目录的纯逻辑部分（对齐 Windows src/lib/scenarioCatalog.ts 的无 IO 子集）：
/// 应答 body 解析（裸数组 / `{ scenarios: [...] }` 双形状）、目录来源三态与徽标文案。
/// 装载/拉取编排（单飞、缓存、注册表）在应用层 ScenarioCatalogService。

/// 用户场景所在的同步集合（A0 syncLocalCollections 已登记，与云端目录对齐）。
/// 场景编辑器保存/读回 baseVersion 共用，杜绝字面量漂移。
public let userScenarioCollection = "speak-scenarios"

/// 官方目录来源三态（catalogBadge）。不变式：fallback ⟺ 官方桶为空（只剩内置场景）。
/// server=refresh 2xx 且装载进非空官方桶（2xx 但内容==缓存也算 server/已同步）；
/// cache=preload 命中非空本地缓存、尚无成功 refresh；fallback=官方桶空。
public enum OfficialCatalogSource: String, Equatable, Sendable {
    case server
    case cache
    case fallback
}

/// 三态徽标文案（逐字对齐 Windows OFFICIAL_CATALOG_BADGE）。
public func officialCatalogBadge(_ source: OfficialCatalogSource) -> String {
    switch source {
    case .server: return "云端目录·已同步"
    case .cache: return "云端目录·本地缓存"
    case .fallback: return "内置场景"
    }
}

/// 解析拉取应答 body：兼容 `{ scenarios: [...] }` 包装与裸数组两种服务端形状；
/// 非法 JSON / 无数组字段返回 nil（垃圾 body 不写盘）。返回过滤后的**原样 JSON
/// 对象**（保留服务端附带的未知字段，缓存写盘与「有更新才替换」比较都以它为准）。
public func parseOfficialScenariosBody(_ body: String) -> [[String: Any]]? {
    guard let data = body.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
        return nil
    }
    let list: [Any]?
    if let array = parsed as? [Any] {
        list = array
    } else if let object = parsed as? [String: Any] {
        list = object["scenarios"] as? [Any]
    } else {
        list = nil
    }
    guard let list else { return nil }
    return list.compactMap { item in
        guard isSpeakScenarioLike(item) else { return nil }
        return item as? [String: Any]
    }
}

/// 官方目录的规范化 JSON 文本（sortedKeys；缓存写盘载荷与「有更新才替换」的比较基准）。
/// 空列表 → "[]"。序列化失败（理论不可能：来料已是 JSONSerialization 值）回落 "[]"。
public func officialScenariosJSON(_ list: [[String: Any]]) -> String {
    guard JSONSerialization.isValidJSONObject(list),
          let data = try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys, .withoutEscapingSlashes]),
          let text = String(data: data, encoding: .utf8) else {
        return "[]"
    }
    return text
}
