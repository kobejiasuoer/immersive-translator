# Windows 发布实战清单（以 v0.3.0 实际验证为准）

> 一次「版本号 → 本地构建 → 上传 GitHub Release」的完整流程记录。
> 签名原理与证书体系见 `UPDATE-SETUP.md`；本文是**按顺序照做即可成功**的操作清单，
> 包含 2026-09 发布 0.3.0 时实际踩过的坑。

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
    'url': 'https://github.com/kobejiasuoer/immersive-translator/releases/latest/download/ImmersiveTranslator_X.Y.Z_x64-setup.exe'
  }}
}
json.dump(manifest, open('latest-vX.Y.Z.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)
"
```

注意：signature 是 **.sig 文件全文**（内含换行，json.dump 会转义）。

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
