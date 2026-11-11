#!/bin/bash
# 沉浸口语 iOS 免费账号签名续期(免费 Personal Team profile 只有 7 天有效期)
#
# 用法: bash scripts/resign-ios.sh
# 前提: iPhone 已用 USB 连接本机并在 Xcode 里配对;代码自上次打包后未变。
#
# 原理: profile 过期 ≠ 需要重新编译。直接对 gen/apple/build 下的既有 xcarchive
# 重新签名导出即可,几分钟完成。若 App 代码有改动,先跑一次:
#   npm run tauri ios build   (生成新的 imreader-mobile_iOS.xcarchive,再跑本脚本)
set -euo pipefail

UDID="79CCCDC3-4EB4-5033-B69D-079E8F82AAB4"  # iPhone 17「至始至终的iphone」(devicectl identifier)
APPLE_DIR="$(cd "$(dirname "$0")/../src-tauri/gen/apple" && pwd)"
ARCHIVE="$APPLE_DIR/build/imreader-mobile_iOS.xcarchive"
OUT="$APPLE_DIR/build/resign-$(date +%Y%m%d-%H%M)"

# 防呆:归档里的可执行名必须是 ASCII 的 immersive-speaking。
# 2026-11-07 实测 build/ 下的旧归档还是中文可执行名「沉浸口语」(11-04 启动闪退版),
# 直接重签会把闪退包装回手机。归档过期时先跑 npm run tauri ios build 重新生成。
ARCHIVE_EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \
  "$ARCHIVE/Products/Applications/"*.app/Info.plist 2>/dev/null || true)"
if [ "$ARCHIVE_EXE" != "immersive-speaking" ]; then
  echo "❌ 归档可执行名是「$ARCHIVE_EXE」,不是 immersive-speaking——这是 11-04 修复前的闪退产物。" >&2
  echo "   先执行 npm run tauri ios build 生成新归档,再跑本脚本。" >&2
  exit 1
fi

# xcodebuild 的 Apple ID 会话经常悄悄失效(报 "exportArchive No Accounts"),
# 先启动一次 Xcode 让它恢复会话再导出——2026-10-19 实测这一步是关键
open -a Xcode
sleep 15

mkdir -p "$OUT"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$OUT" \
  -exportOptionsPlist "$APPLE_DIR/build/ExportOptions.plist" \
  -allowProvisioningUpdates

IPA="$(find "$OUT" -maxdepth 1 -name '*.ipa' | head -1)"
xcrun devicectl device install app --device "$UDID" "$IPA"
echo ""
echo "✅ 已安装到手机。若首次打开提示不受信任的开发者:"
echo "   设置 → 通用 → VPN与设备管理 → Apple Development: 1448950074@qq.com → 信任"
