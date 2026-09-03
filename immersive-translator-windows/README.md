# ImmersiveTranslator (Windows)

基于 Tauri 2.x + React + TypeScript 的 Windows 沉浸式翻译工具。

选中任意文本，按 `Ctrl+Shift+Q`，即可在浮窗中实时查看 AI 翻译结果。
按 `Ctrl+Shift+E` 进入截图模式，框选屏幕区域后自动 OCR 识别并翻译。

## 近期更新（v0.2.0）

- **划词翻译改用 Windows UI Automation**（主路径）—— 直接读前台控件的 TextPattern，绕开浏览器拦截 Ctrl+C、输入法抢占等场景。自动 fallback 到 Ctrl+C 模拟（兼容老 Win32 控件）。读取对 Chromium 系应用（Chrome/Edge/Electron）惰性构建做了重试增强。
- 双热键运行时切换改为「先注册新键 → 再注销旧键」的可回滚实现
- 历史窗口支持勾选/批量删除/批量复制
- 内嵌确认弹窗替换全部原生 `window.confirm`
- 翻译浮窗位置与大小跨启动记忆
- 全新应用图标 + 完整设计系统 + 暗色模式

## 功能

### 翻译核心

- **全局热键翻译** — 在任意应用中选中文字，按热键触发翻译
- **截图 OCR 翻译** — 框选屏幕区域，PaddleOCR 识别文字后自动翻译（离线，0.5s 级响应）。支持全局热键（默认 `Ctrl+Shift+E`）一键唤起
- **流式输出** — SSE 流式渲染，区分"连接中/等待首字/输出中"三阶段，显示连接/首字/总耗时拆分
- **浮窗面板** — 可拉伸、固定(pin)、失焦自动隐藏、收藏到历史
- **智能语言检测** — 中文自动译英，其他语言自动译中文；也可固定目标语言
- **思考模式兼容** — DeepSeek/智谱/Qwen 推理模型自动关闭思考，剥离 `<think>` 噪声
- **术语表** — 支持多种格式，导入/导出/去重/格式预检
- **自定义翻译风格** — 追加翻译风格指令
- **多 LLM 后端** — 13 个内置 Provider 预设（OpenAI/DeepSeek/智谱/Gemini/OpenRouter/百炼/Groq 等），一键套用
- **系统托盘** — 菜单含「截图翻译」「翻译历史」「设置」「退出」

### 安全与体验

- **API Key 安全存储** — Windows DPAPI 加密，不落 localStorage 明文
- **快捷键自定义** — 实时录制、冲突检测、运行时注册（翻译热键与截图 OCR 热键分别可配，保留组合识别）
- **错误诊断** — 按服务商分类、200 OK 错误 JSON 识别、连通性测试、脱敏 curl、诊断报告
- **翻译历史** — 本地存储、搜索、收藏、导出 CSV/JSON/Markdown/纯文本
- **浮窗键盘快捷键** — Esc 关闭 · Ctrl+Enter 复制译文 · Ctrl+Shift+C 复制原文+译文 · Ctrl+R 重试
- **取消请求** — 流式翻译可随时取消，保留已翻译部分
- **首次引导** — 未配置接口时显示三步指引
- **自动更新检查** — 设置页检查新版本，下载后自动校验签名并安装（防篡改）

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x (Rust 内核 + WebView2) |
| 前端 | React 19 + TypeScript |
| 构建 | Vite 6 |
| 测试 | Vitest (TS) + cargo test (Rust) |
| HTTP / SSE | reqwest (Rust) |
| 划词选区读取 | UI Automation（windows crate，TextPattern 主路径 + 浏览器惰性 tree 重试）+ arboard / windows-sys SendInput（Ctrl+C 兜底） |
| OCR | paddle-ocr-rs + ort (ONNX Runtime, PaddleOCR v4) |
| 安全存储 | Windows DPAPI (CryptProtectData) |
| 截图 | Win32 GDI BitBlt |
| 自动更新 | tauri-plugin-updater（签名校验 + GitHub Releases manifest） |

