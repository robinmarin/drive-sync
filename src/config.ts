import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const APP_NAME = 'drivesync';
export const APP_VERSION = '0.1.0';
/** Honest third-party identification, per the Proton SDK usage guidelines. */
export const X_PM_APPVERSION = `external-drive-${APP_NAME}@${APP_VERSION}-alpha`;
export const DISCLAIMER = 'This is a third-party application not officially supported by Proton.';

const home = homedir();
const xdg = (name: string, fallback: string) => process.env[name] || path.join(home, fallback);

export const dirs = {
    config: path.join(xdg('XDG_CONFIG_HOME', '.config'), APP_NAME),
    data: path.join(xdg('XDG_DATA_HOME', '.local/share'), APP_NAME),
    runtime: path.join(process.env.XDG_RUNTIME_DIR || path.join('/tmp', `${APP_NAME}-${process.getuid?.()}`), APP_NAME),
};

export const files = {
    config: path.join(dirs.config, 'config.json'),
    db: path.join(dirs.data, 'state.sqlite'),
    /** SDK caches, client UID and logs live here, separate from the official CLI. */
    sdkData: path.join(dirs.data, 'sdk'),
    socket: path.join(dirs.runtime, 'control.sock'),
    status: path.join(dirs.runtime, 'status.json'),
};

export interface Config {
    /** Absolute local folder to sync. */
    localRoot: string;
    /** Drive path to sync, e.g. /my-files/drivesync-test. */
    remoteRoot: string;
    /** Refuse a pass that would delete more than this share of synced entries… */
    maxDeleteRatio: number;
    /** …when at least this many entries would be deleted. */
    maxDeleteMin: number;
}

const DEFAULTS: Config = {
    localRoot: path.join(home, 'DriveSync-test'),
    remoteRoot: '/my-files/drivesync-test',
    maxDeleteRatio: 0.5,
    maxDeleteMin: 10,
};

export async function loadConfig(): Promise<Config> {
    mkdirSync(dirs.config, { recursive: true });
    const file = Bun.file(files.config);
    if (!(await file.exists())) {
        await Bun.write(file, JSON.stringify(DEFAULTS, null, 4) + '\n');
        return { ...DEFAULTS };
    }
    const cfg = { ...DEFAULTS, ...(await file.json()) } as Config;
    if (!path.isAbsolute(cfg.localRoot)) cfg.localRoot = path.resolve(home, cfg.localRoot.replace(/^~\/?/, ''));
    if (!cfg.remoteRoot.startsWith('/my-files')) throw new Error(`remoteRoot must be under /my-files (got ${cfg.remoteRoot})`);
    return cfg;
}
