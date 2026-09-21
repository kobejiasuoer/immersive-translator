import Foundation
import AppKit
import SwiftUI
import ReaderCore

/// 复习触点管理器（对齐 Windows 的 30s 调度线程 + 托盘角标 + 提醒卡 + 快速复习窗）：
/// - 每 30s：算到期数 → 刷菜单栏按钮角标与「快速复习」菜单文案 → 到点弹提醒卡。
/// - 提醒卡：右下角小窗，「N 个词今天到期 · 大约 M 分钟」+ 开始复习/今天先不了；
///   60s 无操作自动关；今天弹过不再弹。
/// - 快速复习迷你窗：识别+完形，自由切卡，可改评（按进窗时原 SRS 重算，打卡只记首次）。
@MainActor
final class ReviewTouchpointManager: ObservableObject {
    static let shared = ReviewTouchpointManager()

    /// 提醒配置（设置抽屉「提醒」组编辑）。
    @Published var config: ReminderConfig {
        didSet { store.save(config) }
    }

    /// 当前到期数（调度器刷新）。
    @Published private(set) var dueCount = 0

    private let store = ReminderStore()
    private var timer: Timer?
    private var reminderWindow: NSWindow?
    private var reminderAutoCloseWork: DispatchWorkItem?
    private var quickReviewController: QuickReviewWindowController?

    /// 菜单刷新回调（App 持有状态栏，由它落实按钮角标与菜单文案）。
    var onDueCountChange: ((Int) -> Void)?

    private init() {
        config = store.load()
    }

    // MARK: - 调度

    func start() {
        guard timer == nil else { return }
        tick()
        let t = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.tick()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        let due = currentDueCount()
        let changed = due != dueCount
        dueCount = due
        if changed {
            onDueCountChange?(due)
        }
        maybeShowReminder(due: due)
    }

    private func currentDueCount() -> Int {
        guard let file = try? ReaderStore.shared.getVocabFile() else { return 0 }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return file.words.filter { $0.srs.dueAt <= now }.count
    }

    /// 生词本变化后立即刷角标（收藏/评分/导入/划词新增后调用）。
    func refreshBadge() {
        let due = currentDueCount()
        let changed = due != dueCount
        dueCount = due
        if changed {
            onDueCountChange?(due)
        }
    }

    // MARK: - 提醒卡

    private func maybeShowReminder(due: Int) {
        let (nowMin, today) = reminderLocalNowParts()
        guard reminderShouldShowNow(config, nowMin: nowMin, due: due, today: today) else { return }
        // 先写 lastShownDay 再弹（对齐 Windows：即便用户没点按钮今天也不再弹）
        config.lastShownDay = today
        showReminderCard(due: due)
    }

    private func showReminderCard(due: Int) {
        closeReminderCard()
        let view = ReminderCardView(
            due: due,
            minutes: reminderEstimateMinutes(due: due),
            onStart: { [weak self] in
                self?.closeReminderCard()
                self?.openQuickReview()
            },
            onDismiss: { [weak self] in
                self?.closeReminderCard()
            }
        )
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 384, height: 170),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        w.title = ""
        w.titlebarAppearsTransparent = true
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.contentView = NSHostingView(rootView: view)
        reminderWindow = w
        // 右下角定位（主屏）
        if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            w.setFrameOrigin(NSPoint(x: visible.maxX - w.frame.width - 24, y: visible.minY + 76))
        } else {
            w.center()
        }
        w.makeKeyAndOrderFront(nil)

        // 60s 无操作自动关
        let work = DispatchWorkItem { [weak self] in
            self?.closeReminderCard()
        }
        reminderAutoCloseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: work)
    }

    func closeReminderCard() {
        reminderAutoCloseWork?.cancel()
        reminderAutoCloseWork = nil
        reminderWindow?.orderOut(nil)
        reminderWindow = nil
    }

    // MARK: - 快速复习

    func openQuickReview() {
        if quickReviewController == nil {
            quickReviewController = QuickReviewWindowController()
        }
        quickReviewController?.show()
    }
}

// MARK: - 提醒卡视图

struct ReminderCardView: View {
    let due: Int
    let minutes: Int
    let onStart: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "book.fill")
                    .font(.system(size: 16))
                    .foregroundColor(.accentColor)
                Text("该复习了")
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
            }
            Text("\(due) 个词今天到期 · 大约 \(minutes) 分钟")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
            HStack {
                Spacer()
                Button("今天先不了", action: onDismiss)
                    .controlSize(.small)
                Button("开始复习", action: onStart)
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 384)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

// MARK: - 提醒配置存储

final class ReminderStore {
    private var fileURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return support.appendingPathComponent("ImmersiveTranslator/review_reminder.json")
    }

    func load() -> ReminderConfig {
        guard let data = try? Data(contentsOf: fileURL),
              let cfg = try? JSONDecoder().decode(ReminderConfig.self, from: data) else {
            return .default
        }
        return cfg
    }

    func save(_ config: ReminderConfig) {
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(config) {
            try? FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}
