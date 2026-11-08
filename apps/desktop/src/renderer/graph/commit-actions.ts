import { h, icon, kbd, toast, dialog, confirm, prompt, contextMenu, closeMenu, resolveSheet, ref } from '../lib/ui.ts';
import { renderDiff } from '../commit/diff.ts';
import { checkoutPlan, inUsePlan } from './checkout-plan.ts';
import * as keymap from '../palette/keymap.ts';
import { authorProfile } from '../lib/profile.ts';
import { AUTOSTASH_DEFAULT, blockedCheckout, stashMessage, autostashPlan, returnOffer, stashRefBySha } from '../commit/autostash.ts';
import { commitBlock } from './commit-guards.ts';
import { up } from '../lib/upcalls.ts';
import { state, MOD, api, loadPref, savePref } from '../lib/app-helpers.ts';
import { stashFocus, setStashFocus, contentEl } from '../shell/shell.ts';
import { act, resolveOp, git, undo } from '../lib/bridge.ts';
import { worktreeOf, refreshAll } from './load.ts';
import { openSplit } from '../commit/split.ts';
import { openQuick } from './quick-view.ts';
import { prFor, createPr } from '../prs/prs-page.js';
import { loadCommit } from './map.ts';
import type { MenuEntry, MenuItem } from '../lib/ui.ts';
import type { GuardCommit } from './commit-guards.ts';
import type { ReturnOffer } from '../commit/autostash.ts';
import type { Ref, Worktree } from '../../shared/git-types.ts';

/** A commit the map acts on: a graph row or a commit's details. */
type MapCommit = GuardCommit & { email?: string | null };
type RewriteOp = 'reword' | 'squash' | 'fixup' | 'swapParent' | 'split' | 'drop';
type WorktreeEntry = Worktree & { elsewhere?: boolean };
/** What to stash before a switch. */
interface StashSpec { message: string; untracked: boolean }
/** A menu item in a group; `inline` is its label when it stands alone (menuGroup). */
type GroupItem = MenuItem & { inline?: string };
type ItemProps = Omit<GroupItem, 'label'>;

// Commit actions (map actions)

const branchesAt = (sha: string) => state.refs.filter((r) => r.kind === 'branch' && r.target === sha);

function commitShortcut(e: KeyboardEvent, id: string, c: MapCommit) {
  const run = ({
    'commit.branch': () => createBranch(c.sha), 'commit.tag': () => createTag(c.sha), 'commit.merge': () => mergeCommit(c),
    'commit.rebase': () => rebaseOnto(c), 'commit.cherryPick': () => cherryPick(c), 'commit.revert': () => revertCommit(c),
    'commit.edit': () => rewriteVia(c, 'reword', (b) => editMessage(c, b)), 'commit.squash': () => rewriteVia(c, 'squash', (b) => rewriteOp('squash', c, b)),
    'commit.fixup': () => rewriteVia(c, 'fixup', (b) => rewriteOp('fixup', c, b)), 'commit.drop': () => rewriteVia(c, 'drop', (b) => rewriteOp('drop', c, b)),
    'commit.checkout': () => checkoutCommit(c), 'commit.diffHead': () => diffWithHead(c),
    'commit.worktree': () => up.addWorktree({ base: c.sha }), 'commit.split': () => rewriteVia(c, 'split', (b) => openSplit(c, b)), 'commit.author': () => up.openAuthor(c),
  } as Record<string, () => unknown>)[id];
  if (!run) return;
  e.preventDefault();
  guarded(id, c, run);
}

// Loaded graph commits by sha, for commitBlock (a new lookup per menu: its answers are cached per lookup).
const graphCommits = () => (sha: string | null | undefined) => { const i = sha == null ? undefined : state.index.get(sha); return i == null ? undefined : state.commits[i]; };
// Runs a map action, or toasts why it can't run on this commit (the menu greys the same cases).
function guarded(id: string, c: MapCommit, run: () => unknown) {
  const why = commitBlock(id, c, state.head.oid, graphCommits());
  if (why) toast(why);
  else run();
}

