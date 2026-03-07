#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/sepiboi/Desktop/codex-telegram-bridge"
PLIST_SRC="$PROJECT_DIR/launchd/com.sepiboi.codex-telegram-bridge.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/com.sepiboi.codex-telegram-bridge.plist"

mkdir -p "$PROJECT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DST"
echo "Installed launch agent at $PLIST_DST"
