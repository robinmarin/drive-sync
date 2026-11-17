import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Config } from '../config';
import { RemoteTree } from '../proton/remote';
import { StateDb } from './db';
import { SyncEngine } from './engine';
import { FakeDrive } from './fakeDrive';
import { LocalTree } from './local';

let dir: string;
let drive: FakeDrive;
let engine: SyncEngine;
let local: LocalTree;
let db: StateDb;

const cfg = (root: string): Config => ({ localRoot: root, remoteRoot: '/my-files/test', maxDeleteRatio: 0.5, maxDeleteMin: 3 });
const L = (p: string) => path.join(dir, 'local', p);
const write = (p: string, s: string) => {
    mkdirSync(path.dirname(L(p)), { recursive: true });
    writeFileSync(L(p), s);
};
const read = (p: string) => readFileSync(L(p), 'utf8');

async function setup() {
    const sdk = drive as any;
    const rootUid = await RemoteTree.resolveRoot(sdk, '/my-files/test', () => {});
    const remote = new RemoteTree(sdk, rootUid, () => {});
    await remote.load();
    await remote.subscribe(() => {});
    local = new LocalTree(L(''));
    mkdirSync(L(''), { recursive: true });
    await local.ensureMeta();
    db = new StateDb(path.join(dir, 'state.sqlite'));
    engine = new SyncEngine(cfg(L('')), sdk, remote, local, db, () => {}, () => {}, { settleMs: 0 });
}

beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'drivesync-test-'));
    drive = new FakeDrive();
});
afterEach(() => {
    engine?.stop();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('engine against a fake Drive', () => {
    test('first sync merges both sides', async () => {
        await setup();
        await drive.externalMkdir('test/docs');
        await drive.externalWrite('test/docs/remote.txt', 'from drive');
        write('notes/local.txt', 'from disk');

        await engine.pass();

        expect(read('docs/remote.txt')).toBe('from drive');
        expect(drive.read('test/notes/local.txt')).toBe('from disk');
        expect(engine.status.errors).toEqual([]);

        // A second pass is a no-op and does not re-list the remote tree.
        const lists = drive.calls.list;
        await engine.pass();
        expect(engine.status.recent.length).toBe(4); // mkdirLocal docs, download, mkdirRemote notes, upload
        expect(drive.calls.list).toBe(lists);
    });

    test('local edit uploads a new revision; remote edit downloads', async () => {
        await setup();
        write('a.txt', 'v1');
        await engine.pass();
        const uid = drive.pathUid('test/a.txt');

        write('a.txt', 'v2 local');
        await engine.pass();
        expect(drive.read('test/a.txt')).toBe('v2 local');
        expect(drive.pathUid('test/a.txt')).toBe(uid); // same node, new revision

        await drive.externalWrite('test/a.txt', 'v3 remote');
        await engine.pass();
        expect(read('a.txt')).toBe('v3 remote');
    });

    test('edits on both sides keep both versions', async () => {
        await setup();
        write('a.txt', 'base');
        await engine.pass();

        await Bun.sleep(5);
        write('a.txt', 'mine');
        await drive.externalWrite('test/a.txt', 'theirs');
        await engine.pass(); // renames local copy, downloads remote
        await engine.pass(); // uploads the conflicted copy

        expect(read('a.txt')).toBe('theirs');
        const copy = readdirSync(L('')).find((n) => n.includes('conflicted copy'));
        expect(copy).toBeDefined();
        expect(read(copy!)).toBe('mine');
        expect(drive.read(`test/${copy}`)).toBe('mine');
    });

    test('identical content on both sides is not a conflict', async () => {
        await setup();
        write('same.txt', 'same');
        await drive.externalWrite('test/same.txt', 'same');
        await engine.pass();
        expect(readdirSync(L('')).filter((n) => n !== '.drivesync')).toEqual(['same.txt']);
    });

    test('local delete trashes remotely; remote delete moves to local trash', async () => {
        await setup();
        write('x.txt', 'x');
        write('y.txt', 'y');
        write('keep.txt', 'k');
        write('keep2.txt', 'k');
        await engine.pass();

        unlinkSync(L('x.txt'));
        await drive.externalTrash('test/y.txt');
        await engine.pass();

        expect(drive.pathUid('test/x.txt')).toBeUndefined();
        expect(existsSync(L('y.txt'))).toBe(false);
        const trashed = readdirSync(path.join(L('.drivesync'), 'trash'), { recursive: true }).map(String);
        expect(trashed.some((p) => p.endsWith('y.txt'))).toBe(true);
    });

    test('mass deletion is blocked until explicitly allowed', async () => {
        await setup();
        for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) write(`${n}.txt`, n);
        await engine.pass();
        for (const n of ['a', 'b', 'c', 'd', 'e']) unlinkSync(L(`${n}.txt`));

        await engine.pass();
        expect(engine.status.paused).toBe(true);
        expect(engine.status.blockedDeletes).toBe(5);
        expect(drive.pathUid('test/a.txt')).toBeDefined();

        engine.resume({ allowDeletes: true });
        await engine.pass();
        expect(drive.pathUid('test/a.txt')).toBeUndefined();
        expect(drive.pathUid('test/f.txt')).toBeDefined();
    });

    test('missing local root pauses instead of deleting everything remotely', async () => {
        await setup();
        write('a.txt', 'a');
        await engine.pass();
        rmSync(L(''), { recursive: true, force: true });

        await engine.pass();
        expect(engine.status.paused).toBe(true);
        expect(engine.status.state).toBe('error');
        expect(drive.pathUid('test/a.txt')).toBeDefined();
    });

    test('remote folder created by another device syncs down via events', async () => {
        await setup();
        await engine.pass();
        await drive.externalMkdir('test/new');
        await drive.externalWrite('test/new/file.txt', 'hello');
        await engine.pass();
        expect(read('new/file.txt')).toBe('hello');
    });
});
