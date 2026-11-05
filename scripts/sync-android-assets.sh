#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSETS="$ROOT/android/app/src/main/assets"
rm -rf "$ASSETS"
mkdir -p "$ASSETS"
cp -R "$ROOT/public/." "$ASSETS/"
cp "$ROOT/android/native-bridge.js" "$ASSETS/native-bridge.js"
python3 - "$ASSETS/index.html" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
html = path.read_text()
needle = '<script src="/app.js'
if needle not in html:
    raise SystemExit('Could not find the app.js script tag in public/index.html')
html = html.replace(needle, '<script src="/native-bridge.js"></script>' + needle, 1)
path.write_text(html)
PY
printf 'Synced web assets into %s\n' "$ASSETS"
