# 微软商店更新发布 Runbook（成功经验总结）

> 2026-10-30 整理。首次提交（Submission 1，v0.11.1）已于 2026-10-29 成功进入认证，
> 本文把「能跑通的全流程 + 踩过的坑」固化下来，供后续每个版本发布商店更新时照抄。
> 背景与决策过程见 [microsoft-store-submission-plan-2026-10-27.md](./microsoft-store-submission-plan-2026-10-27.md)。

## 0. 关键结论（先记住这三条）

1. **通道选「MSIX 或 PWA 应用」**：商店免费重签名，**不需要买任何代码签名证书**（SignPath/Certum 路线已作废）。选错成「EXE 或 MSI 应用」会引入 10.2.9 政策下的签名/静默安装要求——届时只能删产品重建。
2. **每次更新都要重新认证**，但只是「换包再走一遍」：描述/截图/属性/年龄分级全部自动沿用，只换包 + 可选写更新说明。审核数小时～3 个工作日，**期间老版本正常在架**，通过后自动发布。
3. **双通道更新，互不越界**：商店用户由商店自动更新（应用内更新器通过 `is_store_packaged` 短路，政策 10.2.5 + 签名体系不同）；GitHub EXE 用户继续走应用内自动更新。发版时两条线都照顾到即可。

## 1. 产品身份信息（提交时要用，勿重做）

| 项 | 值 |
|---|---|
| 产品 | 沉浸口语（Immersive Speaking） |
| Product ID | `9N6PHF9PML82` |
| 包身份 Name | `6CB76113.301226195DDAA` |
| 发布者 Publisher | `CN=6C32A8A6-A9B5-4B39-9FC3-E1AC3A8949DD` |
| 类别 | 教育 / 语言（次要：实用工具 + 工具） |
| 隐私政策 | 「文本模式」全文内嵌在属性页（见 `docs/privacy-policy.md` 同口径） |
| 受限功能 | runFullTrust，说明 ≤500 字（当前 482 字版本在提交选项页） |

## 2. 每次更新的标准流程（照抄即可）

1. **改版本号**：`immersive-translator-windows/src-tauri/tauri.conf.json` 的 `version`（应用版本单一来源，MSIX/NSIS/更新清单都从这里取）。
2. **打 tag 触发 CI**：`git tag vX.Y.Z && git push origin vX.Y.Z`。release.yml 在 Windows job 里跑 `scripts/pack-msix.ps1` 生成 MSIX，并上传到 GitHub Release 资产：`build/msix/ImmersiveTranslator_<版本>_x64.msix`。
   ⚠️ **必须到 Release 页确认 .msix 资产真的在**：workflow 里 MSIX 步骤是 `continue-on-error: true`，打包失败 CI 仍显示绿。若资产缺失，本地补打（见 §4）后手动上传到 Release。
3. **下载 MSIX**（Release 资产里那个 `.msix`，39MB 量级；**不是** `x64-setup.exe`，那是 EXE 通道的）。
4. **Partner Center → 产品 → 「创建新提交」**（Submission N+1）。
5. **「包」→ 替换/追加新 MSIX**，等状态变 `Validated`（商店侧校验包身份与清单，通常几分钟）。旧版本包可以保留也可以删，首次上架后建议只留最新。
6. **「Store 一览」→「此版本的新增功能」** 写更新说明（可选，首次提交留空，之后建议写）。
7. **「属性」/「年龄分级」**：只在能力声明或隐私行为变化时才需要动（比如新增受限功能、新增个人信息类别）。
8. **「提交选项」**：不用动。已选「认证后立即发布」。
9. **点「提交进行认证」**，等结果（邮件 + Partner Center 通知）。

## 3. 打包链路（已固化在仓库，出问题再查）

