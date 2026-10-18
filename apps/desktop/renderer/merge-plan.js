// Merge plan (Review, AK-279): a safe order for merging the ready PRs one after another.
// Pure: `merge(tip, head)` simulates merging `head` onto `tip` with the chosen method and resolves
// to { files, commit } — commit is the simulated result when it merges clean, null with the
// conflicting files when it doesn't. Squash and merge commits: one `git merge-tree` each
// (git.simulateSquash); rebase: one per commit (git.simulateRebase, AK-545), since a single commit
// can conflict even when the whole PR merges clean. Text conflicts only: clashes that merge clean
// but break the build are CI's job.
//
// A unit of the plan is a PR ({ number, head }) or a native GitHub stack ({ stack, prs, head },
// AK-545): a stack takes one place in the order, merges as a whole, and `head` is its top PR's.

// At most this many PRs are planned, and this many simulated merges per plan.
export const MAX_READY = 10;
export const MAX_OTHERS = 20;
export const MAX_MERGES = 300;
// PRs in one stack, and PRs across all stacks, that a plan looks at.
export const MAX_STACK = 10;
export const MAX_STACKED = 20;
export const METHODS = ['squash', 'merge', 'rebase'];

// A unit's key in order / forced / blocked: a PR's number or a stack's id.
const keyOf = (u) => u.stack ?? u.number;
// "#41", or "the stack #41–#43" for a stack id.
export const unitLabel = (key, stacks = []) => {
  if (typeof key === 'number') return `#${key}`;
  const s = stacks.find((x) => x.id === key);
  return s ? `the stack #${s.prs[0]}–#${s.prs[s.prs.length - 1]}` : 'a stack';
};

// prs: the ready units [{ number, head } | { stack, prs, head }] in their natural order (Review's:
// waiting longest first). others: open PRs that aren't ready [{ number, head }]. Returns
//   { order: [{ number, after } | { stack, prs, after }], forced: [{ first, then, files }],
//     blocked: [{ number | stack, files, with }], warnings: [{ number, files }], tip, complete }
// order: a sequence that merges with no text conflicts, as close to the natural order as possible;
//   `after` is null when the unit merges clean on the base alone, else the key it has to wait for.
// forced: why the order differs from the natural one: "#first before #then would conflict in files".
// blocked: ready PRs no clean order fits, with the files they'd conflict in at the end and `with`,
//   the unit in the plan after which they stop merging clean (null if that's the base itself).
// warnings: PRs that aren't ready and merge clean today but would conflict once the plan merges.
// complete: false when the search ran out of MAX_MERGES before trying every order.
export async function planOrder({ prs = [], others = [], baseSha, merge, budget = MAX_MERGES }) {
  const cache = new Map();
  let calls = 0;
  const sim = (tip, head) => {
    const key = `${tip} ${head}`;
    if (!cache.has(key)) { calls++; cache.set(key, Promise.resolve(merge(tip, head)).then((r) => r || { files: [], commit: null }, () => ({ files: [], commit: null }))); }
    return cache.get(key);
  };
  const ready = prs.slice(0, MAX_READY);
  let best = [];
  let complete = true;
  const tried = new Set(); // sets of merged PRs already explored. Heuristic: assumes a clean set merges to the same tree in any order (true for nearly all text merges)
  async function dfs(tip, done, left) {
    if (done.length > best.length) best = done;
    if (!left.length || best.length === ready.length) return;
    const key = done.map((d) => String(keyOf(d.pr))).sort().join(',');
    if (tried.has(key)) return;
    tried.add(key);
    for (const p of left) {
      if (calls >= budget) { complete = false; return; }
      const r = await sim(tip, p.head);
      if (!r.commit) continue;
      await dfs(r.commit, [...done, { pr: p, before: tip, tip: r.commit }], left.filter((x) => x !== p));
      if (best.length === ready.length) return;
    }
  }
  await dfs(baseSha, [], ready);

  const tips = [baseSha, ...best.map((s) => s.tip)];
  const order = [];
  for (let i = 0; i < best.length; i++) {
    // The first point in the plan where it merges clean; the PR just before that is what it waits for.
    let k = 0;
    while (k < i && !(await sim(tips[k], best[i].pr.head)).commit) k++;
    const u = best[i].pr;
    order.push({ ...(u.stack ? { stack: u.stack, prs: u.prs } : { number: u.number }), after: k ? keyOf(best[k - 1].pr) : null });
  }

  const rank = new Map(ready.map((p, i) => [keyOf(p), i]));
  const forced = [];
  const explained = new Set();
  for (let i = 0; i < best.length; i++) {
    const x = best[i].pr;
    // A PR later in the plan that comes earlier naturally: say what goes wrong if it went first.
    for (const y of best.slice(i + 1).map((s) => s.pr)) {
      if (rank.get(keyOf(y)) > rank.get(keyOf(x)) || explained.has(keyOf(y))) continue;
      const first = await sim(best[i].before, y.head);
      const files = first.commit ? (await sim(first.commit, x.head)).files : first.files;
      if (!files.length) continue;
      explained.add(keyOf(y));
      forced.push({ first: keyOf(y), then: keyOf(x), files });
    }
  }

  const tip = tips[tips.length - 1];
  const inPlan = new Set(best.map((s) => keyOf(s.pr)));
  const blocked = [];
  for (const p of ready) {
    if (inPlan.has(keyOf(p))) continue;
    // The plan step after which it stops merging clean names the PR it conflicts with (AK-550).
    let k = 0;
    while (k < tips.length && (await sim(tips[k], p.head)).commit) k++;
    blocked.push({ ...(p.stack ? { stack: p.stack } : { number: p.number }), files: (await sim(tip, p.head)).files, with: k > 0 && k < tips.length ? keyOf(best[k - 1].pr) : null });
  }

  const warnings = [];
  if (best.length) {
    for (const o of others.slice(0, MAX_OTHERS)) {
      if (!o.head) continue;
      const now = await sim(baseSha, o.head);
      if (!now.commit) continue; // already conflicts with the base: it's in Stuck already
      const later = await sim(tip, o.head);
      if (!later.commit && later.files.length) warnings.push({ number: o.number, files: later.files });
    }
  }
  return { order, forced, blocked, warnings, tip, complete };
}

