import { h, toast, ago, confirm, closeMenu, resolveSheet } from './ui.ts';
import { opSentence, divergeSheet, pushIntent, pushAfterContinue, stoppedStepToast, stoppedBranch, SWITCHES } from '../commit/resolve-text.js';
import { blockedByChanges } from '../commit/autostash.js';
import { GIT_NEEDS, GIT_FEATURES, gitMeets } from './git-version.ts';
import { up } from './upcalls.ts';
import { api, state } from './app-helpers.ts';
import { bannerEl } from '../shell/shell.js';

// Git bridge

async function git(method, ...args) {
  const r = await api.git(method, ...args);
  if (r.error) { const e = new Error(r.error.message); e.stderr = r.error.stderr; e.code = r.error.code; e.moved = r.error.moved; throw e; }
  return r.ok;
}

// Ref mutations git can refuse over uncommitted changes; act() then offers to stash and retry (stashAnd).
const STASH_AND = new Set(['merge', 'pull', 'pullAndPush', 'cherryPick', 'revert', 'setBranchTip']);

// Git refuses these while a rebase, merge, cherry-pick or revert is stopped here; act() then offers
// to continue it (or open its conflicts), or abort it and go on (abortAnd).
const OP_BLOCKED = new Set(['merge', 'pull', 'pullAndPush', 'cherryPick', 'revert', 'rebaseOnto', 'rebaseBranch']);

async function act(label, method, args = [], opts = {}) {
  const { busy, success, detail, undoable = true, quiet = false, then, actions } = opts;
  closeMenu();
  closeStickyToast();
  if (state.opState && (OP_BLOCKED.has(method) || (method === 'mergeLane' && args[1] === state.head?.branch && !args[3]?.abort))) return resolveOp(label, method, args, opts);
  if (state.opState && SWITCHES.has(method)) return resolveOp(label, method, args, { ...opts, after: () => act(label, method, args, opts) });
  const t = busy ? toast(busy, { kind: 'busy', timeout: 0 }) : null;
  try {
    const res = await git(method, ...args, { __label: label });
    t?.close();
    // A continued "Rebase and push" offers the push instead of the generic toast.
    const offer = method === 'continueOp' && pendingPush;
    const done = () => {
      if (quiet) return;
      const undoBtn = undoable ? { label: 'Undo', run: undo } : null;
      // A toast with a choice stays until it's dismissed or used.
      toast(success || label, actions?.length ? { kind: 'success', detail, timeout: 0, actions: [undoBtn, ...actions].filter(Boolean) } : { kind: 'success', detail, action: undoBtn });
    };
    if (!offer) done();
    await up.refreshAll();
    if (offer && !offerPushAfterContinue()) done();
    if (!state.opState) pendingPush = null;
    await then?.(res);
    return true;
  } catch (e) {
    t?.close();
    // An old git refused `stash push --staged`: Update git, then stash.
    if (method === 'stashSave' && args[2]?.staged && 'git-version' === e.code) return updateGit('stashStaged', () => act(label, method, args, opts));
    const fixed = await offerFix(label, method, args, opts, e);
    if (fixed !== undefined) return fixed;
    if (STASH_AND.has(method) && blockedByChanges(`${e.stderr || ''}\n${e.message}`)) {
      const v = await resolveSheet({ title: label, reason: 'Uncommitted changes are in the way.', actions: [{ id: 'stash', label: `Stash and ${label.split(' ')[0].toLowerCase()}` }] });
      if (v) return act(label, 'stashAnd', [method, args], { busy, success: `Stashed changes · ${success || label}`, detail, undoable, quiet, then });
    } else {
      await up.refreshAll();
      // Stopped on conflicts (rebase, merge, cherry-pick, continue): point at them, not at git's output.
      const n = state.opState ? state.status.conflicts.length : 0;
      if (state.opState) rememberPush(method, args);
      const skip = method === 'cherryPick' && state.opState === 'cherry-pick' ? { label: 'Skip', run: () => act('Skip cherry-pick', 'abortOp', [], { success: 'Skipped cherry-pick', undoable: false }) } : null;
      if (n) toast(`${label} stopped on ${n} conflict${n > 1 ? 's' : ''}`, skip
        ? { timeout: 0, actions: [{ label: 'Open conflicts', primary: true, run: up.openConflicts }, skip] }
        : { action: { label: 'Open conflicts', run: up.openConflicts } });
      else toast(`${label} failed`, { kind: 'error', detail: e.message });
      return false;
    }
    await up.refreshAll();
    return false;
  }
}
const gitTooOld = (feature) => Boolean(state.gitInfo && !gitMeets(state.gitInfo.version, GIT_NEEDS[feature]));
const gitWhy = (feature) => (gitTooOld(feature) ? `Needs git ${GIT_NEEDS[feature]}` : null);
// The Update git sheet: the git in use and Use another git…; `then` carries on once the git is new enough.
async function updateGit(feature, then) {
  const need = GIT_NEEDS[feature];
  const cur = await api.app('git-info').catch(() => null);
  if (cur?.ok) state.gitInfo = cur.ok;
  const info = state.gitInfo;
  // Nothing to confirm (AK-598): say what's missing, offer the fix on the toast.
  toast(`${GIT_FEATURES[feature]} needs git ${need} or later`, {
    kind: 'warn',
    detail: info ? `In use: git ${info.version}` : 'No git found.',
    actions: [{ label: 'Choose git…', run: async () => {
      const res = await api.app('git-choose');
      if (res.error) return toast('Can’t use that git', { kind: 'error', detail: res.error.message });
      if (!res.ok) return;
      if (need && !gitMeets(res.ok.version, need)) return updateGit(feature, then);
      return useGit('chosen', then);
    } }],
  });
  return false;
}
// ⌘K Choose git… / Use system git: no feature to gate on, any git that runs will do.
const chooseGit = async () => {
  const res = await api.app('git-choose');
  if (res.error) return toast('Can’t use that git', { kind: 'error', detail: res.error.message });
  if (res.ok) return useGit('chosen');
};
async function useGit(which, then) {
  const res = await api.app('git-use', which);
  if (res.error) return toast('Can’t use that git', { kind: 'error', detail: res.error.message });
  state.gitInfo = res.ok;
  toast(`Using git ${res.ok.version}`, { detail: res.ok.path });
  return then?.();
}

