#!/usr/bin/env bash
# Build monica.app and install it into /Applications (local, unsigned — no release).
set -euo pipefail

cd "$(dirname "$0")/.."

yarn package

APP=$(ls -d dist/monica-darwin-*/monica.app 2>/dev/null | head -1 || true)
if [ -z "${APP:-}" ]; then
  echo "✗ Build output not found (expected dist/monica-darwin-*/monica.app)" >&2
  exit 1
fi

DEST="/Applications/monica.app"
echo "Installing $APP → $DEST"
osascript -e 'tell application "monica" to quit' >/dev/null 2>&1 || true   # close a running copy first
rm -rf "$DEST"
cp -R "$APP" "$DEST"
echo "✓ monica installed in /Applications — launch it from Spotlight or Applications."
