#!/usr/bin/env bash
# Prepare the vendored Proton SDK for local builds.
# Upstream lockfiles reference Proton's internal npm mirror, which is not
# reachable publicly; the same tarballs (same integrity hashes) live on npmjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/vendor/proton-sdk"

git -C "$ROOT" submodule update --init vendor/proton-sdk

find "$SDK" -name bun.lock -not -path '*/node_modules/*' -print0 |
  xargs -0 sed -i 's#https://pkg.protontech.ch/npm/npm-public/#https://registry.npmjs.org/#g'

export BUN_TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/bun/tmp"
mkdir -p "$BUN_TMPDIR"

(cd "$SDK/cli" && bun install --frozen-lockfile)
(cd "$ROOT" && bun install)
