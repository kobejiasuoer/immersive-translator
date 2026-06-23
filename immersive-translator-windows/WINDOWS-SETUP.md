# Windows 开发环境准备检查单

在 Windows 机器上继续 ImmersiveTranslator Windows 版开发前，按本检查单准备好环境。每项后面都有验证命令，跑通才算 OK。

## 1. 操作系统

- Windows 10（1803+）或 Windows 11。
- WebView2 运行时：Win11 自带；Win10 可能需要手动安装。下载：https://developer.microsoft.com/microsoft-edge/webview2/
- 验证：打开「设置 → 应用」，能看到「Microsoft Edge WebView2 Runtime」。

## 2. Microsoft C++ Build Tools（Rust MSVC 依赖）

Rust 在 Windows 上默认用 MSVC 工具链，需要 C++ 构建工具。

- 下载 Visual Studio Build Tools：https://visualstudio.microsoft.com/visual-cpp-build-tools/
- 安装时勾选「使用 C++ 的桌面开发」工作负载。
- 验证：安装完成后，在「开始菜单」能找到「x64 Native Tools Command Prompt」。

## 3. Rust 工具链

- 安装 rustup：https://rustup.rs/ ，下载 `rustup-init.exe` 运行，选默认（MSVC）。
- 验证：

```powershell
rustc --version
cargo --version
```

两个命令都应输出版本号。如果报错说缺少 MSVC linker，回到第 2 步装 C++ Build Tools。

## 4. Node.js（18 LTS 或更高）

- 安装：https://nodejs.org/ （推荐 LTS 版）。
- 验证：

```powershell
node --version   # 应 >= v18
npm --version
```

## 5. Git

- 安装：https://git-scm.com/download/win
- 验证：

```powershell
git --version
```

- 配置好 GitHub 认证（SSH key 或 HTTPS + credential manager），确保能 clone 本仓库。

## 6. 克隆仓库 & 验证 monorepo 结构

```powershell
git clone git@github.com:kobejiasuoer/immersive-translator-macos.git immersive-translator
cd immersive-translator
```

> 注意：GitHub 仓库当前仍叫 `immersive-translator-macos`。后续在 GitHub Settings 里改名 `immersive-translator` 后，旧地址会自动重定向，clone 命令同步更新。

验证目录结构：

```powershell
dir
```

应看到：`immersive-translator-mac/`、`immersive-translator-windows/`、`contracts/`、`docs/`。

## 7. 跑通已预写的核心逻辑单测

这是第一个真正的验证关卡——确认环境里 Node + Vitest 可用。

```powershell
cd immersive-translator-windows
# 先初始化 package.json 和装 vitest（工程骨架还没建，先手动补依赖）
npm init -y
npm install -D vitest typescript
npm test
```

> `src/core/` 下已经预写好 4 个核心逻辑模块和它们的测试。`npm test` 应全部通过（语言检测、术语表、提示词、错误分类）。如果通过，说明纯逻辑层和环境都 OK。
>
> 注意：完整的 Tauri 工程脚手架（`package.json` 里的脚本、`vite.config.ts`、`vitest.config.ts`）要在实施计划的 Task 2 用 `npm create tauri-app` 创建，这里只是临时跑通核心单测。

## 8. 环境准备完成后

环境全部就绪后，对照实施计划 `docs/superpowers/plans/2026-06-19-windows-phase-0-1.md`，从 **Task 2（初始化 Tauri 工程）** 开始。

> Task 1（monorepo 改造）和核心逻辑代码（Task 5-9 的代码部分）已经在 Mac 上预写好并推送，不用重做。Windows 端需要做的是：Task 2 Tauri 脚手架 → Task 3 托盘 → Task 4 热键验证（阶段 0 终点）→ Task 10-11 Rust 端 → Task 12-14 前端串联和端到端验证。

## 常见问题

**Q: `cargo build` 报「link.exe not found」？**
A: C++ Build Tools 没装或没勾「使用 C++ 的桌面开发」。回到第 2 步。

**Q: `npm create tauri-app` 报 Rust 相关错误？**
A: 确认第 3 步 Rust 装好，重开终端让 PATH 生效。

**Q: 热键（Ctrl+Shift+Q）注册失败？**
A: 可能被其他程序占用（部分输入法/快捷启动器）。如果撞了，可以换成 `Ctrl+Space` 或 `Ctrl+Alt+T` 之类试。

**Q: WebView2 白屏？**
A: 确认第 1 步 WebView2 Runtime 装好；Win10 尤其要检查。