// "global.css", "a.css and b.css", "a.css, b.css and 3 more files".
export function fileList(files = [], max = 2) {
  const names = files.slice(0, max);
  const more = files.length - names.length;
  if (more > 0) return `${names.join(', ')} and ${more} more file${more === 1 ? '' : 's'}`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || 'some files';
}

export const statusText = (step, stacks) => (step.after ? `clean after ${unitLabel(step.after, stacks)}` : 'clean');
export const forcedText = (f, stacks) => `${unitLabel(f.first, stacks)} before ${unitLabel(f.then, stacks)} would conflict in ${fileList(f.files)}`;
export const blockedText = (b) => `Conflicts in ${fileList(b.files)} with the PRs above, so it’s left out`;
export const warningText = (w) => `#${w.number} will conflict in ${fileList(w.files)} after these merge`;

// The method a plan starts with (AK-545): the one last used in this repo, else the repo's GitHub
// default, else squash, as long as the repo allows it; else the first one it does allow.
export function startMethod({ saved, allowed = METHODS, fallback } = {}) {
  for (const m of [saved, fallback, 'squash']) if (allowed.includes(m)) return m;
  return allowed[0] || 'squash';
}

// Stacks to plan among the open PRs (AK-545): a straight chain, native GitHub stack or not (AK-555), where the bottom PR targets
// `base` and each PR above targets the branch of the one below. open: [{ number, branch,
// baseBranch, head }]. A chain that branches (two PRs on one branch) or crosses a fork isn't a stack,
// and its bottom PR plans on its own. → [{ id, prs: [bottom…top], heads }], two PRs or more, at most MAX_STACK.
export function findStacks(open = [], base) {
  return findChains(open, base).filter((c) => !c.branch && !c.fork && c.prs.length > 1).map(({ id, prs, heads }) => ({ id, prs, heads }));
}

