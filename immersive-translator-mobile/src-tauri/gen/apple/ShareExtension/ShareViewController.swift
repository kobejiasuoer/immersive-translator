// Safari 入站分享扩展（share extension）—— 沉浸口语。
//
// 职责（mac-handoff P0）：接收 Safari 分享的 URL / 选中文本，做类型与大小校验后写入
// 主 App 共享的 App Group 有界交接队列；不做任何联网抓取、登录或自动保存。
// 主 App 侧（lib.rs share_handoff + 前端 LearningImport）在启动/回前台时读取队列，
// 弹出既有「加入阅读」预览确认流，用户确认后才走真实导入路径。
//
// 队列文件 <AppGroup>/share-handoff/queue.json：
//   {"version":1,"items":[{"id":..64位十六进制..,"kind":"text"|"url","text":"..","receivedAt":毫秒}]}
// 与 Rust 侧（lib.rs share_handoff）的 JSON 结构逐字段对齐，任何一侧不得单方面改动。
// 稳定 ID = SHA-256("v1|kind|text")：同一内容重复分享命中去重，不重复入队、不重复导入。
// 有界：≤20 条；单条文本 ≤200_000 UTF-8 字节、URL ≤2_048 字节；保留期 7 天（读写双侧过滤）。
// 可恢复：Data.write(.atomic) 原子落盘（临时文件+rename），进程被杀也不会留下半截队列。

import UIKit
import CryptoKit
import UniformTypeIdentifiers

private struct HandoffItem: Codable {
    var id: String
    var kind: String // "text" | "url"
    var text: String
    var receivedAt: Int64
}

/// 一次分享的接收结果：要么是校验通过的内容，要么是给用户看的拒绝原因。
enum ExtractOutcome {
    case content(kind: String, text: String)
    case rejected(String)
}

private enum HandoffQueue {
    static let appGroupId = "group.com.kobejiasuoer.reader.shared"
    static let fileVersion = 1
    static let maxItems = 20
    static let maxTextBytes = 200_000
    static let maxURLBytes = 2_048
    static let retentionMs: Int64 = 7 * 24 * 3600 * 1000

    private struct Payload: Codable { var version: Int; var items: [HandoffItem] }

    static func queueURL() -> URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else { return nil }
        return container.appendingPathComponent("share-handoff/queue.json")
    }

    static func load(now: Int64) -> [HandoffItem] {
        guard let url = queueURL(), let data = try? Data(contentsOf: url) else { return [] }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: data), payload.version == fileVersion else { return [] }
        return payload.items.filter { now - $0.receivedAt <= retentionMs }
    }

    /// 追加一条（稳定 ID 去重 + 容量/保留期收敛 + 原子落盘 + 文件保护）。
    /// 返回 "是否为新入队"：false 表示重复分享（队列无变化）。
    static func append(item: HandoffItem, now: Int64) throws -> Bool {
        var items = load(now: now)
        if items.contains(where: { $0.id == item.id }) { return false }
        items.append(item)
        items.sort { $0.receivedAt < $1.receivedAt }
        if items.count > maxItems { items = Array(items.suffix(maxItems)) }
        guard let url = queueURL() else {
            throw NSError(domain: "ShareHandoff", code: 1, userInfo: [NSLocalizedDescriptionKey: "App Group 容器不可用"])
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(Payload(version: fileVersion, items: items))
        try data.write(to: url, options: [.atomic])
        applyProtection(url)
        return true
    }

    /// 队列文件与录音同口径的隐私属性：锁屏加密（首次解锁后可读）+ 不进备份。
    static func applyProtection(_ url: URL) {
        let fm = FileManager.default
        try? fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.deletingLastPathComponent().path)
        try? fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        try? (url as NSURL).setResourceValue(true, forKey: .isExcludedFromBackupKey)
    }
}

@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let statusLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    /// 完成回调只能调一次；自动收起与手动关闭并发时以先到者为准。
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        for sub in [spinner, statusLabel, closeButton] { sub.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(sub) }
        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.text = "正在读取分享内容…"
        closeButton.setTitle("关闭", for: .normal)
        closeButton.isHidden = true
        closeButton.addTarget(self, action: #selector(finishNow), for: .touchUpInside)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            view.trailingAnchor.constraint(greaterThanOrEqualTo: statusLabel.trailingAnchor, constant: 24),
            closeButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            closeButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 20),
        ])
        spinner.startAnimating()
        extract { [weak self] result in
            DispatchQueue.main.async { self?.handle(result: result) }
        }
    }

    /// 从 NSExtensionContext 取内容：优先选中文本（public.text），退回页面 URL（public.url）。
    private func extract(done: @escaping (ExtractOutcome) -> Void) {
        let attachments = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        guard !attachments.isEmpty else { return done(.rejected("没有可接收的分享内容")) }
        if let textProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.text.identifier) }) {
            textProvider.loadItem(forTypeIdentifier: UTType.text.identifier, options: nil) { item, _ in
                let text: String
                if let s = item as? String { text = s }
                else if let s = item as? NSString { text = s as String }
                else { text = "" }
                done(Self.validate(text: text))
            }
        } else if let urlProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            urlProvider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                let text: String
                if let url = item as? URL { text = url.absoluteString }
                else if let url = item as? NSURL { text = url.absoluteString ?? "" }
                else if let s = item as? String { text = s }
                else { text = "" }
                done(Self.validate(url: text))
            }
        } else {
            done(.rejected("暂不支持的内容类型（支持网页链接与文字）"))
        }
    }

    static func validate(text raw: String) -> ExtractOutcome {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .rejected("分享的文字是空的") }
        if text.data(using: .utf8)?.count ?? 0 > HandoffQueue.maxTextBytes {
            return .rejected("文字过长，请复制正文后在 App 内粘贴导入")
        }
        return .content(kind: "text", text: text)
    }

    static func validate(url raw: String) -> ExtractOutcome {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host() != nil else {
            return .rejected("仅支持 http/https 网页链接")
        }
        if text.utf8.count > HandoffQueue.maxURLBytes { return .rejected("链接过长，请直接复制到 App 导入") }
        return .content(kind: "url", text: text)
    }

    private func handle(result: ExtractOutcome) {
        spinner.stopAnimating()
        switch result {
        case .rejected(let message):
            statusLabel.text = message
            closeButton.isHidden = false // 失败必须给用户明确结果并等手动关闭
        case .content(let kind, let text):
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let id = Self.stableId(kind: kind, text: text)
            do {
                let fresh = try HandoffQueue.append(item: HandoffItem(id: id, kind: kind, text: text, receivedAt: now), now: now)
                statusLabel.text = fresh ? "已加入阅读队列\n打开 App 确认后保存" : "内容已在阅读队列中"
                closeButton.isHidden = false
                // 成功态自动收起；失败/超时仍可手动关闭
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in self?.finishNow() }
            } catch {
                statusLabel.text = "写入队列失败：\(error.localizedDescription)"
                closeButton.isHidden = false
            }
        }
    }

    static func stableId(kind: String, text: String) -> String {
        let digest = SHA256.hash(data: Data("v1|\(kind)|\(text)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    @objc private func finishNow() {
        guard !finished else { return }
        finished = true
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
