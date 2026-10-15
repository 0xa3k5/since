// Send back (Review, AK-279): pure helpers (no DOM) that turn a stuck row into a prompt for
// whoever fixes it, from facts only (no AI: the receiving agent is the LLM). Loaded by the
// renderer as an ES module and by main.js via require (template storage).
//
// A template is plain text with placeholders, filled from the row:
//   {{subject}}    PR #12 "Title" (head → base), or Branch head (→ base) without a PR
//   {{number}} {{title}} {{head}} {{base}}
//   {{reason}}     why it's stuck, one line (review-rows.js stuckReason)
//   {{conflicts}}  one line per conflicting file, with the commits on the base that touched it
//   {{checks}}     one line per failing check
//   {{log}}        the last lines of the failed CI log, once fetched (empty until then)

export const TEMPLATE_IDS = ['conflict', 'ci', 'both'];
export const TEMPLATE_LABELS = { conflict: 'Conflict', ci: 'CI failing', both: 'Both' };
export const PLACEHOLDERS = ['subject', 'number', 'title', 'head', 'base', 'reason', 'conflicts', 'checks', 'log'];
// Longest template kept (characters); a prompt is pasted into an agent, not a novel.
export const MAX_TEMPLATE = 16 * 1024;

export const DEFAULT_TEMPLATES = {
  conflict: `{{subject}} can't merge: it has conflicts.

Conflicting files:
{{conflicts}}

Rebase {{head}} onto {{base}} and resolve the conflicts, keeping the intent of both sides. Run the tests, then push.`,
  ci: `{{subject}} has failing checks.

Failing checks:
{{checks}}

{{log}}

Find the cause and fix it on {{head}}. Run the checks locally, then push.`,
  both: `{{subject}} can't merge: it has conflicts and failing checks.

Conflicting files:
{{conflicts}}

Failing checks:
{{checks}}

{{log}}

Rebase {{head}} onto {{base}} and resolve the conflicts, keeping the intent of both sides. Then fix the failing checks, run them locally, and push.`,
};

const conflicted = (row) => Boolean((row.conflicts || []).length || row.pr?.mergeable === false);
const failing = (row) => row.pr?.checks === 'failure';

// The template that fits the row: Both when it conflicts and fails CI, else whichever applies.
export function templateFor(row) {
  if (conflicted(row) && failing(row)) return 'both';
  return failing(row) ? 'ci' : 'conflict';
}

// `touches`: { [file]: [{ sha, subject, pr }] }, the commits on the base since the branch left it
// that changed the file (git.baseTouches), newest first.
function conflictLines(row, base, touches = {}) {
  const list = row.conflicts || [];
  const lines = [];
  for (const c of list) {
    for (const f of c.files || []) {
      const by = c.base ? (touches[f] || []) : [];
      const who = by.map((t) => (t.pr ? `#${t.pr} ${t.sha}` : t.sha)).join(', ');
      lines.push(`- ${f} (with ${c.with}${who ? `; changed on ${c.with} by ${who}` : ''})`);
    }
    if (!c.files?.length) lines.push(`- conflicts with ${c.with}`);
  }
  if (!list.length && row.pr?.mergeable === false) lines.push(`- GitHub reports conflicts with ${row.pr.base || base || 'the base'}; rebase to see which files`);
  return lines.join('\n') || '- none';
}

function checkLines(row) {
  const names = row.pr?.failing || [];
  if (names.length) return names.map((n) => `- ${n}`).join('\n');
  return failing(row) ? '- (GitHub didn’t name them)' : '- none';
}

const logBlock = (log) => (log && log.trim() ? `Last lines of the failed log:\n\`\`\`\n${log.trim()}\n\`\`\`` : '');

// The facts a template is filled from. `reason` is stuckReason's text for the row.
export function promptFacts(row, { base = null, touches = {}, log = '', reason = '' } = {}) {
  const { pr } = row;
  const head = pr?.branch || row.branch || row.title || 'the branch';
  const to = pr?.base || base || 'the base';
  return {
    subject: pr ? `PR #${pr.number} "${pr.title}" (${head} → ${to})` : `Branch ${head} (→ ${to})`,
    number: pr ? `#${pr.number}` : '',
    title: pr?.title || row.title || '',
    head,
    base: to,
    reason: reason || '',
    conflicts: conflictLines(row, base, touches),
    checks: checkLines(row),
    log: logBlock(log),
  };
}

// Fills `{{name}}` placeholders; unknown ones stay as typed. Lines left empty by a missing fact
// collapse, so an unfetched log doesn't leave a gap.
export function fillTemplate(template, facts) {
  return String(template || '')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k) => (Object.hasOwn(facts, k) ? facts[k] : all))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const buildPrompt = (row, id, templates = DEFAULT_TEMPLATES, opts = {}) =>
  fillTemplate(templates[id] ?? DEFAULT_TEMPLATES[id], promptFacts(row, opts));

// --- Template storage (settings.json `sendBack`) ----------------------------------------------
// { default: { [id]: text }, repos: { [repo root]: { [id]: text } } }: a repository's own template
// wins, then the user-wide default, then the built-in one.

const clean = (v) => (typeof v === 'string' && v.trim() ? v.slice(0, MAX_TEMPLATE) : null);

// The templates in force for `root`: { [id]: { text, from: 'repo' | 'default' | 'builtin' } }.
export function resolveTemplates(saved = {}, root = null) {
  const repo = (root && saved?.repos?.[root]) || {};
  const user = saved?.default || {};
  return Object.fromEntries(TEMPLATE_IDS.map((id) => {
    if (clean(repo[id])) return [id, { text: clean(repo[id]), from: 'repo' }];
    if (clean(user[id])) return [id, { text: clean(user[id]), from: 'default' }];
    return [id, { text: DEFAULT_TEMPLATES[id], from: 'builtin' }];
  }));
}

// A new `saved` with template `id` set for `root` (scope 'repo') or everywhere (scope 'default').
// Empty text removes it, so the next level shows through. Never mutates `saved`.
export function saveTemplate(saved = {}, { root = null, id, text, scope = 'repo' } = {}) {
  if (!TEMPLATE_IDS.includes(id)) throw new Error(`Unknown template: ${id}`);
  if (scope !== 'repo' && scope !== 'default') throw new Error(`Unknown scope: ${scope}`);
  if (scope === 'repo' && !root) throw new Error('No repository to save the template for');
  const set = (obj = {}) => {
    const next = { ...obj };
    const v = clean(text);
    if (v) next[id] = v; else delete next[id];
    return next;
  };
  const out = { default: { ...(saved?.default || {}) }, repos: { ...(saved?.repos || {}) } };
  if (scope === 'default') out.default = set(out.default);
  else {
    out.repos[root] = set(out.repos[root]);
    if (!Object.keys(out.repos[root]).length) delete out.repos[root];
  }
  return out;
}
