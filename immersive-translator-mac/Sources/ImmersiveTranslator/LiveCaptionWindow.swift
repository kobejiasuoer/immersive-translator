import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ReaderCore

/// 录音直译字幕窗（R4）：双语滚动字幕 + 方向切换/开始停止/导出/清空/电平条。
/// 对齐 Windows live-caption 窗口（520×680 置顶）。

struct LiveCaptionView: View {
    @ObservedObject var controller: LiveCaptionController
    @State private var scrollTarget: Int?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.5)
            captionList
            Divider().opacity(0.5)
            footer
        }
        .frame(minWidth: 480, minHeight: 560)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 10) {
            // 方向切换（录音中锁定）
            Button {
                controller.toggleDirection()
            } label: {
                HStack(spacing: 4) {
                    Text(controller.direction.label)
                        .font(.system(size: 12.5, weight: .semibold))
                    Image(systemName: "arrow.left.arrow.right").font(.system(size: 10))
                }
            }
            .buttonStyle(.plain)
            .foregroundColor(controller.recording ? .secondary : .accentColor)
            .disabled(controller.recording)
            .help(controller.recording ? "录音中不能切换方向" : "切换翻译方向")

            if controller.recording {
                Circle().fill(Color.red).frame(width: 7, height: 7)
                Text(controller.speaking ? "正在听…" : "等待你开口")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
            }

            Spacer()

            if let error = controller.errorMessage {
                Text(error)
                    .font(.system(size: 10.5))
                    .foregroundColor(.red)
                    .lineLimit(1)
                    .help(error)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var captionList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if controller.segments.isEmpty {
                        VStack(spacing: 8) {
                            Text("🎙").font(.system(size: 34))
                            Text("点下方「开始录音」，边说边出双语字幕")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                            Text("说中文译英文，或切方向说英文译中文；停顿约 1 秒自动断句")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                    }
                    ForEach(controller.segments) { seg in
                        segmentRow(seg)
                            .id(seg.id)
                    }
                }
                .padding(14)
            }
            .onChange(of: controller.segments.last?.id) { last in
                if let last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func segmentRow(_ seg: CaptionSegment) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(seg.source.isEmpty ? "（识别中…）" : seg.source)
                    .font(.system(size: 13.5, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                if seg.state == .transcribing || seg.state == .translating {
                    ProgressView().controlSize(.mini)
                }
            }
            switch seg.state {
            case .done:
                if let target = seg.target {
                    Text(target)
                        .font(.system(size: 12.5))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .translating:
                Text("翻译中…")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .opacity(0.6)
            case .failed:
                Text(seg.target == nil ? "这句没有翻出来（网络/接口问题），原文保留" : "")
                    .font(.system(size: 11.5))
                    .foregroundColor(.orange)
            case .transcribing:
                EmptyView()
            }
        }
        .padding(.horizontal, 4)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button {
                controller.toggleRecording()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: controller.recording ? "stop.circle.fill" : "record.circle")
                        .font(.system(size: 15))
                        .foregroundColor(controller.recording ? .red : .accentColor)
                    Text(controller.recording ? "停止录音" : "开始录音")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(controller.recording ? .red : .accentColor)
                }
            }
            .buttonStyle(.plain)

            if controller.recording {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.secondary.opacity(0.2))
                        Capsule()
                            .fill(controller.level > 0.05 ? Color.green : Color.orange)
                            .frame(width: max(4, min(1, Double(controller.level)) * geo.size.width))
                    }
                }
                .frame(width: 64, height: 5)
            }

            Spacer()

            Button("保存 .md") { export(markdown: true) }
                .controlSize(.small)
                .disabled(controller.segments.isEmpty)
            Button("保存 .txt") { export(markdown: false) }
                .controlSize(.small)
                .disabled(controller.segments.isEmpty)
            Button("清空") { controller.clearSegments() }
                .controlSize(.small)
                .disabled(controller.recording || controller.segments.isEmpty)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func export(markdown: Bool) {
        let panel = NSSavePanel()
        var types: [UTType] = [.plainText]
        if markdown, let md = UTType(filenameExtension: "md") { types.insert(md, at: 0) }
        panel.allowedContentTypes = types
        panel.nameFieldStringValue = captionFileName(ext: markdown ? "md" : "txt")
        if panel.runModal() == .OK, let url = panel.url {
            let content = markdown ? controller.exportMarkdown() : controller.exportPlainText()
            try? content.data(using: .utf8)?.write(to: url, options: .atomic)
        }
    }
}

/// 录音直译窗口控制器：置顶可关面板。
@MainActor
final class LiveCaptionWindowController {
    private var controller = LiveCaptionController()
    private var window: NSWindow?

    func toggle() {
        if let window, window.isVisible {
            window.orderOut(nil)
            return
        }
        if window == nil {
            let contentView = LiveCaptionView(controller: controller)
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 680),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            w.title = "录音直译"
            w.contentView = NSHostingView(rootView: contentView)
            w.level = .floating
            w.isReleasedWhenClosed = false
            window = w
        }
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
