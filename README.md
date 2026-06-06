# ImmersiveTranslator

ImmersiveTranslator 是一个 macOS 原生菜单栏翻译工具。它的目标不是做一个网页翻译入口，而是让选中文本翻译、截图 OCR 翻译和沉浸式阅读浮窗在 Mac 上更顺手。

当前项目仍处在 MVP 阶段，适合本地使用、体验验证和继续迭代。

## Features

- `Option + Space` 翻译当前选中文本。
- `Control + Option + Space` 框选屏幕区域，使用 Apple Vision 本机 OCR 后翻译。
- 浮窗译文面板，支持复制、重新翻译、收藏、固定、历史入口和耗时展示。
- 本地翻译历史和收藏，支持搜索、复制、删除和清空非收藏历史。
- 设置窗口支持 API Key、接口地址、模型、目标语言、快捷键预设和 OCR 识别偏好。
- 流式翻译展示，接口支持时会边生成边更新浮窗。
- API Key 存储在 macOS Keychain。
- 支持 OpenAI Chat Completions 兼容接口，并针对 DeepSeek、智谱 GLM 做了关闭思考模式的兼容处理。

## Requirements

- macOS 13.0+
- Swift 5.9+
- 一个 OpenAI Chat Completions 兼容服务的 API Key

## Quick Start

```bash
git clone https://github.com/kobejiasuoer/immersive-translator-macos.git
cd immersive-translator-macos
swift run ImmersiveTranslator
```

打包成普通 macOS App：

```bash
./scripts/build_app.sh
open dist/ImmersiveTranslator.app
```

也可以复制到应用程序目录：

```bash
ditto dist/ImmersiveTranslator.app /Applications/ImmersiveTranslator.app
open /Applications/ImmersiveTranslator.app
```

## Download

可以从 GitHub Releases 下载预构建版本：

```text
https://github.com/kobejiasuoer/immersive-translator-macos/releases
```

当前 release 包仍是开发构建，尚未使用 Apple Developer ID 正式签名和公证。macOS 可能会提示“无法验证开发者”，需要在“系统设置 -> 隐私与安全性”里手动允许打开。更推荐开发者从源码构建运行。

## Setup

首次使用需要在菜单栏点击 `译`：

1. 打开 `设置...`，填入 API Key、接口地址、模型和目标语言。
2. 授权 `辅助功能`，用于在你触发选中文本翻译时发送 `Command + C`。
3. 授权 `屏幕录制`，用于截图 OCR 翻译。

设置里还可以调整：

- 流式显示译文。
- OCR 识别模式：准确或快速。
- OCR 识别语言：混合、中英、英文、日文、韩文。
- 快捷键预设：避免和系统快捷键或输入法冲突。

默认接口：

```text
https://api.openai.com/v1/chat/completions
```

默认模型：

```text
gpt-4o-mini
```

常用兼容服务可以在设置窗口里一键填入预设，例如 DeepSeek 和 OpenAI。

## Privacy

- API Key 只写入 macOS Keychain，不写入仓库、日志或历史文件。
- 选中文本翻译会临时触发 `Command + C`，读取后恢复原剪贴板。
- OCR 使用本机 Apple Vision；截图不会发送给翻译服务。
- 翻译请求只发送待翻译文本和模型配置。
- 历史记录保存在本机 Application Support 目录。

## Diagnostics

本地诊断日志路径：

```text
~/Library/Application Support/ImmersiveTranslator/diagnostic.log
```

日志会记录请求开始、耗时、状态和错误摘要，不记录 API Key。

## Code Signing Notes

开发阶段如果每次重新打包后都需要重新授权辅助功能，通常是因为 App 使用了 ad-hoc 签名。macOS 会把每次重新打包后的二进制当成新的代码身份。

可以创建一个本地固定代码签名证书，例如：

```bash
security find-identity -v -p codesigning
CODESIGN_IDENTITY="ImmersiveTranslator Local Dev" ./scripts/build_app.sh
```

如果 `codesign` 卡住，通常是钥匙串私钥访问需要授权。可以在“钥匙串访问”里找到对应证书的私钥，允许 `codesign` 访问。

### Release Packaging

生成 release zip 和 sha256：

```bash
./scripts/package_release.sh 0.1.0
```

如果你有 Apple Developer ID 证书，可以先用正式证书构建：

```bash
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./scripts/package_release.sh 0.1.0
```

公证需要先在 Keychain 里配置 notarytool credentials：

```bash
xcrun notarytool store-credentials immersive-translator-notary
xcrun notarytool submit release/ImmersiveTranslator-0.1.0-macOS.zip \
  --keychain-profile immersive-translator-notary \
  --wait
```

公证通过后再发布到 GitHub Releases。

## Architecture

- `App.swift`：应用入口和菜单栏控制，串联热键、设置、浮窗、OCR、历史和首次引导。
- `HotKeyManager.swift`：使用 Carbon 注册全局快捷键。
- `ClipboardReader.swift`：通过辅助功能发送 `Command + C`，读取选中文本后恢复剪贴板。
- `ScreenSelection.swift`：跨屏幕 OCR 框选遮罩，并按 Retina/多屏坐标截取图像。
- `OCRReader.swift`：使用 Apple Vision 做本机 OCR。
- `TranslationClient.swift`：调用 OpenAI Chat Completions 兼容接口。
- `TranslationPanel.swift`：浮窗 UI、复制、固定、重新翻译、收藏和历史入口。
- `Settings.swift`：设置窗口和本地偏好读写。
- `KeychainStore.swift`：API Key 的 Keychain 读写。
- `TranslationHistoryStore.swift`：本地 JSON 历史和收藏。
- `Onboarding.swift`：首次启动权限和 API Key 引导。
- `Permissions.swift`：辅助功能、屏幕录制权限检查和系统设置跳转。

## Roadmap

- 快捷键自定义。
- 更好的截图 OCR 后处理和段落合并。
- 正式签名、公证和 release 分发。
- 更完善的错误诊断和 provider 预设。

## Contributing

欢迎提交 issue 和 pull request。这个项目会优先保持简单、原生、可读，不会为了功能堆叠引入复杂依赖。

## License

MIT
