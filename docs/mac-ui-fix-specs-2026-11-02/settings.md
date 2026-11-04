# 设置中心对齐规格（Mac ↔ Windows v0.12 设置中心）

- 诊断员：设置中心域 · 2026-11-03
- Windows 基准：`immersive-translator-windows/src/views/Settings.tsx`（1619 行）+ `VoiceSettingsTab.tsx` + `AccountSection.tsx` + `GatewayVoiceSection.tsx` + `core/providerPresets.ts` + `src/styles.css`
- Mac 落点：`immersive-translator-mac/Sources/ImmersiveTranslator/Settings.swift`（4789 行）+ `VoiceGateway/VoiceSettingsTab.swift` + `VoiceGateway/GatewayVoiceSection.swift` + `Sources/ProviderCore/ProviderProfile.swift`
- 用户实测反馈「没有按照最新 windows 端的来」→ 核实为：**模型服务页未对齐最新双栏 IA（缺官方云服务平台卡/品牌色服务商网格/逐字文案）、翻译与快捷键页多处文案漂移、墨绿品牌色未落地（全窗跟随系统强调色）**。语音页、账号页、壳层（侧栏/面包屑/底部状态区）上一轮已对齐，本轮为增量修补。

---

## 一、Windows 行为基准（逐字文案与关键值）

### 1.1 壳层（Settings.tsx:527-568 + styles.css:655-817）

| 元素 | 基准 |
|---|---|
| 七分区 TABS | `模型服务 / 翻译 / 语音 / 术语表 / 快捷键 / 账号 / 关于`（Settings.tsx:77-85） |
| 侧栏分组 | caption `翻译与工具`（前 5 项）+ `账号与应用`（后 2 项）（Settings.tsx:540-545） |
| 品牌区 | 渐变徽记 24px（内 IconTranslate 13px）+ `沉浸口语`（bold 13.5px）+ `设置中心`（Settings.tsx:531-538） |
| 侧栏宽 | 176px（styles.css:664-672）；内容列 `max-width: 600px`（styles.css:755-757） |
| 侧栏底部状态区 | `conn-chip` ×2 + 版本号：`接口已配置`/`未配置接口`、`账号已登录`/`未登录账号`、`v{appVersion}`（Settings.tsx:546-556）；chip = 6px 状态点 + 11px 文案，绿 `--ok` / 橙 `--warn`（styles.css:789-817） |
| 顶栏面包屑 | `应用设置` ＋ `／` ＋ `{当前分区名}`（Settings.tsx:561-565） |
| 底部操作条 save-bar | 左：`有未保存的更改`（脏）/`已保存`；右：`关闭`（btn-secondary）+ `保存设置`（btn-primary）（Settings.tsx:1344-1367） |

「已配置」判定：`hasValidSettings(settings) && (!isPlatform || loggedIn)`（Settings.tsx:509-510）——沉浸云选中时必须已登录才算配置。

### 1.2 模型服务页（Settings.tsx:573-875）

页头：`模型服务` ＋ 副标题逐字 **「沉浸云登录即用；其他服务商使用你自己的 API Key，每家密钥分开保存、切换互不影响。」**（575-579）

首次引导卡 welcome-box（582-602，未关闭引导且接口未配好时显示）：
- 标题 `三步开始使用`；正文三步：`① 选「沉浸云」登录即用；或选一个自带 Key 的服务商（国内直连推荐 DeepSeek 或 智谱 GLM）。` / `② 自带 Key 的服务商需填入对应的 API Key（本地 Ollama 可留空）。` / `③ 自带 Key 的服务商可点「测试连接」验证；选中任意文字按 Ctrl+Shift+Q 即可翻译。`；按钮 `知道了`（点了写 `setOnboardingDismissed(true)`）。

双栏 `provider-workspace`（604-873）：

**左列 provider-selection**（radiogroup aria-label `翻译服务商`）：
1. 分组 `官方云服务`（副标题 `沉浸云账号登录即用，无需申请任何密钥`）＋ platform-card（607-647）：
   - mark `云`；标题 `沉浸云` + chip-green `官方`；描述 `模型与额度由服务端统一管理，本机不保存任何密钥。`
   - 状态行：已登录 → `已登录 {email}`；未登录 → `未登录——选中后到右侧登录即可使用`
   - 选中态右上对勾徽章 provider-check
2. 分组 `自带 API Key 的服务商`（副标题 `使用你自己的密钥，加密保存在本机，切换互不影响`）+ 右侧计数 `{n} 个`（649-656）
3. ProviderItem 行（1405-1446）：品牌色徽标（mark 字 + 品牌色底 12% 透明）+ 名称 + keydot（已存 Key 时亮，title `已保存此服务商的 API Key`）+ 模型胶囊 + 选中对勾

品牌色 map（Settings.tsx:1449-1460）：
```
deepseek #4d6bfe · zhipu #3859ff · dashscope #ff6a00 · moonshot #7b5cff
openai #10a37f · gemini #4285f4 · ollama #8b8d94 · 缺省 var(--accent)
```

