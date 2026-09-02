#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# SwiftPM supplies XCTest's framework/module search paths to `swift test`.
# A bare `swift -e 'import XCTest'` does not, so it is not a valid probe.
# CI must never silently downgrade a failed or unavailable test target.
if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" || -n "${REQUIRE_SWIFT_TESTS:-}" ]]; then
    exec swift test "$@"
fi

if command -v xcrun >/dev/null 2>&1 && xcrun --find xctest >/dev/null 2>&1; then
    exec swift test "$@"
fi

if (( $# > 0 )); then
    echo "error: XCTest is unavailable in this Command Line Tools environment; cannot honor swift test arguments: $*" >&2
    exit 1
fi

echo "warning: XCTest is unavailable in the selected Swift toolchain; running limited ProviderCore regression checks instead." >&2
zsh "$ROOT_DIR/scripts/check_provider_presets.sh"
zsh "$ROOT_DIR/scripts/check_diagnostic_logger.sh"
