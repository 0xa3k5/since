// Wrong-identity check before committing. git.getIdentity supplies the configured user, the
// identities that made this clone's earlier commits (from the reflog) and the remote URLs; the
// user's rules map remote URL fragments to the email that repos there must commit with.

import type { Identity } from '../../shared/git-types.ts';

/** A rule: repos whose remote URL contains `pattern` commit as `email` (and `name`, when set). */
export interface IdentityRule { pattern: string; email: string; name?: string }
export type IdentityWarning =
  | { expected: { email: string; name: string }; reason: 'rule'; pattern: string }
  | { expected: { email: string; name: string }; reason: 'usual'; count: number };

const norm = (e: string | null | undefined) => (e || '').trim().toLowerCase();
// scp-style "git@host:owner/repo" reads as "host/owner/repo" so one pattern fits SSH and HTTPS.
const urlText = (u: string) => norm(u).replace(/^([^/@:]+@)?([^/:]+):(?!\/\/|\d+\/)/, '$2/');

// The rule for this repo: the longest pattern found in any remote URL, so
// "github.com/acme" beats "github.com".
export function matchRule(rules: readonly IdentityRule[] | null | undefined, remotes: readonly string[]): IdentityRule | null {
  let best: IdentityRule | null = null;
  for (const r of rules || []) {
    const p = norm(r.pattern);
    if (!p || !norm(r.email)) continue;
    if (remotes.some((u) => urlText(u).includes(p)) && (!best || p.length > norm(best.pattern).length)) best = r;
  }
  return best;
}

// The identity this clone usually commits as: the most frequent reflog committer, once it has
// made at least `min` commits here.
function usualIdentity(used: Identity['used'] | null | undefined, min = 3) {
  const top = [...(used || [])].sort((a, b) => b.count - a.count)[0];
  return top && top.count >= min ? top : null;
}

// { expected, reason } when committing now would use the wrong identity, else null.
// A rule wins over history. History only warns when the current email has never committed
// here, so people who switch between two identities on purpose aren't nagged.
export function checkIdentity({ name, email, used = [], remotes = [] }: Pick<Identity, 'name' | 'email'> & Partial<Pick<Identity, 'used' | 'remotes'>>, rules: readonly IdentityRule[] = [], ignored: readonly string[] = []): IdentityWarning | null {
  if (email && ignored.map(norm).includes(norm(email))) return null;
  const rule = matchRule(rules, remotes);
  if (rule) {
    if (norm(rule.email) === norm(email)) return null;
    return { expected: { email: rule.email.trim(), name: rule.name?.trim() || name || '' }, reason: 'rule', pattern: rule.pattern.trim() };
  }
  const usual = usualIdentity(used);
  if (!usual || norm(usual.email) === norm(email)) return null;
  if (email && used.some((u) => norm(u.email) === norm(email))) return null;
  return { expected: { email: usual.email, name: usual.name || name || '' }, reason: 'usual', count: usual.count };
}

// A rule pattern suggestion from a remote URL: "host/owner", e.g. "github.com/acme".
export function suggestPattern(url: string | null | undefined): string {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+)/i.exec(url || '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
}

// Add or replace the rule for `pattern`.
export function upsertRule(rules: readonly IdentityRule[] | null | undefined, rule: IdentityRule): IdentityRule[] {
  const p = norm(rule.pattern);
  return [...(rules || []).filter((r) => norm(r.pattern) !== p), { pattern: rule.pattern.trim(), email: rule.email.trim(), ...(rule.name?.trim() ? { name: rule.name.trim() } : {}) }];
}
