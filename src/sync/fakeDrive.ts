// Minimal in-memory stand-in for ProtonDriveClient, implementing just the
// calls RemoteTree and SyncEngine use. Test-only.

import { DriveEventType, NodeType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';

interface FNode {
    uid: string;
    parentUid?: string;
    name: string;
    type: 'file' | 'folder';
    content?: Uint8Array;
    revUid?: string;
    mtime?: Date;
    trashed?: boolean;
}

let seq = 0;
const id = (p: string) => `${p}${++seq}`;

function sha1(b: Uint8Array): string {
    return new Bun.CryptoHasher('sha1').update(b).digest('hex');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class FakeDrive {
    nodes = new Map<string, FNode>();
    rootUid = 'root';
    private listeners: ((e: any) => Promise<void>)[] = [];
    calls = { list: 0 };

    constructor() {
        this.nodes.set(this.rootUid, { uid: this.rootUid, name: 'my-files', type: 'folder' });
    }

    // ---- helpers for tests (simulate another device) --------------------

    pathUid(p: string): string | undefined {
        let cur = this.rootUid;
        for (const name of p.split('/').filter(Boolean)) {
            const next = this.children(cur).find((n) => n.name === name);
            if (!next) return undefined;
            cur = next.uid;
        }
        return cur;
    }

    read(p: string): string | undefined {
        const uid = this.pathUid(p);
        const n = uid ? this.nodes.get(uid) : undefined;
        return n?.content ? new TextDecoder().decode(n.content) : undefined;
    }

    async externalMkdir(p: string): Promise<string> {
        const parts = p.split('/');
        const parent = this.pathUid(parts.slice(0, -1).join('/'))!;
        const n: FNode = { uid: id('d'), parentUid: parent, name: parts.at(-1)!, type: 'folder' };
        this.nodes.set(n.uid, n);
        await this.emit(DriveEventType.NodeCreated, n);
        return n.uid;
    }

    async externalWrite(p: string, text: string): Promise<void> {
        const existing = this.pathUid(p);
        const content = new TextEncoder().encode(text);
        if (existing) {
            const n = this.nodes.get(existing)!;
            Object.assign(n, { content, revUid: id('r'), mtime: new Date() });
            await this.emit(DriveEventType.NodeUpdated, n);
        } else {
            const parts = p.split('/');
            const parent = this.pathUid(parts.slice(0, -1).join('/'))!;
            const n: FNode = { uid: id('f'), parentUid: parent, name: parts.at(-1)!, type: 'file', content, revUid: id('r'), mtime: new Date() };
            this.nodes.set(n.uid, n);
            await this.emit(DriveEventType.NodeCreated, n);
        }
    }

    async externalTrash(p: string): Promise<void> {
        const n = this.nodes.get(this.pathUid(p)!)!;
        n.trashed = true;
        await this.emit(DriveEventType.NodeUpdated, n);
    }

    private async emit(type: DriveEventType, n: FNode) {
        for (const l of this.listeners) {
            await l({ type, nodeUid: n.uid, parentNodeUid: n.parentUid, isTrashed: !!n.trashed, isShared: false, treeEventScopeId: 'vol', eventId: id('e') });
        }
    }

    private children(uid: string): FNode[] {
        return [...this.nodes.values()].filter((n) => n.parentUid === uid && !n.trashed);
    }

    private entity(n: FNode): any {
        return {
            uid: n.uid,
            parentUid: n.parentUid,
            name: { ok: true, value: n.name },
            type: n.type === 'folder' ? NodeType.Folder : NodeType.File,
            trashTime: n.trashed ? new Date() : undefined,
            treeEventScopeId: 'vol',
            activeRevision:
                n.type === 'file'
                    ? {
                          uid: n.revUid,
                          claimedSize: n.content?.length,
                          claimedDigests: { sha1: n.content ? sha1(n.content) : undefined, sha1Verified: true },
                          claimedModificationTime: n.mtime,
                      }
                    : undefined,
        };
    }

    private uidOf(x: any): string {
        return typeof x === 'string' ? x : x.uid;
    }

    // ---- ProtonDriveClient subset ----------------------------------------

    async getMyFilesRootFolder() {
        return this.entity(this.nodes.get(this.rootUid)!);
    }

    async *iterateFolderChildren(parent: any, filter?: { type?: NodeType }) {
        this.calls.list += 1;
        for (const n of this.children(this.uidOf(parent))) {
            const e = this.entity(n);
            if (!filter?.type || e.type === filter.type) yield e;
        }
    }

    async getNode(uid: any) {
        const n = this.nodes.get(this.uidOf(uid));
        if (!n) throw new Error('not found');
        return this.entity(n);
    }

    async createFolder(parent: any, name: string) {
        const p = this.uidOf(parent);
        const dup = this.children(p).find((c) => c.name === name);
        if (dup) throw new NodeWithSameNameExistsValidationError('exists', 2500, dup.uid);
        const n: FNode = { uid: id('d'), parentUid: p, name, type: 'folder' };
        this.nodes.set(n.uid, n);
        return this.entity(n);
    }

    async getFileUploader(parent: any, name: string, meta: any) {
        const p = this.uidOf(parent);
        const dup = this.children(p).find((c) => c.name === name);
        if (dup) throw new NodeWithSameNameExistsValidationError('exists', 2500, dup.uid);
        return this.uploader(meta, (content) => {
            const n: FNode = { uid: id('f'), parentUid: p, name, type: 'file', content, revUid: id('r'), mtime: meta.modificationTime };
            this.nodes.set(n.uid, n);
            return n;
        });
    }

    async getFileRevisionUploader(uid: any, meta: any) {
        return this.uploader(meta, (content) => {
            const n = this.nodes.get(this.uidOf(uid))!;
            Object.assign(n, { content, revUid: id('r'), mtime: meta.modificationTime });
            return n;
        });
    }

    private uploader(meta: any, commit: (c: Uint8Array) => FNode) {
        return {
            uploadFromStream: async (stream: ReadableStream<Uint8Array>) => ({
                completion: async () => {
                    const content = await readAll(stream);
                    if (meta.expectedSha1 && meta.expectedSha1 !== sha1(content)) throw new Error('integrity');
                    const n = commit(content);
                    return { nodeUid: n.uid, nodeRevisionUid: n.revUid };
                },
            }),
        };
    }

    async getFileDownloader(uid: any) {
        const n = this.nodes.get(this.uidOf(uid))!;
        return {
            downloadToStream: (ws: WritableStream<Uint8Array>) => ({
                completion: async () => {
                    const w = ws.getWriter();
                    await w.write(n.content ?? new Uint8Array());
                    await w.close();
                },
            }),
        };
    }

    async *trashNodes(uids: any[]) {
        for (const u of uids) {
            const n = this.nodes.get(this.uidOf(u));
            if (n) n.trashed = true;
            yield { uid: this.uidOf(u), ok: true as const };
        }
    }

    async subscribeToTreeEvents(_scope: string, cb: (e: any) => Promise<void>) {
        this.listeners.push(cb);
        return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)), getLatestEventId: () => null };
    }
}
