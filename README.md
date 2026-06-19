# ImmersiveTranslator

ImmersiveTranslator 是一个 macOS 原生菜单栏翻译工具。它想解决的不是“再做一个网页翻译入口”，而是让 Mac 上的选中文本翻译、截图 OCR 翻译和沉浸式阅读浮窗更顺手。

项目目前处在 MVP 阶段：核心链路已经可用，但交互、OCR 体验和正式分发还在持续打磨。

## 当前能力

- 菜单栏 App：启动后菜单栏显示 `译`。
- 选中文本翻译：默认快捷键 `Option + Space`。
- 截图 OCR 翻译：默认快捷键 `Control + Option + Space`，框选屏幕区域后使用 Apple Vision 本机 OCR，并在翻译前提供轻量文本确认、空结果手动输入/粘贴、OCR 设置恢复入口和识别质量提示；补入文本后会自动回到确认状态。
- 沉浸式翻译浮窗：支持复制、重新翻译、取消当前请求、固定、自动隐藏、收藏、查看历史、OCR 原文确认和耗时展示；错误/系统提示会和真实译文区分操作，避免误收藏或自动消失，并可直接复制提示、按错误类型打开 App 设置或直达系统权限设置排查。
- 流式翻译：接口支持时可以边生成边显示译文；慢请求会区分“正在连接服务商”“已连接等待首个可见文字”和“已连接等待完整译文”，持续刷新连接前、连接后和总计等待耗时，并显示连接耗时、首字耗时和偏慢原因提示；服务商先返回角色事件、空白片段或代理缓冲时不会把空白当成译文展示；流式刷新不会把浮窗重新挪到鼠标旁，请求变慢或误触发时可点击“取消”或按 `Esc`，已经出现的片段会保留下来方便复制。
- 中英互译：中文自动翻成英文，非中文自动翻成简体中文。
- 固定目标语言：也可以指定始终翻译成某一种语言。
- 历史与收藏：本地保存，支持按原文、译文、来源、目标语言、日期/时间和收藏状态搜索，自动选中当前结果，一键复制译文/原文、复制 Markdown 片段、删除与撤销刚删除的单条记录，将选中记录、当前列表、全部历史或收藏导出为 CSV/JSON/Markdown/纯文本，并可在导出后定位文件或复制路径；清空非收藏历史前会二次确认。
- OCR 设置：支持准确/快速模式，以及混合、中英、英文、日文、韩文识别语言预设。
- 快捷键自定义：可以在设置里真实录制快捷键，并提示重复、系统保留组合、注册失败冲突和更稳妥的替代组合。
- API Key 安全存储：API Key 保存在 macOS Keychain。
- Provider 预设：设置里提供 OpenAI、DeepSeek、智谱 GLM、Gemini、OpenRouter、SiliconFlow、阿里云百炼、Groq、xAI、Kimi、本地 Ollama、本地 LM Studio 和本地 vLLM 常用预设、模型说明和延迟排查提示。
- 术语表与固定风格：支持维护本地术语表和自定义翻译风格，提供格式预检、未识别行示例、追加导入 UTF-8/UTF-16 的 CSV/TSV/纯文本、导出、复制完整词库、复制本次请求映射和清理去重；翻译请求只发送可识别的前 80 条有效术语映射，超出部分仅本地保留。
- OpenAI 兼容接口：支持 OpenAI Chat Completions 兼容服务，并对 DeepSeek、智谱 GLM 做了关闭思考模式的兼容处理；本地 localhost 兼容接口可以不填真实 API Key。

## 系统要求

- macOS 13.0 或更高版本
- Swift 5.9 或更高版本
- 翻译功能需要 OpenAI Chat Completions 兼容接口；云接口需要对应服务商的 API Key，本地 Ollama / LM Studio / vLLM / localhost 兼容接口可以不填真实 Key。截图 OCR 体验只需要屏幕录制权限。

## 快速开始

从源码运行：

```bash
git clone https://github.com/kobejiasuoer/immersive-translator-macos.git
cd immersive-translator-macos
swift run ImmersiveTranslator
```

打包成 macOS App：

```bash
./scripts/build_app.sh
open dist/ImmersiveTranslator.app
```

首次打包前建议先按下文“本地开发签名”创建固定的本地 Code Signing 证书，避免反复重新授权辅助功能和屏幕录制。

安装到应用程序目录：

```bash
ditto dist/ImmersiveTranslator.app /Applications/ImmersiveTranslator.app
open /Applications/ImmersiveTranslator.app
```

## 下载

可以从 GitHub Releases 下载预构建版本：

```text
https://github.com/kobejiasuoer/immersive-translator-macos/releases
```

当前 release 仍是开发构建，尚未使用 Apple Developer ID 正式签名和公证。macOS 可能会提示“无法验证开发者”，需要在“系统设置 -> 隐私与安全性”里手动允许打开。开发者更推荐从源码构建运行。

## 使用方式

启动 App 后，它会以菜单栏工具的形式运行，不会出现在 Dock 里。点击菜单栏的 `译` 可以打开设置、历史、权限检查或退出 App。

