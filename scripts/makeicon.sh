#!/bin/bash
# Render the app icon with Electron, then build assets/icon.icns with the
# stock macOS tools. Re-run after editing scripts/icon/icon.html.
set -euo pipefail
cd "$(dirname "$0")/.."

PNG=scripts/icon/icon-1024.png
SET=scripts/icon/Gonds.iconset

ICON_OUT="$PWD/$PNG" node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/icon >/dev/null
[ -f "$PNG" ] || { echo "icon render failed"; exit 1; }

# A non-square source would be stretched by sips into a distorted .icns, and
# nothing downstream would complain. Fail here instead.
W=$(sips -g pixelWidth  "$PNG" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$PNG" | awk '/pixelHeight/{print $2}')
[ "$W" = "$H" ] || { echo "render is ${W}x${H}, expected a square — aborting"; exit 1; }
[ "$W" = "1024" ] || { echo "render is ${W}px, expected 1024 — aborting"; exit 1; }

rm -rf "$SET" && mkdir -p "$SET" assets
for s in 16 32 128 256 512; do
  sips -z $s $s        "$PNG" --out "$SET/icon_${s}x${s}.png"    >/dev/null
  sips -z $((s*2)) $((s*2)) "$PNG" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done

iconutil -c icns "$SET" -o assets/icon.icns
rm -rf "$SET"
echo "assets/icon.icns $(stat -f%z assets/icon.icns) bytes"
