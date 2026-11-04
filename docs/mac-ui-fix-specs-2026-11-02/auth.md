# 登录与远程服务域规格：修复 Mac 登录「网络连接失败」——base_url 两层机制对齐 Windows

域：登录 / 远程服务（auth）。诊断日期 2026-11-03。
Windows 基准：`immersive-translator-windows/src-tauri/src/auth.rs`（本轮只读）。
Mac 落点：`immersive-translator-mac/Sources/ImmersiveTranslator/`（本轮只读，规格供施工）。

## 根因（一句话）

Mac `ServerAuthConfiguration.resolveBaseURL` 在无 `server_endpoint.json` 覆盖时**恒返回 dev 缺省**
`http://127.0.0.1:8090`（`ServerAuth.swift:123-134`），没有 Windows `resolve_base_url` 的「按构建类型取缺省」
分支（`auth.rs:220-228`）。结果：**正式 release 包**（`scripts/build_app.sh:93` 的 `swift build -c release`）
登录时连 `127.0.0.1:8090`，连接被拒 → 传输层抛本地伪码 `network_error`（`ServerAuth.swift:192`）→
错误表映射为「网络连接失败，请检查网络后重试」（`ServerAuth.swift:845`），即用户实测现象。
开发机装了覆盖文件的机器不受影响，所以日常联调从未暴露。

---

## 一、Windows 行为基准（逐项核实，含逐字文案与关键值）

### 1.1 base_url 两层机制（§4.6）

| 项 | 值 | 证据 |
|---|---|---|
| dev 缺省常量 | `DEV_BASE_URL = "http://127.0.0.1:8090"` | `auth.rs:150` |
| **生产缺省常量** | **`PROD_BASE_URL = "https://www.prismspace.online"`** | `auth.rs:153` |
| 公众开放开关 | `PLATFORM_PUBLIC: bool = true`（2026-10 服务端公开部署） | `auth.rs:155-159` |
| 第 1 层：覆盖文件 | `app_data_dir/server_endpoint.json`，形状 `{"baseUrl":"https://..."}`；存在且 baseUrl 非空（trim 后）则优先 | `auth.rs:169-186`（`EndpointOverride` 结构 + `endpoint_override`） |
| 开放判定 | `platform_available = PLATFORM_PUBLIC \|\| 本机 override 存在` | `auth.rs:190-192` |
| 第 2 层：缺省分支 | `endpoint_override(app).unwrap_or_else(\|\| if PLATFORM_PUBLIC && !cfg!(debug_assertions) { PROD } else { DEV })`——即：覆盖优先；无覆盖时 **debug 构建（tauri dev / cargo run）→ 本地联调，release 构建（tauri build / GitHub Releases 包）→ 生产域名** | `auth.rs:215-228`（`resolve_base_url`） |
| 构建类型判定 | `cfg!(debug_assertions)`（编译期常量） | `auth.rs:222` |
| 解析时机 | 进程启动构造 TokenManager 时一次（`ReqwestTransport::from_app` → `resolve_base_url`）；改覆盖文件需重启 | `auth.rs:209-213` |
| HTTP 客户端超时 | `reqwest::Client::builder().timeout(30s)` | `auth.rs:196-198` |
| gateway 派生 | `base_url + "/v1/chat/completions"`（`AuthTokenManager::gateway_endpoint`），以同一 base 为源 | `auth.rs:890-899` |
| 设置页暴露 | IPC `auth_server_base_url`：`platform_available().then(\|\| resolve_base_url(&app))`，未开放返回 None → 前端隐藏沉浸云入口（非敏感，只读） | `auth.rs:1130-1138`；`tauriBridge.ts:514-518` |

f08b56f（2026-10-27）提交说明逐字：「resolve_base_url 增加 cfg!(debug_assertions) 分支：tauri dev/cargo run
直连 127.0.0.1:8090 联调，tauri build（GitHub Releases 正式包）直连 www.prismspace.online；任何机器仍可用
server_endpoint.json 覆盖（内测机正式包指回本地）」——这就是 Mac 缺失的那次修复。

### 1.2 认证路由与错误分类（curl 实测的契约依据）