首次启动会弹出使用引导。建议先完成权限和 OCR 体验，再决定接本地模型还是云服务：

1. 在引导里授权 `辅助功能` 和 `屏幕录制`。辅助功能只用于选中文本翻译时临时发送 `Command + C`；屏幕录制只用于截取你框选的 OCR 区域。
2. 点击引导里的“试一次本机 OCR”，框选一小段屏幕文字。看到原文预览就说明截图、Vision OCR 和确认浮窗已经跑通；这一步不需要 API Key。
3. 准备翻译接口：本地 Ollama / LM Studio / vLLM / localhost 兼容接口可直接试，不需要真实 API Key；OpenAI、DeepSeek、智谱、Gemini 等云接口需要填对应服务商的 API Key，Key 会保存到 macOS Keychain。

默认快捷键：

- `Option + Space`：翻译当前选中的文本。
- `Control + Option + Space`：框选屏幕区域，先确认或修正 OCR 原文，再发送翻译。

截图 OCR 的当前流程：

1. 按下 OCR 快捷键后框选屏幕区域。
2. 进入框选遮罩后，即使还没开始拖选，也会先显示当前屏幕名称、主/副屏位置、缩放倍率、点尺寸和像素尺寸；框选时还能看像素级放大镜、选区像素尺寸、点尺寸、边缘吸附和 OCR 可读性提示。选区过小、过矮、过窄、像超长单行或区域过大时，HUD 会提醒可能只截到局部文字、半行、漏掉单词边缘或导致 OCR 变慢。靠近屏幕边缘时，对应边缘会高亮，方便确认是否已经吸附。鼠标进入哪块屏幕的遮罩，`Esc`、`Enter` 和方向键会自动作用在那块屏幕上。`Shift` 可锁定水平/垂直调整，按住 `Option` 松开鼠标可先停留在选区内继续微调。停留后可拖动边/角改大小、拖动选区内部移动位置，方向键移动选区，`Shift + 方向键` 微调右/上边缘，`Command + Shift + 方向键` 微调左/下边缘，`Option + 方向键` 大步移动或大步改尺寸；键盘微调后 HUD 会直接显示已移动方向、步长或已调整的边缘，如果已经到屏幕边缘或最小尺寸，会提示反向移动、拖动内部调整或拖边放大。`Enter` 确认截图，`R` / `Command + R` 清空重选。误点或区域太小时不会立刻退出遮罩，可以直接重新拖选。
3. App 先在本机完成 OCR，并弹出原文预览。
4. 你可以直接修正文案、复制原文、整理段落、整理并翻译、复制整理版、粘贴替换、粘贴并翻译，或重新框选；原文预览会显示当前字符/行/段统计，以及相对最初识别文本的变化摘要，并提示空结果、几乎全是符号/分隔线/OCR 噪声的结果、极短结果、超长单行、疑似截断片段、疑似硬换行自然段、目录/索引页码、列表/表格/键值结构、问答/表单字段标签、紧凑字段/状态/数值/模型名结构、多短行内容和疑似双列/多区域文本；空结果、噪声、极短结果和疑似截断片段会直接显示为橙色“需要你看一下”，提醒先补全、重新框选，或打开 OCR 设置调整识别语言/模式。多列/多区域和多短行提示会直接说明该先整理段落、保留换行，还是重新框选单列。整理段落会尽量保留 Markdown 标题、引用、代码/HTML/JSON 片段、目录点线/页码、罗马数字/中文序号、括号序号、圈号序号列表边界、问答/表单标签与内容换行、紧凑字段值、独立小标题结构，以及短标题/按钮标签夹着长提示的跨区块内容；同一条列表项内部的自然续行会合并，短标题接长正文时会整理成段落空行，普通自然段和答案正文硬换行则尽量合并，URL、邮箱、文件路径和模型名等技术 token 跨行时会尽量无空格拼回，明显的 `state-of-the-` / `art`、`non-` / `blocking` 这类英文复合词断行会保留连字符。原文预览支持 `Enter` / `Command + Enter` 确认、`Shift + Enter` 换行、`Command + Shift + Enter` 先整理段落再翻译、`Command + Option + Enter` 用剪贴板文本替换并立即翻译、`Command + J` 整理段落、`Command + Option + J` 复制整理版、`Command + Option + V` 用剪贴板文本替换整段原文、`Command + ,` 打开 OCR 设置、`Esc` / `Command + R` 重新框选、`Command + Shift + C` 复制整段原文。
5. 点击“确认翻译”后，才会检查翻译接口配置并发送文本。如果当前云接口还没填 API Key，预览会保留原文并打开设置；你可以填 Key，也可以切到本地预设继续试。

常用设置：