// Chains vs GitHub stacks (AK-555). A chain is open PRs where the bottom one targets `base` and
// each one above targets the branch of the one below, all in this repo. findStacks keeps only the
// straight ones (they plan as one unit); findChains also returns the ones that can't be linked as a
// GitHub stack, and why. open: as findStacks, plus `fork` (head in another repo). → [{ id, prs,
// heads, fork, forkPr?, branch?: { number, kids: [a, b] } }].
export function findChains(open = [], base) {
  const byBase = new Map();
  for (const p of open) {
    if (!p.branch || !p.baseBranch) continue;
    if (!byBase.has(p.baseBranch)) byBase.set(p.baseBranch, []);
    byBase.get(p.baseBranch).push(p);
  }
  const chains = [];
  for (const bottom of byBase.get(base) || []) {
    const chain = [bottom];
    const seen = new Set([base, bottom.branch]);
    let branch = null;
    for (;;) {
      const top = chain[chain.length - 1];
      // A fork's branch isn't a branch here, so nothing in this repo stacks on it.
      const kids = top.fork ? [] : (byBase.get(top.branch) || []).filter((k) => !seen.has(k.branch));
      if (kids.length > 1) { branch = { number: top.number, kids: kids.slice(0, 2).map((k) => k.number) }; break; }
      if (!kids.length || chain.length >= MAX_STACK) break;
      seen.add(kids[0].branch);
      chain.push(kids[0]);
    }
    if (chain.length < 2 && !branch) continue;
    const fork = chain.find((p) => p.fork);
    chains.push({ id: `stack-${bottom.number}`, prs: chain.map((p) => p.number), heads: chain.map((p) => p.head), fork: Boolean(fork), ...(fork ? { forkPr: fork.number } : {}), ...(branch ? { branch } : {}) });
  }
  return chains;
}

// Why a chain can't be linked as a GitHub stack, or null when it can. host: the remote's host
// (stacks are github.com only); enabled: pull requests on for this repo.
export function chainWhy(chain, { host = 'github.com', enabled = true } = {}) {
  if (!enabled) return 'Pull requests are off for this repository.';
  if (chain.branch) return `It branches: #${chain.branch.kids[0]} and #${chain.branch.kids[1]} both build on #${chain.branch.number}.`;
  if (String(host).toLowerCase() !== 'github.com') return 'Stacks aren’t available on GitHub Enterprise Server.';
  if (chain.fork) return `#${chain.forkPr} comes from a fork, and a stack can’t cross forks.`;
  if (chain.prs.length < 2) return 'A stack needs two pull requests or more.';
  return null;
}

// What GitHub says about each PR's stack (github.stackFacts) → is the whole chain one native
// stack? Every PR has to be in the same one.
export function isNative(chain, facts) {
  const ids = chain.prs.map((n) => facts.get?.(n)?.stack?.number ?? null);
  return ids[0] != null && ids.every((x) => x === ids[0]);
}

// The all-or-nothing check before `gh stack link` (AK-555): every PR is open, you can push to its
// branch, and its base is what the chain says (the bottom one `base`, each next one the branch
// below it). facts: Map number → github.stackFacts entry. → { number, reason } for the first PR
// that fails, else null.
export function linkBlocker(numbers, facts, base) {
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i], f = facts.get(n);
    if (!f) return { number: n, reason: 'GitHub didn’t return this pull request.' };
    if (f.state !== 'open') return { number: n, reason: `It’s ${f.state || 'not open'}.` };
    if (f.fork) return { number: n, reason: 'It comes from a fork.' };
    if (!f.canPush || !f.canUpdate) return { number: n, reason: 'No write access to this branch.' };
    const want = i === 0 ? base : facts.get(numbers[i - 1])?.branch;
    if (f.baseBranch !== want) return { number: n, reason: `It targets ${f.baseBranch || 'another branch'}, not ${want}.` };
  }
  return null;
}

// The first PR that keeps a stack from merging: reasons maps a PR number to why it isn't ready
// (absent when it is). → { number, reason } | null. A stack plans only when this is null and its
// history is linear.
export function stackBlocker(stack, reasons) {
  for (const n of stack.prs) if (reasons.has(n)) return { number: n, reason: reasons.get(n) };
  return null;
}

// What has to still hold before each merge, from the plan's snapshot of a PR ({ head, checks,
// review }) and what `gh pr view` says now (github.mergeInfo). null when nothing changed, else the
// reason to stop and re-plan.
export function changedSince(snap, now) {
  if (!now) return 'GitHub didn’t say where it stands';
  if (now.state && now.state !== 'open') return `it’s ${now.state} now`;
  if (snap.head && now.headOid && now.headOid !== snap.head) return 'new commits were pushed';
  if ((now.checks || null) !== (snap.checks || null)) return now.checks ? `its checks are ${now.checks === 'failure' ? 'failing' : now.checks} now` : 'its checks changed';
  if ((now.review || null) !== (snap.review || null)) return now.review === 'changes' ? 'changes were requested' : 'its review changed';
  if (now.draft) return 'it’s a draft now';
  if (now.conflicts) return 'GitHub reports conflicts with the base now';
  return null;
}

