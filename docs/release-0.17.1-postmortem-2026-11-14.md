# v0.17.1 发版复盘（2026-11-14）

> 本次发版从「提交推送 → CI 出包 → GitHub Release → 商店提交」全程打通，但 CI 连续 9 轮失败后定位出三个独立问题，均为历史遗留或环境时变，与本次功能代码（首启竞态修复）无关。本文固化根因、修复与免登录排查手法，供后续发版照抄。

## 0. 结果速览

| 通道 | 结果 |
|---|---|
| GitHub Release v0.17.1 | ✅ 已发布，四件套齐（exe / .sig / latest.json；msix 本地补打直传商店） |
| 应用内更新链路 | ✅ `releases/latest/download/latest.json` 返回 0.17.1，signature 非空 |
| 微软商店 Submission 2 | ✅ 0.17.1 MSIX 已提交认证（0.15.3 时代首次上架后第一个更新） |
| CI workflow | ⚠️ Windows/前端全绿；macOS regression checks 仍红（独立遗留，见 §5） |

## 1. 问题一：ort-sys 落盘 DirectML.dll 被安全软件拦截（主犯）

**现象**：Windows 上 cargo 编译必挂 `exit code 101`（panic），无 Release 产物；本机同样挂（`os error 5 拒绝访问`）。

**根因**：`ort-sys 2.0.0-rc.10` build.rs 的 `copy_libraries`（第 126 行 `fs::copy(...).unwrap()`）把下载的 onnxruntime 包里唯一的 DLL（`DirectML.dll`，与仓库 `src-tauri/DirectML.dll.payload` 逐字节一致，sha256 `9c9e6d82…`）拷到 `target/<profile>/{,deps,examples}/`。该写入被拦截：

- **本机**：360 主动防御/Kaspersky 对 cargo 子进程落盘该 DLL 定向拦截（`scripts/restore-directml.ps1` 注释早有记载）；
- **GitHub runner**：2026-11 初 runner 镜像更新后同样拦截（无杀软特征，行为等同）。

**为什么以前没炸**：`copy_libraries` 有 `if !out_path.exists()` 跳过——release.yml 的 rust-cache 恢复的旧 target 树里已有 DirectML.dll 副本，命中即跳过。**rustc stable 升级（1.99.0→1.99.1）使 rust-cache key 变化 → 缓存全空 → 拷贝路径首次真实执行 → 炸**。ci.yml 无缓存，从 v0.16.0（eb67587，11-08 镜像窗口）起每轮都炸（当时只看 Release 绿、没人看 CI）。

**修复（c0c1122）**：釜底抽薪——关闭 `copy-dylibs` feature：

```toml
ort = { version = "2.0.0-rc.10", default-features = false, features = ["download-binaries", "std", "ndarray", "tracing"] }
paddle-ocr-rs = { version = "0.6", default-features = false, features = ["download-binaries"] }
```

`copy-dylibs` 来自 paddle-ocr-rs 的 default（其 default = download-binaries + copy-dylibs + ort/default），关掉后整段拷贝不编译。DirectML.dll 的实际分发不依赖它：测试期由 `scripts/restore-directml.ps1` 预置（CI 已加此步骤，见 release.yml/ci.yml「Work around blocked DLL writes」），运行期由 bundle.resources 的 payload + 首启解包提供。**feature 变化不写 Cargo.lock，`--locked` 兼容**。

**修复后必须做**（AGENTS.md 硬性约束）：PE 导入表核对。实测 0.17.1 exe 导入表含 `DirectML.dll`（delay-load，0.15.3 同布局在架可跑）+ VC 四件套，包内文件齐全 → PASS。

## 2. 问题二：rustfmt 遗留（v0.16.0 起 CI 红灯的一半）

`reader_store.rs` / `translation.rs` 在 33616ad（v0.17.0）引入不合 rustfmt 的行，`Check formatting` 自 eb67587 起失败——Release 不跑 fmt 所以发版无感。**教训：push main 后瞄一眼 CI 再走发版**。修复即 `cargo fmt --all`（7512206）。

## 3. 问题三：tag 重推产生 draft Release 遗留 → 上传步骤 404

**现象**：NSIS 构建成功后「Upload installer and release notes」挂 `exit 1`。

**根因链**：排查期间多次删 tag 重推 → **GitHub 在 tag 被删时把对应非 draft Release 自动转为 draft** → 上传步骤里 `gh api repos/…/releases/tags/vX.Y.Z`（清残留段）对 draft 返回 **404** → `set -e` 中断。

