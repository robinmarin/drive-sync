#!/usr/bin/env bash
# Install drivesync from this checkout for the current user:
#   ~/.local/bin/drivesync  -> bin/drivesync (symlink)
#   ~/.config/systemd/user/drivesync.service
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
ln -sfn "$ROOT/bin/drivesync" "$HOME/.local/bin/drivesync"
install -m 644 "$ROOT/packaging/drivesync.service" "$HOME/.config/systemd/user/drivesync.service"
systemctl --user daemon-reload
echo "Installed. Next:"
echo "  drivesync login"
echo "  systemctl --user enable --now drivesync"
echo "  drivesync status"
