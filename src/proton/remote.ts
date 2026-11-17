// In-memory mirror of the remote sync root, kept current by Drive events so
// that sync passes never need to re-walk the remote tree. A full listing only
// happens at startup and when the server asks for a tree refresh.

import {
    type DriveEvent,
    DriveEventType,
    type EventSubscription,
    type NodeEntity,
    NodeType,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import type { EntryType, RemoteEntry } from '../sync/types';

interface RNode {
    uid: string;
    parentUid?: string;
    name: string;
    type: EntryType;
    revUid?: string;
    size?: number;
    sha1?: string;
    mtimeMs?: number;
}

type Log = (msg: string) => void;

function toRNode(node: NodeEntity): RNode | undefined {
    if (node.trashTime) return undefined;
    if (!node.name.ok) return undefined;
    const type: EntryType | undefined =
        node.type === NodeType.Folder ? 'folder' : node.type === NodeType.File ? 'file' : undefined;
    if (!type) return undefined;
    const rev = node.activeRevision;
    return {
        uid: node.uid,
        parentUid: node.parentUid,
        name: node.name.value,
        type,
        revUid: rev?.uid,
        size: rev?.claimedSize,
        sha1: rev?.claimedDigests?.sha1,
        mtimeMs: rev?.claimedModificationTime?.getTime(),
    };
}

export class RemoteTree {
    private nodes = new Map<string, RNode>();
    private children = new Map<string, Set<string>>();
    private subscription?: EventSubscription;

    constructor(
        private sdk: ProtonDriveClient,
        public readonly rootUid: string,
        private log: Log,
    ) {}

    /** Resolve (creating if needed) a /my-files/... path to its folder UID. */
    static async resolveRoot(sdk: ProtonDriveClient, remotePath: string, log: Log): Promise<string> {
        const parts = remotePath.split('/').filter(Boolean);
        if (parts[0] !== 'my-files') throw new Error(`Remote root must be under /my-files: ${remotePath}`);
        let folder = await sdk.getMyFilesRootFolder();
        for (const name of parts.slice(1)) {
            let next: NodeEntity | undefined;
            for await (const child of sdk.iterateFolderChildren(folder, { type: NodeType.Folder })) {
                if (child.name.ok && child.name.value === name && !child.trashTime) {
                    next = child;
                    break;
                }
            }
            if (!next) {
                log(`Creating remote folder ${name} under ${folder.name.ok ? folder.name.value : folder.uid}`);
                next = await sdk.createFolder(folder, name);
            }
            folder = next;
        }
        return folder.uid;
    }

    async load(): Promise<void> {
        this.nodes.clear();
        this.children.clear();
        await this.loadChildren(this.rootUid);
    }

    private async loadChildren(folderUid: string): Promise<void> {
        const queue = [folderUid];
        while (queue.length) {
            const uid = queue.shift()!;
            for await (const child of this.sdk.iterateFolderChildren(uid)) {
                const n = toRNode(child);
                if (!n) {
                    if (!child.name.ok) this.log(`Skipping remote node with undecryptable name: ${child.uid}`);
                    continue;
                }
                this.put(n);
                if (n.type === 'folder') queue.push(n.uid);
            }
        }
    }

    private put(n: RNode): void {
        const old = this.nodes.get(n.uid);
        if (old?.parentUid && old.parentUid !== n.parentUid) this.children.get(old.parentUid)?.delete(n.uid);
        this.nodes.set(n.uid, n);
        if (n.parentUid) {
            let set = this.children.get(n.parentUid);
            if (!set) this.children.set(n.parentUid, (set = new Set()));
            set.add(n.uid);
        }
    }

    remove(uid: string): void {
        const n = this.nodes.get(uid);
        for (const child of [...(this.children.get(uid) ?? [])]) this.remove(child);
        this.children.delete(uid);
        if (n?.parentUid) this.children.get(n.parentUid)?.delete(uid);
        this.nodes.delete(uid);
    }

    /** Insert/refresh a node we just created or changed ourselves. */
    upsert(node: NodeEntity): void {
        const n = toRNode(node);
        if (n && this.isInTree(n.parentUid)) this.put(n);
        else this.remove(node.uid);
    }

    private isInTree(parentUid?: string): boolean {
        return !!parentUid && (parentUid === this.rootUid || this.nodes.get(parentUid)?.type === 'folder');
    }

    pathOf(uid: string): string | undefined {
        const parts: string[] = [];
        let cur = this.nodes.get(uid);
        while (cur) {
            parts.unshift(cur.name);
            if (cur.parentUid === this.rootUid) return parts.join('/');
            cur = cur.parentUid ? this.nodes.get(cur.parentUid) : undefined;
        }
        return undefined;
    }

    /** UID of the folder at a relative path ('' is the root). */
    folderUid(rel: string): string | undefined {
        if (rel === '') return this.rootUid;
        let cur = this.rootUid;
        for (const name of rel.split('/')) {
            const next = [...(this.children.get(cur) ?? [])].map((u) => this.nodes.get(u)!).find((n) => n.name === name);
            if (!next || next.type !== 'folder') return undefined;
            cur = next.uid;
        }
        return cur;
    }

    snapshot(): Map<string, RemoteEntry> {
        const out = new Map<string, RemoteEntry>();
        const walk = (folderUid: string, prefix: string) => {
            for (const uid of this.children.get(folderUid) ?? []) {
                const n = this.nodes.get(uid)!;
                const p = prefix ? `${prefix}/${n.name}` : n.name;
                out.set(p, { type: n.type, uid: n.uid, revUid: n.revUid, size: n.size, sha1: n.sha1, mtimeMs: n.mtimeMs });
                if (n.type === 'folder') walk(uid, p);
            }
        };
        walk(this.rootUid, '');
        return out;
    }

    /**
     * Subscribe to Drive events for the root's tree scope. `onChange` is called
     * after the mirror has been updated for an event that touched our tree.
     */
    async subscribe(onChange: () => void): Promise<void> {
        const root = await this.sdk.getNode(this.rootUid);
        this.subscription = await this.sdk.subscribeToTreeEvents(root.treeEventScopeId, async (event) => {
            try {
                if (await this.applyEvent(event)) onChange();
            } catch (e) {
                this.log(`Failed to apply remote event ${event.type}: ${e instanceof Error ? e.message : e}`);
                onChange(); // let a pass run; it will surface any real problem
            }
        });
    }

    unsubscribe(): void {
        this.subscription?.dispose();
        this.subscription = undefined;
    }

    /** Returns true if the event affected the synced tree. */
    private async applyEvent(event: DriveEvent): Promise<boolean> {
        switch (event.type) {
            case DriveEventType.TreeRefresh:
                this.log('Server requested a tree refresh; reloading remote tree');
                await this.load();
                return true;
            case DriveEventType.NodeDeleted: {
                if (!this.nodes.has(event.nodeUid)) return false;
                this.remove(event.nodeUid);
                return true;
            }
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated: {
                const known = this.nodes.has(event.nodeUid);
                const parentKnown = this.isInTree(event.parentNodeUid);
                if (!known && !parentKnown) return false; // somewhere else on the Drive
                if (event.isTrashed) {
                    this.remove(event.nodeUid);
                    return known;
                }
                const node = await this.sdk.getNode(event.nodeUid);
                const n = toRNode(node);
                if (!n || !this.isInTree(n.parentUid)) {
                    this.remove(event.nodeUid); // trashed, renamed to garbage, or moved out
                    return known;
                }
                const wasFolderKnown = known && this.nodes.get(n.uid)?.type === 'folder';
                this.put(n);
                if (n.type === 'folder' && !wasFolderKnown) await this.loadChildren(n.uid); // moved in with content
                return true;
            }
            default:
                return false;
        }
    }
}