// A push, pull or cherry-pick git refused for a cause we know: offer the fix together with the
// action, as one undo step. undefined: not one of those, act() reports it as before.
// Pull and Push decide in a panel above their sidebar buttons (AK-598); force push asks once more
// inside it, since it can't be undone.
const syncButton = (name) => document.querySelector(`.sb-action[aria-label="${name}"]`);
const forcePush = (d) => ({ id: 'force', label: 'Force push…', danger: true, primary: false, confirm: { note: d?.theirsCount ? `Drops ${d.theirsCount} commit${d.theirsCount === 1 ? '' : 's'} on ${d.upstream.split('/')[0]}.` : 'Drops the commits only on the remote.', label: 'Force push' } });
async function offerFix(label, method, args, opts, err) {
  const branch = state.head?.branch || '';
  if (err.code === 'rejected' && method === 'push' && !args[0]?.force && !args[0]?.all) {
    const d = await git('divergence', true).catch(() => null);
    const sheet = d ? divergeSheet(d, { push: true, age: ago }) : {
      reason: `The remote has commits ${branch} doesn’t have.`,
      actions: [{ id: 'rebase', label: 'Rebase and push' }, { id: 'merge', label: 'Merge and push' }],
    };
    const v = await resolveSheet({ title: `Push ${branch}`, ...sheet, actions: [...sheet.actions.filter((a) => a.id !== 'force'), forcePush(d)], anchor: syncButton('Push') });
    if (!v) return false;
    if (v.id === 'force') return up.push(true);
    return act(`Pull and push ${branch}`, 'pullAndPush', [v.id], { busy: `Pulling and pushing ${branch}…`, success: `Pulled and pushed ${branch}` });
  }
  if (err.code === 'diverged' && (method === 'pull' || method === 'pullAndPush') && !args[0]) {
    const d = await git('divergence').catch(() => null);
    const v = await resolveSheet({ ...(d ? { title: label, ...divergeSheet(d, { age: ago }) } : { title: label, reason: `${branch} and its upstream have both moved.`, actions: [{ id: 'rebase', label: 'Rebase' }, { id: 'merge', label: 'Merge' }] }), anchor: syncButton('Pull') });
    return v ? act(label, method, [v.id], opts) : false;
  }
  if (err.code === 'empty-pick' && method === 'cherryPick' && !args[1]) {
    // Nothing to do is the obvious outcome (AK-598): say so, offer the rare alternative.
    const c = await up.loadCommit(args[0]).catch(() => null);
    toast(`Already on ${branch || 'this branch'}`, { detail: `${args[0].slice(0, 7)}${c?.subject ? ` ${c.subject}` : ''}. Nothing to cherry-pick.`, actions: [{ label: 'Commit anyway', run: () => act(label, method, [args[0], true], opts) }] });
    return false;
  }
}

