import { toast, confirm, contextMenu, palette, closePalette, timeAgo } from '../lib/ui.ts';
import * as keymap from './keymap.ts';
import { otherRecent, PALETTE_RECENT_LIMIT } from './recent.ts';
import { CONFLICT_KEYS } from '../commit/conflict-view.js';
import { BRANCH_TABS } from '../branches/branches.ts';
import { laneTitle, canRemove, checkoutHereMode } from '../lanes/lanes.ts';
import { paneActions, fixActions } from '../prs/pr-review.ts';
import { sidebarToggleLabel, SECTION_PAGES, orderedSections, showSection } from '../shell/sidebar.ts';
import { authorProfile, loginProfile } from '../lib/profile.ts';
import { SUBMODULE_STATES } from '../lib/submodule.ts';
import { AUTOSTASH_DEFAULT } from '../commit/autostash.ts';
import { GIT_NEEDS } from '../lib/git-version.ts';
import { draftSwitch } from '../prs/prs.ts';
import { up } from '../lib/upcalls.ts';
import { api, state, tildePath, loadPref, savePref, MOD } from '../lib/app-helpers.ts';
import { stashShown, commitView, lanesPage, branchesPage, catchupPage } from '../shell/shell.ts';
import { THEMES, setTheme, cycleTheme, THEME_KBD } from '../shell/theme.ts';
import { canReopenTab, tabList, TAB_KEYS, update, installUpdate, checkUpdates, toggleAutoUpdate } from '../shell/updates.ts';
import { chooseGit, useGit, act, gitWhy, undoTitle, undo, redoTitle, redo, git } from '../lib/bridge.ts';
import { openIdentity } from '../commit/identity-check.js';
import { stashSave, applyStash } from '../commit/stashes.ts';
import { writeMessageWithAi, aiOn, setupAi } from '../commit/ai-message.ts';
import { snapshotEntries, restoreSnapshot } from '../history/snapshots.js';
import { openDifftool } from '../commit/external-tools.js';
import { fetchAll, pull, push, remotesSwitcher, addRemote, remoteItems } from '../branches/remote-ops.ts';
import { exportShortcuts, importShortcuts, resetShortcuts, openShortcuts, openSetup } from '../welcome/welcome.js';
import { openSplit } from '../commit/split.js';
import { openFileHistory, fileHistoryTarget, openConflicts, openMergetool } from '../history/file-history.js';
import { prList, refreshPrs, createPr, pickPrBranch, pickPr, approvePr, approveTargetWhy, requestChangesPr, togglePrs, hidePrs, pickPrRemote, submoduleSwitcher, checkoutPr, prRemote, prFor, prViewer, toggleDraft } from '../prs/prs-page.js';
import { pendingAutostash, applyAutostash, createBranch, canSwitchFrom, checkoutSelected, guarded, checkout } from '../graph/commit-actions.js';
import { openRepo, openPrefs, cloneRepo, closeRepo } from '../settings/prefs-window.js';
import { VIEWS, setView, setSections, nav, goBack, goForward, openLfs, conflictEd, originRemote, openOrigin, toggleShow, lanesOpen, detailToggleLabel, toggleDetail, resetPanes, sbState, toggleSidebar, openAuthor, copyCommitLink, jumpTo } from '../shell/navigation.js';
import { pickPrReview, prDeskAction, mergePrCmd, closePrCmd, openReview, branchSwitcher, addWorktree, worktreeSwitcher, pruneWorktrees, removeWorktree, switchWorktree, openWorktreeWindow, toggleLock, updateSubmodules, openSubmodule, mergeLane, rebaseLane, laneAction, deleteLane, startCleanup, makeChainStack, paneAction, openLane, showBranches } from '../lanes/worktrees.js';

// Command palette

// Recent repositories other than the open one, newest first.
async function recentRepos(limit) {
  return otherRecent(await api.app('recent'), state.repo?.root, limit);
}

async function repoSwitcher() {
  const recent = await recentRepos();
  if (!recent.length) return toast('No other recent repositories');
  palette(() => [
    ...recent.map((x) => ({ group: 'Recent repositories', label: x.name, icon: 'folder', detail: tildePath(x.root), keywords: x.root, run: () => openRepo(x.root) })),
    { group: 'Recent repositories', label: 'Remove from recent…', icon: 'x', keywords: 'forget clear', run: removeFromRecent },
  ], { placeholder: 'Switch repository…' });
}

async function removeFromRecent() {
  const recent = await recentRepos();
  if (!recent.length) return toast('No other recent repositories');
  palette(() => recent.map((x) => ({ group: 'Remove from recent', label: x.name, icon: 'x', detail: tildePath(x.root), keywords: x.root, run: async () => {
    await api.app('remove-recent', x.root);
    toast(`Removed ${x.name} from recent`);
  } })), { placeholder: 'Remove from recent…' });
}

