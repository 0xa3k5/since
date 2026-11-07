import { h, icon, toast, ago, dialog, confirm, contextMenu, palette, resolveSheet } from '../lib/ui.js';
import { mergeGateFix, ghErrorFix } from './gh-gates.js';
import * as keymap from '../palette/keymap.js';
import { prefetchReview } from '../lanes/lanes-view.js';
import { stageMemory, STAGES } from '../review/review-rows.js';
import { prefetchCatchup } from '../catchup/catchup-view.js';
import { SUBMODULE_STATES } from '../lib/submodule.js';
import { failingChecks, passedCount, checkLines, mergeConfirm } from '../lanes/check-confirm.js';
import { peekEvidence } from '../review/evidence-store.js';
import { prsByRef, prRef, prTitle, refKey, prActionRemote, prActionCall, approveWhy, draftSwitch, withDraft, REVIEW_LABELS, CHECK_LABELS } from './prs.js';
import { up } from '../lib/upcalls.js';
import { state, api, prop, tildify, parentDir, MOD, keyText } from '../lib/app-helpers.js';
import { lanesPage, catchupPage, mapView, reviewPage } from '../shell/shell.js';
import { undo, act } from '../lib/bridge.js';
import { addRemote, fetchAll } from '../branches/remote-ops.js';
import { openQuick } from '../graph/quick-view.js';

// Pull requests (read-only), through the user’s GitHub CLI. One user-wide switch (plus a per-repo hide);
// `gh` only runs on Fetch or Refresh, never in the background. The last result is kept per
// repository and shown as stale until the next successful refresh.

const prCacheKey = (root) => 'prs:' + root;
async function loadPrs() {
  const repo = state.repo;
  const st = await api.app('pr-state').catch(() => null);
  if (!st || state.repo !== repo) return;
  let data = null;
  if (st.active) { try { data = JSON.parse(localStorage.getItem(prCacheKey(repo.root))); } catch { /* none */ } }
  state.prs = { ...st, data, stale: Boolean(data), error: null, busy: false, byRef: new Map() };
  showPrs();
}
// Review's and Catch up's pull requests load when a repo opens (AK-382) and after each Fetch (AK-401), with
// pull requests on, and on Reload (⌘R): not on view changes or window focus. The same loads Reload runs, shared, so
// an open Review or Catch up shows "Reloading…" and then the PRs; a closed one finds them in its cache.
function prefetchOnOpen() {
  const root = state.repo?.root;
  if (!root || !state.prs?.active) return;
  const prsOn = () => Boolean(state.prs?.active) && state.repo?.root === root;
  prefetchReview({ repo: root, load: (opts) => api.app('lanes-list', opts), prsOn }).then(() => { if (state.repo?.root === root) up.countReview(); });
  prefetchCatchup({ repo: root, load: (opts) => api.app('catchup', opts), prsOn, onCount: (n) => { if (state.repo?.root === root) up.setCatchupCount(n); } });
  if (lanesPage?.el.isConnected && lanesPage.canReload()) lanesPage.reload(); // joins the load above
  if (catchupPage?.el.isConnected) catchupPage.reload();
}
function indexPrs() { if (state.prs) state.prs.byRef = prsByRef(state.prs.data, state.refs); }
function showPrs() { indexPrs(); up.renderSidebar(); mapView?.refresh(); }
const prFor = (r) => (state.prs?.active ? state.prs.byRef.get(refKey(r)) : null);
const openPrOnGitHub = (pr) => pr.url && api.app('external', pr.url);

// Draft and review marks plus the PR's Review stage dot (AK-385: the same stage and colour as Review,
// from GitHub's merge box, so a failing check GitHub doesn't require stays green), shared by graph
// badges and the sidebar list.
let prStage = stageMemory(); // new per repository
const prMarks = (pr) => {
  const stage = prStage(pr);
  const label = STAGES.find((x) => x.id === stage)?.label || 'In progress';
  return [
    pr.draft ? h('span.pr-draft', null, 'draft') : null,
    pr.review === 'approved' ? h('span.pr-review.approved', null, '✓') : pr.review === 'changes' ? h('span.pr-review.changes', null, '✗') : null,
    h('span.review-dot.pr-dot' + (stage ? `.${stage}` : ''), { role: 'img', 'aria-label': label, title: label }),
  ];
};
function prBadge(pr) {
  if (!pr) return null;
  const stop = (e) => e.stopPropagation();
  return h('span.pr-badge' + (state.prs.stale ? '.stale' : ''), { title: prTitle(pr, state.prs.stale), onmousedown: stop, onclick: (e) => { stop(e); openPr(pr); }, oncontextmenu: (e) => { stop(e); prMenu(e, pr); } }, `#${pr.number}`, prMarks(pr));
}

// Quick view: the PR's summary, with Open on GitHub.
async function openPr(pr) {
  const updated = Date.parse(pr.updatedAt);
  const ok = await dialog({
    title: `#${pr.number} ${pr.title}`,
    description: h('div.pr-quick', null,
      prop('Author', pr.author || '—'),
      prop('Branch', `${pr.branch} → ${pr.base}`),
      prop('Review', pr.draft ? 'Draft' : REVIEW_LABELS[pr.review] || 'No review yet'),
      prop('Checks', CHECK_LABELS[pr.checks] || 'No checks'),
      Number.isFinite(updated) ? prop('Updated', ago(updated / 1000)) : null,
      state.prs.stale ? h('div.pr-stale-note', null, 'Not refreshed: this is the last result Since got.') : null,
    ),
    submit: 'Open on GitHub',
  });
  if (ok) openPrOnGitHub(pr);
}

