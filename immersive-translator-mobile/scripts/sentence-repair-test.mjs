import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "ita-sentence-repair-"));
const tests = [], test = (name, run) => tests.push([name, run]);
const paragraphs = [
  ["Funding will boost domestic manufacturing, reduce reliance on foreign suppliers, and advance efforts to secure America's electric grid."],
  ["WASHINGTON— The U.S.", "Department of Energy (DOE) today announced a $237 million funding opportunity to boost American manufacturing and strengthen supply chains for critical electric grid components.", "The investment is expected to deliver an estimated $125 million in annual utility savings and keep an estimated $50 million per year in the U.S. economy that would otherwise go to foreign suppliers."],
  ["The investments will help facilitate the reliable flow of electricity for American families and businesses and position the U.S. as a global leader in foundational technologies, by incentivizing the refurbishment and reuse of critical equipment and encouraging the adoption of alternative materials and subcomponents that are sourced and made in America.", "These efforts will lower costs, strengthen grid reliability, and meet growing electricity demand."],
  ["“President Trump is bringing American industry and manufacturing back home, including the critical equipment and components needed to power our nation,” said U.S.", "Secretary of Energy Chris Wright.", "“The Energy Department is investing in American-made technologies and modernizing our grid to reduce reliance on foreign suppliers and deliver affordable, reliable, electricity.”"],
  ["This funding opportunity will support projects in two key areas:"],
  ["Up to $50 million will be provided to projects that promote greater refurbishment and reuse of existing grid equipment and materials;"],
  ["Up to $187 million will be provided to projects that will increase the use of alternative materials and subcomponents sourced and made in the U.S, reducing dependence on imports."],
  ["“America should never have to rely on foreign suppliers to keep the lights on,” said Office of Electricity Assistant Secretary Katie Jereza.", "“We’re putting American ingenuity to work, developing next-generation grid technologies that strengthen our domestic supply chain, help lower costs, and make our grid more reliable.", "The power to secure our energy future should be in our own hands.”"],
  ["The Grid Supply Chain Alternatives to Lead Energy Dominance (Grid SCALED) funding opportunity is the first of DOE’s Grid Supply Chain Program, which is authorized to provide up to $375 million to strengthen domestic supply chains for the manufacturing of distribution and power transformers, grid components, and materials.", "Additional funding announcements are anticipated in 2027 to strengthen domestic supply chains for next-generation technologies, including solid-state transformers, and promote common configurations to streamline manufacturing."],
  ["Applicants must submit a concept paper by November 20, 2026, to qualify to submit a full application.", "Full applications are due by February 8, 2027."],
];