- `翻译方向`：选择 `中英互译` 或 `固定目标语言`。
- `流式显示译文`：开启后接口支持时会边生成边展示；浮窗会拆分显示连接、连接后等待、首个可见文字和完整翻译耗时，并在慢请求时持续刷新总计等待秒数，方便判断慢在网络入口、模型排队、代理缓冲还是非流式完整返回；如果服务商先返回空白 delta 或角色事件，浮窗会继续显示“等待首个可见文字”，不把空白内容当译文。同一请求内的状态刷新不会重新挪动浮窗。等待中可以点击“取消”或按 `Esc` 停止当前请求。如果已经有流式片段，会保留已生成译文方便复制；如果还没有片段，会保留原文，可点“重新翻译”或按 `Command + R` 直接重试。
- `术语表与固定风格`：填写固定翻译风格和专有名词映射；固定风格可追加自然口语、技术文档、产品 UI、忠实原文等模板，也可复制或清空；术语表支持格式预检、未识别行示例、追加导入 UTF-8/UTF-16 的 CSV/TSV/纯文本、纯文本导出、复制完整词库、复制本次请求会发送的映射和清理去重。术语行支持 `原词 = 译法`、`原词 -> 译法`、`原词：译法`、CSV/TSV 前两列、逗号/中文逗号或竖线两列格式，可自动忽略表头和 `#` / `//` 备注；从表格导入时只取前两列作为原词和译法，后续备注列不会进入请求或清理后的词库。无法识别的行会显示最多 3 条可修正示例，并且清理去重前会在确认弹窗里再次提示。导出时会按纯文本格式修正文件扩展名。长术语表会明确提示去重后有效映射数、请求实际发送数，以及超出上限后仅本地保留的条数。
- `OCR 识别模式`：准确模式更稳，快速模式更快；日文、中文和韩文会自动回退到准确模式识别。
- `OCR 识别语言`：语言越少通常越快、误识别越少；日文截图建议选 `日文` 或 `混合`。
- `快捷键`：点击录制后按下新的组合键；设置页会标出默认/自定义状态，可一键恢复默认。如果和另一功能重复、注册失败、只按了不适合的单键，或接近 Spotlight/输入法、Mission Control、桌面空间切换、截图、App 切换、复制粘贴撤销、关闭退出隐藏、设置/取消/帮助、保存搜索、地址栏/定位栏、刷新打印、新建标签页、书签、前进后退、链接、文字格式和缩放等 macOS / App 常见快捷键，会给出具体原因和替代组合建议；替代建议会避开另一功能已经占用的组合，并优先给出更不容易撞系统/输入法的 `Control + Option + 字母`。录制成功表示组合已保存；如果 macOS 全局注册失败，设置页和浮窗会明确提示“已录制但未注册成全局热键”。

翻译浮窗常用快捷键：`Command + Shift + C` 复制译文/错误提示，`Command + Option + C` 复制原文，`Command + Option + Shift + C` 复制原文和译文组合文本，`Command + Option + S` 收藏/取消收藏，`Command + R` 重新翻译，`Esc` 取消当前请求或关闭浮窗。

历史窗口常用快捷键：`Command + F` 搜索，`Command + ↑` / `Command + ↓` 切换可见记录，`Command + R` 用当前设置重新翻译选中原文，`Command + Shift + C` 复制选中译文，`Command + Option + C` 复制选中原文，`Command + Option + Shift + C` 复制原文和译文组合文本，`Command + Option + M` 复制 Markdown 片段，`Command + Option + S` 收藏/取消收藏，`Command + Option + E` 快速导出选中记录 CSV，`Delete` 删除选中记录，`Command + Z` 撤销刚删除的单条记录。搜索框支持原文、译文、来源、目标语言、日期、时间、`OCR`、`收藏` 和 `未收藏`。右键任意历史记录可重新翻译原文、复制原文/译文/组合文本、复制 Markdown 片段、收藏、删除，或把当前单条记录导出为 CSV、JSON、Markdown 或纯文本；导出菜单也可按范围选择格式，保存时会按当前选择的格式修正文件扩展名。不想落盘时，可在导出菜单或单条记录右键菜单里用“复制为”把选中记录、当前列表、全部历史或收藏按 CSV/JSON/Markdown/纯文本直接复制到剪贴板。

## 接口配置

默认接口：

```text
https://api.openai.com/v1/chat/completions
```

默认模型：

```text
gpt-5.4-mini
```

新用户可以按阻力最小的方式选择接口：

- 本地接口可直接试：先启动 Ollama、LM Studio、vLLM 或其它 localhost OpenAI 兼容服务，在设置里选择本地预设并点击“测试当前接口”；不需要真实 API Key。
- 云接口需要 API Key：选择 OpenAI、DeepSeek、智谱、Gemini、OpenRouter 等云服务预设后，需要填入对应服务商的 Key，才能验证真实翻译请求。

设置窗口内置了常用 Provider 预设卡片：