function goToPr(pr) {
  const r = prRef(pr, state.refs, state.prs.byRef);
  if (!r) return toast(`${pr.branch} isn’t in this clone`, { detail: 'Check it out to get it, or open the pull request on GitHub.', action: { label: 'Check out', run: () => checkoutPr(pr) } });
  if (!state.index.has(r.target)) return openQuick(r.target);
  up.jumpTo(r.target);
}

// Check out a PR as a branch (gh's branch name), here or in a new worktree. Undoable with ⌘Z.
// An existing branch that points somewhere else is only moved after asking.
async function checkoutPr(pr, { worktree = false } = {}) {
  let opts = { worktree };
  if (worktree) {
    const main = state.worktrees.find((w) => w.main);
    const v = await dialog({
      title: `Check out #${pr.number} in a new worktree`,
      description: `Fetches ${pr.branch} from GitHub and checks it out on a new branch in its own worktree.`,
      submit: 'Create worktree',
      fields: [
        { name: 'dir', label: 'Location (optional)', placeholder: main ? `${tildify(parentDir(main.path))}/${main.name}-${pr.branch.replace(/\//g, '-')}` : '' },
        { name: 'open', type: 'checkbox', label: 'Switch this window to it', value: false },
      ],
    });
    if (!v) return;
    opts = { worktree, dir: v.dir.trim() || null, open: v.open };
  }
  const run = async (update, free = null, move = null) => {
    const t = toast(`Checking out #${pr.number}…`, { kind: 'busy', timeout: 0 });
    const res = await api.app('pr-checkout', pr.number, { worktree, dir: opts.dir || null, update, free, ...(move && { move: true, stash: move.stash }) }).catch((e) => ({ error: { message: e.message } }));
    t.close();
    return res;
  };
  let res = await run(false), update = false;
  if (res.ok?.confirm) {
    const c = res.ok.confirm;
    const ok = await confirm(`Update ${c.branch}?`, `${c.branch} is at ${c.from.slice(0, 7)}. Pull request #${pr.number} is at ${c.to.slice(0, 7)}. Moving the branch there is undoable with ${MOD}Z.`, { submit: 'Update branch' });
    if (!ok) return;
    res = await run(update = true);
  }
  if (res.ok?.inUse) {
    const { branch, worktree: w } = res.ok.inUse;
    const v = await up.inUseSheet(branch, w);
    if (!v) return;
    res = await run(update, w.path, v.id === 'move' ? { stash: v.stash } : null);
  }
  if (res.error) return prError(`Couldn’t check out #${pr.number}`, { ...res.error, message: res.error.stderr || res.error.message });
  const { branch, worktree: wt } = res.ok;
  toast(wt ? `New worktree for #${pr.number} on ${branch}` : `Switched to ${branch} (#${pr.number})`, { kind: 'success', action: { label: 'Undo', run: undo } });
  if (wt && opts.open) up.openRepo(wt.path);
  return res.ok;
}

// ⌘⌥⇧O / ⌘⌥⇧L: pick an open PR to check out here or in a new worktree.
function pickPr(worktree) {
  if (!state.prs?.active) return setupPrs();
  const prs = state.prs.data?.prs || [];
  if (!prs.length) return toast('No pull requests yet', { detail: `Refresh pull requests with ${keyText('repo.prRefresh')}.` });
  palette(() => prs.map((pr) => ({ group: 'Open pull requests', label: `#${pr.number} ${pr.title}`, icon: worktree ? 'worktree' : 'merge', detail: pr.branch, keywords: `${pr.author} ${pr.branch} ${pr.base}`, run: () => checkoutPr(pr, { worktree }) })),
    { placeholder: worktree ? 'Check out pull request in a new worktree…' : 'Check out pull request…' });
}