async function commitMenu(x: number, y: number, c: MapCommit) {
  // Not on this branch: each rewrite switches to a local branch containing it first (AK-581).
  const targets = await rewriteTargets(c);
  const locals = branchesAt(c.sha);
  const isHead = c.sha === state.head.oid;
  const curBranch = state.head.branch;
  const remote = up.originRemote();
  // Greyed with the reason under the label (AK-582).
  const get = graphCommits();
  const off = (id: string) => { const why = commitBlock(id, c, state.head.oid, get); return { disabled: !!why, why }; };
  contextMenu(x, y, [
    { label: 'Quick View', icon: 'eye', kbd: keymap.keys('map.quick'), run: () => openQuick(c.sha) },
    { label: 'Diff with HEAD', icon: 'diff', kbd: keymap.keys('commit.diffHead'), ...off('commit.diffHead'), run: () => diffWithHead(c) },
    '-',
    ...menuGroup('Checkout', 'checkout', locals.length
      ? locals.map((b): GroupItem => { const wt = worktreeOf(b.short); return (wt
        ? { label: `Switch to Worktree “${wt.name}”`, icon: 'worktree', run: () => up.switchWorktree(wt) }
        : { label: `Checkout “${b.short}”`, icon: 'checkout', kbd: !isHead && b === locals.find((x) => x.short !== state.head.branch) ? [MOD, '↵'] : null, disabled: b.short === state.head.branch, why: b.short === state.head.branch ? 'Current branch' : null, run: () => checkout(b.short) }); })
      : [{ label: 'Checkout (detached)', icon: 'checkout', kbd: keymap.keys('commit.checkout'), disabled: isHead && state.head.detached, why: isHead && state.head.detached ? 'Checked out' : null, run: () => checkoutCommit(c) }]),
    ...menuGroup('Create', 'plus', [
      { label: 'Branch…', inline: 'Create Branch…', icon: 'branch', kbd: keymap.keys('commit.branch'), run: () => createBranch(c.sha) },
      { label: 'Tag…', inline: 'Create Tag…', icon: 'tag', kbd: keymap.keys('commit.tag'), run: () => createTag(c.sha) },
      { label: 'Worktree…', inline: 'New Worktree Here…', icon: 'worktree', kbd: keymap.keys('commit.worktree'), run: () => up.addWorktree({ base: c.sha }) },
    ]),
    ...menuGroup('Branch', 'branch', [
      curBranch && !isHead ? { label: 'Move Current Branch Here', icon: 'swap', run: () => setTip(curBranch, c) } : null,
      ...locals.map((b) => deleteBranchItem(b)),
    ]),
    '-',
    ...menuGroup(state.head.branch ? 'Current Branch' : 'HEAD', 'merge', [
      { label: 'Merge', icon: 'merge', kbd: keymap.keys('commit.merge'), ...off('commit.merge'), run: () => mergeCommit(c) },
      { label: 'Rebase onto This', icon: 'rebase', kbd: keymap.keys('commit.rebase'), ...off('commit.rebase'), run: () => rebaseOnto(c) },
      { label: 'Cherry-pick', icon: 'cherry', kbd: keymap.keys('commit.cherryPick'), ...off('commit.cherryPick'), run: () => cherryPick(c) },
      { label: 'Revert', icon: 'revert', kbd: keymap.keys('commit.revert'), run: () => revertCommit(c) },
    ]),
    ...menuGroup('Rewrite', 'edit', [
      rewriteItem(targets, 'reword', 'Edit Message…', { icon: 'edit', kbd: keymap.keys('commit.edit'), ...off('commit.edit') }, (b) => editMessage(c, b)),
      rewriteItem(targets, 'squash', 'Squash into Parent', { icon: 'squash', kbd: keymap.keys('commit.squash'), ...off('commit.squash') }, (b) => rewriteOp('squash', c, b)),
      rewriteItem(targets, 'fixup', 'Fixup into Parent', { icon: 'squash', kbd: keymap.keys('commit.fixup'), ...off('commit.fixup') }, (b) => rewriteOp('fixup', c, b)),
      rewriteItem(targets, 'swapParent', 'Swap with Parent', { icon: 'swap', ...off('swapParent') }, (b) => rewriteOp('swapParent', c, b)),
      rewriteItem(targets, 'split', 'Split…', { icon: 'split', kbd: keymap.keys('commit.split'), ...off('commit.split') }, (b) => openSplit(c, b)),
      '-',
      rewriteItem(targets, 'drop', 'Delete', { icon: 'trash', kbd: keymap.keys('commit.drop'), danger: true, ...off('commit.drop') }, (b) => rewriteOp('drop', c, b)),
    ]),
    '-',
    ...menuGroup('Copy', 'copy', [
      { label: 'SHA', icon: 'copy', kbd: keymap.keys('map.copySha'), run: () => copy(c.sha, 'Copied SHA') },
      remote?.web ? { label: 'Link', icon: 'copy', kbd: keymap.keys('map.copyLink'), run: () => up.copyCommitLink(c.sha) } : null,
      { label: 'Message', icon: 'copy', run: async () => copy((await loadCommit(c.sha)).message, 'Copied message') },
    ]),
    ...menuGroup('Open in Browser', 'external', [
      authorProfile(c.email ?? '', remote?.web) ? { label: 'Author', inline: 'View Author on GitHub', icon: 'external', kbd: keymap.keys('commit.author'), run: () => up.openAuthor(c) } : null,
      remote?.web ? { label: 'Commit', inline: 'View on Hosting Service', icon: 'external', run: () => api.app('external', `${remote.web}/commit/${c.sha}`) } : null,
    ]),
  ]);
}