// ── Blockers (AK-550) ──
// Why GitHub won't merge a PR yet, by GitHub's own rules: from github.planFacts (or mergeInfo's
// shape, which has no per-check list). Each is { kind, required, who?, detail?, … }; `required`
// false means GitHub would merge past it (a check the base doesn't require), so the plan takes the
// PR only with Merge anyway. Kinds: error, closed, draft, conflicts-base { files },
// check-failed { checks: [{ name, required, url?, run?, quick }], rerun }, check-running { checks },
// needs-review { approvals, canApprove, changes }, behind, protected; the plan adds
// conflicts-pr { with, files } and stack { number }. `who` is who has to act.
export const QUICK_FAIL = 5; // seconds: a check that failed this fast probably didn't run
const FAILED = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
const checkOf = (c) => ({ name: c.name, required: c.required === true, ...(c.url ? { url: c.url } : {}), ...(c.run ? { run: c.run } : {}) });
export function blockersOf(f) {
  if (!f || f.error) return [{ kind: 'error', required: true, detail: f?.error || 'GitHub didn’t say where it stands.' }];
  if (f.state && f.state !== 'open') return [{ kind: 'closed', required: true, detail: `It’s ${f.state}.` }];
  const out = [];
  const who = f.author ? [f.author] : [];
  if (f.draft) out.push({ kind: 'draft', required: true, who });
  if (f.conflicts) out.push({ kind: 'conflicts-base', required: true, who, files: f.conflictFiles || [] });
  if (Array.isArray(f.checkList)) {
    const failed = f.checkList.filter((c) => FAILED.has(c.result));
    if (failed.length) {
      const checks = failed.map((c) => ({ ...checkOf(c), quick: c.duration != null && c.duration <= QUICK_FAIL }));
      out.push({ kind: 'check-failed', required: checks.some((c) => c.required), who, checks, rerun: checks.some((c) => c.run) });
    }
    const running = f.checkList.filter((c) => c.result === 'pending').map(checkOf);
    if (running.length) out.push({ kind: 'check-running', required: running.some((c) => c.required), checks: running });
  } else if (f.checks === 'failure') {
    // No per-check list: GitHub's merge state says whether a failing check is required.
    out.push({ kind: 'check-failed', required: f.mergeState !== 'unstable', who, checks: (f.failing || []).map((name) => ({ name, required: f.mergeState !== 'unstable', quick: false })), rerun: false });
  } else if (f.checks === 'pending') out.push({ kind: 'check-running', required: f.mergeState === 'blocked', checks: [] });
  if (f.review === 'required' || f.review === 'changes') {
    out.push({ kind: 'needs-review', required: true, who: f.requested || [], approvals: f.approvals ?? null, canApprove: f.canApprove === true, changes: f.review === 'changes' });
  }
  if (f.mergeState === 'behind') out.push({ kind: 'behind', required: true, who });
  if (f.mergeState === 'blocked' && !out.some((b) => b.required)) out.push({ kind: 'protected', required: true, detail: 'Branch protection rules block this merge.' });
  return out;
}
// Whether the plan leaves a PR out: anything GitHub requires, and with `anyway` off, anything at all.
export const waits = (blockers, anyway = false) => blockers.some((b) => b.required || !anyway);
// Only checks GitHub doesn't require stand in the way: Merge anyway would take it.
export const anywayOnly = (blockers) => blockers.length > 0 && blockers.every((b) => !b.required);
// The blocker a one-line reason names: the first GitHub requires, else the first.
export const mainBlocker = (blockers) => blockers.find((b) => b.required) || blockers[0] || null;

const names = (list, max = 2) => {
  const n = list.map((c) => c.name);
  if (n.length <= max) return n.join(' and ');
  return `${n.slice(0, max).join(', ')} and ${n.length - max} more`;
};
export function blockerText(b, stacks) {
  switch (b?.kind) {
    case 'draft': return 'It’s a draft.';
    case 'conflicts-base': return b.files?.length ? `Conflicts with the base in ${fileList(b.files)}` : 'It has conflicts with its base branch.';
    case 'conflicts-pr': return b.with ? `Conflicts with ${unitLabel(b.with, stacks)} in ${fileList(b.files)}` : blockedText(b);
    case 'check-failed': return b.checks?.length ? `${names(b.checks)} failed${b.required ? '' : ', not required'}` : 'Checks failed.';
    case 'check-running': return b.checks?.length ? `${names(b.checks)} still running` : 'Checks are still running.';
    case 'needs-review': return b.changes ? 'Changes were requested.' : b.approvals > 1 ? `Needs ${b.approvals} approvals.` : 'Needs an approval.';
    case 'behind': return 'It’s behind its base, and the base must be up to date.';
    case 'stack': return `#${b.number} below it can’t merge yet`;
    default: return b?.detail || 'GitHub won’t merge it yet.';
  }
}

