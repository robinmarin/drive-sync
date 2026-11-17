# drivesync

An unofficial, third-party Proton Drive sync client for Linux, with an
[Omarchy](https://omarchy.org/) shell (Quickshell) bar widget.

> This is a third-party application not officially supported by Proton.

## Status

Early spike. Planned pieces:

1. **Spike**: sign in and list Drive folders via Proton's open-source SDK (`src/spike.ts`)
2. **Daemon**: two-way sync of a local folder, event-based, with conflict copies
3. **Bar plugin**: Omarchy shell widget + panel (status, recent activity, pause)
4. **Packaging**: PKGBUILD + systemd user service

## Development

Requires [mise](https://mise.jdx.dev/) (pins Bun 1.4.2) and a libsecret keyring.

```bash
git clone --recurse-submodules git@github.com:robinmarin/drive-sync.git
cd drive-sync
mise install
mise exec -- ./scripts/bootstrap.sh
mise exec -- bun src/spike.ts            # sign in via browser, list /my-files
```

Builds on [ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk) (MIT),
vendored as a submodule in `vendor/proton-sdk`, and follows its
[usage guidelines for personal projects](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects).