// ⌘⌥⇧N: open a PR from the current (or a picked) branch. Title and body come from its commits.
// A branch that isn't on GitHub yet is only pushed after the user ticks the confirm.
async function createPr(branch = state.head.branch) {
  if (!state.prs?.active) return setupPrs();
  if (!branch) return toast('Check out a branch first', { detail: 'A pull request needs a branch to merge from.' });
  const open = prFor({ kind: 'branch', short: branch });
  if (open) return toast(`${branch} already has #${open.number}`, { action: { label: 'Open', run: () => openPr(open) } });
  const t = toast(`Preparing a pull request for ${branch}…`, { kind: 'busy', timeout: 0 });
  const info = await api.app('pr-create-info', branch).catch((e) => ({ error: { message: e.message } }));
  t.close();
  if (info.error) return prError(`Couldn’t prepare a pull request for ${branch}`, info.error);
  const { base, remote, push } = info.ok;
  const bases = [...new Set([base, ...state.refs.filter((r) => r.kind === 'remote' && r.short.startsWith(`${remote}/`)).map((r) => r.short.slice(remote.length + 1)).filter((b) => b !== 'HEAD' && b !== branch)])];
  const aiReady = state.ai?.provider !== 'off' && state.ai?.consented;
  const v = await dialog({
    title: `New pull request from ${branch}`,
    description: h('div.pr-merge', null,
      h('div', null, `${info.ok.head} → ${base} on ${remote}`),
      push ? h('div.pr-blocked', null, push.isNew ? `${branch} isn’t on ${remote} yet.` : `${branch} has ${push.ahead} commit${push.ahead === 1 ? '' : 's'} that ${push.ahead === 1 ? 'isn’t' : 'aren’t'} on ${push.remote} yet.`) : null,
      h('div.pr-remote-note', null, REMOTE_NOTE),
    ),
    submit: push ? 'Push and create' : 'Create pull request',
    wide: true,
    gate: push ? 'push' : undefined,
    fields: [
      bases.length > 1 ? { name: 'base', type: 'select', label: 'Base branch', value: base, options: bases.map((b) => ({ value: b, label: b })) } : null,
      { name: 'title', label: 'Title', value: info.ok.title },
      { name: 'body', label: 'Description', multiline: true, rows: 10, value: info.ok.body },
      aiReady ? { name: 'ai', type: 'button', icon: 'sparkle', label: 'Draft with AI', run: async (inputs) => {
        const busy = toast('Drafting the pull request…', { kind: 'busy', timeout: 0 });
        const res = await api.app('pr-ai-draft', branch, inputs.base?.value || base).catch((e) => ({ error: { message: e.message } }));
        busy.close();
        if (res.error) return toast('Couldn’t draft the pull request', { kind: 'error', detail: res.error.message });
        if (res.ok.title) inputs.title.value = res.ok.title;
        inputs.body.value = res.ok.body;
      } } : null,
      { name: 'draft', type: 'checkbox', label: 'Create as draft', value: false },
      push ? { name: 'push', type: 'checkbox', label: `Push ${branch} to ${push.remote} first`, value: false } : null,
    ].filter(Boolean),
  });
  if (!v) return;
  if (!v.title.trim()) return toast('A pull request needs a title', { kind: 'error' });
  const busy = toast(push ? `Pushing ${branch} and creating the pull request…` : 'Creating the pull request…', { kind: 'busy', timeout: 0 });
  const res = await api.app('pr-create', branch, { base: v.base || base, title: v.title, body: v.body, draft: v.draft, push: Boolean(v.push) }).catch((e) => ({ error: { message: e.message } }));
  busy.close();
  if (res.error) return prError(`Couldn’t create the pull request`, res.error);
  const { number, url } = res.ok;
  toast(`Opened #${number}${v.draft ? ' as a draft' : ''}`, { kind: 'success', detail: url, action: { label: 'Open on GitHub', run: () => openPrOnGitHub({ url }) } });
  refreshPrs();
}

// Pick a local branch for a new PR when the current one can't be used (⌘K entry).
function pickPrBranch() {
  const branches = state.refs.filter((r) => r.kind === 'branch' && !prFor(r));
  palette(() => branches.map((r) => ({ group: 'Branches', label: r.short, icon: 'branch', detail: r.upstream || 'not pushed', run: () => createPr(r.short) })), { placeholder: 'New pull request from branch…' });
}

async function refreshPrs({ manual = false } = {}) {
  const p = state.prs;
  if (!p?.active) return manual ? setupPrs() : undefined;
  if (p.busy) return;
  p.busy = true;
  const busy = manual ? toast('Refreshing pull requests…', { kind: 'busy', timeout: 0 }) : null;
  const res = await api.app('pr-list').catch((e) => ({ error: { message: e.message } }));
  busy?.close();
  p.busy = false;
  if (state.prs !== p) return; // another repository by now
  if (res.ok) {
    p.data = res.ok;
    p.stale = false;
    p.error = null;
    try { localStorage.setItem(prCacheKey(state.repo.root), JSON.stringify(res.ok)); } catch { /* full */ }
    if (manual) toast(`${res.ok.prs.length} open pull request${res.ok.prs.length === 1 ? '' : 's'}`, { kind: 'success' });
  } else if (res.ok === null) {
    p.active = false; // turned off or hidden in another window
  } else {
    // Offline or a `gh` error: keep what we had, marked stale. After a fetch this stays quiet.
    p.stale = Boolean(p.data);
    p.error = res.error.message;
    if (manual) prError('Couldn’t refresh pull requests', res.error);
  }
  showPrs();
}

const setPrState = (next) => { state.prs = { ...next, data: null, stale: false, error: null, busy: false, byRef: new Map() }; showPrs(); };
let prLoggedOut = false; // the last turn-on found `gh` logged out, so setup shows Set up… until it works