// Whether GitHub would merge a PR now (no blockers at all): what Review's Ready to merge means.
export const isReady = (info) => Boolean(info) && !waits(blockersOf(info));

// Clean up after merging (AK-543): what git.cleanupLanes should remove for PRs GitHub confirmed
// merged. `merged` is [{ number, branch, head }] (head: the PR's tip, so a local branch with other
// commits is kept); `local` is the set of local branch names; `worktrees` is git.getWorktrees,
// each optionally marked `elsewhere` when another window shows it. A worktree in this window, the
// main worktree or one open elsewhere is skipped, branch included. → { items, skipped: [{ name, message }] }
export function cleanupItems(merged, local, worktrees) {
  const items = [];
  const skipped = [];
  for (const pr of merged) {
    if (!pr.branch || !local.has(pr.branch)) continue;
    const wt = worktrees.find((w) => w.branch === pr.branch);
    const why = wt && (wt.current ? 'It’s checked out in this window.' : wt.main ? 'It’s checked out in the main worktree.'
      : wt.elsewhere ? 'It’s open in another window.' : wt.locked ? 'Its worktree is locked.' : null);
    if (why) skipped.push({ name: pr.branch, message: why });
    else items.push({ branch: pr.branch, head: pr.head || undefined, ...(wt ? { worktree: wt.path } : {}) });
  }
  return { items, skipped };
}

// What a clean up did, for the sheet: { worktrees, branches, skipped } from git.cleanupLanes' result.
export const cleanupSummary = (res, skipped = []) => ({
  worktrees: res.removed.length, branches: res.deleted.length, skipped: [...skipped, ...res.failed],
});

// The sheet's split button and method menu (AK-542). `merge` is "Create a Merge Commit" in the menu, but the
// button just says "Merge 3 in order".
export const METHOD_NAMES = { squash: 'Squash & Merge', merge: 'Create a Merge Commit', rebase: 'Rebase & Merge' };
const VERBS = { squash: 'Squash & Merge', merge: 'Merge', rebase: 'Rebase & Merge' };
export const mergeLabel = (method, n) => `${VERBS[method] || VERBS.squash} ${n}${n > 1 ? ' in order' : ''}`;
// "Order · 3 of 4 picked" before merging, "Order · 3" once it runs.
export const orderLabel = (picked, pickable, running) => (running ? `Order · ${picked}` : `Order · ${picked} of ${pickable} picked`);

// ── What the sheet shows for PRs that can't merge yet (AK-549) ──
// A stack's readable name: the issue-key range of its titles ("AK-518 → AK-530"), else the title
// they share without the Conventional Commits prefix, the "[k/n]" and the key.
const ISSUE_KEY = /\(([A-Z][A-Z0-9]*-\d+)\)/;
export const cleanTitle = (t) => {
  const s = String(t || '').replace(/^\s*[a-z]+(\([^)]*\))?!?:\s*/i, '').replace(/\s*\[\d+\/\d+\]\s*$/, '').replace(/\s*\([A-Z][A-Z0-9]*-\d+\)\s*$/, '').trim();
  return s.replace(/^./, (c) => c.toUpperCase());
};
export function stackName(titles = []) {
  const keys = titles.map((t) => ISSUE_KEY.exec(t || '')?.[1] || null);
  if (keys.length > 1 && keys.every(Boolean) && keys[0] !== keys[keys.length - 1]) return `${keys[0]} → ${keys[keys.length - 1]}`;
  const clean = titles.map(cleanTitle);
  return clean.find(Boolean) || keys.find(Boolean) || '';
}

