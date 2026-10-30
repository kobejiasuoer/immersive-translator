# GitHub 发版 Runbook（EXE 通道 + 应用内自动更新）

> 2026-10-30 整理。v0.1.0–v0.11.1 全部版本验证过的成功流程，与
> [microsoft-store-update-runbook-2026-10-30.md](./microsoft-store-update-runbook-2026-10-30.md)
> 配套：**同一条 tag 同时服务两个通道**——GitHub Release 资产里的
> `-setup.exe` 给直接下载的用户（应用内自更新），`.msix` 给微软商店提交用。

## 0. 一图看懂

```
改版本号 → push tag vX.Y.Z
   ├─ release.yml · windows job：NSIS 安装包 (+.sig) + MSIX → 上传到 Release 资产
   ├─ release.yml · release job (macOS)：创建/更新 Release 正文与标题
   └─ 【补签段】本地 sign.sh 生成 .sig + latest.json → 提交 release-updater/vX.Y.Z/ → push
        └─ updater-assets.yml：把 .sig + latest.json 附件到同一 Release
             └─ 应用内更新器命中 releases/latest/download/latest.json → 用户收到更新
```

## 1. 标准流程（照抄）

1. **改版本号**：`immersive-translator-windows/src-tauri/tauri.conf.json` 的 `version`，提交并**确认已 push**（见 §2 坑 1）。
2. **打 tag**：`git tag vX.Y.Z && git push origin vX.Y.Z` → release.yml 自动跑（约 20–40 分钟）。
3. **核对 Release 资产**（到 GitHub Release 页逐项看，CI 绿 ≠ 资产齐）：
   - `ImmersiveTranslator_X.Y.Z_x64-setup.exe`（EXE 通道安装包）
   - `ImmersiveTranslator_X.Y.Z_x64-setup.exe.sig`（更新器签名，缺了走第 4 步）
   - `ImmersiveTranslator_X.Y.Z_x64.msix`（商店提交用；此步骤 continue-on-error，缺了本地 `pwsh ./scripts/pack-msix.ps1` 补打后 `gh release upload` 手传）
   - `latest.json`（更新清单，缺了走第 4 步）
4. **补签（两段式发版的第二段）**：若 CI 日志有「未配置 TAURI_SIGNING_PRIVATE_KEY」警告（minisign 私钥只在本地 `~/.tauri/`，仓库 secret 长期为空）：
   - 本地跑 `release-updater/sign.sh`（对 CI 的安装包产出 `.sig` + `latest.json`，私钥签名、pubkey 在 tauri.conf.json 里与之配对）；
   - 把两个文件放进 `release-updater/vX.Y.Z/`，**随 main 推送**；
   - `updater-assets.yml` 自动把它们附件到对应 Release（--clobber，可重复触发）。
5. **验证更新链路**：浏览器打开 `https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/latest.json` 应返回新版本的 JSON（`version`、`platforms["windows-x86_64"].signature` 非空、`url` 指向新 exe）。老版本应用里点「检查更新」应提示发现新版。
6. **商店通道**：拿 Release 里的 `.msix` 按 [商店 Runbook](./microsoft-store-update-runbook-2026-10-30.md) §2 走提交。

## 2. 踩坑实录

| 坑 | 现象 / 解法 |
|---|---|
| **tag 先于提交落地** | 本地 commit 后直接打旧 tag 推送 → CI 构建的是没有新改动的旧树（v0.11.0 实测：MSIX 打包改动没进包）。**先 push main，确认远端到位，再打 tag** |
| **Release 资产名必须 ASCII** | 资产名含中文会被 GitHub 服务端剥字符（v0.9.0 实测变成 `_0.9.0_x64-setup.exe`；REST 百分号编码上传返回 422）。资产名固定用英文 `ImmersiveTranslator_*`；应用内 productName 改中文不受影响。workflow 已内置自动清残留逻辑 |
| **latest.json 资产名必须恰为 `latest.json`** | 更新端点是 `releases/latest/download/latest.json`，改名即静默 404，**用户端表现为永远提示已是最新**（无报错） |
| 忘了补签段 | CI 正常、Release 也有 exe，但没 .sig / latest.json → 应用内更新静默失效。补第 4 步即可，无需重新构建 |
| MSIX 资产缺失 | release.yml 的 MSIX 步骤 `continue-on-error: true`，失败不红。本地补打后 `gh release upload vX.Y.Z -R kobejiasuoer/immersive-translator <文件> --clobber` |
| 国内下载/更新慢 | 更新端点已配三个镜像轮询：gh-proxy.com、ghfast.top 代理 + GitHub 原始地址（tauri.conf.json `plugins.updater.endpoints`），改动时三个一起维护 |

## 3. 验证清单（发版收尾口诀）

- [ ] Release 页四件套齐：`setup.exe` / `.sig` / `latest.json` / `.msix`
- [ ] `latest.json` 内容指向新版本且 signature 非空
- [ ] 老版本点「检查更新」能收到新版（真实验证，别跳过）
- [ ] （如发商店）MSIX 已按商店 Runbook 提交认证