// One switch for every repository. `ask` explains first (⌘K, ⌘⌥P); the setup switch skips that.
async function setupPrs({ ask = true } = {}) {
  const st = await api.app('pr-state').catch(() => null);
  if (!st) return toast('Open a repository to turn on pull requests', { detail: 'After that they’re on in every repository.' });
  if (st.enabled && st.hidden) return hidePrs(false);
  if (st.enabled && !st.remote) return toast('This repository has no GitHub remote', { action: { label: 'Add remote…', run: () => addRemote() } });
  if (ask) {
    const ok = await dialog({
      title: 'Show pull requests from GitHub?',
      description: 'Shows open pull requests in the graph and the sidebar of every repository with a GitHub remote. Uses your GitHub CLI login and talks to GitHub only when you fetch or refresh.',
      submit: 'Turn on',
    });
    if (!ok) return;
  }
  if (st.gh === 'missing') {
    const install = await dialog({ title: 'Install GitHub CLI', description: 'Since reads pull requests through GitHub’s own `gh` command, so it never handles your token. Install it, run `gh auth login` once, then turn pull requests on again.', submit: 'Open cli.github.com' });
    if (install) api.app('external', st.installUrl);
    return;
  }
  // Login is per host, so it's checked against this repository's remote when there is one.
  if (st.remote) {
    const det = await api.app('pr-detect');
    if (det.error) return toast('Couldn’t check GitHub CLI', { kind: 'error', detail: det.error.message });
    prLoggedOut = det.ok.gh === 'logged-out';
    if (prLoggedOut) {
      const host = st.remote.host;
      const login = await resolveSheet({ title: 'Turn on pull requests', reason: `GitHub CLI isn’t logged in to ${host}.`, actions: [{ id: 'login', label: 'Open Terminal' }] });
      if (login) api.app('gh-login');
      return;
    }
  }
  const next = await api.app('pr-enable', true);
  setPrState(next);
  toast('Pull requests on', { kind: 'success', action: { label: 'Undo', run: () => turnOffPrs() } });
  if (next.active) refreshPrs();
}

async function turnOffPrs() {
  const next = await api.app('pr-enable', false);
  try { localStorage.removeItem(prCacheKey(state.repo.root)); } catch { /* ignore */ }
  setPrState(next);
  toast('Pull requests off', { action: { label: 'Undo', run: () => setupPrs({ ask: false }) } });
}
const togglePrs = () => (state.prs?.enabled ? turnOffPrs() : setupPrs());

// The per-repository escape hatch. The cache stays, so showing them again is instant.
async function hidePrs(hide) {
  const next = await api.app('pr-hide', hide);
  if (hide) setPrState(next); else await loadPrs();
  toast(hide ? 'Hidden in this repository' : 'Shown in this repository', { action: { label: 'Undo', run: () => hidePrs(!hide) } });
}

// Which remote the PR features use here (AK-461): Automatic or one GitHub remote by name. Saved per repository
// in settings.json; switching reloads the PR list from the new remote.
async function setPrRemote(name) {
  const prev = state.prs?.chosen ?? null;
  const next = await api.app('pr-remote', name).catch((err) => { toast('Couldn’t change the remote', { kind: 'error', detail: err.message }); return null; });
  if (!next) return;
  // The cached list came from the old remote.
  if (state.repo) localStorage.removeItem(prCacheKey(state.repo.root));
  setPrState(next);
  if (next.active) refreshPrs();
  toast(next.remote ? `Pull requests use ${next.remote.name}` : 'Pull requests use the default remote', { detail: next.remote ? `${next.remote.owner}/${next.remote.repo}` : null, action: { label: 'Undo', run: () => setPrRemote(prev) } });
}
function pickPrRemote() {
  const st = state.prs;
  if (!st?.choices?.length) return toast('This repository has no GitHub remote', { action: { label: 'Add remote…', run: () => addRemote() } });
  palette(() => [
    { group: 'Remote for pull requests', label: 'Automatic', detail: 'origin when it is on GitHub, else the first GitHub remote', icon: st.chosen ? 'cloud' : 'check', run: () => setPrRemote(null) },
    ...st.choices.map((c) => ({ group: 'Remote for pull requests', label: c.name, detail: `${c.owner}/${c.repo}`, icon: st.chosen === c.name ? 'check' : 'cloud', run: () => setPrRemote(c.name) })),
  ], { placeholder: 'Remote for pull requests…' });
}

// ⌘⌥P: open PRs, newest update first; pick one to jump to its branch.
function prList() {
  if (!state.prs?.active) return setupPrs();
  const prs = state.prs.data?.prs || [];
  palette(() => [
    ...prs.map((pr) => ({ group: state.prs.stale ? 'Open pull requests (not refreshed)' : 'Open pull requests', label: `#${pr.number} ${pr.title}`, icon: 'merge', detail: pr.branch, keywords: `${pr.author} ${pr.branch} ${pr.base}`, run: () => goToPr(pr) })),
    { group: 'Pull requests', label: 'Refresh pull requests', icon: 'fetch', kbd: keymap.keys('repo.prRefresh'), run: () => refreshPrs({ manual: true }) },
    { group: 'Pull requests', label: 'New pull request…', icon: 'plus', kbd: keymap.keys('repo.prCreate'), run: () => createPr() },
    { group: 'Pull requests', label: 'Check out pull request…', icon: 'checkout', kbd: keymap.keys('repo.prCheckout'), run: () => pickPr(false) },
    { group: 'Pull requests', label: 'Check out pull request in new worktree…', icon: 'worktree', kbd: keymap.keys('repo.prWorktree'), run: () => pickPr(true) },
    { group: 'Pull requests', label: 'Approve pull request…', icon: 'check', kbd: keymap.keys('repo.prApprove'), detail: approveTargetWhy(), gated: Boolean(approveTargetWhy()), run: () => approvePr() },
    { group: 'Pull requests', label: 'Merge pull request…', icon: 'merge', kbd: keymap.keys('repo.prMerge'), run: up.mergePrCmd },
    { group: 'Pull requests', label: 'Close pull request…', icon: 'x', kbd: keymap.keys('repo.prClose'), run: up.closePrCmd },
    { group: 'Pull requests', label: 'Show in sidebar', icon: 'sidebar', run: () => up.openSidebarAt('prs') },
  ], { placeholder: 'Go to pull request…' });
}