// A submenu row for a group of menu items (AK-629): nothing when the group is empty, the item
// itself (under its `inline` label, when the short one needs the group's context) when there's only one.
function menuGroup(label: string, icon: string, items: (GroupItem | '-' | null | false | undefined)[]): MenuEntry[] {
  const real = items.filter((it): it is GroupItem => Boolean(it) && typeof it === 'object');
  const one = real[0];
  if (!one) return [];
  if (real.length === 1) return [{ ...one, label: one.inline || one.label }];
  return [{ label, icon, submenu: items }];
}

// Delete a branch label: the one checked out here through the switch-and-delete sheet.
function deleteBranchItem(r: Ref): GroupItem {
  const cur = r.short === state.head.branch;
  const why = cur ? (canSwitchFrom(r.short) ? null : 'Only branch') : worktreeOf(r.short) ? 'In another worktree' : null;
  return { label: cur && !why ? `Switch to ${switchTarget(r.short)} & Delete “${r.short}”` : `Delete Branch “${r.short}”`, icon: 'trash', danger: true, disabled: Boolean(why), why, run: () => (cur ? switchAndDelete(r) : deleteBranch(r)) };
}

function refMenu(x: number, y: number, r: Ref) {
  const items: MenuEntry[] = [];
  if (r.kind === 'branch') {
    const cur = r.short === state.head.branch;
    const wt = worktreeOf(r.short);
    const only = cur && !switchTargets(r.short).length;
    items.push(
      wt ? { label: `Switch to Worktree “${wt.name}”`, icon: 'worktree', run: () => up.switchWorktree(wt) } : { label: 'Checkout', icon: 'checkout', disabled: cur, run: () => checkout(r.short) },
      !wt && !cur ? { label: 'Open in New Worktree…', icon: 'worktree', run: () => up.addWorktree({ branch: r.short }) } : null,
      { label: `Merge into ${state.head.branch || 'HEAD'}`, icon: 'merge', disabled: cur, run: () => act(`Merge ${r.short}`, 'merge', [r.short]) },
      { label: `Rebase ${state.head.branch || 'HEAD'} onto ${r.short}`, icon: 'rebase', disabled: cur, run: () => act(`Rebase onto ${r.short}`, 'rebaseOnto', [r.short]) },
      '-',
      state.prs?.active && !prFor(r) ? { label: 'New Pull Request…', icon: 'plus', kbd: cur ? [MOD, '⌥', '⇧', 'N'] : null, run: () => createPr(r.short) } : null,
      state.prs?.active && !prFor(r) ? '-' : null,
      { label: 'Rename…', icon: 'edit', run: () => renameBranch(r) },
      { label: 'Copy Name', icon: 'copy', run: () => copy(r.short, 'Copied branch name') },
      '-',
      { label: cur && !only ? `Switch to ${switchTarget(r.short)} & Delete` : 'Delete Branch', icon: 'trash', danger: true, disabled: only, why: only ? 'Only branch' : null, run: () => (cur ? switchAndDelete(r) : deleteBranch(r)) },
    );
  } else if (r.kind === 'remote') {
    items.push(
      { label: 'Checkout as Local Branch', icon: 'checkout', run: () => act(`Checkout ${r.short}`, 'checkoutTracking', [r.short]) },
      { label: 'Open in New Worktree…', icon: 'worktree', run: () => up.addWorktree({ base: r.short, branch: r.short.slice(r.short.indexOf('/') + 1) }) },
      { label: `Merge into ${state.head.branch || 'HEAD'}`, icon: 'merge', run: () => act(`Merge ${r.short}`, 'merge', [r.short]) },
      { label: 'Copy Name', icon: 'copy', run: () => copy(r.short, 'Copied') },
      '-',
      { label: 'Delete Remote Branch…', icon: 'trash', danger: true, run: async () => { if (await confirm(`Delete ${r.short} on the remote?`, 'This pushes a deletion to the remote and cannot be undone from here.', { submit: 'Delete' })) act(`Delete ${r.short}`, 'deleteRemoteBranch', [r.short], { busy: 'Deleting remote branch…', undoable: false }); } },
    );
  } else if (r.kind === 'tag') {
    items.push(
      { label: 'Copy Name', icon: 'copy', run: () => copy(r.short, 'Copied') },
      { label: 'Push All Tags', icon: 'push', run: () => act('Push tags', 'pushTags', [], { busy: 'Pushing tags…', undoable: false }) },
      '-',
      { label: 'Delete Tag', icon: 'trash', danger: true, run: () => act(`Delete tag ${r.short}`, 'deleteTag', [r.short]) },
    );
  }
  contextMenu(x, y, items);
}