**服务商预设全表**（providerPresets.ts:52-143，`PLATFORM_PROVIDER_ID = "immersive-cloud"`:40，platformEndpoint = `{base}/v1/chat/completions`:48-50）：

| id | displayName | mark | endpoint | 默认 model | models 候选 | keyUrl | hint |
|---|---|---|---|---|---|---|---|
| deepseek | DeepSeek | D | `https://api.deepseek.com/chat/completions` | deepseek-chat | deepseek-chat, deepseek-reasoner | `https://platform.deepseek.com/api_keys` | 国内直连，性价比高。如遇推理模型噪声，会自动关闭思考模式。 |
| zhipu | 智谱 GLM | 智 | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | glm-4-flash | glm-4-flash, glm-4-plus, glm-4-air | `https://open.bigmodel.cn/usercenter/apikeys` | GLM-4-Flash 免费，国内直连速度快。会自动关闭思考模式。 |
| dashscope | 通义千问 | 通 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | qwen-plus | qwen-plus, qwen-turbo, qwen-max | `https://bailian.console.aliyun.com/?apiKey=1#/api-key` | 阿里云百炼，使用兼容模式路径。 |
| moonshot | Kimi | K | `https://api.moonshot.cn/v1/chat/completions` | moonshot-v1-8k | moonshot-v1-8k/32k/128k | `https://platform.moonshot.cn/console/api-keys` | 月之暗面 Kimi，长上下文，适合长文翻译。 |
| openai | OpenAI | O | `https://api.openai.com/v1/chat/completions` | gpt-4o-mini | gpt-4o-mini, gpt-4o, gpt-4.1-mini | `https://platform.openai.com/api-keys` | 官方接口，国内直连不稳定，建议配置代理。 |
| gemini | Google Gemini | G | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | gemini-2.5-flash | gemini-2.5-flash/-flash-lite/-pro | `https://aistudio.google.com/app/apikey` | 使用 OpenAI 兼容路径，国内需代理。 |
| ollama | Ollama | Ol | `http://localhost:11434/v1/chat/completions` | llama3.2 | llama3.2, qwen3:8b, deepseek-r1:8b | （无）allowEmptyApiKey | 本机运行，数据不出机器。先 \`ollama serve\`，再 \`ollama pull llama3.2\`。 |
| immersive-cloud | 沉浸云 | 云 | 动态 `platformEndpoint(base)` | （空，服务端下发） | `/v1/me/config` 下发 | （无）allowEmptyApiKey | 登录即用，无需 API Key，按账号额度计费；模型与上游由服务端统一管理。 |

**右列 provider-configuration**（672-871）：
- 卡头：`连接配置`（沉浸云时为 `沉浸云账号`）+ 副标题 `{displayName}`（沉浸云未选预设时 `自定义 OpenAI 兼容接口`）+ 状态 chip：沉浸云 → `已登录`/`未登录`（绿/amber）；本机 → `本机服务`（绿）；其他 → `密钥已保存`/`等待密钥`（678-688）
- caption：非沉浸云时显示预设 hint（690-694）
- API Key 块（742-783）：label `API Key` + chip `本机无需 Key`（本地）/`已保存`/`未设置`；输入框 placeholder `填入 {displayName} 的 API Key`（自定义时 `sk-…`）+ 显隐眼睛（title `显示 Key`/`隐藏 Key`）；keyUrl 链接逐字 `↗ 前往 {displayName} 控制台获取 API Key`（778-782）
- 模型块（786-806）：label `模型`、datalist 候选、placeholder `gpt-4o-mini`、hint `下拉里是 {displayName} 的常用模型，也可自由输入`
- 动作（809-817）：`测试连接`（测试中 → `测试中…`）
- `details` 折叠 `高级：接口地址与诊断`（819-871）：label `接口地址（OpenAI 兼容）` placeholder `https://api.openai.com/v1/chat/completions`；`实际请求：{normalizeEndpointPreview}` + hint `地址会自动补全 /v1/chat/completions；支持任意 OpenAI 兼容接口。`；按钮 `复制脱敏 curl`（成功提示 `脱敏 curl 已复制到剪贴板`）与 `生成诊断报告`（提示 `诊断报告已复制（已脱敏，可安全分享）`）
- normalizeEndpointPreview（1388-1394）：尾 `/chat/completions` 原样；尾 `/v1` 补 `/chat/completions`；其余补 `/v1/chat/completions`
- 沉浸云账号块（696-740）：已登录 → 邮箱行 + hint `翻译请求自动携带账号令牌（到期自动续期），按账号额度计费；模型由服务端统一下发，无需配置。` + 按钮 `管理账号`（跳账号页）；未登录 → hint `登录后即可使用：无需 API Key，模型由服务端下发，按账号额度计费。` + 主按钮 `登录沉浸云`

登录自动切云轻提示（567-572， loggedIn false→true 且未选 gateway 时）：`已切换为沉浸云语音——讯飞凭据已保留，可在「语音」页随时切回`，4s。

### 1.3 翻译页（Settings.tsx:877-1004）

