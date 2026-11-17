// Pure three-way sync planner. Given the current local tree, the current remote
// tree and the last-synced base, decide what to do for every path. No I/O here,
// so the rules can be unit tested exhaustively.

import type { Action, BaseEntry, LocalEntry, RemoteEntry } from './types';

export interface Plan {
    actions: Action[];
    /** Number of base entries (files + folders) the plan would delete on either side. */
    deletions: number;
}

export function localChanged(l: LocalEntry, b: BaseEntry): boolean {
    if (l.type !== 'file') return false;
    return l.size !== b.size || Math.floor(l.mtimeMs) !== Math.floor(b.mtimeMs ?? -1);
}

export function remoteChanged(r: RemoteEntry, b: BaseEntry): boolean {
    if (r.type !== 'file') return false;
    return r.revUid !== b.revUid;
}

export function plan(
    local: Map<string, LocalEntry>,
    remote: Map<string, RemoteEntry>,
    base: Map<string, BaseEntry>,
): Plan {
    const paths = new Set<string>([...local.keys(), ...remote.keys(), ...base.keys()]);
    paths.delete(''); // the root itself is never synced as an entry

    const raw: Action[] = [];
    for (const path of paths) {
        const a = decide(path, local.get(path), remote.get(path), base.get(path));
        if (a) raw.push(a);
    }

    const actions = resolveFolderDeletions(raw);
    return { actions: order(actions), deletions: countDeletions(actions, base) };
}

function decide(path: string, l?: LocalEntry, r?: RemoteEntry, b?: BaseEntry): Action | undefined {
    // A base entry of a different type than what is there now is stale.
    if (b && ((l && l.type !== b.type) || (r && r.type !== b.type))) b = undefined;

    if (l && r) {
        if (l.type !== r.type) return { kind: 'typeMismatch', path };
        if (l.type === 'folder') {
            return b?.uid === r.uid ? undefined : { kind: 'record', path, uid: r.uid, type: 'folder' };
        }
        if (!b) return { kind: 'reconcile', path, uid: r.uid };
        const lc = localChanged(l, b);
        const rc = remoteChanged(r, b);
        if (lc && rc) return { kind: 'reconcile', path, uid: r.uid };
        if (lc) return { kind: 'upload', path, replaceUid: r.uid };
        if (rc) return { kind: 'download', path, uid: r.uid };
        return undefined;
    }

    if (l) {
        if (l.type === 'folder') {
            return b ? { kind: 'trashLocal', path, type: 'folder' } : { kind: 'mkdirRemote', path };
        }
        // Deleted remotely: follow the deletion only if nothing changed locally.
        if (b && !localChanged(l, b)) return { kind: 'trashLocal', path, type: 'file' };
        return { kind: 'upload', path };
    }

    if (r) {
        if (r.type === 'folder') {
            return b ? { kind: 'trashRemote', path, uid: r.uid, type: 'folder' } : { kind: 'mkdirLocal', path };
        }
        if (b && !remoteChanged(r, b)) return { kind: 'trashRemote', path, uid: r.uid, type: 'file' };
        return { kind: 'download', path, uid: r.uid };
    }

    return b ? { kind: 'forget', path } : undefined;
}

const isUnder = (path: string, folder: string) => path.startsWith(folder + '/');

// A folder deleted on one side may still contain content the other side
// changed or added. In that case keep (recreate) the folder instead of
// trashing it, so that content survives. Otherwise trash only the topmost
// deleted folder; its descendants go with it.
function resolveFolderDeletions(actions: Action[]): Action[] {
    const keepsLocalContent = (a: Action) =>
        a.kind === 'upload' || a.kind === 'mkdirRemote' || a.kind === 'reconcile' || a.kind === 'typeMismatch';
    const keepsRemoteContent = (a: Action) =>
        a.kind === 'download' || a.kind === 'mkdirLocal' || a.kind === 'reconcile' || a.kind === 'typeMismatch';

    const out = actions.map((a): Action => {
        if (a.kind === 'trashLocal' && a.type === 'folder') {
            if (actions.some((o) => isUnder(o.path, a.path) && keepsLocalContent(o))) {
                return { kind: 'mkdirRemote', path: a.path };
            }
        }
        if (a.kind === 'trashRemote' && a.type === 'folder') {
            if (actions.some((o) => isUnder(o.path, a.path) && keepsRemoteContent(o))) {
                return { kind: 'mkdirLocal', path: a.path };
            }
        }
        return a;
    });

    // Recreating a folder must also recreate its ancestors that were slated for trashing.
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < out.length; i++) {
            const a = out[i];
            if (a.kind === 'trashLocal' && a.type === 'folder' && out.some((o) => o.kind === 'mkdirRemote' && isUnder(o.path, a.path))) {
                out[i] = { kind: 'mkdirRemote', path: a.path };
                changed = true;
            }
            if (a.kind === 'trashRemote' && a.type === 'folder' && out.some((o) => o.kind === 'mkdirLocal' && isUnder(o.path, a.path))) {
                out[i] = { kind: 'mkdirLocal', path: a.path };
                changed = true;
            }
        }
    }

    const trashedLocal = out.filter((a) => a.kind === 'trashLocal' && a.type === 'folder').map((a) => a.path);
    const trashedRemote = out.filter((a) => a.kind === 'trashRemote' && a.type === 'folder').map((a) => a.path);
    return out.filter((a) => {
        if (a.kind === 'trashLocal') return !trashedLocal.some((f) => isUnder(a.path, f));
        if (a.kind === 'trashRemote') return !trashedRemote.some((f) => isUnder(a.path, f));
        return true;
    });
}

const depth = (p: string) => p.split('/').length;

const PHASE: Record<Action['kind'], number> = {
    mkdirRemote: 0,
    mkdirLocal: 0,
    record: 1,
    upload: 2,
    download: 2,
    reconcile: 2,
    trashLocal: 3,
    trashRemote: 3,
    forget: 4,
    typeMismatch: 4,
};

function order(actions: Action[]): Action[] {
    return [...actions].sort((a, b) => {
        if (PHASE[a.kind] !== PHASE[b.kind]) return PHASE[a.kind] - PHASE[b.kind];
        // Create parents first; trash deepest first.
        const d = depth(a.path) - depth(b.path);
        if (d !== 0) return PHASE[a.kind] === 3 ? -d : d;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
}

function countDeletions(actions: Action[], base: Map<string, BaseEntry>): number {
    let n = 0;
    for (const a of actions) {
        if (a.kind !== 'trashLocal' && a.kind !== 'trashRemote') continue;
        n += 1;
        if (a.type === 'folder') for (const p of base.keys()) if (isUnder(p, a.path)) n += 1;
    }
    return n;
}