function article() {
  const sentences = [], paragraphStarts = [];
  paragraphs.forEach((paragraph, paragraphIdx) => {
    paragraphStarts.push(sentences.length);
    paragraph.forEach(en => { const idx = sentences.length; sentences.push({ id: `news:s${idx}`, idx, paragraphIdx, en, zh: `旧译文${idx}。`, zhState: "machine" }); });
  });
  return { id: "news", sourceType: "url", sourceUrl: "https://energy.gov/news", title: "Grid Funding", titleCn: "电网投资", createdAt: 100, updatedAt: 200, lastReadAt: 150, contentRevision: "legacy-revision", sentences, paragraphStarts, progress: { sentenceIdx: 7, percent: 42, secondsListened: 88 } };
}
function state() {
  const a = article();
  return {
    articles: [a], progress: { news: 7, unrelated: 3 }, readingCompleted: { news: true },
    vocab: [{ id: "kept-word", word: "Secretary", sourceArticleId: "news", sourceSentenceIdx: 7, source: { articleId: "news", sentenceIdx: 7, sentenceId: "news:s7", extra: "preserve" }, senses: [{ pos: "n.", cn: "部长" }], dueAt: 99, generation: "keep-generation", srs: { reps: 8 }, createdAt: 20, updatedAt: 21 }],
    notes: [{ id: "kept-note", title: "My note", body: "Do not change my writing", insight: "Mine", sub: "Note", sourceArticleId: "news", sourceSentenceIdx: 18, createdAt: 30, updatedAt: 31 }],
    tasks: [{ id: "kept-task", mode: "follow", title: "Follow", source: { articleId: "news", sentenceIdx: 1 }, steps: a.sentences.slice(1, 4).map(s => s.en), reference: a.sentences[1].en, step: 2, attempts: [{ id: "kept-recording", clipId: "local-audio", reference: a.sentences[2].en, step: 1, text: "My recording", createdAt: 40, status: "recorded" }], status: "paused", draft: "My draft", createdAt: 40, updatedAt: 41 }],
    sentenceZh: { news: { 1: "我的第一部分。", 2: "我的第二部分。", 18: "截止日期。" }, unrelated: { 3: "无关译文" } },
    readLog: { day: "2026-11-05", count: 6, seen: { news: [1, 2, 6, 7, 18], unrelated: [3] } },
    sentenceParseCache: { news: { 1: { en: a.sentences[1].en, result: { trunk: "old fragment", parts: [] } }, 3: { en: a.sentences[3].en, result: { trunk: "whole sentence", parts: [] } } } },
    sessions: [{ id: "kept-session", audio: "Do not touch" }],
  };
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

try {
  const output = join(directory, "repair.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/core/repairSentenceBoundaries.ts", import.meta.url))], outfile: output, bundle: true, platform: "browser", format: "esm" });
  const { repairSentenceBoundaries: repair, sentenceBoundaryKey, practiceSourceSentenceIndex, reconcileRepairedVocabReferences } = await import(pathToFileURL(output).href);

  test("real news merges only the two U.S. fragments and retains all paragraphs and text", () => {
    const input = state(), result = repair(input), a = result.patch.articles[0];
    assert.equal(result.repairs.length, 1); assert.deepEqual(result.skipped, []);
    assert.equal(a.sentences.length, 17);
    assert.deepEqual(a.paragraphStarts, [0, 1, 3, 5, 7, 8, 9, 10, 13, 15]);
    assert.equal(a.sentences.map(s => s.en).join(" "), input.articles[0].sentences.map(s => s.en).join(" "));
    assert(a.sentences[1].en.includes("U.S. Department")); assert(a.sentences[5].en.includes("said U.S. Secretary"));
    assert.deepEqual(result.repairs[0].oldToNew, [0, 1, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.equal(a.id, "news"); assert.equal(a.createdAt, 100); assert.equal(a.updatedAt, 200); assert.equal(a.lastReadAt, 150);
    assert.notEqual(a.contentRevision, "legacy-revision"); assert.equal(a.sentenceBoundaryRepair.toBoundaryKey, sentenceBoundaryKey(a));
  });
  test("progress, vocabulary, notes, nested locators and multi-step practice move without changing IDs or recordings", () => {
    const input = state(), { patch } = repair(input), a = patch.articles[0];
    assert.equal(patch.progress.news, 5); assert.equal(patch.progress.unrelated, 3);
    assert.equal(a.progress.sentenceIdx, 5); assert.equal(a.progress.secondsListened, 88);
    assert.equal(patch.vocab[0].sourceSentenceIdx, 5); assert.equal(patch.vocab[0].source.sentenceIdx, 5); assert.equal(patch.vocab[0].source.sentenceId, "news:s6");
    assert.equal(patch.vocab[0].id, input.vocab[0].id); assert.equal(patch.vocab[0].source.extra, "preserve"); assert.deepEqual(patch.vocab[0].srs, input.vocab[0].srs); assert.equal(patch.vocab[0].generation, "keep-generation");
    assert.equal(patch.notes[0].sourceSentenceIdx, 16); assert.equal(patch.notes[0].body, input.notes[0].body); assert.equal(patch.notes[0].id, input.notes[0].id);
    assert.equal(patch.tasks[0].source.sentenceIdx, 1); assert.deepEqual(patch.tasks[0].source.sentenceIndices, [1, 1, 2]);
    assert.equal(practiceSourceSentenceIndex(patch.tasks[0].source, 2), 2);
    assert.deepEqual(patch.tasks[0].attempts, input.tasks[0].attempts); assert.deepEqual(patch.tasks[0].steps, input.tasks[0].steps); assert.equal(patch.tasks[0].reference, input.tasks[0].reference); assert.equal(patch.tasks[0].id, "kept-task");
    assert(!("readingCompleted" in patch)); assert(!("sessions" in patch));
  });
  test("complete translations and personal edits combine; reading counts deduplicate merged fragments", () => {
    const { patch } = repair(state());
    assert.equal(patch.articles[0].sentences[1].zh, "旧译文1。旧译文2。");
    assert.equal(patch.sentenceZh.news[1], "我的第一部分。我的第二部分。");
    assert.equal(patch.sentenceZh.news[16], "截止日期。");
    assert.deepEqual(patch.sentenceZh.unrelated, { 3: "无关译文" });
    assert.deepEqual(patch.readLog, { day: "2026-11-05", count: 4, seen: { news: [1, 5, 16], unrelated: [3] } });
  });
  test("partial translations stay only in the exact rollback backup, never as a complete new sentence", () => {
    const input = state(); input.articles[0].sentences[2].zh = null; delete input.sentenceZh.news[2];
    input.articles[0].sentences[1].parse = { trunk: "partial parse", parts: [] };
    const { patch, repairs } = repair(input);
    assert.equal(patch.articles[0].sentences[1].zh, null); assert.equal(patch.articles[0].sentences[1].zhState, "empty");
    assert.equal(patch.sentenceZh.news[1], undefined); assert.equal(patch.articles[0].sentences[1].parse, undefined);
    assert.deepEqual(repairs[0].backup.article, input.articles[0]); assert.deepEqual(repairs[0].backup.sentenceZh, input.sentenceZh.news);
    assert.equal(repairs[0].backup.article.sentences[1].zh, "旧译文1。");
  });
  test("personal edits may fill a missing fragment only when every effective part is complete", () => {
    const input = state(); input.articles[0].sentences[2].zh = null; delete input.sentenceZh.news[1];
    const { patch } = repair(input);
    assert.equal(patch.articles[0].sentences[1].zh, null);
    assert.equal(patch.sentenceZh.news[1], "旧译文1。我的第二部分。");
  });
  test("only unchanged whole-sentence analysis is reused; merged analysis remains in backup", () => {
    const input = state(), { patch, repairs } = repair(input);
    assert.deepEqual(Object.keys(patch.sentenceParseCache.news), ["2"]);
    assert.deepEqual(patch.sentenceParseCache.news[2], input.sentenceParseCache.news[3]);
    assert.deepEqual(repairs[0].backup.sentenceParseCache, input.sentenceParseCache.news);
  });
  test("the input is immutable and rerunning the repaired snapshot is a no-op", () => {
    const input = state(), before = structuredClone(input); deepFreeze(input);
    const result = repair(input);
    assert.deepEqual(input, before);
    assert.deepEqual(repair({ ...input, ...result.patch }), { patch: {}, repairs: [], skipped: [] });
    result.repairs[0].backup.article.sentences[0].en = "Only the backup copy changes";
    assert.equal(input.articles[0].sentences[0].en, before.articles[0].sentences[0].en);
  });
  test("predefined samples and already correct paragraphs are untouched", () => {
    for (const overrides of [{ sourceType: "sample" }, { id: "starter" }]) {
      const input = state(); Object.assign(input.articles[0], overrides); assert.deepEqual(repair(input).patch, {});
    }
    const input = state(); input.articles = [{ ...article(), id: "clean", sentences: [{ idx: 0, paragraphIdx: 0, en: "One. Two.", zh: null }], paragraphStarts: [0] }];
    const result = repair(input); assert.deepEqual(result.patch, {}); assert.equal(result.skipped[0].reason, "would-split-existing-sentence");
  });
  test("paragraph boundaries never permit a merge across paragraphs", () => {
    const input = state(); input.articles = [{ ...article(), id: "other", sentences: [{ idx: 0, paragraphIdx: 0, en: "The U.S.", zh: null }, { idx: 1, paragraphIdx: 1, en: "Department announced news.", zh: null }], paragraphStarts: [0, 1] }];
    assert.deepEqual(repair(input).patch, {});
  });
  test("ambiguous indices, malformed boundaries and unmappable references skip the whole article", () => {
    for (const corrupt of [s => s.articles[0].sentences[2].idx = 1, s => s.articles[0].paragraphStarts = [0, 0], s => s.vocab[0].sourceSentenceIdx = 99, s => s.readLog.seen.news.push(99), s => s.sentenceZh.news["01"] = "noncanonical key"]) {
      const input = state(); corrupt(input); const before = structuredClone(input), result = repair(input);
      assert.deepEqual(result.patch, {}); assert.equal(result.skipped.length, 1); assert.deepEqual(input, before);
    }
  });
  test("explicitly current reference markers prevent a second numeric remap", () => {
    const input = state(), initial = repair(input), word = structuredClone(initial.patch.vocab[0]), task = structuredClone(initial.patch.tasks[0]);
    input.vocab = [word]; input.tasks = [task];
    const result = repair(input);
    assert.deepEqual(result.patch.vocab[0], word); assert.deepEqual(result.patch.tasks[0], task);
    assert.equal(result.patch.vocab[0], word); assert.equal(result.patch.tasks[0], task);
    input.vocab[0].sourceBoundaryKey = "unknown-boundary";
    assert.equal(repair(input).skipped[0].reason, "unmappable-reference");
  });
  test("a late untagged old vocabulary row retains a proven repaired source while accepting remote learning changes", () => {
    const input = state(), { patch } = repair(input), incoming = [{ ...input.vocab[0], senses: [{ pos: "n.", cn: "云端新释义" }], dueAt: 1234 }];
    const words = reconcileRepairedVocabReferences(patch.vocab, incoming, patch.articles);
    assert.equal(words[0].sourceSentenceIdx, 5); assert.equal(words[0].source.sentenceIdx, 5);
    assert.equal(words[0].sourceBoundaryKey, patch.vocab[0].sourceBoundaryKey);
    assert.equal(words[0].senses[0].cn, "云端新释义"); assert.equal(words[0].dueAt, 1234);
    assert.equal(incoming[0].sourceSentenceIdx, 7);
    assert.equal(reconcileRepairedVocabReferences(words, words, patch.articles), words);
  });
  test("late references require either an explicit old marker or a matching current word; unknown IDs are never guessed", () => {
    const input = state(), { patch, repairs } = repair(input);
    const unknown = [{ ...input.vocab[0], id: "new-unknown-word" }];
    assert.equal(reconcileRepairedVocabReferences(patch.vocab, unknown, patch.articles), unknown);
    const tagged = [{ ...unknown[0], sourceBoundaryKey: repairs[0].fromBoundaryKey, source: { ...unknown[0].source, boundaryKey: repairs[0].fromBoundaryKey } }];
    assert.equal(reconcileRepairedVocabReferences([], tagged, patch.articles)[0].sourceSentenceIdx, 5);
    const unrelatedGeneration = [{ ...input.vocab[0], generation: "re-created-word" }];
    assert.equal(reconcileRepairedVocabReferences(patch.vocab, unrelatedGeneration, patch.articles), unrelatedGeneration);
  });

  for (const [name, run] of tests) { await run(); console.log("PASS", name); }
  console.log(`${tests.length}/${tests.length} sentence repair scenarios passed`);
} finally { await rm(directory, { recursive: true, force: true }); }
