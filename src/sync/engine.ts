import { NodeWithSameNameExistsValidationError, type ProtonDriveClient } from '@protontech/drive-sdk';
import { watch, type FSWatcher } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import type { Config } from '../config';
import type { RemoteTree } from '../proton/remote';
import type { StateDb } from './db';
import { conflictName, isIgnoredName, LocalTree, META_DIR, sha1File } from './local';
import { plan } from './planner';
import type { Action, LocalEntry } from './types';

function sameLocal(a: LocalEntry | undefined, b: LocalEntry | undefined): boolean {
    if (!a || !b) return a === b;
    return a.type === b.type && a.size === b.size && Math.floor(a.mtimeMs) === Math.floor(b.mtimeMs);
}

export type SyncState = 'starting' | 'idle' | 'syncing' | 'paused' | 'error' | 'offline';

export interface ActivityItem {
    time: string;
    action: string;
    path: string;
}
export interface ErrorItem {
    time: string;
    path?: string;
    message: string;
}

export interface Status {
    state: SyncState;
    message?: string;
    paused: boolean;
    localRoot: string;
    remoteRoot: string;
    lastSyncAt?: string;
    pending: number;
    current?: { action: string; path: string };
    recent: ActivityItem[];
    errors: ErrorItem[];
    /** Set when a pass was blocked by the mass-deletion guard. */
    blockedDeletes?: number;
}

const DEBOUNCE_MS = 1500;
const LOCAL_RESCAN_MS = 60_000;
const SETTLE_MS = 3000; // don't upload files modified more recently than this
const MAX_BACKOFF_MS = 5 * 60_000;

export class SyncEngine {
    readonly status: Status;
    private dirty = true;
    private timer?: Timer;
    private wake?: () => void;
    private stopped = false;
    private watcher?: FSWatcher;
    private rescan?: Timer;
    private failures = 0;
    private allowDeletesOnce = false;
    private host = hostname().split('.')[0] || 'linux';
    /** Local tree as scanned at the start of the current pass. */
    private localSnap = new Map<string, LocalEntry>();

    constructor(
        private cfg: Config,
        private sdk: ProtonDriveClient,
        private remote: RemoteTree,
        private local: LocalTree,
        private db: StateDb,
        private log: (msg: string) => void,
        private onStatus: (s: Status) => void,
        private opts: { settleMs?: number } = {},
    ) {
        this.status = {
            state: 'starting',
            paused: false,
            localRoot: cfg.localRoot,
            remoteRoot: cfg.remoteRoot,
            pending: 0,
            recent: [],
            errors: [],
        };
    }

    // ---- control ---------------------------------------------------------

