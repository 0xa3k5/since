// Merge plan (Review, AK-279): a safe order for squash-merging the ready PRs one after another.
// Pure: `merge(tip, head)` simulates squash-merging `head` onto `tip` (git.simulateSquash, one
// `git merge-tree --write-tree` each) and resolves to { files, commit } — commit is the simulated
// result when it merges clean, null with the conflicting files when it doesn't. Text conflicts only:
// clashes that merge clean but break the build are CI's job.

// At most this many PRs are planned, and this many simulated merges per plan.
export const MAX_READY = 10;
export const MAX_OTHERS = 20;
export const MAX_MERGES = 300;

// prs: the ready PRs [{ number, head }] in their natural order (Review's: waiting longest first).
// others: open PRs that aren't ready [{ number, head }]. Returns
//   { order: [{ number, after }], forced: [{ first, then, files }], blocked: [{ number, files }],
//     warnings: [{ number, files }], tip, complete }
// order: a sequence that merges with no text conflicts, as close to the natural order as possible;
//   `after` is null when the PR merges clean on the base alone, else the PR it has to wait for.
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
    const key = done.map((d) => d.pr.number).sort((a, b) => a - b).join(',');
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
    order.push({ number: best[i].pr.number, after: k ? best[k - 1].pr.number : null });
  }

  const rank = new Map(ready.map((p, i) => [p.number, i]));
  const forced = [];
  const explained = new Set();
  for (let i = 0; i < best.length; i++) {
    const x = best[i].pr;
    // A PR later in the plan that comes earlier naturally: say what goes wrong if it went first.
    for (const y of best.slice(i + 1).map((s) => s.pr)) {
      if (rank.get(y.number) > rank.get(x.number) || explained.has(y.number)) continue;
      const first = await sim(best[i].before, y.head);
      const files = first.commit ? (await sim(first.commit, x.head)).files : first.files;
      if (!files.length) continue;
      explained.add(y.number);
      forced.push({ first: y.number, then: x.number, files });
    }
  }

  const tip = tips[tips.length - 1];
  const inPlan = new Set(best.map((s) => s.pr.number));
  const blocked = [];
  for (const p of ready) if (!inPlan.has(p.number)) blocked.push({ number: p.number, files: (await sim(tip, p.head)).files });

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

export const statusText = (step) => (step.after ? `clean after #${step.after}` : 'clean');
export const forcedText = (f) => `#${f.first} before #${f.then} would conflict in ${fileList(f.files)}`;
export const blockedText = (b) => `Conflicts in ${fileList(b.files)} with the PRs above, so it’s left out`;
export const warningText = (w) => `#${w.number} will conflict in ${fileList(w.files)} after these merge`;

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
