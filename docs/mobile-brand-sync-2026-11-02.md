# 移动端应用名与图标同步 · 2026-11-02

移动端应用名统一为「沉浸口语」，沿用 Windows 已确认的绿色 B「书页对话」图标。

## 名称来源与同步范围

- `immersive-translator-mobile/src-tauri/tauri.conf.json`：`productName`、窗口 `title`。
- `src-tauri/gen/apple/project.yml`：`PRODUCT_NAME`、`CFBundleName`、`CFBundleDisplayName`。
- iOS 主应用与分享扩展的 `Info.plist`：显示名称。
- 现有 `project.pbxproj`：两种配置的 `PRODUCT_NAME` 与产品文件引用；scheme 的 `BuildableName`。
- `src/main.tsx`：启动载入页应用名；`package.json`：项目描述。

主应用显示名为「沉浸口语」，产物及可执行文件名使用 `immersive-speaking.app` / `immersive-speaking`。模拟器验证发现中文可执行路径会在 `NSBundle bundleWithIdentifier:` 内触发 CoreFoundation 崩溃；恢复 ASCII 文件名后正常启动。显示名继续保持中文。工程 target 仍为 `imreader-mobile_iOS`，bundle id 仍为 `com.kobejiasuoer.reader`，签名团队仍为 `3HX836XLHX`。未调整签名权限、深链、版本、Build Rust Code 或分享扩展 target 的当前启用状态。

## 图标资产

- 原母版：`immersive-translator-windows/src-tauri/app-icon.svg`。
- 移动母版：`immersive-translator-mobile/src-tauri/app-icon.svg`。
- 渲染母图：`immersive-translator-mobile/src-tauri/app-icon.png`，1024×1024。
- 全套平台尺寸：`immersive-translator-mobile/src-tauri/icons/`。
- iOS 实际打包资产：`src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`，18 项 iPhone/iPad/marketing 图标。

移动母版的书页路径、尾角与颜色逐项保留，仅去掉底色矩形的 `rx="116"`，增加 1024 像素画布尺寸。iOS 图标四角为完整绿色底色，不预裁系统圆角，不带透明像素。

使用 app-icon-designer 的捆绑 Playwright 渲染脚本生成母图，再由项目现有 Tauri CLI 的 `tauri icon` 生成尺寸。为使 `icons/ios` 与 Xcode 实际资产一致，最终尺寸在新的临时输出目录生成后显式覆盖两个目录。没有下载软件或重画图标。

## 本次完成的验证

- 解析 Tauri 配置、主应用/扩展 plist、Xcode 工程与 scheme，名称一致，bundle id、team、target 保持原值。
- 原 SVG 与移动 SVG 的两条书页 path 属性完全相同，底色均为 `#1f6b57`。
- 18 项 iOS PNG 与 `Contents.json` 声明尺寸逐一相符；所有 alpha 值为 255；四角均为 `(31, 107, 87)`。
- `icons/ios` 与 Xcode `AppIcon.appiconset` 中对应 PNG 字节完全一致。
- 已目视检查浅/深背景的 180px 与 60px 图标预览。
- 产品源代码与配置中没有剩余「沉浸阅读室」或 `reader-spike` 名称；plist 与 pbxproj 的 `plutil -lint` 通过。

本子任务未构建、安装或提交。最终安装后的桌面图标与应用名由主任务继续验证。

## 主任务安装验证补充

模拟器（iOS 26.5）及物理 iPhone 17（iOS 27.0 Beta）Xcode debug 构建通过；物理设备已原位安装。模拟器桌面确认绿色书页对话图标及「沉浸口语」名称，启动成功。后续底栏手感修复与最终设备证据见 `mobile-ios-debug-2026-11-03.md`。

Apple/Firebase 维护者的同栈复现：[firebase-ios-sdk #3951](https://github.com/firebase/firebase-ios-sdk/issues/3951)。本轮实际做了中文可执行名崩溃 / ASCII 名启动的对照，没有修改第三方运行时或降低钥匙串安全性。
