import SwiftUI
import XfyunCore

/// 设置窗口「语音（讯飞）」区：三组凭据卡（评测 / 合成 / 听写）。
/// 对齐 Windows XfyunVoiceSection.tsx：
/// - 每卡 APPID + APIKey + APISecret 三输入，部分更新语义（空串不覆盖已存值）。
/// - 保存后引擎立即生效（凭据实时从 Keychain 读）。
/// - 状态徽标：已配好 ✓ / 未配置；听写留空自动回落评测凭据的说明。
/// - 状态灯（idle/testing/ok/bad）：真实签名探测（wss 降级 https GET，不耗额度），
///   401/403 → 鉴权/IP 白名单归因，其余 HTTP 状态 = 可达。

struct XfyunVoiceSettingsSection: View {
    @ObservedObject private var store = XfyunCredentialsStore.shared
    @State private var editing: [XfyunService: (appId: String, apiKey: String, apiSecret: String)] = [:]
    @State private var saveResults: [XfyunService: String] = [:]
    @State private var lights: [XfyunService: XfyunLight] = [:]
    @State private var isTestingAll = false

    /// 状态灯（对齐 Windows LightState idle|testing|ok|bad）。
    private struct XfyunLight: Equatable {
        enum State { case idle, testing, ok, bad }
        var state: State
        var message: String

        static let idle = XfyunLight(state: .idle, message: "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("讯飞开放平台的语音能力按服务独立开通。跟读评测 / 云朗读 / 口语听写各创建一个应用，凭据分别填在下面；都存本机 Keychain，不上传。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button("一键测试三个服务") {
                    testAll()
                }
                .disabled(isTestingAll)
                .controlSize(.small)
                if isTestingAll {
                    Text("探测中（不发业务请求、不耗额度）…")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            ForEach(XfyunService.allCases) { service in
                credentialCard(service)
            }

            Text("「流式听写」凭据留空时自动使用「语音评测」的凭据（两类能力常共用一个应用）。每日免费额度以讯飞控制台为准（合成约 500 次/日，朗读有本地缓存不重复扣额）。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func fields(_ service: XfyunService) -> Binding<(appId: String, apiKey: String, apiSecret: String)> {
        Binding(
            get: {
                editing[service] ?? ("", "", "")
            },
            set: { value in
                editing[service] = value
            }
        )
    }

    private func credentialCard(_ service: XfyunService) -> some View {
        let current = store.credentials[service] ?? XfyunCredentials()
        let complete = current.isComplete
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(service.label)
                    .font(.system(size: 12.5, weight: .semibold))
                if complete {
                    Label("已配置", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.green)
                        .labelStyle(.titleAndIcon)
                } else {
                    Label("未配置", systemImage: "circle.dashed")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            HStack(spacing: 10) {
                credentialField("APPID", text: bindingFor(service, \.appId))
                credentialField("APIKey", text: bindingFor(service, \.apiKey))
                credentialField("APISecret", text: bindingFor(service, \.apiSecret), secure: true)
            }

            lightRow(service)

            HStack {
                Text(service.consoleHint)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if let result = saveResults[service] {
                    Text(result)
                        .font(.system(size: 10.5))
                        .foregroundStyle(result.contains("失败") ? .red : .green)
                }
                Button("保存") {
                    save(service)
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func bindingFor(_ service: XfyunService, _ keyPath: WritableKeyPath<(appId: String, apiKey: String, apiSecret: String), String>) -> Binding<String> {
        let base = fields(service)
        return Binding(
            get: { base.wrappedValue[keyPath: keyPath] },
            set: { value in
                base.wrappedValue[keyPath: keyPath] = value
            }
        )
    }

    private func credentialField(_ label: String, text: Binding<String>, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            if secure {
                SecureField("", text: text)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11.5))
            } else {
                TextField("", text: text)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11.5))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func save(_ service: XfyunService) {
        let f = editing[service] ?? ("", "", "")
        let ok = store.update(service, appId: f.appId, apiKey: f.apiKey, apiSecret: f.apiSecret)
        saveResults[service] = ok ? "✓ 已保存" : "保存失败（Keychain 写入异常）"
        if ok {
            editing[service] = nil
            // 保存后灯复位 idle（对齐 Windows：新凭据待重测，不沿用旧结论）。
            lights[service] = .idle
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                saveResults[service] = nil
            }
        }
    }

    // MARK: - 状态灯（真实签名探测）

    /// 状态灯行：圆点 + 凭据来源 + 重测按钮；有结论时下方显示归因文案。
    @ViewBuilder
    private func lightRow(_ service: XfyunService) -> some View {
        let light = lights[service] ?? .idle
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor(light.state))
                    .frame(width: 9, height: 9)
                Text(sourceLabel(service))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(light.state == .idle ? "测试" : "重测") {
                    test(service)
                }
                .controlSize(.small)
                .disabled(light.state == .testing)
            }
            if !light.message.isEmpty {
                Text(light.message)
                    .font(.system(size: 10.5))
                    .foregroundStyle(light.state == .ok ? Color.green : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func dotColor(_ state: XfyunLight.State) -> Color {
        switch state {
        case .idle: return .secondary
        case .testing: return .orange
        case .ok: return .green
        case .bad: return .red
        }
    }

    private func sourceLabel(_ service: XfyunService) -> String {
        switch store.source(for: service) {
        case .own: return "本服务凭据"
        case .fallbackISE: return "回落评测凭据"
        case .none: return "未配置"
        }
    }

    /// 单服务探测：missingCredentials / 网络失败 / 401·403 / 可达 四态归因。
    private func test(_ service: XfyunService) {
        lights[service] = XfyunLight(state: .testing, message: "")
        let host = endpointHost(service)
        let path = endpointPath(service)
        let creds = store.creds(for: service)
        Task {
            let outcome = await XfyunServiceProbe.probe(host: host, path: path, creds: creds)
            lights[service] = XfyunLight(state: outcome.ok ? .ok : .bad, message: outcome.message)
        }
    }

    /// 一键测试三个服务：并发 TaskGroup 跑完，灯逐个落定（对齐 Windows testAll）。
    private func testAll() {
        isTestingAll = true
        let targets: [(service: XfyunService, host: String, path: String, creds: XfyunCredentials?)] =
            XfyunService.allCases.map { ($0, endpointHost($0), endpointPath($0), store.creds(for: $0)) }
        for target in targets {
            lights[target.service] = XfyunLight(state: .testing, message: "")
        }
        Task {
            await withTaskGroup(of: (XfyunService, XfyunProbeOutcome).self) { group in
                for target in targets {
                    group.addTask {
                        let outcome = await XfyunServiceProbe.probe(host: target.host, path: target.path, creds: target.creds)
                        return (target.service, outcome)
                    }
                }
                for await (service, outcome) in group {
                    lights[service] = XfyunLight(state: outcome.ok ? .ok : .bad, message: outcome.message)
                }
            }
            isTestingAll = false
        }
    }

    private func endpointHost(_ service: XfyunService) -> String {
        switch service {
        case .ise: return XfyunIse.host
        case .tts: return XfyunTts.host
        case .asr: return XfyunAsr.host
        }
    }

    private func endpointPath(_ service: XfyunService) -> String {
        switch service {
        case .ise: return XfyunIse.path
        case .tts: return XfyunTts.path
        case .asr: return XfyunAsr.path
        }
    }
}
