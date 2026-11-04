import XCTest
@testable import ReaderCore

/// 复习首页列表与 rail 筛选的行为向量（对齐 Windows VaultPage.test.tsx
/// 「rail」/「胶带列表」组与 VocabListPanel.tsx 计数口径）：
/// - 列表条目 = 到期词（已按 dueAt 排序）+ 口语会话带 coachDiff 的 user 轮；
/// - 来源标签 `《{title}》` / 划词收藏；口语条目日期 `{m}月{d}日`；
/// - rail 筛选联合过滤：口语条目只挂在 全部×全部（非词非块）；
/// - rail 计数与列表严格一致，rail 数据结构不含任何词面（防剧透数据层）。
final class VaultListEntriesTests: XCTestCase {

    private let nowMs: Int64 = 1_700_000_000_000

    private func word(
        _ id: String,
        _ word: String,
        kind: VocabKind? = .word,
        articleId: String = "art-1",
        dueAt: Int64,
        example: VocabExample? = nil
    ) -> VocabWord {
        VocabWord(
            id: id,
            word: word,
            kind: kind,
            senses: [VocabSense(pos: "v.", cn: "放松")],
            source: VocabSource(articleId: articleId, sentenceIdx: 3),
            srs: VocabSrsState(dueAt: dueAt),
            addedAt: nowMs,
            example: example
        )
    }

    private func session(
        _ id: String,
        original: String,
        segs: [CoachSeg]?,
        at: Int64
    ) -> SpeakSession {
        SpeakSession(
            id: id,
            scenario: "smalltalk",
            difficulty: .medium,
            turns: [
                SpeakTurn(role: .assistant, text: "hello", at: at - 1),
                SpeakTurn(
                    role: .user,
                    text: original,
                    coachDiff: segs.map { CoachDiff(segs: $0, note: "注意时态") },
                    at: at
                ),
            ],
            createdAt: at,
            updatedAt: at
        )
    }

    private func sourceSentence(articleId: String, sentenceIdx: Int) -> (en: String, zh: String?)? {
        articleId == "art-1" ? (en: "Time will unwind slowly in the mountains.", zh: "时间在山里缓慢舒展。") : nil
    }

    private func articleTitle(articleId: String) -> String? {
        articleId == "art-1" ? "TestChapter" : nil
    }

    // MARK: - 条目构建

    func testBuildEntriesWordsThenSpeakWithSourceLabels() {
        // due 由调用方按 dueAt 排好序传入（vm.dueWords 已排序）；构建保持传入顺序。
        let due = [
            word("w1", "unwind", kind: .chunk, dueAt: nowMs - 200),
            word("w2", "calm", dueAt: nowMs - 100),
        ]
        let sessions = [
            session("s1", original: "I very like it", segs: [
                CoachSeg(t: .keep, v: "I"),
                CoachSeg(t: .del, v: "very"),
                CoachSeg(t: .ins, v: "really"),
                CoachSeg(t: .ins, v: "enjoy"),
            ], at: nowMs),
        ]
        let entries = buildVaultListEntries(
            due: due,
            speakSessions: sessions,
            sourceSentence: sourceSentence,
            articleTitle: articleTitle
        )
        // 到期词在前（保持传入顺序）、口语纠偏在后。
        XCTAssertEqual(entries.count, 3)
        XCTAssertEqual(entries[0].id, "w:w1")
        XCTAssertEqual(entries[0].kind, .word)
        XCTAssertEqual(entries[0].sourceLabel, "《TestChapter》", "来源标签 =《{title}》")
        XCTAssertEqual(entries[2].kind, .speak)
        XCTAssertEqual(entries[2].dateLabel, dateLabel(nowMs), "口语条目日期 {m}月{d}日")
        XCTAssertEqual(entries[2].original, "I very like it")
        XCTAssertEqual(entries[2].better, "I really enjoy", "地道说法 = 非 del 片段拼接")
        XCTAssertEqual(entries[2].note, "注意时态")
        // 原句切分 pre/blank/post（findChunkRange 命中）。
        XCTAssertEqual(entries[0].blank, "unwind")
        XCTAssertEqual(entries[0].pre, "Time will ")
        XCTAssertEqual(entries[0].post, " slowly in the mountains.")
    }

    func testBuildEntriesPopupFallsBackToExampleAndLabel() {
        let due = [word("p1", "unwind", articleId: "", dueAt: nowMs, example: VocabExample(en: "She can unwind here.", zh: "她可以在这里放松。"))]
        let entries = buildVaultListEntries(
            due: due,
            speakSessions: [],
            sourceSentence: sourceSentence,
            articleTitle: articleTitle
        )
        XCTAssertEqual(entries[0].sourceLabel, "划词收藏", "无 articleId 的词 = 划词收藏")
        XCTAssertEqual(entries[0].blank, "unwind", "原句来自词条自带例句")
        XCTAssertEqual(entries[0].pre, "She can ")
        XCTAssertEqual(entries[0].sentenceZh, "她可以在这里放松。")
    }

    // MARK: - 联合过滤

