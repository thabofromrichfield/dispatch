#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSETS="$ROOT/android/app/src/main/assets"
rm -rf "$ASSETS"
mkdir -p "$ASSETS"
cp -R "$ROOT/android/field-app/." "$ASSETS/"
cp "$ROOT/android/native-bridge.js" "$ASSETS/native-bridge.js"
printf 'Synced the lightweight Android field app into %s\n' "$ASSETS"
