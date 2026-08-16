# ImmersiveTranslator

ImmersiveTranslator 是一个跨平台的沉浸式翻译工具，提供选中文本翻译和截图 OCR 翻译，让日常阅读和翻译更顺手。

## 平台

- **macOS**：原生 Swift 实现，菜单栏 App，详见 [`immersive-translator-mac/`](./immersive-translator-mac/README.md)
- **Windows**：Tauri + React + TypeScript 实现，详见 [`immersive-translator-windows/`](./immersive-translator-windows/README.md)

## 下载

前往 [Releases](https://github.com/kobejiasuoer/immersive-translator/releases) 下载已经发布的平台安装包。不同 Release 的平台资产可能不同；Windows 版也可以按其 [`WINDOWS-SETUP.md`](./immersive-translator-windows/WINDOWS-SETUP.md) 在 Windows 环境构建。

## 共享契约

跨平台 Provider 与历史记录的契约收敛计划位于 [`contracts/`](./contracts/README.md)。当前两端的运行时数据格式仍独立，尚不能把内部历史文件直接互换；对外导入/导出格式稳定后再提升为共同的单一事实来源。

## 架构

本项目采用「双端独立、逐步收敛契约」的架构：

- 两个平台各自有独立的实现（Mac 用 Swift 原生，Windows 用 Tauri（Rust）+ React/TypeScript）。
- 用户能跨平台感知的数据（Provider 预设、历史记录）会逐步通过 `contracts/` 收敛；当前实现差异记录在该目录中。
- 各平台的内部实现各自演化，互不影响。

详细架构设计见 [`docs/superpowers/specs/`](./docs/superpowers/specs/)。

## License

MIT
