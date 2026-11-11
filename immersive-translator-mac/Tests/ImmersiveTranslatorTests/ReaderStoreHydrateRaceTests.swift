import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// BUG-027：ReaderStore 域文件「读-改-写」与同步 pull（storePut → 事务内 hydrate）并发丢更新。
///
/// 全真链路（临时目录里的真实 LearningStore + SQLite + ReaderStore，不碰用户数据）：
/// - 线程 A：阅读计时的周期落盘 `recordReading`（读 reader_vocab.json → 改 readingLog → commit 回写整份）；
/// - 主线程 B：模拟同步 pull 落地——`storePut("reading-vocab")` 把他端刚改的 baseline 写进实体，
///   事务内 hydrate 重写 reader_vocab.json 快照。
/// 判据：pull 落地后，A 再跑满两轮，目标词的 baseline 必须仍是刚拉下来的值。若 A 的某轮在
/// 「读」与「写」之间被 pull 插入，它会拿拉取前的旧稿 commit：mergeUnknown 让旧标量胜出、
/// derive 以 now() 重新入队（dirty）——本地快照与待推实体同时回退 = 丢同步进度并外推。
final class ReaderStoreHydrateRaceTests: XCTestCase {
    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    /// 线程间计数器（A 每完成一轮读-改-写 +1）。
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func increment() { lock.lock(); value += 1; lock.unlock() }
        var current: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    private func word(_ id: String) -> VocabWord {
        VocabWord(
            id: id, word: id, source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(ease: 2.5, intervalDays: 0, reps: 0, dueAt: 0, lapses: 0), addedAt: 5
        )
    }

    /// 目标词在实体表（待推送的 reading-vocab）里的 baseline.reps / srs.reps。
    private func entityReps(_ learning: LearningStore, id: String) throws -> (baseline: Int64?, srs: Int64?, dirty: Bool) {
        let entity = try learning.list("reading-vocab").first { $0.id == id }
        let payload = entity.flatMap { LearningJSON.object($0.payload) }
        return (
            LearningJSON.int64(LearningJSON.object(payload?["baseline"])?["reps"]),
            LearningJSON.int64(LearningJSON.object(payload?["srs"])?["reps"]),
            entity?.dirty ?? false
        )
    }

    func testPulledVocabProgressSurvivesConcurrentReadingFlush() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("reader-hydrate-race-\(UUID().uuidString)", isDirectory: true)
        tmpDirs.append(root)
        let learning = LearningStore(rootDirectory: root, center: NotificationCenter())
        let reader = ReaderStore(baseDirectory: root, learning: learning)

        // 词库一次落库：目标词 + 陪跑词（贴近真实词库，放大读-写之间的解码/编码窗口）。
        let words = [word("target")] + (0..<10).map { word("filler-\($0)") }
        let seed = VocabFile(schemaVersion: readerSchemaVersion, words: words)
        try learning.commit(reader.vocabURL, String(decoding: try ReaderFileCodec.encode(seed), as: UTF8.self))
        guard var pulledPayload = try learning.list("reading-vocab").first(where: { $0.id == "target" })
            .flatMap({ LearningJSON.object($0.payload) }) else {
            return XCTFail("种子词未入实体表")
        }

        let cycles = Counter()
        let stop = Counter()
        let flusherDone = expectation(description: "阅读计时落盘线程退出")
        Thread.detachNewThread {
            while stop.current == 0 {
                _ = try? reader.recordReading(day: "2026-11-10", seconds: 1)
                cycles.increment()
                // 生产里阅读计时约 15s 才落盘一次；这里只留 1ms 间隙，避免紧循环在非公平锁上
                // 立即重入、饿死 pull 线程（压测要的是交错，不是锁饥饿）。
                usleep(1_000)
            }
            flusherDone.fulfill()
        }

        let iterations = 150
        var lost: [String] = []
        // 远超本地 now() 的服务端时钟：pull 实体恒压过本地 dirty 行（putTransaction 冲突规则）。
        let serverClock: Int64 = 4_000_000_000_000
        for i in 1...iterations {
            var baseline = LearningJSON.object(pulledPayload["baseline"]) ?? [:]
            baseline["reps"] = Int64(i)
            pulledPayload["baseline"] = baseline
            var srs = LearningJSON.object(pulledPayload["srs"]) ?? [:]
            srs["reps"] = Int64(i)
            pulledPayload["srs"] = srs
            // 随机错开 0–16ms（≈ A 一轮落盘时长）：pull 落在 A 读-改-写周期的随机相位上，
            // 而不是总紧跟 A 的轮次边界（那样恒落在 A 的空档里，交错被系统性规避）。
            usleep(UInt32.random(in: 0...16_000))
            try learning.storePut("reading-vocab", [
                StoredSyncEntity(
                    id: "target", baseVersion: Int64(i), updatedAt: serverClock + Int64(i) * 1_000,
                    deleted: false, schemaVersion: 2, originDevice: "phone", payload: pulledPayload, dirty: false
                ),
            ], cursor: Int64(i))
            // 等 A 在 pull 之后再完整跑两轮（跨在 pull 上的那一轮必然已写回）。
            let mark = cycles.current
            let deadline = Date().addingTimeInterval(5)
            while cycles.current < mark + 2 && Date() < deadline {
                usleep(200)
            }
            let entity = try entityReps(learning, id: "target")
            let snapshot = try reader.getVocabFile().words.first { $0.id == "target" }?.srs.reps
            if entity.baseline != Int64(i) || entity.srs != Int64(i) || snapshot != i {
                lost.append(
                    "第 \(i) 次 pull 后：实体 baseline.reps=\(entity.baseline.map(String.init) ?? "nil")"
                    + " srs.reps=\(entity.srs.map(String.init) ?? "nil") dirty=\(entity.dirty)"
                    + "，域文件 srs.reps=\(snapshot.map(String.init) ?? "nil")"
                )
            }
        }
        stop.increment()
        wait(for: [flusherDone], timeout: 10)

        // 每次 pull 后都等满 A 两轮，计数至少 2×iterations；不足说明 A 线程卡死/未运行。
        XCTAssertGreaterThanOrEqual(cycles.current, iterations * 2, "并发落盘线程应持续运行（否则未形成交错）")
        XCTAssertEqual(
            lost, [],
            "同步拉下的复习进度被并发的读-改-写以旧稿覆盖（\(lost.count)/\(iterations) 次）：\(lost.prefix(3).joined(separator: "；"))"
        )
        // 收尾同口径：域文件里的目标词也必须是最后一次 pull 的值。
        let final = try reader.getVocabFile().words.first { $0.id == "target" }
        XCTAssertEqual(final?.srs.reps, iterations)
    }
}
