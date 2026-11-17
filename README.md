# drivesync

An unofficial, third-party Proton Drive sync client for Linux, with an
[Omarchy](https://omarchy.org/) shell (Quickshell) bar widget on the way.

> This is a third-party application not officially supported by Proton.

## Status

Alpha. Two-way sync of one folder works against an in-memory fake Drive in
tests; real-account testing is in progress. **Use a test folder, not your real
files, until this says otherwise.**

- [x] Sign in via browser, session in the desktop keyring
- [x] Sync daemon: two-way sync, conflict copies, safety guards, control socket
- [ ] Omarchy bar plugin (status icon + panel)
- [ ] Packaging (PKGBUILD)
- [ ] Later: rename/move detection, selective sync, files on demand

## How it syncs

- One local folder ⇄ one Drive folder (defaults: `~/DriveSync-test` ⇄ `/my-files/drivesync-test`;
  edit `~/.config/drivesync/config.json`).
- Remote changes arrive as Drive **events**; the remote tree is listed once at
  startup and kept up to date from events (no polling or repeated full scans).
- Local changes are picked up by a file watcher plus a cheap local rescan every minute.
- Three-way comparison against the last synced state (SQLite) decides each path.

Safety rules:

- **Edited on both sides** → both kept: the local file becomes
  `name (conflicted copy <date> <host>).ext` and is uploaded too.
- **Deleted on one side, edited on the other** → the edit wins.
- Deletions go to the **Drive trash** or to `<folder>/.drivesync/trash/`, never permanently.
- A pass that would delete more than half of the synced items (min. 10) **pauses**
  until you run `drivesync resume --allow-deletes`.
- If the local folder disappears (unmounted disk, deleted folder), sync **pauses**
  instead of treating it as "delete everything".
- Files modified in the last 3 seconds are not uploaded until they settle.
- Renames/moves currently sync as delete + add (the old copy goes to the trash).

## Install (from this checkout)

Requires [mise](https://mise.jdx.dev/) (pins Bun 1.4.2) and a Secret Service keyring
(gnome-keyring, KWallet).

```bash
git clone --recurse-submodules git@github.com:robinmarin/drive-sync.git
cd drive-sync
mise install
mise exec -- ./scripts/bootstrap.sh
./scripts/install-dev.sh                 # ~/.local/bin/drivesync + systemd user unit

drivesync login                          # browser sign-in
systemctl --user enable --now drivesync
drivesync status
journalctl --user -u drivesync -f        # logs
```

Commands: `login`, `logout`, `daemon`, `status [--json]`, `pause`, `resume [--allow-deletes]`,
`sync`, `reset`, `paths`.

The daemon writes its live status to `$XDG_RUNTIME_DIR/drivesync/status.json`
(for the bar widget) and accepts commands on `$XDG_RUNTIME_DIR/drivesync/control.sock`.

## Development

```bash
mise exec -- bun test                    # planner, engine (fake Drive), control socket
```

Layout: `src/sync/` is Proton-agnostic (planner, engine, local tree, state DB);
`src/proton/` is the only code that touches the SDK.

Builds on [ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk) (MIT),
vendored as a submodule in `vendor/proton-sdk`, and follows its
[usage guidelines for personal projects](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects).