// `label` is blocked by the operation stopped here: continue it (then offer `label` again), open its
// conflicts, or abort it and run `label`, as one undo step.
// "Abort rebase and merge", but "Abort and merge" when the stopped op is a merge too.
const abortAnd = (op, verb) => (op === verb ? `Abort and ${verb}` : `Abort ${op} and ${verb}`);
// After abortAnd: when resolved files were saved, say so and offer them back until the next action.
async function aborted(label, res, opts) {
  const { op, saved } = res || {};
  if (saved && op && !saved.sha) {
    toast(`Aborted the ${op}`, { kind: 'success', detail: `${saved.unchanged} resolved file${saved.unchanged > 1 ? 's match' : ' matches'} HEAD. Nothing to save.` });
  } else if (saved && op) {
    const n = saved.paths.length;
    toast(`Aborted the ${op}`, {
      kind: 'success', detail: `${n} resolved file${n > 1 ? 's' : ''} saved.`, timeout: 0,
      actions: [{ label: 'Restore', primary: true, run: () => act('Restore resolved files', 'restoreResolved', [saved.sha], { success: `Restored ${n} resolved file${n > 1 ? 's' : ''}` }) }, opts.undoable !== false && { label: 'Undo', run: undo }].filter(Boolean),
    });
  } else if (!opts.quiet) {
    toast(opts.success || label, { kind: 'success', action: opts.undoable === false ? null : { label: 'Undo', run: undo } });
  }
  await opts.then?.(res?.result);
}

async function resolveOp(label, method, args, opts) {
  const op = state.opState;
  const n = state.status.conflicts.length;
  const verb = label.split(' ')[0];
  // The banner already says what's stopped (AK-598): point at it and offer the next step. Aborting
  // can't be undone, so it confirms.
  const banner = document.querySelector('.banner-slot .banner');
  if (banner) { banner.classList.remove('flash'); void banner.offsetWidth; banner.classList.add('flash'); setTimeout(() => banner.classList.remove('flash'), 2000); }
  const why = opSentence(state.opInfo, n);
  const abortLabel = abortAnd(op, verb.toLowerCase());
  const abort = async () => {
    if (!(await confirm(`${abortLabel}?`, why, { submit: abortLabel }))) return false;
    // A switch runs its own way after the abort (in use elsewhere, changes in the way).
    if (opts.after) return abortThen(op, opts.after);
    return method === 'mergeLane'
      ? act(label, method, [...args.slice(0, 3), { abort: true }], { ...opts, then: async (res) => {
        if (res?.saved) await aborted(label, res, { quiet: true });
        await opts.then?.(res);
      } })
      : act(label, 'abortAnd', [method, args], { ...opts, quiet: true, then: (res) => aborted(label, res, opts) });
  };
  toast(`${label} is waiting`, { kind: 'warn', detail: why, actions: [
    n ? { label: 'Open conflicts', run: up.openConflicts } : { label: `Continue ${op}`, run: () => continueThen(label, method, args, opts) },
    { label: `${abortLabel}…`, run: abort },
  ] });
  return false;
}
async function continueThen(label, method, args, opts) {
  const op = state.opState;
  const verb = label.split(' ')[0];
  const ok = await act(`Continue ${op}`, 'continueOp', [], { quiet: true });
  const next = opts.after || (() => act(label, method, args, opts));
  if (ok && !state.opState && !stickyToast) toast(`Continued ${op}`, { kind: 'success', detail: `${label} is next.`, timeout: 0, actions: [{ label: `${verb} now`, primary: true, run: next }, { label: 'Undo', run: undo }] });
  return false;
}

// "Rebase and push" stopped on conflicts: once the operation is continued to the end, offer the push
// it was on the way to. The toast stays until the next action (so does the one for ⌘Z while stopped).
let pendingPush = null, stickyToast = null;
function rememberPush(method, args) {
  const branch = stoppedBranch(state.head, state.opInfo);
  const upstream = state.refs.find((r) => r.kind === 'branch' && r.short === branch)?.upstream;
  const intent = pushIntent(method, args, branch, upstream);
  if (intent) pendingPush = { ...intent, root: state.repo?.root };
}
function closeStickyToast() { stickyToast?.close(); stickyToast = null; }
function offerPushAfterContinue() {
  if (pendingPush && pendingPush.root !== state.repo?.root) pendingPush = null;
  const t = pushAfterContinue(pendingPush, { opState: state.opState, branch: state.head?.branch });
  if (!state.opState) pendingPush = null;
  if (!t) return false;
  stickyToast = toast(t.message, { kind: 'success', timeout: 0, actions: [{ label: t.push, primary: true, run: () => up.push() }, { label: 'Undo', run: undo }] });
  return true;
}