// Approve, merge and close. These happen on GitHub, so ⌘Z can't undo them, and each sheet says
// so. What follows locally (fetch, deleting the merged branch) goes through the journal as usual.
const REMOTE_NOTE = 'This happens on GitHub. ⌘Z can’t undo it.';
const prRemote = (pr, fallback) => prActionRemote(pr, state.prs, fallback);

// The PR to act on: the one given, else the checked-out branch's, else pick one.
function withPr(pr, verb, fn, whyOf = () => null) {
  if (!state.prs?.active) return setupPrs();
  pr ||= state.review?.pr; // the PR on the review page
  if (pr) return fn(pr);
  const mine = state.head.branch ? prFor({ kind: 'branch', short: state.head.branch }) : null;
  if (mine) return fn(mine);
  const prs = state.prs.data?.prs || [];
  if (!prs.length) return toast('No open pull requests', { detail: `Refresh pull requests (${keyText('repo.prRefresh')}) to load them.` });
  palette(() => prs.map((p) => ({ group: 'Open pull requests', label: `#${p.number} ${p.title}`, icon: 'merge', detail: whyOf(p) || p.branch, gated: Boolean(whyOf(p)), keywords: `${p.author} ${p.branch} ${p.base}`, run: () => fn(p) })), { placeholder: `${verb} pull request…` });
}
// The PR a bare Approve acts on without asking (withPr), and why it can't be approved, for ⌘K (AK-577).
const approveTargetWhy = () => {
  if (!state.prs?.active) return null;
  const pr = state.review?.pr || (state.head.branch ? prFor({ kind: 'branch', short: state.head.branch }) : null);
  return pr ? approveWhy(pr, prViewer()) : null;
};

async function prCall(channel, pr, opts, busy) {
  const t = toast(busy, { kind: 'busy', timeout: 0 });
  const res = await prActionCall((...a) => api.app(...a), channel, pr, opts, { prs: state.prs });
  t.close();
  return res;
}
// gh errors with a fix one click away (AK-588): log in from Terminal, or add a GitHub remote.
const ghFixAction = (err) => {
  const fix = ghErrorFix(err);
  if (fix?.id === 'login') return { label: fix.label, run: () => api.app('gh-login') };
  if (fix?.id === 'addRemote') return { label: fix.label, run: () => addRemote() };
  if (fix?.id === 'installStack') return { label: fix.label, run: installStack };
  return null;
};
async function installStack() {
  const t = toast('Installing the stack extension…', { kind: 'busy', timeout: 0 });
  const res = await api.app('pr-stack-install').catch((e) => ({ error: { message: e.message } }));
  t.close();
  if (res?.error) toast('Couldn’t install the stack extension', { kind: 'error', detail: res.error.message });
  else toast('Installed the stack extension', { kind: 'success' });
}
const ghErrorDetail = (err) => (err.code === 'gh-auth' ? 'GitHub CLI isn’t logged in.' : err.message);
const prError = (title, err) => toast(title, { kind: 'error', detail: ghErrorDetail(err), action: ghFixAction(err) });

// Who you are on GitHub for Approve's reason (AK-577): the caller's (Review's), else the PR list's.
const OWN_PR = /can ?not approve your own pull request/i;
const prViewer = (viewer) => viewer || state.prs?.data?.viewer || null;
const approvePr = (given, onDone, viewer) => withPr(given, 'Approve', async (pr) => {
  const why = approveWhy(pr, prViewer(viewer));
  if (why) return toast(`Can’t approve #${pr.number}`, { detail: why });
  const v = await dialog({
    title: `Approve #${pr.number}?`,
    description: `${pr.title}\n${REMOTE_NOTE}`,
    submit: 'Approve',
    fields: [{ name: 'body', label: 'Comment (optional)', multiline: true, rows: 3 }],
  });
  if (!v) return;
  const res = await prCall('pr-approve', pr, { body: v.body }, `Approving #${pr.number}…`);
  // GitHub's word when the reason above wasn't known (AK-577): said the same way, never gh's text.
  if (res.error && OWN_PR.test(res.error.message)) return toast(`Can’t approve #${pr.number}`, { detail: 'Your own pull request' });
  if (res.error) return prError(`Couldn’t approve #${pr.number}`, res.error);
  toast(`Approved #${pr.number}`, { kind: 'success' });
  onDone?.();
  refreshPrs();
}, (p) => approveWhy(p, prViewer(viewer)));

