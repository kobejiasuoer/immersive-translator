# Windows 发布实战清单（以 v0.3.0 实际验证为准）

> 一次「版本号 → 本地构建 → 上传 GitHub Release」的完整流程记录。
> 签名原理与证书体系见 `UPDATE-SETUP.md`；本文是**按顺序照做即可成功**的操作清单，
> 包含 2026-09 发布 0.3.0 时实际踩过的坑。

## ⭐ v0.6.0 起的标准发布流程（免 PAT、免手动上传）

> 2026-09-21 发布 v0.6.0 全程实跑验证。适用前提：本机无 GitHub PAT、未装 gh CLI、
> 不想弹「Connect to GitHub」登录窗，只用 SSH push 完成一切。
> 涉及文件锚点：`.github/workflows/release.yml`（windows job 云端构建）、
> `.github/workflows/updater-assets.yml`（签名产物补传）、`release-notes/`（中文发布说明）、
> `release-updater/`（本地签名产物投放处）。

### 为什么改流程

v0.5.2 之后本机凭据管理器的 PAT 失效，`git credential fill` 只会弹出
「Connect to GitHub」交互登录（**不要用它**）。新流程里：git push 走 SSH（正常）；
Release 的创建与资产上传全部由 Actions 内置 token 完成；updater 私钥只在本机
`~/.tauri/`，其签名产物通过「提交进仓库 + 专用 workflow 附件」补传——全程零登录。

### 第 0 步 · 前置核对

| 项 | 核对方式 |
|---|---|
| updater 私钥 | `ls ~/.tauri/immersive-translator-updater.key` 存在 |
| 无残留进程 | 任务管理器无 immersive-translator-windows.exe；1420 端口空闲 |
| 工作区 | `git status`：所有改动已归入模块 commit，无计划外文件会被顺带提交 |

### 第 1 步 · 收尾门禁（全绿才许打 tag）

```bash
cd immersive-translator-windows
pnpm test                                  # vitest 全绿
pnpm build                                 # tsc + vite
cd src-tauri && cargo test && cargo fmt --all -- --check
#   fmt 不干净就先 cargo fmt --all，格式化改动随功能 commit 入库（CI fmt 是硬门禁）
cd .. && npm audit --audit-level=high --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile             # pnpm-lock.yaml 与 package.json 同步校验
```

⚠️ **本次加过依赖就必须重建 package-lock.json**（CI 前端门禁走 `npm ci`，lockfile
落后直接红）：`npx -y npm@11 install --registry=https://registry.npmjs.org`，
重建后本地完整复跑 `npm ci && npm test && npm run build` 一遍最稳。

### 第 2 步 · 分模块提交

按功能模块拆 commit（一个功能一个，如 R1 导入 / R2 笔记 / R3 口语……），共享的
接线文件（lib.rs、tauriBridge、readerStore、样式等）归最后一个功能 commit。
信息格式沿用仓库惯例：`feat(scope): 中文标题`+ 空行 + 要点列表。

### 第 3 步 · 版本号（三处 + Cargo.lock）

改 `package.json`、`src-tauri/tauri.conf.json` 的 `"version"` 与 `src-tauri/Cargo.toml`
的 `version`，再改 Cargo.lock 里本包那行：

```bash
grep -n -A1 'name = "immersive-translator-windows"' src-tauri/Cargo.lock
#   ⚠️ 别按固定行号 sed——依赖增减后行号会漂，先 grep 定位再改
cd src-tauri && cargo test --locked        # --locked 验证 lockfile 一致（CI 同款门禁）
git add … && git commit -m "chore(release): bump version to X.Y.Z"
```

### 第 4 步 · 本地烟囱构建（可选但推荐，5 分钟买个放心）

```bash
export TAURI_SIGNING_PRIVATE_KEY=$(base64 -w0 ~/.tauri/immersive-translator-updater.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build    # 验证打包链路可走通；产物仅作验证，正式包以 CI 产物为准
```

### 第 5 步 · 发布说明 + 推送

- 写仓库根 `release-notes/vX.Y.Z.md`（**不在** windows 子目录）。格式照 v0.5.2/v0.6.0：
  `## 更新内容` + 加粗版本定调 + 分组要点 + 「老版本用户：检查更新/覆盖安装」尾注。
- `git push origin main && git tag vX.Y.Z && git push origin vX.Y.Z`

### 第 6 步 · 等 Actions（免凭据监控，公开 API 直接读）

