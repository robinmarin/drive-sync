#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';

import { APP_VERSION, DISCLAIMER, files, loadConfig } from './config';
import { clearStatus, sendCommand, serveControl, writeStatus } from './control';
import { RemoteTree } from './proton/remote';
import { openSession, signInViaBrowser } from './proton/session';
import { StateDb } from './sync/db';
import { SyncEngine, type Status } from './sync/engine';
import { LocalTree } from './sync/local';

const USAGE = `drivesync ${APP_VERSION} — unofficial Proton Drive sync for Linux
${DISCLAIMER}

Usage:
  drivesync login                    Sign in via the browser
  drivesync logout                   Sign out and clear caches
  drivesync daemon                   Run the sync service (normally via systemd)
  drivesync status [--json]          Show sync status
  drivesync pause | resume           Pause or resume syncing
  drivesync resume --allow-deletes   Resume and allow a large deletion once
  drivesync sync                     Sync now
  drivesync reset                    Forget sync state (daemon must be stopped)
  drivesync paths                    Show config and data locations
`;

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main(argv: string[]): Promise<number> {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case 'login':
            return login();
        case 'logout':
            return logout();
        case 'daemon':
            return daemon();
        case 'status':
            return status(rest.includes('--json'));
        case 'pause':
            await sendCommand({ cmd: 'pause' });
            return 0;
        case 'resume':
            await sendCommand({ cmd: 'resume', allowDeletes: rest.includes('--allow-deletes') });
            return 0;
        case 'sync':
            await sendCommand({ cmd: 'sync' });
            return 0;
        case 'reset':
            return reset();
        case 'paths': {
            const cfg = await loadConfig();
            console.log(JSON.stringify({ ...files, localRoot: cfg.localRoot, remoteRoot: cfg.remoteRoot }, null, 2));
            return 0;
        }
        default:
            console.log(USAGE);
            return cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0;
    }
}

async function login(): Promise<number> {
    console.log(DISCLAIMER);
    const session = await openSession();
    try {
        if (session.auth.isLoggedIn()) {
            console.log('Already signed in.');
            return 0;
        }
        await signInViaBrowser(session, (url) => console.log(`Sign in in your browser (or open manually):\n${url}`));
        console.log('Signed in.');
        return 0;
    } finally {
        await session.dispose();
    }
}

async function logout(): Promise<number> {
    const session = await openSession();
    await session.auth.logout();
    await session.clearCaches();
    await session.dispose();
    console.log('Signed out.');
    return 0;
}

async function reset(): Promise<number> {
    try {
        await sendCommand({ cmd: 'status' });
        console.error('Stop the daemon first: systemctl --user stop drivesync');
        return 1;
    } catch {
        /* not running: good */
    }
    const db = new StateDb(files.db);
    db.reset();
    db.close();
    console.log('Sync state cleared. Next start compares both sides from scratch (nothing is deleted).');
    return 0;
}

async function status(json: boolean): Promise<number> {
    let s: Status | undefined;
    try {
        s = await sendCommand({ cmd: 'status' });
    } catch (e) {
        if (json) console.log(JSON.stringify({ state: 'stopped' }));
        else console.log((e as Error).message);
        return json ? 0 : 1;
    }
    if (json) {
        console.log(JSON.stringify(s));
        return 0;
    }
    console.log(`State:   ${s!.state}${s!.message ? ` — ${s!.message}` : ''}`);
    console.log(`Syncing: ${s!.localRoot}  ⇄  ${s!.remoteRoot}`);
    if (s!.lastSyncAt) console.log(`Last:    ${new Date(s!.lastSyncAt).toLocaleString()}`);
    if (s!.current) console.log(`Now:     ${s!.current.action} ${s!.current.path} (${s!.pending} left)`);
    if (s!.recent.length) {
        console.log('Recent:');
        for (const r of s!.recent.slice(0, 10)) console.log(`  ${new Date(r.time).toLocaleTimeString()}  ${r.action.padEnd(11)} ${r.path}`);
    }
    if (s!.errors.length) {
        console.log('Errors:');
        for (const e of s!.errors.slice(0, 5)) console.log(`  ${new Date(e.time).toLocaleTimeString()}  ${e.path ?? ''} ${e.message}`);
    }
    return 0;
}

async function daemon(): Promise<number> {
    const cfg = await loadConfig();
    log(`drivesync ${APP_VERSION} starting: ${cfg.localRoot} ⇄ ${cfg.remoteRoot}`);
    await clearStatus('starting', 'Connecting…');

    const db = new StateDb(files.db);
    const session = await openSession();
    if (!session.auth.isLoggedIn()) {
        await clearStatus('signed_out', 'Not signed in. Run: drivesync login');
        log('Not signed in. Run: drivesync login');
        await session.dispose();
        return 2;
    }

    const firstRun = db.count() === 0;
    const rootUid = await RemoteTree.resolveRoot(session.sdk, cfg.remoteRoot, log);

    // Refuse to sync if the configured roots changed under existing state.
    const knownRoot = db.getMeta('remoteRootUid');
    const knownLocal = db.getMeta('localRoot');
    if (!firstRun && ((knownRoot && knownRoot !== rootUid) || (knownLocal && knownLocal !== cfg.localRoot))) {
        const msg = 'Sync folders changed since the last run. Stop the daemon and run "drivesync reset" to start over.';
        await clearStatus('error', msg);
        log(msg);
        await session.dispose();
        return 2;
    }
    db.setMeta('remoteRootUid', rootUid);
    db.setMeta('localRoot', cfg.localRoot);

    const local = new LocalTree(cfg.localRoot);
    if (firstRun) {
        await mkdir(cfg.localRoot, { recursive: true });
        await local.ensureMeta();
    } else if (await local.hasMarker()) {
        await local.ensureMeta();
    }

    const remote = new RemoteTree(session.sdk, rootUid, log);
    log('Loading remote tree…');
    await remote.load();

    const engine = new SyncEngine(cfg, session.sdk, remote, local, db, log, writeStatus);
    const stopControl = await serveControl((c) => {
        switch (c.cmd) {
            case 'status':
                return engine.status;
            case 'pause':
                engine.pause();
                return engine.status;
            case 'resume':
                engine.resume({ allowDeletes: c.allowDeletes });
                return engine.status;
            case 'sync':
                engine.trigger(0);
                return engine.status;
            default:
                throw new Error(`Unknown command`);
        }
    });

    const shutdown = () => {
        log('Shutting down…');
        engine.stop();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    try {
        await engine.run();
    } finally {
        stopControl();
        await clearStatus('stopped', 'drivesync is not running');
        await session.dispose();
        db.close();
    }
    return 0;
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    },
);
