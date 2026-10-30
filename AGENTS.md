# AGENTS.md

给 AI 编码助手的仓库指引。**做任务前先扫一遍本文件**；命中下面场景的，先读对应文档再动手。

## 项目速览

- **沉浸口语 / Immersive Speaking**：面向语言学习者的 Windows 桌面应用（Tauri 2 + React + Rust），AGPL-3.0 开源。
- 主工程在 `immersive-translator-windows/`（前端 `src/`，Rust 侧 `src-tauri/`）；服务端在 `immersive-translator-server/`（附加目录）。
- 应用版本号单一来源：`immersive-translator-windows/src-tauri/tauri.conf.json` 的 `version`。

## 场景 → 必读文档

| 你要做的任务 | 先读 |
|---|---|
| **发版 / 打 tag / GitHub Release / 应用内自动更新问题** | `docs/github-release-runbook-2026-10-30.md`（两段式发版：CI 出包 + 本地补签 latest.json，**照抄即可**） |
| **微软商店更新 / 碰 Partner Center** | `docs/microsoft-store-update-runbook-2026-10-30.md`（标准流程 + 踩坑实录，**照抄即可**） |
| 商店提交相关的背景与决策 | `docs/microsoft-store-submission-plan-2026-10-27.md` |
| 改隐私政策文案 | `docs/privacy-policy.md`（注意三处同步：应用内 `src/views/privacyPolicy.ts`、仓库页、商店属性页提交文本） |

## 硬性约束（违反会出事故）

- **商店版禁用应用内自更新**：`is_store_packaged()` 命令 + updater 短路是刻意的（商店政策 10.2.5 + 签名体系不同），不许移除或绕过。
- **runFullTrust 受限功能说明 ≤500 字**：超限 Partner Center 会静默卡住「提交选项」为未完成。
- **pack-msix.ps1 / 任何 PS 5.1 脚本读 UTF-8 文件必须显式 `-Encoding UTF8`**：否则中文按 GBK 误读，`tauri.conf.json` 直接解析失败。
- MSIX 包内清单必须叫 `AppxManifest.xml`，XML 注释不能含 `--`（makeappx 硬约束，见 runbook §4）。
- CI 的 MSIX 打包步骤 `continue-on-error: true`：**发版后必须去 GitHub Release 页确认 `.msix` 资产真实存在**，CI 绿不等于包打出来了。
- **发版必须完成「补签段」**：`latest.json` + `.sig` 提交到 `release-updater/vX.Y.Z/` 推送（updater-assets.yml 自动附件）。缺了它应用内更新**静默失效**——用户端永远显示「已是最新」，无任何报错。

## 仓库约定

- 提交信息用中文 conventional commits：`feat(reader): xxx` / `fix(app): xxx`。
- 过程文档放 `docs/`，文件名带日期后缀（如 `xxx-2026-10-30.md`）。
- 测试与类型检查：`npx vitest run <file>`、`npx tsc --noEmit`（在 `immersive-translator-windows/` 下执行）。