- `OpenAI · GPT-5.4 Mini`：`https://api.openai.com/v1/chat/completions` + `gpt-5.4-mini`
- `DeepSeek V4 Flash`：`https://api.deepseek.com/chat/completions` + `deepseek-v4-flash`
- `DeepSeek V4 Pro`：`https://api.deepseek.com/chat/completions` + `deepseek-v4-pro`
- `智谱 · GLM-4 Flash`：`https://open.bigmodel.cn/api/paas/v4/chat/completions` + `glm-4-flash-250414`
- `智谱 · GLM-5.2`：`https://open.bigmodel.cn/api/paas/v4/chat/completions` + `glm-5.2`
- `Google · Gemini 2.5 Flash`：`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` + `gemini-2.5-flash`
- `OpenRouter · Auto Router`：`https://openrouter.ai/api/v1/chat/completions` + `openrouter/auto`
- `SiliconFlow · GLM-4.7`：`https://api.siliconflow.cn/v1/chat/completions` + `Pro/zai-org/GLM-4.7`
- `阿里云百炼 · Qwen Plus`：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` + `qwen-plus`
- `Groq · Llama 3.3 70B`：`https://api.groq.com/openai/v1/chat/completions` + `llama-3.3-70b-versatile`
- `xAI · Grok 4.3`：`https://api.x.ai/v1/chat/completions` + `grok-4.3`
- `Moonshot · Kimi K2`：`https://api.moonshot.cn/v1/chat/completions` + `kimi-k2`
- `本地 · Ollama Llama 3.2`：`http://localhost:11434/v1/chat/completions` + `llama3.2`
- `本地 · LM Studio`：`http://localhost:1234/v1/chat/completions` + `model-identifier`，使用前请在 LM Studio 里启动本地 Server，并把模型名替换为已加载模型的 identifier。
- `本地 · vLLM`：`http://localhost:8000/v1/chat/completions` + `served-model-name`，使用前请运行 `vllm serve <模型名>`，并把模型名替换为 `/v1/models` 返回的模型 ID。

设置页会显示实际请求地址，并提前提示 API Key 缺失、模型为空、非 HTTPS、接口地址 query 里疑似混入 `api_key` / `token` / `secret` 等凭证这类常见配置问题；点击任一 Provider 预设后，会立即显示已套用的模型、实际请求地址，以及下一步该先补 API Key、测试网络入口，还是验证真实翻译请求。本地 `localhost` / `127.0.0.1` / `::1` 兼容接口允许不填真实 API Key。也可以使用“测试当前接口”：只检查接口连通性和首个响应耗时，不发送 API Key、原文或翻译请求正文；如果 2xx 响应正文已经是错误 JSON、HTML/登录页、非 JSON 文本或非 UTF-8 内容，也会提示先检查接口地址、代理/网关或兼容路径。若要检查 API Key、模型名、余额/限流和账号权限，可以使用“验证翻译请求”，它会发送一段很短的测试文本并显示分类后的错误提示。错误提示会结合 HTTP 状态码、服务商原始提示、200 OK 下的错误 JSON 和响应预览，进一步区分 API Key、缺少 Authorization/Bearer 鉴权头、模型名、接口地址、余额/额度、限流、权限、区域限制、内容安全/合规策略、文本过长、未知参数、流式兼容、Gemini、OpenRouter、SiliconFlow、阿里云百炼、Groq、xAI、Kimi、Ollama、本地接口未启动、`Cannot POST` / `404 Not Found` 路径错误、HTML/网关页、登录页和非 JSON/非 UTF-8 响应等常见情况。诊断运行中可以取消；结果下方会给出“建议下一步”，例如继续验证真实请求、检查模型名/API Key/额度、区分连接偏慢/短翻译偏慢，或切换低延迟预设；接口地址、模型、API Key、目标语言、流式设置、固定风格或术语表改动后也会提示重新验证。Provider 诊断报告会带上 App 版本、macOS 版本、诊断类型、完成时间、耗时、延迟判断、HTTP 状态、实际请求地址、模型、固定风格是否配置、术语表有效/发送/忽略/重复数量、配置指纹、建议下一步和诊断日志路径，也可以直接复制或在 Finder 中显示日志。还可以复制一条不包含真实 API Key 的安全 `curl` 命令，用 `${API_KEY}` 占位复现 Chat Completions 请求，方便在终端或服务商支持工单里排查；“复制支持包”会把诊断报告、配置提示和脱敏 curl 一次性打包。报告只记录 API Key 是否已配置或本地接口是否不需要 Key，不记录 Key 本身，也不复制固定风格正文或术语表内容；如果接口地址 query 中包含 `api_key`、`token`、`secret` 等疑似凭证，也会替换为 `REDACTED`。

翻译失败时，浮窗会区分可重试和需要先修配置/文本的错误：网络超时、服务商 5xx、限流等会保留“重新翻译”；API Key、模型名、接口地址、余额/权限、内容安全策略、文本/上下文/请求体超限、HTTPS 证书或响应格式这类问题会优先提示检查对应设置或调整文本，避免无效重试。内容安全/合规策略拦截会提示缩小 OCR/选中文本范围、删除敏感片段或分段翻译；上下文、Token 或请求体大小超限会提示缩小 OCR/选中文本范围、按自然段分批翻译或换用更长上下文模型。本地接口未启动、本地模型响应超时、离线、网络中断、ATS/HTTPS、代理证书、系统网络策略和客户端证书错误会显示更具体的短状态和检查按钮。点击错误浮窗里的检查按钮会打开设置页，并自动发起 Provider 诊断：能验证真实请求时会检查 Key/模型/额度/权限，不能验证时会先做接口连通性测试。