async function copy(text: string, msg: string) { await api.app('copy', text); toast(msg); }

async function checkout(branch: string): Promise<unknown> {
  const wt = worktreeOf(branch);
  const label = `Checkout ${branch}`;
  closeMenu();
  if (state.opState) return resolveOp(label, 'checkout', [branch], { after: () => checkout(branch) });
  if (wt) {
    const v = await inUseSheet(branch, wt);
    if (v?.id === 'free') return freeCheckout(label, branch, wt);
    if (v?.id === 'move') return moveCheckout(label, branch, wt, v.stash);
    return false;
  }
  try {
    await git('checkout', branch, { __label: label });
  } catch (e) {
    // Only when local changes are in the way: offer to stash them and switch.
    const err = e as Error & { stderr?: string };
    const blocked = blockedCheckout(`${err.stderr || ''}\n${err.message}`);
    if (blocked) return autostashCheckout(branch, blocked);
    toast(`${label} failed`, { kind: 'error', detail: err.message });
    await refreshAll();
    return false;
  }
  toast(`Switched to ${branch}`, { kind: 'success', action: { label: 'Undo', run: undo } });
  await refreshAll();
  offerAutostash(branch);
  return true;
}

// `branch` is checked out in worktree `wt`: offer to free it there (HEAD detached) and check it
// out here, bringing its uncommitted changes along, or to open that worktree. Resolves to
// { id: 'free' }, { id: 'move', stash } (this window's changes to stash first, or null) or null.
async function inUseSheet(branch: string, wt: WorktreeEntry): Promise<{ id: 'free' } | { id: 'move'; stash: StashSpec | null } | null> {
  const hold = wt.missing ? { blocker: 'Its folder no longer exists.' } : await git('worktreeHold', wt.path).catch((e: Error) => ({ blocker: e.message }));
  const { untracked } = loadPref('autostash', AUTOSTASH_DEFAULT);
  const mine = switchChanges();
  const p = inUsePlan(wt, hold, mine);
  // Clean: nothing is lost and it's undoable, so it just happens (AK-598).
  if (p.kind === 'clean') return { id: 'free' };
  const status = p.kind === 'dirty' ? p.changes : wt.missing ? 'missing' : p.why;
  const v = await resolveSheet({
    anchor: document.querySelector('.branch-chip'),
    title: ['Check out ', ref(branch)],
    reason: ['In use by ', h('span.sheet-strong', null, wt.name), '.'],
    rows: [
      [[wt.name, h('span.sheet-row-path', null, p.where)], h(status === 'clean' ? 'span' : 'span.warn', null, status)],
      ...(p.kind === 'dirty' && p.changed ? [[h('span.muted', null, p.changed), ''] as const] : []),
    ],
    checkbox: p.kind === 'dirty' && p.stash ? { label: p.stash, checked: true } : null,
    actions: p.actions.map((id) => (id === 'move' ? { id, label: 'Move changes & check out' } : { id, label: 'Open that worktree' })),
  });
  if (v?.id === 'open') wt.elsewhere ? api.app('open-window', wt.path) : up.openRepo(wt.path);
  if (v?.id === 'move') return { id: 'move', stash: v.checked ? { message: stashMessage(state.head.branch, branch), untracked } : null };
  return v?.id === 'free' ? { id: 'free' } : null;
}