const requestChangesPr = (given) => withPr(given, 'Request changes on', async (pr) => {
  const v = await dialog({
    title: `Request changes on #${pr.number}?`,
    description: `${pr.title}\n${REMOTE_NOTE}`,
    submit: 'Request changes',
    fields: [{ name: 'body', label: 'What needs to change', multiline: true, rows: 4 }],
  });
  if (!v) return;
  if (!v.body.trim()) return toast('Say what needs to change', { detail: 'GitHub needs a message to request changes.' });
  const res = await prCall('pr-request-changes', pr, { body: v.body }, `Requesting changes on #${pr.number}…`);
  if (res.error) return prError(`Couldn’t request changes on #${pr.number}`, res.error);
  toast(`Requested changes on #${pr.number}`, { kind: 'success' });
  refreshPrs();
});

// A PR's failing checks for a merge confirm (check-confirm.js): names from `gh`, durations and the
// passed count from its evidence when the reader loaded it. checkFailEl draws them:
// "✗ lint failed after 1m 12s", then "and 2 more failing checks · 5 other checks passed".
function prChecks(pr, names = pr?.failing, counts = pr?.checkCounts) {
  const evidence = state.prs?.active ? peekEvidence(prRemote(pr), pr) : null;
  return { failing: failingChecks({ names, evidence }), passed: passedCount({ counts, evidence }) };
}
const prCheckLines = (...a) => { const c = prChecks(...a); return checkLines(c.failing, c.passed); };
const checkFailEl = (c) => (c ? h('div.pr-check-fail', null,
  ...c.lines.map((l) => h('div.pr-check-line', null, h('span.ev-icon.fail', null, icon('x', 12)), h('span.name', null, l.name), h('span.muted', null, l.text))),
  c.more || c.passed ? h('div.muted', null, [c.more, c.passed].filter(Boolean).join(' · ')) : null) : null);

// A merge GitHub refuses outright (AK-588): a draft is marked ready, a conflicting PR is rebased
// here. → the fresh merge info when the merge can go on, else null (cancelled, failed or rebasing).
async function fixMergeGate(pr, info) {
  const local = prRef(pr, state.refs, state.prs.byRef);
  const branch = local?.kind === 'branch' ? local.short : null;
  const fix = mergeGateFix(info, { local: Boolean(branch) });
  if (!fix) { toast(`Can’t merge #${pr.number}`, { kind: 'error', detail: info.gate.hard }); return null; }
  const v = await resolveSheet({ title: `Merge #${pr.number}`, reason: fix.reason, actions: fix.actions });
  if (!v) return null;
  if (v.id === 'rebase') { await rebasePr(pr, branch); return null; }
  const ready = await prCall('pr-ready', pr, undefined, `Marking #${pr.number} ready for review…`);
  if (ready.error) { prError(`Couldn’t mark #${pr.number} ready`, ready.error); return null; }
  const again = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
  if (again.error) { prError(`Couldn’t check #${pr.number}`, again.error); return null; }
  return again.ok.gate.hard ? fixMergeGate(pr, again.ok) : again.ok;
}

// Rebase a PR's branch onto its base as GitHub has it: the local branch when there is one (one
// undo step), else check the PR out first.
async function rebasePr(pr, branch) {
  const remote = prRemote(pr);
  const onto = state.refs.some((r) => r.kind === 'remote' && r.short === `${remote}/${pr.base}`) ? `${remote}/${pr.base}` : pr.base;
  if (branch) {
    const wt = state.worktrees.find((w) => w.branch === branch);
    return up.rebaseLane({ branch, worktree: wt ? { path: wt.path, current: wt.current } : null }, onto);
  }
  const out = await checkoutPr(pr);
  if (out?.branch && !out.worktree) return act(`Rebase ${out.branch} onto ${onto}`, 'rebaseOnto', [onto], { busy: 'Rebasing…' });
}