```bash
curl -s "https://api.github.com/repos/kobejiasuoer/immersive-translator/actions/runs?per_page=5"
curl -s "https://api.github.com/repos/kobejiasuoer/immersive-translator/releases/tags/vX.Y.Z"
```

- **Release** 工作流：mac job 先创建 release（mac 三件资产）；windows job 随后
  （约 10-25 分钟）构建 NSIS 并上传 `ImmersiveTranslator_X.Y.Z_x64-setup.exe`，
  再用 `release-notes/vX.Y.Z.md` 覆盖自动生成的英文说明。
- **CI** 工作流：mac swift / 前端 audit+test+build / Rust fmt+test(--locked) 三组门禁。

### 第 7 步 · updater 签名补传（仓库未配 TAURI secret 时必做）

```bash
# ① 下载 CI 产物 —— ⚠️ 字节与本机构建不同，.sig 必须对 CI 产物签！
curl -sL -o ci.exe "https://github.com/kobejiasuoer/immersive-translator/releases/download/vX.Y.Z/ImmersiveTranslator_X.Y.Z_x64-setup.exe"
# ② 签名：-k 传 base64 后的私钥全文（不是文件路径！），密码是空串
npx tauri signer sign -k "$(base64 -w0 ~/.tauri/immersive-translator-updater.key)" --password "" ci.exe
# ③ 按 §3 ① 验 keynum == 723b366356af3935
# ④ 按 §4 生成 latest.json：signature = 新 .sig 全文；url 用
#    https://gh-proxy.com/https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/ImmersiveTranslator_X.Y.Z_x64-setup.exe（常青链）
# ⑤ 投放仓库并推送（.sig 文件名必须与 release 资产 exe 同名；latest.json 名字固定）
mkdir -p release-updater/vX.Y.Z
cp ci.exe.sig release-updater/vX.Y.Z/ImmersiveTranslator_X.Y.Z_x64-setup.exe.sig
cp latest.json  release-updater/vX.Y.Z/latest.json
git add release-updater && git commit -m "chore(release): vX.Y.Z updater 签名与 latest.json" && git push
#    推送后 updater-assets.yml 自动把两者附件到对应 tag 的 release
```

若仓库日后配置 `TAURI_SIGNING_PRIVATE_KEY` secret（base64 私钥全文 + 空密码），
windows job 构建时就会直接产出并上传 .sig，**本步整段跳过**。

### 第 8 步 · 发布后验证 + 归档

- §6 验证照旧：`releases/latest/download/latest.json` 返回新版本号且 signature
  与本地 .sig 全文一致；`--noproxy '*'` 走 gh-proxy 镜像验一遍；tag 上 CI/Release 全绿。
- 归档 `release-builds/vX.Y.Z/`：exe **从 release 重新下载**（与本地产物字节不同），
  连同 .sig、latest-vX.Y.Z.json，保证归档与线上一致。

### 实测节奏（v0.6.0，2026-09-21）

门禁 + 分模块提交约 30 分钟 → 本地烟囱构建 5 分钟 → push tag 后 windows job
约 12 分钟出包上传 → 签名补传约 3 分钟。全程无人值守、零登录。

以下 §0–§6 为 v0.5.x 及之前的「本机构建 + PAT 上传」流程，留作参考
（重新存好 PAT 且网络畅通时仍可用）。

## 0. 前置条件（每次发布前核对）

| 项 | 位置 / 获取方式 | 缺失时后果 |
|---|---|---|
| updater minisign 私钥 | `~/.tauri/immersive-translator-updater.key` | 无法签名更新包，老用户自动更新失效 |
| Authenticode 证书 | `signing/*.pfx` + `password.txt`（不入仓库） | 仅警告跳过，产物无代码签名（易被杀软拦） |
| GitHub 凭证 | Windows 凭据管理器存有 PAT（用户 kobejiasuoer），用 `git credential fill` 取用 | 无法创建/上传 Release |
| 干净环境 | 无残留 `immersive-translator-windows.exe`、1420 端口空闲 | 新实例热键注册 panic / vite 端口冲突 |