// Check out `branch` from clean worktree `wt`, leaving it detached (one undo step). Changes here in
// the way are stashed first, as a plain checkout does.
async function freeCheckout(label: string, branch: string, wt: WorktreeEntry) {
  try {
    await git('freeCheckout', branch, wt.path, { __label: label });
  } catch (e) {
    const err = e as Error & { stderr?: string };
    if (blockedCheckout(`${err.stderr || ''}\n${err.message}`)) {
      const n = switchChanges();
      const { untracked } = loadPref('autostash', AUTOSTASH_DEFAULT);
      const stash = { message: stashMessage(state.head.branch, branch), untracked };
      return act(label, 'moveCheckout', [branch, wt.path, stash], { success: `Checked out ${branch}`, detail: `Took it from ${wt.name}. ${changesText(n)} stashed.`, actions: [showStashAction(stash.message)] });
    }
    toast(`${label} failed`, { kind: 'error', detail: err.message });
    await refreshAll();
    return false;
  }
  toast(`Checked out ${branch}`, { kind: 'success', detail: `Took it from ${wt.name}, which is now detached.`, timeout: 0, actions: [{ label: 'Undo', run: undo }, { label: `Open ${wt.name}`, run: () => (wt.elsewhere ? api.app('open-window', wt.path) : up.openRepo(wt.path)) }] });
  await refreshAll();
  return true;
}

// Check out `branch` from worktree `wt` and bring its changes here (one undo step). A conflict
// while bringing them stops there, with the changes still in their stash.
async function moveCheckout(label: string, branch: string, wt: WorktreeEntry, stash: StashSpec | null) {
  try {
    const res = await git('moveCheckout', branch, wt.path, ...(stash ? [stash] : []), { __label: label });
    if (res?.conflicts) toast(`Switched to ${branch}. The changes from “${wt.name}” conflict here.`, { kind: 'error', detail: 'Their stash is kept.', action: { label: 'Undo', run: undo } });
    else toast(`Checked out ${branch}`, { kind: 'success', detail: `Moved the changes from ${wt.name}.${stash ? ' Yours are stashed.' : ''}`, actions: [{ label: 'Undo', run: undo }, ...(stash ? [showStashAction(stash.message)] : [])] });
  } catch (e) {
    toast(`${label} failed`, { kind: 'error', detail: (e as Error).message });
  }
  await refreshAll();
  return true;
}

// Stash, then switch (one undoable step). Asks first unless "Don't ask again" was ticked.
async function autostashCheckout(branch: string, blocked: { untracked: boolean }) {
  const from = state.head.branch;
  const plan = autostashPlan(loadPref('autostash', AUTOSTASH_DEFAULT), blocked);
  let message = stashMessage(from, branch), untracked = plan.untracked;
  if (plan.ask) {
    const v = await dialog({
      title: `Stash your current changes before checking out ${branch}?`,
      submit: 'Stash and switch',
      fields: [
        { name: 'msg', label: 'Message', value: message },
        { name: 'u', type: 'checkbox', label: 'Include untracked files', value: untracked },
        { name: 'never', type: 'checkbox', label: 'Don’t ask again', value: false },
      ],
    });
    if (!v) return false;
    message = v.msg.trim() || message;
    untracked = v.u || !!blocked.untracked;
    if (v.never) savePref('autostash', { ask: false, untracked: v.u });
  }
  return act(`Checkout ${branch}`, 'autostashCheckout', [branch, message, untracked], {
    success: `Stashed changes and switched to ${branch}`,
    then: (a) => { if (a?.branch && state.repo) savePref('autostashes', { list: [...autostashes(), { root: state.repo.root, branch: a.branch, sha: a.sha }] }); },
  });
}
const autostashes = () => loadPref<{ list: ReturnOffer['records'] }>('autostashes', { list: [] }).list;