路由表（`auth.rs`）：`POST /v1/auth/refresh`(:531)、`POST /v1/auth/otp/request`(:695)、
`POST /v1/auth/otp/verify`(:718)、`POST /v1/auth/login`(:732)、`POST /v1/auth/logout`(:792)、
`GET /v1/me`(:844)、`GET /v1/me/config`(:855)、`POST /v1/events`(:881)。
401 分类（红线 4）：仅 `token_expired` 触发单飞刷新重放一次；`token_invalid` / `token_reused` /
`unauthorized` 清凭据绝不再刷（`auth.rs:9-12`、`415-425`、`653-685`）；`retry-after` 头透传为
`retry_after_seconds`（`auth.rs:257-261`）。错误信封形状 `{"error":{"code":"...","message":"..."}}`。

### 1.3 登录 UI 基准（Windows 逐字，供 Mac 对照确认零改动）

- 两页签：**「验证码登录」「密码登录」**（`LoginView.tsx:351/359`；tab 类型 `"otp" | "password"`，
  view 四态 `email/code/password/success`，`LoginView.tsx:24-26`）。
- 选中页签样式：`background: var(--surface); color: var(--text-1); font-weight: 600;
  box-shadow: var(--shadow-card)`（`styles.css:2488-2493`）；容器 `padding:3px; gap:3px;
  border-radius: var(--radius-md)`（`styles.css:2464-2470`）。
- 密码页提示逐字：「从未设置过密码的账号，请改用验证码登录」（`LoginView.tsx:491`）、
  「忘记密码？可在验证码登录后随时设置密码（后续迭代）」（`LoginView.tsx:504`）。
- 错误文案（`authErrorText.ts`）：`network_error` → **「网络连接失败，请检查网络后重试」**（:57，inline）；
  `invalid_credentials` → 「邮箱或密码不正确；若从未设置密码，请改用验证码登录」(:38)。
- 菜单项全列表：**本域不适用**——auth 无托盘/菜单结构，Windows 与 Mac 的登录均走窗口页签
  （Mac `LoginWindowController.swift:326-359` tabs、:17 按压动画 spring response 0.3 / damping 1.0）。

---

## 二、Mac 落点设计（施工单）

### 2.1 改 `ServerAuth.swift`（唯一必改文件）

**落点 A：`ServerAuthConfiguration`（:108-135）。** 对齐 Windows `resolve_base_url`（`auth.rs:220-228`）：

1. 新增生产常量（镜像 `auth.rs:153` 的值）：
   ```swift
   /// 生产服务 base（登录/鉴权同源；gateway = base + /v1/chat/completions）。
   /// 镜像 Windows auth.rs:153 PROD_BASE_URL。
   static let prodBaseURL = "https://www.prismspace.online"
   ```
2. 新增公众开关（镜像 `auth.rs:159`，保持表达式同构以继承「未开放期回退本地」语义）：
   ```swift
   /// 沉浸云对公众开放（服务端已公开部署，2026-10）。镜像 Windows auth.rs:159。
   static let platformPublic = true
   ```
3. 新增编译期构建类型常量 + 缺省函数（可测）：
   ```swift
   /// 编译期常量，等价 Windows cfg!(debug_assertions)（auth.rs:222）。
   /// SwiftPM debug 配置（swift run / swift build / swift test）为 true；
   /// release（scripts/build_app.sh:93 `swift build -c release`）为 false。
   static let isDebugBuild: Bool = {
       #if DEBUG
       return true
       #else
       return false
       #endif
   }()

   /// 缺省 base：公众开放期 debug→本地联调、release→生产（对齐 auth.rs:221-227）。
   static func defaultBaseURL(isDebugBuild: Bool) -> String {
       (platformPublic && !isDebugBuild) ? prodBaseURL : devBaseURL
   }
   ```
4. 改 `resolveBaseURL(:123-134)` 的最后一行兜底：`return devBaseURL` →
   `return defaultBaseURL(isDebugBuild: isDebugBuild)`。覆盖优先逻辑（:126-131）与
   trim/空串/坏 JSON 容错（:126-132）不动。

`#if DEBUG` 可行性已实证：临时 SwiftPM 包 `swift run`（debug）输出 `DEBUG-DEFINED`、
`swift run -c release` 输出 `DEBUG-NOT-DEFINED`（2026-11-03 本机执行）。Mac 源码当前无任何
`#if DEBUG` 使用（grep 为空），本常量为首例，不影响既有编译。

**落点 B：无需改。** 传输层构造（`URLSessionAuthTransport(baseURL:)` 于 `ServerAuth.swift:1008`）、
语音网关源 `VoiceHttp.swift:55-57,79`、发现页源 `DiscoverService.swift:55,93` 全部以
`resolveBaseURL()` 为源，缺省值一变全链生效。既有 30s 请求超时（`ServerAuth.swift:145`）与
Windows 30s（`auth.rs:197`）已一致，不动；60s resource 超时（:146）保留（见差异 5）。

