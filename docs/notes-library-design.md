# 笔记库设计 · 复习笔记留存 + 应用内查看 + AI 复盘闭环（2026-09-16 v3）

> **实施状态（2026-09-17 更新）**：已按本设计实现并通过 `tsc` / `vitest`（398 用例）/
> `cargo test` / `vite build`。落点：
> - Rust：`reader_store.rs` 新增 `RecallStat` 错题记录、`reader_record_recall`、
>   `note_save/note_list/note_read/note_write_replay/note_delete`（notes/ 目录、
>   JSON frontmatter、同名去重永不覆盖）
> - 契约：`contracts/reading-room.schema.json` 增加 `recallStat/noteMeta/noteReplay`
> - 生成：`noteBuilder.ts`（诊断式 prompt、【记不住】【记法】【测】标记、`recallBucket`
>   归桶、复盘 prompt/解析/校验）、`noteParser.ts`（frontmatter + 受限 markdown 解析）
> - UI：`NotesView.tsx`（笔记库视图 + 朱批视觉 + AI 复盘区）、`VocabNoteDialog`
>   自动入库 +「在笔记库打开」、书架「📒 笔记库」入口
> - 样式：`reader.css`「笔记库（R3）」段（纸/朱红/楷体/印章，四主题）
>
> **串联补强（2026-09-17，四房闭环打通）**：
> - 复习完成面板（SummaryPanel）新增「把这轮错题整理成笔记 / 去笔记库看复盘」出口；
>   空队列态补「回阅读室 / 去笔记库」——复习的黄金时刻不再断流
> - 笔记复盘区「开始复习 / 只测仍错的词」→ 加练队列（`focusIds`）：只排该笔记
>   仍错词（实时口径：没测过 或 错+陷阱>过），无视到期时间；生词本左栏出现
>   加练横幅 + 退出；判分即出队，与到期队列同语义
> - 导航对称：生词本左栏补「口语陪练 / 笔记库」入口，笔记库左栏补「生词本复习」
>   （带到期角标）；口语入口页加「‹ 返回书架」；顶栏应用名返回位常驻 ‹ 标记
> - 「仍错」实时化：笔记列表 N 词仍错 / 已全过 ✓、复排判定签「已过 ✓」翻绿，
>   随最新错题记录自动翻新，不再只增不减
> - 提醒与一致性：书架笔记库入口 + 生成按钮显示「N 词未整理」角标
>   （未出现在任何笔记 wordIds 的生词数）；今日进度环抽成 `TodayCard`
>   三视图共用；书架导航图标统一为线性图标（新增 IconMic / IconNotebook）
> - 口语陪练与生词/笔记的数据联动仍为独立模块（见 user-feedback 审计第 5 条）

原型：`prototypes/vocab-notes-library.html`（自包含单文件，双击即开；右上角圆点切换日间/护眼/暗色）。

## 视觉语言（v3「朱批」，用户反馈原型太丑后重构）

概念：**一页被先生批过的阅读笔记**。双墨系统——靛蓝管版式（页边线、引文线、链接），朱红只管批语（为什么忘、速览重点、复盘按语），绿只表示"通过"。三色之外无色。

- **纸张分层**：外壳（顶栏/左栏/弹窗）保持应用工作台原样；正文是一页暖白纸（`--paper`）放在桌上，带阴影与页边线。实现只需给 sheet 换底色 + 阴影，不影响应用其他页面。
- **楷体批语**：诊断、速览、复盘按语用 `--font-kai: KaiTi/楷体`（Windows 全量自带，应用目标平台即 Windows），颜色 `--cinnabar`（day #bf4a35 / sepia #a53c2c / dark #e8927f）。
- **去盒子化**：词条不再包白卡，是纸面条目（发丝线分隔）；批语无背景框；复习量表 = 批改记号 `✗✗✓`（楷体，红/绿）+ 文字注（"4 次里忘 3"）；关键词用 wavy 下划线（`text-decoration: underline wavy`）模拟红笔划线。
- **印章动效**：复盘按语旁一枚「阅」章（朱红描边楷体、rotate -5deg），载入时 stamp 动画（scale 1.8→1 + 回弹），`prefers-reduced-motion` 时静止显示。全页唯一动效。
- 三主题已验证（日间/护眼/暗色）。

v2 要点（对应用户反馈「笔记太像词典、看两三个就放弃、要回答为什么记住/为什么忘、要 AI 复盘闭环」）：
**笔记从「词典复读」变成「记忆诊断报告」**。每张卡先回答"你为什么记不住"（基于真实错题数据），
页面底部是「AI 复盘」闭环区：生成 → 间隔复习 → 再测 → 更新薄弱点 → 滚动进下一篇。

## 问题（v1 结论 + v2 新增）

1. 生成后不留存、用户不会打开 .md（v1 已解决：自动入库 + 应用内查看）。
2. **内容是词典复读**：音标+释义+例句的罗列没有复习价值，重点埋在中间扫不出来。
3. **没有闭环**：笔记是一次性文档，与后续复习、错题完全脱节。

## 数据基础（应用内已存在，不是设想）

- `VocabSrsState`：`reps / lapses / intervalDays / dueAt`（`readerTypes.ts:148`）
- `RecallResult`：`{ wordId, mode: recognition|cloze|dictation, judged, grade }`（`ReviewView.tsx:246`；
  `judged=trap` = 踩了直译陷阱）——**目前只在会话内（SummaryPanel），需要落盘**