// Back on a branch that was auto-stashed: offer its stash back.
async function pendingAutostash(branch: string | null) {
  const stashes = await git('stashes').catch(() => null);
  if (!stashes || !state.repo) return null;
  const { offer, records } = returnOffer(autostashes(), state.repo.root, branch, stashes);
  savePref('autostashes', { list: records });
  return offer;
}
// Resolve the ref from the sha at click time: the toast lives 15 s and positions shift if something else is stashed.
async function applyAutostash(o: { sha: string }, drop: boolean) {
  const ref = stashRefBySha(await git('stashes').catch(() => null), o.sha);
  if (!ref) return toast('That auto-stash is gone');
  return act(drop ? `Apply and drop ${ref}` : `Apply ${ref}`, 'stashApply', [ref, drop]);
}
async function offerAutostash(branch: string) {
  const o = await pendingAutostash(branch);
  if (o) toast(['Changes stashed on ', h('span.toast-ref', { title: branch }, branch)], {
    detail: 'Saved when you switched away. Bring them back?',
    timeout: 15000,
    actions: [{ label: 'Apply and drop', run: () => applyAutostash(o, true) }, { label: 'Apply and keep', run: () => applyAutostash(o, false) }],
  });
}
function checkoutCommit(c: { sha: string }) {
  const b = branchesAt(c.sha).find((x) => x.short !== state.head.branch);
  if (b) return checkout(b.short);
  return act(`Checkout ${c.sha.slice(0, 7)}`, 'checkout', [c.sha], { success: `HEAD detached at ${c.sha.slice(0, 7)}` });
}
// ⌘↵ / double-click on a map row (see checkoutPlan): a branch tip switches to it; a remote-only
// branch or a plain commit opens a small popover at `at` (or the selected row), Enter = default,
// Esc = cancel. Every choice is an undoable act. Never throws: a failure is a toast.
async function checkoutSelected(c: { sha: string }, at?: [number, number] | null) {
  try {
    const plan = checkoutPlan(c, state.refs, state.head);
    if (!plan) return;
    if (plan.kind === 'switch') return await checkout(plan.branch);
    const short = c.sha.slice(0, 7);
    const detached = { label: 'Check out detached', icon: 'checkout', run: () => act(`Checkout ${short}`, 'checkout', [c.sha], { success: `HEAD detached at ${short}` }) };
    const first = plan.kind === 'remote'
      ? { label: `Create local branch ${plan.local} tracking ${plan.remote}`, icon: 'branch', kbd: '↵', run: () => act(`Checkout ${plan.remote}`, 'checkoutTracking', [plan.remote], { success: `Switched to ${plan.local} tracking ${plan.remote}` }) }
      : { label: 'New branch here…', icon: 'branch', kbd: '↵', run: () => createBranch(c.sha) };
    const row = document.querySelector('.map-list .row.selected')?.getBoundingClientRect();
    const [x, y] = at || (row ? [row.left + 48, row.bottom + 2] : [innerWidth / 3, innerHeight / 3]);
    contextMenu(x, y, [{ section: plan.kind === 'remote' ? `Check out ${plan.remote}` : `Check out ${short}` }, first, detached], { focus: 0 });
  } catch (e) {
    toast('Checkout failed', { kind: 'error', detail: (e as Error | null)?.message || String(e) });
  }
}
// ⌘B: the selected commit in the Map, HEAD everywhere else.
function branchHere() {
  const sha = state.view === 'map' && state.selected && state.index.has(state.selected) ? state.selected : state.head.oid;
  if (!sha) return toast('No commits yet');
  createBranch(sha);
}

async function createBranch(sha: string) {
  const v = await dialog({ title: 'Create branch', description: `At ${sha.slice(0, 7)}`, submit: 'Create branch', fields: [{ name: 'name', label: 'Name', placeholder: 'feature/my-branch', required: true }, { name: 'co', type: 'checkbox', label: 'Check out after creating', value: true }] });
  if (!v || !v.name.trim()) return;
  act(`Create branch ${v.name.trim()}`, 'createBranch', [v.name.trim(), sha, v.co]);
}
async function createTag(sha: string) {
  const v = await dialog({ title: 'Create tag', description: `At ${sha.slice(0, 7)}`, submit: 'Create tag', fields: [{ name: 'name', label: 'Name', placeholder: 'v0.1.0', required: true }, { name: 'msg', label: 'Message (optional, makes it annotated)', multiline: true, rows: 3 }] });
  if (!v || !v.name.trim()) return;
  act(`Create tag ${v.name.trim()}`, 'createTag', [v.name.trim(), sha, v.msg.trim() || null]);
}
async function renameBranch(r: Ref) {
  const name = await prompt('Rename branch', { label: 'New name', value: r.short, submit: 'Rename' });
  if (name && name !== r.short) act(`Rename ${r.short}`, 'renameBranch', [r.short, name]);
}
async function deleteBranch(r: Ref) {
  act(`Delete branch ${r.short}`, 'deleteBranch', [r.short]);
}

// Local branches this window can switch to instead of `name` (not checked out in another worktree).
const switchTargets = (name: string) => state.refs.filter((x) => x.kind === 'branch' && x.short !== name && !worktreeOf(x.short)).map((x) => x.short);
const canSwitchFrom = (name: string) => switchTargets(name).length > 0;
// The branch the window switches to when `name` goes: `base`, else main or master, else the first.
const switchTarget = (name: string, base: string | null = null): string | null => { const o = switchTargets(name); return [base, 'main', 'master'].find((b) => b && o.includes(b)) || o[0] || null; };
// This window's changes a switch would stash (submodule insides stay).
const switchChanges = () => {
  const { untracked } = loadPref('autostash', AUTOSTASH_DEFAULT);
  return state.status.staged.length + state.status.unstaged.filter((f) => !f.inside && (untracked || f.status !== '?')).length;
};
const changesText = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

