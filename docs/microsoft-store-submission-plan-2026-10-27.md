# 微软商店上架规划（沉浸口语 Windows 端）

日期：2026-10-27
状态：**通道切换决定（2026-10-27 晚）**——发现当前产品类型误建为「EXE 或 MSI 应用」（URL 外链通道，政策 10.2.9 要求付费 CA 签名）。新后台实际分四类产品：MSIX 或 PWA 应用（微软托管+代签，免费）/ EXE 或 MSI 应用（URL 外链，需自带签名）/ GDK 游戏 / MSIX 或 PWA 游戏。

**决定：删除现有产品，重建为「MSIX 或 PWA 应用」**，走微软免费代签通道：
- 无需购买 Certum/任何代码签名证书（€49 方案作废，仅当 MSIX 路线受阻再启用）
- 无需 SignPath Foundation 申请
- CI 签名改造（sign.ps1/release.yml）保留但不再阻塞商店——GitHub 直发包的 SmartScreen 优化，随时可做
- 新代价：① 需自行产出 MSIX 包；② 商店版须禁用 Tauri 自更新（MSIX 容器只读，更新由商店接管）；③ 删除产品后已填的可用性/属性/年龄分级全部作废，需重填（内容已有记录，可快速重做）
- 重填时顺带补强：应用内需提供隐私政策入口；认证说明准备免短信验证、已开通订阅权限的测试账号

### MSIX 打包方案（2026-10-27 定稿，官方 winapp CLI 路线）

新产品信息：产品 ID `9N6PHF9PML82`，提交草稿 `1152921505702241838`。已填完：定价可用性（CNY 免费锚点）、属性全套、认证说明（在「其他测试信息」页）。待办：年龄分级（用户）、程序包（MSIX）、Store 一览（素材）。

官方依据：Microsoft Learn《Using winapp CLI with Tauri》（2026-10 更新，附官方示例仓库 microsoft/WinAppCli samples/tauri-app）。文档明示："The Microsoft Store will sign the MSIX for you, no need to sign before submission."

