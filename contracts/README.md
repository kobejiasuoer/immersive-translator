# 跨平台共享契约

本目录记录 Mac 版和 Windows 版共享数据契约的收敛目标。

## 当前状态

共享 JSON 契约尚未接入运行时代码，当前不能把两端的内部数据文件直接互换：

- Provider 预设分别维护在 Mac 的 `ProviderProfile.swift` 和 Windows 的 `providerPresets.ts`，数量与字段并不完全一致。
- Mac 历史文件是记录数组、ISO-8601 时间和 `screenshotOCR` 来源；Windows 历史文件带 `records` 包装、Unix 毫秒时间和 `ocr` 来源，并额外保存模型与耗时。
- 两端导出的 CSV、JSON、Markdown 和纯文本适合备份或人工查看，但尚未提供跨平台导入承诺。

在共同 schema、迁移器和双端兼容测试落地前，不应把本目录描述为运行时的单一事实来源。

## 文件

- `provider-presets.json`（计划）：Provider 预设表（OpenAI / DeepSeek / 智谱 / Gemini 等），用于避免模型名与接口地址漂移。
- `history.schema.json`（计划）：对外历史记录 JSON schema，并配套两端导入迁移器与兼容性测试。

## 版本约定

未来每个契约文件都应带 `schemaVersion` 字段。两端在读取或导入数据时校验版本兼容性：

- 主版本号一致：兼容，正常读取。
- 主版本号不同：不兼容，向用户友好提示（例如「历史记录格式来自更新版本，请升级 App」），不静默失败。

## 为什么不共享所有数据

只共享「用户能跨平台感知」的数据（Provider 预设、历史记录格式）。各平台的设置项、内部实现格式各自管理——因为两端本就有平台差异（Mac 用 Keychain 存 API Key，Windows 用 DPAPI 存 API Key），强行统一反而僵硬。
