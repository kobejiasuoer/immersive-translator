#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="ImmersiveTranslator"
VERSION="${1:-${APP_VERSION:-0.1.1}}"
BUILD="${APP_BUILD:-1}"
RELEASE_DIR="${RELEASE_DIR:-$ROOT_DIR/release}"
if [[ "$RELEASE_DIR" != /* ]]; then
    RELEASE_DIR="$ROOT_DIR/$RELEASE_DIR"
fi
APP_DIR="$ROOT_DIR/dist/$APP_NAME.app"
ZIP_PATH="$RELEASE_DIR/$APP_NAME-$VERSION-macOS.zip"
CHECKSUM_PATH="$ZIP_PATH.sha256"
MANIFEST_PATH="$RELEASE_DIR/update-manifest.json"
NOTARY_UPLOAD_ZIP="$RELEASE_DIR/$APP_NAME-$VERSION-notary-upload.zip"
CHECK_ONLY="${CHECK_ONLY:-0}"
CHECK_ERRORS=0
CHECK_WARNINGS=0
VALIDATED_ZIP_APP_RELATIVE_PATH=""
VALIDATED_ZIP_SIGNATURE_SUMMARY=""
VALIDATED_ZIP_GATEKEEPER_SUMMARY=""

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: $1 is required." >&2
        exit 1
    fi
}

json_escape() {
    printf '%s' "$1" | sed \
        -e 's/\\/\\\\/g' \
        -e 's/"/\\"/g'
}

release_asset_url() {
    local filename="$1"
    if [[ -n "${RELEASE_BASE_URL:-}" ]]; then
        printf '%s/%s\n' "${RELEASE_BASE_URL%/}" "$filename"
    else
        printf '%s\n' "$filename"
    fi
}

check_ok() {
    printf 'ok: %s\n' "$1"
}

check_warn() {
    CHECK_WARNINGS=$((CHECK_WARNINGS + 1))
    printf 'warning: %s\n' "$1"
}

check_error() {
    CHECK_ERRORS=$((CHECK_ERRORS + 1))
    printf 'error: %s\n' "$1" >&2
}

has_command() {
    command -v "$1" >/dev/null 2>&1
}

check_command() {
    if has_command "$1"; then
        check_ok "$1 found"
    else
        check_error "$1 is required"
    fi
}

is_http_url() {
    [[ "$1" == [Hh][Tt][Tt][Pp]://* || "$1" == [Hh][Tt][Tt][Pp][Ss]://* ]]
}

is_https_url() {
    [[ "$1" == [Hh][Tt][Tt][Pp][Ss]://* ]]
}

strip_url_query_fragment() {
    local value="${1%%#*}"
    value="${value%%\?*}"
    printf '%s\n' "$value"
}

url_directory() {
    local clean
    clean="$(strip_url_query_fragment "$1")"
    clean="${clean%/}"
    if [[ "$clean" == */* ]]; then
        printf '%s\n' "${clean%/*}"
    else
        printf '%s\n' "$clean"
    fi
}

is_probably_zip_url() {
    local clean
    clean="$(strip_url_query_fragment "$1")"
    [[ "$clean" == *.zip ]]
}

is_probably_release_file_url() {
    local clean
    clean="$(strip_url_query_fragment "$1")"
    clean="${clean%/}"
    [[ "$clean" == *.zip || "$clean" == *.json || "$clean" == *.sha256 || "$clean" == *.dmg ]]
}

has_url_scheme() {
    [[ "$1" =~ '^[A-Za-z][A-Za-z0-9+.-]*:' ]]
}

