// The only place that touches Proton's CLI plumbing. Everything else talks to
// the SDK client returned from here (via RemoteTree / RemoteOps).

import { files, X_PM_APPVERSION } from '../config';

export type Session = Awaited<ReturnType<typeof openSession>>;

export async function openSession() {
    // Keep SDK caches, client UID and logs out of the official CLI's folders.
    // (The keyring entry is still shared with proton-drive-cli for now.)
    process.env.PROTON_DRIVE_CACHE_DIR ??= files.sdkData;
    process.env.PROTON_DRIVE_LOG_LEVEL ??= 'INFO';

    const { init } = await import('../../vendor/proton-sdk/cli/src/init');
    return init({
        appVersion: X_PM_APPVERSION,
        clientUidPrefix: 'drivesync',
        enablePersistedEvents: false,
        enableMetrics: false,
    });
}

export async function signInViaBrowser(session: Session, onUrl: (url: string) => void): Promise<void> {
    const { openBrowserUrl } = await import('../../vendor/proton-sdk/cli/src/cli');
    await session.auth.authViaWeb((url: string) => {
        openBrowserUrl(url);
        onUrl(url);
    });
}
