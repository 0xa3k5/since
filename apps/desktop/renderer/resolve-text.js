// Copy for the resolve sheets that state the facts before the choice: the stopped operation
// (AK-584) and a diverged pull or rejected push (AK-585). Pure, so it's unit-tested.

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const noDot = (s) => (s || '').replace(/\.+$/, '');

// "Merging feature/conflict into feature/merging is stopped on 1 conflict." `info`: git opInfo.
export function opSentence(info, conflicts = 0) {
  if (!info) return '';
  const tail = conflicts ? `is stopped on ${plural(conflicts, 'conflict')}.` : 'is stopped.';
  const pick = (verb) => `${verb} ${(info.sha || '').slice(0, 7)} ${noDot(info.subject)}`.replace(/\s+$/, '');
  if (info.op === 'merge') return `Merging ${info.from} into ${info.branch || 'HEAD'} ${tail}`;
  if (info.op === 'cherry-pick') return `${pick('Cherry-picking')} ${tail}`;
  if (info.op === 'revert') return `${pick('Reverting')} ${tail}`;
  const what = `Rebasing ${info.branch || 'HEAD'}${info.onto ? ` onto ${info.onto}` : ''}`;
  if (!info.step || !info.total) return `${what} ${tail}`;
  return `${what} is stopped at ${info.step} of ${info.total}${info.subject ? `: ${noDot(info.subject)}` : ''}.`;
}

const LIST_ROWS = 5;
const SHOWN_FILES = 3;

// The resolve sheet for a diverged pull (`push` false) or a rejected push: what moved where, whether a
// merge would conflict, and buttons that say what you end up with. `d`: git divergence; `age`: a time
// formatter. Rebase is primary unless some local commits are on a remote already.
export function divergeSheet(d, { push = false, age = String } = {}) {
  const remote = d.upstream.split('/')[0];
  const list = (title, commits, count) => ({
    title: `${title} · ${count}`,
    rows: commits.slice(0, LIST_ROWS).map((c) => [c.sha.slice(0, 7), c.subject, c.author, age(c.date)]),
    more: Math.max(0, count - Math.min(commits.length, LIST_ROWS)),
  });
  const files = d.conflicts || [];
  const forecast = d.conflicts == null ? null
    : !files.length ? { ok: true, text: 'No conflicts expected' }
    : { ok: false, text: `Conflicts likely in ${files.slice(0, SHOWN_FILES).join(', ')}${files.length > SHOWN_FILES ? ` and ${files.length - SHOWN_FILES} more` : ''}` };
  const n = d.oursCount;
  const rebase = { id: 'rebase', label: push ? 'Rebase and push' : 'Rebase', sub: `Your ${plural(n, 'commit')} ${n === 1 ? 'goes' : 'go'} on top` };
  const merge = { id: 'merge', label: push ? 'Merge and push' : 'Merge', sub: 'Adds a merge commit' };
  const force = push ? { id: 'force', label: 'Force push', sub: `Drops ${plural(d.theirsCount, 'commit')} on ${remote}`, danger: true, primary: false } : null;
  return {
    reason: `${d.branch} and ${d.upstream} have both moved.`,
    lists: [list(`On ${remote}`, d.theirs, d.theirsCount), list('Only here', d.ours, n)].filter((l) => !l.title.endsWith(' · 0')),
    forecast,
    actions: [...(d.shared ? [merge, rebase] : [rebase, merge]), force].filter(Boolean),
  };
}