- 页头：`翻译` + `目标语言与翻译浮窗的行为。`
- 方向示意条 translation-route（885-900）：`原文` `自动识别` → `译文` `{English / 简体中文 或 fixedTarget}` + 模式 chip `自动切换`/`固定目标`
- 译文目标卡（902-950）：seg 按钮 `自动识别` / `固定目标语言`；auto 态 hint `中文 → English，其他语言 → 简体中文`；fixed 态 hint `始终翻译为指定的目标语言`；目标语言输入 placeholder `如：日本語、English、简体中文`
- 输出行为卡（952-987）：`流式输出` switch（hint `边翻译边显示；关闭则等全部完成再显示`）；`词典卡片` switch（hint `划选单个单词或短语时，浮窗自动切换为词典卡片（音标、多义项释义、例句）`）
- 自定义翻译风格卡（989-1001）：hint `可选项，追加到系统提示词`；placeholder `例如：使用自然口语化的风格；保留专有名词不翻译`
- **无截图 OCR 卡**（Windows OCR 在关于页「离线能力」）

### 1.4 语音页（VoiceSettingsTab.tsx:190-369 + GatewayVoiceSection.tsx）

Mac 上一轮已对齐（见 §二.6 复核结论），基准要点：页头双态副标题（196-199）；引导切云条/未开通条（203-225）；左列 `官方云服务`（`沉浸云语音` + chip 官方/推荐 + `登录即用，三服务共用一个账号`）与 `自带凭据 · 高级`（讯飞行，mark `讯` 蓝 `#2c6dfb`）；右列卡头 chip `已登录/未登录` 或 `凭据已保存/未配置`；GatewayVoiceSection：账号卡、语音能力卡（`全部可用/读取中…/未开通/部分可用/额度用尽` 五态 + 朗读音色 + 识别语种 + 跟读打分开关 + 本月额度 + `兑换更多额度` + 一键测试三行）；页脚 caption `之前在阅读室设置抽屉、口语陪练、录音直译里填过的凭据仍然有效（同一套加密存储），无需重复填写。`

### 1.5 术语表页（Settings.tsx:1022-1138）

- 页头：`术语表` + `固定译法。每行一条，翻译时随请求一并发送（最多前 80 条）。` + 右侧 meta `{valid} 条有效`（` · {invalid} 行无法解析`、` · 超出 80 条 {n} 条`）
- 编辑器 placeholder 逐字：`hello = 你好\nworld -> 世界\n# 注释行会被忽略\n\n支持 原词 = 译法、->、全角冒号，以及 CSV/TSV 前两列`
- 工具条四按钮：`导入文件`（.txt/.csv/.tsv，导入后 `已导入并合并 {file.name}`）/`从剪贴板导入`（`已从剪贴板导入并合并`）/`去重 / 规范化`（`已去重并规范化`）/`导出到剪贴板`（`已复制 {n} 条到剪贴板`）
- 右侧 guide aside（1090-1120）：大数字 `{valid}` + `/ 80 条已启用` + progressbar（0..80）+ `每次翻译最多附带 80 条有效术语。` + 警告 `{n} 行无法识别，请检查分隔符。`/`有 {n} 条超出发送上限。` + `格式示例`：`原词 = 译法`、`source → target`、`也支持 CSV / TSV 的前两列，井号开头的行会忽略。`

### 1.6 快捷键页（Settings.tsx:1141-1188 + 1484-1619 + hotkeyValidator.ts:122-128）

- 页头：`快捷键` + `任意界面下全局生效；改完点「立即生效」或保存设置。`
- 三张 HotkeyField 卡（label / hint）：
  1. `翻译热键` / `读取当前选中文字并弹出翻译浮窗`
  2. `截图 OCR 热键` / `进入截图模式，框选区域后自动识别并翻译`
  3. `阅读室热键` / `把选中的内容送进沉浸阅读室精读`
- 每卡：输入框（placeholder `Ctrl+Shift+Q`）+ `录制组合键` 按钮（录制中 `录制中…（取消）`、提示 `请按下新的组合键…（Esc 取消）`、无效 `需要至少一个修饰键 + 一个主键`、成功 `已设置 {combo}`）+ `立即生效` 按钮 + 推荐行
- RECOMMENDED_HOTKEYS：`Ctrl+Shift+Q`、`Ctrl+Shift+E`、`Ctrl+Shift+T`、`Alt+Shift+S`、`Ctrl+Alt+T`（hotkeyValidator.ts:122-128）

### 1.7 账号页（AccountSection.tsx:190-349）

- 页头：`账号` + 双态副标题：已登录 `账号信息与登录状态`；未登录 `登录是可选项——翻译、阅读室与复习全部本地可用`
- 失效橙条 acct-notice（token_invalid/token_reused 落点）
- 未登录：空态卡 `未登录` + `登录后可使用官方翻译服务、同步云端配置；不登录不影响任何本地功能` + 主按钮 `登 录`
- 已登录五卡：资料卡（头像字 + 昵称 + plan 徽标 + 邮箱）/ `登录信息`（`当前设备` `Windows · 本机` + chip `当前`；`注册时间`；`云端配置` hint `登录后自动同步；失败可在此手动重拉` + `重新拉取`）/ `口语场景云同步`（hint `升级计划 A0：先拉取云端变更再推送本地改动；场景编辑器上线后将自动接入` + `立即同步`）/ RedeemCard（锚点 `account-redeem`）/ 安全行（`退出当前账号后，本地数据（生词本/历史/书架）不受影响` + 红按钮 `登出`→`登出中…`）

