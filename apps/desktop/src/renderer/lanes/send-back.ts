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

/** A lane or PR row as the send-back prompt reads it. */
export interface SendBackRow {
  branch?: string | null; title?: string | null;
  conflicts?: { files?: string[]; base?: boolean; with: string }[];
  pr?: { number: number; title: string; branch?: string; base?: string; mergeable?: boolean | null; checks?: string | null; failing?: string[] } | null;
}
export type TemplateId = 'conflict' | 'ci' | 'both';
/** settings.json `sendBack`: templates saved for all repositories and per repository root. */
export interface SendBackSaved { default?: Record<string, string>; repos?: Record<string, Record<string, string>> }
/** A commit on the base that changed a conflicting file (git.baseTouches). */
export interface BaseTouch { sha: string; pr: number | null }
export interface PromptOptions { base?: string | null; touches?: Record<string, BaseTouch[]>; log?: string; reason?: string }

export const TEMPLATE_IDS: readonly TemplateId[] = ['conflict', 'ci', 'both'];
export const TEMPLATE_LABELS: Record<TemplateId, string> = { conflict: 'Conflict', ci: 'CI failing', both: 'Both' };
export const PLACEHOLDERS = ['subject', 'number', 'title', 'head', 'base', 'reason', 'conflicts', 'checks', 'log'];
// Longest template kept (characters); a prompt is pasted into an agent, not a novel.
export const MAX_TEMPLATE = 16 * 1024;

export const DEFAULT_TEMPLATES: Record<TemplateId, string> = {
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

const conflicted = (row: SendBackRow): boolean => Boolean((row.conflicts || []).length || row.pr?.mergeable === false);
const failing = (row: SendBackRow): boolean => row.pr?.checks === 'failure';

// The template that fits the row: Both when it conflicts and fails CI, else whichever applies.
export function templateFor(row: SendBackRow): TemplateId {
  if (conflicted(row) && failing(row)) return 'both';
  return failing(row) ? 'ci' : 'conflict';
}

// `touches`: { [file]: [{ sha, subject, pr }] }, the commits on the base since the branch left it
// that changed the file (git.baseTouches), newest first.
function conflictLines(row: SendBackRow, base: string | null, touches: Record<string, BaseTouch[]> = {}): string {
  const list = row.conflicts || [];
  const lines: string[] = [];
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

function checkLines(row: SendBackRow): string {
  const names = row.pr?.failing || [];
  if (names.length) return names.map((n) => `- ${n}`).join('\n');
  return failing(row) ? '- (GitHub didn’t name them)' : '- none';
}

const logBlock = (log: string | null | undefined): string => (log && log.trim() ? `Last lines of the failed log:\n\`\`\`\n${log.trim()}\n\`\`\`` : '');
// A fetched log at the end of a hand-edited prompt, when the user keeps their edits (AK-289).
export const appendLog = (text: string | null | undefined, log: string | null | undefined): string => (logBlock(log) ? `${String(text || '').trimEnd()}\n\n${logBlock(log)}` : String(text || ''));

// The facts a template is filled from. `reason` is stuckReason's text for the row.
function promptFacts(row: SendBackRow, { base = null, touches = {}, log = '', reason = '' }: PromptOptions = {}): Record<string, string> {
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
function fillTemplate(template: string | undefined, facts: Record<string, string>): string {
  return String(template || '')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => (Object.hasOwn(facts, k) ? facts[k] ?? all : all))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const buildPrompt = (row: SendBackRow, id: TemplateId, templates: Partial<Record<TemplateId, string>> = DEFAULT_TEMPLATES, opts: PromptOptions = {}): string =>
  fillTemplate(templates[id] ?? DEFAULT_TEMPLATES[id], promptFacts(row, opts));

// --- Template storage (settings.json `sendBack`) ----------------------------------------------
// { default: { [id]: text }, repos: { [repo root]: { [id]: text } } }: a repository's own template
// wins, then the user-wide default, then the built-in one.

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, MAX_TEMPLATE) : null);

// The templates in force for `root`: { [id]: { text, from: 'repo' | 'default' | 'builtin' } }.
export function resolveTemplates(saved: SendBackSaved | null | undefined = {}, root: string | null = null): Record<TemplateId, { text: string; from: 'repo' | 'default' | 'builtin' }> {
  const repo: Record<string, string> = (root && saved?.repos?.[root]) || {};
  const user: Record<string, string> = saved?.default || {};
  return Object.fromEntries(TEMPLATE_IDS.map((id) => {
    const mine = clean(repo[id]), all = clean(user[id]);
    if (mine) return [id, { text: mine, from: 'repo' as const }];
    if (all) return [id, { text: all, from: 'default' as const }];
    return [id, { text: DEFAULT_TEMPLATES[id], from: 'builtin' as const }];
  })) as Record<TemplateId, { text: string; from: 'repo' | 'default' | 'builtin' }>;
}

// A new `saved` with template `id` set for `root` (scope 'repo') or everywhere (scope 'default').
// Empty text removes it, so the next level shows through. Never mutates `saved`.
export function saveTemplate(saved: SendBackSaved | null | undefined = {}, { root = null, id, text, scope = 'repo' }: { root?: string | null; id: string; text?: string; scope?: string }): SendBackSaved {
  if (!(TEMPLATE_IDS as readonly string[]).includes(id)) throw new Error(`Unknown template: ${id}`);
  if (scope !== 'repo' && scope !== 'default') throw new Error(`Unknown scope: ${scope}`);
  if (scope === 'repo' && !root) throw new Error('No repository to save the template for');
  const set = (obj: Record<string, string> = {}) => {
    const next = { ...obj };
    const v = clean(text);
    if (v) next[id] = v; else delete next[id];
    return next;
  };
  const out: Required<SendBackSaved> = { default: { ...(saved?.default || {}) }, repos: { ...(saved?.repos || {}) } };
  if (scope === 'default') out.default = set(out.default);
  else {
    const key = root ?? '';
    out.repos[key] = set(out.repos[key]);
    if (!Object.keys(out.repos[key] ?? {}).length) delete out.repos[key];
  }
  return out;
}
