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

## 4. Node.js（20 或更高，推荐 22 LTS）

- 安装：https://nodejs.org/ （推荐 LTS 版）。
- 验证：

```powershell
node --version   # 应 >= v20（CI 使用 v22）
npm --version
```

## 5. Git

- 安装：https://git-scm.com/download/win
- 验证：

```powershell
git --version
```

- 配置好 GitHub 认证（SSH key 或 HTTPS + credential manager），确保能 clone 本仓库。

## 6. 克隆仓库 & 安装依赖

```powershell
git clone git@github.com:kobejiasuoer/immersive-translator.git immersive-translator
cd immersive-translator
```

验证目录结构：

```powershell
dir
```

应看到：`immersive-translator-mac/`、`immersive-translator-windows/`、`contracts/`、`docs/`。

安装 Windows 端依赖：

```powershell
cd immersive-translator-windows
npm ci
```

`package.json`、Vite、Vitest 和完整 Tauri 工程已经在仓库中，不要再运行 `npm init -y` 或 `npm create tauri-app`。

## 7. 跑通前端单测和构建

这是第一个验证关卡，确认 Node、TypeScript 和 Rust 工程外的前端逻辑都可用。

```powershell
npm test
npm run build
```

> `src/core/` 下的 Vitest 应全部通过；`npm run build` 会同时检查 TypeScript 类型和 Vite 生产构建。

## 8. 启动和验证 Tauri 后端

环境全部就绪后，可以直接启动完整应用：

```powershell
npm run tauri dev
```

也可以运行 Rust 单测和正式构建检查：

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

OCR 模型在首次使用时下载到应用数据目录；请预留磁盘空间并保持网络可用。

## 常见问题

**Q: `cargo build` 报「link.exe not found」？**
A: C++ Build Tools 没装或没勾「使用 C++ 的桌面开发」。回到第 2 步。

**Q: `npm ci` 或 `cargo test` 报工具链错误？**
A: 确认 Node、Rust MSVC 和 C++ Build Tools 都已安装，重开「x64 Native Tools Command Prompt」让 PATH 生效。

**Q: 热键（Ctrl+Shift+Q）注册失败？**
A: 可能被其他程序占用（部分输入法/快捷启动器）。如果撞了，可以换成 `Ctrl+Space` 或 `Ctrl+Alt+T` 之类试。

**Q: WebView2 白屏？**
A: 确认第 1 步 WebView2 Runtime 装好；Win10 尤其要检查。