is_relative_manifest_url() {
    [[ -n "$1" ]] && [[ "$1" != //* ]] && ! has_url_scheme "$1"
}

codesign_identity_exists() {
    local identity="$1"
    has_command security || return 2
    security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$identity\""
}

has_notarytool_credentials() {
    [[ -n "${NOTARYTOOL_PROFILE:-}" ]] \
        || [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]] \
        || [[ -n "${APP_STORE_CONNECT_API_KEY:-}" && -n "${APP_STORE_CONNECT_KEY_ID:-}" && -n "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]
}

should_assess_gatekeeper() {
    [[ "${NOTARIZE:-0}" == "1" && "${SKIP_SPCTL_ASSESS:-0}" != "1" ]]
}

check_json_validator() {
    if has_command ruby; then
        check_ok "ruby JSON parser found"
    elif has_command python3; then
        check_ok "python3 JSON parser found"
    else
        check_error "ruby or python3 is required to validate update-manifest.json"
    fi
}

validate_json_file() {
    local file="$1"
    if has_command ruby; then
        ruby -rjson -e 'JSON.parse(File.read(ARGV.fetch(0)))' "$file" >/dev/null
    elif has_command python3; then
        python3 - "$file" <<'PY' >/dev/null
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    json.load(manifest_file)
PY
    else
        echo "error: ruby or python3 is required to validate update-manifest.json." >&2
        exit 1
    fi
}

json_manifest_value() {
    local file="$1"
    local key="$2"
    if has_command ruby; then
        ruby -rjson -e 'value = JSON.parse(File.read(ARGV.fetch(0)))[ARGV.fetch(1)]; puts value unless value.nil?' "$file" "$key"
    elif has_command python3; then
        python3 - "$file" "$key" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    value = json.load(manifest_file).get(sys.argv[2])
if value is not None:
    print(value)
PY
    else
        echo "error: ruby or python3 is required to inspect update-manifest.json." >&2
        exit 1
    fi
}

validate_update_manifest_schema() {
    local file="$1"
    if has_command ruby; then
        ruby -rjson -ruri -rtime -e '
manifest = JSON.parse(File.read(ARGV.fetch(0)))

def fail!(message)
  warn "error: #{message}"
  exit 1
end

def required_string(manifest, key)
  value = manifest[key]
  fail!("update manifest #{key} must be a non-empty string") unless value.is_a?(String) && !value.strip.empty?
  value.strip
end

def validate_version(value)
  fail!("update manifest version has an invalid format") unless value.match?(/\A[0-9]+([.][0-9]+)*([-+._A-Za-z0-9]*)?\z/)
end

def validate_build(value)
  fail!("update manifest build has an invalid format") unless value.match?(/\A[0-9]+([.][0-9]+)*\z/)
end

def validate_sha256(value)
  fail!("update manifest sha256 must be 64 lowercase hex characters") unless value.match?(/\A[0-9a-f]{64}\z/)
end

def required_positive_integer(manifest, key)
  value = manifest[key]
  fail!("update manifest #{key} must be a positive integer") unless value.is_a?(Integer) && value.positive?
  value
end

def validate_published_at(manifest)
  value = manifest["published_at"]
  return if value.nil?
  fail!("update manifest published_at must be a non-empty string") unless value.is_a?(String) && !value.strip.empty?
  begin
    Time.iso8601(value.strip)
  rescue ArgumentError
    fail!("update manifest published_at must be ISO-8601, for example 2026-06-10T12:34:56Z")
  end
end

def validate_manifest_url(manifest, key, required)
  value = manifest[key]
  if value.nil?
    fail!("update manifest #{key} is required") if required
    return
  end
  fail!("update manifest #{key} must be a string or null") unless value.is_a?(String)

  clean = value.strip
  fail!("update manifest #{key} cannot be empty") if clean.empty?
  if clean.start_with?("//")
    fail!("update manifest #{key} must be HTTP/HTTPS or a relative path, not a protocol-relative URL")
  end

  uri = URI.parse(clean) rescue nil
  scheme = uri && uri.scheme && uri.scheme.downcase
  return if scheme.nil?
  fail!("update manifest #{key} must be HTTP/HTTPS or a relative path") unless ["http", "https"].include?(scheme)
end

validate_version(required_string(manifest, "version"))
validate_build(required_string(manifest, "build"))
validate_sha256(required_string(manifest, "sha256"))
required_positive_integer(manifest, "size_bytes")
if manifest.key?("minimum_system_version")
  value = required_string(manifest, "minimum_system_version")
  fail!("update manifest minimum_system_version has an invalid format") unless value.match?(/\A[0-9]+([.][0-9]+)*\z/)
end
validate_manifest_url(manifest, "download_url", true)
validate_manifest_url(manifest, "release_notes_url", false)
validate_published_at(manifest)
' "$file" >/dev/null
    elif has_command python3; then
        python3 - "$file" <<'PY' >/dev/null
import json
import re
import sys
from datetime import datetime
from urllib.parse import urlparse


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def required_string(manifest, key):
    value = manifest.get(key)
    if not isinstance(value, str) or not value.strip():
        fail(f"update manifest {key} must be a non-empty string")
    return value.strip()


def validate_version(value):
    if not re.fullmatch(r"[0-9]+([.][0-9]+)*([-+._A-Za-z0-9]*)?", value):
        fail("update manifest version has an invalid format")


def validate_build(value):
    if not re.fullmatch(r"[0-9]+([.][0-9]+)*", value):
        fail("update manifest build has an invalid format")


def validate_sha256(value):
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        fail("update manifest sha256 must be 64 lowercase hex characters")


def required_positive_integer(manifest, key):
    value = manifest.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        fail(f"update manifest {key} must be a positive integer")
    return value


def validate_minimum_system_version(value):
    if not re.fullmatch(r"[0-9]+([.][0-9]+)*", value):
        fail("update manifest minimum_system_version has an invalid format")


def validate_published_at(manifest):
    value = manifest.get("published_at")
    if value is None:
        return
    if not isinstance(value, str) or not value.strip():
        fail("update manifest published_at must be a non-empty string")
    try:
        datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        fail("update manifest published_at must be ISO-8601, for example 2026-06-10T12:34:56Z")


def validate_manifest_url(manifest, key, required):
    value = manifest.get(key)
    if value is None:
        if required:
            fail(f"update manifest {key} is required")
        return
    if not isinstance(value, str):
        fail(f"update manifest {key} must be a string or null")

    clean = value.strip()
    if not clean:
        fail(f"update manifest {key} cannot be empty")
    if clean.startswith("//"):
        fail(f"update manifest {key} must be HTTP/HTTPS or a relative path, not a protocol-relative URL")

    scheme = urlparse(clean).scheme.lower()
    if scheme and scheme not in {"http", "https"}:
        fail(f"update manifest {key} must be HTTP/HTTPS or a relative path")


with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)

validate_version(required_string(manifest, "version"))
validate_build(required_string(manifest, "build"))
validate_sha256(required_string(manifest, "sha256"))
required_positive_integer(manifest, "size_bytes")
if "minimum_system_version" in manifest:
    validate_minimum_system_version(required_string(manifest, "minimum_system_version"))
validate_manifest_url(manifest, "download_url", True)
validate_manifest_url(manifest, "release_notes_url", False)
validate_published_at(manifest)
PY
    else
        echo "error: ruby or python3 is required to validate update-manifest.json." >&2
        exit 1
    fi
}

validate_manifest_transport_security() {
    local file="$1"
    local manifest_url="${APP_UPDATE_MANIFEST_URL:-}"
    local field
    local value

    if ! is_https_url "$manifest_url"; then
        return 0
    fi

    for field in download_url release_notes_url; do
        value="$(json_manifest_value "$file" "$field")"
        if is_http_url "$value" && ! is_https_url "$value"; then
            echo "error: APP_UPDATE_MANIFEST_URL is HTTPS but update manifest $field uses HTTP: $value" >&2
            echo "Use HTTPS for absolute update asset URLs, or use a relative path next to update-manifest.json." >&2
            exit 1
        fi
    done
}

plist_value() {
    local plist="$1"
    local key="$2"
    if has_command plutil; then
        plutil -extract "$key" raw -o - "$plist" 2>/dev/null || true
    elif has_command /usr/libexec/PlistBuddy; then
        /usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null || true
    else
        echo "error: plutil or PlistBuddy is required to inspect Info.plist." >&2
        exit 1
    fi
}

validate_app_bundle_metadata_at() {
    local app_dir="$1"
    local label="${2:-app bundle}"
    local info_plist="$app_dir/Contents/Info.plist"
    local executable="$app_dir/Contents/MacOS/$APP_NAME"
    local expected_bundle_id="${APP_BUNDLE_ID:-local.immersive-translator.mvp}"
    local expected_update_url="${APP_UPDATE_MANIFEST_URL:-}"
    local expected_minimum_system_version="${APP_MINIMUM_SYSTEM_VERSION:-13.0}"

    if [[ ! -d "$app_dir" ]]; then
        echo "error: $label is missing: $app_dir" >&2
        exit 1
    fi
    if [[ ! -x "$executable" ]]; then
        echo "error: $label executable is missing or not executable: $executable" >&2
        exit 1
    fi
    if [[ ! -s "$info_plist" ]]; then
        echo "error: $label Info.plist is missing or empty: $info_plist" >&2
        exit 1
    fi

    local actual_version
    actual_version="$(plist_value "$info_plist" CFBundleShortVersionString)"
    local actual_build
    actual_build="$(plist_value "$info_plist" CFBundleVersion)"
    local actual_bundle_id
    actual_bundle_id="$(plist_value "$info_plist" CFBundleIdentifier)"
    local actual_executable
    actual_executable="$(plist_value "$info_plist" CFBundleExecutable)"
    local actual_update_url
    actual_update_url="$(plist_value "$info_plist" ITUpdateManifestURL)"
    local actual_minimum_system_version
    actual_minimum_system_version="$(plist_value "$info_plist" LSMinimumSystemVersion)"

    if [[ "$actual_version" != "$VERSION" ]]; then
        echo "error: $label Info.plist version mismatch. expected '$VERSION', got '$actual_version'." >&2
        exit 1
    fi
    if [[ "$actual_build" != "$BUILD" ]]; then
        echo "error: $label Info.plist build mismatch. expected '$BUILD', got '$actual_build'." >&2
        exit 1
    fi
    if [[ "$actual_bundle_id" != "$expected_bundle_id" ]]; then
        echo "error: $label Info.plist bundle id mismatch. expected '$expected_bundle_id', got '$actual_bundle_id'." >&2
        exit 1
    fi
    if [[ "$actual_executable" != "$APP_NAME" ]]; then
        echo "error: $label Info.plist executable mismatch. expected '$APP_NAME', got '$actual_executable'." >&2
        exit 1
    fi
    if [[ "$actual_update_url" != "$expected_update_url" ]]; then
        echo "error: $label Info.plist update manifest URL mismatch. expected '$expected_update_url', got '$actual_update_url'." >&2
        exit 1
    fi
    if [[ "$actual_minimum_system_version" != "$expected_minimum_system_version" ]]; then
        echo "error: $label Info.plist minimum system version mismatch. expected '$expected_minimum_system_version', got '$actual_minimum_system_version'." >&2
        exit 1
    fi
}

validate_app_bundle_metadata() {
    validate_app_bundle_metadata_at "$APP_DIR" "app bundle"
}

code_signature_summary() {
    local app_dir="$1"
    local details
    details="$(codesign -dv --verbose=4 "$app_dir" 2>&1 || true)"

    local summary
    summary="$(printf '%s\n' "$details" | sed -nE 's/^Authority=(Developer ID Application.*)/\1/p' | head -n 1)"
    if [[ -n "$summary" ]]; then
        printf '%s\n' "$summary"
        return
    fi

    summary="$(printf '%s\n' "$details" | sed -nE 's/^Authority=(.*)/\1/p' | head -n 1)"
    if [[ -n "$summary" ]]; then
        printf '%s\n' "$summary"
        return
    fi

    if printf '%s\n' "$details" | grep -q '^Signature=adhoc$'; then
        printf '%s\n' "ad-hoc signing"
    else
        printf '%s\n' "code signature structure verified"
    fi
}

validate_release_zip_contents() {
    require_command ditto
    require_command codesign

    local extraction_dir
    extraction_dir="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-release-zip.XXXXXX")"

    {
        local ditto_output
        if ! ditto_output="$(ditto -x -k "$ZIP_PATH" "$extraction_dir" 2>&1)"; then
            echo "error: release zip could not be extracted for validation: $ZIP_PATH" >&2
            if [[ -n "$ditto_output" ]]; then
                echo "$ditto_output" >&2
            fi
            exit 1
        fi

        local -a app_bundles
        app_bundles=()
        local app_bundle
        while IFS= read -r app_bundle; do
            app_bundles+=("$app_bundle")
        done < <(find "$extraction_dir" -name "*.app" -type d -prune -print | sort)

        if [[ "${#app_bundles[@]}" -eq 0 ]]; then
            echo "error: release zip does not contain an installable .app bundle." >&2
            exit 1
        fi
        if [[ "${#app_bundles[@]}" -gt 1 ]]; then
            echo "error: release zip contains multiple .app bundles; keep exactly one installable app." >&2
            printf '  %s\n' "${app_bundles[@]#$extraction_dir/}" >&2
            exit 1
        fi

        local extracted_app="${app_bundles[1]}"
        local relative_app_path="${extracted_app#$extraction_dir/}"
        local expected_relative_app_path="$APP_NAME.app"
        if [[ "$relative_app_path" != "$expected_relative_app_path" ]]; then
            echo "error: release zip app path mismatch. expected '$expected_relative_app_path', got '$relative_app_path'." >&2
            exit 1
        fi

        validate_app_bundle_metadata_at "$extracted_app" "release zip app '$relative_app_path'"

        local codesign_output
        if ! codesign_output="$(codesign --verify --deep --strict --verbose=2 "$extracted_app" 2>&1)"; then
            echo "error: release zip app code signature could not be verified: $relative_app_path" >&2
            if [[ -n "$codesign_output" ]]; then
                echo "$codesign_output" >&2
            fi
            exit 1
        fi

        if should_assess_gatekeeper; then
            require_command spctl
            local spctl_output
            if ! spctl_output="$(spctl --assess --type execute --verbose=4 "$extracted_app" 2>&1)"; then
                echo "error: release zip app failed Gatekeeper assessment: $relative_app_path" >&2
                if [[ -n "$spctl_output" ]]; then
                    echo "$spctl_output" >&2
                fi
                exit 1
            fi
            VALIDATED_ZIP_GATEKEEPER_SUMMARY="Gatekeeper assessment passed"
        else
            VALIDATED_ZIP_GATEKEEPER_SUMMARY="not run"
        fi

        VALIDATED_ZIP_APP_RELATIVE_PATH="$relative_app_path"
        VALIDATED_ZIP_SIGNATURE_SUMMARY="$(code_signature_summary "$extracted_app")"
    } always {
        rm -rf "$extraction_dir"
    }
}

run_release_preflight() {
    local zip_filename="$APP_NAME-$VERSION-macOS.zip"
    local planned_download_url="${RELEASE_DOWNLOAD_URL:-$(release_asset_url "$zip_filename")}"
    local bundle_id="${APP_BUNDLE_ID:-local.immersive-translator.mvp}"
    local manifest_dir=""
    if [[ -n "${APP_UPDATE_MANIFEST_URL:-}" ]] && is_http_url "$APP_UPDATE_MANIFEST_URL"; then
        manifest_dir="$(url_directory "$APP_UPDATE_MANIFEST_URL")"
    fi

    echo "ImmersiveTranslator release preflight"
    echo "version: $VERSION"
    echo "build: $BUILD"
    echo "bundle id: $bundle_id"
    echo "notarize: ${NOTARIZE:-0}"
    echo "planned download_url: $planned_download_url"
    echo

    check_command swift
    check_command codesign
    check_command ditto
    check_command shasum
    check_command plutil
    check_json_validator

    if [[ -z "$VERSION" ]]; then
        check_error "release version is empty"
    elif [[ "$VERSION" =~ '^[0-9]+([.][0-9]+)*([-+._A-Za-z0-9]*)?$' ]]; then
        check_ok "version format looks usable"
    else
        check_warn "version '$VERSION' is unusual; CFBundleShortVersionString is usually numeric, for example 1.2.3"
    fi

    if [[ -z "$BUILD" ]]; then
        check_error "APP_BUILD is empty"
    elif [[ "$BUILD" =~ '^[0-9]+([.][0-9]+)*$' ]]; then
        check_ok "build format looks usable"
    else
        check_warn "APP_BUILD '$BUILD' is unusual; CFBundleVersion is usually numeric, for example 42"
    fi

    if [[ -n "${APP_MINIMUM_SYSTEM_VERSION:-}" ]]; then
        if [[ "$APP_MINIMUM_SYSTEM_VERSION" =~ '^[0-9]+([.][0-9]+)*$' ]]; then
            check_ok "APP_MINIMUM_SYSTEM_VERSION format looks usable"
        else
            check_error "APP_MINIMUM_SYSTEM_VERSION must look like 13.0 or 14.5.1"
        fi
    fi

    if [[ "$bundle_id" == "local.immersive-translator.mvp" ]]; then
        check_warn "APP_BUNDLE_ID is still the local default; use a stable reverse-DNS id for public releases"
    elif [[ "$bundle_id" =~ '^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*){2,}$' ]]; then
        check_ok "APP_BUNDLE_ID looks like a stable reverse-DNS id"
    elif [[ "$bundle_id" =~ '^[A-Za-z0-9.-]+$' && "$bundle_id" == *.* ]]; then
        check_warn "APP_BUNDLE_ID is customized but does not look like a stable reverse-DNS id, for example com.example.ImmersiveTranslator"
    else
        check_error "APP_BUNDLE_ID contains characters outside letters, numbers, hyphen, and period"
    fi

    if [[ -n "${CODESIGN_ENTITLEMENTS:-}" ]]; then
        if [[ -f "$CODESIGN_ENTITLEMENTS" ]]; then
            check_ok "CODESIGN_ENTITLEMENTS file exists"
        else
            check_error "CODESIGN_ENTITLEMENTS points to a missing file: $CODESIGN_ENTITLEMENTS"
        fi
    fi

    if [[ "${NOTARIZE:-0}" == "1" ]]; then
        check_command xcrun
        if [[ "${SKIP_SPCTL_ASSESS:-0}" != "1" ]]; then
            check_command spctl
        else
            check_warn "SKIP_SPCTL_ASSESS=1 skips Gatekeeper assessment for the notarized app and final release zip"
        fi

        if [[ -z "${CODESIGN_IDENTITY:-}" || "${CODESIGN_IDENTITY:-}" == "-" ]]; then
            check_error "NOTARIZE=1 requires CODESIGN_IDENTITY to be a Developer ID Application certificate"
        elif [[ "$CODESIGN_IDENTITY" != *"Developer ID Application"* && "${ALLOW_NON_DEVELOPER_ID_NOTARIZATION:-0}" != "1" ]]; then
            check_error "CODESIGN_IDENTITY should contain 'Developer ID Application' for notarization"
        else
            check_ok "Developer ID signing identity is configured"
            if codesign_identity_exists "$CODESIGN_IDENTITY"; then
                check_ok "Developer ID identity is present in the keychain"
            else
                check_error "CODESIGN_IDENTITY was not found by security find-identity: $CODESIGN_IDENTITY"
            fi
        fi

        if has_notarytool_credentials; then
            check_ok "notarytool credentials are configured"
        else
            check_error "notarization credentials are missing"
        fi
    else
        if [[ -z "${CODESIGN_IDENTITY:-}" || "${CODESIGN_IDENTITY:-}" == "-" ]]; then
            check_warn "release package will use ad-hoc signing; macOS Gatekeeper will not treat this as a verified public release"
        elif codesign_identity_exists "$CODESIGN_IDENTITY"; then
            check_ok "codesign identity is present in the keychain"
        else
            check_warn "CODESIGN_IDENTITY was not found by security find-identity: $CODESIGN_IDENTITY"
        fi
    fi

    if [[ -z "${APP_UPDATE_MANIFEST_URL:-}" ]]; then
        check_warn "APP_UPDATE_MANIFEST_URL is empty; packaged app will not offer update checks"
    elif is_http_url "$APP_UPDATE_MANIFEST_URL"; then
        if is_https_url "$APP_UPDATE_MANIFEST_URL"; then
            check_ok "APP_UPDATE_MANIFEST_URL is HTTPS"
        else
            check_warn "APP_UPDATE_MANIFEST_URL uses HTTP; HTTPS is recommended for public updates"
        fi
        if [[ "$(strip_url_query_fragment "$APP_UPDATE_MANIFEST_URL")" != *.json ]]; then
            check_warn "APP_UPDATE_MANIFEST_URL does not look like a JSON manifest file; make sure it points directly to the hosted update manifest"
        fi
    else
        check_error "APP_UPDATE_MANIFEST_URL must be an HTTP/HTTPS URL"
    fi

    if [[ -n "${RELEASE_BASE_URL:-}" ]]; then
        if is_http_url "$RELEASE_BASE_URL"; then
            check_ok "RELEASE_BASE_URL is HTTP/HTTPS"
            if is_https_url "${APP_UPDATE_MANIFEST_URL:-}" && ! is_https_url "$RELEASE_BASE_URL"; then
                if [[ -z "${RELEASE_DOWNLOAD_URL:-}" ]]; then
                    check_error "APP_UPDATE_MANIFEST_URL is HTTPS but RELEASE_BASE_URL is HTTP; generated update download_url would be rejected by the app"
                else
                    check_warn "RELEASE_BASE_URL is HTTP but RELEASE_DOWNLOAD_URL overrides it for manifest download_url"
                fi
            fi
            if is_probably_release_file_url "$RELEASE_BASE_URL"; then
                check_warn "RELEASE_BASE_URL looks like a file URL; use a directory URL or set RELEASE_DOWNLOAD_URL explicitly"
            fi
        else
            check_error "RELEASE_BASE_URL must be an HTTP/HTTPS URL"
        fi
    fi

    if [[ -n "${RELEASE_DOWNLOAD_URL:-}" ]]; then
        if [[ -n "${RELEASE_BASE_URL:-}" ]]; then
            check_warn "RELEASE_DOWNLOAD_URL overrides RELEASE_BASE_URL for manifest download_url"
        fi
        if is_http_url "$RELEASE_DOWNLOAD_URL"; then
            check_ok "RELEASE_DOWNLOAD_URL is HTTP/HTTPS"
            if is_https_url "${APP_UPDATE_MANIFEST_URL:-}" && ! is_https_url "$RELEASE_DOWNLOAD_URL"; then
                check_error "APP_UPDATE_MANIFEST_URL is HTTPS but RELEASE_DOWNLOAD_URL is HTTP; update download_url would be rejected by the app"
            fi
        elif is_relative_manifest_url "$RELEASE_DOWNLOAD_URL"; then
            if [[ -n "$manifest_dir" ]]; then
                check_ok "RELEASE_DOWNLOAD_URL is relative and will resolve against $manifest_dir"
            else
                check_warn "RELEASE_DOWNLOAD_URL is relative but APP_UPDATE_MANIFEST_URL is empty; app update checks are disabled until a manifest URL is configured"
            fi
        else
            check_error "RELEASE_DOWNLOAD_URL must be HTTP/HTTPS or a relative URL"
        fi
    elif [[ -z "${RELEASE_BASE_URL:-}" ]]; then
        if [[ -n "$manifest_dir" ]]; then
            check_warn "manifest download_url will be the relative filename '$zip_filename'; upload the zip next to APP_UPDATE_MANIFEST_URL"
        else
            check_warn "manifest download_url will be a relative filename; upload the zip next to update-manifest.json when APP_UPDATE_MANIFEST_URL is configured"
        fi
    else
        check_ok "manifest download_url will be generated from RELEASE_BASE_URL"
    fi

    if is_probably_zip_url "$planned_download_url"; then
        check_ok "planned download_url points to a .zip asset"
    else
        check_warn "planned download_url does not end with .zip; make sure it downloads the release zip directly"
    fi

    if [[ -n "${RELEASE_NOTES_URL:-}" ]]; then
        if is_http_url "$RELEASE_NOTES_URL"; then
            check_ok "RELEASE_NOTES_URL is HTTP/HTTPS"
            if is_https_url "${APP_UPDATE_MANIFEST_URL:-}" && ! is_https_url "$RELEASE_NOTES_URL"; then
                check_error "APP_UPDATE_MANIFEST_URL is HTTPS but RELEASE_NOTES_URL is HTTP; update release_notes_url would be rejected by the app"
            fi
        elif is_relative_manifest_url "$RELEASE_NOTES_URL"; then
            if [[ -n "$manifest_dir" ]]; then
                check_ok "RELEASE_NOTES_URL is relative and will resolve against $manifest_dir"
            else
                check_warn "RELEASE_NOTES_URL is relative but APP_UPDATE_MANIFEST_URL is empty; app update checks are disabled until a manifest URL is configured"
            fi
        else
            check_error "RELEASE_NOTES_URL must be HTTP/HTTPS or a relative URL"
        fi
    fi

    echo
    if [[ "$CHECK_ERRORS" -gt 0 ]]; then
        echo "release preflight failed: $CHECK_ERRORS error(s), $CHECK_WARNINGS warning(s)." >&2
        exit 1
    fi
    echo "release preflight passed: $CHECK_WARNINGS warning(s)."
}

build_app_for_release() {
    local identity="${1:-${CODESIGN_IDENTITY:-}}"
    local hardened_runtime="${2:-${CODESIGN_HARDENED_RUNTIME:-0}}"
    local timestamp="${3:-${CODESIGN_TIMESTAMP:-0}}"

    if [[ -n "$identity" ]]; then
        APP_VERSION="$VERSION" \
            APP_BUILD="$BUILD" \
            APP_BUNDLE_ID="${APP_BUNDLE_ID:-local.immersive-translator.mvp}" \
            APP_UPDATE_MANIFEST_URL="${APP_UPDATE_MANIFEST_URL:-}" \
            APP_MINIMUM_SYSTEM_VERSION="${APP_MINIMUM_SYSTEM_VERSION:-13.0}" \
            CODESIGN_IDENTITY="$identity" \
            CODESIGN_HARDENED_RUNTIME="$hardened_runtime" \
            CODESIGN_TIMESTAMP="$timestamp" \
            "$ROOT_DIR/scripts/build_app.sh"
    else
        APP_VERSION="$VERSION" \
            APP_BUILD="$BUILD" \
            APP_BUNDLE_ID="${APP_BUNDLE_ID:-local.immersive-translator.mvp}" \
            APP_UPDATE_MANIFEST_URL="${APP_UPDATE_MANIFEST_URL:-}" \
            APP_MINIMUM_SYSTEM_VERSION="${APP_MINIMUM_SYSTEM_VERSION:-13.0}" \
            CODESIGN_HARDENED_RUNTIME="$hardened_runtime" \
            CODESIGN_TIMESTAMP="$timestamp" \
            "$ROOT_DIR/scripts/build_app.sh"
    fi
}

notarytool_credentials_args() {
    if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
        NOTARYTOOL_ARGS=(--keychain-profile "$NOTARYTOOL_PROFILE")
        return
    fi

    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
        NOTARYTOOL_ARGS=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
        return
    fi

    if [[ -n "${APP_STORE_CONNECT_API_KEY:-}" && -n "${APP_STORE_CONNECT_KEY_ID:-}" && -n "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
        NOTARYTOOL_ARGS=(--key "$APP_STORE_CONNECT_API_KEY" --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID")
        return
    fi

    cat >&2 <<EOF
error: notarization credentials are missing.

Set one of:
  NOTARYTOOL_PROFILE="profile saved by xcrun notarytool store-credentials"
  APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD
  APP_STORE_CONNECT_API_KEY, APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID
EOF
    exit 1
}

notarize_and_staple() {
    require_command xcrun

    if [[ -z "${CODESIGN_IDENTITY:-}" || "$CODESIGN_IDENTITY" == "-" ]]; then
        echo "error: NOTARIZE=1 requires CODESIGN_IDENTITY to be a Developer ID Application certificate." >&2
        exit 1
    fi

    if [[ "$CODESIGN_IDENTITY" != *"Developer ID Application"* && "${ALLOW_NON_DEVELOPER_ID_NOTARIZATION:-0}" != "1" ]]; then
        echo "error: CODESIGN_IDENTITY should be a Developer ID Application identity for notarization." >&2
        echo "       Set ALLOW_NON_DEVELOPER_ID_NOTARIZATION=1 only if you know this identity is valid for notarytool." >&2
        exit 1
    fi

    build_app_for_release "$CODESIGN_IDENTITY" 1 1
    codesign --verify --strict --verbose=2 "$APP_DIR" >/dev/null

    ditto -c -k --keepParent "$APP_DIR" "$NOTARY_UPLOAD_ZIP"
    notarytool_credentials_args
    xcrun notarytool submit "$NOTARY_UPLOAD_ZIP" --wait "${NOTARYTOOL_ARGS[@]}"
    xcrun stapler staple "$APP_DIR"
    xcrun stapler validate "$APP_DIR"

    if [[ "${SKIP_SPCTL_ASSESS:-0}" != "1" ]]; then
        spctl --assess --type execute --verbose=4 "$APP_DIR"
    fi

    rm -f "$NOTARY_UPLOAD_ZIP"
}

validate_release_artifacts() {
    if [[ ! -s "$ZIP_PATH" ]]; then
        echo "error: release zip is missing or empty: $ZIP_PATH" >&2
        exit 1
    fi
    if [[ ! -s "$CHECKSUM_PATH" ]]; then
        echo "error: checksum file is missing or empty: $CHECKSUM_PATH" >&2
        exit 1
    fi
    if [[ ! -s "$MANIFEST_PATH" ]]; then
        echo "error: update manifest is missing or empty: $MANIFEST_PATH" >&2
        exit 1
    fi

    shasum -a 256 -c "$CHECKSUM_PATH" >/dev/null
    validate_json_file "$MANIFEST_PATH"
    validate_update_manifest_schema "$MANIFEST_PATH"
    validate_manifest_transport_security "$MANIFEST_PATH"

    local checksum_sha
    checksum_sha="$(awk '{print $1}' "$CHECKSUM_PATH")"
    local manifest_sha
    manifest_sha="$(sed -nE 's/^[[:space:]]*"sha256"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})".*/\1/p' "$MANIFEST_PATH")"
    local actual_zip_size
    actual_zip_size="$(wc -c < "$ZIP_PATH" | tr -d '[:space:]')"
    local manifest_size
    manifest_size="$(json_manifest_value "$MANIFEST_PATH" size_bytes)"

    if [[ -z "$manifest_sha" ]]; then
        echo "error: update manifest does not contain a valid lowercase sha256 value." >&2
        exit 1
    fi
    if [[ "$checksum_sha" != "$manifest_sha" ]]; then
        echo "error: manifest sha256 does not match checksum file." >&2
        echo "checksum: $checksum_sha" >&2
        echo "manifest: $manifest_sha" >&2
        exit 1
    fi
    if [[ "$actual_zip_size" != "$manifest_size" ]]; then
        echo "error: manifest size_bytes does not match release zip size." >&2
        echo "zip: $actual_zip_size" >&2
        echo "manifest: $manifest_size" >&2
        exit 1
    fi

    validate_release_zip_contents

    echo "Validated release artifacts:"
    echo "  zip: $ZIP_PATH"
    echo "  zip app: $VALIDATED_ZIP_APP_RELATIVE_PATH"
    echo "  size_bytes: $actual_zip_size"
    echo "  sha256: $checksum_sha"
    echo "  signature: $VALIDATED_ZIP_SIGNATURE_SUMMARY"
    echo "  gatekeeper: $VALIDATED_ZIP_GATEKEEPER_SUMMARY"
    echo "  manifest: $MANIFEST_PATH"
}

cd "$ROOT_DIR"

if [[ "$CHECK_ONLY" == "1" ]]; then
    run_release_preflight
    exit 0
fi

require_command ditto
require_command shasum

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

if [[ "${NOTARIZE:-0}" == "1" ]]; then
    notarize_and_staple
else
    if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
        build_app_for_release "$CODESIGN_IDENTITY"
    else
        build_app_for_release "-"
    fi
    codesign --verify --strict --verbose=2 "$APP_DIR" >/dev/null
fi

validate_app_bundle_metadata

ditto -c -k --keepParent "$APP_DIR" "$ZIP_PATH"
shasum -a 256 "$ZIP_PATH" > "$CHECKSUM_PATH"
ZIP_SIZE_BYTES="$(wc -c < "$ZIP_PATH" | tr -d '[:space:]')"
ZIP_SHA256="$(awk '{print $1}' "$CHECKSUM_PATH")"
ZIP_FILENAME="$(basename "$ZIP_PATH")"
DOWNLOAD_URL="${RELEASE_DOWNLOAD_URL:-$(release_asset_url "$ZIP_FILENAME")}"
RELEASE_NOTES_JSON="null"
if [[ -n "${RELEASE_NOTES_URL:-}" ]]; then
    RELEASE_NOTES_JSON="\"$(json_escape "$RELEASE_NOTES_URL")\""
fi
PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$MANIFEST_PATH" <<JSON
{
  "version": "$(json_escape "$VERSION")",
  "build": "$(json_escape "$BUILD")",
  "minimum_system_version": "${APP_MINIMUM_SYSTEM_VERSION:-13.0}",
  "download_url": "$(json_escape "$DOWNLOAD_URL")",
  "size_bytes": $ZIP_SIZE_BYTES,
  "sha256": "$ZIP_SHA256",
  "release_notes_url": $RELEASE_NOTES_JSON,
  "published_at": "$PUBLISHED_AT"
}
JSON

validate_release_artifacts

echo "$ZIP_PATH"
echo "$CHECKSUM_PATH"
echo "$MANIFEST_PATH"