- **脚本**：`immersive-translator-windows/scripts/pack-msix.ps1` —— staging `target/release` 的 exe + `models/` + `DirectML.dll.payload`，生成 `AppxManifest.xml`（版本取 tauri.conf.json，`@VERSION@` 占位符替换为四段式 `X.Y.Z.0`），拷 5 个图标资产，调 Windows SDK 的 `makeappx pack`。**不签名**（商店重签）。
- **清单模板**：`src-tauri/msix/Package.appxmanifest`（Identity 已填商店分配的 Name/Publisher，改版本不要动这里，脚本会替换）。
- **本地补打**：`pwsh ./scripts/pack-msix.ps1`（需装 Windows SDK 提供 makeappx；产物在 `build/msix/`）。

## 4. 踩坑实录（这些坑都真实踩过，别再踩）

| 坑 | 现象 / 解法 |
|---|---|
| 产品类型选错 | 选成「EXE 或 MSI」→ 触发 10.2.9 签名要求。**只能删除产品重建**（「MSIX 或 PWA」），商店分配的身份会变，需同步改 `msix/Package.appxmanifest` |
| runFullTrust 说明超字数 | 提交选项页标「未完成」但无显眼红字。硬上限 **500 字**（当前合规版 482 字），超限时提交按钮置灰 |
| makeappx 报 0x80080203 | 包内清单文件名必须是 **`AppxManifest.xml`**（`Package.appxmanifest` 只是源模板名） |
| makeappx 报清单无效 | XML 注释里**不能含 `--`** |
| makeappx 报 DefaultTile schema | 声明了 `Square310x310Logo` 就必须同时给 `Wide310x150Logo`；最简做法只留 `Square71x71Logo` |
| PS 5.1 读 UTF-8 乱码 | 无 BOM 的 UTF-8 会被按 GBK 误读，「沉浸口语」变乱码导致 JSON 解析失败。`Get-Content` 一律显式 **`-Encoding UTF8`** |
| staging 混入杂散 DLL | release 目录里的 cdylib 产物、`DirectML.dll`（运行时解包产物）不属于安装布局，带入 MSIX 会白白变大甚至审核不过。只 stage exe + models/ + DirectML.dll.payload |
| CI 绿但没包 | MSIX 步骤 `continue-on-error: true`，失败不红。**以 Release 资产为准** |
| 商店截图规格 | 桌面设备系列至少 1 张，建议 1366×768 起、.png、≤50MB。现成 3 张：`build/store-shots/*-final.png`（本地 `localhost:1420/*-preview.html` 截图裁掉横幅所得）；Store 徽标/磁贴图**可选**，默认用包内图标 |
| 商店版自更新打架 | 商店版必须禁用应用内自更新（已做：`is_store_packaged` 命令 + updater 短路）。**别把这段逻辑拆了** |

## 5. 遗留事项（下个提交顺手处理）

- [ ] 属性页「应用网站」目前填的 `immersivetranslate.com` 是原版沉浸翻译官网，与本应用无关；下次提交改成自己的地址（GitHub 仓库页即可）。若本次认证因此被拒，改完直接重提。
- [ ] 订阅/登录功能的**测试账号**：认证员若验证付费功能会要凭据，届时在「提交选项 → 认证说明」补充。
- [ ] 应用内隐私入口（`PrivacyPolicyCard`，e42018f）随下个版本上线；上线后商店版和仓库页三方口径一致。
- [ ] 下个 release 观察 CI 的 MSIX 产物在 runner 上真实产出（首次提交的包是本地补打的）。

## 6. 自动化小抄（浏览器自动化传截图/填表）

Partner Center 的上传控件是隐藏的 `input[type=file]`（id `image-upload-input`）。浏览器自动化（Playwright 类工具）**不需要点「＋」弹系统文件框**，直接对空 value 的 input 构造 `DataTransfer` 塞 `File` 并派发 bubbling 的 `change` 事件即可；上传完成有数秒延迟，以「桌面 (N)」计数为准。提交按钮在 `he-button` shadow DOM 里，需钻入 shadowRoot 点真实 `<button>`。