const MERGE_LABELS = { squash: 'Squash & Merge', merge: 'Create a Merge Commit', rebase: 'Rebase & Merge' };
const mergePr = (given, onDone) => withPr(given, 'Merge', async (pr) => {
  let info = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
  if (info.error) return prError(`Couldn’t check #${pr.number}`, info.error);
  // A draft is a row in the one merge dialog, whose button marks it ready (AK-598).
  const draft = Boolean(info.ok.gate.hard && info.ok.draft && mergeGateFix(info.ok)?.actions[0]?.id === 'ready');
  if (info.ok.gate.hard && !draft) {
    const fixed = await fixMergeGate(pr, info.ok);
    if (!fixed) return;
    info = { ok: fixed };
  }
  const { gate, methods, headOid, checking } = info.ok;
  if (gate.soft.length && !gate.canOverride) return toast(`GitHub blocks merging #${pr.number}`, { kind: 'error', detail: `${gate.soft.join(' ')} Only a repository admin can bypass it.` });
  // The local branch to delete afterwards, found now: the refresh after merging drops the PR.
  const local = prRef(pr, state.refs, state.prs.byRef);
  const sheet = mergeConfirm({ gate, ...prChecks(pr, info.ok.failing, info.ok.checkCounts) });
  const v = await dialog({
    title: `Merge #${pr.number}?`,
    description: h('div.pr-merge', null,
      h('div', null, pr.title),
      h('div', null, draft ? [h('span.warn', null, 'Draft'), ' · '] : null, `${pr.branch} → ${pr.base}`),
      checkFailEl(sheet.checks),
      gate.soft.length ? h('div.pr-blocked', null, `Merge is blocked: ${gate.soft.join(' ')}`) : null,
      checking ? h('div.pr-remote-note', null, 'GitHub is still checking this pull request. If the merge fails, try again in a moment.') : null,
      h('div.pr-remote-note', null, `${REMOTE_NOTE} Fetching and deleting the local branch afterwards can be undone.`),
    ),
    submit: draft ? 'Mark ready and merge' : sheet.submit,
    destructive: sheet.destructive,
    gate: sheet.anyway ? 'anyway' : undefined,
    fields: [
      methods.length > 1 ? { name: 'method', type: 'select', label: 'Merge method', value: methods[0], options: methods.map((m) => ({ value: m, label: MERGE_LABELS[m] })) } : null,
      { name: 'del', type: 'checkbox', label: `Delete ${pr.branch} on GitHub${local?.kind === 'branch' ? ' and here' : ''}`, value: true },
      sheet.anyway ? { name: 'anyway', type: 'checkbox', label: gate.needsAdmin ? 'Merge anyway, using my admin rights to bypass branch protection' : 'Merge anyway', value: false } : null,
    ].filter(Boolean),
  });
  if (!v) return;
  if (draft) {
    const ready = await prCall('pr-ready', pr, undefined, `Marking #${pr.number} ready for review…`);
    if (ready.error) return prError(`Couldn’t mark #${pr.number} ready`, ready.error);
    const again = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
    if (again.error) return prError(`Couldn’t check #${pr.number}`, again.error);
    if (again.ok.gate.hard && !(await fixMergeGate(pr, again.ok))) return;
  }
  const method = v.method || methods[0];
  const res = await prCall('pr-merge', pr, { method, deleteBranch: v.del, admin: Boolean(v.anyway && gate.needsAdmin) }, `Merging #${pr.number}…`);
  if (res.error) return prError(`Couldn’t merge #${pr.number}`, res.error);
  toast(`Merged #${pr.number}`, { kind: 'success' });
  onDone?.();
  await fetchAll();
  if (!v.del || local?.kind !== 'branch') return;
  const now = state.refs.find((r) => r.kind === 'branch' && r.short === local.short);
  if (!now) return;
  // Only delete what was merged: local commits that never reached the PR stay.
  if (!headOid || now.target !== headOid) return toast(`Kept ${local.short}`, { detail: 'It doesn’t match the merged pull request, so it may hold other work.' });
  if (local.short === state.head.branch) return up.switchAndDelete(now, typeof pr.base === 'string' ? pr.base : null);
  up.deleteBranch(now);
});

const closePr = (given, onDone) => withPr(given, 'Close', async (pr) => {
  const v = await dialog({
    title: `Close #${pr.number} without merging?`,
    description: `${pr.title}\n${REMOTE_NOTE} You can reopen it on GitHub.`,
    submit: 'Close pull request',
    destructive: true,
    fields: [{ name: 'body', label: 'Comment (optional)', multiline: true, rows: 3 }],
  });
  if (!v) return;
  const res = await prCall('pr-close', pr, { body: v.body }, `Closing #${pr.number}…`);
  if (res.error) return prError(`Couldn’t close #${pr.number}`, res.error);
  toast(`Closed #${pr.number}`, { kind: 'success' });
  onDone?.();
  refreshPrs();
});

// Draft ↔ ready for review (AK-610). It happens on GitHub, so there's no Undo: the toast offers
// the opposite switch instead. onDone(draft) re-stages the Review row it came from; without it an
// open Review reloads. The graph badges and the review page update at once.
const toggleDraft = (given, viewer, onDone) => withPr(given, 'Switch draft state of', async (pr) => {
  const d = draftSwitch(pr, prViewer(viewer));
  if (!d) return toast(`#${pr.number} isn’t open`);
  if (d.why) return toast(d.cant, { detail: d.why });
  const res = await prCall(d.channel, pr, undefined, d.busy);
  if (res.error) return prError(d.failed, res.error);
  toast(d.done, { kind: 'success', detail: 'On GitHub: ⌘Z can’t undo it', action: { label: d.back, run: () => toggleDraft({ ...pr, draft: d.draft }, viewer, onDone) } });
  if (state.prs?.data?.prs) { state.prs.data = { ...state.prs.data, prs: withDraft(state.prs.data.prs, pr.number, d.draft) }; showPrs(); }
  if (state.review?.pr?.number === pr.number) { state.review.pr = { ...state.review.pr, draft: d.draft }; reviewPage?.setDraft?.(d.draft); }
  if (onDone) onDone(d.draft);
  else if (lanesPage?.el.isConnected && lanesPage.canReload()) lanesPage.reload();
});

// Update branch (AK-364): bring a PR that isn't checked out here up to date with its base on
// GitHub (`gh pr update-branch`), with a merge commit or a rebase. GitHub refuses when the two
// conflict; then the PR has to be checked out and fixed here.
const updatePrBranch = (given, onDone) => withPr(given, 'Update branch of', async (pr) => {
  const base = pr.base || 'its base';
  const v = await dialog({
    title: `Update #${pr.number} with ${base}?`,
    description: `${pr.title}\n${REMOTE_NOTE}`,
    submit: 'Update branch',
    fields: [{ name: 'how', type: 'select', label: 'How', value: 'merge', options: [{ value: 'merge', label: `Merge ${base} into it` }, { value: 'rebase', label: `Rebase it onto ${base} (rewrites its commits)` }] }],
  });
  if (!v) return;
  const res = await prCall('pr-update-branch', pr, { rebase: v.how === 'rebase' }, `Updating #${pr.number}…`);
  if (res.error) return pr.mergeState === 'dirty' || pr.mergeable === false
    ? toast(`Couldn’t update #${pr.number}`, { kind: 'error', detail: `GitHub can’t update a branch that conflicts with ${base}. Check it out (${keyText('lanes.checkout')}) to fix it here.` })
    : prError(`Couldn’t update #${pr.number}`, res.error);
  toast(`Updated #${pr.number} with ${base}`, { kind: 'success' });
  onDone?.();
  refreshPrs();
});

