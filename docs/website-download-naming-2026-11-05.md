# 官网下载名称修复

日期：2026-11-05。延续 2026-11-04 官网精简升级预览。

## 根因与范围

Windows `productName` 已为「沉浸口语」，但发布 workflow 上传前把安装包复制为 `ImmersiveTranslator_*`；macOS 打包和更新也使用旧英文名。浏览器下载名来自 GitHub 资产响应，改按钮文字或跨域 `download` 属性不能可靠解决。

修复采用同字节的新品牌下载副本。保留原 EXE、签名、macOS ZIP、校验文件、MSIX、两份更新清单及应用身份。本轮没有重新构建安装包、打 tag 或发布新版本。

## 已发布下载副本

原 [v0.15.2 Release](https://github.com/kobejiasuoer/immersive-translator/releases/tag/v0.15.2) 已增加：

- [ImmersiveSpeaking_0.15.2_x64-setup.exe](https://github.com/kobejiasuoer/immersive-translator/releases/download/v0.15.2/ImmersiveSpeaking_0.15.2_x64-setup.exe)，35,937,330 字节。
- [ImmersiveSpeaking-0.15.2-macOS.zip](https://github.com/kobejiasuoer/immersive-translator/releases/download/v0.15.2/ImmersiveSpeaking-0.15.2-macOS.zip)，6,082,560 字节。
- `ImmersiveSpeaking-0.15.2-macOS.zip.sha256`，内部引用新 ZIP 的 basename。

SHA256 与原包一致：

```text
Windows  1fbb5ad7ad26361cafb137b086f2455eeed7abb63db319a73f303597718b4b41
macOS    da03f079c329cbca7e7addafe698b7045c5a8dbf74efdc2c58dd4ec4c7045157
```

已通过 GitHub 官方 API 比较发布前后：原七项资产的 ID、名称和 digest 均未改变；Release ID、tag、标题、正文和正式发布状态一致。副本状态为 `uploaded`，其 digest 与本地下载校验一致。安装包仅下载和校验，没有执行安装。macOS ZIP 内部应用名仍沿用该客户端现有名称，本轮只调整官网外层下载文件名。

## 本地代码

- `website/upgrade.html` 的四个无脚本直链切换到已发布的新名资产。
- `website/downloads.js` 同时识别新旧名称，优先新名；每个候选分别验证版本、上传状态和完整 GitHub URL。异常的新名资产仍可回退到有效旧名，平台之间独立。
- `.github/workflows/release.yml` 两平台追加同字节副本上传。旧资产和更新清单继续上传。该配置需提交并推送后，才对后续 CI 发版生效。
- `website/tests/downloads.test.mjs` 使用 Node 内置测试工具，无新增依赖。

官网仍为本地升级预览，入口 `http://127.0.0.1:4179/upgrade.html`；未替换 `index.html` 或部署至正式域名。移动端继续保留开发中原型与独立交接模块。

## 实际验证

- 两平台新资产的 Range GET 均返回 HTTP 206，`Content-Disposition` 分别为 `ImmersiveSpeaking_0.15.2_x64-setup.exe` 与 `ImmersiveSpeaking-0.15.2-macOS.zip`；实际响应已使用新文件名。Windows 经公开下载 URL，macOS 经 GitHub 官方资产 API 重定向到下载服务验证。curl HEAD 受本机网络连接限制，采用 Node GET 完成响应验证。
- 下载回归：`node --test website/tests/downloads.test.mjs`，36 项通过。覆盖名称优先、旧名兼容、异常候选回退、URL 白名单、平台独立、发布状态、请求失败、8 秒取消和 DOMContentLoaded。
- 既有下载校验：18 项通过；脚本语法检查通过。
- 六种尺寸交互检查：1440×900、1366×768、1440×700、768×1024、390×844、320×812；无横向溢出、缺图、错误锚点或脚本异常。场景切换、大图关闭焦点恢复、FAQ、菜单、双平台下载、禁用脚本和减少动态效果通过。
- 发布 workflow：两处 Bash 块语法检查、YAML 解析及六项本地模拟通过；覆盖上传／创建分支、签名存在／缺失、复制字节和 ZIP 校验文件 basename。未触发真实 CI 构建。
- 视觉检查：1440、768、390 宽，0 FAIL / 2 WARN。警告为缺少实景摄影和视频；延续已认可的软件界面展示，不加入无关素材。已查看三个尺寸截图。

沿用方向 `The page is the object`、seed `1337086390`，没有重抽方向或调整布局。页面直接成为阅读、口语、复习的可切换展示空间。复盘分数沿用实际截图的尺度：design 8.2、usability 8.6、creativity 7.0、content 8.3，overall 8.0；手机截图本身文字较小，可通过大图查看。素材均来自已有产品界面或明确标注的移动端原型，未新增图库或生成媒体。

诊断与截图位于 `.taste-skill/download-name-2026-11-05/`；资产核对记录为 `.taste-skill/release-name-audit-2026-11-05.json` 与 `release-name-after-2026-11-05.json`。这些过程文件和下载包不属于官网部署资产。
