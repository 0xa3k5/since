// Recent repositories (recent.json in userData): newest first, at most 20, folders that still exist.
import fs from 'node:fs';
import path from 'node:path';

export const MAX = 20;

export interface RecentRepo { root: string; name: string; opened: number }
type OpenRepo = (root: string) => Promise<{ root: string }>;

export function readRecent(file: string): RecentRepo[] {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as RecentRepo[]).filter((r) => fs.existsSync(r.root)); } catch { return []; }
}
function write(file: string, list: RecentRepo[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX)));
}
export function addRecent(file: string, repo: { root: string; name: string }): void {
  const list = readRecent(file).filter((r) => r.root !== repo.root);
  list.unshift({ root: repo.root, name: repo.name, opened: Date.now() });
  write(file, list);
}
// Returns true when `root` was in the list.
export function removeRecent(file: string, root: string): boolean {
  const list = readRecent(file);
  const kept = list.filter((r) => r.root !== root);
  if (kept.length !== list.length) write(file, kept);
  return kept.length !== list.length;
}
const realpath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// The repository launch reopens (AK-633): `wanted` (the one the window closed last showed; null for the
// welcome screen) while it is still recent, else with nothing saved the newest recent one. Only while it
// is still a repository's top level: a folder whose .git is gone may sit inside another repository.
export async function lastRepo(file: string, openRepo: OpenRepo, wanted?: string | null): Promise<string | null> {
  const list = readRecent(file);
  const root = wanted === undefined ? list[0]?.root : list.find((r) => r.root === wanted)?.root;
  if (!root) return null;
  try { return realpath((await openRepo(root)).root) === realpath(root) ? root : null; } catch { return null; }
}

// The tabs launch reopens (AK-634): of `wanted` (the roots the window closed last showed), those still recent
// repositories, in order; with nothing saved (undefined) the newest recent one.
export async function lastTabs(file: string, openRepo: OpenRepo, wanted?: readonly (string | null)[]): Promise<string[]> {
  if (wanted === undefined) { const root = await lastRepo(file, openRepo); return root ? [root] : []; }
  const roots: string[] = [];
  for (const w of wanted) { const root = await lastRepo(file, openRepo, w); if (root && !roots.includes(root)) roots.push(root); }
  return roots;
}