    func testSpeakEntriesOnlyVisibleInAllTimesAll() {
        let entries = buildVaultListEntries(
            due: [word("w1", "unwind", dueAt: nowMs)],
            speakSessions: [session("s1", original: "I very like it", segs: [CoachSeg(t: .ins, v: "really")], at: nowMs)],
            sourceSentence: sourceSentence,
            articleTitle: articleTitle
        )
        // 口语条目非词非块：类型筛选（word/chunk）时一并隐藏——rail 计数与列表严格一致。
        XCTAssertTrue(filterVaultListEntries(entries, source: .all, type: .all).contains { $0.kind == .speak })
        XCTAssertTrue(filterVaultListEntries(entries, source: .all, type: .word).allSatisfy { $0.kind == .word })
        XCTAssertTrue(filterVaultListEntries(entries, source: .all, type: .chunk).allSatisfy { $0.kind == .word && $0.word?.kind != .chunk })
        // speak 来源筛选只剩口语条目。
        let speakOnly = filterVaultListEntries(entries, source: .speak, type: .all)
        XCTAssertEqual(speakOnly.count, 1)
        XCTAssertEqual(speakOnly[0].kind, .speak)
    }

    func testSourceFiltersPopupAndArticle() {
        let due = [
            word("a1", "unwind", articleId: "art-1", dueAt: nowMs - 1),
            word("p1", "calm", articleId: "", dueAt: nowMs),
        ]
        let entries = buildVaultListEntries(
            due: due,
            speakSessions: [],
            sourceSentence: sourceSentence,
            articleTitle: articleTitle
        )
        XCTAssertEqual(filterVaultListEntries(entries, source: .popup, type: .all).map(\.id), ["w:p1"])
        XCTAssertEqual(filterVaultListEntries(entries, source: .article("art-1"), type: .all).map(\.id), ["w:a1"])
        XCTAssertEqual(filterVaultListEntries(entries, source: .article("other"), type: .all).count, 0)
    }

    func testTypeFilterChunkOnlyHidesPlainWords() {
        let due = [
            word("w1", "unwind", kind: .word, dueAt: nowMs - 1),
            word("c1", "take root", kind: .chunk, dueAt: nowMs),
        ]
        let entries = buildVaultListEntries(
            due: due,
            speakSessions: [],
            sourceSentence: sourceSentence,
            articleTitle: articleTitle
        )
        XCTAssertEqual(filterVaultListEntries(entries, source: .all, type: .word).map(\.id), ["w:w1"])
        XCTAssertEqual(filterVaultListEntries(entries, source: .all, type: .chunk).map(\.id), ["w:c1"])
        // 再点取消（type=all）回全集。
        XCTAssertEqual(filterVaultListEntries(entries, source: .all, type: .all).count, 2)
    }

    // MARK: - rail 计数（防剧透数据层：只有计数，没有词面）

    func testRailCountsMatchListContract() {
        let due = [
            word("a1", "unwind", articleId: "art-1", dueAt: nowMs - 2),
            word("a2", "take root", kind: .chunk, articleId: "art-1", dueAt: nowMs - 1),
            word("p1", "calm", articleId: "", dueAt: nowMs),
        ]
        let sessions = [
            session("s1", original: "I very like it", segs: [CoachSeg(t: .ins, v: "really")], at: nowMs),
            session("s2", original: "no coach here", segs: nil, at: nowMs - 5),
        ]
        let counts = vaultRailCounts(due: due, speakSessions: sessions, articleTitle: articleTitle)
        // 全部 = 到期词 + 口语纠偏轮（无 coachDiff 的 user 轮不计）。
        XCTAssertEqual(counts.total, 4)
        XCTAssertEqual(counts.articleGroups.count, 1)
        XCTAssertEqual(counts.articleGroups[0].id, "art-1")
        XCTAssertEqual(counts.articleGroups[0].count, 2)
        XCTAssertEqual(counts.articleGroups[0].title, "TestChapter")
        XCTAssertEqual(counts.popupCount, 1)
        XCTAssertEqual(counts.speakCount, 1)
        XCTAssertEqual(counts.wordCount, 2)
        XCTAssertEqual(counts.chunkCount, 1)
    }

    func testRailCountsCarryNoWordSurface() {
        // 反剧透数据层：rail 计数结构不携带任何词面字段（词面只活在 VaultListEntry）。
        let counts = vaultRailCounts(
            due: [word("a1", "unwind", articleId: "art-1", dueAt: nowMs)],
            speakSessions: [],
            articleTitle: articleTitle
        )
        let mirrored = String(describing: Mirror(reflecting: counts).children.map { $0.value })
        XCTAssertFalse(mirrored.contains("unwind"), "rail 计数不得包含词面；实际=\(mirrored)")
    }

    // MARK: - Hero 形态 chips 派生

    func testHeroModeChipsDerivedFromDueQueue() {
        let withSentence = [
            word("a1", "unwind", articleId: "art-1", dueAt: nowMs),
            word("p1", "calm", articleId: "", dueAt: nowMs, example: VocabExample(en: "Stay calm.", zh: nil)),
        ]
        let chips = vaultHeroModeChips(due: withSentence, sourceSentence: sourceSentence)
        XCTAssertTrue(chips.dictation, "有原句 → 听音点亮")
        XCTAssertTrue(chips.cloze, "原句含目标词 → 填空点亮")

        let noSentence = [word("p2", "calm", articleId: "", dueAt: nowMs)]
        let chips2 = vaultHeroModeChips(due: noSentence, sourceSentence: sourceSentence)
        XCTAssertFalse(chips2.dictation)
        XCTAssertFalse(chips2.cloze, "无原句 → 完形/听音都不点亮（只剩开口）")
    }

    private func dateLabel(_ ms: Int64) -> String {
        let comps = Calendar.current.dateComponents([.month, .day], from: Date(timeIntervalSince1970: Double(ms) / 1000))
        return "\(comps.month ?? 1)月\(comps.day ?? 1)日"
    }
}
