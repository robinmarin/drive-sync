// Daemon ⇄ clients. The daemon atomically rewrites a status JSON file on every
// change (the bar plugin just watches that file) and listens on a Unix socket
// for line-delimited JSON commands from the `drivesync` CLI.

import { mkdirSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { files } from './config';

export type Command = { cmd: 'status' } | { cmd: 'pause' } | { cmd: 'resume'; allowDeletes?: boolean } | { cmd: 'sync' };

let writing: Promise<void> = Promise.resolve();
let pendingStatus: unknown;

/** Coalescing atomic write of the status file. */
export function writeStatus(status: unknown): void {
    pendingStatus = structuredClone(status);
    writing = writing.then(async () => {
        if (pendingStatus === undefined) return;
        const data = JSON.stringify({ ...(pendingStatus as object), updatedAt: new Date().toISOString(), pid: process.pid }, null, 2);
        pendingStatus = undefined;
        mkdirSync(path.dirname(files.status), { recursive: true, mode: 0o700 });
        const tmp = `${files.status}.tmp`;
        await Bun.write(tmp, data);
        await rename(tmp, files.status);
    }).catch(() => {});
}

export async function clearStatus(state: string, message: string): Promise<void> {
    mkdirSync(path.dirname(files.status), { recursive: true, mode: 0o700 });
    await Bun.write(files.status, JSON.stringify({ state, message, updatedAt: new Date().toISOString() }, null, 2));
}

export async function serveControl(handle: (c: Command) => unknown): Promise<() => void> {
    mkdirSync(path.dirname(files.socket), { recursive: true, mode: 0o700 });
    await unlink(files.socket).catch(() => {});
    const server = Bun.listen<{ buf: string }>({
        unix: files.socket,
        socket: {
            open(s) {
                s.data = { buf: '' };
            },
            data(s, chunk) {
                s.data.buf += chunk.toString();
                let nl;
                while ((nl = s.data.buf.indexOf('\n')) >= 0) {
                    const line = s.data.buf.slice(0, nl);
                    s.data.buf = s.data.buf.slice(nl + 1);
                    let reply: unknown;
                    try {
                        reply = { ok: true, result: handle(JSON.parse(line) as Command) };
                    } catch (e) {
                        reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
                    }
                    s.write(JSON.stringify(reply) + '\n');
                }
            },
        },
    });
    return () => {
        server.stop(true);
        unlink(files.socket).catch(() => {});
    };
}

export async function sendCommand(command: Command): Promise<any> {
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    let buf = '';
    try {
        const sock = await Bun.connect({
            unix: files.socket,
            socket: {
                data(s, chunk) {
                    buf += chunk.toString();
                    const nl = buf.indexOf('\n');
                    if (nl >= 0) {
                        try {
                            const reply = JSON.parse(buf.slice(0, nl));
                            reply.ok ? resolve(reply.result) : reject(new Error(reply.error));
                        } catch (e) {
                            reject(e);
                        }
                        s.end(); // after settling, so close() below is a no-op
                    }
                },
                error(_s, e) {
                    reject(e);
                },
                close() {
                    reject(new Error('Connection closed'));
                },
            },
        });
        sock.write(JSON.stringify(command) + '\n');
    } catch {
        throw new Error('drivesync daemon is not running (start it with: systemctl --user start drivesync)');
    }
    return promise;
}
