# 口语复盘 → 生词本：功能方案 v1

> 状态：**已实现**（2026-09-24）。前端 `speakVocab.ts` + 17 个规则测试、弹层 `SpeakReviewDialog.tsx`、Rust `reader_merge_vocab_words` + 2 个存储单测；vitest / tsc / vite build / cargo test 全绿。
> 原型：[prototypes/speak-review-vocab.html](prototypes/speak-review-vocab.html)。
> 基于 windows 端现有口语陪练 / 阅读室生词本体系。

## 零、一句话

用户练完口语后，系统把「这次确实没掌握的词」列出来，用户确认后查词典补齐释义，批量合并进生词本，接上已有的复习笔记 / SRS 闭环。

**不在对话过程中自动收藏**——复盘由用户主动触发，避免噪音。

产品主链路：

```text
阅读材料 → 查词/收藏 → 口语陪练 → 发现自己不会说的词
  → 结束本轮并复盘 → 勾选 → 查释义 → 加入生词本 → 生成复习笔记 / SRS 复习
```

## 一、用户流程与交互

口语陪练页标题栏右侧新增按钮：**「✦ 结束本轮并复盘」**（低频收尾动作，不进底部控制条）。

点击后弹出「本轮复盘」弹层（居中对话框，640px）：

1. **候选列表**：词 + 音标 + 原因标签 + 一行释义；点行展开看「本轮原句（EN+ZH）+ 词性释义 + 常搭配」
2. **勾选**：证据强的默认勾选，弱的进列表但默认不勾（见第二节）
3. **底部**：`已选 N 个 · 保存时自动查词典补齐词性/释义/音标`；[稍后处理] [✓ 加入生词本（N）]，N=0 时主按钮禁用
4. **保存**：600ms 合并态（真实实现走 `reader_merge_vocab_words`），成功后切换为成功视图：
   - ✓ 已加入 N 个词 · 已排入复习计划（明天第 1 次复习）
   - 词 chips（带 D+1 排期徽标）
   - [📄 生成复习笔记] [▶ 去复习] [继续练习]
5. **空态**：本轮无弱词时显示「这轮没有明显拖后腿的词」，不打扰

## 二、候选词规则（v1 定稿，全部确定性、无模型参与）

数据来源：`SpeakSession.turns[*].shadowAttempts`（每轮 ≤10 次跟读全量落盘）→ `WordScore`（`content` / `totalScore` / `dpMessage`）→ `mapWordsToText` 得到 `WordMark.quality`（good/ok/bad/missed，`dpMessage===16` 为漏读，增读 `dpMessage===32` 本就不映射）。

聚合口径：**会话内所有 assistant 轮 × 所有跟读 attempt × 逐词 mark**，按词归一化（小写、去首尾标点）去重合并。每个候选保留：

```ts
{
  word: string;              // 原文大小写（展示用）
  latestScore: number|null;  // 最新一次评分；纯漏读为 null
  reasons: ("low"|"missed"|"substituted")[];  // 跨 attempt 合并的原因
  occurrences: number;       // 出现过的 attempt 数
  example: { en, zh };       // 首次出现处的 AI 原句 + hintZh
}
```

### 规则清单

| # | 规则 | 默认勾选 | 说明 |
|---|------|---------|------|
| R1 | **最新一次**词分 < 3.5（或有替换标记） | ✅ | 用最新分而非历史最低——「这次没掌握」看当前状态 |
| R2 | 最新一次 ≥ **4.0 → 已攻克剔除** | — | 这轮已经读会了，不再进列表打扰 |
| R3 | 漏读：**功能词表内直接丢弃** | — | a/the/of/to/is… 一百多个，漏读功能词是弱读吞音的正常现象，无词汇信号 |
| R4 | 漏读：**实词 + 某次低分**（合并） | ✅ | 最硬证据：跳过非偶然，读到也读不好 |
| R5 | 漏读：**实词 ≥ 2 次** | ✅ | 反复跳过基本是真缺口 |
| R6 | 漏读：**实词仅 1 次** | ❌ | 进列表默认不勾，排序垫底（用户确认兜底） |
| R7 | 临界词 3.5～4.0 | ❌ | 进列表默认不勾，由用户决定 |
| R8 | **候选封顶 8 个** | — | 按证据强度排序展示 Top 8，其余折叠为「另有 N 个较弱的词」 |
| R9 | **生词本唤醒**：命中已收藏且复习未过/逾期的词 | — | 不重复添加；标签升级为「已收藏 N 天 · 复习 M 次未过」，并把该词**提到今日复习队列最前** |

