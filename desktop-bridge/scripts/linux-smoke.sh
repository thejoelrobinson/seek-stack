#!/usr/bin/env bash
set -euo pipefail
export NO_AT_BRIDGE=0
export GTK_MODULES=gail:atk-bridge
# Chromium (and so Electron) exposes AT-SPI only when accessibility is requested.
export ACCESSIBILITY_ENABLED=1
openbox > /tmp/seek-bridge-openbox.log 2>&1 &
window_manager=$!
trap 'kill "$window_manager" 2>/dev/null || true' EXIT
npm run smoke:packaged:input