### 1.8 关于页（Settings.tsx:1194-1340 + PrivacyPolicyCard.tsx）

- 页头：`关于` + `版本更新与离线模型管理。`
- `应用更新` 卡：卡头 + 右侧 `v{appVersion}` code；`检查更新`（`检查中…`）/ 有新版 `升级到 v{version}`；下载进度条
- `启动与引导` 卡：`开机自启` switch（hint `开机后驻留托盘，确保提醒和角标正常工作`，失败 `设置开机自启失败：{err}`）；`功能引导`（hint `重新查看主要功能与快捷键` + `查看引导`）
- `离线能力` 卡：`截图翻译模型`（hint `PaddleOCR，支持中英日韩等`）+ `已就绪` / `未下载（约 16MB）` + `下载模型`
- `隐私政策` 卡（PrivacyPolicyCard.tsx:10-39）：`数据怎么收集、怎么使用（更新于 {updatedAt}）` + `查看完整政策`/`收起`
- danger-zone：`恢复默认设置` + hint `清空已保存的接口配置（endpoint / API Key / 模型等），并恢复全部默认值` + 红按钮 `恢复默认`；确认弹窗 title `恢复默认设置`、message `将清空已保存的接口配置（endpoint / API Key / 模型等），并恢复全部默认值。确定继续？`、confirm `恢复默认`（1370-1377）

### 1.9 墨绿品牌色（styles.css:28-35 亮色 / 76-83 暗色）

| 变量 | 亮色 | 暗色 |
|---|---|---|
| --brand-accent | `#1f6b57` | `#73c6aa` |
| --brand-hover | `#185646` | `#86d3ba` |
| --brand-active | `#134836` | `#9cdfc6` |
| --brand-rgb | `31, 107, 87` | `115, 198, 170` |
| --brand-foreground | `#ffffff` | `#112a20` |
| --brand-soft | `#e3f0ea` | `#263d34` |
| --brand-softer | `#f1f6f2` | `#21332c` |
| --brand-line | `#b9d8cc` | `#436c5b` |

### 1.10 生产服务端（登录域硬性要求的 curl 实测）

Windows 常量：`PROD_BASE_URL: &str = "https://www.prismspace.online"`（`src-tauri/src/auth.rs:153`；dev 常量 `http://127.0.0.1:8090` 在 Mac `ServerAuth.swift:111` 有对应，Mac **无** prod 常量）。

路由级实测（2026-11-03 本机执行，仅证明可达与路由正确，未发送真实邮箱、未创建账号）：

```bash
# 1) 域名连通性 → HTTP 404（根路径无页面属预期，域名与 TLS 可达，connect 0.000243s）
curl -sS -o /dev/null -w "HTTP %{http_code}\n" --max-time 15 https://www.prismspace.online

# 2) GET /v1/me（无令牌）→ HTTP 401
curl -sS -w "\nHTTP %{http_code}\n" https://www.prismspace.online/v1/me
#   {"error":{"code":"unauthorized","message":"缺少访问令牌"}}

# 3) POST /v1/auth/otp/request（非法 body，无真实邮箱）→ HTTP 400
curl -sS -w "\nHTTP %{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"not_a_field":123}' https://www.prismspace.online/v1/auth/otp/request
#   {"error":{"code":"validation_error","message":"请求参数不合法","details":[{"path":"email","message":"Required"}]}}

# 4) 错误路径 → HTTP 404
curl -sS -w "\nHTTP %{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{}' https://www.prismspace.online/v1/nonexistent
#   {"error":{"code":"not_found","message":"Cannot POST /v1/nonexistent"}}
```

四条全部符合预期（401 / 400 / 404 / 域名可达）。服务端路由健康，Mac 端登录链路修复只需补客户端缺省 URL（见 §二.7）。

---

## 二、Mac 落点设计

### 2.1 墨绿品牌色落地（P0，域目标硬指标）

现状：设置窗全部取 `Color.accentColor`（跟随系统强调色，默认蓝），项目**无 Assets.xcassets**；登录窗有独立暖橙 palette（LoginWindowController.swift:44-54）**不许动**。

