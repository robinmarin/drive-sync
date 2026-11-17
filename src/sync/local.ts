import { lstat, mkdir, readdir, rename, utimes } from 'node:fs/promises';
import path from 'node:path';

import type { LocalEntry } from './types';

/** Hidden per-root folder for the marker, temp downloads and local trash. */
export const META_DIR = '.drivesync';

const IGNORED: RegExp[] = [
    /^\.~lock\..*#$/, // LibreOffice lock files
    /^~\$/, // MS Office owner files
    /\.sw[po]$/, // vim swap
    /~$/, // editor backups
    /^\.goutputstream-/, // GTK atomic-save temp files
    /\.(part|crdownload|tmp)$/,
    /^\.#/, // emacs locks
    /^\.DS_Store$/,
];

export function isIgnoredName(name: string): boolean {
    return IGNORED.some((re) => re.test(name));
}

export class LocalTree {
    constructor(public readonly root: string) {}

    abs(rel: string): string {
        return rel ? path.join(this.root, ...rel.split('/')) : this.root;
    }

    get metaDir() {
        return path.join(this.root, META_DIR);
    }
    get markerFile() {
        return path.join(this.metaDir, 'marker');
    }

    async ensureMeta(): Promise<void> {
        await mkdir(path.join(this.metaDir, 'tmp'), { recursive: true });
        await mkdir(path.join(this.metaDir, 'trash'), { recursive: true });
        const marker = Bun.file(this.markerFile);
        if (!(await marker.exists())) {
            await Bun.write(marker, 'This folder is synced by drivesync. Do not delete this directory.\n');
        }
    }

    async hasMarker(): Promise<boolean> {
        return Bun.file(this.markerFile).exists();
    }

    /** Walk the tree. Symlinks and special files are skipped (and reported). */
    async scan(onSkip?: (rel: string, why: string) => void): Promise<Map<string, LocalEntry>> {
        const out = new Map<string, LocalEntry>();
        const walk = async (rel: string) => {
            let names: string[];
            try {
                names = await readdir(this.abs(rel));
            } catch (e: any) {
                if (e?.code === 'ENOENT') return;
                throw e;
            }
            for (const name of names) {
                if (rel === '' && name === META_DIR) continue;
                if (isIgnoredName(name)) continue;
                const childRel = rel ? `${rel}/${name}` : name;
                let st;
                try {
                    st = await lstat(this.abs(childRel));
                } catch (e: any) {
                    if (e?.code === 'ENOENT') continue; // vanished mid-scan
                    throw e;
                }
                if (st.isSymbolicLink()) {
                    onSkip?.(childRel, 'symlink');
                } else if (st.isDirectory()) {
                    out.set(childRel, { type: 'folder', size: 0, mtimeMs: st.mtimeMs });
                    await walk(childRel);
                } else if (st.isFile()) {
                    out.set(childRel, { type: 'file', size: st.size, mtimeMs: st.mtimeMs });
                } else {
                    onSkip?.(childRel, 'special file');
                }
            }
        };
        await walk('');
        return out;
    }

    async stat(rel: string): Promise<LocalEntry | undefined> {
        try {
            const st = await lstat(this.abs(rel));
            if (st.isDirectory()) return { type: 'folder', size: 0, mtimeMs: st.mtimeMs };
            if (st.isFile()) return { type: 'file', size: st.size, mtimeMs: st.mtimeMs };
        } catch (e: any) {
            if (e?.code !== 'ENOENT') throw e;
        }
        return undefined;
    }

    tmpPath(): string {
        return path.join(this.metaDir, 'tmp', `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    }

    /** Move into the local trash instead of deleting, preserving the relative path. */
    async trash(rel: string, batch: string): Promise<void> {
        const dest = path.join(this.metaDir, 'trash', batch, ...rel.split('/'));
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(this.abs(rel), dest);
    }

    async mkdir(rel: string): Promise<void> {
        await mkdir(this.abs(rel), { recursive: true });
    }

    async moveInto(tmp: string, rel: string, mtime?: Date): Promise<void> {
        if (mtime) await utimes(tmp, mtime, mtime);
        await mkdir(path.dirname(this.abs(rel)), { recursive: true });
        await rename(tmp, this.abs(rel));
    }

    async renameRel(from: string, to: string): Promise<void> {
        await rename(this.abs(from), this.abs(to));
    }
}

export async function sha1File(absPath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha1');
    for await (const chunk of Bun.file(absPath).stream()) hasher.update(chunk);
    return hasher.digest('hex');
}

export function conflictName(rel: string, host: string, when = new Date()): string {
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    const stamp = when.toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
    const name = `${stem} (conflicted copy ${stamp} ${host})${ext}`;
    return dir === '.' ? name : `${dir}/${name}`;
}