排序权重：R4/R1（低分）> R5 > R7/R6；同权重按出现次数、出现顺序。

### 漏读特有护栏（防「跟丢整句」噪音）

- attempt 级：`integrity` < 2.5 的那次跟读视为跟丢，**不采集**其漏读词
- 数量级：单次 attempt 漏读词 > 4 个视为跟丢整句，跳过采集
- 增读词不采集（与现有 `mapWordsToText` 行为一致）

### 明确不做（v1）

- AI 纠错词、用户口头禅、语法问题、「应该学的词」、全对话入库——信息未结构化，强行总结会带来幻觉
- 音素级诊断（/v/ 在 3 个词里不准 → 建议只练）：价值高但挤弹层，**放 v2**（`worstPhoneOf` 现成）
- drill 复查升级（练过仍差 → 强候选）、词频表替代功能词表、重听次数埋点：v2

## 三、保存到生词本

`VocabWord` 不是字符串，需要 `id / word / kind / senses / phonetic / source / srs / example`，因此不能直接存 `WordScore`：

```text
低分词 → speakVocab 生成查询请求 → 复用 readerDict.ts 词典结果转换
  → 组装 VocabWord（kind/senses/音标/搭配）→ reader_merge_vocab_words 批量合并
```

- **例句直接用本轮 AI 原句**（EN + `hintZh`），来自刚才的练习语境，比让模型编例句可靠
- **来源表示**：`source.articleId` 留空、`sentenceIdx: 0`，例句随卡保存；**不新增 sourceType**。复习卡显示「来源：口语陪练 · 场景」+ 原句，无文章不丢语境

### 重复词安全（R9）

现有 Rust 单条保存按 `id` 覆盖（`Some(existing) => *existing = word`），会冲掉 SRS 进度，因此新增批量命令：

```text
reader_merge_vocab_words
```

Rust 侧流程：加锁 → 逐个判重 → 新词追加（组装后的完整 VocabWord）→ 已有词**保留 SRS/recall**、仅合并补充例句 → 单次原子写入。

UI 侧：已收藏的词**不可勾选**，显示「已在生词本」（R9 命中时显示唤醒标签），语义诚实、不静默合并。

## 四、代码拆分

| 文件 | 职责 |
|------|------|
| `src/core/speakVocab.ts`（新） | 纯逻辑：提取候选、归一去重、最新分/原因计算、功能词表、漏读护栏、排序与折叠、词典查询请求、组装中间结构 |
| `src/core/speakVocab.test.ts`（新） | 见下「测试要点」 |
| `src/reader/SpeakView.tsx` | 标题栏入口按钮 + 复盘弹层 + 成功视图（新组件可放 `SpeakReviewDialog.tsx`） |
| `src/lib/readerStore.ts` | `mergeVocabWords` 批量接口封装 |
| `src-tauri/src/reader_store.rs` | `reader_merge_vocab_words` 命令（加锁/判重/保留 SRS/原子写） |
| contracts/schema | **不改**（新增命令不改数据结构） |

## 五、测试要点（speakVocab.test.ts）

- 单次低分（2.4）→ 候选且默认勾选
- 跨 attempt 合并：漏读 1 次 + 上次 2.9 → 一条候选、两个原因、默认勾选
- 纯漏读 1 次实词 → 候选、默认不勾；≥2 次 → 默认勾选
- 功能词（the/of）漏读 → 不产生候选
- 最新 ≥4.0 → 剔除；僵持（3.2→3.0）保留、爬坡到 3.6 仍 <3.5 保留
- integrity < 2.5 的 attempt 漏读词不采集；单次漏读 >4 截断
- 候选 >8 → 折叠计数与排序正确
- 命中已有词 → 标记 wake/dup，不产生新 VocabWord
- Rust 侧：merge 保留已有词 SRS、新增词追加、失败不落半截

## 六、实现顺序（预计 2～3 天）

1. `speakVocab.ts` 提取 + 规则 + 测试
2. 复盘弹层（列表/勾选/折叠/空态）
3. 词典查询 + 释义展示
4. `reader_merge_vocab_words`（Rust）+ 重复词保留 SRS
5. 批量保存接入 + 成功视图
6. 生成复习笔记 / 去复习按钮接入
7. 真机验证（含深色模式）

## 附：原型

[prototypes/speak-review-vocab.html](prototypes/speak-review-vocab.html) — 半保真可点击原型，覆盖：对话页入口 → 复盘弹层（勾选/展开/折叠/唤醒行）→ 加入成功 → 复习卡；顶部工具栏可切换「无弱词」场景与深色模式。
