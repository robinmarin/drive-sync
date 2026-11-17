import { describe, expect, test } from 'bun:test';

// The bar widget's pure helpers (plain JS shared with QML).
const Model = require('../shell-plugin/Model.js');

describe('shell plugin model', () => {
    test('parses a daemon status file', () => {
        const s = Model.parseStatus(
            JSON.stringify({
                state: 'syncing',
                paused: false,
                localRoot: '/home/u/Drive',
                remoteRoot: '/my-files/x',
                pending: 3,
                current: { action: 'upload', path: 'a/b.txt' },
                recent: [{ time: '2026-11-17T10:00:00Z', action: 'download', path: 'c.txt' }],
                errors: [{ time: '2026-11-17T10:00:00Z', message: 'boom' }],
                pid: 42,
            }),
        );
        expect(s.state).toBe('syncing');
        expect(s.pending).toBe(3);
        expect(s.current).toEqual({ action: 'upload', path: 'a/b.txt' });
        expect(s.recent[0].time).toBe(Date.parse('2026-11-17T10:00:00Z'));
        expect(s.errors[0].path).toBe('');
        expect(s.pid).toBe(42);
    });

    test('rejects garbage and unknown states', () => {
        expect(Model.parseStatus('').state).toBe('missing');
        expect(Model.parseStatus('[1,2]').state).toBe('missing');
        expect(Model.parseStatus('{"state":"<b>x</b>"}').state).toBe('missing');
    });

    test('bounds untrusted fields', () => {
        const s = Model.parseStatus(
            JSON.stringify({
                state: 'idle',
                message: 'x'.repeat(5000),
                pending: -4,
                recent: Array.from({ length: 100 }, (_, i) => ({ action: 'upload', path: `f${i}\n` })),
                errors: [null, { message: 7 }, ...Array.from({ length: 50 }, () => ({ message: 'e' }))],
            }),
        );
        expect(s.message.length).toBeLessThanOrEqual(300);
        expect(s.pending).toBe(0);
        expect(s.recent.length).toBe(30);
        expect(s.recent[0].path).toBe('f0 ');
        expect(s.errors.length).toBe(5);
    });

    test('markup in paths stays as text', () => {
        const s = Model.parseStatus(JSON.stringify({ state: 'idle', recent: [{ action: 'upload', path: '<img src="https://x.invalid/t">' }] }));
        // Passed through verbatim; the QML renders it with Text.PlainText.
        expect(Model.baseName(s.recent[0].path)).toBe('t">');
        expect(Model.actionKey('<script>')).toBe('action.other');
        expect(Model.stateKey('nope')).toBe('state.missing');
    });

    test('a dead daemon reads as stopped', () => {
        const s = Model.parseStatus('{"state":"syncing","pid":1}');
        expect(Model.effectiveState(s, true)).toBe('syncing');
        expect(Model.effectiveState(s, false)).toBe('stopped');
        expect(Model.effectiveState(Model.parseStatus('{"state":"signed_out"}'), false)).toBe('signed_out');
    });

    test('helpers', () => {
        const now = Date.parse('2026-11-17T12:00:00Z');
        expect(Model.relativeParts(0, now)).toEqual(['time.never', 0]);
        expect(Model.relativeParts(now - 30_000, now)).toEqual(['time.justNow', 0]);
        expect(Model.relativeParts(now - 5 * 60_000, now)).toEqual(['time.minutesAgo', 5]);
        expect(Model.relativeParts(now - 3 * 3600_000, now)).toEqual(['time.hoursAgo', 3]);
        expect(Model.joinPath('/home/u/Drive/', '/a/b')).toBe('/home/u/Drive/a/b');
        expect(Model.parentDir('a/b/c.txt')).toBe('a/b');
        expect(Model.fileUri('/a b/#c')).toBe('file:///a%20b/%23c');
        expect(JSON.parse(Model.command('resume', { allowDeletes: true }))).toEqual({ cmd: 'resume', allowDeletes: true });
    });
});
