import { run, SEP } from './run.ts';
import { getRemotes } from './remotes.ts';
import type { ConfigEntry, Identity, ReflogEntry } from '../../shared/git-types.ts';

// Reflog, config and identity.

export async function getReflog(cwd: string, limit = 500): Promise<ReflogEntry[]> {
  const out = await run(cwd, ['log', '-g', `--max-count=${limit}`, '--format=%H%x00%gD%x00%gs%x00%ct%x00%s', '--all'], { allowCodes: [0, 128] }).catch(() => '');
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha = '', selector = '', action = '', time, subject = ''] = l.split(SEP);
    return { sha, selector, action, time: Number(time), subject };
  }).sort((a, b) => b.time - a.time);
}

export async function getConfig(cwd: string): Promise<ConfigEntry[]> {
  // With -z every entry is "scope\0key\nvalue\0" (no newline when a key has no value).
  const out = await run(cwd, ['config', '--list', '--show-scope', '-z']);
  const parts = out.split('\0');
  const list: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? '', kv = parts[i + 1] ?? '';
    const nl = kv.indexOf('\n');
    list.push({ scope, key: nl === -1 ? kv : kv.slice(0, nl), value: nl === -1 ? '' : kv.slice(nl + 1) });
  }
  return list;
}

// Who commits here: the configured user, the identities in HEAD's reflog that made commits
// in this clone (with counts), and the remote URLs, for the wrong-identity check.
export async function getIdentity(cwd: string): Promise<Identity> {
  const get = async (k: string) => (await run(cwd, ['config', '--get', k], { allowCodes: [0, 1] })).trim();
  const [name, email, log, remotes] = await Promise.all([
    get('user.name'), get('user.email'),
    run(cwd, ['log', '-g', '--max-count=2000', '--format=%gs%x00%ge%x00%gn', 'HEAD'], { allowCodes: [0, 128] }).catch(() => ''),
    getRemotes(cwd).catch(() => []),
  ]);
  const used = new Map<string, { email: string; name: string; count: number }>();
  for (const l of log.split('\n')) {
    const [action, e, n] = l.split(SEP);
    if (!/^commit\b/.test(action || '') || !e) continue;
    const k = e.toLowerCase();
    const u = used.get(k) || { email: e, name: n ?? '', count: 0 };
    u.count++;
    used.set(k, u);
  }
  return { name, email, used: [...used.values()], remotes: remotes.map((r) => r.url) };
}