**修复**：
- 清残留段加 `2>/dev/null … || true` 容错（1c0c9a1）；
- windows job 末尾新增 publish 步骤：资产齐后 `gh release edit "$RELEASE_TAG" --draft=false --latest`（51bd492），消除 draft 遗留并保证 updater 的 latest 端点指向新版本。

## 4. 免登录排查手法（无 gh / 无 token / API 限流时）

本轮验证有效的通道，按优先级：

1. **公开 API**：`actions/runs/{id}/jobs`（步骤结论+耗时）、`check-runs/{job_id}/annotations`（匿名可读）、`releases` 列表（**draft 匿名不可见**——Release「消失」先想 draft）。
2. **annotation 侧信道**：步骤里 `echo "::error::$(tail -c N build.log | tr '\r' ' ' | awk 1 ORS='|')"` 把日志尾部打进 annotation，免登录可见。两个坑：`::error::` 必须**行首**（缩进会静默失效，用 sed/printf 保证）；grep 要 `-i`（tauri CLI 错误是大写 `Error`）。
3. **网页兜底**：API 限流时用浏览器开 run 页（annotations/步骤结论/图标颜色匿名可见，日志正文需登录）。
4. **artifacts / Release 资产**：下载都要认证，别指望。

## 5. 遗留事项

- [ ] **macOS regression checks 自 v0.16.0 起失败**（`immersive-relator-mac/scripts/check_*.sh` 某个 Swift harness，与 Windows 无关、不阻塞 Release——mac 构建发布 job 一直绿）。下次带 dump 诊断定位。
- [ ] Release 资产里的 `nsis-build.log` 为诊断残留（几 KB），下个版本可顺手在成功路径删除。
- [ ] 本机 cargo 的 tauri-build `copy_resources`（VC 四件套进 target 树）同样被杀软拦（`os error 5`），本机全量构建前需预置或信任 target 目录；CI 不受影响（tauri-build 在 runner 上工作正常）。
- [ ] `restore-directml.ps1` 可考虑加 VC 四件套预置 + triple 目录（`target/x86_64-pc-windows-msvc/release/…`），覆盖 `--target` 构建场景。

## 6. 商店提交自动化实录（本次新增经验）

Partner Center 提交页大量 he-* 自定义元素（shadow DOM），Playwright 常规 locator 点不到，实测有效的手法：

- 概览页「开始更新」/「提交进行认证」：`evaluate` 里递归穿 shadowRoot 找 `he-button`，取 `shadowRoot.querySelector('button')` 点原生按钮；
- 六个提交易区（定价/属性/年龄分级/包/Store 一览/提交选项）：`.accordion-body-list-item` 内的 `<a>` 可直接点进入对应编辑页；
- **MSIX 上传**（IAB 无 filechooser）：读本地文件 → **256KB 分块 base64 嵌入 evaluate 代码**（约 350KB/次，MCP 消息上限内；1MB 会超）→ 页面端**逐块 atob 重组**（⚠️ 不能 join 后整体 atob：每块独立 base64 尾部有 `=` padding，拼接即损坏）→ `new File` + `DataTransfer` → 赋 `input.files` + dispatch `change`（runbook §6 手法对包上传同样有效）；
- listing 的「此版本的新增功能」：textarea 按 DOM 序 = [说明, 新增功能, …]；用 `HTMLTextAreaElement.prototype` 的 value setter + `input` 事件写入（Angular 受控），**必须点显式「保存」按钮**（该页无自动保存，跳转即丢）；
- 语言 listing 直链：中文 `languageid=5&languagecode=zh-cn`，英语 `languageid=4&languagecode=en-us`。

## 7. 发版时间线（供对照）

| 轮次 | tag 指向 | 结果 | 定位 |
|---|---|---|---|
| 1-2 | 776aa66 | NSIS ~285s 挂 | 误判方向（以为瞬态/编译错误） |
| 3 | 7512206 | 挂 | fmt 修复无效于 NSIS；确认 CI 同挂 |
| 4-6 | e3cf3fb/e599edf/6158cff | 挂 | annotation 通道逐步建好，锁定 `ort-sys build.rs:126` |
| 7 | c0c1122 | NSIS 挂 exit 1 | copy-dylibs 关闭生效，cargo 已过 |
| 8 | b64545a | Upload 挂 exit 1 | draft Release 404 |
| 9 | 1c0c9a1 | ✅ 全绿 | — |