1. **新建 `Sources/ImmersiveTranslator/SettingsBrandColor.swift`**：`enum SettingsBrandColor`，用 `NSColor(name:dynamicProvider:)` 定义随深浅色切换的动态色，亮/暗值照抄 §1.9（accent `#1f6b57`/`#73c6aa`、soft、line、foreground）。SPM 无资产目录，动态 NSColor 是唯一等价物。
2. **替换设置域内的 `Color.accentColor` → `SettingsBrandColor.accent`**（实测计数：`Settings.swift` 12 处：1492/1574/1596/1599/1881/1884/2138/4264/4268/4283/4308/4466；`VoiceGateway/VoiceSettingsTab.swift` 7 处：250/258/279/286/290/343/350/354 附近；`VoiceGateway/GatewayVoiceSection.swift` 1 处；`LoginWindowController.swift` 内 `AccountSectionView` 3 处（1296/1311/1312，avatar+plan 徽标）——只动账号分区视图，登录窗主视图的 palette 不动）。机械替换后 `swift build` 兜底验证无遗漏。
3. **根视图 `.tint(SettingsBrandColor.accent)`**：`SettingsView.body` 最外层（Settings.swift:1280-1339）加 `.tint(...)`，让系统控件（Toggle 开关、segmented Picker、borderedProminent 按钮、录制高亮）同步墨绿；`Color.accentColor` 不受 `.tint` 环境影响，故第 2 步替换不可省。
4. 侧栏导航选中态（Settings.swift:1573-1599 左缘 3pt 条 + accent-soft 底）与 conn-chip 点色保持现有 green/orange 语义（对齐 Windows styles.css:804-816 的 `--ok`/`--warn`，非品牌色职责）。

### 2.2 模型服务页对齐双栏 IA（P0，最大差距）

改 `Settings.swift` 的 `providerSection`（1753-1797）、`providerSelector`（4210-4236）、`builtinProviderCard`（4238-4273）、`SettingsSection.pageSubtitle`（1021-1022）。

1. **页头副标题改逐字**（1021-1022）：`选择一个翻译服务商；每家的密钥分开保存，切换互不影响。` → **`沉浸云登录即用；其他服务商使用你自己的 API Key，每家密钥分开保存、切换互不影响。`**（Windows Settings.tsx:578）
2. **ProviderCore 补沉浸云预设**（`Sources/ProviderCore/ProviderProfile.swift`）：
   - `builtinPresets`（48-91）追加 `immersive-cloud` 项：displayName `沉浸云`、endpoint `https://www.prismspace.online/v1/chat/completions`（缺省值，运行时若已登录可由 `ServerAuthConfiguration.resolveBaseURL()` 派生覆盖）、model 空、isBuiltin true、allowEmpty 语义由 `TranslationClient.requiresAPIKey` 豁免（host 命中生产域名时免 Key，改 `requiresAPIKey` 的本地判定扩展：`prismspace.online` 域名 + 已登录豁免）。
   - `builtinModelCandidates`（37-46）**同步 Windows 最新值**：deepseek → `["deepseek-chat","deepseek-reasoner"]`（现 `deepseek-v4-flash` 等三值，37-44 过时）；zhipu → `["glm-4-flash","glm-4-plus","glm-4-air"]`；openai → `["gpt-4o-mini","gpt-4o","gpt-4.1-mini"]`；dashscope/moonshot/gemini/ollama 与 Windows 一致（现值已一致，除 deepseek/zhipu/openai 默认 model 也要改：`deepseek-chat`、`glm-4-flash`、`gpt-4o-mini`）。
   - displayName 对齐：`智谱` → `智谱 GLM`（57）；`Ollama（本地）` → `Ollama`（86）。
3. **providerSection 改双栏**（1753-1797）：HStack 两列——左列 250pt 选择列（沉浸云平台卡 + 自带 Key 服务商列表），右列配置列（连接配置卡 + 测试动作 + 高级折叠）。现有 `连接配置`/`接口诊断` 卡内容并入右列。
4. **左列结构**（对齐 Settings.tsx:604-670）：
   - 分组头 `官方云服务`（副标题 `沉浸云账号登录即用，无需申请任何密钥`）+ 沉浸云平台大卡（mark `云` + `沉浸云` + `官方` 绿 chip + `模型与额度由服务端统一管理，本机不保存任何密钥。` + 登录态行 `已登录 {email}`/`未登录——选中后到右侧登录即可使用`；未登录态附 `登录沉浸云` 主按钮（696-740 右列账号块语义在 Mac 可收进平台卡下方，见 §四.5）
   - 分组头 `自带 API Key 的服务商`（副标题 `使用你自己的密钥，加密保存在本机，切换互不影响` + 计数 `7 个`）
   - 服务商行改 Windows ProviderItem 同构：品牌色徽标（mark 字 + §1.2 品牌色 12% 底）、名称、keydot（KeychainStore.apiKey(for:) 非空时亮 6pt 绿点）、模型胶囊、选中对勾；Ollama 行加 `本地` 绿 chip（Windows Settings.tsx:1432-1434）
   - providerSubtitle 改用 `pageSubtitle` + 每行点击后右列 caption 显示该预设 hint（Windows 690-694）
5. **右列连接配置**（1761-1775 保留骨架，补三件）：
   - 卡头加状态 chip：沉浸云 → `已登录`/`未登录`；本机 → `本机服务`；其他 → `密钥已保存`/`等待密钥`（Windows 678-688）
   - API Key 字段 placeholder 逐字 `填入 {displayName} 的 API Key`；现有 `labeledField(apiKeyFieldTitle…)`（1772）标题保留 Mac 双态（`API Key（云接口需要）/（本地接口可留空）`，§四.9）
   - keyUrl 链接：`↗ 前往 {displayName} 控制台获取 API Key`（ProviderProfile 需加 `keyURL: URL?` 字段 + Windows §1.2 表内 URL）