// Opens at once; the recent repositories are added when the app:recent IPC answers.
function openPalette() {
  if (!state.repo || closePalette()) return;
  let recent = [];
  const pal = palette(() => {
    const items = [];
    const add = (group, label, run, opts = {}) => items.push({ group, label, run, ...opts });
    VIEWS.forEach((v) => add('Navigation', `Go to ${v.label}`, () => setView(v.view), { icon: v.icon, kbd: keymap.keys(`view.${v.view}`) }));
    SECTION_PAGES.forEach((p) => add('Navigation', `Open ${p.label} page`, () => setView(p.view), { icon: p.icon, kbd: keymap.keys(`view.${p.view}`), keywords: 'sidebar section full page' }));
    orderedSections(state.sections).filter((p) => !p.fixed).forEach((p) => add('View', `${p.hidden ? 'Show' : 'Hide'} ${p.label} in the sidebar`, () => setSections(showSection(state.sections, p.id, p.hidden)), { icon: p.icon, keywords: 'sidebar section show hide refs tree' }));
    add('View', 'Reorder sidebar sections…', () => openPrefs('sidebar'), { icon: 'sidebar', kbd: keymap.keys('app.settings'), keywords: 'sidebar section order move show hide preferences' });
    add('Navigation', 'Open History & recovery', () => setView('snapshots'), { icon: 'history', kbd: keymap.keys('view.snapshots'), keywords: 'snapshots undo timeline restore recover lost' });
    add('Navigation', 'Open Reflog (History & recovery)', () => setView('reflog'), { icon: 'reflog', kbd: keymap.keys('view.reflog'), keywords: 'reflog recover lost commits' });
    add('App', 'Choose git…', chooseGit, { icon: 'terminal', detail: state.gitInfo ? `git ${state.gitInfo.version}` : null, keywords: 'git version path binary homebrew xcode' });
    add('App', 'Use system git', () => useGit('system'), { icon: 'terminal', keywords: 'git version path binary default xcode' });
    add('Repository', 'Fetch all remotes', fetchAll, { icon: 'fetch', kbd: keymap.keys('repo.fetch') });
    add('Repository', 'Pull current branch', pull, { icon: 'pull', kbd: keymap.keys('repo.pull') });
    add('Repository', 'Push current branch', () => push(false), { icon: 'push', kbd: keymap.keys('repo.push') });
    add('Repository', 'Force push current branch (with lease)', async () => { if (await confirm('Force push?', 'Overwrites the remote branch if nobody else pushed meanwhile.', { submit: 'Force push' })) push(true); }, { icon: 'push' });
    add('Repository', 'Write commit message with AI', writeMessageWithAi, { icon: 'sparkle', kbd: keymap.keys('repo.aiMessage'), detail: aiOn() ? null : 'off', keywords: 'ai llm generate claude codex ollama' });
    add('Repository', 'Pull requests…', prList, { icon: 'merge', kbd: keymap.keys('repo.prs'), detail: state.prs?.active ? null : 'off', keywords: 'pr github gh review checks ci' });
    add('Repository', 'Refresh pull requests', () => refreshPrs({ manual: true }), { icon: 'fetch', kbd: keymap.keys('repo.prRefresh'), keywords: 'pr github gh' });
    add('Repository', 'New pull request…', () => createPr(), { icon: 'plus', kbd: keymap.keys('repo.prCreate'), keywords: 'pr github gh create open push' });
    add('Repository', 'New pull request from branch…', pickPrBranch, { icon: 'plus', keywords: 'pr github gh create open branch' });
    add('Repository', 'Check out pull request…', () => pickPr(false), { icon: 'checkout', kbd: keymap.keys('repo.prCheckout'), keywords: 'pr github gh branch review' });
    add('Repository', 'Check out pull request in new worktree…', () => pickPr(true), { icon: 'worktree', kbd: keymap.keys('repo.prWorktree'), keywords: 'pr github gh branch review' });
    if (state.prs?.active) {
      add('Repository', 'Approve pull request…', () => approvePr(), { icon: 'check', kbd: keymap.keys('repo.prApprove'), detail: approveTargetWhy(), gated: Boolean(approveTargetWhy()), keywords: 'pr github gh review approve' });
      add('Repository', 'Request changes on pull request…', () => requestChangesPr(), { icon: 'edit', kbd: keymap.keys(state.review?.pr ? 'review.changes' : 'repo.prChanges'), keywords: 'pr github gh review request changes reject' });
      add('Repository', 'Review pull request…', pickPrReview, { icon: 'diff', keywords: 'pr github gh review diff files inbox' });
      if (state.review?.pr) add('Repository', `Check out #${state.review.pr.number} in a new worktree`, () => prDeskAction('checkout'), { icon: 'worktree', kbd: keymap.keys('review.checkout'), keywords: 'pr github gh worktree branch checkout' });
      add('Repository', 'Merge pull request…', mergePrCmd, { icon: 'merge', kbd: keymap.keys('repo.prMerge'), keywords: 'pr github gh squash rebase merge' });
      add('Repository', 'Close pull request…', closePrCmd, { icon: 'x', kbd: keymap.keys('repo.prClose'), keywords: 'pr github gh close' });
    }
    add('App', state.prs?.enabled ? 'Turn pull requests off' : 'Turn pull requests on', togglePrs, { icon: 'merge', kbd: keymap.keys('global.prs'), keywords: 'pr github gh enable disable everywhere' });
    if (state.prs?.enabled && state.prs.remote) add('Repository', state.prs.hidden ? 'Show pull requests in this repository' : 'Hide pull requests in this repository', () => hidePrs(!state.prs.hidden), { icon: 'eye', kbd: keymap.keys('global.prHide'), keywords: 'pr github gh hide show' });
    if (state.prs?.choices?.length > 1) add('Repository', 'Choose remote for pull requests…', pickPrRemote, { icon: 'cloud', kbd: keymap.keys('global.prRemote'), keywords: 'pr github gh remote origin fork upstream push' });
    add('App', 'Set up AI commit messages…', setupAi, { icon: 'sparkle', keywords: 'ai llm claude codex ollama provider off' });
    add('Repository', 'Manage remotes…', remotesSwitcher, { icon: 'cloud', kbd: keymap.keys('repo.remotes'), keywords: 'remote origin upstream fork url' });
    add('Repository', 'Add remote…', () => addRemote(), { icon: 'plus', keywords: 'remote new origin upstream fork' });
    for (const it of state.remotes.flatMap((r) => remoteItems(r, 'Repository'))) items.push(it);
    add('Repository', 'Set commit identity…', openIdentity, { icon: 'commit', kbd: keymap.keys('repo.identity'), keywords: 'user email name author wrong identity' });
    add('Repository', 'Push all tags', () => act('Push tags', 'pushTags', [], { busy: 'Pushing tags…', undoable: false }), { icon: 'tag' });
    add('Repository', 'Stash changes…', () => stashSave(), { icon: 'stash', kbd: keymap.keys('repo.stash') });
    if (!loadPref('autostash', AUTOSTASH_DEFAULT).ask) add('Repository', 'Ask before auto-stashing on checkout', () => { savePref('autostash', AUTOSTASH_DEFAULT); toast('Since will ask before stashing on checkout'); }, { icon: 'stash', keywords: 'autostash auto stash checkout switch dont ask again' });
    if (state.head?.branch && loadPref('autostashes', { list: [] }).list.some((x) => x.root === state.repo?.root && x.branch === state.head.branch)) {
      add('Repository', `Apply auto-stash for ${state.head.branch}`, async () => { const o = await pendingAutostash(state.head.branch); if (o) applyAutostash(o, true); else toast('That auto-stash is gone'); }, { icon: 'stash', keywords: 'autostash auto stash pop apply drop' });
    }
    add('Repository', 'Stash staged changes…', () => stashSave({ staged: true }), { icon: 'stash', kbd: keymap.keys('repo.stashStaged'), keywords: 'partial stash index', detail: gitWhy('stashStaged') });
    add('Repository', state.history.undo.length ? undoTitle() : 'Undo last operation', undo, { icon: 'undo', kbd: keymap.keys('edit.undo') });
    add('Repository', redoTitle(), redo, { icon: 'redo', kbd: keymap.keys('edit.redo') });
    if (nav.canBack) add('View', 'Back', goBack, { icon: 'chevronLeft', kbd: keymap.keys('view.back'), keywords: 'previous history return navigate' });
    if (nav.canForward) add('View', 'Forward', goForward, { icon: 'chevron', kbd: keymap.keys('view.forward'), keywords: 'next history navigate' });
    const snap = state.view === 'snapshots' && snapshotEntries().find((x) => x.id === state.snapSel && x.movesRefs);
    const shownStash = state.view === 'stashes' && state.stashes.find((x) => x.ref === stashShown);
    if (shownStash) add('Repository', `Apply ${shownStash.ref}`, () => applyStash(shownStash), { icon: 'stash', kbd: keymap.keys('stashes.apply'), detail: shownStash.message, keywords: 'stash apply unstash restore changes' });
    if (snap) add('Repository', `Restore before “${snap.label}”…`, () => restoreSnapshot(snap), { icon: 'restore', kbd: keymap.keys('snapshots.restore'), keywords: 'snapshot undo history timeline jump back restore' });
    if (state.head.oid) add('Repository', 'Create branch at HEAD…', () => createBranch(state.head.oid), { icon: 'branch', kbd: keymap.keys('global.branch'), keywords: 'new branch create' });
    add('Repository', 'Reset hard to HEAD…', resetHard, { icon: 'trash' });
    add('Repository', 'Git LFS files…', openLfs, { icon: 'cloud', kbd: keymap.keys('repo.lfs'), detail: state.lfs?.used ? (state.lfs.installed ? null : 'git-lfs missing') : 'not used', keywords: 'lfs large file storage pointer download' });
    add('Repository', state.head.branch ? `Review branch ${state.head.branch}…` : 'Review branch…', () => openReview(), { icon: 'check', kbd: keymap.keys('repo.review'), keywords: 'review reviewed tick pull request diff base merge-base branch files progress' });
    add('Repository', 'File history & blame…', () => openFileHistory(), { icon: 'history', kbd: keymap.keys('repo.fileHistory'), detail: fileHistoryTarget() || null, keywords: 'blame annotate log file history who changed line follow renames' });
    add('Repository', 'Open file in difftool', () => openDifftool(), { icon: 'diff', kbd: keymap.keys('repo.difftool'), keywords: 'difftool external diff tool compare kaleidoscope beyond' });
    if (state.view === 'commit' && !state.show.unified && (state.status[state.cv.list] || []).length) add('Repository', 'Select all files in list', () => commitView?.selectAll(), { icon: 'check', kbd: keymap.keys('cv.selectAll'), keywords: 'select all multi stage unstage discard files changes' });
    if (state.status.conflicts.length) add('Conflicts', 'Resolve conflicts…', openConflicts, { icon: 'merge', kbd: keymap.keys('repo.conflicts'), detail: `${state.status.conflicts.length} conflicted`, keywords: 'conflict editor merge resolve ours theirs' });
    if (state.view === 'commit' && state.cv.list === 'conflicts' && conflictEd?.info.kind === 'text') {
      const a = conflictEd.actions, k = CONFLICT_KEYS;
      const c = (label, run, kbd) => add('Conflicts', label, run, { icon: 'merge', kbd, keywords: 'conflict resolve' });
      if (conflictEd.blocks()) {
        c('Next conflict', a.next, k.next);
        c('Previous conflict', a.prev, k.prev);
        c('Take ours for this conflict', a.ours, k.ours);
        c('Take theirs for this conflict', a.theirs, k.theirs);
        c('Take both for this conflict', a.both, k.both);
        c('Reset this conflict', a.reset, k.reset);
        c('Take ours for every conflict', a.allOurs, k.allOurs);
        c('Take theirs for every conflict', a.allTheirs, k.allTheirs);
      }
      c(conflictEd.editing() ? 'Stop editing the result' : 'Edit the result', a.edit, k.edit);
      c('Mark file resolved', a.resolve, [MOD, 'S']);
    }
    add('Repository', 'Open conflicts in mergetool', () => openMergetool(), { icon: 'merge', kbd: keymap.keys('repo.mergetool'), detail: state.status.conflicts.length ? `${state.status.conflicts.length} conflicted` : 'no conflicts', keywords: 'mergetool external merge tool conflict resolve' });
    if (state.head.oid) add('Repository', 'Switch branch…', branchSwitcher, { icon: 'branch', kbd: keymap.keys('repo.branchSwitch'), keywords: 'checkout branch switch change' });
    add('Worktrees', 'New worktree…', () => addWorktree(), { icon: 'worktree', kbd: keymap.keys('repo.worktreeAdd') });
    add('Worktrees', 'Switch worktree…', worktreeSwitcher, { icon: 'worktree', kbd: keymap.keys('repo.worktreeSwitch') });
    if (state.worktrees.some((w) => w.missing)) add('Worktrees', 'Prune missing worktrees', pruneWorktrees, { icon: 'trash' });
    const here = state.worktrees.find((w) => w.current && !w.main && !w.missing);
    if (here) add('Worktrees', `Remove worktree ${here.name}…`, () => removeWorktree(here), { icon: 'trash', detail: here.branch || here.head?.slice(0, 7) || null });
    for (const w of state.worktrees) {
      if (w.current || w.missing) continue;
      const detail = w.branch || (w.head ? w.head.slice(0, 7) : null);
      add('Worktrees', `Switch to worktree ${w.name}`, () => switchWorktree(w), { icon: 'worktree', detail });
      add('Worktrees', `Open worktree ${w.name} in new window`, () => openWorktreeWindow(w), { icon: 'plus', detail });
      if (!w.main) add('Worktrees', `${w.locked ? 'Unlock' : 'Lock'} worktree ${w.name}${w.locked ? '' : '…'}`, () => toggleLock(w), { icon: 'key', detail });
      if (!w.main) add('Worktrees', `Remove worktree ${w.name}…`, () => removeWorktree(w), { icon: 'trash', detail });
    }
    if (state.submodules.length) {
      add('Submodules', 'Open submodule…', submoduleSwitcher, { icon: 'submodule', kbd: keymap.keys('repo.submodules'), keywords: 'submodule nested repository' });
      add('Submodules', 'Update all submodules', () => updateSubmodules(), { icon: 'pull', kbd: keymap.keys('repo.submoduleUpdate'), keywords: 'submodule init update checkout recorded' });
      for (const m of state.submodules) {
        if (m.head) add('Submodules', `Open submodule ${m.path} in new window`, () => openSubmodule(m), { icon: 'submodule', detail: SUBMODULE_STATES[m.state][0] });
        if (['outdated', 'uninitialized'].includes(m.state)) add('Submodules', `Update submodule ${m.path}`, () => updateSubmodules([m]), { icon: 'pull', detail: SUBMODULE_STATES[m.state][0] });
      }
    }
    add('Repository', 'Open in Finder', () => api.app('reveal'), { icon: 'folder' });
    add('Repository', 'Open in Terminal', () => api.app('terminal'), { icon: 'terminal' });
    add('Repository', 'Open in hosting service', openHosting, { icon: 'external' });
    if (originRemote()?.web) add('Repository', 'Open origin in browser', openOrigin, { icon: 'external', kbd: keymap.keys('repo.origin'), detail: originRemote().label });
    add('View', state.show.tags ? 'Hide tags' : 'Show tags', () => toggleShow('tags'), { icon: 'tag' });
    add('View', state.show.remotes ? 'Hide remote branches' : 'Show remote branches', () => toggleShow('remotes'), { icon: 'cloud' });
    const laneSel = state.review?.source?.branch ? { lane: state.review.source, base: state.review.base } : state.view === 'lanes' ? lanesPage?.selected() : null;
    if (laneSel?.lane.branch && !laneSel.lane.isBase) add('Repository', `Merge and tidy ${laneSel.lane.name}…`, () => mergeLane(laneSel.lane, laneSel.base), { icon: 'merge', kbd: keymap.keys(state.review ? 'review.merge' : 'lanes.merge'), keywords: 'squash merge tidy cleanup remove worktree delete branch land', detail: gitWhy('mergeHere') });
    if (laneSel && !state.review) {
      const l = laneSel.lane;
      const t = laneTitle(l);
      const next = laneSel.step;
      if (next) add('Repository', `Next step on ${t}: ${next.toLowerCase()}`, () => lanesPage.step(), { icon: 'lanes', keywords: 'branch review next step primary button' });
      if (l.branch && !l.isBase && laneSel.base) add('Repository', `Rebase ${t} onto ${laneSel.base}`, () => rebaseLane(l, laneSel.base), { icon: 'rebase', kbd: keymap.keys('lanes.rebase'), keywords: 'branch conflicts update base' });
      if (l.pr?.url) add('Repository', `Open checks of ${t}`, () => laneAction('checks', l), { icon: 'external', kbd: keymap.keys('lanes.checks'), keywords: 'branch ci failing pull request github' });
      if (canRemove(l, canSwitchFrom)) add('Repository', `${l.changes ? 'Discard' : 'Delete'} branch ${t}…`, () => deleteLane(l), { icon: 'trash', kbd: keymap.keys('lanes.delete'), keywords: 'remove worktree branch discard stalled abandon' });
      if (l.done) add('Repository', `Clean up ${t}…`, () => startCleanup(l), { icon: 'trash', kbd: keymap.keys('lanes.cleanup'), keywords: 'branch merged shipped tidy remove' });
    }
    if (state.view === 'lanes' && lanesOpen() && lanesPage?.canReload()) add('Review', 'Reload pull requests', () => lanesPage.reload(), { icon: 'restore', kbd: keymap.keys('lanes.reload'), keywords: 'refresh fetch github pull requests prs review requests update gh' });
    if (state.view === 'lanes' && lanesOpen() && (lanesPage?.canPlan() || lanesPage?.planGated())) add('Review', 'Plan merge…', () => lanesPage.mergePlan(), { icon: 'merge', kbd: keymap.keys('lanes.mergePlan'), keywords: 'merge plan order ready conflict free squash queue', detail: lanesPage.planGated() ? `Needs git ${GIT_NEEDS.mergePlan}` : null });
    if (state.view === 'lanes' && lanesOpen() && lanesPage?.canPlan()) for (const t of lanesPage.mergeTargets?.() || []) add('Review', `Merge plan into ${t.name}`, () => lanesPage.mergePlan(null, { target: t.name }), { icon: 'merge', keywords: `merge plan into branch target base ${t.name}` });
    if (state.view === 'lanes' && lanesOpen() && lanesPage?.canPlan()) for (const [m, name] of [['squash', 'squash'], ['merge', 'merge commits'], ['rebase', 'rebase']]) add('Review', `Merge plan: ${name}`, () => lanesPage.mergePlan(m), { icon: 'merge', keywords: `merge plan order ready method ${m} ${name}` });
    if (state.view === 'lanes' && lanesOpen() && lanesPage?.canPlan()) add('Review', 'Make chain a GitHub stack', () => makeChainStack(), { icon: 'merge', keywords: 'gh stack link chain stacked pull requests series native' });
    if (state.view === 'lanes' && lanesOpen() && lanesPage?.canPlan()) add('Review', 'Merge plan: merge anyway', () => lanesPage.mergePlan(null, { anyway: true }), { icon: 'merge', keywords: 'merge plan anyway failing checks not required optional ci' });
    const stackSel = state.view === 'lanes' && lanesOpen() ? lanesPage?.stackSelection() : null;
    if (stackSel?.down) add('Review', `Select #${stackSel.down}, the pull request #${stackSel.number} is stacked on`, () => lanesPage.stackStep(-1), { icon: 'merge', kbd: keymap.keys('lanes.stackDown'), keywords: 'stack stacked base parent down previous pull request' });
    if (stackSel?.up) add('Review', `Select #${stackSel.up}, next up the stack`, () => lanesPage.stackStep(1), { icon: 'merge', kbd: keymap.keys('lanes.stackUp'), keywords: 'stack stacked child up next pull request' });
    for (const a of (stackSel && lanesPage.stackActions()) || []) add('Review', a.label, a.run, { icon: 'merge', keywords: a.id === 'ready' ? 'stack draft ready for review mark ready' : 'stack merge stacked pull requests' });
    if (stackSel && lanesPage.canPlan()) add('Review', `Make #${stackSel.number}’s stack a GitHub stack`, () => makeChainStack(stackSel.number), { icon: 'merge', keywords: 'gh stack link chain stacked pull requests series native' });
    const stuckSel = state.view === 'lanes' && lanesOpen() ? lanesPage?.stuckSelection() : null;
    if (stuckSel) add('Review', `Fix prompt for ${stuckSel.pr ? `#${stuckSel.pr.number}` : stuckSel.title}…`, () => lanesPage.sendBack(stuckSel.pr?.number ?? null), { icon: 'copy', kbd: keymap.keys('lanes.sendBack'), keywords: 'fix prompt ai prompt copy prompt send back stuck agent conflict ci failing' });
    const paneSel = state.view === 'lanes' && lanesOpen() ? lanesPage?.paneSelection() : null;
    if (paneSel) {
      const t = paneSel.row.pr ? `#${paneSel.row.pr.number}` : paneSel.row.title;
      for (const a of paneActions(paneSel.row, paneSel.ctx.step, { viewer: paneSel.ctx.viewer }).actions.filter((x) => !(x.id === 'merge' && paneSel.row.lane?.branch))) {
        add('Review', `${a.label.replace('…', '')} ${t}${a.label.endsWith('…') ? '…' : ''}`, () => paneAction(a.id, paneSel.row, paneSel.ctx), { icon: a.icon, kbd: keymap.keys(a.listKey), gated: a.gated, detail: a.gated ? a.note : null, keywords: `review pane pull request ${a.remote ? 'github remote' : 'local'} ${a.id}` });
      }
      if (paneSel.row.pr && paneSel.ctx.prsOn) add('Review', `Show media of ${t}`, () => lanesPage.media(), { icon: 'image', kbd: keymap.keys('review.media'), keywords: 'media gallery images videos screenshots recordings pictures thumbnails' });
      if (paneSel.row.pr && paneSel.ctx.prsOn) add('Review', `Show checks and reviews of ${t}`, () => lanesPage.evidence(), { icon: 'checks', kbd: keymap.keys('review.evidence'), keywords: 'evidence checks ci annotations media screenshots images videos reviews open threads log failed' });
      if (paneSel.row.pr) add('Review', `Check out ${t} here`, () => (checkoutHereMode(paneSel.row) === 'pr' ? checkoutPr(paneSel.row.pr) : openLane(paneSel.row.lane)), { icon: 'checkout', kbd: keymap.keys('lanes.checkoutHere'), keywords: 'review pane pull request checkout switch branch this window local' });
      const authorP = paneSel.row.pr && !paneSel.row.pr.bot && /^https:\/\/github\.com\//.test(paneSel.row.pr.url || '') ? loginProfile(paneSel.row.pr.author) : null;
      if (authorP) add('Review', `Open ${t}’s author on GitHub`, () => api.app('external', authorP.url), { icon: 'external', keywords: `author profile person github ${paneSel.row.pr.author}` });
      // Stuck fixes (AK-359) that ⌘K doesn't list above: rebase, checks and send back are there for a lane.
      for (const a of fixActions(paneSel.row, paneSel.ctx).filter((x) => x.id === 'showConflicts' || x.id === 'updateBranch' || (x.id === 'checks' && !paneSel.row.lane))) {
        const label = a.id === 'checks' ? 'Open failing checks of' : a.id === 'updateBranch' ? 'Update branch of' : 'Show conflicts in';
        add('Review', `${label} ${t}${a.id === 'updateBranch' ? ' on GitHub…' : ''}`, () => (a.id === 'showConflicts' ? lanesPage.showRowConflicts() : paneAction(a.id, paneSel.row, paneSel.ctx)), { icon: a.icon, kbd: keymap.keys(a.listKey), keywords: 'stuck fix conflicts conflicting files ci failing checks rebase update branch behind merge base github' });
      }
    }
    // Draft ↔ ready (AK-610) for the PR in front of you: the pane's, the review page's, else the checked-out branch's.
    const draftPr = !state.prs?.active ? null : paneSel?.row.pr ? { ...paneSel.row.pr, remote: prRemote(paneSel.row.pr, paneSel.ctx?.remote) }
      : state.review?.pr || (state.head.branch ? prFor({ kind: 'branch', short: state.head.branch }) : null);
    const ds = draftPr && draftSwitch(draftPr, prViewer(paneSel?.row.pr ? paneSel.ctx?.viewer : null));
    if (ds) add(paneSel?.row.pr ? 'Review' : 'Repository', ds.command, () => (paneSel?.row.pr ? paneAction('draft', paneSel.row, paneSel.ctx) : toggleDraft(draftPr)), { icon: ds.icon, gated: Boolean(ds.why), detail: ds.why, keywords: 'pr github gh draft ready for review wip convert undo draft' });
    add('Repository', 'Clean up finished branches and worktrees…', () => startCleanup(), { icon: 'trash', kbd: keymap.keys('global.cleanup'), keywords: 'prune delete merged squash gone old stale worktrees branches tidy remove bulk finished' });
    if (state.view === 'branches' && branchesPage?.tab() === 'finished' && !state.review) {
      const n = branchesPage.panel.count();
      if (n) add('Branches', `Clean up ${n} ticked branch${n === 1 ? '' : 'es'}…`, () => branchesPage.panel.go(), { icon: 'trash', kbd: keymap.keys('cleanup.run'), keywords: 'clean up finished remove delete merged worktrees undo' });
      add('Branches', 'Tick everything safe to remove', () => branchesPage.panel.tickAll(), { icon: 'check', kbd: keymap.keys('cleanup.all'), keywords: 'clean up tick all select finished merged' });
      add('Branches', 'Also delete them on GitHub (on or off)', () => branchesPage.panel.toggleRemote(), { icon: 'cloud', kbd: keymap.keys('cleanup.remote'), keywords: 'clean up remote github delete branches' });
    }
    if (state.view === 'catchup' && catchupPage) {
      add('Since', 'Mark since', () => catchupPage.markCaughtUp(), { icon: 'check', kbd: keymap.keys('catchup.caughtUp'), keywords: 'catch up checkpoint seen read merged landed' });
      add('Since', 'Since…', () => catchupPage.pickSince(), { icon: 'history', kbd: keymap.keys('catchup.since'), keywords: 'catch up since checkpoint yesterday last week tag landed merged' });
      add('Since', 'Reload merged pull requests', () => catchupPage.reload(), { icon: 'restore', kbd: keymap.keys('catchup.reload'), keywords: 'catch up refresh fetch github merged pull requests ci gh' });
      if (catchupPage.canMore()) add('Since', 'Show everything that landed', () => catchupPage.showMore(), { icon: 'catchup', kbd: keymap.keys('catchup.more'), keywords: 'catch up more expand all timeline merged landed' });
      add('Since', 'Mark the next file viewed', () => catchupPage.markNextViewed(), { icon: 'check', kbd: keymap.keys('catchup.viewed'), keywords: 'catch up reader viewed tick fold file diff' });
    }
    add('View', 'Show branches that would conflict', () => showBranches('conflict'), { icon: 'branch', kbd: state.view === 'lanes' ? keymap.keys('lanes.conflicts') : state.view === 'branches' ? keymap.keys('branches.tabConflict') : undefined, keywords: 'branches predicted conflicts forecast merge-tree overlap worktrees' });
    if (state.view === 'branches' && branchesPage && !state.review) {
      for (const t of BRANCH_TABS) add('Branches', `Show ${t.label}`, () => branchesPage.setTab(t.id), { icon: 'branch', kbd: keymap.keys(t.keyId), detail: branchesPage.tab() === t.id ? 'current' : null, keywords: 'branches tab active agent made would conflict idle finished clean up worktrees' });
      const sel = branchesPage.selected();
      if (sel) {
        const n = sel.lane.name;
        const can = (id) => branchesPage.can(id);
        add('Branches', `Show ${n} in the Map`, () => branchesPage.run('open'), { icon: 'map', kbd: keymap.keys('branches.open'), keywords: 'branch open worktree switch map' });
        if (can('review')) add('Branches', `Review ${n}`, () => branchesPage.run('review'), { icon: 'check', kbd: keymap.keys('branches.review'), keywords: 'branch review diff changes' });
        if (can('merge')) add('Branches', `Merge and tidy ${n}…`, () => branchesPage.run('merge'), { icon: 'merge', kbd: keymap.keys('branches.merge'), keywords: 'branch squash merge tidy land', detail: gitWhy('mergeHere') });
        if (can('rebase')) add('Branches', `Rebase ${n} onto ${sel.base}`, () => branchesPage.run('rebase'), { icon: 'rebase', kbd: keymap.keys('branches.rebase'), keywords: 'branch rebase update base conflicts' });
        if (can('checks')) add('Branches', `Open checks of ${n}`, () => branchesPage.run('checks'), { icon: 'external', kbd: keymap.keys('branches.checks'), keywords: 'branch ci checks pull request github' });
        if (can('delete')) add('Branches', `${sel.lane.changes ? 'Discard' : 'Delete'} ${n}…`, () => branchesPage.run('delete'), { icon: 'trash', kbd: keymap.keys('branches.delete'), keywords: 'branch delete remove worktree undo' });
        if (can('cleanup')) add('Branches', `Clean up ${n}…`, () => branchesPage.run('cleanup'), { icon: 'trash', kbd: keymap.keys('branches.cleanup'), keywords: 'branch finished merged clean up tidy remove' });
      }
    }
    if (state.view === 'lanes' && lanesOpen()) {
      add('Review', 'Show every active branch in Branches', () => showBranches('active'), { icon: 'branch', kbd: keymap.keys('lanes.all'), keywords: 'review branches every branch worktree local active everything else' });
      add('Review', 'Show agent-made branches in Branches', () => showBranches('agents'), { icon: 'branch', kbd: keymap.keys('lanes.agents'), keywords: 'review branches agent ai made worktrees' });
    }
    if (state.view === 'lanes' && lanesOpen() && lanesPage?.setTab) {
      for (const [id, label, keyId] of [['needs', 'Needs you', 'lanes.tabNeeds'], ['stuck', 'Stuck', 'lanes.tabStuck'], ['ready', 'Ready', 'lanes.tabReady'], ['inProgress', 'In progress', 'lanes.tabProgress'], ['open', 'All open', 'lanes.tabAll']]) {
        add('Review', `Show ${label}`, () => lanesPage.setTab(id), { icon: 'lanes', kbd: keymap.keys(keyId), detail: lanesPage.tab() === id ? 'current' : null, keywords: 'review tab list stuck ready merge in progress open pull requests needs you' });
      }
    }
    add('View', state.show.agentLanes !== false ? 'Stop marking agent-made branches' : 'Mark branches that look agent-made', () => toggleShow('agentLanes'), { icon: 'lanes', keywords: 'agent ai coding badge branch worktree settings' });
    add('View', state.show.unified ? 'Show staged and unstaged separately' : 'Show changes as one list', () => { toggleShow('unified'); if (state.view !== 'commit') setView('commit'); }, { icon: 'commit', kbd: state.view === 'commit' ? keymap.keys('cv.layout') : null, keywords: 'split unified layout changes staged unstaged one list page tick box stage lines hunks commit view settings' });
    add('View', state.show.swatches ? 'Hide colour swatches in diffs' : 'Show colour swatches in diffs', () => toggleShow('swatches'), { icon: 'theme', kbd: keymap.keys('view.swatches'), keywords: 'color colour swatch preview css hex rgb settings' });
    add('View', detailToggleLabel(), () => { setView('map'); toggleDetail(); }, { icon: 'panelRight', kbd: keymap.keys('global.detail'), keywords: 'toggle commit details inspector right panel sidebar show hide' });
    add('View', 'Reset pane sizes', resetPanes, { icon: 'sidebar', kbd: keymap.keys('global.resetPanes'), keywords: 'resize width sidebar file list stash panel pane default restore drag' });
    add('View', sidebarToggleLabel(sbState()), toggleSidebar, { icon: 'sidebar', kbd: keymap.keys('view.sidebar'), keywords: 'toggle sidebar collapse minimize expand rail' });
    THEMES.forEach((t) => add('View', `Theme: ${t.label}`, () => setTheme(t.id), { icon: t.icon, detail: state.theme === t.id ? 'current' : null, keywords: 'appearance light dark mode system' }));
    add('View', 'Cycle theme', cycleTheme, { icon: 'theme', kbd: THEME_KBD, keywords: 'appearance light dark mode' });
    const sel = state.commits[state.index.get(state.selected)];
    if (sel) add('Commit', 'Checkout selected commit', () => checkoutSelected(sel), { icon: 'checkout', kbd: keymap.keys('commit.checkoutBranch'), detail: sel.sha === state.head.oid ? 'already HEAD' : sel.sha.slice(0, 7), keywords: 'checkout switch detach head' });
    if (sel && authorProfile(sel.email, originRemote()?.web)) add('Commit', 'View author on GitHub', () => openAuthor(sel), { icon: 'external', kbd: keymap.keys('commit.author'), detail: sel.author, keywords: 'author profile github user person' });
    if (sel && originRemote()?.web) add('Commit', 'Copy link to selected commit', () => copyCommitLink(sel.sha), { icon: 'copy', kbd: keymap.keys('map.copyLink'), detail: sel.sha.slice(0, 7), keywords: 'copy link url share permalink github web' });
    if (sel) add('Commit', 'Split selected commit…', () => guarded('commit.split', sel, () => openSplit(sel)), { icon: 'split', kbd: keymap.keys('commit.split'), detail: sel.sha.slice(0, 7), keywords: 'split commit lines hunks rewrite' });
    add('View', 'Jump to HEAD', () => jumpTo(state.head.oid), { icon: 'checkout' });
    add('App', 'Open repository…', () => openRepo(), { icon: 'folder', kbd: keymap.keys('file.open') });
    add('App', 'Switch repository…', repoSwitcher, { icon: 'folder', kbd: keymap.keys('file.repoSwitch'), keywords: 'recent open project switch' });
    for (const x of recent) add('Recent repositories', `Switch to ${x.name}`, () => openRepo(x.root), { icon: 'folder', detail: tildePath(x.root), keywords: `recent repository open ${x.root}` });
    add('App', 'Clone repository…', cloneRepo, { icon: 'fetch' });
    add('App', 'New tab', () => api.app('tab', 'new'), { icon: 'plus', kbd: keymap.keys('file.newTab') });
    add('App', 'New window', () => api.app('new-window'), { icon: 'plus', kbd: keymap.keys('file.newWindow') });
    add('App', 'Close tab', () => api.app('tab', 'close'), { icon: 'x', kbd: keymap.keys('file.close') });
    if (canReopenTab) add('App', 'Reopen closed tab', () => api.app('tab', 'reopen'), { icon: 'undo', kbd: keymap.keys('file.reopenTab'), keywords: 'restore tab window' });
    if (tabList.length > 1) {
      add('App', 'Next tab', () => api.app('tab', 'next'), { icon: 'chevron', kbd: keymap.keys('tab.next') });
      add('App', 'Previous tab', () => api.app('tab', 'prev'), { icon: 'chevronLeft', kbd: keymap.keys('tab.prev') });
      tabList.forEach((t, i) => {
        const key = i < TAB_KEYS.length ? TAB_KEYS[i] : i === tabList.length - 1 ? 'tab.last' : null;
        if (!t.active) add('Tabs', t.title, () => api.app('tab', 'select', t.id), { icon: 'folder', kbd: key ? keymap.keys(key) : undefined, keywords: 'tab switch' });
      });
    }
    add('App', 'Close repository', closeRepo, { icon: 'x' });
    add('App', 'Remove from recent…', removeFromRecent, { icon: 'x', keywords: 'recent repository forget clear' });
    if (update.status === 'ready') add('App', `Restart to update to ${update.version}`, installUpdate, { icon: 'update', keywords: 'update upgrade version install' });
    else add('App', 'Check for updates', checkUpdates, { icon: 'update', detail: update.current ? `v${update.current}` : null, keywords: 'update upgrade version' });
    add('App', 'Export shortcuts…', exportShortcuts, { icon: 'command', keywords: 'keys keymap bindings custom save file json' });
    add('App', 'Import shortcuts…', importShortcuts, { icon: 'command', keywords: 'keys keymap bindings custom load file json' });
    add('App', 'Reset all shortcuts to defaults', resetShortcuts, { icon: 'command', keywords: 'keys keymap bindings custom restore default' });
    add('App', 'Preferences…', () => openPrefs(), { icon: 'config', kbd: keymap.keys('app.settings'), keywords: 'settings options config general appearance sidebar git' });
    if (state.repo) add('Repository', 'Repository settings…', () => openPrefs('repository'), { icon: 'config', kbd: keymap.keys('view.config'), keywords: 'git config configuration option local' });
    add('App', 'Keyboard shortcuts', openShortcuts, { icon: 'command', kbd: keymap.keys('help.shortcuts'), keywords: 'keys keymap bindings hotkeys cheat sheet help' });
    add('App', 'Choose defaults…', openSetup, { icon: 'check', kbd: keymap.keys('global.setup'), keywords: 'settings preferences setup onboarding defaults features welcome' });
    add('App', update.auto === false ? 'Turn on automatic update checks' : 'Turn off automatic update checks', toggleAutoUpdate, { icon: 'update', keywords: 'update automatic auto check daily settings' });
    for (const r of state.refs) {
      if (r.kind === 'branch' && r.short !== state.head.branch) add('Branches', `Checkout ${r.short}`, () => checkout(r.short), { icon: 'branch', detail: timeAgo(r.date) });
    }
    for (const r of state.refs) {
      add('Refs', `Go to ${r.short}`, () => jumpTo(r.target), { icon: r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'branch' });
    }
    for (const c of state.commits.slice(0, 5000)) {
      add('Commits', c.subject ?? c.sha.slice(0, 7), () => jumpTo(c.sha), { icon: 'commit', detail: c.sha.slice(0, 7), keywords: c.sha.slice(0, 10) + ' ' + c.author });
    }
    return items;
  });
  recentRepos(PALETTE_RECENT_LIMIT).then((list) => { recent = list; if (list.length) pal?.refresh(); });
}

async function repoMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const recent = await recentRepos(PALETTE_RECENT_LIMIT);
  contextMenu(r.left, r.bottom + 4, [
    recent.length ? { section: 'Recent repositories' } : null,
    ...recent.map((x) => ({ label: x.name, icon: 'folder', run: () => openRepo(x.root) })),
    recent.length ? '-' : null,
    { label: 'Open Repository…', icon: 'folder', kbd: keymap.keys('file.open'), run: () => openRepo() },
    { label: 'Clone Repository…', icon: 'fetch', run: cloneRepo },
    { label: 'New Window', icon: 'plus', kbd: keymap.keys('file.newWindow'), run: () => api.app('new-window') },
    '-',
    { label: 'Open in Finder', icon: 'folder', run: () => api.app('reveal') },
    { label: 'Open in Terminal', icon: 'terminal', run: () => api.app('terminal') },
    { label: 'Open in Hosting Service', icon: 'external', run: openHosting },
    '-',
    { label: 'Close Repository', icon: 'x', run: closeRepo },
  ], { trigger: anchor });
}

async function resetHard() {
  if (await confirm('Reset hard to HEAD?', `All uncommitted changes to tracked files are removed. You can undo this with ${MOD}Z.`, { submit: 'Reset' })) act('Reset hard to HEAD', 'resetHard', []);
}

async function openHosting() {
  const remotes = state.remotes.length ? state.remotes : await git('remotes').catch(() => []);
  const r = remotes.find((x) => x.name === 'origin' && x.web) || remotes.find((x) => x.web);
  if (r) api.app('external', r.web); else toast('No web URL for remotes', { kind: 'error' });
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { repoMenu, openPalette });

export { openPalette, resetHard, openHosting, repoSwitcher };