**不动清单（防施工越界）：** 错误表 `authErrorTextTable`（:832-849）、`authErrorText` 归一化
（:853-869）、OTP 60s 冷却（:887-977）、单飞刷新与 401 红线（:420-712，模块头 ：8-16 已对齐
Windows 红线 1-5）、`LoginWindowController.swift` 全文件（报错路径 `applyAuthError` :628-641、
`handleSendOtp` :644-671、`handleVerify` :691-720、页签 :326-359 文案已与 Windows 逐字一致）。

### 2.2 改测试 `Tests/ImmersiveTranslatorTests/ServerAuthTests.swift`

既有 `ServerAuthConfigurationTests`（:774-808）在 `swift test`（debug 配置）下断言
`resolveBaseURL == devBaseURL`——修复后 debug 缺省仍是 `devBaseURL`，**既有断言全部保持通过，不改**。
在该类内新增（构造临时目录法抄 ：776-779）：

1. `testDefaultBaseURLFollowsBuildKind`：`defaultBaseURL(isDebugBuild: true) == devBaseURL`；
   `defaultBaseURL(isDebugBuild: false) == "https://www.prismspace.online"`（值锁死，防手滑改常量）。
2. `testPlatformPublicMatchesWindows`：`platformPublic == true`（对齐 `auth.rs:159` 当前值）。
3. `testResolveBaseURLFallsBackToBuildDefault`：空临时目录无覆盖 →
   `resolveBaseURL(appSupportDirectory:) == defaultBaseURL(isDebugBuild: isDebugBuild)`
   （一致性断言，不绑死当前运行配置；debug 测试运行下即 devBaseURL，与既有 ：782 断言互证）。
4. `testProdBaseURLShape`：`prodBaseURL.hasPrefix("https://")` 且不以 `"/"` 结尾
   （`URLSessionAuthTransport.init` :143 会 trim 尾斜杠、网关派生按 `{base}/v1/chat/completions`
   拼接，双保险防覆盖文件外的常量坏形状）。
5. release 分支无法在 `swift test`（debug）内单测——由验收 3 的 release 编译 + 上述常量值测试覆盖。

### 2.3 新建资产

无新建文件、无资产、无 UI 改动。规格即本文件。

---

## 三、逐条验收清单

1. **生产端点连通**（2026-11-03 实测已通过，命令与结果如下，施工后无需重跑）：
   - `curl -sS -o /dev/null -w '%{http_code}' https://www.prismspace.online/` → `404`，
     body `{"error":{"code":"not_found","message":"Cannot GET /"}}`——域名可达（~0.7s）、错误信封形状正确。
   - `curl -sS https://www.prismspace.online/v1/me` → `401`，
     body `{"error":{"code":"unauthorized","message":"缺少访问令牌"}}`——路由存在、鉴权按契约。
   - `curl -sS -X POST -H 'content-type: application/json' -d '{"email":"not-an-email"}'
     https://www.prismspace.online/v1/auth/otp/request` → `400`，
     body `{"error":{"code":"validation_error","message":"请求参数不合法",
     "details":[{"path":"email","message":"Invalid email"}]}}`——校验层拒绝，**未发送任何 OTP 邮件**。
   - `curl -sS -X POST -H 'content-type: application/json' -d '{"email":"not-an-email","password":""}'
     https://www.prismspace.online/v1/auth/login` → `400` `validation_error`，details 含
     email/password/device 三条（zod 校验齐全）。
   - `curl -sS https://www.prismspace.online/v1/auth/otp/request`（错误方法）→ `404`
     `Cannot GET /v1/auth/otp/request`——**实测是 404 而非 405**：服务端按方法注册路由，方法不匹配落
     404 处理器（Express 式），路由正确性同样得证，如实记录。
   - `curl -sS -X POST -H 'content-type: application/json' -d '{}' https://www.prismspace.online/v1/auth/__nope__`
     → `404` `Cannot POST /v1/auth/__nope__`。
   - `curl -sS -X POST -H 'content-type: application/json' -d '{}' https://www.prismspace.online/v1/chat/completions`
     → `401` `unauthorized`——gateway 别名路由存在且要求鉴权（与 `auth.rs:894` 派生式吻合）。
   - 全程只用 `not-an-email` 假地址，**未发送真实邮件、未创建账号**。
