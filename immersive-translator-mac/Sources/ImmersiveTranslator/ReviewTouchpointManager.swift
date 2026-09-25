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

    /// 提醒卡「继续阅读」回调（App 注入：打开阅读室并直达书级断点章）。
    var onContinueReading: ((String) -> Void)?

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
        // 阅读目标态数据（无到期词时才需要）：今日已读秒数 + 书架是否有书。
        let readSeconds = (try? ReaderStore.shared.readSeconds(day: today)) ?? 0
        let hasBooks = !((try? ReaderStore.shared.listBooks()) ?? []).isEmpty
        guard reminderShouldShowNow(
            config,
            nowMin: nowMin,
            due: due,
            today: today,
            readSecondsToday: readSeconds,
            hasBooks: hasBooks
        ) else { return }
        // 先写 lastShownDay 再弹（对齐 Windows：即便用户没点按钮今天也不再弹）
        config.lastShownDay = today
        showReminderCard(due: due, readSecondsToday: readSeconds)
    }

    private func showReminderCard(due: Int, readSecondsToday: Double) {
        closeReminderCard()
        // 阅读目标态（due == 0）：取最近读的书做断点直达（书模型已落地，
        // BookMeta.progress.chapterId 即断点章，未读过的书回落第一章）。
        var book: BookMeta?
        if due == 0 {
            book = ((try? ReaderStore.shared.listBooks()) ?? []).first
        }
        let view = ReminderCardView(
            due: due,
            minutes: reminderEstimateMinutes(due: due),
            goalRemainMin: book != nil
                ? reminderReadingRemainMinutes(readGoalMin: config.readGoalMin, readSecondsToday: readSecondsToday)
                : nil,
            goalBookTitle: book?.title,
            goalChapterIdx: book.map { bookChapterIndexOf(book: $0, chapterId: $0.progress.chapterId) } ?? 0,
            goalChapterCount: book?.chapters.count ?? 0,
            onStart: { [weak self] in
                self?.closeReminderCard()
                self?.openQuickReview()
            },
            onContinueReading: book.map { target in
                { [weak self] in
                    self?.closeReminderCard()
                    self?.onContinueReading?(target.id)
                }
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

/// 双态提醒卡（对齐 Windows ReminderApp）：
/// - 到期词态（due > 0）：「N 个词今天到期」+ 开始复习。
/// - 阅读目标态（due == 0 且有书）：「还差 M 分钟」+ 继续读《书名》第 N 章。
/// - 无到期也无书：占位文案（正常调度下不会出现，兜底）。
struct ReminderCardView: View {
    let due: Int
    let minutes: Int
    /// 阅读目标态：离今日目标还差的分钟数（nil = 非阅读目标态）。
    var goalRemainMin: Int? = nil
    var goalBookTitle: String? = nil
    var goalChapterIdx: Int = 0
    var goalChapterCount: Int = 0
    let onStart: () -> Void
    var onContinueReading: (() -> Void)? = nil
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "book.fill")
                    .font(.system(size: 16))
                    .foregroundColor(.accentColor)
                Text(header)
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
            }
            message
            HStack {
                Spacer()
                Button("今天先不了", action: onDismiss)
                    .controlSize(.small)
                if due > 0 {
                    Button("开始复习", action: onStart)
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                } else if let onContinueReading {
                    Button("继续阅读", action: onContinueReading)
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                } else {
                    Button("开始复习", action: onStart)
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                        .disabled(true)
                }
            }
        }
        .padding(16)
        .frame(width: 384)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var header: String {
        if due > 0 {
            return "该复习了"
        }
        return goalRemainMin != nil ? "今日阅读目标" : "该复习了"
    }

    @ViewBuilder
    private var message: some View {
        if due > 0 {
            Text("\(due) 个词今天到期 · 大约 \(minutes) 分钟")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
        } else if let remain = goalRemainMin, let title = goalBookTitle {
            VStack(alignment: .leading, spacing: 3) {
                Text("还差 \(remain) 分钟达成今日阅读目标")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                Text("继续读《\(title)》第 \(goalChapterIdx + 1) 章（共 \(goalChapterCount) 章）")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
        } else {
            Text("今天没有到期的生词")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
        }
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
