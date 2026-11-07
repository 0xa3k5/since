import { run, SEP, GitError } from './run.ts';
import { canForecast } from './support.ts';
import { mergeConflicts } from './forecast.ts';
import type { DivergedCommit, Divergence, Remote } from '../../shared/git-types.ts';

/** A removed remote's config entries and remote-tracking refs ([name, oid, symref]), for undo. */
export interface SavedRemote { config: [string, string][]; refs: string[][] }
/** A remote edit, recorded so it can be undone. */
export type RemoteChange =
  | { op: 'add'; name: string; url: string }
  | { op: 'url'; name: string; from: string; url: string }
  | { op: 'rename'; name: string; to: string }
  | { op: 'remove'; name: string; saved: SavedRemote };

// Remotes: list, edit and undo edits; pull, and how far HEAD is from its upstream.

// Pull the current branch; `mode` 'rebase' or 'merge' settles diverged branches.
export const pull = (cwd: string, mode?: 'rebase' | 'merge' | null): Promise<string> => run(cwd, ['pull', '--no-edit', ...(mode === 'rebase' ? ['--rebase'] : mode === 'merge' ? ['--no-rebase'] : [])]);

// The facts behind a diverged pull or a rejected push (AK-585): the commits only on the upstream
// (`theirs`) and only here (`ours`), up to `max` of each with their counts; `conflicts`: files a merge
// would conflict on ([] clean, null when merge-tree can't tell); `shared`: some of ours are on a
// remote already, so rebasing them would rewrite pushed commits. null without an upstream. `fetch`:
// fetch the upstream's remote first.
export async function divergence(cwd: string, { fetch = false, max = 5 }: { fetch?: boolean; max?: number } = {}): Promise<Divergence | null> {
  const up = (await run(cwd, ['rev-parse', '-q', '--verify', '--symbolic-full-name', '@{u}'], { allowCodes: [0, 1, 128] }).catch(() => '')).trim();
  if (!up) return null;
  // A rejected push: the remote has commits this clone hasn't fetched yet.
  if (fetch) await run(cwd, ['fetch', '-q', up.split('/')[2] ?? '']).catch(() => {});
  const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] })).trim();
  const [theirsN = 0, oursN = 0] = (await run(cwd, ['rev-list', '--left-right', '--count', `${up}...HEAD`])).trim().split(/\s+/).map(Number);
  const list = async (range: string): Promise<DivergedCommit[]> => (await run(cwd, ['log', '-z', `-n${max}`, '--format=%H%x1f%s%x1f%an%x1f%ct', range, '--'])).split('\0').filter(Boolean)
    .map((l) => { const [sha = '', subject = '', author = '', t] = l.replace(/^\n/, '').split('\x1f'); return { sha, subject, author, date: Number(t) * 1000 }; });
  const [theirs, ours, unpushed] = await Promise.all([
    list(`HEAD..${up}`), list(`${up}..HEAD`),
    run(cwd, ['rev-list', '--count', `${up}..HEAD`, '--not', '--remotes']).then((o) => Number(o.trim()), () => oursN),
  ]);
  let conflicts: string[] | null = null;
  if (theirsN && oursN && await canForecast(cwd)) {
    const [a = '', b = ''] = (await run(cwd, ['rev-parse', 'HEAD', up])).trim().split('\n');
    conflicts = await mergeConflicts(cwd, a, b);
  }
  return { branch, upstream: up.replace(/^refs\/remotes\//, ''), theirs, theirsCount: theirsN, ours, oursCount: oursN, conflicts, shared: unpushed < oursN };
}

export async function getRemotes(cwd: string): Promise<Remote[]> {
  const out = await run(cwd, ['remote', '-v']);
  const map = new Map<string, string>();
  for (const l of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l);
    const [, name, url = ''] = m ?? [];
    if (name && !map.has(name)) map.set(name, url);
  }
  // `remote -v` shows URLs after url.<base>.insteadOf rewriting; `setUrl` is the value actually configured.
  const set = new Map<string, string>();
  const cfg = await run(cwd, ['config', '-z', '--get-regexp', '^remote\\..*\\.url$'], { allowCodes: [0, 1] }).catch(() => '');
  for (const e of cfg.split('\0')) {
    const i = e.indexOf('\n');
    const n = i > 0 && e.slice(7, e.lastIndexOf('.', i));
    if (n && !set.has(n)) set.set(n, e.slice(i + 1));
  }
  return [...map].map(([name, url]) => ({ name, url, setUrl: set.get(name) ?? url, web: remoteWebUrl(url), label: remoteLabel(url) }));
}

