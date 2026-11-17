import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('control socket round-trip and status file', async () => {
    process.env.XDG_RUNTIME_DIR = mkdtempSync(path.join(tmpdir(), 'drivesync-rt-'));
    const { serveControl, sendCommand, writeStatus } = await import('./control');
    const { files } = await import('./config');

    let paused = false;
    const stop = await serveControl((c) => {
        if (c.cmd === 'pause') paused = true;
        return { state: paused ? 'paused' : 'idle' };
    });
    try {
        expect(await sendCommand({ cmd: 'status' })).toEqual({ state: 'idle' });
        expect(await sendCommand({ cmd: 'pause' })).toEqual({ state: 'paused' });
        expect(paused).toBe(true);

        writeStatus({ state: 'syncing', recent: [] });
        writeStatus({ state: 'idle', recent: [] });
        await Bun.sleep(50);
        expect(JSON.parse(readFileSync(files.status, 'utf8')).state).toBe('idle');
    } finally {
        stop();
    }
});
