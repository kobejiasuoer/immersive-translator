# 自动更新发布指南

本文件说明如何构建、签名、发布带自动更新的 Windows 安装包。

> **发布操作请照 [`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md) 逐步执行**——
> 那是 v0.3.0 实际跑通的全流程清单（含产物命名修正：Tauri 2 直接签名 setup.exe，
> 不再产生本文步骤 2/3 所述的 `.nsis.zip`）。本文保留作签名/证书体系的原理解释。

## 前置条件

### 1. 签名密钥（已生成，2026-06-24 重新生成）

使用标准 minisign 工具生成（`-W` 无密码）。

- **公钥 Key ID**：`3539AF5663363B72`
- **公钥**（已写入 `tauri.conf.json` → `plugins.updater.pubkey`，用于客户端校验）：
  ```
  RWRyOzZjVq85NZs8EXN9ghTfrS79aKH5ln4JBfUpqQSxsNbsYQ5W4VLF
  ```

签名时需要环境变量：

> **⚠️ @tauri-apps/cli ≥ 2.11 的坑**：新版 CLI 要求 `TAURI_SIGNING_PRIVATE_KEY`
> 是「密钥文件整体 base64 编码后的单行字符串」，直接传文件原文会报
> `failed to decode base64 secret key: Invalid symbol 32`。
> 下面的命令已按新版 CLI 的要求包装。

```powershell
# Windows PowerShell，构建前设置（CI 里配 secret）
$env:TAURI_SIGNING_PRIVATE_KEY = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.tauri\immersive-translator-updater.key"))
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""  # 空密码
```

```bash
# bash / CI
export TAURI_SIGNING_PRIVATE_KEY=$(base64 -w0 ~/.tauri/immersive-translator-updater.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""  # 空密码
```

构建后可用 Python 快速核对签名与 `tauri.conf.json` 公钥是否同一对：
解码 `.sig`（外层是 base64）取第 2 行再 base64 解码，其字节 2..10 的
keynum 应等于公钥的 keynum（公钥同样解两层 base64 后取字节 2..10，
当前为 `723b366356af3935`）。

**私钥**：保存在安全的地方（密码管理器 / CI secret）。当前本地位置：
- `~/.tauri/immersive-translator-updater.key`（主副本）
- 备份：`桌面/immersive-translator-keys-backup/`（拷到 U 盘 / 网盘后可删）

**丢了就无法再发布更新**——届时只能再生成一对新密钥并替换 `tauri.conf.json` 的公钥，代价是已安装旧版本的用户自动更新失效（需手动重装）。

### 2. 更新端点

`tauri.conf.json` 配置的端点（**镜像在前、GitHub 兜底**，updater 按顺序尝试，
前一个失败自动换下一个）：

```
1. https://gh-proxy.com/https://github.com/.../releases/latest/download/latest.json   ← 国内镜像
2. https://ghfast.top/https://github.com/.../releases/latest/download/latest.json     ← 国内镜像备胎
3. https://github.com/.../releases/latest/download/latest.json                        ← 直连兜底
```

**为什么敢走第三方镜像**：客户端下载安装包后用内置 pubkey 校验 minisign 签名，
镜像篡改内容会被拒装——镜像最多让下载失败，不可能装上被改过的包。

**为什么 latest.json 里的下载 url 也要加镜像前缀**（见 RELEASE-CHECKLIST 第 4 步）：
端点数组只决定「清单从哪拉」，安装包从清单的 `url` 字段下载；url 若仍是裸 GitHub，
国内无代理用户会「检查成功、下载失败」。

**换镜像要同步两处**：`tauri.conf.json` 的 endpoints + RELEASE-CHECKLIST 第 4 步
生成 latest.json 的 url 前缀。（镜像站是社区维护，域名会失效；2026-09 实测可用：
`gh-proxy.com` > `ghfast.top` > `ghproxy.net` > `gh.ddlc.top`。长期方案是自建域名
反代或国内对象存储。）

每次发布新版本时，把 `latest.json` 和签名后的安装包上传到 GitHub Release。

## Windows 安装包 Authenticode 代码签名（防杀软误拦）

与上面的 updater minisign 签名（只用于自动更新校验）不同，本节解决的是另一个问题：
**未经 Authenticode 签名的 exe 在企业环境极易被杀软/EDR 拦截**，典型表现就是安装时报
`Error opening file for writing`（杀软把写入中的主程序锁住或隔离）。

### 现状：自签开发证书（免费，适合内部分发）

已接入构建流程：`tauri.conf.json → bundle.windows.signCommand` 会在构建时自动对
主程序 exe 和 NSIS 安装包调用 `scripts/sign.ps1`（SHA-256 + DigiCert 时间戳）。

相关文件：

| 文件 | 作用 | 是否入仓库 |
|---|---|---|
| `scripts/generate-signing-cert.ps1` | 一次性生成自签证书（5 年期，CN=ImmersiveTranslator） | 是 |
| `scripts/sign.ps1` | Tauri 回调的签名脚本；**证书不存在时警告并跳过**（CI 无证书也能出包） | 是 |
| `signing/*.pfx` | 签名私钥 | **否**（.gitignore 已排除） |
| `signing/*.cer` | 公开证书，分发给同事/IT 导入信任 | **否**（按文件分发） |
| `signing/password.txt` | PFX 密码 | **否**（.gitignore 已排除） |

首次在新机器上构建前，运行一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-signing-cert.ps1
```

之后 `npm run tauri build` 会自动签名，无需额外操作。

### 让目标电脑信任自签证书

把 `signing/immersive-translator-codesign.cer` 发给同事，双击导入到
「受信任的根证书颁发机构」和「受信任的发布者」（选"本地计算机"或"当前用户"均可）。
公司域内可让 IT 通过 GPO 统一下发，一次搞定所有机器。

> **注意**：目标电脑没导入证书前，签名只起到"文件已签名+带时间戳"的启发式加分作用，
> SmartScreen 仍可能提示未知发布者，杀软仍可能拦截——那种情况还是要找 IT 加白名单。

验证签名：

```powershell
Get-AuthenticodeSignature .\release-builds\ImmersiveTranslator_0.2.0_x64-setup.exe
# 证书已受信的机器上 Status 应为 Valid；未导入证书的机器上为 UnknownError（自签未受信，属正常）
```

> **注意**：`target\release\` 下的裸 `immersive-translator-windows.exe` 在打包后会被
> Tauri 还原成未签名的中间产物，显示 NotSigned 属正常。需要验证的是**分发物**：
> 安装包本身和它内嵌的主程序 exe（用 7-Zip 解开安装包后 `Get-AuthenticodeSignature`）。

### 升级为正式 CA 证书（对外分发时）

- **Certum 开源代码签名证书**：约 €49/年起，个人可办，云签名（SimplySign），对开源项目最友好。
- **SSL.com / Sectigo 等 OV 证书**：约 $200-300/年，需要企业资质，SmartScreen 信誉积累慢。
- **Azure Trusted Signing**（$9.99/月）：2025-04 起仅限美加组织，**中国大陆不可用**，排除。

买证书后把新证书导入 signing/ 目录（或改 `sign.ps1` 调用对应的云签名工具）即可，
`signCommand` 流程不变。注意 2023-06 后 CA 签发证书的私钥必须存硬件 token 或云签，
拿不到裸 PFX 文件，届时 `sign.ps1` 需按所选 CA 的签名工具调整。

## 发布流程

### 步骤 1：版本号

修改 `src-tauri/tauri.conf.json` 的 `version` 字段：
```json
"version": "0.2.0"
```

### 步骤 2：构建带签名的安装包

```bash
cd src-tauri

# 设置签名密钥（Windows PowerShell）
$env:TAURI_SIGNING_PRIVATE_KEY = "粘贴私钥内容"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

# 构建（生成 .nsis 安装包 + .sig 签名文件）
cargo tauri build
```

> 构建过程会自动做 Authenticode 签名（主程序 exe + 安装包），详见上文
> 「Windows 安装包 Authenticode 代码签名」。本机没生成证书时仅警告跳过，不影响构建。
> 注意 `.ps1` 脚本必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 会按
> ANSI 读取中文注释导致解析报错。

构建产物在 `src-tauri/target/release/bundle/nsis/`：
- `ImmersiveTranslator_0.2.0_x64-setup.exe` — 安装包
- `ImmersiveTranslator_0.2.0_x64-setup.nsis.zip` — updater 用的压缩包
- `ImmersiveTranslator_0.2.0_x64-setup.nsis.zip.sig` — 签名

### 步骤 3：生成 latest.json

在 GitHub Release 页面创建 tag `v0.2.0`，上传：
- `ImmersiveTranslator_0.2.0_x64-setup.nsis.zip`
- `ImmersiveTranslator_0.2.0_x64-setup.nsis.zip.sig`
- `latest.json`（内容如下）

```json
{
  "version": "0.2.0",
  "notes": "更新说明：修复了 XX，新增了 YY",
  "pub_date": "2026-06-24T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "粘贴 .sig 文件的内容",
      "url": "https://github.com/kobejiasuoer/immersive-translator/releases/download/v0.2.0/ImmersiveTranslator_0.2.0_x64-setup.nsis.zip"
    }
  }
}
```

> **注意**：`latest.json` 必须上传为 **Release Asset**（不是 Source code），
> 这样 `releases/latest/download/latest.json` 才能直接下载到它。

### 步骤 4：验证

发布后，在已安装旧版本的 app 里打开「设置 → 关于/更新 → 检查更新」，
应该能检测到新版本并自动下载安装。

## 安全机制

- **签名校验**：客户端下载安装包后，用 `pubkey` 校验 `.sig` 签名。
  签名不匹配 → 拒绝安装（防中间人篡改）。
- **HTTPS**：manifest 和安装包都走 GitHub HTTPS。
- **私钥保护**：私钥不入仓库，只存在 CI secret / 密码管理器里。

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 检查更新报错 | GitHub releases 还没上传 latest.json | 确认 latest.json 是 Release Asset |
| 下载后校验失败 | .sig 文件内容不对 / 私钥不匹配 | 重新签名，确保用的是同一对密钥 |
| 检测不到新版本 | latest.json 的 version ≤ 当前版本 | 确保 latest.json 的 version 高于已安装版本 |
| 国内下载失败/慢 | GitHub 国内直连不稳（DNS 污染/连接重置） | 已配 gh-proxy 镜像端点（见上文「更新端点」）；镜像失效时换一家并同步改 endpoints + latest.json 的 url 前缀。**jsDelivr 走不通**——它只能加速仓库内文件，拿不到 Release Asset |