2. `cd immersive-translator-mac && swift test`（scripts/run_swift_tests.sh 同口径）全绿，
   既有 `ServerAuthConfigurationTests` 四条断言（:782/:790/:796/:803）不改仍过。
3. 新增 4 条测试（2.2 清单）全绿；`prodBaseURL` 值断言等于 `https://www.prismspace.online`。
4. `cd immersive-translator-mac && swift build -c release` 编译通过（release 分支语法进编译）。
5. 真机验收：无 `~/Library/Application Support/ImmersiveTranslator/server_endpoint.json` 的机器上，
   release 包登录窗输入邮箱点「获取验证码」不再出「网络连接失败，请检查网络后重试」红条
   （`LoginWindowController.swift:665` 路径），改为正常进入验证码页或返回服务端业务错误。
6. 覆盖文件仍然优先：放置 `{"baseUrl":"http://127.0.0.1:8090"}` 的 release 包仍连本地联调（内测机语义，
   对齐 f08b56f 提交说明）。
7. 文案零回归：登录窗页签、错误红条文案与 1.3 基准逐字一致（本轮已核，施工不改任何文案文件）。
8. `swift run`（debug）联调行为不变：仍直连 `127.0.0.1:8090`。

---

## 四、平台必然差异清单（逐条理由）

1. **Mac 无「官方云未开放」null 态**：Windows `auth_server_base_url` 未开放返回 None、前端隐藏入口
   （`auth.rs:1130-1138`）；Mac `resolveBaseURL` 恒有值，设置页/语音页已按双态文案差异实现
   （`Settings.swift:1027-1031`、`VoiceSettingsTab.swift:12,30` 明文标注「Mac 无 null 态」）。
   本轮不移植：`PLATFORM_PUBLIC=true` 时 Windows 门控休眠，移植需改语音设置页状态机，超本域范围。
2. **覆盖文件路径不同**：Windows `app_data_dir/server_endpoint.json`（`auth.rs:177`）；Mac
   `~/Library/Application Support/ImmersiveTranslator/server_endpoint.json`（`ServerAuth.swift:116-120`）。
   机制同构，路径随平台惯例，不可也不必统一。
3. **构建类型判定机制不同**：Windows `cfg!(debug_assertions)`（`auth.rs:222`）；Mac SwiftPM `#if DEBUG`
   （已实证 debug 定义/release 不定义）。语义等价，编译期常量，均需重新打包才生效。
4. **传输栈不同**：reqwest（`auth.rs:196-198`，单一 30s timeout）vs URLSession ephemeral
   （`ServerAuth.swift:144-147`，请求 30s + 资源 60s 两级）。Mac 多一级 resource 上限是 URLSession
   结构差异，30s 关键值已对齐，不必抹平。
5. **gateway 派生点不同**：Windows 在 `AuthTokenManager::gateway_endpoint`（`auth.rs:894-899`）；
   Mac 在 `VoiceHttp.baseUrlSource`（`VoiceHttp.swift:55-57`）。同以 base_url 为源，修复自动继承，
   派生位置保持各自架构。
6. **设置页读取路径不同**：Windows 经 IPC `auth_server_base_url`（`tauriBridge.ts:516`）；Mac 直接调
   `resolveBaseURL`（`Settings.swift:1027` 语境）。Rust/JS 进程边界 vs 同进程直接调用，架构差异。
7. **token 存储不同**：Windows DPAPI（`auth.rs:8`）vs Mac Keychain（`ServerAuth.swift:9,224-240`）。
   已各自按红线 1 落地，与本域修复无关。
8. **错误方法状态码语义**：Windows 契约文档预期 404/405，实测生产端点方法不匹配返回 404（验收 1
   第 5 条）。这是服务端行为，两端客户端一致承受，非客户端差异；Mac 不做任何特殊处理。

## 附：本规格证据执行记录

- 读：`auth.rs:1-280,885-905,1128-1140,1880-1935`；`ServerAuth.swift:1-240,820-919,960-1029`；
  `LoginWindowController.swift:326-359,645-724`；`ServerAuthTests.swift:770-864`；`LoginView.tsx`
  锚点行；`authErrorText.ts` 锚点行；`styles.css:2464-2493`；`tauriBridge.ts:495-539`；
  `build_app.sh:93`；`git show f08b56f`。
- 跑：§三.1 的 7 条 curl（2026-11-03）；SwiftPM `#if DEBUG` 双配置实证（临时包 swift run 双跑）。
- 未跑（施工方跑）：`swift test`、`swift build -c release`、release 包真机登录（验收 2-5、8）。