    trigger(delay = DEBOUNCE_MS): void {
        this.dirty = true;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.wake?.(), delay);
    }

    pause(): void {
        this.status.paused = true;
        this.setState('paused');
    }

    resume(opts: { allowDeletes?: boolean } = {}): void {
        this.status.paused = false;
        if (opts.allowDeletes) this.allowDeletesOnce = true;
        this.status.blockedDeletes = undefined;
        this.setState('idle');
        this.trigger(0);
    }

    stop(): void {
        this.stopped = true;
        this.watcher?.close();
        clearInterval(this.rescan);
        clearTimeout(this.timer);
        this.wake?.();
    }

    // ---- main loop -------------------------------------------------------

    async run(): Promise<void> {
        this.watchLocal();
        this.rescan = setInterval(() => this.trigger(0), LOCAL_RESCAN_MS);
        await this.remote.subscribe(() => this.trigger());

        while (!this.stopped) {
            if (!this.dirty || this.status.paused) {
                await new Promise<void>((resolve) => (this.wake = resolve));
                continue;
            }
            this.dirty = false;
            try {
                await this.pass();
                this.failures = 0;
            } catch (e) {
                this.failures += 1;
                const msg = e instanceof Error ? e.message : String(e);
                const offline = /fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|timed? ?out|offline/i.test(msg);
                this.pushError(undefined, msg);
                this.setState(offline ? 'offline' : 'error', msg);
                const backoff = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (this.failures - 1));
                this.log(`Pass failed (${msg}); retrying in ${Math.round(backoff / 1000)}s`);
                this.trigger(backoff);
            }
        }
        this.remote.unsubscribe();
    }

    private watchLocal(): void {
        try {
            this.watcher = watch(this.local.root, { recursive: true }, (_event, filename) => {
                const f = filename?.toString() ?? '';
                if (f === META_DIR || f.startsWith(META_DIR + '/')) return;
                if (isIgnoredName(path.basename(f))) return;
                this.trigger();
            });
        } catch (e) {
            this.log(`File watching unavailable (${e}); relying on periodic rescans`);
        }
    }

    // ---- one sync pass ---------------------------------------------------

    /** One full sync pass. Public for tests; normally driven by run(). */
    async pass(): Promise<void> {
        if (!(await this.local.hasMarker())) {
            // Root missing or replaced (unmounted drive, deleted folder…). Never
            // interpret that as "user deleted everything".
            this.status.paused = true;
            this.setState('error', `Local folder ${this.local.root} is missing or not initialised; sync paused.`);
            return;
        }

        this.setState('syncing');
        this.localSnap = await this.local.scan((p, why) => this.log(`Skipping ${p} (${why})`));
        const remoteSnap = this.remote.snapshot();
        const base = this.db.loadBase();
        const { actions, deletions } = plan(this.localSnap, remoteSnap, base);

        const limit = Math.max(this.cfg.maxDeleteMin, Math.floor(base.size * this.cfg.maxDeleteRatio));
        if (deletions > limit && !this.allowDeletesOnce) {
            this.status.paused = true;
            this.status.blockedDeletes = deletions;
            this.setState(
                'paused',
                `This sync would delete ${deletions} items. Paused for safety — run "drivesync resume --allow-deletes" to proceed.`,
            );
            return;
        }
        this.allowDeletesOnce = false;

        const batch = new Date().toISOString().replace(/[:.]/g, '-');
        this.status.pending = actions.length;
        let deferred = false;

        for (const action of actions) {
            if (this.stopped || this.status.paused) break;
            this.status.current = { action: action.kind, path: action.path };
            this.emit();
            try {
                const done = await this.execute(action, batch);
                if (done === 'deferred') deferred = true;
                else if (done) this.pushActivity(action.kind, action.path);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.log(`${action.kind} ${action.path} failed: ${msg}`);
                this.pushError(action.path, msg);
                if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) throw e; // whole pass is doomed
            }
            this.status.pending -= 1;
        }

        this.status.current = undefined;
        this.status.pending = 0;
        this.status.lastSyncAt = new Date().toISOString();
        if (!this.status.paused) this.setState('idle');
        if (deferred) this.trigger(SETTLE_MS);
    }

    /** Returns true if something visible happened, 'deferred' to retry later. */
    private async execute(a: Action, batch: string): Promise<boolean | 'deferred'> {
        switch (a.kind) {
            case 'record':
                this.db.put(a.path, { type: a.type, uid: a.uid });
                return false;
            case 'forget':
                this.db.removeTree(a.path);
                return false;
            case 'typeMismatch':
                this.pushError(a.path, 'Is a file on one side and a folder on the other; left untouched.');
                return false;
            case 'mkdirLocal': {
                const r = this.remote.snapshot().get(a.path);
                await this.local.mkdir(a.path);
                if (r) this.db.put(a.path, { type: 'folder', uid: r.uid });
                return true;
            }
            case 'mkdirRemote': {
                const parentUid = this.parentUidOf(a.path);
                const node = await this.sdk.createFolder(parentUid, path.posix.basename(a.path));
                this.remote.upsert(node);
                this.db.put(a.path, { type: 'folder', uid: node.uid });
                return true;
            }
            case 'upload':
                return this.upload(a.path, a.replaceUid);
            case 'download':
                return this.download(a.path, a.uid, this.localSnap.get(a.path));
            case 'reconcile':
                return this.reconcile(a.path, a.uid);
            case 'trashRemote': {
                for await (const res of this.sdk.trashNodes([a.uid])) {
                    if (!res.ok) throw res.error;
                }
                this.remote.remove(a.uid);
                this.db.removeTree(a.path);
                return true;
            }
            case 'trashLocal':
                if (a.type === 'file' && !sameLocal(await this.local.stat(a.path), this.localSnap.get(a.path))) {
                    this.trigger(); // edited since the scan: don't follow the remote deletion
                    return false;
                }
                await this.local.trash(a.path, batch);
                this.db.removeTree(a.path);
                return true;
        }
    }

    private parentUidOf(rel: string): string {
        const parent = path.posix.dirname(rel);
        const uid = this.remote.folderUid(parent === '.' ? '' : parent);
        if (!uid) throw new Error(`Remote parent folder of ${rel} not found`);
        return uid;
    }

    private async upload(rel: string, replaceUid?: string): Promise<boolean | 'deferred'> {
        const before = await this.local.stat(rel);
        if (!before || before.type !== 'file') return false; // vanished; next pass handles it
        const settle = this.opts.settleMs ?? SETTLE_MS;
        if (settle > 0 && Date.now() - before.mtimeMs < settle) return 'deferred'; // still being written

        const abs = this.local.abs(rel);
        const file = Bun.file(abs);
        const sha1 = await sha1File(abs);
        const metadata = {
            mediaType: (file.type || 'application/octet-stream').split(';')[0],
            expectedSize: before.size,
            expectedSha1: sha1,
            modificationTime: new Date(before.mtimeMs),
        };

        let uploader;
        try {
            uploader = replaceUid
                ? await this.sdk.getFileRevisionUploader(replaceUid, metadata)
                : await this.sdk.getFileUploader(this.parentUidOf(rel), path.posix.basename(rel), metadata);
        } catch (e) {
            if (e instanceof NodeWithSameNameExistsValidationError) {
                // Appeared remotely since our snapshot; the incoming event will
                // update the mirror and the next pass will reconcile.
                this.trigger();
                return false;
            }
            throw e;
        }
        const controller = await uploader.uploadFromStream(file.stream(), []);
        const { nodeUid } = await controller.completion();
        const node = await this.sdk.getNode(nodeUid);
        this.remote.upsert(node);
        // Record the pre-upload stat: if the file changed during upload, the
        // next pass sees it as changed and uploads again.
        this.db.put(rel, {
            type: 'file',
            uid: node.uid,
            revUid: node.activeRevision?.uid,
            size: before.size,
            mtimeMs: before.mtimeMs,
            sha1,
        });
        return true;
    }

    private async download(rel: string, uid: string, expectLocal: LocalEntry | undefined): Promise<boolean> {
        const node = await this.sdk.getNode(uid);
        const rev = node.activeRevision;
        const tmp = this.local.tmpPath();
        const sink = Bun.file(tmp).writer();
        let closed = false;
        const stream = new WritableStream<Uint8Array>({
            async write(chunk) {
                await sink.write(chunk);
            },
            async close() {
                closed = true;
                await sink.end();
            },
            async abort() {
                closed = true;
                await sink.end();
            },
        });

        try {
            const downloader = await this.sdk.getFileDownloader(uid);
            await downloader.downloadToStream(stream).completion();
            if (!closed) await sink.end();

            const expected = rev?.claimedDigests?.sha1;
            const sha1 = await sha1File(tmp);
            if (expected && expected !== sha1) throw new Error(`Checksum mismatch downloading ${rel}`);

            // Don't clobber a local change made since this pass scanned the folder.
            const current = await this.local.stat(rel);
            if (!sameLocal(current, expectLocal)) {
                await unlink(tmp).catch(() => {});
                this.trigger();
                return false;
            }

            await this.local.moveInto(tmp, rel, rev?.claimedModificationTime);
            const after = await this.local.stat(rel);
            this.db.put(rel, {
                type: 'file',
                uid,
                revUid: rev?.uid,
                size: after?.size,
                mtimeMs: after?.mtimeMs,
                sha1,
            });
            return true;
        } catch (e) {
            await unlink(tmp).catch(() => {});
            throw e;
        }
    }

    private async reconcile(rel: string, uid: string): Promise<boolean> {
        const r = this.remote.snapshot().get(rel);
        const localSha1 = await sha1File(this.local.abs(rel));
        const st = await this.local.stat(rel);
        if (r?.sha1 && r.sha1 === localSha1 && st) {
            this.db.put(rel, { type: 'file', uid, revUid: r.revUid, size: st.size, mtimeMs: st.mtimeMs, sha1: localSha1 });
            return false;
        }
        // Keep both: local copy is renamed (and uploaded next pass), remote wins the original name.
        const copy = conflictName(rel, this.host);
        if (!sameLocal(st, this.localSnap.get(rel))) {
            this.trigger(); // changed again since the scan; look at it fresh next pass
            return false;
        }
        await this.local.renameRel(rel, copy);
        this.log(`Conflict on ${rel}: local version kept as ${copy}`);
        this.pushActivity('conflict', copy);
        await this.download(rel, uid, undefined);
        this.trigger();
        return true;
    }

    // ---- status ----------------------------------------------------------

    private setState(state: SyncState, message?: string): void {
        this.status.state = state;
        this.status.message = message;
        this.emit();
    }

    private pushActivity(action: string, p: string): void {
        this.status.recent.unshift({ time: new Date().toISOString(), action, path: p });
        this.status.recent.length = Math.min(this.status.recent.length, 30);
        this.emit();
    }

    private pushError(p: string | undefined, message: string): void {
        this.status.errors.unshift({ time: new Date().toISOString(), path: p, message });
        this.status.errors.length = Math.min(this.status.errors.length, 20);
        this.emit();
    }

    private emit(): void {
        this.onStatus(this.status);
    }
}