// ⌘Z / ⇧⌘Z while a rebase, merge, cherry-pick or revert is stopped: flash its banner and say so, with
// its conflicts or aborting it (confirmed: can't be undone) and then taking the step. true: handled here.
function flashBanner() {
  const b = bannerEl?.querySelector('.banner');
  if (!b) return;
  b.classList.remove('flash');
  void b.offsetWidth;
  b.classList.add('flash');
}
function stepWhileStopped(dir) {
  const op = state.opState;
  if (!op) return false;
  flashBanner();
  const t = stoppedStepToast(dir, op, state.opInfo, state.status.conflicts.length);
  const run = { open: up.openConflicts, continue: () => act(`Continue ${op}`, 'continueOp'), abort: () => abortThenStep(dir, op) };
  stickyToast = toast(t.message, { kind: 'info', detail: t.detail, timeout: 0, actions: t.actions.map((a, i) => ({ label: a.label, primary: i === 0, run: run[a.id] })) });
  return true;
}
async function abortThenStep(dir, op) {
  if (!(await confirm(`Abort ${op}?`, "Aborting can't be undone.", { submit: 'Abort' }))) return;
  await abortThen(op, dir === 'undo' ? undo : redo);
}
// Abort the operation stopped here, then run `step`. Resolved files it saved are offered back, as after abortAnd.
async function abortThen(op, step) {
  let res;
  try { res = await git('abortOp'); } catch (e) {
    toast(`Abort ${op} failed`, { kind: 'error', detail: e.message });
    await up.refreshAll();
    return false;
  }
  pendingPush = null;
  await up.refreshAll();
  const ok = await step();
  if (res?.saved) await aborted(`Abort ${op}`, res, { quiet: true, undoable: false });
  return ok;
}

async function quiet(method, ...args) {
  try { await git(method, ...args); } catch (e) { toast('Git error', { kind: 'error', detail: e.message }); }
  await up.refreshStatus();
}

// `opts.stash`: stash what's in the way first (offerStashStep); `opts.discard`: discard it instead,
// kept on the step so the opposite step brings it back. `opts.force`: take the step though
// branches moved since (offerMovedStep). Click handlers pass an event here.
const stepOpts = (o) => (o?.stash || o?.force || o?.skip || o?.discard ? Object.fromEntries(['stash', 'force', 'skip', 'discard'].filter((k) => o[k]).map((k) => [k, true])) : null);
async function undo(opts) {
  opts = stepOpts(opts);
  closeStickyToast();
  if (!opts && stepWhileStopped('undo')) return;
  try {
    const label = await git('undo', ...(opts ? [opts] : []));
    if (opts?.skip) toast(`Skipped “${label}”`);
    else toast(label ? `Undid “${label}”` : 'Nothing to undo', { action: label ? { label: 'Redo', run: redo } : null });
  } catch (e) {
    if (await offerSkipStep('undo', e)) return;
    if (!opts?.force && await offerMovedStep('undo', e, opts)) return;
    if (!opts?.stash && !opts?.discard && await offerStashStep('undo', e, opts)) return;
    toast('Undo failed', { kind: 'error', detail: e.message });
  }
  await up.refreshAll();
}

