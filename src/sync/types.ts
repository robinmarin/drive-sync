// Shared shapes for the three views the planner compares:
//   local  – what is on disk now
//   remote – what is on Drive now
//   base   – what both sides looked like after the last successful sync
// Paths are relative POSIX paths inside the sync root ('' is the root itself).

export type EntryType = 'file' | 'folder';

export interface LocalEntry {
    type: EntryType;
    size: number;
    mtimeMs: number;
}

export interface RemoteEntry {
    type: EntryType;
    uid: string;
    revUid?: string;
    size?: number;
    sha1?: string;
    mtimeMs?: number;
}

export interface BaseEntry {
    type: EntryType;
    uid: string;
    revUid?: string;
    /** Local size/mtime as recorded right after the last sync of this path. */
    size?: number;
    mtimeMs?: number;
    sha1?: string;
}

export type Action =
    | { kind: 'mkdirRemote'; path: string }
    | { kind: 'mkdirLocal'; path: string }
    /** Upload a local file; `replaceUid` means "new revision of this node". */
    | { kind: 'upload'; path: string; replaceUid?: string }
    | { kind: 'download'; path: string; uid: string }
    /**
     * Both sides have a file at `path` that differs from base (or there is no
     * base). Engine compares content hashes: identical → just record, else
     * keep both by renaming the local copy and downloading the remote one.
     */
    | { kind: 'reconcile'; path: string; uid: string }
    | { kind: 'trashRemote'; path: string; uid: string; type: EntryType }
    | { kind: 'trashLocal'; path: string; type: EntryType }
    /** Both sides already agree (e.g. same folder on both); store it in base. */
    | { kind: 'record'; path: string; uid: string; type: EntryType }
    /** Gone on both sides; drop from base. */
    | { kind: 'forget'; path: string }
    /** File on one side, folder on the other: left alone and reported. */
    | { kind: 'typeMismatch'; path: string };
