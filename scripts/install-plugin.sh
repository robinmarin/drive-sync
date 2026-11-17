#!/usr/bin/env bash
# Install the Omarchy bar widget from this checkout. The shell refuses
# symlinked plugins, so this copies; re-run it after editing shell-plugin/.
# Pass --enable to also place it on the bar (once; later runs just update).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID=drivesync.panel
DEST="$HOME/.config/omarchy/plugins/$ID"

omarchy plugin validate "$ROOT/shell-plugin" >/dev/null
mkdir -p "$DEST"
rsync -a --delete --exclude tests "$ROOT/shell-plugin/" "$DEST/"
echo "Installed $DEST"

if [[ ${1:-} == --enable ]]; then
  omarchy plugin enable "$ID" --section right
fi
