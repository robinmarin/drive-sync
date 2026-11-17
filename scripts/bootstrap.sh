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

# The CLI links the SDK packages file-by-file, and Bun resolves bare imports
# from each file's real path. Point the SDK sources at the CLI's node_modules
# so they resolve, sharing one (patched) copy of @protontech/crypto.
ln -sfn ../../cli/node_modules "$SDK/client/js/node_modules"
ln -sfn ../../../cli/node_modules "$SDK/incubating/account/js/node_modules"