6. **首次引导卡重写**（2427-2453 现文案 `先选接口类型，不必一上来就找 Key`/`内置三个云预设…` 与 Windows 不同）：改 Windows welcome-box 三步版（§1.2 逐字），`知道了` 后写 UserDefaults（新键 `onboardingDismissed`，对齐 Windows `isOnboardingDismissed`/`setOnboardingDismissed`）；显示条件 `!dismissed && !hasValidSettings`。

### 2.3 翻译页文案对齐（P1）

改 `translationSection`（1800-1856）：
1. seg 选项 `中英互译` → **`自动识别`**（`TranslationDirection.title`，Settings.swift:496）；`detail` auto 态改 `中文 → English，其他语言 → 简体中文`（Windows 914）
2. 流式开关 label `流式显示译文` → `流式输出`（Windows 961）+ hint `边翻译边显示；关闭则等全部完成再显示`
3. 词典卡片 hint 改逐字 `划选单个单词或短语时，浮窗自动切换为词典卡片（音标、多义项释义、例句）`（现文本多了 `；关闭后一律整句翻译` 尾巴，Windows 无；可保留为 Mac 补充但放次要行）
4. 自定义风格 placeholder 改 `例如：使用自然口语化的风格；保留专有名词不翻译`（现 `例如：译文要自然口语化；技术名词保留英文；不要翻译产品名。`，1913）

### 2.4 快捷键页文案对齐（P1）

改 `hotkeysSection`（1945-1993）：
1. 三行标题：`选中文本翻译` → **`翻译热键`**、`截图 OCR 翻译` → **`截图 OCR 热键`**、`沉浸阅读室` → **`阅读室热键`**（Windows 1150/1161/1171；同步 `hotKeyConflictMessage` 4394-4397 内标题）
2. 每行加 hint 副文案（Windows 1151/1162/1172 逐字）
3. 加推荐组合行：Mac 等价键位建议 `⌘⌥R`、`⌃⌥T`、`⌘⇧T`、`⌃⇧Q`、`⌥⇧S`（Windows Ctrl+Shift 系列在 macOS 与系统冲突率高，按 §四.10 理由取 mac 化组合；点 chip 即写入）
4. 页头副标题 `任意界面下全局生效；改完点「立即生效」或保存设置。` → Mac 自动保存语义版保留现文案（Settings.swift:1034，§四.4）

### 2.5 术语表页补齐（P2）

改 `glossarySection`（1921-1942）+ `glossaryMaintenanceActions`（3513-3553）：
1. 加 `从剪贴板导入` 按钮（NSPasteboard 读文本 → mergeGlossary 等价逻辑，成功提示 `已从剪贴板导入并合并`；Windows 1056-1065）
2. 统计卡加进度条视觉：大数字 `{valid}` + `/ 80 条已启用` + ProgressView(0..80)（Windows 1092-1105；`GlossaryParser.promptMappingLimit` = 80 已有，Settings.swift:1032）
3. 编辑器 placeholder：Mac 用编辑器下方说明文字已可，但把 §1.5 的 `hello = 你好 / world -> 世界 / # 注释行会被忽略` 三行示例并进现说明首行（1931 现说明过长，精简为 Windows placeholder 语序）

### 2.6 账号页与关于页增量（P2）

1. 账号页补 pagehead：`sectionContent` 的 `.account` 分支（Settings.swift:1687-1688）在 `AccountSectionView` 前调 `pagehead(.account)`；`AccountSectionView` 内联副标题 Text（LoginWindowController.swift:1242-1246）删除（防双标题）；`SettingsSection.pageSubtitle` `.account`（1036）改 Windows 双态逐字：`登录是可选项——翻译、阅读室与复习全部本地可用`（Mac 版页头为静态，已登录态文案差异进 §四.6）
2. 关于页副标题（Settings.swift:1038）`版本更新、启动与引导。` 保持——Windows 的 `版本更新与离线模型管理。` 指向 PaddleOCR 卡，Mac 无此卡（§四.7）
3. 危险区确认弹窗文案（1435）已含账号/历史保护说明，比 Windows 更完整，保留（§四.8）

### 2.7 ServerAuth 生产缺省 URL（P0 前置，跨域协同项）

`ServerAuthConfiguration`（ServerAuth.swift:108-134）只有 `devBaseURL = "http://127.0.0.1:8090"`；生产 Mac 包无 `server_endpoint.json` 覆盖时登录/沉浸云语音全部打 127.0.0.1。**照 Windows auth.rs:144-165 的两层机制补齐**：加 `static let prodBaseURL = "https://www.prismspace.online"`，`resolveBaseURL` 覆盖文件优先，否则按构建类型取缺省（`#if DEBUG` → dev，release → prod）。本域 curl 实测见 §1.10。此项同时是 §2.2 沉浸云平台卡可登录的前提；修复落点在 ServerAuth.swift，归属登录域，规格此处只做协同声明。

### 2.8 底部状态区与关闭按钮（已对齐，复核项）

