/**
 * 生成阅读室「内容进水口」的静态资产：
 *   src/core/data/exam-wordlists.json —— 考试大纲词表（考研 / 四级 / 六级）
 *   src/core/data/library.json        —— 内置分级文库（公版书全文 + 元信息）
 *
 * 数据来源（均为公开渠道，文本属公有领域）：
 *   - 词表：mahavivo/english-wordlists（四级/六级，整理自四六级大纲）；
 *     busiyiworld/maimemo-export（2025 考研英语词汇红宝书导出）。
 *   - 文库：Standard Ebooks（github.com/standardebooks）的 XHTML 源。
 *
 * 用法：node scripts/build-intake-assets.mjs   （在 immersive-translator-windows/ 下运行）
 * 原始文件放在 ../../.tmp-assets/（不入库）；生成产物入库，日常开发无需重跑。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "../.tmp-assets");
const outDir = join(root, "src", "core", "data");
mkdirSync(outDir, { recursive: true });

// ---------------- 词表 ----------------

/** 从 mahavivo 格式行取词：`abandon [əˈbændən] vt.丢弃` → abandon */
function parseMahavivo(text) {
  const words = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    const m = line.match(/^[a-zA-Z][a-zA-Z'’-]*(?=\s|\[|$)/);
    if (!m) continue;
    const w = m[0].toLowerCase();
    // 排除把释义首词当词的行（例：句子型条目）
    if (w.length < 1 || line.length > 120) continue;
    words.add(w);
  }
  return words;
}

/** 红宝书格式：每行一个词，`#xxx` 为分组标记。 */
function parsePlainList(text) {
  const words = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^[a-zA-Z][a-zA-Z'’-]*$/.test(line)) continue;
    words.add(line.toLowerCase());
  }
  return words;
}

const cet4 = parseMahavivo(readFileSync(join(assets, "CET4_edited.txt"), "utf8"));
const cet6 = parseMahavivo(readFileSync(join(assets, "CET6_edited.txt"), "utf8"));
const kaoyan = parsePlainList(readFileSync(join(assets, "kaoyan.txt"), "utf8"));

const wordlists = {
  cet4: [...cet4].sort(),
  cet6: [...cet6].sort(),
  kaoyan: [...kaoyan].sort(),
};
writeFileSync(join(outDir, "exam-wordlists.json"), JSON.stringify(wordlists));
console.log(
  `exam-wordlists.json: cet4=${cet4.size} cet6=${cet6.size} kaoyan=${kaoyan.size}`,
);

// ---------------- 文库 ----------------

/** XHTML → 纯文本（按段落，空行分隔）。剥脚注标记与题头尾。 */
function xhtmlToText(xhtml) {
  let s = xhtml
    // 脚注引用（上标链接）与隐藏类
    .replace(/<a [^>]*epub:type="noteref"[^>]*>[\s\S]*?<\/a>/g, "")
    .replace(/<aside [^>]*>[\s\S]*?<\/aside>/g, "")
    .replace(/<header[\s\S]*?<\/header>/g, "")
    .replace(/<footer[\s\S]*?<\/footer>/g, "");
  // 块级边界 → 段落分隔
  s = s.replace(/<\/(p|h[1-6]|blockquote|div|li|figcaption)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // 剩余标签全剥
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8230;|&hellip;/g, "…");
  const paras = [];
  for (const raw of s.split(/\n{2,}/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    // 章节序号（I / II / III…）、题头页杂项
    if (/^[IVXLC]+$/.test(t)) continue;
    if (/^(by |illustrated|standard ebooks|the standard ebooks)/i.test(t)) continue;
    paras.push(t);
  }
  // 剥掉开头连续的题头行（书名/章节名：短且不带句末标点），
  // 只留正文段落；标题由库条目元信息提供，不进正文。
  while (
    paras.length > 0 &&
    paras[0].length < 60 &&
    !/[.!?…]["')」』]?$/.test(paras[0])
  ) {
    paras.shift();
  }
  return paras;
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/** 第一句（用作文库卡的摘句）。 */
function firstSentence(paras) {
  for (const p of paras) {
    const m = p.match(/^[“"']?(.{20,220}?[.!?])[”"']?( .*)?$/s);
    if (m) return m[1];
  }
  return paras[0]?.slice(0, 140) ?? "";
}

const SOURCE_BASE = "https://github.com/standardebooks";
const LIB_DEFS = [
  {
    id: "happy-prince",
    file: "happy-prince.xhtml",
    repo: "oscar-wilde_childrens-stories",
    en: "The Happy Prince",
    cn: "快乐王子",
    author: "Oscar Wilde",
    level: "B1",
    quoteStart: "One night there flew over the city a little Swallow.",
  },
  {
    id: "nightingale",
    file: "nightingale.xhtml",
    repo: "oscar-wilde_childrens-stories",
    en: "The Nightingale and the Rose",
    cn: "夜莺与玫瑰",
    author: "Oscar Wilde",
    level: "B1",
  },
  {
    id: "selfish-giant",
    file: "selfish-giant.xhtml",
    repo: "oscar-wilde_childrens-stories",
    en: "The Selfish Giant",
    cn: "自私的巨人",
    author: "Oscar Wilde",
    level: "A2",
  },
  {
    id: "devoted-friend",
    file: "devoted-friend.xhtml",
    repo: "oscar-wilde_childrens-stories",
    en: "The Devoted Friend",
    cn: "忠实的朋友",
    author: "Oscar Wilde",
    level: "B2",
  },
  {
    id: "remarkable-rocket",
    file: "remarkable-rocket.xhtml",
    repo: "oscar-wilde_childrens-stories",
    en: "The Remarkable Rocket",
    cn: "了不起的火箭",
    author: "Oscar Wilde",
    level: "B2",
  },
  {
    id: "call-of-the-wild-1",
    file: "call-wild-1.xhtml",
    repo: "jack-london_the-call-of-the-wild",
    en: "The Call of the Wild · I",
    cn: "野性的呼唤 · 第一章",
    author: "Jack London",
    level: "B2",
  },
];

const items = LIB_DEFS.map((def) => {
  const paras = xhtmlToText(readFileSync(join(assets, "library", def.file), "utf8"));
  const text = paras.join("\n\n");
  const words = countWords(text);
  return {
    id: def.id,
    en: def.en,
    cn: def.cn,
    author: def.author,
    level: def.level,
    words,
    minutes: Math.max(1, Math.round(words / 135)),
    quote: firstSentence(paras),
    sourceUrl: `${SOURCE_BASE}/${def.repo}`,
    text,
  };
});

writeFileSync(join(outDir, "library.json"), JSON.stringify(items));
console.log(
  `library.json: ${items.map((i) => `${i.id}=${i.words}w`).join(" ")}`,
);