- `VocabWord`：`trap / pattern / collocations / source`（出处文章+句子）、`example`
- 复习日志 `reader_vocab.json` 的 `ReviewLogFile`（按日打卡）

## 笔记卡：从词典卡 → 记忆诊断卡

每张卡固定回答四个问题，顺序即优先级：

| 区块 | 内容 | 数据来源 |
| --- | --- | --- |
| 词头 + 音标 + 词性 + **复习量表** | 红/绿小条：每格一次复习（红=没想起/踩陷阱） | RecallResult 历史 |
| **为什么记不住 / 为什么这次记住了**（红/绿诊断块，放最前） | 判断类型：「认识但搭配调不出」「眼熟假熟（只识别未产出）」「同一陷阱反复踩」；给出针对性记法 | lapses + 按 mode 的错题分布 + judged=trap 计数 |
| 释义（压缩） | 只保留核心义项 | senses |
| **怎么锚住**（琥珀批注条） | 出处锚点/整块记法/介词考点 | source 例句 + pattern + trap |
| 例句（靛蓝引文块） | 原句 + 出处文章/收藏日期 | source.articleId + sentenceIdx |
| 搭配（压缩为"必记/类推"两档） | 考点导向，不是罗列 | collocations |
| **下次怎么测**（虚线条 + 去测按钮） | 建议测试模式与考法（如"完形·考介词"），可跳转测试卡 | 诊断结论推导 |

「先看这里」（v1 的本篇速览升级）：不再罗列词条，而是给**结论**——"这批词的通病是搭配调不出""sourcing from 踩过 2 次陷阱是本篇最可能再错的词"。

「为什么这次记住了」同样重要：通过诊断的卡用绿色块告诉用户"保持节奏即可"，并标注毕业条件（intervalDays ≥ 7）。

## AI 复盘区（页面底部闭环）

闭环链路（页面上可视化，逐步点亮）：

> 阅读发现 → 自动记录 → AI 诊断 → 复习笔记 → 间隔复习 → 再测 → 更新薄弱点 ♻

两种状态：

1. **等待首轮复习**（生成后还没复习过）：链路亮到"间隔复习"，CTA「开始复习」。
2. **已复盘**（有复习记录后，AI 生成复盘段）：
   - 总结论："6 词复习 1 轮后 4 个进入 3 天以上间隔；2 个仍在错——你的薄弱点不是不认识，是认识但搭配调不出"
   - 薄弱点行：词 + 为什么仍错（更新后的诊断） + 判定 chip（完形连错 / 踩陷阱）
   - 行动：「只测仍错的词」「把这 2 词滚进新笔记」（仍错词自动进入下一篇笔记的默认选词）

左栏条目同步显示「· N 词仍错」，让用户不打开也知道哪篇还有债。

复盘生成时机：一轮复习结束（SummaryPanel 出现）时提示「复盘已更新」，或用户打开笔记时懒生成。

## 生成端变化（noteBuilder.ts）

1. 材料新增（无损传给 LLM，规则仍是"没有就不写，不得编造"）：
   - 每词的错题统计：`{ reps, lapses, byMode: { cloze: {n, wrong, trap}, ... }, intervalDays }`
   - （judged=trap 区分"没想起"和"踩陷阱"，两种失败对应不同诊断）
2. System prompt 重写：
   - 「先看这里」：挑 ≤3 条**关于用户的结论**（不是关于词的科普）
   - 每词先写诊断（为什么记不住/为什么记住了），再写锚点，释义压缩
   - 结尾「下次怎么测」：每词一行测试建议
3. 防幻觉扩展：诊断里的错题数字必须与材料一致（数字校验比词条校验更严格）。

## 存储与实现清单

Rust（`src-tauri/`）：
- `reader_store.rs`：`reader_vocab.json` 增加 `recallLog`（per-word 按模式的答题记录，
  精简为计数：`{ mode, pass, wrong, trap, lastAt }`）；ReviewView 的 results 目前会话内即弃，需在
  `onGrade` 时累计落盘（或每轮 Summary 时批量写）。
- 新增 `note_store.rs`：`note_list / note_read / note_save / note_delete`，目录 `app_data_dir/notes/`。
- 复盘数据：笔记 md 前后加 frontmatter（生成时间、覆盖词条 id、复盘状态与结果），或同目录
  `.meta.json`——**推荐 frontmatter**（单文件自包含，导出后仍是合法 md）。

前端：
- `NotesView.tsx`：左栏 + 渲染页（含 AI 复盘区组件）。
- `noteParser.ts`：受限 markdown 解析（标题/列表/引用/加粗 + frontmatter），不引第三方。
- `ReviewView.tsx`：`onGrade` / Summary 时把 RecallResult 累计写入 store。
- `VocabNoteDialog.tsx`：完成即 `note_save`；主按钮「在笔记库打开」。
- 复盘文案生成：复用 requestTranslate 通道，输入 = 笔记词条 + 最新错题统计，输出 = 复盘段
  （存进 frontmatter 或独立 section）。

主题：全部走既有 `data-theme` 令牌（诊断块用 --err-soft/--ok-soft，已验证三主题）。

## 里程碑拆分（每步可独立交付）

1. **M1 留存与查看**：note_store + NotesView（v1 范围，词典式渲染即可用）
2. **M2 错题落盘**：recallLog 进 reader_vocab.json，ReviewView 累计
3. **M3 诊断笔记**：noteBuilder 材料与 prompt 升级 + 诊断卡渲染
4. **M4 AI 复盘**：复盘生成 + 闭环区 + 「滚进新笔记」