## 项目结构

```
immersive-translator-windows/
├── src/                       # 前端 (React + TypeScript)
│   ├── views/
│   │   ├── TranslationPanel   # 翻译浮窗面板（流式/取消/固定/收藏/快捷键）
│   │   ├── OcrOverlay         # 截图框选覆盖层（全屏透明 + 拖拽选区）
│   │   ├── Settings           # 设置窗口（预设/热键/术语表/OCR/诊断）
│   │   └── History            # 翻译历史（搜索/收藏/导出）
│   ├── core/                  # 平台无关的核心逻辑
│   │   ├── languageDetect     # 语言检测 & 目标语言选择
│   │   ├── glossaryParser     # 术语表解析/去重/合并/预检
│   │   ├── promptBuilder      # 系统提示词构造
│   │   ├── providerPresets    # 13 个内置 Provider 预设
│   │   ├── hotkeyValidator    # 热键格式校验/冲突检测
│   │   └── errorMessageFormatter  # 错误分类/诊断报告/脱敏 curl
│   ├── lib/
│   │   ├── settingsStore      # 设置持久化 (localStorage + DPAPI)
│   │   └── tauriBridge        # Tauri 命令封装 & 事件监听
│   └── App.tsx                # 多窗口路由
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── lib.rs             # 应用入口、托盘、热键、多窗口管理
│   │   ├── clipboard.rs       # 选中文本读取 (Ctrl+C 模拟)
│   │   ├── translation.rs     # LLM API 调用 & SSE 流式解析 & 思考模式兼容
│   │   ├── ocr.rs             # PaddleOCR 引擎（懒加载 + 段落整理 + 模型下载）
│   │   ├── screenshot.rs      # Win32 BitBlt 屏幕截图
│   │   ├── history.rs         # 翻译历史存储 & 导出
│   │   └── secret_store.rs    # DPAPI 加密存储 API Key
│   ├── examples/ocr_smoke.rs  # OCR 验证脚本
│   └── tauri.conf.json        # Tauri 配置（4 个窗口）
├── WINDOWS-SETUP.md           # 开发环境搭建指南
├── run-dev.bat                # 一键启动开发服务器
├── run-build.bat              # 一键构建
└── run-test.bat               # 一键运行测试
```

## 快速开始

### 安装依赖

```bash
cd immersive-translator-windows
npm install
```

### 开发环境准备

首次开发请参阅 [`WINDOWS-SETUP.md`](./WINDOWS-SETUP.md)，需要安装：
- Rust 工具链
- C++ Build Tools
- Node.js
- WebView2 Runtime

### 开发模式

```bash
npm run tauri dev
```

或直接双击 `run-dev.bat`。

### 构建

```bash
npm run tauri build
```

或双击 `run-build.bat`，产物在 `src-tauri/target/release/bundle/` 下。

### 测试

```bash
npx vitest run
```

## 使用方式

1. 启动应用后，程序最小化到系统托盘
2. 在任意应用中选中文字
3. 按 **Ctrl+Shift+Q**，浮窗出现并自动翻译
4. 可复制翻译结果、拖拽浮窗位置、按 **Esc** 关闭面板
5. 截图翻译：按 **Ctrl+Shift+E** 进入截图模式，框选区域后自动 OCR 识别并翻译（也可右键托盘 → 截图翻译）
6. 右键托盘图标可打开设置或退出

## 设置说明

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 接口地址 | OpenAI 兼容 API 的 Chat Completions 端点 | OpenAI 官方 |
| API Key | 服务商提供的密钥 | — |
| 模型 | 使用的模型名称 | gpt-4o-mini |
| 翻译模式 | 自动 / 固定目标语言 | 自动 |
| 翻译风格 | 追加到系统提示词的自定义指令 | — |
| 术语表 | 自定义翻译对照表（最多 80 条） | — |
| 流式输出 | 是否启用逐字流式渲染 | 开启 |
