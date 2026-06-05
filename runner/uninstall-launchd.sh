#!/bin/bash
# Remove the nexus-runner LaunchAgent.
set -e

LABEL="com.eli.nexus-runner"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "[uninstall] removed $PLIST"
else
    echo "[uninstall] not installed (no $PLIST)"
fi
