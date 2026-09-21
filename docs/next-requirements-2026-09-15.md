# 下一轮需求规划 · 基于用户反馈 2026-09-15

> 输入：`docs/user-feedback-2026-09-15.md`（用户「鲜鲜鱼」的实测反馈）
> 产出：4 个开发需求（R1–R4）+ 1 个战略取舍 + 可直接投喂 AI 的需求 prompt（模板 + 需求卡）
> 代码现状已核实（2026-09-15），需求卡里的「现状锚点」均为真实文件路径。

---

## 0. 总览与顺序

| 顺序 | 需求 | 解决的反馈 | 规模感 | 理由 |
|------|------|-----------|--------|------|
| R1 | 阅读室导入 Word(.docx)/PDF 文件 | #1 导入麻烦（P0） | 2-3 天 | 唯一「现在就挡着用户」的问题，最优先 |
| R2 | 生词本 → 学词笔记（一键生成 Markdown 复习笔记） | #4 自建 GPT 笔记 + #6 生词本没人用 | 2-3 天 | 用户已自建 workaround，需求被验证；LLM 通道现成，成本最低感知最强 |
| R3 | 口语陪练 MVP（情景对话） | #2 最强诉求（「111我想要这个」） | ~1 周 | 反馈里意愿最强的功能；依赖讯飞 ASR 新模块 |
| R4 | 录音直译（实时转写 + 双语翻译） | #3 录音直译 | 2-3 天 | 复用 R3 的 ASR 模块，放后面顺路 |

**战略取舍（非开发需求）**：截图翻译**不加资源**。用户已明确「这个功能不突出，很多软件有类似的功能」（有道/豆包/系统 AI 均有），单点翻译功能打不赢大厂全家桶；差异化押注 R1–R4 构成的「读 → 学 → 练 → 复习」闭环。

---

## 1. 需求卡

### R1（P0）阅读室导入 Word / PDF 文件

**解决的反馈**：「现在word和pd比较多，粘贴文字有点麻烦」

**现状锚点**（开工前先读）：
- `src/reader/ImportDialog.tsx` — 导入弹窗三个 tab（内置文库/网页链接/粘贴文本），目前仅支持 `.txt`（`accept=".txt,text/plain"`，前端 FileReader，上限 `MAX_FILE_BYTES = 4MB`）
- `src/core/readerTypes.ts` — `ArticleSourceType = "paste" | "url" | "epub" | "pdf"`，注释标明 pdf 仅预留；**该文件头部注明：类型改动必须同步 `contracts/reading-room.schema.json` 与 `src-tauri/src/reader_store.rs`（camelCase 序列化）**
- `src/core/sentenceSplit.ts` 的 `splitParagraphs` — 提取出的正文走现有切段→导入流程即可

**范围**：
1. 导入弹窗支持选 `.docx` / `.pdf` / `.txt` 三种文件（文件选择 + 拖拽均可）。
2. docx：前端用 `mammoth`（browser build）抽取正文段落；pdf：用 `pdfjs-dist` 抽文本层，**扫描件/无文本层时给出明确报错并引导走粘贴/OCR**，不要静默产出空文章。
3. 抽取的纯文本走现有 `splitParagraphs → onImport` 流程；`sourceType` 填 `"pdf"`，docx 新增 `"docx"` 枚举值并同步 schema + Rust 结构体。
4. 超限/解析失败的错误态照 `ImportDialog` 现有失败态风格展示。

**验收标准**：
- [ ] 三种格式各用一个真实文件导入成功，能进入阅读视图，翻译/朗读/生词标注正常
- [ ] 无文本层 PDF 有明确中文报错，不产生空文章
- [ ] `pnpm test`、`pnpm build` 通过；新增解析逻辑有 vitest 单测

**不做**：排版/样式还原（只要正文）、图片型 PDF 的 OCR、epub。

---

### R2（P1）生词本 → 学词笔记：一键生成 Markdown 复习笔记

**解决的反馈**：「我用那个gpt建了一个skill…让他帮我整理成markdown，方便我复习，就相当于他给我做了一份很好的笔记」「生词本我还没用」「背单词的软件不要用🤣」
—— 用户拒绝的是「背单词」形态，接受的是「整理好的笔记」形态。把她自建的流程产品化。

**现状锚点**：
- 生词数据模型 `VocabWord`（`src/core/readerTypes.ts`）+ SRS 调度 `src/core/readerSrs.ts` + 面板 `src/reader/VocabListPanel.tsx` + 存储 `src-tauri/src/reader_store.rs`
- 阅读时标注的词块 `SentenceChunk`（搭配/短语动词/习语/句式）已在数据模型里
- LLM：`src-tauri/src/translation.rs` 的 `translate_stream`（OpenAI 兼容流式，含 `cancel_translation` 取消模式），可复用或参照新增非流式 command

**范围**：
1. `VocabListPanel` 新增「生成复习笔记」：选中若干生词（默认全选未掌握，即 `intervalDays < 7`）→ 连同各自例句/词块交给 LLM，整理成结构化 Markdown 笔记（按 词 / 音标 / 释义 / 例句 / 常见搭配 / 易混语法 分节）。
2. 生成过程流式上屏、可取消；完成后可预览（Markdown 渲染）、一键复制、导出 `.md` 文件。
3. 入口文案与空态从「背单词」话术调整为「复习笔记」话术（只改文案与入口，不动 SRS 数据与调度）。

