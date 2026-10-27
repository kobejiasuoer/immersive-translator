# RELEASE-RUNBOOK —— 发版一条龙（AI 优先读这份）

> **给 AI 助手的指引**：当你被要求「发版 / 发布新版本 / 打安装包 / 推 Release / 更新签名」时，
> 先完整读完本文件再动手，按本文流程执行，不要凭通用 Tauri 经验自由发挥。
>
> - **最近一次成功发版：v0.11.0，2026-10-27**（本文即按该次实跑验证整理，所有命令与坑都实测过）
> - 历史详细 runbook（v0.6.0 时代，讲原理与背景）：[`immersive-translator-windows/RELEASE-CHECKLIST.md`](./immersive-translator-windows/RELEASE-CHECKLIST.md)
> - 一键补签脚本：[`release-updater/sign.sh`](./release-updater/sign.sh)

## 0. 全景：发版 = 4 件事

1. **本地门禁**全绿（测试/类型/构建/Rust 三查）
2. **提交改动 → bump 版本号（5 处）→ 写 release-notes → 推 tag**
3. **GitHub Actions 自动出包**：mac job 建 Release，Windows job 构建 NSIS 安装包上传
4. **updater 签名补传**（一条命令）：让已装老版本的用户收到应用内自动更新

---

## 1. 本地门禁（全绿才继续）

```bash
cd immersive-translator-windows
npm test                                        # vitest（v0.11.0 时 931 例）
npm run build                                   # tsc && vite build
cd src-tauri && cargo check && cargo fmt --all --check && cd ..   # CI 会查 fmt，本地先保证
npm audit --package-lock-only --registry=https://registry.npmjs.org --audit-level=high
```

⚠️ audit 必须显式指官方 registry——本机 npm 默认走 npmmirror，它的 audit 端点直接 404。

## 2. 版本号（5 处，缺一不可）

`immersive-translator-windows/` 下：

| 文件 | 改什么 |
|---|---|
| `package.json` | `"version"` |
| `package-lock.json` | 顶部 `"version"` + `packages[""].version` 两处 |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version =` |
| `src-tauri/Cargo.lock` | `immersive-translator-windows` 包自己的 `version` 行 |

参考实现：`git show v0.10.3 --stat`（历代 bump 提交都长这样）。

## 3. release-notes

写仓库根 `release-notes/vX.Y.Z.md`（**不在** windows 子目录）。格式照 v0.11.0/v0.10.3：
一句主题加粗 + 分节面向用户讲更新内容 + 结尾固定一行
`> 老版本用户：设置 → 关于 → 检查更新，或直接下载本页安装包覆盖安装。`
发布时 workflow 会自动把它挂到 Release 页。

## 4. 提交与推 tag

```bash
git add -A && git commit -m "chore(release): bump version to X.Y.Z + 发布说明"
git push origin main
git tag -a vX.Y.Z -m "chore(release): bump version to X.Y.Z"
git push origin vX.Y.Z      # ← 推 tag 即触发发布流水线
```

## 5. 监控 Actions（本机没有 gh CLI，全走 curl）

```bash
# 运行状态
curl -s "https://api.github.com/repos/kobejiasuoer/immersive-translator/actions/runs?per_page=3" \
  | python -c "import json,sys; [print(r['name'],'|',r['head_branch'],'|',r['status'],r['conclusion']) for r in json.load(sys.stdin)['workflow_runs']]"
