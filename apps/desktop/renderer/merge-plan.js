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
//     blocked: [{ number | stack, files }], warnings: [{ number, files }], tip, complete }
// order: a sequence that merges with no text conflicts, as close to the natural order as possible;
//   `after` is null when the unit merges clean on the base alone, else the key it has to wait for.
// forced: why the order differs from the natural one: "#first before #then would conflict in files".
// blocked: ready PRs no clean order fits, with the files they'd conflict in at the end.
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
  for (const p of ready) if (!inPlan.has(keyOf(p))) blocked.push({ ...(p.stack ? { stack: p.stack } : { number: p.number }), files: (await sim(tip, p.head)).files });

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

// Native GitHub stacks among the open PRs (AK-545): a straight chain where the bottom PR targets
// `base` and each PR above targets the branch of the one below. open: [{ number, branch,
// baseBranch, head }]. A chain that forks (two PRs on one branch) isn't a stack, and its bottom PR
// plans on its own. → [{ id, prs: [bottom…top], heads }], two PRs or more, at most MAX_STACK.
export function findStacks(open = [], base) {
  const byBase = new Map();
  for (const p of open) {
    if (!p.branch || !p.baseBranch) continue;
    if (!byBase.has(p.baseBranch)) byBase.set(p.baseBranch, []);
    byBase.get(p.baseBranch).push(p);
  }
  const stacks = [];
  for (const bottom of byBase.get(base) || []) {
    const chain = [bottom];
    const seen = new Set([base, bottom.branch]);
    let straight = true;
    for (;;) {
      const kids = byBase.get(chain[chain.length - 1].branch) || [];
      if (kids.length > 1) { straight = false; break; }
      if (!kids.length || seen.has(kids[0].branch) || chain.length >= MAX_STACK) break;
      seen.add(kids[0].branch);
      chain.push(kids[0]);
    }
    if (straight && chain.length > 1) stacks.push({ id: `stack-${bottom.number}`, prs: chain.map((p) => p.number), heads: chain.map((p) => p.head) });
  }
  return stacks;
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

// Whether `gh pr view` (mergeInfo) says a PR is ready: what Review's Ready to merge means.
export const isReady = (info) => Boolean(info && info.state === 'open' && !info.draft && !info.conflicts
  && info.review === 'approved' && (info.checks === 'success' || info.checks == null));