如果你使用的是其它 OpenAI Chat Completions 兼容服务，只要填入对应接口地址、模型名和 API Key 即可；本地兼容服务可以留空 Key 或按服务要求填占位值。

## 隐私说明

- API Key 只写入 macOS Keychain，不写入仓库、日志或历史文件。
- 选中文本翻译会临时触发 `Command + C`，读取后恢复原剪贴板。
- OCR 使用本机 Apple Vision；截图不会发送给翻译服务。
- 翻译请求会发送待翻译文本、目标语言、模型配置、自定义风格，以及术语表中可识别的前 80 条有效映射；术语表坏行、空行、`#` / `//` 注释和 CSV/TSV 额外备注列不会发送，超出上限的有效映射只保存在本机。
- 翻译历史保存在本机 Application Support 目录；导出历史/收藏/当前列表/单条记录时，默认文件名会带记录数量或内容摘要，并过滤不适合作为文件名的分隔符。
- 诊断日志不记录 API Key；接口 URL query 里的疑似凭证也会先脱敏，并且设置页会提示尽量把这类凭证移到 API Key 字段。

本地数据路径：

```text
~/Library/Application Support/ImmersiveTranslator/
```

诊断日志路径：

```text
~/Library/Application Support/ImmersiveTranslator/diagnostic.log
```

## 已知限制

- 选中文本翻译依赖模拟 `Command + C`，因此需要辅助功能权限；未授权时会直接提示并打开辅助功能设置，某些 App 的自定义文本区域仍可能无法稳定读取。
- 截图 OCR 依赖 Apple Vision，识别质量会受字号、清晰度、背景干扰和语言设置影响。
- OCR 已有轻量识别确认、空结果手动输入、符号/分隔线/OCR 噪声提示、极短/疑似截断结果警告状态、粘贴并翻译、识别质量提示、当前文本统计、相对最初识别文本的变化摘要、段落合并、问答/表单标签换行保护、答案正文硬换行合并、英文复合词断行连字符保留、短标题段落空行、短标题/按钮标签夹长提示时保守保留区块、复制整理版、整理反馈、恢复最初识别文本、目录/索引页码、键值/表格/复选框/Markdown 标题/引用、紧凑字段/状态/数值/模型名换行保护、代码/HTML/JSON 片段、罗马数字、中文序号、括号序号与圈号序号列表换行保护、疑似双列/多区域保守整理、明显左右锚点跳变断段、像素级放大镜、显示器/缩放倍率/点尺寸/像素尺寸提示、选区偏小/过窄/过矮/超长单行/过大选区提示、Option 松手微调、拖边/角改大小、拖内部移动选区、方向键移动、键盘微调受阻提示、误点/小选区留在遮罩内重选和边缘吸附高亮；复杂跨栏识别和更精细的框选辅助仍在打磨。
- 快捷键录制依赖 macOS 全局热键注册；少数系统保留组合或输入法占用组合无法注册。
- 当前 release 未正式签名和公证，分发体验还不够好。
- 已有基于 `update-manifest.json` 的启动后每日低打扰检查、菜单手动检查更新，以及下载到 Downloads 后自动校验文件大小、sha256、解包检查 zip 内 App 的 Bundle ID/版本/构建号/可执行文件/代码签名结构；校验通过后可重新校验已保存 zip、解压到系统临时目录，并在用户确认后退出当前版本、后台替换当前 `.app`、复制后再次核对 App 元数据和代码签名。暂未内置特权 helper 或管理员授权提权；如果当前 App 所在目录不可写，会保留已校验的新版本并降级到 Finder 手动安装。

## 待开发路线

优先级最高的是把日常使用体验从“能用”推进到“顺手”：

- OCR 确认增强：继续优化多屏幕细节和识别文本预览。
- OCR 段落优化：继续减少复杂排版下的跨栏/跨区域误合并，并打磨表格/键值内容的换行保留。
- OCR 交互优化：继续优化多屏幕细节、选区二次调整和更细腻的边缘定位反馈。
- 快捷键自定义：继续优化更多系统保留组合的解释和推荐替代组合。
- Provider 预设：补充更多服务商预设和可用性诊断。
- 正式分发：继续完善 Developer ID 实际签名/公证验证、发布托管、管理员授权提权和更完整的更新失败回滚体验。

## 项目结构