取 GitHub token（本机无 gh CLI，全部走 REST API）：

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n" | git credential fill 2>/dev/null | grep "^password=" | cut -d= -f2)
```

## 1. 版本号（三处 + lockfile）

新功能升 minor，修复升 patch。改这三处，版本保持一致：

```
immersive-translator-windows/package.json
immersive-translator-windows/src-tauri/tauri.conf.json   ← UPDATE-SETUP.md 只提了这处，别漏另外两个
immersive-translator-windows/src-tauri/Cargo.toml
```

`src-tauri/Cargo.lock` 里本包的 version 会在构建时自动跟进（历史上发版漏过它，
若构建后 lockfile 有 version diff，一并提交）。

提交并推送 main，然后打 tag 推送：

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore(release): bump version to X.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

**推 tag 会自动触发两个 workflow**（`.github/workflows/`）：
- `release.yml`：在 macOS runner 上构建 **macOS 包**并创建/更新同名 GitHub Release（只有 mac，Windows 必须本地构建）
- `ci.yml`：测试 + `npm audit --audit-level=high` 门禁 + `cargo fmt --check` 门禁

## 2. Windows 本地构建（Git Bash）

```bash
cd immersive-translator-windows
export TAURI_SIGNING_PRIVATE_KEY=$(base64 -w0 ~/.tauri/immersive-translator-updater.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

- ⚠️ **必须 base64 包装**：@tauri-apps/cli ≥ 2.11 要求私钥是「文件整体 base64 的单行
  字符串」，直接传文件原文报 `failed to decode base64 secret key`。
- 构建会自动做 Authenticode 签名（sign.ps1，证书缺失则警告跳过）。
- dev 环境若在跑，构建可能把它顶掉（0.3.0 发布时 dev 随构建退出）——构建前先停 dev。
- 全程约 3-5 分钟（release 增量编译）。

产物（`src-tauri/target/release/bundle/nsis/`）：

| 文件 | 用途 |
|---|---|
| `ImmersiveTranslator_X.Y.Z_x64-setup.exe` | 安装包（= Tauri 2 的 updater 产物，**没有** v1 时代的 `.nsis.zip`，UPDATE-SETUP.md 旧段落提 `.nsis.zip` 已过时） |
| `ImmersiveTranslator_X.Y.Z_x64-setup.exe.sig` | updater 签名（latest.json 的 signature 字段用它的全文） |

## 3. 验证产物（上传前必做）

```bash
cd src-tauri/target/release/bundle/nsis

# ① updater 签名与 tauri.conf.json 公钥同一对（keynum 应为 723b366356af3935）
python -c "
import base64
sig = base64.b64decode(open('ImmersiveTranslator_X.Y.Z_x64-setup.exe.sig').read())
inner = base64.b64decode(sig.splitlines()[1])
print(inner[2:10].hex())
"
# ② Authenticode（应为 Valid）
powershell -NoProfile -Command "(Get-AuthenticodeSignature 'ImmersiveTranslator_X.Y.Z_x64-setup.exe').Status"

# ③ 测试全绿
npm run test          # vitest
cd src-tauri && cargo test
```

## 4. 生成 latest.json

```bash
python -c "
import json, datetime
sig = open('ImmersiveTranslator_X.Y.Z_x64-setup.exe.sig').read()
manifest = {
  'version': 'X.Y.Z',
  'notes': ' vX.Y.Z 更新说明',
  'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
  'platforms': {'windows-x86_64': {
    'signature': sig,
    'url': 'https://gh-proxy.com/https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/ImmersiveTranslator_X.Y.Z_x64-setup.exe'
  }}
}
json.dump(manifest, open('latest-vX.Y.Z.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)
"
```

注意：signature 是 **.sig 文件全文**（内含换行，json.dump 会转义）。

⚠️ **url 前缀是国内镜像**（`gh-proxy.com` 前缀 + GitHub 原链），无代理的国内用户
检查更新和下载安装包都走它。镜像失效时需要**同步换两处**：本脚本的前缀 +
`tauri.conf.json → plugins.updater.endpoints` 的前两行（候选镜像见下）。
安装包下载后客户端会用 pubkey 校验 minisign 签名，镜像篡改会被拒装，只可能失败不会中毒。
2026-09 实测可用（都能代理 Release 资产，按速度排序）：
`gh-proxy.com` > `ghfast.top` > `ghproxy.net` > `gh.ddlc.top`。

## 5. 上传到 GitHub Release

等 Release workflow 把 Release 创建出来（tag 推送后 15-30 分钟；轮询查状态）：

```bash
curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/kobejiasuoer/immersive-translator/actions/runs?per_page=5"
```

然后往 **同一个 tag 的 Release** 上传 3 个资产（⚠️ 清单文件必须叫 `latest.json`，
自动更新端点 `releases/latest/download/latest.json` 才能命中；本地留 `latest-vX.Y.Z.json` 归档）：

```bash
RID=$(curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/kobejiasuoer/immersive-translator/releases/tags/vX.Y.Z" \
  | python -c "import json,sys; print(json.load(sys.stdin)['id'])")
UPLOAD_URL="https://uploads.github.com/repos/kobejiasuoer/immersive-translator/releases/$RID/assets?name="
for f in "ImmersiveTranslator_X.Y.Z_x64-setup.exe" \
         "ImmersiveTranslator_X.Y.Z_x64-setup.exe.sig" \
         "latest-vX.Y.Z.json"; do
  NAME="$f"; [ "$f" = "latest-vX.Y.Z.json" ] && NAME="latest.json"
  curl -s -o /dev/null -w "$NAME -> HTTP %{http_code}\n" -X POST \
    -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary "@$f" "$UPLOAD_URL$NAME"    # 期望 201；409=重名，先 DELETE 旧资产
done
```

更新 Release 说明（中文功能清单；CI 创建时用的是 --generate-notes，直接覆盖 body）：

```bash
python -c "import json; json.dump({'body': '## 更新内容\n…'}, open('body.json','w',encoding='utf-8'))"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X PATCH \
  -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  --data-binary "@body.json" \
  "https://api.github.com/repos/kobejiasuoer/immersive-translator/releases/$RID"
```

## 6. 发布后验证

```bash
# 自动更新端点已指向新版本（老用户「检查更新」走的就是它）
curl -sL "https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/latest.json"
# ↑ version 应为新版本号；signature 应与本地 .sig 全文一致

# 国内镜像链路也验一遍（endpoints 第一优先 + latest.json 里的下载 url 都走它）
curl -sL --noproxy '*' "https://gh-proxy.com/https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/latest.json"
# ↑ 同样应返回新版本号，且 platforms...url 以 https://gh-proxy.com/ 开头

# tag 上 CI 全绿（audit / fmt / 测试门禁）
curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/kobejiasuoer/immersive-translator/actions/runs?per_page=5"
```

本地归档一份到 `release-builds/`（exe + sig + latest-vX.Y.Z.json）。

## 踩坑记录（每条都实际发生过）

1. **产物要与 tag 严格对应**：如果打 tag 后又修了 CI 门禁之类并重指了 tag
   （`git tag -f vX.Y.Z && git push -f origin vX.Y.Z`），记得用新提交**重建并重传**
   exe/sig/latest.json 三件套（同名资产先 DELETE 再 POST）。
2. **vite 转换缓存吞同秒连续编辑**（Windows 文件监视不可靠）：dev 窗口可能跑
   「半新半旧」模块——表现为改动行为不生效但源码正确。用
   `curl http://localhost:1420/src/reader/Xxx.tsx` 直接看 vite 吐的内容对不对；
   不对就随便改一下该文件强制重转换。**重启应用无效**（缓存在 vite 进程里）。
   详见 96fb6b1 / aa28730。
3. **npm 10 arborist 对混合源元数据报 `Cannot read properties of null (reading 'edgesOut')`**：
   npmmirror 镜像不支持 audit 端点，audit / audit fix / update 必须加
   `--registry=https://registry.npmjs.org`；arborist 报错时改用
   `npx -y npm@11 install --registry=https://registry.npmjs.org`（0.3.0 时靠它重建 lockfile）。
4. **依赖漏洞门禁**：`npm audit --audit-level=high` 是 CI 硬门禁。传递依赖的洞用
   package.json `overrides` 钉修复版（0.3.0 加了 browserslist / baseline-browser-mapping）。
5. **重启 dev 前先清场**：托盘应用关窗口不退进程。残留进程占热键 → 新实例
   `HotKey already registered` panic（exit 101）；残留 node 占 1420 → vite 起不来。
   `taskkill /IM immersive-translator-windows.exe /F` + 杀掉 1420 端口的 node。
6. **快速重启的窗口创建竞态**：上一实例的 WebView2 数据目录未释放时，配置里的
   窗口可能静默创建失败（表现为进程在、无窗口）。再启动一次即可。lib.rs 内有同款注释。
7. **cargo fmt 门禁**：`examples/` 下的探针脚本也在 `cargo fmt --all --check` 范围内，
   提交前 `cargo fmt --all` 一下省得 CI 红。
