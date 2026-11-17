import { describe, expect, test } from 'bun:test';

import { plan } from './planner';
import type { BaseEntry, LocalEntry, RemoteEntry } from './types';

const lf = (size = 1, mtimeMs = 1000): LocalEntry => ({ type: 'file', size, mtimeMs });
const ld = (): LocalEntry => ({ type: 'folder', size: 0, mtimeMs: 0 });
const rf = (uid: string, revUid = `${uid}-r1`): RemoteEntry => ({ type: 'file', uid, revUid });
const rd = (uid: string): RemoteEntry => ({ type: 'folder', uid });
const bf = (uid: string, revUid = `${uid}-r1`, size = 1, mtimeMs = 1000): BaseEntry => ({ type: 'file', uid, revUid, size, mtimeMs });
const bd = (uid: string): BaseEntry => ({ type: 'folder', uid });

function run(l: Record<string, LocalEntry>, r: Record<string, RemoteEntry>, b: Record<string, BaseEntry>) {
    return plan(new Map(Object.entries(l)), new Map(Object.entries(r)), new Map(Object.entries(b)));
}
const kinds = (p: ReturnType<typeof run>) => p.actions.map((a) => `${a.kind}:${a.path}`);

describe('files', () => {
    test('in sync → nothing', () => {
        expect(run({ a: lf() }, { a: rf('A') }, { a: bf('A') }).actions).toEqual([]);
    });
    test('new local → upload', () => {
        expect(kinds(run({ a: lf() }, {}, {}))).toEqual(['upload:a']);
    });
    test('new remote → download', () => {
        expect(kinds(run({}, { a: rf('A') }, {}))).toEqual(['download:a']);
    });
    test('local edit → upload new revision', () => {
        const p = run({ a: lf(2, 2000) }, { a: rf('A') }, { a: bf('A') });
        expect(p.actions).toEqual([{ kind: 'upload', path: 'a', replaceUid: 'A' }]);
    });
    test('remote edit → download', () => {
        expect(kinds(run({ a: lf() }, { a: rf('A', 'A-r2') }, { a: bf('A') }))).toEqual(['download:a']);
    });
    test('both edited → reconcile (never overwrite)', () => {
        expect(kinds(run({ a: lf(2, 2000) }, { a: rf('A', 'A-r2') }, { a: bf('A') }))).toEqual(['reconcile:a']);
    });
    test('both new → reconcile', () => {
        expect(kinds(run({ a: lf() }, { a: rf('A') }, {}))).toEqual(['reconcile:a']);
    });
    test('deleted locally, unchanged remotely → trash remote', () => {
        expect(kinds(run({}, { a: rf('A') }, { a: bf('A') }))).toEqual(['trashRemote:a']);
    });
    test('deleted locally, edited remotely → download (edit wins)', () => {
        expect(kinds(run({}, { a: rf('A', 'A-r2') }, { a: bf('A') }))).toEqual(['download:a']);
    });
    test('deleted remotely, unchanged locally → trash local', () => {
        expect(kinds(run({ a: lf() }, {}, { a: bf('A') }))).toEqual(['trashLocal:a']);
    });
    test('deleted remotely, edited locally → upload (edit wins)', () => {
        expect(run({ a: lf(5, 5000) }, {}, { a: bf('A') }).actions).toEqual([{ kind: 'upload', path: 'a' }]);
    });
    test('gone on both sides → forget', () => {
        expect(kinds(run({}, {}, { a: bf('A') }))).toEqual(['forget:a']);
    });
    test('file vs folder → reported, not touched', () => {
        expect(kinds(run({ a: lf() }, { a: rd('A') }, {}))).toEqual(['typeMismatch:a']);
    });
});

describe('folders', () => {
    test('new local folder → created remotely before its files are uploaded', () => {
        expect(kinds(run({ d: ld(), 'd/x': lf() }, {}, {}))).toEqual(['mkdirRemote:d', 'upload:d/x']);
    });
    test('nested new remote folders → created parent-first', () => {
        expect(kinds(run({}, { 'd/e': rd('E'), d: rd('D') }, {}))).toEqual(['mkdirLocal:d', 'mkdirLocal:d/e']);
    });
    test('same folder on both sides without base → record', () => {
        expect(kinds(run({ d: ld() }, { d: rd('D') }, {}))).toEqual(['record:d']);
    });
    test('folder deleted locally with unchanged content → only the folder is trashed remotely', () => {
        const p = run({}, { d: rd('D'), 'd/x': rf('X') }, { d: bd('D'), 'd/x': bf('X') });
        expect(kinds(p)).toEqual(['trashRemote:d']);
        expect(p.deletions).toBe(2);
    });
    test('folder deleted locally but a file inside changed remotely → folder recreated, file downloaded', () => {
        const p = run(
            {},
            { d: rd('D'), 'd/x': rf('X', 'X-r2'), 'd/y': rf('Y') },
            { d: bd('D'), 'd/x': bf('X'), 'd/y': bf('Y') },
        );
        expect(kinds(p)).toEqual(['mkdirLocal:d', 'download:d/x', 'trashRemote:d/y']);
    });
    test('folder deleted remotely but local file added inside → folder recreated remotely', () => {
        const p = run({ d: ld(), 'd/new': lf() }, {}, { d: bd('D') });
        expect(kinds(p)).toEqual(['mkdirRemote:d', 'upload:d/new']);
    });
    test('recreation propagates to ancestors', () => {
        const p = run(
            {},
            { a: rd('A'), 'a/b': rd('B'), 'a/b/x': rf('X', 'X-r2') },
            { a: bd('A'), 'a/b': bd('B'), 'a/b/x': bf('X') },
        );
        expect(kinds(p)).toEqual(['mkdirLocal:a', 'mkdirLocal:a/b', 'download:a/b/x']);
    });
});