- `Sources/ImmersiveTranslator/App.swift`：应用入口、菜单栏、热键动作、设置/历史/引导串联。
- `Sources/ImmersiveTranslator/HotKeyManager.swift`：使用 Carbon 注册全局快捷键。
- `Sources/ImmersiveTranslator/ClipboardReader.swift`：读取当前选中文本并恢复剪贴板。
- `Sources/ImmersiveTranslator/ScreenSelection.swift`：跨屏幕截图 OCR 框选遮罩和 Retina 坐标截图。
- `Sources/ImmersiveTranslator/OCRReader.swift`：使用 Apple Vision 做本机 OCR，并合并多行/多段识别结果。
- `Sources/ImmersiveTranslator/TranslationClient.swift`：调用 OpenAI Chat Completions 兼容接口，并处理流式输出与部分 provider 兼容项。
- `Sources/ImmersiveTranslator/TranslationPanel.swift`：翻译浮窗、OCR 原文确认、复制、重试、收藏、历史入口。
- `Sources/ImmersiveTranslator/TranslationHistoryStore.swift`：本地历史和收藏 JSON 存储。
- `Sources/ImmersiveTranslator/Settings.swift`：设置窗口和本地偏好。
- `Sources/ImmersiveTranslator/KeychainStore.swift`：API Key 的 Keychain 读写。
- `Sources/ImmersiveTranslator/Onboarding.swift`：首次启动引导。
- `Sources/ImmersiveTranslator/Permissions.swift`：辅助功能、屏幕录制权限检查和系统设置跳转。
- `Sources/ImmersiveTranslator/UpdateChecker.swift`：读取 release 更新清单、下载更新包、校验文件大小和 sha256，检查 zip 内 App 元数据与代码签名结构，并准备校验后的临时解包与后台替换安装脚本。
- `scripts/build_app.sh`：构建 `dist/ImmersiveTranslator.app`。
- `scripts/package_release.sh`：生成 release zip、sha256 和 `update-manifest.json`。

## 构建与发布

普通构建：

```bash
swift build
```

OCR 段落整理回归检查：

```bash
./scripts/check_ocr_paragraph_polisher.sh
```

OCR 识别行版面合并回归检查：

```bash
./scripts/check_ocr_reader_layout.sh
```

错误分类回归检查：

```bash
./scripts/check_error_classification.sh
```

翻译响应错误解析回归检查：

```bash
./scripts/check_translation_response_error_parser.sh
```

流式片段解析回归检查：

```bash
./scripts/check_translation_stream_parser.sh
```

流式/慢请求等待状态回归检查：

```bash
./scripts/check_translation_wait_status.sh
```

OCR 预览质量提示回归检查：

```bash
./scripts/check_ocr_preview_quality.sh
```

OCR 框选提示与键盘微调回归检查：

```bash
./scripts/check_ocr_selection_guidance.sh
```

快捷键建议和系统保留组合回归检查：

```bash
./scripts/check_hotkey_advisory.sh
```

术语表解析、去重和请求上限回归检查：

```bash
./scripts/check_glossary_parser.sh
```

Provider 连接响应体回归检查：

```bash
./scripts/check_provider_connection_body_inspector.sh
```

Provider 预设目录回归检查：

```bash
./scripts/check_provider_presets.sh
```

历史导出格式回归检查：

```bash
./scripts/check_history_export.sh
```

更新清单解析与安全 URL 回归检查：

```bash
./scripts/check_update_manifest.sh
```

Release 更新链预检回归检查：

```bash
./scripts/check_release_update_security.sh
```

Release App 构建：

```bash
./scripts/build_app.sh
```

生成 release zip：

```bash
./scripts/package_release.sh 0.1.0
```

发布前预检，不构建、不清理 `release/`：

```bash
CHECK_ONLY=1 ./scripts/package_release.sh 0.1.0
```

生成正式签名并公证的 release zip：

```bash
APP_BUNDLE_ID="com.example.ImmersiveTranslator" \
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARIZE=1 \
NOTARYTOOL_PROFILE="immersive-translator" \
./scripts/package_release.sh 0.1.0
```

输出文件会放在 `release/`：

- `ImmersiveTranslator-<version>-macOS.zip`
- `ImmersiveTranslator-<version>-macOS.zip.sha256`
- `update-manifest.json`

如果要让 App 启动后每日低打扰检查更新、启用菜单里的“检查更新...”，并支持下载后自动校验文件大小、sha256、zip 内 App 元数据和代码签名结构，以及校验通过后的替换安装辅助，需要在构建正式包时设置更新清单地址：

```bash
APP_BUNDLE_ID="com.example.ImmersiveTranslator" \
APP_UPDATE_MANIFEST_URL="https://example.com/immersive-translator/update-manifest.json" \
./scripts/package_release.sh 0.1.0
```

发布到静态托管或 GitHub Release 时，可以让脚本写入下载地址和发布说明：

```bash
APP_BUNDLE_ID="com.example.ImmersiveTranslator" \
RELEASE_BASE_URL="https://example.com/immersive-translator" \
RELEASE_NOTES_URL="https://example.com/immersive-translator/releases/0.1.0" \
APP_UPDATE_MANIFEST_URL="https://example.com/immersive-translator/update-manifest.json" \
./scripts/package_release.sh 0.1.0
```

`RELEASE_BASE_URL` 会用于生成 manifest 里的 `download_url`；如果需要完全自定义下载地址，也可以传入 `RELEASE_DOWNLOAD_URL`。

仓库内置的 GitHub Actions 发布工作流会在推送 tag 或手动触发时自动复用 `./scripts/package_release.sh`，构建 release zip、sha256 和 `update-manifest.json`，并上传到 GitHub Release。以 `v0.1.0` 为例，最终会生成：

