#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$ROOT_DIR/.." && pwd)"
APP_NAME="ImmersiveTranslator"

# 默认版本跟随最近一次发布 tag（发版版本号由 tag 决定），避免本地默认值过期。
default_app_version() {
    local tag
    tag="$(git -C "$REPO_DIR" describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null || true)"
    if [[ -n "$tag" ]]; then
        printf '%s\n' "${tag#v}"
    else
        printf '0.15.2\n'
    fi
}

# 默认更新源指向本仓库 GitHub Release 的 latest manifest；非 GitHub 远程则留空（禁用更新检查）。
default_update_manifest_url() {
    local remote
    remote="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
    remote="${remote%.git}"
    remote="${remote#git@github.com:}"
    remote="${remote#https://github.com/}"
    if [[ "$remote" == */* && "$remote" != *[:@]* && "$(printf '%s' "$remote" | tr -dc '/')" == "/" ]]; then
        printf 'https://github.com/%s/releases/latest/download/update-manifest.json\n' "$remote"
    fi
}

APP_VERSION="${APP_VERSION:-$(default_app_version)}"
APP_BUILD="${APP_BUILD:-1}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-local.immersive-translator.mvp}"
APP_UPDATE_MANIFEST_URL="${APP_UPDATE_MANIFEST_URL:-$(default_update_manifest_url)}"
APP_MINIMUM_SYSTEM_VERSION="${APP_MINIMUM_SYSTEM_VERSION:-13.0}"
# bundle 目录名用产品中文名：macOS 对第三方 App 的 Finder/启动台/macOS 26「App」页
# 显示名直接取 bundle 文件名（lproj/InfoPlist.strings 与 CFBundleName 都覆盖不了这些
# 视图），要显示「沉浸口语」就得叫 沉浸口语.app。可执行名/资源 bundle 名仍由 APP_NAME 决定。
APP_BUNDLE_DIRNAME="${APP_BUNDLE_DIRNAME:-沉浸口语}"
APP_DIR="$ROOT_DIR/dist/$APP_BUNDLE_DIRNAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
DEFAULT_LOCAL_CODESIGN_IDENTITY="ImmersiveTranslator Local Dev"

resolve_codesign_identity() {
    if ! command -v codesign >/dev/null 2>&1; then
        echo "error: codesign is required to build $APP_NAME.app on macOS." >&2
        exit 1
    fi

    if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
        if [[ "$CODESIGN_IDENTITY" == "-" ]]; then
            echo "warning: using explicit ad-hoc signing. macOS permissions may need re-approval after rebuilds." >&2
        fi
        printf '%s\n' "$CODESIGN_IDENTITY"
        return
    fi

    # 优先选带 Team ID 的证书（Apple Development / Developer ID Application）。
    # 钥匙串对无 Team ID 签名（自签名/ad-hoc）只能按 cdhash 记分区授权，
    # 每次重编译哈希都变，读 keychain 条目就会弹「想要使用密钥串」要密码；
    # 带 Team ID 的签名按 teamid:XXX 记授权，重编译不再弹。
    local team_id_identity
    team_id_identity="$(
        security find-identity -v -p codesigning 2>/dev/null |
            sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -n 1
    )"
    if [[ -z "$team_id_identity" ]]; then
        team_id_identity="$(
            security find-identity -v -p codesigning 2>/dev/null |
                sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1
        )"
    fi
    if [[ -n "$team_id_identity" ]]; then
        echo "codesign identity: $team_id_identity" >&2
        printf '%s\n' "$team_id_identity"
        return
    fi

    if command -v security >/dev/null 2>&1 && security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$DEFAULT_LOCAL_CODESIGN_IDENTITY\""; then
        echo "warning: no Team-ID signing identity found; falling back to '$DEFAULT_LOCAL_CODESIGN_IDENTITY'." >&2
        echo "warning: without a Team ID, Keychain re-prompts for access on every rebuild." >&2
        printf '%s\n' "$DEFAULT_LOCAL_CODESIGN_IDENTITY"
        return
    fi

    if [[ "${ALLOW_ADHOC_CODESIGN:-0}" == "1" ]]; then
        echo "warning: no fixed local codesign identity named '$DEFAULT_LOCAL_CODESIGN_IDENTITY' was found; using explicit ad-hoc signing." >&2
        echo "warning: ad-hoc builds may need Accessibility and Screen Recording re-approval after rebuilds." >&2
        printf '%s\n' "-"
        return
    fi

    cat >&2 <<EOF
error: no fixed local codesign identity was found.

Local app builds no longer fall back to ad-hoc signing by default, because ad-hoc
signatures often make macOS ask again for Accessibility and Screen Recording
permissions after rebuilds.

Create a self-signed Code Signing certificate named:
  $DEFAULT_LOCAL_CODESIGN_IDENTITY

Or use an existing stable identity explicitly (an Apple Development /
Developer ID identity is preferred — it carries a Team ID, which keeps
Keychain authorizations stable across rebuilds):
  security find-identity -v -p codesigning
  CODESIGN_IDENTITY="Your Code Signing Identity" ./scripts/build_app.sh

For release packaging or a one-off ad-hoc build, opt in explicitly:
  ALLOW_ADHOC_CODESIGN=1 ./scripts/build_app.sh
EOF
    exit 1
}

codesign_target() {
    local identity="$1"
    local target="$2"
    local args=(--force --sign "$identity")

    if [[ "${CODESIGN_HARDENED_RUNTIME:-0}" == "1" ]]; then
        args+=(--options runtime)
    fi

    if [[ "${CODESIGN_TIMESTAMP:-0}" == "1" ]]; then
        args+=(--timestamp)
    fi

    if [[ -n "${CODESIGN_ENTITLEMENTS:-}" ]]; then
        args+=(--entitlements "$CODESIGN_ENTITLEMENTS")
    fi

    codesign "${args[@]}" "$target" >/dev/null
}

xml_escape() {
    printf '%s' "$1" | sed \
        -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g' \
        -e "s/'/\&apos;/g"
}

cd "$ROOT_DIR"
swift build -c release

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp "$ROOT_DIR/.build/release/$APP_NAME" "$MACOS_DIR/$APP_NAME"
# SPM 资源 bundle（内置文库 / 考试词表）。放 Contents/Resources/：
# Bundle.module 的候选路径含 Bundle.main.resourceURL；放 MacOS/ 会被 codesign
# 当作内嵌裸 bundle 子组件拒绝签名。SPM 产物缺 Info.plist，在签名前补一个。
APP_BUNDLE_ID_ESCAPED="$(xml_escape "$APP_BUNDLE_ID")"
APP_VERSION_ESCAPED="$(xml_escape "$APP_VERSION")"
APP_BUILD_ESCAPED="$(xml_escape "$APP_BUILD")"
RESOURCE_BUNDLE="$ROOT_DIR/.build/release/${APP_NAME}_${APP_NAME}.bundle"
if [[ ! -d "$RESOURCE_BUNDLE" ]]; then
    echo "error: SPM resource bundle not found at $RESOURCE_BUNDLE" >&2
    exit 1
fi
cp -R "$RESOURCE_BUNDLE" "$RESOURCES_DIR/"
# Finder/启动台/macOS 26「App」页/Spotlight 对 App 显示名的解析优先级：
# 本地化 InfoPlist.strings > bundle 文件名，裸 CFBundleName/DisplayName key
# 不参与。要显示中文「沉浸口语」必须写入 lproj 本地化资源（签名前完成，会被 seal 进签名）。
APP_DISPLAY_NAME_ESCAPED="$(xml_escape "沉浸口语")"
for lang in zh_CN en; do
    mkdir -p "$RESOURCES_DIR/$lang.lproj"
    cat > "$RESOURCES_DIR/$lang.lproj/InfoPlist.strings" <<PSTR
/* 本地化 App 显示名：对齐 Windows productName「沉浸口语」（tauri.conf.json:3） */
"CFBundleName" = "$APP_DISPLAY_NAME_ESCAPED";
"CFBundleDisplayName" = "$APP_DISPLAY_NAME_ESCAPED";
PSTR
done
cat > "$RESOURCES_DIR/${APP_NAME}_${APP_NAME}.bundle/Info.plist" <<BPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${APP_BUNDLE_ID_ESCAPED}.resources</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}_${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>BNDL</string>
    <key>CFBundleShortVersionString</key>
    <string>${APP_VERSION_ESCAPED}</string>
    <key>CFBundleVersion</key>
    <string>${APP_BUILD_ESCAPED}</string>
</dict>
</plist>
BPLIST

cp "$ROOT_DIR/Resources/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
APP_BUNDLE_ID_ESCAPED="$(xml_escape "$APP_BUNDLE_ID")"
APP_VERSION_ESCAPED="$(xml_escape "$APP_VERSION")"
APP_BUILD_ESCAPED="$(xml_escape "$APP_BUILD")"
APP_UPDATE_MANIFEST_URL_ESCAPED="$(xml_escape "$APP_UPDATE_MANIFEST_URL")"
APP_MINIMUM_SYSTEM_VERSION_ESCAPED="$(xml_escape "$APP_MINIMUM_SYSTEM_VERSION")"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>zh_CN</string>
    <!-- 显示名（访达/启动台/App 页/强制退出）：对齐 Windows productName「沉浸口语」
         （tauri.conf.json:3）。CFBundleName 与 CFBundleDisplayName 都设为中文——
         macOS 26「App」启动器、Spotlight 元数据(kMDItemDisplayName)取 CFBundleName；
         CFBundleExecutable 保持 ImmersiveTranslator：联动 dist 路径、SPM 资源
         bundle 命名与 codesign 目标，不可改。 -->
    <key>CFBundleDisplayName</key>
    <string>沉浸口语</string>
    <key>CFBundleExecutable</key>
    <string>ImmersiveTranslator</string>
    <key>CFBundleIdentifier</key>
    <string>$APP_BUNDLE_ID_ESCAPED</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>沉浸口语</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$APP_VERSION_ESCAPED</string>
    <key>CFBundleVersion</key>
    <string>$APP_BUILD_ESCAPED</string>
    <key>LSMinimumSystemVersion</key>
    <string>$APP_MINIMUM_SYSTEM_VERSION_ESCAPED</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>ITUpdateManifestURL</key>
    <string>$APP_UPDATE_MANIFEST_URL_ESCAPED</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>跟读评测、口语陪练与录音直译需要使用麦克风录音，音频只送你配置的讯飞语音服务。</string>
</dict>
</plist>
PLIST

SIGN_IDENTITY="$(resolve_codesign_identity)"
codesign_target "$SIGN_IDENTITY" "$MACOS_DIR/$APP_NAME"
# SPM 资源 bundle 必须先单独签名，再签整个 app（内嵌未签名 bundle 会被拒）
if [[ -d "$RESOURCES_DIR/${APP_NAME}_${APP_NAME}.bundle" ]]; then
    codesign_target "$SIGN_IDENTITY" "$RESOURCES_DIR/${APP_NAME}_${APP_NAME}.bundle"
fi
codesign_target "$SIGN_IDENTITY" "$APP_DIR"
codesign --verify --strict --verbose=2 "$APP_DIR" >/dev/null

echo "$APP_DIR"