// The inbox's Ready bucket, squash-merged on GitHub one at a time after one confirmation. Stops
// at the first failure and says what merged. The branches stay; deleting them is up to you.
async function mergeReadyPrs(prs, remote) {
  const ok = await dialog({
    title: `Squash-merge ${prs.length} pull request${prs.length === 1 ? '' : 's'}?`,
    description: h('div.pr-merge', null,
      ...prs.flatMap((p) => [h('div', null, `#${p.number} ${p.title} · ${p.author}`), p.checks === 'failure' ? checkFailEl(prCheckLines(p)) : null]),
      h('div.pr-remote-note', null, `${REMOTE_NOTE} They merge one at a time and stop at the first one that fails.`)),
    submit: `Merge ${prs.length}`,
  });
  if (!ok) return;
  const merged = [];
  for (const pr of prs) {
    const t = toast(`Merging #${pr.number} (${merged.length + 1} of ${prs.length})…`, { kind: 'busy', timeout: 0 });
    const res = await prActionCall((...a) => api.app(...a), 'pr-merge', pr, { method: 'squash', deleteBranch: false, admin: false }, { prs: state.prs, remote });
    t.close();
    if (res.error) {
      prError(`Couldn’t merge #${pr.number}${merged.length ? ` · merged ${merged.map((n) => `#${n}`).join(', ')}` : ''}`, res.error);
      break;
    }
    merged.push(pr.number);
  }
  if (merged.length === prs.length) toast(`Merged ${merged.length} pull request${merged.length === 1 ? '' : 's'}`, { kind: 'success' });
  if (merged.length) { await fetchAll(); lanesPage?.reload(); }
}

function prMenu(e, pr) {
  e.preventDefault();
  const ds = draftSwitch(pr, prViewer());
  contextMenu(e.clientX, e.clientY, [
    { label: 'Go to Branch', icon: 'branch', kbd: keymap.keys('menu.choose'), run: () => goToPr(pr) },
    { label: 'Check Out', icon: 'checkout', kbd: keymap.keys('repo.prCheckout'), run: () => checkoutPr(pr) },
    { label: 'Check Out in New Worktree…', icon: 'worktree', kbd: keymap.keys('repo.prWorktree'), run: () => checkoutPr(pr, { worktree: true }) },
    '-',
    { label: 'Approve…', icon: 'check', disabled: Boolean(approveWhy(pr, prViewer())), why: approveWhy(pr, prViewer()), run: () => approvePr(pr) },
    ...(ds ? [{ label: ds.menu, icon: ds.icon, disabled: Boolean(ds.why), why: ds.why, run: () => toggleDraft(pr) }] : []),
    { label: 'Merge…', icon: 'merge', run: () => mergePr(pr) },
    { label: 'Close…', icon: 'x', danger: true, run: () => closePr(pr) },
    '-',
    { label: 'Open on GitHub', icon: 'external', disabled: !pr.url, run: () => openPrOnGitHub(pr) },
  ]);
}

function submoduleSwitcher() {
  if (!state.repo) return;
  if (!state.submodules.length) return toast('This repository has no submodules');
  palette(() => [
    ...state.submodules.map((m) => ({ group: 'Submodules', label: m.path, icon: 'submodule', detail: SUBMODULE_STATES[m.state][0], keywords: `${m.name} ${m.url}`, run: () => (m.head ? up.openSubmodule(m) : up.updateSubmodules([m])) })),
    { group: 'Submodules', label: 'Update all submodules', icon: 'pull', kbd: keymap.keys('repo.submoduleUpdate'), run: () => up.updateSubmodules() },
  ], { placeholder: 'Open submodule…' });
}

// Other modules assign these through setters: an imported binding can't be assigned.
function setPrStage(value) { return (prStage = value); }

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { indexPrs, prBadge, prFor, refreshPrs, prefetchOnOpen, setupPrs, turnOffPrs });
Object.defineProperties(up, {
  prLoggedOut: { get: () => prLoggedOut, set: (value) => { prLoggedOut = value; }, enumerable: true },
});

export { prViewer, prFor, createPr, checkoutPr, mergeReadyPrs, setupPrs, toggleDraft, prRemote, prError, approvePr, requestChangesPr, mergePr, closePr, openPrOnGitHub, updatePrBranch, REMOTE_NOTE, prCall, OWN_PR, refreshPrs, fixMergeGate, prCheckLines, checkFailEl, prList, pickPrBranch, pickPr, approveTargetWhy, togglePrs, hidePrs, pickPrRemote, submoduleSwitcher, turnOffPrs, setPrRemote, prStage, loadPrs, prefetchOnOpen, setPrStage };