- App 内置更新源：`https://github.com/<owner>/<repo>/releases/latest/download/update-manifest.json`
- manifest 里的 `download_url`：`https://github.com/<owner>/<repo>/releases/download/v0.1.0/ImmersiveTranslator-0.1.0-macOS.zip`
- manifest 里的 `release_notes_url`：`https://github.com/<owner>/<repo>/releases/tag/v0.1.0`

这样旧版本 App 会始终读取 latest release 上的最新 manifest，而下载包和发布说明会落到本次 tag 对应的最终发布页。触发方式：

```bash
git tag v0.1.0
git push origin v0.1.0
```

也可以在 GitHub Actions 页面手动运行 `Release` 工作流，填写 `version`，可选填写 `tag`、`build`、`draft` 和 `prerelease`。如果不填写 `build`，工作流会使用 GitHub Actions run number 作为 `CFBundleVersion`。

GitHub Actions 发布需要在仓库配置这些变量和密钥：

- `vars.APP_BUNDLE_ID`：正式公开发布建议使用稳定 reverse-DNS，例如 `com.example.ImmersiveTranslator`。
- `vars.APP_MINIMUM_SYSTEM_VERSION`：可选，默认 `13.0`。
- `vars.CODESIGN_IDENTITY` 或 `secrets.CODESIGN_IDENTITY`：Developer ID Application 证书名称，例如 `Developer ID Application: Your Name (TEAMID)`。
- `secrets.MACOS_CERTIFICATE_P12_BASE64` 和 `secrets.MACOS_CERTIFICATE_PASSWORD`：Developer ID Application 证书导出的 `.p12` 及密码；没有配置时工作流只能退回 ad-hoc 签名，不适合正式公开分发。
- `vars.NOTARIZE`：可选，默认 `auto`；当证书和 notarytool 凭据齐全时自动公证，也可设为 `1` 强制公证。
- notarytool 凭据三选一：`secrets.APPLE_ID` + `secrets.APPLE_TEAM_ID` + `secrets.APPLE_APP_PASSWORD`，或 `secrets.APP_STORE_CONNECT_API_KEY_BASE64` + `secrets.APP_STORE_CONNECT_KEY_ID` + `secrets.APP_STORE_CONNECT_ISSUER_ID`，或在自托管 runner 上使用 `secrets.NOTARYTOOL_PROFILE`。

正式公开发布时建议使用稳定的 reverse-DNS `APP_BUNDLE_ID`，例如 `com.example.ImmersiveTranslator`。如果没有设置 `RELEASE_BASE_URL` 或 `RELEASE_DOWNLOAD_URL`，manifest 会写入相对 zip 文件名；这种配置也可用，但需要把 zip 上传到 `APP_UPDATE_MANIFEST_URL` 指向的 manifest 同目录。更新源使用 HTTPS 时，manifest 里的绝对下载地址和发布说明地址必须同样使用 HTTPS；也可以使用相对路径让 App 按 manifest 同目录解析。打包脚本会在预检和产物校验中阻止 HTTPS manifest 指向 HTTP 更新资源。
当 App 发现新版本时，会先检查 manifest 里的 `minimum_system_version`；如果当前 macOS 不满足要求，只提示原因，不建议下载。兼容时用户可以选择“下载并校验”，更新包会保存到 Downloads，并用 manifest 里的 `size_bytes` 和 `sha256` 自动核对；这些通过后还会临时解包 zip，确认其中的 `.app` 与当前 App 的 Bundle ID 一致，且版本号、构建号、可执行文件与 manifest/Info.plist 对齐，并验证代码签名结构可读。全部通过后，App 会提供“替换安装并退出”：安装准备阶段会重新校验已保存 zip 的大小和 sha256，再解压到系统临时目录，确认其中只有可信的新版本 App 后生成一次性的后台替换脚本；用户确认后当前版本退出，脚本把新 App 复制到当前 App 所在位置，复制后再次核对 Bundle ID、版本号、构建号、可执行文件和代码签名，并自动重新打开新版本。任一校验失败都不会建议安装；如果当前 App 所在目录不可写或系统策略阻止命令行替换，会保留已校验的新 App 并在 Finder 中显示，供手动拖入 Applications。

### 本地开发签名

开发阶段如果每次重新打包后都需要重新授权辅助功能或屏幕录制，通常是因为 App 使用了 ad-hoc 签名。macOS 会把每次重新打包后的二进制当成新的代码身份。

`./scripts/build_app.sh` 默认会自动查找名为 `ImmersiveTranslator Local Dev` 的固定本地 Code Signing identity。找到后会直接复用；找不到时脚本会停止并给出提示，不再默认退回到 ad-hoc 签名。

可以在“钥匙串访问 -> 证书助理 -> 创建证书...”里创建一个本地自签名证书：

- 名称：`ImmersiveTranslator Local Dev`
- 身份类型：`自签名根证书`
- 证书类型：`代码签名`

创建后验证并构建：

```bash
security find-identity -v -p codesigning
./scripts/build_app.sh
codesign -dv --verbose=4 dist/ImmersiveTranslator.app 2>&1 | grep -E 'Authority|Signature'
```