**验收标准**：
- [ ] 选 10 个生词生成笔记，全程流式可取消，可复制/导出 `.md`
- [ ] 导出的 Markdown 用任意编辑器打开结构清晰、无幻觉词（只整理生词本里真实存在的词）
- [ ] 空生词本有引导空态；`pnpm test`、`pnpm build` 通过

**不做**：SRS 调度改动、云同步、图片/富文本导出。

---

### R3（P1）口语陪练 MVP：情景对话（我说 → AI 答 → 我跟读）

**解决的反馈**：「我想要口语陪练呀」「111我想要这个」——全篇唯一被重复强调的诉求。

**现状锚点**：
- 麦克风：`src/core/micRecorder.ts`（getUserMedia → 16k PCM，权限已验证放行）
- 发音评测：`src/core/pronunciation.ts`（讯飞 ISE 流式版，HMAC 鉴权，5 分制）+ 凭据 `src/lib/iseCredentials.ts`；**讯飞应用已开通 ISE + TTS**
- LLM：`translate_stream` 可复用为对话生成器；TTS：`src-tauri/src/tts.rs`（SAPI，云 TTS 见 `docs/voice-roadmap.md` 近期规划）
- 影子跟读/评测链路：`src/reader/useShadowAssess.ts`

**范围（MVP 切法）**：
1. 新增「口语陪练」入口（阅读室侧栏或独立窗口，入口层级由实现者按现有导航判断）：选场景（点餐/面试/旅行/日常寒暄）+ 难度。
2. 对话环：按住说话 → **讯飞流式听写 ASR**（与 ISE 同族鉴权，新建 `src/core/xfyunAsr.ts`）→ LLM 以场景角色人设回复（1-3 句口语化英文 + 一行中文提示）→ TTS 播报回复 → 用户可跟读并用 ISE 打分。
3. 会话历史本地保存（沿用 `reader_store.rs` 的存储模式），支持重开上一次对话。

**验收标准**：
- [ ] 真机手动走通 5 轮对话，每轮「说完→听到回复」反馈 < 3s
- [ ] 断麦/断网/凭据缺失有明确降级提示，不白屏不卡死
- [ ] ASR/对话逻辑有单测（网络层 mock）；`pnpm test`、`pnpm build` 通过

**不做**：打断式全双工（远期，见 voice-roadmap）、数字人形象、多语言（先英语）。

---

### R4（P2）录音直译：麦克风实时转写 + 双语字幕

**解决的反馈**：「可以搞一个那种录音直译😍😍」「这个是不是很困难」（答：不难，R3 落地后顺手）

**现状锚点**：复用 R3 沉淀的 `src/core/xfyunAsr.ts` + `translate_stream`；独立窗口模式可参考 OCR overlay（`open_ocr_overlay`）的挂载方式。

**范围**：
1. 「录音翻译」模式：开始 → 实时转写上屏 → 句级翻译 → 双语滚动字幕，支持中→英 / 英→中切换。
2. 录音结束后可保存为双语对照 `.md`/`.txt`。
3. 长录音（≥10 分钟）不崩、内存稳定（分句及时释放音频缓冲）。

**验收标准**：
- [ ] 句级「说完→译文上屏」延迟 < 2s
- [ ] 10 分钟连续录音稳定；保存的文件双语对照可读
- [ ] `pnpm test`、`pnpm build` 通过

**依赖**：R3 的 `xfyunAsr.ts` 先落（或与 R3 同期抽成公共模块）。

---

## 2. 投喂 AI 的 Prompt

### 2.1 通用模板（每次干活都用它）

```
你在 D:\workspace\immersive-translator 仓库工作（Tauri + React/TypeScript 的 Windows 应用，
主代码在 immersive-translator-windows/，测试用 vitest，UI 样式集中在 src/reader/reader.css）。
请完整实现下面这个需求。

【需求卡】
{{粘贴下方对应需求卡}}

【工作方式】
1. 先读需求卡「现状锚点」列出的文件，核实现状；若代码与卡片描述有出入，以代码为准，
   并在动手前先说明差异和你的调整方案。
2. 遵循仓库既有约定：数据契约改动必须同步 contracts/reading-room.schema.json 与
   src-tauri/src/reader_store.rs（camelCase）；注释密度与相邻代码一致；不做需求卡
   「不做」清单里的事，不顺手重构无关代码。
3. 关键逻辑（纯函数/解析/状态机）配 vitest 单测，参考 src/core/*.test.ts 现有写法。
4. 完成后自验：在 immersive-translator-windows/ 下跑 pnpm test 和 pnpm build，必须全过；
   涉及 UI/硬件链路的需求，用 pnpm tauri dev 真机把每条验收标准走一遍。
5. 最终回报：改动文件清单、每条验收标准的逐条通过情况（附证据）、已知遗留问题。
```

### 2.2 用法

模板 `【需求卡】` 处依次粘贴上文的 R1–R4 需求卡，一个 prompt 干一个需求，按 R1 → R2 → R3 → R4 顺序投放；R4 必须等 R3 的 ASR 模块落地。每个需求完成后，把 AI 回报的「验收标准通过情况」对照需求卡勾选核对，再投下一个。

---

## 3. 反馈 → 需求覆盖对照

| 用户反馈 | 承接需求 |
|----------|----------|
| #1 Word/PDF 导入麻烦 | R1 |
| #2 口语陪练（最强诉求） | R3 |
| #3 录音直译 | R4 |
| #4 GPT 整理 Markdown 笔记 | R2 |
| #5 截图翻译不突出 | 战略取舍：不加资源，靠 R1–R4 闭环建立差异 |
| #6 生词本没人用/排斥背单词 | R2（重定位为复习笔记） |
