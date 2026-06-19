# ImmersiveTranslator Windows 版设计

**日期**：2026-06-19
**状态**：待批准
**动机**：扩展产品触达，让 Windows 用户用上与 Mac 版对等的翻译体验

## 背景与约束

ImmersiveTranslator 当前是一个 macOS 原生菜单栏翻译工具，约 17,000 行 Swift，深度绑定 macOS 系统框架（AppKit、Carbon 全局热键、Vision OCR、Keychain、屏幕截图、SwiftUI）。不存在"重新编译即可跨平台"的路径——AppKit / Vision / Carbon / SwiftUI 这些框架在 Windows 上完全不可用。

但项目里真正有价值的**业务逻辑**是平台无关的：翻译请求与流式、术语表解析、错误分类、历史存储。只有"系统接入层"和"UI 层"是平台专属。

经过与产品负责人确认，本设计遵循以下既定约束：

- **Mac 版保持 Swift 原生**，不重写、不替换。继续维护其原生体验。
- **技术栈**：团队熟悉 Web / 前端栈（TypeScript、React 等），不引入需要重新学习的 Rust / C# 业务逻辑开发。
- **目标**：Windows 版全功能对齐 Mac 版（不是简化版）。
- **截图 OCR**：Windows 版使用 Windows 原生 OCR（WinRT `Windows.Media.Ocr`），不使用 Tesseract。

## 总体方案

**双端独立、契约共享**：

- Mac 版保留现有 Swift 实现，不动。
- Windows 版是一个自包含的 **Tauri + TypeScript** 应用，业务逻辑用 TS 按 Mac 版行为重写一份。
- 两端不共享代码，共享**数据格式契约**（Provider 预设表、历史记录 schema）。用户能跨平台感知的数据保持一致，平台各自的内部实现各自演化。
- 不引入跨平台共享代码层（不抽 Rust 核心 + FFI 回 Swift）。这类抽象的工程成本远超收益，且违背"Mac 留原生"约束。

**为什么是 Tauri 而非 Electron**：Tauri 包体积小（~5-10MB vs Electron 100MB+）、内存占用低，符合"菜单栏轻量工具"的产品定位。Rust 内核能直接调用 Windows 系统 API（WinRT OCR、全局热键），前端用团队熟悉的 React/TS。

## 仓库结构（Monorepo）

将现有仓库 `immersive-translator-macos` **就地改造**为 monorepo（保留完整 git 历史，GitHub 改名后旧 release 链接自动重定向）：

```
immersive-translator/                  ← GitHub 仓库根（现 immersive-translator-macos 改名）
├── immersive-translator-mac/          ← 现有 Swift 代码整体挪进来
│   ├── Sources/
│   ├── scripts/
│   ├── Package.swift
│   ├── Tests/
│   └── README.md
├── immersive-translator-windows/      ← 新建 Tauri 工程
│   ├── src-tauri/                     Rust 内核 + Windows 系统调用
│   ├── src/                           TypeScript 业务逻辑 + UI
│   ├── Tests/
│   └── README.md
├── contracts/                         跨平台共享契约（单一事实来源）
│   ├── provider-presets.json          Provider 预设表（两端引用）
│   ├── history.schema.json            历史记录结构 schema
│   └── README.md                      契约说明与版本约定
└── README.md                          顶层导航 README
```

### 顶层 README 职责

根 README 只做导航：一句话介绍产品，然后引导用户去对应平台子目录的 README（mac / windows）查看安装、下载和使用。下载入口统一指向 GitHub Release 页面（一个发布同时挂 Mac 包和 Windows 包，用户各取所需）。

## 数据契约共享策略（折中）

| 数据 | 是否共享 | 位置 | 理由 |
|------|---------|------|------|
| Provider 预设表 | **共享** | `contracts/provider-presets.json` | 模型名 / 接口地址两端漂移会让产品显得不专业。改一次两端同步。 |
| 历史记录 schema | **共享** | `contracts/history.schema.json` | Mac 导出的历史能在 Windows 导入，反之亦然。 |
| 设置项 schema | 各自管 | 各平台子目录内 | 两端本就有平台差异（Keychain vs Credential Manager）。 |
| 内部格式（术语表等） | 各自管 | 各平台子目录内 | 解析逻辑随平台实现，但术语表文件格式在两端 README 里对齐说明。 |

契约文件带**版本号字段**，两端在导入/读取时校验版本兼容性，不兼容时友好提示而非静默失败。

## 核心模块映射（Mac → Windows）

| 功能 | Mac 版实现 | Windows 版实现 |
|------|-----------|---------------|
| 全局热键 | Carbon `RegisterEventHotKey` | `tauri-plugin-global-shortcut` |
| 系统托盘 | NSStatusItem（菜单栏 `译`） | Tauri `SystemTray`（Windows 托盘图标） |
| 选中文本翻译 | 模拟 `Cmd+C` 读剪贴板并恢复 | 模拟 `Ctrl+C`；部分应用用 UI Automation API 补充 |
| 截图框选 | 自绘 NSWindow 遮罩 + Retina 截图（1987 行精致交互） | Tauri 透明全屏窗口 + Rust 端 `windows-rs` GDI 截图 |
| OCR | Apple Vision | WinRT `Windows.Media.Ocr`（本地、多语言），Rust 端经 `windows-rs` 调用后经 Tauri command 暴露给前端 |
| API Key 存储 | macOS Keychain | Windows Credential Manager（`keyring` crate） |
| 翻译浮窗 | NSPanel + SwiftUI（2744 行） | Tauri 透明无边框窗口 + React |
| 流式翻译 | URLSession SSE | Rust 端 `reqwest` + SSE → Tauri 事件流 → 前端 |
| 历史存储 | JSON（~/Library/Application Support） | JSON（%APPDATA%），schema 对齐 `contracts/history.schema.json` |
| 设置 | SwiftUI | React，设置项语义对齐但各管各的 |
| 错误分类 | ErrorMessageFormatter（803 行） | TS 重写，错误分类逻辑行为对齐 |
| 更新检查 | UpdateChecker（读 update-manifest.json） | 首发不做，后续再加 |