// Delete the checked-out branch: the menu item already said "Switch to main & Delete", so it
// switches (stashing what's here), deletes, and says so (AK-598). One undo step.
async function switchAndDelete(r: Ref, base: string | null = null) {
  const to = switchTarget(r.short, base);
  if (!to) return;
  const { untracked } = loadPref('autostash', AUTOSTASH_DEFAULT);
  const n = switchChanges();
  const stash = n ? { message: stashMessage(r.short, to), untracked } : undefined;
  return act(`Delete branch ${r.short}`, 'switchDelete', [to, ...(stash ? [stash] : [])], {
    success: `Deleted ${r.short}`,
    detail: `Switched to ${to}.${stash ? ` ${changesText(n)} stashed.` : ''}`,
    actions: stash ? [showStashAction(stash.message)] : undefined,
  });
}
// "Show stash" on a toast: opens Stashes with the stash saved as `message` selected.
const showStashAction = (message: string) => ({ label: 'Show stash', run: async () => {
  setStashFocus((await git('stashes').catch(() => [])).find((x) => x.message.endsWith(message))?.ref ?? null);
  up.showView('stashes');
} });
async function setTip(branch: string, c: { sha: string }) {
  act(`Move ${branch} to ${c.sha.slice(0, 7)}`, 'setBranchTip', [branch, c.sha]);
}
function mergeCommit(c: { sha: string }) {
  if (c.sha === state.head.oid) return;
  const b = branchesAt(c.sha)[0] || state.refs.find((r) => r.kind === 'remote' && r.target === c.sha);
  act(`Merge ${b ? b.short : c.sha.slice(0, 7)}`, 'merge', [b ? b.short : c.sha]);
}
function rebaseOnto(c: { sha: string }) {
  if (c.sha === state.head.oid) return;
  act(`Rebase onto ${c.sha.slice(0, 7)}`, 'rebaseOnto', [c.sha], { busy: 'Rebasing…' });
}
function cherryPick(c: { sha: string }) { act(`Cherry-pick ${c.sha.slice(0, 7)}`, 'cherryPick', [c.sha]); }
function revertCommit(c: { sha: string }) { act(`Revert ${c.sha.slice(0, 7)}`, 'revert', [c.sha]); }
async function editMessage(c: { sha: string }, branch: string | null = null) {
  const full = await loadCommit(c.sha);
  const msg = await prompt('Edit commit message', { value: full.message, multiline: true, submit: 'Save', description: `${c.sha.slice(0, 7)} · descendants will be rewritten` });
  if (!msg || msg === full.message) return;
  if (branch) return switchRewrite('reword', c, branch, { message: msg + '\n' });
  act('Edit message', 'rewrite', ['reword', c.sha, { message: msg + '\n' }], { busy: 'Rewriting history…' });
}
const REWRITE_LABELS: Record<RewriteOp, string> = { reword: 'Edit message', squash: 'Squash with parent', fixup: 'Fixup with parent', swapParent: 'Swap with parent', split: 'Split commit', drop: 'Delete commit' };
function rewriteOp(op: RewriteOp, c: { sha: string }, branch: string | null = null) {
  if (branch) return switchRewrite(op, c, branch);
  act(REWRITE_LABELS[op], 'rewrite', [op, c.sha], { busy: 'Rewriting history…' });
}

// The local branches to switch to for rewriting `c` when it isn't on this branch (AK-581): those
// containing it, except ones checked out in another worktree. null: it's on this branch.
async function rewriteTargets(c: { sha: string }): Promise<string[] | null> {
  const where = await git('commitBranches', c.sha).catch(() => null);
  return !where || where.onHead ? null : where.branches.filter((b) => !worktreeOf(b));
}
// A Rewrite menu item that says what happens: run here, "Switch to feature/api & Squash", or a
// "Switch to" submenu when several branches contain the commit.
const REWRITE_VERBS: Record<RewriteOp, string> = { reword: 'Edit Message…', squash: 'Squash', fixup: 'Fixup', swapParent: 'Swap', split: 'Split…', drop: 'Delete' };
function rewriteItem(targets: string[] | null, op: RewriteOp, label: string, props: ItemProps, run: (branch: string | null) => unknown): GroupItem {
  if (!targets) return { label, ...props, run: () => run(null) };
  if (props.disabled) return { label, ...props };
  if (!targets.length) return { label, ...props, kbd: null, disabled: true, why: 'Not on a branch here' };
  const verb = REWRITE_VERBS[op];
  const only = targets[0];
  if (targets.length === 1 && only) return { label: `Switch to ${only} & ${verb}`, ...props, kbd: null, run: () => run(only) };
  return { label: `Switch & ${verb.replace('…', '')}`, ...props, kbd: null, submenu: [{ section: 'Switch to' }, ...targets.map((b) => ({ label: b, icon: 'branch', run: () => run(b) }))] };
}