打包流程（CI 化目标）：
1. `winget install microsoft.winappcli`（CI runner 可用 winget）
2. `winapp init` 生成 `Package.appxmanifest` + Assets；manifest 的 Identity Name/Publisher 必须与 Partner Center「产品标识」页一致（待抄录）；Tauri Win32 应用需 `runFullTrust` capability
3. 构建：`tauri build --no-bundle`（跳过 NSIS），把 `target/release/` 的 exe + 资源（models/*.onnx、DirectML.dll.payload 等 bundle.resources）staging 到 dist/
4. `winapp pack .\dist`（本地调试用 `winapp cert generate` 自签；**商店提交无需签名**）
5. 上传 .msix 到提交的「程序包」页

配套改动：
- 商店构建专用配置（参照 tauri 官方 `tauri.microsoftstore.conf.json` 模式）：`createUpdaterArtifacts: false` + 去掉 updater endpoints；进阶方案：运行时用 `Package.Current()` 检测包身份、有身份则跳过自更新（winapp 指南同款 API）
- 资源加载验证：确认 models/DirectML 在 MSIX 布局下相对 exe 的路径与 NSIS 安装一致

参考：
- 官方指南 https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/tauri
- 官方示例 https://github.com/microsoft/WinAppCli/tree/main/samples/tauri-app
- MakeAppx（winapp pack 的底层）https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool
- 注意：Tauri v2 官网 distribute/microsoft-store 页面写的仍是旧通道（EXE/MSI + URL 外链 + 自签名），**不要按它建产品**

以下为原方案存档（基于误选的 EXE/MSI 通道，签名要求等内容对通道理解仍有效）：

---

---

## 一、当前进度

| 提交环节 | 状态 | 备注 |
|---|---|---|
| 产品创建 | ✅ 完成 | 曾误建为「游戏」，已删除重建为「应用」 |
| 可用性 | ✅ 完成 | 240 市场、公开可见、免费 |
| 属性 | ✅ 完成 | 教育+工具；隐私政策为文本模式（待换成 URL）；勾选生成式 AI；系统要求已填 |
| 年龄分级 | ✅ 完成 | 用户手动填写 |
| 包 | ⛔ 阻塞 | 需要满足政策 10.2.9 的签名安装包 + 版本化 URL |
| Store 一览 | ⬜ 未开始 | 截图/描述/隐私 URL，不依赖签名，可并行 |
| Package validation | ⬜ 未开始 | 填包后运行 |

提交渠道为政策 10.2.9（HTTPS 直链安装包，微软代为打包分发）：
- 安装包及全部 PE 文件必须由「微软信任根计划内 CA 签发」的代码签名证书签名；
- URL 必须版本化（每个版本一个固定 URL，二进制提交后不得变更）；
- 必须支持静默安装（NSIS `/S`，允许 UAC 弹窗）；
- 必须是独立安装包（非下载器），仅限 PC。

## 二、签名路线：SignPath Foundation（免费，首选）

仓库满足核心条件：AGPL-3.0（OSI 认可）、公开、活跃、Windows 客户端源码在仓库内。
基金会验证方式 = 核实「二进制构建自公开仓库」，与我们 GitHub Actions 发版流程契合。

### 需要注意的条款边界

- 禁止商业双许可：客户端必须**只**按 AGPL 发布。收登录订阅费（服务费）不违反；将来若客户端转闭源/双许可，必须更换证书。
- 捆绑的第三方运行库（DirectML.dll、ONNX Runtime）在申请表中如实说明。
- 证书链：基金会证书由 Certum 签发（信任根计划成员）。申请通过后向基金会索取证书链信息，写入 Partner Center 认证说明备查。

### 申请材料（英文草稿，粘贴到 signpath.org/apply）

> **Project name:** Immersive Translator (Windows desktop client: 沉浸口语)
> **Repository:** https://github.com/kobejiasuoer/immersive-translator
> **License:** GNU Affero General Public License v3.0 (AGPL-3.0), no commercial dual-licensing.
> **Description:** Immersive Translator is an open-source language-learning suite (immersive translation, speaking practice, and immersive reading). The Windows client "沉浸口语" is a Tauri-based Win32 application distributed exclusively as open-source builds via GitHub Releases.
> **Release process:** Every release is tagged (vX.Y.Z) and built by the public GitHub Actions workflow `.github/workflows/release.yml` from the tagged commit; artifacts (NSIS installer + main executable) are published to GitHub Releases at https://github.com/kobejiasuoer/immersive-translator/releases. We request signing of these two PE files (installer + main exe) produced by this workflow.
> **Signing policy (to be published on the project home page):** Only version-tagged CI builds from the main repository are eligible for signing; a single designated approver releases each signing request; no local/developer builds are signed.
> **Bundled third-party components:** Microsoft DirectML runtime and ONNX Runtime (MIT) are redistributed inside the installer. All project-owned code is AGPL-3.0 and published in the repository.
> **Note:** We intend to submit the signed installer to the Microsoft Store (policy 10.2.9). Please confirm the certificate chain (issuing CA within the Microsoft Trusted Root Program) for our certification notes.

### 证书主线（2026-10-27 决定）：Certum 开源开发者证书

SignPath Foundation 因项目声誉证据不足（GitHub star/下载量/社区几乎为零，且 "Immersive Translator" 与知名扩展撞名易误判）转为可选尝试，**主线改为直接购买 Certum**：

- **产品：Open Source Code Signing in the Cloud（SimplySign）— €49/年（约 ¥380）**
  https://shop.certum.eu/open-source-code-signing-on-simplysign.html
- SimplySign 云端签名，无需实体卡和读卡器（实体卡套装 €69；对比：标准 OV 云端 €209、EV €379——€49 是最低档）
- Certum 在微软信任根计划内，满足商店政策 10.2.9
- 购买条件：身份验证（证件）+ 开源项目证明（GitHub 仓库 + AGPL 许可证，满足）
- CI 接入注意：SimplySign 是云端虚拟签名设备，需在登录 SimplySign 客户端的机器上签名（虚拟证书进 Windows 证书库后 `signtool` 按指纹调用）。CI 集成偏脆弱，务实方案：发版时本地跑签名步骤（半自动），后续再评估 CI 化。`sign.ps1` 的 pfx 分支届时改为按证书指纹调 `signtool`。

项目更名决定：对外英文名采用 **Immersive Speaking**（实测无撞名）。改名分层：仓库名 `immersive-translator` → `immersive-speaking`（GitHub 自动重定向旧链接，改名后需同步 updater endpoints 与 README/CI 引用）、Store 英文名 Immersive Speaking；**不动** Tauri identifier（`com.immersivetranslator.windows`，动了用户本地数据全丢）、cargo/exe 名、安装包资产名前缀。

### 回退方案（若 Certum 购买受阻）

- SignPath Foundation 免费证书（见上节申请材料；声誉弱，作低概率尝试）
- SSL.com eSigner 等云端签名 CA（更贵但 CI API 完善，约 $130+/年）

### 申请表逐字段对照（signpath.org/apply，HubSpot 表单，2026-10-27 实测）

提交前必须先就位的两项（表单字段明确要求）：

1. **Download URL 页面必须提及使用 SignPath Foundation 做代码签名** → 在 README 的下载小节（或 Releases 说明）加一句 "Windows installers are code-signed with the SignPath Foundation certificate."，申请时 Download URL 填 README 或 Releases 页。
2. **Privacy Policy URL**（软件收集数据则必需——我们收集麦克风/文本）→ 需要把已写好的隐私政策托管出 URL（与商店属性页换 URL 是同一件事，一并完成）。

逐字段：

| 表单字段 | 填写内容 |
|---|---|
| Project Name* | `Immersive Translator`（Google 搜索需能明确识别项目） |
| Repository URL* | `https://github.com/kobejiasuoer/immersive-translator` |
| Homepage URL* | 官网或仓库页（与 Homepage 一致即可） |
| Download URL | Releases 页或 README 下载节（须含上述 SignPath 声明） |
| Privacy Policy URL | 托管后的隐私政策 URL |
| Wikipedia URL | 留空 |
| Tagline* | `Open-source language-learning suite: immersive translation, speaking practice, and immersive reading.` |
| Category* | 打开后选最接近「Developer Tools / Utilities」的一项 |
| Description* | 见下方英文段 |
| Reputation* | 沉浸式翻译生态的证据：浏览器扩展用户量/商店链接、媒体报道、社区讨论——**需要你提供真实数字和链接** |
| Maintainer Type | 打开后选「Individual / Community」类 |
| Build System* | 选「GitHub Actions」 |
| First/Last Name*, Email* | 你的真名和邮箱（同时是 SignPath 账号） |
| Company Name | 可留空 |
| Primary Discovery Channel* | 如实选（如 Search engine / AI assistant） |
| 复选框 | 勾 Code of Conduct 同意项；营销邮件可拒绝；最后有 reCAPTCHA 人机验证 |

Description* 英文段：

> Immersive Translator is an open-source language-learning suite covering immersive bilingual translation, AI-assisted speaking practice, and an immersive reading room. The Windows desktop client is a Tauri-based Win32 application; all clients are developed in the public repository and released as open-source builds (AGPL-3.0) via GitHub Releases.

注意：Reputation 是必填且是本项目最弱项（GitHub star 数极少）。建议申请前先做一轮仓库门面：完善 README（英文截图、下载徽章、构建说明），并把扩展侧的用户量证据链接收集齐。

## 三、CI 签名改造方案 ✅ 已实现（2026-10-27）

现状：`scripts/sign.ps1` 本地自签（pfx 在 `signing/`，**password.txt 已被 git 跟踪，pfx 未入库**——换正式证书时两者都改为 GitHub Secrets，不再进仓库）。

已落地（本地开发体验不变，CI 按 env 自动分支）：

- `scripts/sign.ps1`：新增 SignPath 分支（`SIGNPATH_API_TOKEN` 存在时启用）——校验四个环境变量 → 按需安装 SignPath PowerShell 模块 → `Submit-SigningRequest -WaitForCompletion -Force` 原地覆盖签名产物。已验证：无 env 时正确回退本地 pfx 路径；缺配套变量时报出精确错误。
- `.github/workflows/release.yml`（windows job）：
  - job env 注入 `SIGNPATH_API_TOKEN`/`SIGNPATH_ORGANIZATION_ID`（secrets）与 `SIGNPATH_PROJECT_SLUG`/`SIGNPATH_SIGNING_POLICY_SLUG`（vars，默认 `immersive-translator` / `release-signing`）；
  - 新增「Ensure SignPath module」步骤（仅 token 存在时运行）；
  - 新增「Verify Authenticode signature」步骤：安装包无签名时硬失败，链校验异常仅警告（CI 常见于中间证书拉取超时，商店侧会做完整校验）。

**待基金会开通后**：在仓库 secrets 填 `SIGNPATH_API_TOKEN`/`SIGNPATH_ORGANIZATION_ID`，vars 确认两个 slug 与 SignPath 项目配置一致，打 tag 跑一次 v0.10.4 验证全链路。

要求（基金会条款）：团队成员启用 MFA；在项目主页发布签名政策；定义 Authors/Reviewers/Approvers 角色。

## 四、Store 一览清单（与签名并行，无阻塞）

- [ ] 隐私政策正式页：现用文本模式，需在官网/GitHub Pages 托管后换 URL（内容以已提交文本为准）
- [ ] 详细联系信息：支持邮箱（必补，商店公开展示）
- [ ] 截图：建议 5-10 张（口语练习、翻译悬浮窗、阅读室、设置），1366x768 以上
- [ ] 应用描述：简中+英文，开头披露生成式 AI 功能（政策 11.16 要求 metadata 披露）
- [ ] 声明第三方购买 API：提交时的表单勾选「使用安全第三方购买 API」（订阅走自有支付，10.8.1/10.8.2）

## 五、发版联动（v0.10.4 起，每次发版固定动作）

1. tag `vX.Y.Z` → CI 构建 + SignPath 签名 → 发布 GitHub Release（URL 天然版本化：
   `https://github.com/kobejiasuoer/immersive-translator/releases/download/vX.Y.Z/ImmersiveTranslator_X.Y.Z_x64-setup.exe`）
2. Partner Center → 包 → 新提交：
   - 包 URL：上面的 Release 资产直链
   - 体系结构：x64；应用类型：EXE；安装参数：`/S`；语言：简体中文 + 英文
   - 保存 → 运行「软件包验证」→ 通过后提交审核
3. 商店与应用内更新器并行：无需禁用 Tauri updater（10.2.9 流程为普通 Win32 安装，政策仅限制游戏 10.2.5）。注意商店提交尽量与 GitHub 发版同步，减少版本漂移。

## 六、合规备忘

- **11.16 生成式 AI**：metadata 披露 ✓（属性已勾选 + 描述中写明）；需提供用户举报不当 AI 内容的渠道（应用内反馈入口）。
- **AGPL §13**：server 端如为 AGPL 衍生且对外提供服务，源码需公开（server 仓库本来开源即可）。
- **10.5.1 隐私政策**：必须覆盖麦克风音频、文本发送第三方 AI、OCR 截图、本地存储、账号订阅（已提交文本已覆盖）。
- **10.2.9**：提交后该 URL 的二进制不可变更——重签/换包必须走新版本号新 URL。
- **10.7 本地化**：声明的语言需有对应本地化描述。

## 七、时间线（预估）

| 周 | 事项 |
|---|---|
| 第 1 周 | 提交 SignPath 申请；并行完成 Store 一览、隐私政策托管页、CI 签名改造（写好等 token） |
| 第 2 周 | 基金会审核（数天~两周）；补齐联系邮箱 |
| 第 3 周 | 通过后接 SignPath → 出 v0.10.4 签名构建 → 填包 + 软件包验证 |
| 第 4 周 | 提交审核（通常 1–3 天，长则一周）→ 上架 |

回退路径：SignPath 被拒 → 直接买 Certum（¥200 量级/年），第 3 周起流程相同。