// "Needs something first", grouped by what's in the way, in the order to deal with them.
export const GROUPS = ['check-failed', 'check-running', 'conflicts', 'review', 'draft', 'behind', 'other'];
const GROUP_OF = { 'check-failed': 'check-failed', 'check-running': 'check-running', 'conflicts-base': 'conflicts', 'conflicts-pr': 'conflicts', 'needs-review': 'review', draft: 'draft', behind: 'behind' };
export const groupOf = (b) => GROUP_OF[b?.kind] || 'other';
// A PR's own blockers: the plan also marks every PR above a stack's blocker with `stack`.
export const ownBlockers = (list = []) => list.filter((b) => b.kind !== 'stack');
// entries: [{ key, prs, blockers }] (a stack's blockers are its blocking PR's). → [{ id, entries }].
export function groupNeeds(entries = []) {
  const by = new Map();
  for (const e of entries) {
    const id = groupOf(mainBlocker(e.blockers || []));
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(e);
  }
  return GROUPS.filter((id) => by.has(id)).map((id) => ({ id, entries: by.get(id) }));
}
// Failing (or running) check names across a group, each once.
export const groupChecks = (entries, kind = 'check-failed') => {
  const seen = new Map();
  for (const e of entries) for (const b of e.blockers || []) if (b.kind === kind) for (const c of b.checks || []) if (!seen.has(c.name)) seen.set(c.name, c);
  return [...seen.values()];
};
const prCount = (entries) => entries.reduce((n, e) => n + (e.prs?.length || 1), 0);
const isAre = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const PHRASES = {
  'check-failed': (n) => isAre(n, 'failed a check', 'failed a check'),
  'check-running': (n) => isAre(n, 'is waiting on checks', 'are waiting on checks'),
  conflicts: (n) => isAre(n, 'has conflicts', 'have conflicts'),
  review: (n) => isAre(n, 'needs a review', 'need a review'),
  draft: (n) => isAre(n, 'is a draft', 'are drafts'),
  behind: (n, base) => isAre(n, `is behind ${base}`, `are behind ${base}`),
  other: (n) => isAre(n, 'can’t merge for another reason', 'can’t merge for other reasons'),
};
const andList = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

// The sentence at the top of the sheet: { lead, rest }. now: PRs that merge now (a stack counts
// each PR); groups: groupNeeds' output.
export function planSummary({ now = 0, groups = [], base = 'the base' } = {}) {
  const waiting = groups.reduce((n, g) => n + prCount(g.entries), 0);
  const total = now + waiting;
  if (!waiting) return now ? { lead: now === 1 ? 'It can merge' : `All ${now} can merge`, rest: now === 1 ? ' with no conflicts.' : ', in this order, with no conflicts.' } : { lead: 'Nothing to merge.', rest: '' };
  // A stack held up by one PR counts as its own phrase: its other PRs didn't fail anything.
  const singles = groups.map((g) => [g.id, prCount(g.entries.filter((e) => !(e.prs?.length > 1)))]).filter(([, n]) => n);
  const stacked = groups.reduce((n, g) => n + prCount(g.entries.filter((e) => e.prs?.length > 1)), 0);
  const list = andList([...singles.map(([id, n]) => PHRASES[id](n, base)), ...(stacked ? [`${stacked} ${stacked === 1 ? 'is' : 'are'} in a stack that can’t merge yet`] : [])]);
  if (now) return { lead: `${now} of ${total} can merge now.`, rest: ` ${waiting} need${waiting === 1 ? 's' : ''} something first: ${list}.` };
  if (groups.length > 1) return { lead: 'Nothing can merge yet.', rest: ` ${waiting === 1 ? 'It needs' : `${waiting} need`} something first: ${list}.` };
  const g = groups[0];
  const all = waiting > 1 ? `all ${waiting}` : 'it';
  if (g.id === 'check-failed') {
    const checks = groupChecks(g.entries);
    const optional = checks.length > 0 && checks.every((c) => !c.required);
    const what = checks.length === 1 ? `the ${checks[0].name} check failed` : checks.length ? `${andList(checks.map((c) => c.name))} failed` : 'checks failed';
    const inStack = g.entries.length === 1 && g.entries[0].prs?.length > 1 ? ' in the stack' : '';
    // hits: the PRs in an entry the check failed on (a stack's other PRs may be fine).
    const hits = g.entries.reduce((n, e) => n + (e.hits ?? (e.prs?.length || 1)), 0);
    const on = waiting === 1 ? 'it' : hits >= waiting ? `${all} PRs${inStack}` : `${hits} of the ${waiting} PRs${inStack}`;
    const why = optional ? ` ${base} doesn’t require ${checks.length === 1 ? 'it' : 'them'}, so GitHub would let you merge.` : '';
    return { lead: 'Nothing can merge yet, and it’s one thing:', rest: ` ${what} on ${on}.${why}` };
  }
  return { lead: 'Nothing can merge yet:', rest: ` ${list}.` };
}