## 分阶段实施

虽然目标是全功能对齐，实施按风险从高到低分阶段，**先验证系统层再填业务**。

### 阶段 0 — 骨架验证（最高风险，必须先做）

目标：证明 Windows 系统集成链路可跑通。不涉及翻译、不涉及 OCR。

- Tauri 工程初始化。
- 系统托盘图标显示。
- 注册一个全局热键。
- 热键触发后弹出一个透明浮窗。

**通过标准**：在真实 Windows 机器上，托盘图标可见、热键可触发、浮窗可弹出。跑通才进阶段 1；跑不通立刻评估替代方案。

### 阶段 1 — 核心翻译链路

- 选中文本翻译：模拟 `Ctrl+C`（先验证浏览器 / 记事本 / Office 主流场景可用性）。
- TranslationClient（TS 重写）：OpenAI Chat Completions 兼容接口。
- 流式翻译：Rust 端 SSE → 前端事件流。
- 翻译浮窗：显示译文、复制、取消、重新翻译。
- 基础错误分类（TS 重写 ErrorMessageFormatter 核心逻辑）。

### 阶段 2 — 存储与契约

- API Key 存储：Windows Credential Manager（`keyring` crate）。
- 历史记录存储：%APPDATA% 下 JSON，落定 `contracts/history.schema.json`。
- 收藏功能。
- 术语表解析（TS 重写 GlossaryParser）。
- 术语表文件格式在两端 README 对齐说明。

### 阶段 3 — 截图 OCR

- 截图框选窗口（Tauri 透明全屏 + Rust GDI 截图）。MVP 先做基础框选，Mac 版的精致交互（放大镜、边缘吸附、键盘微调）放阶段 5。
- WinRT OCR 接入：Rust 端 `windows-rs` 调 `Windows.Media.Ocr`，Tauri command 暴露给前端。
- 原文确认流程（对齐 Mac 版 OCR 预览：确认 / 修正 / 整理段落 / 翻译）。

### 阶段 4 — 进阶对齐

- 快捷键自定义（录制 + 冲突检测）。
- 设置全套（React，设置项对齐）。
- 历史导出（CSV / JSON / Markdown / 纯文本）。
- Provider 预设卡片（引用 `contracts/provider-presets.json`）。
- 首次启动引导。
- OCR 模式 / 语言设置。

### 阶段 5 — 打磨

- 对齐 Mac 版错误诊断（Provider 诊断报告、安全 curl、支持包）。
- 流式等待状态细节（连接 / 首字 / 完整耗时、偏慢提示）。
- OCR 段落整理（对齐 Mac 版的跨栏 / 表格 / 复合词断行处理）。
- 截图框选精致交互（放大镜、边缘吸附、键盘微调）。

## 风险点

1. **WinRT OCR 在 Tauri 中的调用**：`windows-rs` 调 `Windows.Media.Ocr` 再经 Tauri command 暴露，是新组合，阶段 3 需留足调试时间。
2. **选中文本翻译可靠性**：纯模拟 `Ctrl+C` 不总可靠，部分应用需 UI Automation API。阶段 1 必须先验证主流应用可用性，必要时引入 UI Automation 兜底。
3. **截图框选工作量**：Mac 版 ScreenSelection.swift 有 1987 行精致交互，Windows 上要重新实现。阶段 3 先做基础框选，精致交互推迟到阶段 5。
4. **全功能对齐 = 体量大**：Mac 版 17,000 行，Windows 版即使复用思路也是万行级长周期项目。
5. **Windows 代码签名**：首发可不做正式签名，但未签名 exe 会触发 SmartScreen 警告，影响分发体验。正式分发阶段需评估 EV 证书成本。

## 不做的事（YAGNI）

- 不重写 Mac 版（保持 Swift 原生）。
- 不引入跨平台共享代码层（不抽 Rust 核心 + FFI 回 Swift）。
- 首发不做自动更新检查。
- 首发不做正式代码签名。
- 首发不做 Tesseract / 云 OCR——OCR 一律走 WinRT 原生。

## 实施计划范围说明

本设计覆盖 Windows 版整体架构与全功能对齐的完整路线，但这是**长周期多阶段项目**。第一个实施计划只聚焦 **阶段 0（骨架验证）+ 阶段 1（核心翻译链路）**，目标是在 Windows 上交付一个"选中翻译能跑起来"的可用版本。阶段 2-5 各自再开独立的实施计划，逐阶段推进。

理由：阶段 0 风险最高，必须先验证 Windows 系统集成；阶段 1 交付后用户已有可用产品；后续阶段在此基础上增量迭代，每个阶段可独立验收。

## 成功标准

- 阶段 0：Windows 上托盘 + 热键 + 浮窗链路跑通。
- 阶段 1-5 完成后：Windows 版功能与 Mac 版对齐，一个用户在两端都能完成「选中翻译 / 截图 OCR 翻译 / 流式显示 / 历史收藏 / 术语表 / 快捷键自定义」完整流程，且 Provider 预设和历史记录跨平台互通。
