#!/usr/bin/env bash
# 给指定版本的 Windows 安装包补「签名资产」（latest.json + .sig）并推送，
# updater-assets.yml 会自动把它们挂到对应 tag 的 GitHub Release。
# 完整背景见 immersive-translator-windows/RELEASE-CHECKLIST.md 第 7 步。
#
# 私钥：~/.tauri/immersive-translator-updater.key（口令为空串，v0.6.0 起如此）。
# -k 传的是「整个私钥文件再 base64 一层」，不是文件路径、也不是密钥体第二行。
#
# 用法（在仓库根目录）：
#   bash release-updater/sign.sh            # 默认补 0.11.0
#   bash release-updater/sign.sh 0.12.0     # 以后每个新版本传版本号即可
set -euo pipefail

VERSION="${1:-0.11.0}"
TAG="v$VERSION"
REPO="kobejiasuoer/immersive-translator"
ASSET="ImmersiveTranslator_${VERSION}_x64-setup.exe"
KEY="$HOME/.tauri/immersive-translator-updater.key"
WORK="$(cd "$(dirname "$0")/.." && pwd)"
APP="$WORK/immersive-translator-windows"

command -v npx >/dev/null || { echo "需要 Node/npx"; exit 1; }
[[ -f "$KEY" ]] || { echo "缺少 updater 私钥：$KEY"; exit 1; }

# 1) 下载 CI 产物到项目目录（⚠️ 别放 /tmp：MSYS 虚拟路径，原生 npx 会解析错位；
#    且 .sig 必须对 CI 产物签，本地构建字节不同）
cd "$APP"
EXE="ci-${VERSION}.exe"
echo "下载 $ASSET …"
curl -fL -o "$EXE" "https://github.com/$REPO/releases/download/$TAG/$ASSET" \
  || curl -fL -o "$EXE" "https://gh-proxy.com/https://github.com/$REPO/releases/download/$TAG/$ASSET"

# 2) 签名：-k = base64(私钥全文)，--password 空串（RELEASE-CHECKLIST §7 ②）
npx tauri signer sign -k "$(base64 -w0 "$KEY")" --password "" "$EXE"

# 3) 验 keynum == 723b366356af3935（RELEASE-CHECKLIST §7 ③）
KEYNUM="$(base64 -d "$EXE.sig" | sed -n '2p' | base64 -d | od -A n -t x1 | head -1 | tr -d ' \n' | cut -c5-20)"
[[ "$KEYNUM" == "723b366356af3935" ]] || { echo "keynum 不符：$KEYNUM（期望 723b366356af3935）"; exit 1; }
echo "keynum 校验通过"

# 4) latest.json：signature = .sig 文件内容（单行 base64）；url 走 gh-proxy 常青链
OUT="$WORK/release-updater/$TAG"
mkdir -p "$OUT"
SIG="$(cat "$EXE.sig")"
cat > "$OUT/latest.json" <<EOF
{
  "version": "$VERSION",
  "notes": " $TAG 更新说明",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "windows-x86_64": {
      "signature": "$SIG",
      "url": "https://gh-proxy.com/https://github.com/$REPO/releases/latest/download/$ASSET"
    }
  }
}
EOF
cp "$EXE.sig" "$OUT/$ASSET.sig"
rm -f "$EXE" "$EXE.sig"

# 5) 提交推送 → updater-assets workflow 自动挂到 Release 资产
cd "$WORK"
git add "release-updater/$TAG"
git commit -m "chore(updater): $TAG 签名资产" || echo "无变更需要提交（可能已传过）"
git push origin main
echo ""
echo "完成。updater-assets workflow 正在把 latest.json 与 .sig 挂到 $TAG Release。"