侧栏底部双 conn-chip + 版本号（Settings.swift:1531-1548，文案 `接口已配置/未配置接口`、`账号已登录/未登录账号`、`v{version}` 与 Windows 逐字一致）与保存条 `关闭` 按钮（Settings.swift:2308-2310）均已落地，本轮只随 §2.1 换色。`providerConfigured`（1629-1636）需在 §2.2 落地后补沉浸云分支：选中 immersive-cloud 时改判 `serverAuth.status.loggedIn`（对齐 Windows Settings.tsx:509-510）。

### 2.9 需补的 Swift 测试

1. `Tests/ProviderCoreTests/ProviderProfileTests.swift`（新增）：断言 `builtinPresets` 含 `immersive-cloud` 且 endpoint/model 与 §1.2 表逐字一致；deepseek/zhipu/openai 的默认 model = `deepseek-chat`/`glm-4-flash`/`gpt-4o-mini`；`builtinModelCandidates` 首候选与默认 model 相同；zhipu displayName = `智谱 GLM`。
2. `Tests/ImmersiveTranslatorTests/SettingsBrandColorTests.swift`（新增）：动态色在 light/dark appearance 下解析出 `#1F6B57` / `#73C6AA`（用 `NSColor.resolveColor` 断言 RGB 分量，容差 0）。
3. `Tests/ImmersiveTranslatorTests/SettingsSectionIATests.swift`（新增，仿 `SettingsDangerZoneTests.swift` 既有模式）：`SettingsSection` 七分区 title/分组与 §1.1 一致；`pageSubtitle` provider/voice/glossary 逐字含关键短语（`沉浸云登录即用`、`最多前 80 条`）。
4. `Tests/ImmersiveTranslatorTests/ServerAuthConfigURLTests.swift`（新增）：`resolveBaseURL` 无覆盖文件时 DEBUG→dev、（用注入参数模拟）release→prod；覆盖文件 baseUrl 非空时优先——与现有 ServerAuthTests 合并亦可。
5. 既有 `SettingsDangerZoneTests.testSettingsSectionsMatchWindowsIA`（Tests/ImmersiveTranslatorTests/SettingsDangerZoneTests.swift:147-164）只断言 title/分组 caption，不断言 subtitle——新副标题文案不会打爆它；新 subtitle 断言放上面第 3 条的新测试里。

---

## 三、逐条验收清单

1. `swift build`（在 immersive-translator-mac/）通过；`swift test --filter SettingsSectionIATests` / `--filter ProviderProfileTests` / `--filter SettingsBrandColorTests` / `--filter ServerAuthConfigURLTests` 全绿（或并入既有测试 target 跑全量 `swift test`）。
2. 深色与浅色模式下，设置窗侧栏选中行、品牌徽记、语音页官方卡、下载进度条、账号头像均为墨绿 `#1f6b57`（浅）/`#73c6aa`（深）；登录窗保持暖橙不变。
3. 模型服务页为双栏：左列先「官方云服务」沉浸云平台卡、后「自带 API Key 的服务商」`7 个`；右列连接配置随选中切换；沉浸云选中时右列标题为 `沉浸云账号` 且未登录显示 `登录沉浸云` 按钮。
4. 沉浸云平台卡未登录态显示 `未登录——选中后到右侧登录即可使用`；已登录显示 `已登录 {email}`；选中沉浸云时侧栏「接口已配置」点仅在已登录时亮。
5. 服务商列表七行（DeepSeek/智谱 GLM/通义千问/Kimi/OpenAI/Google Gemini/Ollama）各带品牌色徽标与 §1.2 品牌色；已存 Key 的行亮 keydot；Ollama 行带 `本地` chip 且 Key 字段显示 `本机无需 Key`。
6. 默认模型与候选与 §1.2 表一致：DeepSeek 默认 `deepseek-chat`、智谱 GLM 默认 `glm-4-flash`、OpenAI 默认 `gpt-4o-mini`；模型下拉含完整候选表。
7. 选中自带 Key 服务商时右列 caption 显示该家 hint，keyUrl 链接逐字 `↗ 前往 {displayName} 控制台获取 API Key` 并可点开。
8. 首次打开（无有效配置且未点过知道了）显示 `三步开始使用` 引导卡；点 `知道了` 后重启设置窗不再出现（UserDefaults 持久）。
9. 翻译页 seg 显示 `自动识别`/`固定目标语言`，auto 态 hint `中文 → English，其他语言 → 简体中文`；流式开关 label `流式输出`；自定义风格 placeholder 为 `例如：使用自然口语化的风格；保留专有名词不翻译`。
10. 快捷键页三行标题为 `翻译热键`/`截图 OCR 热键`/`阅读室热键`，各带 Windows 逐字 hint，含推荐组合 chips 可一键填入；冲突提示沿用新标题。
11. 术语表页有 `从剪贴板导入` 按钮且合并后提示 `已从剪贴板导入并合并`；统计卡显示 `N / 80 条已启用` + 进度条。
12. 账号页页头有 `账号` 19pt 标题 + 副标题 `登录是可选项——翻译、阅读室与复习全部本地可用`，且无重复副标题行。
13. 侧栏底部：双状态点文案逐字 + `v{version}`；保存条有 `关闭` 按钮；改动任意字段出现 `已自动保存` 闪现（Mac 语义，非 Windows「保存设置」）。
14. 生产 URL：`ServerAuthConfiguration.prodBaseURL == "https://www.prismspace.online"`，release 语义解析返回生产地址（测试注入验证）；域名连通性与 401/400/404 路由实测结论见 §1.10（已执行，全部符合）。
15. 登录窗（LoginWindowController 主视图）视觉零回归：暖橙 palette 各值不被波及（登录窗账号分区视图除外）。