# 各 job / 各 step 明细（run id 换成上面的）
curl -s "https://api.github.com/repos/kobejiasuoer/immersive-translator/actions/runs/<id>/jobs" | ...
```

- **Release** 工作流：mac job 先建 Release（约 7 分钟）；Windows job 随后（10–25 分钟）出
  `ImmersiveTranslator_X.Y.Z_x64-setup.exe`。**CI 红不拦发布**（两个工作流独立触发），但门禁红是隐患要尽快修。
- Windows job 现在还带两个**可选增强**（都不阻塞主流程）：SignPath 云端签名（未配 secrets 自动跳过）、MSIX 商店包（`continue-on-error`，失败仅告警）。

## 6. updater 签名补传（一条命令，无需任何密码）

```bash
bash release-updater/sign.sh X.Y.Z
```

脚本自动完成：下载 CI 产物 → minisign 签名 → keynum 校验（`723b366356af3935`）→
生成 `latest.json`（gh-proxy 常青链）→ 提交推送 → `updater-assets` workflow 自动挂到 Release。

**签名原理（AI 容易踩的三个坑，都在这里）**：

- 私钥：`~/.tauri/immersive-translator-updater.key`，**口令是空字符串**（v0.6.0 起如此）
- `-k` 参数传的是 **私钥文件整体再 base64 一层**：`-k "$(base64 -w0 ~/.tauri/immersive-translator-updater.key)"`
  ——不是文件路径、不是 `-f`、也不是密钥第二行；传错会报
  `Invalid symbol 58/32` 或 `invalid utf-8 sequence` 这类 base64/解密错误
- 待签文件放**项目目录用相对路径**，别放 `/tmp`（Git Bash 的 /tmp 是 MSYS 虚拟路径，原生 npx 解析错位）
- `.sig` 必须对 **CI 产物**签（从 Release 下载），本地构建字节不同

## 7. 发版后验证

```bash
# Release 资产应包含：setup.exe / .sig / latest.json / macOS.zip(+sha256) / update-manifest.json
curl -s "https://api.github.com/repos/kobejiasuoer/immersive-translator/releases/tags/vX.Y.Z" \
  | python -c "import json,sys; [print(a['name']) for a in json.load(sys.stdin)['assets']]"
# 常青更新端点应返回新版本号
curl -sL --noproxy '*' "https://gh-proxy.com/https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/latest.json"
```

---

## 8. 踩坑速查表（2026-10-27 实录，按症状对症）

| 症状 | 原因 | 解法 |
|---|---|---|
| `npm audit fix` / `npm update --package-lock-only` 报 `Cannot read properties of null (reading 'edgesOut')` | 本机 lock 上 npm arborist bug，与 pnpm 布局的 node_modules 混用加剧 | 改用脚本外科手术：python 直接替换 lock 里的 version/resolved/integrity 三元组，再 `npm install --package-lock-only` 验证 |
| `npm audit` 报 404 / NOT_IMPLEMENTED | 默认 registry 是 npmmirror，不支持 audit 端点 | 加 `--registry=https://registry.npmjs.org` |
| CI「Check formatting」红 | Rust 代码没跑 fmt | `cargo fmt --all` 后随下个提交推上（tag 不用动，Release 不受 CI 影响） |
| CI「Audit dependencies」红 | 高危依赖公告 | lock 内升级到修复版（只动 devDependencies 时不影响运行时产物），命令见第 1 节 |
| 改动 node_modules 相关时报 Permission denied / 目录改不了名 | dev 会话进程链持锁：`tauri dev` → `npm run dev` → vite → esbuild，以及调试版 app 本体 | 用 `wmic process where "name='node.exe'" get ProcessId,CommandLine` 找出本项目进程（**别误杀 z_ai/mcp 等会话自身进程**），taskkill 后操作，完事提醒用户重启 `npm run tauri dev` |
| tauri signer 各种 base64/utf-8 报错 | `-k` 传参姿势错 | 见第 6 节：`-k "$(base64 -w0 私钥文件)"` + `--password ""` |
| GitHub Release 资产名被剥成 `_0.9.0_x64-setup.exe` 之类 | 资产 API 只认 ASCII，中文名被剥 | 资产名保持英文 `ImmersiveTranslator_...`（workflow 已处理，别改回中文） |
| Release 工作流挂了想重跑 | — | 修复后 `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`（mac 会 --clobber 重传，约 7 分钟/轮） |

## 9. 环境备忘

- 本机 `node_modules` 是 **pnpm 布局**而仓库/CI 用 **npm**（package-lock.json）：跑 `npm run`/`npm test` 没问题，
  但**别在本机跑 `npm install`/`npm audit fix` 类会重写 node_modules 的命令**，只改 lock 用 `--package-lock-only`
- 本机无 `gh` CLI：GitHub 操作全走 `curl` + 公开 REST API（发版足够，看日志用 check-runs annotations）
- 本地持有 updater 私钥（`~/.tauri/`，空口令）；GitHub 凭据在 Windows 凭据管理器（PAT，`git credential fill` 可取）

## 10. 可选：把补签也全自动化

在仓库 Settings → Secrets 配置 `TAURI_SIGNING_PRIVATE_KEY`（= `base64 -w0 ~/.tauri/immersive-translator-updater.key`
的输出）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（空串）后，Windows job 构建时会直接产出并上传 `.sig`，
第 6 步只剩 latest.json 仍需 sign.sh（gh-proxy 常青链 URL 需要手工生成）。
