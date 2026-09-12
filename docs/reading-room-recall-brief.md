# 产出式复习（Active Recall）—— 功能 brief

> **状态：Windows 端已实现（2026-09-12）。** 实现记录见文末 §5；自检报告见该节。
> 交互原型：`prototypes/reading-room-recall.html`（单文件、无依赖、四主题，支持 `#demo=` 直达关键状态）
> 本文回答三个问题：为什么做这个、做成什么样、怎么落地。
> 上游文档：`docs/reading-room-handoff.md`（屏 D 生词本复习流是本文的改造对象）。

---

## 0. 一句话

把复习流从**纯识别**（看词想义、翻卡评分）升级为**产出式练习**：完形填空（原句挖空打字）、听写（听句写句）、直译陷阱检测，四档 SRS 评分与所有现有数据**原样复用**。

---

## 1. 为什么是它（调研结论）

### 1.1 现状缺口：复习流是全链路里唯一的"只读"环节

阅读室现有闭环：导入 → 逐句朗读 → 查词/词块 → 收藏 → **SRS 复习**。前四步都是"接触"，只有复习负责"留下"。但现在的复习卡（`ReviewView.tsx`）是纯识别式：词在前、义在后，按 1–4 评分。用户从头到尾**没有产出过一次目标语言**。词块复习卡虽然有 `blankChunkInSentence` 挖空展示（`chunkAnnotate.ts:242`），但那是静态文本——挖空了却不能填，练习价值停留在"看"。

### 1.2 学习科学的证据方向一致

- **提取练习效应**（testing effect）：L2 词汇学习中，提取练习稳定优于重复阅读（Li 2022, *Language Teaching Research* 等 meta 线索）。
- **产出式提取的额外收益**：接受性提取（认出）每分钟学的词更多，但**产出性提取（写出）带来最大的整体增益**（Serfaty et al. 2024, *Language Learning & Technology*）；产出机会对产出性词汇学习约有 10% 的提升。
- **搭配的"产出滞后"**：L2 搭配的产出性知识显著落后于接受性知识，是需要专门训练的明确靶点（Zhang 2017；2024 接收-产出差距研究）——而词块/搭配恰好是我们已经建立的数据资产。

### 1.3 竞品全部有产出式复习，我们没有

| 产品 | 产出式练习 |
|---|---|
| Readlang | typing（打字）模式 + Blitz 快速模式 + cloze 卡（自动用收藏句挖空） |
| LingQ | 复习五件套：卡片 / 反向卡 / **完形** / **听写** / 选择题 |
| Migaku | cloze deletion 是核心工作流（sentence mining → 挖空卡） |
| Anki 生态 | cloze 删除是默认卡型之一 |
| **沉浸阅读室（现状）** | **只有识别翻卡** |

### 1.4 我们独有的差异化：直译陷阱检测

词块标注管线（`chunkAnnotate.ts`）已经让 LLM 为每个词块产出 `pattern`（槽位记法）和 `trap`（直译陷阱，如 "make momentum" ✗）。这是 Anki / Readlang / LingQ 都**没有**的数据——它们只知道词，不知道"中式学习者会在哪里翻车"。完形判分时命中 `trap` 给专门反馈（⚠ 命中直译陷阱），并把「直译陷阱命中数」积累成一个独有的长期指标（中式直译纠正率）。

### 1.5 成本几乎为零

- 判分是**纯本地字符串计算**（归一化 + 编辑距离），不新增任何 LLM 调用、网络请求、Rust 依赖。
- 听写的音频走现成 TTS 双音轨的 word 轨（`ttsSpeakAdvanced`，`usePlayback.ts` 已有独立音轨机制）。
- 数据模型**零 schema 变更**：`VocabWord` 全部字段够用；复习判分明细只往 `ReviewLogFile` 加可选字段（schemaVersion 仍为 1）。

---

## 2. 做成什么样（原型已实现，可直接体验）

打开 `prototypes/reading-room-recall.html`（或 `npx serve prototypes` 后访问），可体验的交互：

### 2.1 模式分段控件（复习卡上方）

**智能混合（默认） / 识别 / 完形 / 听写**。智能路由规则：

- `kind === "chunk"` → **完形**（词块的价值就在语境中产出）
- `kind === "word"` 且 `srs.intervalDays >= 1` → **听写**（熟词绑定听力-拼写）
- 其余新词 → **识别**（现状保留，先认脸）

四档评分带、间隔文案（忘记 10 分钟 · 困难 1 天 · 一般 3 天 · 简单 7 天）、`1–4` 快捷键全部不变——**判分只是把"建议档"描边高亮，用户仍可改选**（评分主权在用户，与研究口径一致）。

### 2.2 完形卡

- 原句中挖掉词块（句中真实词形，如 took root），空槽是**内嵌在句子里的下划线输入框**，宽度自适应。
- 中文提示默认打码（`＿＿＿`），点击显示——避免中文句直接剧透答案。
- **提示阶梯**（`H` 键逐级，用了提示会如实标注在反馈里，不参与判分）：释义 → 首字母+词数 → 槽位记法（`pattern`）。
- Enter 提交判分；"想不出来，直接看答案" 等价于 wrong。