---

## 四、平台必然差异清单（逐条理由）

1. **保存条无「保存设置」按钮与「有未保存的更改」橙点**：Mac 设置是 didSet 即时落盘（Settings.swift:1237-1244 REVIEW-01 注释），展示「未保存」是失实文案；保留「已自动保存」闪现 + `关闭`。Windows 显式双轨源于 localStorage 快照模型。
2. **快捷键页副标题不是「改完点立即生效或保存设置」**：同上，Mac 改完即重注册（`hotKeysDiffer` 闸门 Settings.swift:1098-1104/2329-2331），无「立即生效」按钮；保留现副标题。
3. **翻译页多「截图 OCR」卡（识别模式/识别语言）**：Windows 的 OCR 语言与模式固化在关于页模型管理里；Mac 用 Vision 框架（OCRReader.swift:3 `import Vision`）多语言可调，设置须有落点。保留。
4. **关于页无「离线能力 / PaddleOCR 下载模型」卡**：Mac OCR 走系统 Vision，无需下载 16MB 模型；该卡在 Mac 无对应功能，不照搬。副标题相应保持 `版本更新、启动与引导。`。
5. **沉浸云账号登录按钮放平台卡内部（右列账号块简化）**：Windows 右列 `连接配置` 卡与账号块是两个卡位；Mac 右列首卡已是账号语义卡（模型服务页配置列），登录入口合并避免双卡重复；「管理账号」跳转账号分区行为保留。
6. **账号页副标题为静态单句**：Mac pagehead 是枚举静态文案（SettingsSection.pageSubtitle），未随登录态切双态；已登录时 Windows 的 `账号信息与登录状态` 在 Mac 由页内资料卡承担，不复制双态切换逻辑（若实现方愿意，可在 AccountSectionView 里按 `serverAuth.status.loggedIn` 切 pageSubtitle，非硬性）。
7. **当前设备显示 `macOS · 本机`**：Windows 字面 `Windows · 本机`（AccountSection.tsx:255）是平台名；平台名必然不同，其余逐字。
8. **危险区确认弹窗 message 多「账号登录状态、翻译历史与生词数据不受影响」**（Settings.swift:1435）：Windows 只清接口配置（ConfirmDialog 1373）；Mac `resetToDefaults` 同时清自定义 provider 与密钥（SettingsDangerZoneTests 语义），说明后果更完整，是刻意的加严不改。
9. **API Key 字段标题双态 `API Key（云接口需要）/（本地接口可留空）`**：Windows 用 chip `本机无需 Key` 表达同信息（Settings.tsx:746）；Mac 现有双态标题 + §2.2 补 chip 后两者并存，保留 Mac 标题因 SecureField 无 chip 位。
10. **推荐组合键取 mac 化键位而非 Windows 五值**：`Ctrl+Shift+Q` 等在 macOS 与系统/输入法冲突率高且 Carbon 注册的 Ctrl 语义不同；Mac 已有录制器默认 `⌥Space`/`⌃⌥Space`/`⌃⌥R`（Settings.swift:4444-4453），推荐 chips 从默认键族派生，不逐字照抄。
11. **自定义 provider（添加/删除表单）为 Mac 保留项**：Windows 靠「高级：接口地址」直接改 endpoint 覆盖，无自定义 provider 实体；Mac ProviderProfile 支持多自定义档（Settings.swift:4364-4391），是既有能力，不删。
12. **字体/尺寸用 pt 近似 px 值**：Windows 网页 13px/11px 在 macOS 按 pt 落（Settings.swift:1514-1516 REVIEW-05 已把 10→11pt 抬到可读下限）；数值不逐像素对齐，以层级关系一致为准。
13. **设置窗无侧栏选中行 hover 底色的 accent-softer 变体**：macOS vibrancy 侧栏（Settings.swift:1556-1559）hover 由系统承担，不引入第三种底色。

---

## 附：域内已核实但本轮不改的观察

- 语音页 Mac 已对齐（VoiceGateway/VoiceSettingsTab.swift 445 行双栏 + GatewayVoiceSection.swift 文案逐字复核，含五态能力卡/额度行/一键测试/申诉卡），本轮仅随 §2.1 换品牌色，不动结构。
- 侧栏品牌徽记 Mac 用文字 `译`（Settings.swift:1484），Windows 用 IconTranslate 图标（Settings.tsx:533）；换 SF Symbol `character.book.closed` 可选，不设验收。
- Windows 内容列 `max-width:600px`，Mac 右列 `maxWidth: 720`（Settings.swift:1311）；Mac 双栏页需要更宽，保持 720。