// A rewrite shortcut: here, on the one branch containing the commit, or with a "Switch to" choice.
async function rewriteVia(c: MapCommit, op: RewriteOp, run: (branch: string | null) => unknown) {
  const t = await rewriteTargets(c);
  if (!t || t.length === 1) return run(t ? t[0]! : null);
  if (!t.length) return toast('This commit isn’t on a branch here', { kind: 'error' });
  const row = document.querySelector('.map-list .row.selected')?.getBoundingClientRect();
  contextMenu(row ? row.left + 48 : innerWidth / 3, row ? row.bottom + 2 : innerHeight / 3, rewriteItem(t, op, '', {}, run).submenu ?? [], { focus: 0 });
}

// Switch to `branch` (stashing this window's changes), then rewrite `c` there: one undo step that
// brings back the branch, the switch and the stash (Journal.switchRewrite).
function switchRewrite(op: RewriteOp, c: { sha: string }, branch: string, extra: unknown = null) {
  const { untracked } = loadPref('autostash', AUTOSTASH_DEFAULT);
  const n = switchChanges();
  const from = state.head.branch;
  const stash = n ? { message: stashMessage(from, branch), untracked } : null;
  const done = ({ reword: 'Reworded', squash: 'Squashed', fixup: 'Fixed up', swapParent: 'Swapped', split: 'Split', drop: 'Deleted' } satisfies Record<RewriteOp, string>)[op];
  return act(`${REWRITE_LABELS[op]} on ${branch}`, 'switchRewrite', [branch, op, c.sha, extra, ...(stash ? [stash] : [])], {
    busy: 'Rewriting history…',
    success: `${done} ${c.sha.slice(0, 7)} on ${branch}`,
    detail: `Switched from ${from || 'detached HEAD'}.${n ? ` ${n} change${n === 1 ? '' : 's'} stashed.` : ''}`,
    actions: stash ? [showStashAction(stash.message)] : undefined,
    // Offered back on returning to `from`, like any stash-and-switch.
    then: (a) => { if (a?.branch && state.repo) savePref('autostashes', { list: [...autostashes(), { root: state.repo.root, branch: a.branch, sha: a.sha }] }); },
  });
}
async function diffWithHead(c: { sha: string }) {
  if (!state.head.oid || c.sha === state.head.oid) return;
  const diffs = await git('compare', c.sha, 'HEAD').catch((e: Error) => { toast('Diff failed', { kind: 'error', detail: e.message }); return null; });
  const host = contentEl;
  if (!diffs || !host) return;
  state.quick = null;
  host.replaceChildren(h('div.compare', null,
    h('div.diff-head', null, h('button.btn.ghost.small', { onclick: () => up.renderView() }, icon('chevron', 12), 'Back', kbd(...(keymap.keys('diff.close') ?? []))),
      h('span.mono', null, `${c.sha.slice(0, 7)} → HEAD`), h('span.spacer'), h('span.muted', null, `${diffs.length} files`)),
    h('div.diff-scroll', { tabIndex: 0, onkeydown: (e) => { if (keymap.match('diff', e) === 'diff.close') up.renderView(); } }, diffs.map((d) => h('div.diff-file', null, h('div.diff-file-head', null, h('span.mono', null, d.newPath === '/dev/null' ? d.oldPath : d.newPath)), renderDiff(d)))),
  ));
  host.querySelector<HTMLElement>('.diff-scroll')?.focus();
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { showStashAction, checkoutSelected, commitMenu, copy, commitShortcut, checkoutCommit, createBranch, switchRewrite, inUseSheet, switchAndDelete, deleteBranch });

export { copy, checkout, refMenu, changesText, canSwitchFrom, switchTarget, switchChanges, switchAndDelete, showStashAction, createBranch, pendingAutostash, applyAutostash, checkoutSelected, guarded, branchHere };