// A remote URL as https://host/owner/repo, or null when it is not on a web host
// (local paths, file://). Drops credentials, ssh ports and the trailing ".git".
export function remoteWebUrl(url: string | null | undefined): string | null {
  const s = String(url || '').trim().replace(/\/+$/, '');
  let m = /^(?:ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/i.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/i.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  // scp-style "[user@]host:owner/repo" (no slash before the colon, as git reads it).
  m = /^(?:[^@/:]+@)?([^/:]+):\/?(?!\/)(.+?)(?:\.git)?$/.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

// Short label for a remote: "host/owner/repo", or the path of a local remote.
// The fallback drops any userinfo, so a token in the URL is never shown.
export function remoteLabel(url: string | null | undefined): string {
  const web = remoteWebUrl(url);
  if (web) return web.slice('https://'.length);
  return String(url || '').trim().replace(/^file:\/\//i, '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

// Managing remotes (Remotes section, ⌘K): add, change the URL of, rename and remove. journal.runRemote
// records the returned change so it can be undone; removing saves the remote's config, the upstream
// settings of branches that track it and its remote-tracking refs, which undo writes back.
const sub = (key: string) => key.slice(key.indexOf('.') + 1, key.lastIndexOf('.'));

async function saveRemote(cwd: string, name: string): Promise<SavedRemote> {
  const cfg = await run(cwd, ['config', '--local', '-z', '--get-regexp', '^(remote|branch)\\.'], { allowCodes: [0, 1] });
  const entries = cfg.split(SEP).filter(Boolean).map((e): [string, string] => { const i = e.indexOf('\n'); return i === -1 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; });
  const tracking = new Set(entries.filter(([k, v]) => /^branch\..+\.(remote|pushremote)$/.test(k) && v === name).map(([k]) => sub(k)));
  const config = entries.filter(([k]) => (k.startsWith('remote.') && sub(k) === name) || (/^branch\..+\.(remote|merge|pushremote)$/.test(k) && tracking.has(sub(k))));
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', `refs/remotes/${name}/`]);
  const refs = out.split('\n').filter(Boolean).map((l) => l.split(SEP));
  return { config, refs };
}

async function restoreSavedRemote(cwd: string, { config, refs }: SavedRemote): Promise<void> {
  for (const [k, v] of config) await run(cwd, ['config', '--local', ...(k.startsWith('branch.') ? ['--replace-all'] : ['--add']), k, v]);
  const lines = refs.filter(([, , sym]) => !sym).map(([n, o]) => `create ${n} ${o}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin', '-m', 'since: undo remove remote'], { input: lines.join('\n') + '\n' });
  for (const [n = '', , sym] of refs) if (sym) await run(cwd, ['symbolic-ref', n, sym]).catch(() => {});
}

// `op` is add (name, url), url (name, url), rename (name, new name) or remove (name).
export async function changeRemote(cwd: string, op: RemoteChange['op'], name: string, value = ''): Promise<RemoteChange> {
  const remotes = await getRemotes(cwd);
  const has = (n: string) => remotes.some((r) => r.name === n);
  if (op !== 'add' && !has(name)) throw new GitError(`There is no remote named ${name}.`);
  const taken = op === 'add' ? name : op === 'rename' ? value : null;
  if (taken && has(taken)) throw new GitError(`A remote named ${taken} already exists.`);
  if (op === 'add') { await run(cwd, ['remote', 'add', '--', name, value]); return { op, name, url: value }; }
  if (op === 'url') {
    const from = remotes.find((r) => r.name === name)?.setUrl ?? '';
    await run(cwd, ['remote', 'set-url', '--', name, value]);
    return { op, name, from, url: value };
  }
  if (op === 'rename') { await run(cwd, ['remote', 'rename', '--', name, value]); return { op, name, to: value }; }
  if (op === 'remove') {
    const saved = await saveRemote(cwd, name);
    await run(cwd, ['remote', 'remove', '--', name]);
    return { op, name, saved };
  }
  throw new GitError(`Unknown remote operation ${op}`);
}

// Undo or redo a changeRemote step. Redoing a remove saves the remote again (its refs may have moved).
export async function revertRemote(cwd: string, change: RemoteChange, dir: 'undo' | 'redo'): Promise<void> {
  const c = change, undo = dir === 'undo';
  const remotes = await getRemotes(cwd);
  const has = (n: string) => remotes.some((r) => r.name === n);
  const fail = (why: string): never => { throw new GitError(why); };
  if (c.op === 'add') {
    if (undo) { if (!has(c.name)) fail(`the remote ${c.name} no longer exists.`); await run(cwd, ['remote', 'remove', '--', c.name]); }
    else { if (has(c.name)) fail(`a remote named ${c.name} exists again.`); await run(cwd, ['remote', 'add', '--', c.name, c.url]); }
  } else if (c.op === 'url') {
    const r = remotes.find((x) => x.name === c.name);
    if (!r || r.setUrl !== (undo ? c.url : c.from)) fail(`the URL of ${c.name} has changed since.`);
    await run(cwd, ['remote', 'set-url', '--', c.name, undo ? c.from : c.url]);
  } else if (c.op === 'rename') {
    const [from, to] = undo ? [c.to, c.name] : [c.name, c.to];
    if (!has(from)) fail(`the remote ${from} no longer exists.`);
    if (has(to)) fail(`a remote named ${to} exists again.`);
    await run(cwd, ['remote', 'rename', '--', from, to]);
  } else if (c.op === 'remove') {
    if (undo) { if (has(c.name)) fail(`a remote named ${c.name} exists again.`); await restoreSavedRemote(cwd, c.saved); }
    else { if (!has(c.name)) fail(`the remote ${c.name} no longer exists.`); c.saved = await saveRemote(cwd, c.name); await run(cwd, ['remote', 'remove', '--', c.name]); }
  }
}

