// Step 1 spike: prove we can sign in and list a Drive folder through Proton's SDK,
// reusing the official CLI's plumbing (HTTP client, keyring session, caches, events).
//
// Usage: bun src/spike.ts [/my-files/some/folder]
import { init } from '../vendor/proton-sdk/cli/src/init';
import { openBrowserUrl } from '../vendor/proton-sdk/cli/src/cli';

// Honest third-party identification, per the SDK's usage guidelines.
const APP_VERSION = 'external-drive-drivesync@0.0.1-alpha';

const target = process.argv[2] ?? '/my-files';

const session = await init({
    appVersion: APP_VERSION,
    clientUidPrefix: 'drivesync',
    enablePersistedEvents: false,
    enableMetrics: false,
});

try {
    if (!session.auth.isLoggedIn()) {
        console.log('This is a third-party application not officially supported by Proton.');
        await session.auth.authViaWeb((url: string) => {
            openBrowserUrl(url);
            console.log(`Sign in in your browser (or open manually): ${url}`);
        });
        console.log('Signed in.');
    }

    const folder = await session.paths.getNode(target);
    console.log(`Listing ${target}:`);
    for await (const node of session.sdk.iterateFolderChildren(folder)) {
        const name = node.name.ok ? node.name.value : `<undecryptable: ${node.uid}>`;
        console.log(`  ${node.type.padEnd(6)} ${name}`);
    }
} finally {
    await session.dispose();
}
