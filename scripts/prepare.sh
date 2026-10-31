#!/bin/sh
# Gets the web assets ready for a build: refreshes the built-in firmware list, then syncs Capacitor.
# The list is the fallback the app shows before "Check GitHub" has been run. Order of preference:
#   1. a sibling checkout of the firmware repo (../esphome-Itho-Daalderop-HRU400)
#   2. the file on GitHub
#   3. the copy already committed in www/
set -eu
cd "$(dirname "$0")/.."

URL=https://raw.githubusercontent.com/william-sy/esphome-Itho-Daalderop-HRU400/main/firmware_update/firmware_metadata.json
SIBLING=../esphome-Itho-Daalderop-HRU400/firmware_update/firmware_metadata.json
DEST=www/firmware_metadata.json
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ -f "$SIBLING" ]; then
  cp "$SIBLING" "$DEST"; echo "firmware list: from $SIBLING"
elif curl -fsSL --max-time 30 "$URL" -o "$TMP" && python3 -c 'import json,sys; json.load(open(sys.argv[1]))["firmware"]' "$TMP" 2>/dev/null; then
  cp "$TMP" "$DEST"; echo "firmware list: from GitHub"
else
  echo "firmware list: keeping the committed copy"
fi

npx cap sync android
