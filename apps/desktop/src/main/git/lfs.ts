import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.ts';
import type { LfsFile, LfsInfo, WorkStatus } from '../../shared/git-types.ts';

// Git LFS. Everything here is read-only and works without git-lfs installed: LFS files
// are found through their gitattributes, and a working file that still holds the small
// pointer text hasn't been downloaded.

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';
const LFS_POINTER_MAX = 1024; // git-lfs never writes a pointer larger than this
const LFS_FILE_CAP = 5000;

export function parseLfsPointer(text: string | null | undefined): { oid: string; size: number } | null {
  if (!text || text.length > LFS_POINTER_MAX || !text.startsWith(LFS_POINTER)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text);
  const size = /^size (\d+)$/m.exec(text);
  return oid && size ? { oid: oid[1] ?? '', size: Number(size[1]) } : null;
}

// Patterns from the top-level .gitattributes that route files through the LFS filter.
export function parseLfsPatterns(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /(^|\s)filter=lfs(\s|$)/.test(l))
    .map((l) => l.split(/\s+/)[0] ?? '');
}

async function lfsVersion(cwd: string): Promise<string | null> {
  const out = await run(cwd, ['lfs', 'version']).catch(() => null);
  return out ? out.trim().split('\n')[0] ?? null : null;
}

async function lfsWorkState(root: string, p: string): Promise<Omit<LfsFile, 'path' | 'stored'>> {
  let fh;
  try { fh = await fs.promises.open(path.join(root, p), 'r'); } catch { return { state: 'missing' }; }
  try {
    const { size } = await fh.stat();
    if (size > LFS_POINTER_MAX) return { state: 'downloaded', size };
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    const ptr = parseLfsPointer(buf.toString('utf8'));
    return ptr ? { state: 'pointer', size: ptr.size, oid: ptr.oid } : { state: 'downloaded', size };
  } finally { await fh.close(); }
}

// used: the repository routes files through LFS. installed: git-lfs runs here.
// files[].state: 'downloaded' | 'pointer' (not fetched) | 'missing' (deleted from the working tree).
// files[].stored: false when the index holds the whole file instead of a pointer, which
// happens when the file was added without git-lfs installed.
export async function getLfs(cwd: string): Promise<LfsInfo> {
  const [attrs, staged, version] = await Promise.all([
    fs.promises.readFile(path.join(cwd, '.gitattributes'), 'utf8').catch(() => ''),
    run(cwd, ['ls-files', '-s', '-z', '--', ':(attr:filter=lfs)']),
    lfsVersion(cwd),
  ]);
  const patterns = parseLfsPatterns(attrs);
  const entries = new Map<string, string>();
  for (const rec of staged.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab > 0 && !entries.has(rec.slice(tab + 1))) entries.set(rec.slice(tab + 1), rec.split(' ')[1] ?? '');
  }
  const used = patterns.length > 0 || entries.size > 0;
  const list = [...entries].slice(0, LFS_FILE_CAP);
  const sizes = list.length ? (await run(cwd, ['cat-file', '--batch-check=%(objectsize)'], { input: list.map(([, oid]) => oid).join('\n') + '\n' })).split('\n') : [];
  const files = await Promise.all(list.map(async ([p], i) => ({ path: p, stored: !(Number(sizes[i]) > LFS_POINTER_MAX), ...(await lfsWorkState(cwd, p)) })));
  return { used, installed: !!version, version, patterns, files, truncated: entries.size > list.length };
}

// Marks status entries whose path goes through the LFS filter (lfs: true).
export async function markLfs<S extends WorkStatus>(cwd: string, status: S): Promise<S> {
  const all = [...status.staged, ...status.unstaged, ...status.conflicts];
  if (!all.length) return status;
  const out = await run(cwd, ['check-attr', '-z', '--stdin', 'filter'], { input: [...new Set(all.map((f) => f.path))].join('\0') + '\0' });
  const parts = out.split('\0');
  const lfs = new Set<string | undefined>();
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'lfs') lfs.add(parts[i]);
  for (const f of all) if (lfs.has(f.path)) f.lfs = true;
  return status;
}

