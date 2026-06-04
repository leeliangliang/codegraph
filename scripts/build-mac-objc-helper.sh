#!/usr/bin/env bash
#
# Build the universal macOS binary for the codegraph-xchelper Swift helper and
# drop it into packages/mac-objc-enricher/bin/ so that subpackage is ready to
# publish.
#
# Workflow:
#   1. swift build -c release --arch arm64   (Apple Silicon slice)
#   2. swift build -c release --arch x86_64  (Intel slice)
#   3. lipo -create the two together
#   4. chmod +x; lipo -info to confirm both arches are present
#
# Both slices need their SDKs installed (xcode-select -p must point at a real
# Xcode, not just Command Line Tools, because the Intel slice depends on the
# macosx SDK's x86_64 stubs that the CLT-only SDK ships only on Intel hosts).
#
# Usage:
#   bash scripts/build-mac-objc-helper.sh
#
# Exit codes:
#   0  binary built and verified universal
#   1  prerequisites missing (swift, lipo) or build failed
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-mac-objc-helper] This script runs on macOS only — current uname=$(uname -s)" >&2
  exit 1
fi

command -v swift >/dev/null 2>&1 || { echo "[build-mac-objc-helper] swift not found in PATH — install Xcode CLI Tools" >&2; exit 1; }
command -v lipo  >/dev/null 2>&1 || { echo "[build-mac-objc-helper] lipo not found — install Xcode CLI Tools" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SWIFT_PROJ="$ROOT/src/extraction/semantic-objc/swift"
OUT_DIR="$ROOT/packages/mac-objc-enricher/bin"
OUT_BIN="$OUT_DIR/codegraph-xchelper"

mkdir -p "$OUT_DIR"

echo "[build-mac-objc-helper] swift project: $SWIFT_PROJ"
cd "$SWIFT_PROJ"

# Clean SwiftPM artifact dir so per-arch builds don't reuse stale incremental
# state from a host-arch-only build. Cheap (Swift resolves the package graph
# from cache, only the per-target build is fresh).
rm -rf .build

echo "[build-mac-objc-helper] building arm64 slice…"
swift build -c release --arch arm64

echo "[build-mac-objc-helper] building x86_64 slice…"
swift build -c release --arch x86_64

ARM64_BIN="$SWIFT_PROJ/.build/arm64-apple-macosx/release/codegraph-xchelper"
X86_BIN="$SWIFT_PROJ/.build/x86_64-apple-macosx/release/codegraph-xchelper"

[[ -f "$ARM64_BIN" ]] || { echo "[build-mac-objc-helper] arm64 build missing at $ARM64_BIN" >&2; exit 1; }
[[ -f "$X86_BIN"   ]] || { echo "[build-mac-objc-helper] x86_64 build missing at $X86_BIN" >&2; exit 1; }

echo "[build-mac-objc-helper] lipo -create → $OUT_BIN"
lipo -create -output "$OUT_BIN" "$ARM64_BIN" "$X86_BIN"
chmod +x "$OUT_BIN"

echo "[build-mac-objc-helper] lipo -info:"
lipo -info "$OUT_BIN"

# Sanity-check both arches are actually present.
INFO="$(lipo -info "$OUT_BIN")"
if [[ "$INFO" != *"arm64"* || "$INFO" != *"x86_64"* ]]; then
  echo "[build-mac-objc-helper] universal binary check failed: $INFO" >&2
  exit 1
fi

echo "[build-mac-objc-helper] ✓ universal binary ready: $OUT_BIN"