### 2.3 判分（纯本地，`judge()` 四档）

| 判定 | 条件 | 反馈 | 建议档 |
|---|---|---|---|
| perfect | 归一化后等于句中形式，或命中 `accepted`（词条原形） | 绿 ✓ 一次写对 | 简单 |
| close | 去冠词相等，或编辑距离 ≤ max(1, ⌊len/6⌋) | 黄 ≈ 很接近，差一点 | 一般 |
| trap | 归一化后命中 `trap` 字段 | 红 ⚠ 命中直译陷阱 + 陷阱解释 | 忘记 |
| wrong | 其余 | 灰 ✗ 没想起来 + 揭示答案 | 忘记 |

归一化：小写、去标点、折空白（与 `normalizeWordKey` 的精神一致）。听写卡在字符级判分之外，按**词级命中率**复核（≥85% 算 close，否则 wrong）——整句编辑距离对长句过宽。

### 2.4 听写卡

- 自动朗读整句（原型用 Web Speech API；实现时走 `tts.rs` word 轨，不打断句子朗读音轨），**限次重播 3 次**（Space），重播次数可见。
- 听写整句 → 提交 → **词级 diff**：绿色 = 写对；红色 `+虚线` = 漏写的词；红色删除线 = 多写/写错的词；下方附完整原句。
- "听不出，看句子" 等价于 wrong 并自动重播。

### 2.5 结果摘要

一轮走完显示：产出卡四格统计（一次写对 / 接近差一点 / 直译陷阱 / 未想起）+ 识别卡单独计数。直译陷阱格是天然的"中式直译纠正率"展示位。

---

## 3. 怎么落地（Windows 端实施清单）

### 3.1 新增（纯前端，全部可测）

```
src/core/recallJudge.ts        # judge() / normalize() / levenshtein() / wordDiff()，纯函数 + 单测
src/core/recallJudge.test.ts   # 完形/听写/trap/accepted/边界（空输入、标点、冠词）用例
src/reader/RecallCard.tsx      # 三种卡形态（或拆 ClozeCard / DictationCard / RecognitionCard）
```

`ReviewView.tsx` 改造：顶部加模式分段控件；`dueVocab()` 队列按智能路由标注 `effectiveMode`；评分后逻辑不变。

### 3.2 数据（零 schema 变更）

- 完形挖空目标：`SentenceChunk.text` 本来就校验为 `en` 的连续子串（`findChunkRange`），单词条目挖 `word` 在原句中的出现（复用 `findChunkRange` 三档回退；句中词形与词条不一致时，挖句中形式、判分 `accepted` 放行词条原形）。
- 判分明细（可选）：`ReviewLogFile` 增加每卡 `{ wordId, mode, judged }` 可选字段，向后兼容（老代码忽略未知字段即可，`schemaVersion` 不动）。
- 听写音频：`ttsSpeakAdvanced(sentence, false, { track: "word", target: "reader", rate })`——word 轨本就为"不打断句子朗读"设计（handoff §9-2）。

### 3.3 设置与入口

- `ReaderSettings` 增加 `reviewMode?: "smart" | "recognition" | "cloze" | "dictation"`（可选字段，默认 smart）；设置抽屉「复习」组一行分段控件。
- 复习入口不动：书架「生词本」→ 复习页。不新增托盘/浮窗入口。

### 3.4 里程碑切分（每步可独立验收）

1. **M1 判分内核**：`recallJudge.ts` + 单测全绿（半天）。
2. **M2 完形卡**：ReviewView 接入完形形态 + 提示阶梯 + trap 反馈 + 建议档聚焦（1 天）。
3. **M3 听写卡**：TTS word 轨读句 + 限次重播 + 词级 diff（1 天）。
4. **M4 智能路由 + 摘要**：路由规则、四格统计、识别卡计数（半天）。
5. **M5 打磨**：设置项、判分明细落盘、快捷键帮助文案（半天）。

### 3.5 验收清单

- [ ] 词块卡默认走完形，挖空位置与正文下划线同源（`findChunkRange`）
- [ ] 写出 trap 形式（如 take roots / buffer from / big rain）出现红色陷阱反馈
- [ ] 判分映射只做"建议档"高亮，用户可改选任意档；SRS 状态演进与现状完全一致（`gradeSrs` 不动）
- [ ] 听写重播限 3 次且计数可见；听写不与句子朗读音轨互相打断
- [ ] `npm run test` 全绿；`readerSrs` / `readerTypes` 无破坏性变更
- [ ] 四主题下完形输入槽、diff 三色、verdict 四色对比度达标

### 3.6 明确不做（本轮）

- ❌ 语音跟读打分（ASR / whisper.cpp）——decisions #3 已推迟，跟读模式保持停顿等待
- ❌ 多选题 / 反向翻译卡——识别+完形+听写三形态已覆盖练习维度，先验证使用率
- ❌ LLM 动态生成新练习句——原句挖空的研究依据更硬，且零成本；"AI 出新题"留作后续实验
- ❌ macOS 端同步实现——按惯例 Windows 先行，契约已兼容