如果你想使用其它稳定证书，可以显式指定：

```bash
CODESIGN_IDENTITY="Your Code Signing Identity" ./scripts/build_app.sh
```

只有在一次性构建或 release 打包确实可以接受权限重新授权风险时，才显式允许 ad-hoc：

```bash
ALLOW_ADHOC_CODESIGN=1 ./scripts/build_app.sh
```

`./scripts/package_release.sh` 在没有传入 `CODESIGN_IDENTITY` 时会显式使用 ad-hoc 签名，保持当前开发 release 的打包路径可用。正式分发需要 Apple Developer ID 证书和 notarytool 公证；传入 `CODESIGN_IDENTITY` 并设置 `NOTARIZE=1` 后，脚本会开启 Hardened Runtime、使用 timestamp 签名、提交 notarytool、公证成功后 staple，并生成 sha256 校验文件。

每次打包结束后，脚本会自动校验 `.app` 结构、可执行文件、Info.plist 里的版本/构建号/Bundle ID/更新源、release zip 非空、`.sha256` 文件可用、`update-manifest.json` 可被 Ruby/Python 解析为合法 JSON，确认 manifest 里的 `version`、`build`、`minimum_system_version`、`download_url` / `release_notes_url`、`size_bytes`、`sha256`、`published_at` 等字段格式可用，并确认 `size_bytes` 与 zip 实际字节数一致、`sha256` 与校验文件一致。随后脚本会临时解开最终 release zip，确认里面正好只有一个 `ImmersiveTranslator.app`，再核对 zip 内 App 的 Info.plist、可执行文件和代码签名结构；如果是 `NOTARIZE=1` 且没有设置 `SKIP_SPCTL_ASSESS=1`，还会对 zip 内 App 再跑一次 Gatekeeper `spctl --assess`，避免构建目录正确但压缩包内容错位，或公证/装订在最终包路径上不可用。App 端检查更新时也会拒绝格式异常的 manifest；下载后会再校验文件大小、sha256，并检查 zip 内 `.app` 的 Bundle ID、版本号、构建号、可执行文件和代码签名结构，避免用户安装不可信、不可比较、下载截断或打包错位的更新包。用户选择替换安装时，App 会在安装准备阶段重新核对已保存 zip 的大小和 sha256，重新解包并复用同一套 App 校验；后台替换复制完成后，还会对落地后的 App 再核对 Info.plist、可执行文件和 `codesign --verify --deep --strict`。

`CHECK_ONLY=1 ./scripts/package_release.sh <version>` 可以提前检查发布环境：必要命令、版本号/构建号、Bundle ID、签名身份、notarytool 凭据、更新清单地址、下载地址、发布说明地址和 release zip 指向。预检会提示 Bundle ID 是否像稳定 reverse-DNS、HTTPS manifest 是否混用了 HTTP 下载、`RELEASE_BASE_URL` 是否误填成文件地址、相对下载地址会按哪个 manifest 位置解析，以及最终 `download_url` 是否看起来直连 `.zip`。预检不会构建或删除产物；error 会阻断发布，warning 用来提醒可能影响公开分发体验的配置。

正式公证可以使用三种凭据方式之一：

```bash
# 推荐：提前保存到 Keychain
xcrun notarytool store-credentials immersive-translator \
  --apple-id "you@example.com" \
  --team-id "TEAMID" \
  --password "app-specific-password"

NOTARYTOOL_PROFILE="immersive-translator" \
APP_BUNDLE_ID="com.example.ImmersiveTranslator" \
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARIZE=1 \
./scripts/package_release.sh 0.1.0
```

```bash
# 或直接通过 Apple ID app-specific password
APPLE_ID="you@example.com" \
APPLE_TEAM_ID="TEAMID" \
APPLE_APP_PASSWORD="app-specific-password" \
APP_BUNDLE_ID="com.example.ImmersiveTranslator" \
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARIZE=1 \
./scripts/package_release.sh 0.1.0
```

```bash
# 或使用 App Store Connect API Key
APP_STORE_CONNECT_API_KEY="/path/to/AuthKey_ABC123.p8" \
APP_STORE_CONNECT_KEY_ID="ABC123" \
APP_STORE_CONNECT_ISSUER_ID="issuer-uuid" \
APP_BUNDLE_ID="com.example.ImmersiveTranslator" \
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARIZE=1 \
./scripts/package_release.sh 0.1.0
```

校验发布包：

```bash
shasum -a 256 -c release/ImmersiveTranslator-0.1.0-macOS.zip.sha256
spctl --assess --type execute --verbose=4 dist/ImmersiveTranslator.app
ruby -rjson -e 'JSON.parse(File.read("release/update-manifest.json")); puts "manifest OK"'
```

## 贡献

欢迎提交 issue 和 pull request。这个项目会优先保持简单、原生、可读，不会为了功能堆叠引入复杂依赖。

比较适合优先贡献的方向：

- OCR 体验和识别后处理
- 浮窗交互
- 错误提示和诊断
- 快捷键自定义
- Provider 预设
- 文档、截图和演示视频

## License

MIT
