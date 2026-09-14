#!/bin/bash
# Builds Glidecast.app into dist/. Pass --install to copy it into /Applications.
# The app runs the project from this folder, so rebuild if you move the project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/Glidecast.app"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.0)"

echo "→ Rendering icon"
swiftc -O "$ROOT/macos/icon.swift" -o "$BUILD/icon"
"$BUILD/icon" "$BUILD/icon.png" >/dev/null
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$BUILD/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

echo "→ Compiling app"
swiftc -O -swift-version 5 "$ROOT/macos/Glidecast.swift" -o "$BUILD/Glidecast" -framework Cocoa -framework WebKit

echo "→ Assembling bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/Glidecast" "$APP/Contents/MacOS/Glidecast"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Glidecast</string>
  <key>CFBundleDisplayName</key><string>Glidecast</string>
  <key>CFBundleIdentifier</key><string>com.jonno.glidecast</string>
  <key>CFBundleExecutable</key><string>Glidecast</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>GlidecastHome</key><string>$ROOT</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "✓ Built $APP"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/Glidecast.app"
  cp -R "$APP" "/Applications/Glidecast.app"
  touch "/Applications/Glidecast.app"
  echo "✓ Installed /Applications/Glidecast.app"
fi
