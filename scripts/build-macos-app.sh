#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-1.2.0}"
BUILD_NUMBER="${BUILD_NUMBER:-4}"
APP_NAME="Git贡献看板"
PRODUCT_DIR="$ROOT/outputs"
APP="$PRODUCT_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
NODE_SOURCE="${NODE_BINARY:-$(command -v node || true)}"
ICON_SOURCE="${APP_ICON:-$PRODUCT_DIR/AppIcon.icns}"

if [[ -z "$NODE_SOURCE" || ! -x "$NODE_SOURCE" ]]; then
  echo "未找到可执行的 Node.js。请设置 NODE_BINARY=/absolute/path/to/node" >&2
  exit 1
fi

if [[ "$(file "$NODE_SOURCE")" != *"arm64"* ]]; then
  echo "内置 Node.js 必须包含 arm64 架构：$NODE_SOURCE" >&2
  exit 1
fi

mkdir -p "$PRODUCT_DIR"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/runtime" "$CONTENTS/Resources/dashboard/src" "$CONTENTS/Resources/dashboard/public"

/usr/bin/xcrun swiftc -O -framework AppKit -framework WebKit \
  "$ROOT/src/macos-app/main.swift" \
  -o "$CONTENTS/MacOS/GitContributionDashboard"

cp "$NODE_SOURCE" "$CONTENTS/Resources/runtime/node"
chmod 755 "$CONTENTS/Resources/runtime/node"
cp "$ROOT/package.json" "$CONTENTS/Resources/dashboard/package.json"
cp -R "$ROOT/src/server" "$CONTENTS/Resources/dashboard/src/server"
cp -R "$ROOT/public/." "$CONTENTS/Resources/dashboard/public/"

if [[ -f "$ICON_SOURCE" ]]; then
  cp "$ICON_SOURCE" "$CONTENTS/Resources/AppIcon.icns"
  ICON_ENTRY=$'\n  <key>CFBundleIconFile</key>\n  <string>AppIcon</string>'
else
  ICON_ENTRY=""
fi

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>GitContributionDashboard</string>
  <key>CFBundleIdentifier</key>
  <string>com.local.git-contribution-dashboard</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>$ICON_ENTRY
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

/usr/bin/codesign --force --sign - --timestamp=none "$CONTENTS/Resources/runtime/node"
/usr/bin/codesign --force --deep --sign - --timestamp=none "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"

ZIP="$PRODUCT_DIR/GitContributionDashboard-v$VERSION-macos-arm64.zip"
rm -f "$ZIP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

printf '%s\n' "$APP" "$ZIP"
