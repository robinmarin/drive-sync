import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { BaseEntry } from './types';

/** Persistent last-synced state ("base") plus a few metadata values. */
export class StateDb {
    private db: Database;

    constructor(file: string) {
        mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file, { create: true });
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS base (
                path TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                uid TEXT NOT NULL,
                rev_uid TEXT,
                size INTEGER,
                mtime_ms REAL,
                sha1 TEXT
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
    }

    loadBase(): Map<string, BaseEntry> {
        const rows = this.db.query('SELECT * FROM base').all() as any[];
        return new Map(
            rows.map((r) => [
                r.path,
                {
                    type: r.type,
                    uid: r.uid,
                    revUid: r.rev_uid ?? undefined,
                    size: r.size ?? undefined,
                    mtimeMs: r.mtime_ms ?? undefined,
                    sha1: r.sha1 ?? undefined,
                },
            ]),
        );
    }

    count(): number {
        return (this.db.query('SELECT COUNT(*) AS n FROM base').get() as any).n;
    }

    put(p: string, e: BaseEntry): void {
        this.db
            .query('INSERT OR REPLACE INTO base (path, type, uid, rev_uid, size, mtime_ms, sha1) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(p, e.type, e.uid, e.revUid ?? null, e.size ?? null, e.mtimeMs ?? null, e.sha1 ?? null);
    }

    /** Remove a path and, for folders, everything below it. */
    removeTree(p: string): void {
        this.db.query("DELETE FROM base WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(p, likePrefix(p));
    }

    getMeta(key: string): string | undefined {
        return (this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value;
    }

    setMeta(key: string, value: string): void {
        this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
    }

    reset(): void {
        this.db.exec('DELETE FROM base; DELETE FROM meta;');
    }

    close(): void {
        this.db.close();
    }
}

function likePrefix(p: string): string {
    return p.replace(/[\\%_]/g, (c) => '\\' + c) + '/%';
}
