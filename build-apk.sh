#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
CACHE="$ROOT/.gradle-bootstrap"
VERSION=8.9
DIST="$CACHE/gradle-$VERSION"
ZIP="$CACHE/gradle-$VERSION-bin.zip"
mkdir -p "$CACHE"
if [ ! -x "$DIST/bin/gradle" ]; then
  [ -f "$ZIP" ] || curl -fL --retry 3 -o "$ZIP" "https://services.gradle.org/distributions/gradle-$VERSION-bin.zip"
  rm -rf "$CACHE/extract"
  mkdir -p "$CACHE/extract"
  unzip -q "$ZIP" -d "$CACHE/extract"
  rm -rf "$DIST"
  mv "$CACHE/extract/gradle-$VERSION" "$DIST"
fi
"$DIST/bin/gradle" --no-daemon :app:assembleDebug "$@"
echo "APK: $ROOT/app/build/outputs/apk/debug/app-debug.apk"