// Undo or redo refused over uncommitted changes: offer to stash them and try again.
async function offerStashStep(dir, err, opts) {
  const { code } = err;
  if (code !== 'dirty' && code !== 'dirty-submodule') return false;
  // A safe default (AK-598): keep the newer edit in a stash and take the step; the toast offers
  // discarding it instead.
  const what = /: (.+) changed since\.$/.exec(err.message)?.[1];
  try {
    const label = await git(dir, { ...opts, stash: true });
    const message = `Set aside to ${dir} “${label}”`;
    const many = what && /,| and /.test(what);
    const dropIt = { label: 'Discard it instead', run: async () => {
      const s = (await git('stashes').catch(() => [])).find((x) => x.message.endsWith(message));
      if (s) act(`Drop ${s.ref} (${s.message})`, 'stashDrop', [s.ref], { success: what ? `Discarded your newer edit${many ? 's' : ''} to ${what}` : 'Discarded your newer edit' });
    } };
    const other = { label: dir === 'undo' ? 'Redo' : 'Undo', run: dir === 'undo' ? redo : undo };
    toast(`${dir === 'undo' ? 'Undid' : 'Redid'} “${label}”`, {
      kind: 'success',
      detail: code === 'dirty-submodule' ? 'The newer changes in the submodule are stashed there.' : what ? `Your newer edit${many ? 's' : ''} to ${what} ${many ? 'are' : 'is'} stashed.` : 'Your newer edit is stashed.',
      actions: code === 'dirty' ? [dropIt, up.showStashAction(message), other] : [other],
    });
  } catch (e) {
    // Branches moved since too: the moved-since sheet still asks (keeping the stash step).
    if (await offerSkipStep(dir, e) || await offerMovedStep(dir, e, { ...opts, stash: true })) return true;
    toast(`${dir === 'undo' ? 'Undo' : 'Redo'} failed`, { kind: 'error', detail: e.message });
  }
  await up.refreshAll();
  return true;
}

// The step's stash was applied or dropped since: it can never be taken, so offer to drop it.
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
async function offerSkipStep(dir, err) {
  if (err.code !== 'stash-gone') return false;
  const title = dir === 'undo' ? undoTitle() : redoTitle();
  const step = err.step;
  const rows = step ? [
    ['stash', [step.stash.message, h('span.muted', null, ` · saved ${clock(step.stash.time || step.time)}`)]],
    ['step', `${step.label} · ${clock(step.time)}`],
  ] : null;
  const v = await resolveSheet({ title, reason: 'The stash this step made was applied or dropped outside Since.', rows, actions: [{ id: 'skip', label: 'Skip this step' }] });
  if (!v) return false;
  await (dir === 'undo' ? undo : redo)({ skip: true });
  return true;
}

// Undo or redo refused because branches or HEAD moved since: list what moved and offer to take
// the step anyway (the opposite step puts the moved refs back).
const MOVED_ROWS = 4;
async function offerMovedStep(dir, err, opts) {
  if (err.code !== 'moved' || !err.moved?.length) return false;
  const title = dir === 'undo' ? undoTitle() : redoTitle();
  const side = (v) => v ?? 'none';
  const rows = err.moved.slice(0, MOVED_ROWS).map((m) => [m.ref, `${side(m.from)} → ${side(m.to)}`]);
  if (err.moved.length > MOVED_ROWS) rows.push([`${err.moved.length - MOVED_ROWS} more`, '']);
  const v = await resolveSheet({ title, reason: 'Branches or HEAD have moved since.', rows, actions: [{ id: 'force', label: dir === 'undo' ? 'Undo anyway' : 'Redo anyway' }] });
  if (!v) return false;
  await (dir === 'undo' ? undo : redo)({ ...opts, force: true });
  return true;
}
// "Undo Discard 3 lines in app.js" style labels for the next undo/redo step.
const undoTitle = () => { const e = state.history.undo.at(-1); return e ? `Undo ${e.label}` : 'Undo'; };
const redoTitle = () => { const e = state.history.redo.at(-1); return e ? `Redo ${e.label}` : 'Redo'; };

async function redo(opts) {
  opts = stepOpts(opts);
  closeStickyToast();
  if (!opts && stepWhileStopped('redo')) return;
  try {
    const label = await git('redo', ...(opts ? [opts] : []));
    toast(opts?.skip ? `Skipped “${label}”` : label ? `Redid “${label}”` : 'Nothing to redo');
  } catch (e) {
    if (await offerSkipStep('redo', e)) return;
    if (!opts?.force && await offerMovedStep('redo', e, opts)) return;
    if (!opts?.stash && !opts?.discard && await offerStashStep('redo', e, opts)) return;
    toast('Redo failed', { kind: 'error', detail: e.message });
  }
  await up.refreshAll();
}

// Run at most one instance of fn at a time; calls made meanwhile collapse into one rerun.
function coalesce(fn) {
  let running = null, again = false;
  const wrapped = async () => {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await fn(); } while (again);
    })().finally(() => { running = null; });
    return running;
  };
  return wrapped;
}

export { coalesce, git, undoTitle, undo, redoTitle, redo, act, aborted, resolveOp, quiet, gitTooOld, gitWhy, updateGit, abortAnd, chooseGit, useGit };