---

## 4. 原型技术说明

- 位置：`prototypes/reading-room-recall.html`，与 `reading-room-v2.html` 同一套设计令牌（浅/深/护眼/纯黑）。
- `#demo=` 钩子（也适合截图/分享）：`cloze` / `trap` / `hints` / `dict` / `summary` / `dark`。
- 判分、diff、路由全部是真实实现（不是假动画），可直接抄进 `recallJudge.ts`。
- 已知取舍：识别卡翻面后 judged 为空，摘要统计只计产出卡（完形/听写），识别卡单独计数——避免把"翻面"伪装成"答对/答错"。
- 截图存档：`prototypes/shots/recall/recall-*.png`（6 张，judge 视觉验收 6/6 通过）。

---

## 5. 实现记录（2026-09-12）

按 §3 落地，全部完成并通过验证。

### 5.1 交付物

| 文件 | 内容 |
|---|---|
| `src/core/recallJudge.ts` | 判分内核：normalizeAnswer / levenshtein / judgeCloze / judgeDictation / wordDiff / wordHitRate / routeRecallMode / verdictToSuggestedGrade / firstLetters，纯函数零 IO |
| `src/core/recallJudge.test.ts` | 23 个用例：归一化（撇号剥离）、trap 多候选（`/` 分隔）、去冠词、编辑距离阈值、听写词级命中率 85% 阈值、智能路由、建议档映射 |
| `src/reader/ReviewView.tsx` | 复习页重写：模式分段控件（智能混合/识别/完形/听写）+ 三种卡形态 + 提示阶梯 + 中文打码提示 + 判分反馈 + 建议档描边 + 词级 diff + 结果摘要；原句缺失或词块定位失败自动降级识别卡 |
| `src/reader/ReviewView.render.test.tsx` | SSR 渲染冒烟（react-dom/server，无新依赖）：完形/听写/识别/空态 + 完形卡不剧透词条断言 |
| `src/core/readerTypes.ts` | `RecallMode` / `ReviewModeSetting` / `REVIEW_MODE_LABELS`；`ReaderSettings.reviewMode`（默认 smart）+ merge 校验 |
| `src/reader/ReaderApp.tsx` | 接线：`sourceSentence`（原句含译文）、`speakRecallSentence`（word 音轨 0.92×）、`patchReviewMode`（只写全局默认，不入文章覆盖） |
| `src/reader/SettingsDrawer.tsx` | 「复习」组：复习模式分段控件 |
| `src/reader/reader.css` | 产出式复习整节样式（模式控件/完形输入/提示/四色反馈条/diff 三色/听写条/建议档描边/摘要），令牌随四主题 |
| `review-preview.html` + `src/reader/reviewPreview.main.tsx` | 仅开发预览（不进生产构建）：真实组件 + mock 数据，浏览器人工验收与截图用 |

### 5.2 验证

- `npm run test`：**276 passed / 3 skipped（e2e 按既有约定跳过），0 failed**（新增 27 个用例）
- `npm run build`（tsc + vite）：通过
- 浏览器视觉验收（真实组件渲染，Playwright + Chrome headless，8 个状态截图）：judge 两轮验收，**二轮 4/4 通过**；第一轮发现的 diff 空格丢失、深色反馈条对比度两个缺陷已修复
- 截图存档：`prototypes/shots/recall-impl/`

### 5.3 与 brief §3.5 验收清单对照

- [x] 词块卡默认走完形，挖空定位与正文下划线同源（`findChunkRange` 三档回退）
- [x] trap 形式（take roots / big rain 等）命中红色陷阱反馈（单测 + 截图验证）
- [x] 判分只做「建议档」描边，1–4 可改选；SRS 演进 `gradeSrs` 未动
- [x] 听写重播限 3 次、计数可见、判分后不限次（复盘）；word 音轨与句子朗读互不打断
- [x] 测试全绿；`readerSrs` / `readerTypes` 仅有向后兼容的可选新增
- [x] 四主题下完形输入槽、diff 三色、反馈条四色对比度达标（截图验收）

### 5.4 实现期决定（对 §3 的偏离与补充）

1. **完形卡不显示词条词头**（原型里有）：词头即答案，显示等于剧透；识别/听写卡保留词头。
2. **听写卡不再要求词块在句中可定位**：听写只需要整句朗读，定位要求只留给完形；定位失败降级识别卡。SSR 冒烟测试抓到过这个过严的降级。
3. **归一化剥离撇号**（city's→citys，dont==don't）：测试驱动发现所有格/缩写拆词会造成听写误判。
4. **复习模式只写全局默认、不写文章覆盖**：复习不随文章变化，避免覆盖污染合并结果。
5. **§3.2 的「判分明细落盘」未做**：需要动 Rust 侧 ReviewLogFile 契约，本轮刻意不碰（与「数据模型零 schema 变更」的目标冲突）；结果摘要是会话内状态，刷新即清。直译陷阱纠正率的长期指标留待契约 v2 一并考虑。
6. **判分音轨语速定 0.92×**：听写场景略慢于常速更可用；后续如需要可挂到设置。
