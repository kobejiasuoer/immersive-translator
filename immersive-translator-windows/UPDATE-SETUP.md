# 自动更新发布指南

本文件说明如何构建、签名、发布带自动更新的 Windows 安装包。

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

`tauri.conf.json` 配置的端点：
```
https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/latest.json
```

每次发布新版本时，把 `latest.json` 和签名后的安装包上传到 GitHub Release。

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
| 国内下载慢 | GitHub releases 国内访问慢 | 可换 jsdelivr CDN 或自建镜像改 endpoints |
