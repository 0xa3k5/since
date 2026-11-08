// IPC for pull requests, catch-up, worktree handoffs and repository setup.
import electron from 'electron';
const { app, dialog, shell, clipboard } = electron;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as git from '../git/index.ts';
import * as check from '../ipc.ts';
import { menuChanged } from '../app-events.ts';
import * as catchupStore from '../stores/catchup-store.ts';
import * as ai from '../ai.ts';
import * as github from '../github.ts';
import * as prMedia from '../pr-media.ts';
import * as mergePlan from '../../renderer/lanes/merge-plan.js';
import * as sendBack from '../../renderer/lanes/send-back.js';
import { readSettings, writeSettings, addRecent, removeRecent, isMac } from '../settings.ts';
import { sessions, session, currentRepoGen, windowFor, RepoSession, notifyWindows, notRepoDirs, handoffs } from '../session.ts';
import { handle, okCall, serializeError } from './handle.ts';
import { tabOf, windowOf, createWindow, hasClosedTabs, closeTab, reopenClosed } from '../windows.ts';
import { r, plainMutations } from './git.ts';
import { aiSettings } from './ai.ts';
import type { IpcError } from '../../shared/ipc-contract.ts';

type Ev = Electron.IpcMainInvokeEvent;
/** Options a PR action takes from the renderer; each one is checked where it is used. */
type PrOpts = { body?: unknown; method?: unknown; deleteBranch?: unknown; admin?: unknown; rebase?: unknown } | null | undefined;
type MergedPrs = Awaited<ReturnType<typeof github.mergedPrs>>;
/** A window's tab (windows.ts); every page that sends IPC has one, and a session's window is one. */
type Tab = NonNullable<ReturnType<typeof tabOf>>;
const tabFor = (e: Ev): Tab => { const t = tabOf(e); if (!t) throw new Error('This page has no tab.'); return t; };
// Merge plan's working data: built from gh's answers (github.ts) and passed through
// renderer/lanes/merge-plan.js, which is still JavaScript. It gets real types when that module
// moves to TypeScript (the renderer part of this migration).
// biome-ignore lint: see above
type PlanData = any;

// ---------------------------------------------------------------------------
// Pull request status through the user's GitHub CLI (github.js). One user-wide flag, plus a
// per-repository hide. The first time it's needed, a fresh install turns it on if `gh` is installed
// and logged in, and an upgrade turns it on if any repository had it on (the old per-repository
// keys are dropped). Otherwise `gh` only runs when the user fetches or refreshes PRs.

let prInit: Promise<void> | null = null;
const prSettings = () => (prInit ||= (async () => {
  const saved = readSettings().github;
  let s = github.normalize(saved);
  if (s.on === null) s = { ...s, on: (await github.ghStatus()) === 'ready' };
  if (JSON.stringify(saved) !== JSON.stringify(s)) writeSettings({ github: s });
})().catch(() => { prInit = null; }));
const prEnabled = async (root: string): Promise<boolean> => { await prSettings(); return github.isEnabled(readSettings().github, root); };
// The repository's remotes with the one chosen for PRs (Preferences → Pull requests) marked `pr: true`,
// which github.pickRemote prefers. Every PR path reads remotes through here (AK-461).
async function prRemotes(root: string) {
  const chosen = github.chosenRemote(readSettings().github, root);
  return (await git.getRemotes(root)).map((r) => (r.name === chosen ? { ...r, pr: true } : r));
}
// The user-wide switch works before a repository is open (the welcome screen's setup step).
async function prState(e: Ev) {
  const root = sessions.get(e.sender.id)?.repo?.root;
  await prSettings();
  const saved = readSettings().github;
  const remotes = root ? await prRemotes(root).catch(() => []) : [];
  const remote = github.pickRemote(remotes);
  const choices = github.prCandidates(remotes);
  const chosen = root ? github.chosenRemote(saved, root) : null;
  const enabled = github.normalize(saved).on === true;
  const hidden = root ? github.isHidden(saved, root) : false;
  return { enabled, hidden, active: enabled && !hidden && Boolean(remote), remote, choices, chosen: choices.some((c) => c.name === chosen) ? chosen : null, gh: github.ghInstalled() ? 'installed' : 'missing', installUrl: github.INSTALL_URL };
}
handle('app:pr-state', (e) => prState(e));
handle('app:pr-detect', okCall(async (e) => {
  const s = sessions.get(e.sender.id);
  return github.detect({ remotes: s ? await prRemotes(s.repo.root) : null });
}));
// gh is logged out (AK-588): Terminal opens running `gh auth login` for this repo's GitHub host
// (github.com without a repo). No arguments from the renderer: the host comes from the remote.
handle('app:gh-login', okCall(async (e) => {
  const s = sessions.get(e.sender.id);
  const remote = s ? github.pickRemote(await prRemotes(s.repo.root)) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-gh-'));
  const file = path.join(dir, 'gh-login.command');
  fs.writeFileSync(file, github.loginScript(remote ? remote.host : 'github.com'), { mode: 0o700 });
  spawn('open', ['-a', 'Terminal', file], { detached: true });
  return true;
}));
handle('app:pr-enable', async (e, on) => {
  const v = check.bool(on, 'pull requests on');
  await prSettings();
  writeSettings({ github: github.setEnabled(readSettings().github, v) });
  return prState(e);
});
handle('app:pr-hide', async (e, hide) => {
  const v = check.bool(hide, 'hide pull requests');
  await prSettings();
  writeSettings({ github: github.setHidden(readSettings().github, session(e).repo.root, v) });
  return prState(e);
});
// The remote the PR features use in this repository; null goes back to the default.
handle('app:pr-remote', async (e, name) => {
  const root = session(e).repo.root;
  const chosen = name === null ? null : check.str(name, 'remote');
  if (chosen !== null && !github.prCandidates(await git.getRemotes(root)).some((r) => r.name === chosen)) throw new check.IpcArgError('Unknown remote');
  await prSettings();
  writeSettings({ github: github.setChosenRemote(readSettings().github, root, chosen) });
  return prState(e);
});
handle('app:pr-list', okCall(async (e) => {
  const s = session(e);
  const root = s.repo.root;
  // Checked before anything else, so nothing runs while it's off or hidden here.
  if (!(await prEnabled(root))) return null;
  const remotes = await prRemotes(root);
  // No GitHub remote: no PRs, quietly.
  if (!github.pickRemote(remotes)) return null;
  const { signal } = s.closed;
  return github.listPrs({ enabled: true, remotes, signal }).catch((err: Error) => { if (signal.aborted) return null; throw err; });
}));

// Lanes overview: every local branch and worktree (git.lanes), with open PRs joined on by head
// branch. Local only unless the caller asks for PRs ({ prs: true }) and pull requests are on
// here; then it's the same single `gh pr list` as app:pr-list. A gh failure leaves `pr: null`
// on every lane and comes back as `prError`, so the local data still shows. The PR inbox tab
// adds { inbox: true }: every open PR (`prs`), plus github.inbox (review requests, your login).
handle('app:lanes-list', async (e, opts) => {
  if (opts != null && (typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some((k) => !['base', 'prs', 'inbox'].includes(k)))) throw new check.IpcArgError('Invalid lanes options');
  const o = opts as { base?: unknown; prs?: unknown; inbox?: unknown } | null | undefined; // keys checked above
  const base = o?.base == null ? undefined : check.rev(o.base, 'base');
  const withPrs = o?.prs == null ? false : check.bool(o.prs, 'prs');
  const withInbox = o?.inbox == null ? false : check.bool(o.inbox, 'inbox');
  // Closing the repository cancels this load: its gh calls stop, nothing runs after them, and
  // the page that asked (gone with the repository) gets null.
  const s = session(e);
  const root = s.repo.root;
  const { signal } = s.closed;
  // The local lanes don't wait for `gh` (AK-639): both run at once, and every caller that asks while a
  // run is in flight shares it (git.sharedLanes). Merged PRs add the "shipped" check after (prShipped).
  const gh = async () => {
    const out: { listed: github.ListedPrs | null; prError: IpcError | null; inbox: Awaited<ReturnType<typeof github.inbox>> | null; inboxError: IpcError | null; prHeads: MergedPrs } = { listed: null, prError: null, inbox: null, inboxError: null, prHeads: [] };
    if (!(await prEnabled(root))) return out;
    const remotes = await prRemotes(root);
    if (!github.pickRemote(remotes)) return out;
    // A failed inbox or merged-PR lookup (token scope, Enterprise) keeps the PR list and the
    // lane badges; merged PRs only add the "shipped" check.
    const [l, i, m] = await Promise.allSettled([
      github.listPrs({ enabled: true, remotes, signal }),
      withInbox ? github.inbox({ enabled: true, remotes, signal }) : null,
      github.mergedPrs({ enabled: true, remotes, signal }),
    ]);
    if (l.status === 'fulfilled') out.listed = l.value ?? null;
    else out.prError = serializeError(l.reason);
    if (i.status === 'fulfilled') out.inbox = i.value;
    else if (!out.prError) out.inboxError = serializeError(i.reason);
    if (m.status === 'fulfilled') out.prHeads = m.value;
    return out;
  };
  const [res, { listed, prError, inbox, inboxError, prHeads }] = await Promise.all([
    git.sharedLanes(root, { base, gen: currentRepoGen() }),
    withPrs ? gh() : { listed: null, prError: null, inbox: null, inboxError: null, prHeads: [] as MergedPrs },
  ]);
  if (signal.aborted) return null;
  const rest = { base: res.base, baseRef: res.baseRef, baseSha: res.baseSha };
  const lanes = git.prShipped(res, prHeads);
  s.lanes = { root, baseSha: rest.baseSha, lanes };
  const joined = github.joinLanes(lanes, listed);
  if (!withInbox) return { ...rest, lanes: joined, prError };
  return { ...rest, lanes: joined, prError, prs: listed?.prs || null, remote: listed?.remote.name || null, viewer: listed?.viewer || null, inbox, inboxError };
});

// Conflict forecast for the lanes app:lanes-list last returned in this window (git-only, no
// network). A new request cancels the one still running; the cancelled one resolves to null.
handle('app:lanes-forecast', async (e) => {
  const s = session(e);
  if (!s.lanes || s.lanes.root !== s.repo.root) return { supported: true, pairs: [] };
  s.forecast?.abort();
  const ctrl = new AbortController();
  s.forecast = ctrl;
  try {
    return await git.forecastConflicts(s.lanes.root, s.lanes.lanes, { baseSha: s.lanes.baseSha, signal: ctrl.signal });
  } catch (caught) { const err = caught as Error & { code?: unknown };
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  } finally {
    if (s.forecast === ctrl) s.forecast = null;
  }
});

// Review's catch-up card (AK-281): what landed on the base since the checkpoint (or since
// yesterday, last week or a tag), from git log. With { prs: true } and pull requests on here, the
// merged PRs (the same `gh pr list --state merged` call as app:lanes-list) are joined on by merge
// commit, plus the base's CI (`gh run list --branch <base>`); with pull requests off, no gh calls.
// { base } (AK-374) reads another branch instead: a full ref name, refs/heads/… or refs/remotes/…
// (the `name` of a branch or remote ref from `refs`). The checkpoint belongs to the default base,
// so another branch has none (checkpoint: null, Mark caught up doesn't apply) and a checkpoint
// read falls back to last week (kind: 'week').
const catchupFile = () => path.join(app.getPath('userData'), 'catchup.json');
const tipOf = async (root: string) => {
  const r = await git.landed(root, {});
  return r && { sha: r.baseSha, base: r.base, date: r.baseDate };
};
handle('app:catchup', async (e, opts) => {
  const s = session(e);
  const root = s.repo.root;
  const { signal } = s.closed; // closing the repository stops the gh calls (→ null)
  const { kind, tag, withPrs, base, isDefault, cp, since } = await catchupStore.catchupOptions(opts, {
    defaultRef: async () => (await git.laneBase(root))?.ref ?? null,
    checkpoint: () => catchupStore.checkpoint(catchupFile(), root),
  });
  const res = await git.landed(root, { base, since });
  if (!res) return null;
  let merged: MergedPrs | null = null;
  let ci: Awaited<ReturnType<typeof github.baseCi>> = null;
  let prError: IpcError | null = null;
  if (withPrs && (await prEnabled(root))) {
    const remotes = await prRemotes(root);
    if (github.pickRemote(remotes)) {
      const remote = remotes.find((r) => res.base.startsWith(`${r.name}/`));
      const branch = remote ? res.base.slice(remote.name.length + 1) : res.base;
      const [m, c] = await Promise.allSettled([github.mergedPrs({ enabled: true, remotes, signal }), github.baseCi({ enabled: true, remotes, branch, signal })]);
      if (signal.aborted) return null;
      if (m.status === 'fulfilled') merged = m.value; else prError = serializeError(m.reason);
      if (c.status === 'fulfilled') ci = c.value;
      // Merged stacks (AK-616): which merged PRs in range were parts of a GitHub stack. If that
      // lookup fails, Catch up lists them one by one, without an error.
      const landed = new Set(res.commits.map((x) => x.sha));
      const numbers = (merged || []).filter((p) => p.merge && landed.has(p.merge)).map((p) => p.number);
      if (numbers.length) {
        const facts = await github.mergedStacks({ enabled: true, remotes, numbers, signal }).catch((err: Error) => { console.warn('could not read merged stacks', err.message); return null; });
        if (signal.aborted) return null;
        merged = github.joinStacks(merged ?? [], facts);
      }
    }
  }
  return { ...res, kind, tag, checkpoint: cp, defaultBase: isDefault, merged, ci, prError };
});
// Mark caught up: the checkpoint becomes the base tip the card showed. → the checkpoint it replaced,
// which the renderer sends back to undo.
handle('app:catchup-mark', (e, to) => {
  const t = check.obj(to, 'checkpoint', { sha: (v, w) => (v === null ? v : check.oid(v, w)), base: (v, w) => (v === null ? v : check.rev(v, w)), date: (v, w) => { if (!Number.isFinite(v)) throw new check.IpcArgError(`Invalid ${w}`); }, source: check.oneOf('mark', 'opened', 'week'), at: () => {} });
  if (!Number.isFinite(t.date)) throw new check.IpcArgError('Invalid checkpoint.date');
  return catchupStore.mark(catchupFile(), session(e).repo.root, t as { sha?: string | null; base?: string | null; date: number; source?: string }); // fields checked above
});

// Approve, merge, close and update branch: remote actions on GitHub, not journaled (⌘Z can't undo them). The
// renderer names the PR and the remote it came from; both are checked before `gh` runs.
const prAction = (fn: (t: github.GhCall, o: PrOpts) => unknown) => okCall(async (e, remoteName, number, opts) => {
  const root = session(e).repo.root;
  check.prNumber(number);
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  return fn({ enabled: await prEnabled(root), remotes: [remote], number }, opts as PrOpts);
});
handle('app:pr-merge-info', prAction((t) => github.mergeInfo(t)));
handle('app:pr-approve', prAction((t, o) => github.approvePr({ ...t, body: check.str(o?.body ?? '', 'review comment', { empty: true }) })));
handle('app:pr-request-changes', prAction((t, o) => github.requestChangesPr({ ...t, body: check.str(o?.body ?? '', 'review comment') })));
handle('app:pr-merge', prAction((t, o) => github.mergePr({
  ...t,
  method: check.oneOf(...github.MERGE_METHODS)(o?.method, 'merge method'),
  deleteBranch: check.bool(o?.deleteBranch, 'delete branch'),
  admin: check.bool(o?.admin, 'merge as admin'),
})));
handle('app:pr-close', prAction((t, o) => github.closePr({ ...t, body: check.str(o?.body ?? '', 'close comment', { empty: true }) })));
// Merge plan fixes (AK-550): mark a draft ready, re-run failed Actions jobs. Opt-in like every
// PR action: target() refuses while pull requests are off.
handle('app:pr-ready', prAction((t) => github.markReady(t)));
// Back to draft (AK-610): the PR's author or anyone with write access; GitHub decides.
handle('app:pr-draft', prAction((t) => github.markDraft(t)));
handle('app:pr-rerun-failed', prAction((t) => github.rerunFailed(t)));
handle('app:pr-update-branch', prAction((t, o) => github.updatePrBranch({ ...t, rebase: check.bool(o?.rebase ?? false, 'rebase') })));
// Review's re-check (AK-625): GitHub's merge state for the open PRs it was still working out on
// the last PR load (github.mergeStates, read-only). Only while pull requests are on (target() checks).
handle('app:pr-merge-states', okCall(async (e, remoteName, numbers) => {
  const root = session(e).repo.root;
  if (!Array.isArray(numbers) || numbers.length > github.LIMIT) throw new check.IpcArgError('Invalid pull request numbers');
  const ns = numbers.map((n) => check.prNumber(n));
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  return github.mergeStates({ enabled: await prEnabled(root), remotes: [remote], numbers: ns });
}));
// Send back: the failed CI log's last lines, and posting the prompt as a PR comment. Both only on
// an explicit click in the sheet, and only while pull requests are on (target() checks).
handle('app:pr-failed-log', prAction((t) => github.failedLog(t)));
// PR evidence (AK-519): checks, failed CI log lines, annotations, media, approvals and open thread
// counts for the PR reader, from `gh` (github.evidence), cached per head commit. Only while pull
// requests are on. Media come back with ids; the main process loads them (pr-media.js).
export const media = prMedia.createMedia({ token: (host) => github.authToken({ host }) });
const CI_FILES = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/.+)$/;
async function ciConfigured(root: string, sha: unknown): Promise<boolean> {
  const head = typeof sha === 'string' ? sha : '';
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return false;
  const out = await git.run(root, ['ls-tree', '-r', '--name-only', head, '--', '.github/workflows', '.gitlab-ci.yml', '.circleci']).catch(() => '');
  return out.split('\n').some((f) => CI_FILES.test(f));
}
handle('app:pr-evidence', okCall(async (e, remoteName, number, opts) => {
  const root = session(e).repo.root;
  check.prNumber(number);
  const o = check.obj(opts ?? {}, 'evidence options', { head: (v, w) => (v == null ? v : check.oid(v, w)) });
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  const ev = await github.evidence({ enabled: await prEnabled(root), remotes: [remote], number, head: (o.head as string | null | undefined) ?? null, ciConfigured: (head) => ciConfigured(root, head) });
  return ev.media ? { ...ev, media: media.register(ev.media, github.parseRemote(remote)?.host ?? '') } : ev;
}));
handle('app:pr-media-image', okCall((_e, id) => media.image(check.mediaId(id))));
handle('app:pr-comment', prAction((t, o) => github.commentPr({ ...t, body: check.str(o?.body ?? '', 'comment') })));
const planErr = (message: string, code = 'gh-failed') => Object.assign(new Error(message), { code });
const oidArg = (v: unknown, w: string) => check.oid(v, w);
async function planTarget(e: Ev, remoteName: unknown, base: unknown) {
  const s = session(e);
  if (!(await prEnabled(s.repo.root))) throw planErr('Pull requests are off for this repository.', 'gh-off');
  if (!(await git.canForecast(s.repo.root))) throw planErr('Merge plan needs git 2.38 or later.', 'git-version');
  const remote = check.knownRemote(await git.getRemotes(s.repo.root), remoteName);
  return { s, remote, base: check.rev(base, 'base branch'), t: { enabled: true, remotes: [remote] } };
}
async function remoteBase(s: RepoSession, remote: { name: string }, base: string): Promise<string> {
  const out = await r(s, ['ls-remote', '--', remote.name, `refs/heads/${base}`]);
  const oid = out.split(/\s/)[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw planErr(`${base} isn’t on ${remote.name}.`);
  return oid;
}
// opts (AK-545): { method: squash | merge | rebase (squash when absent), stacks: plan native
// stacks as one unit each }. → the plan plus { methods: { allowed, default, saved, used }, stacks:
// [{ id, prs, linear, blocker, native }] }.
handle('app:merge-plan', okCall(async (e, remoteName, baseName, ready, others, opts) => {
  const { s, remote, base, t } = await planTarget(e, remoteName, baseName);
  if (!Array.isArray(ready) || !Array.isArray(others)) throw new check.IpcArgError('Invalid merge plan');
  const flag = (v: unknown, w: string) => (v == null ? v : check.bool(v, w));
  const po = check.obj(opts ?? {}, 'merge plan options', { method: (v, w) => (v == null ? v : check.oneOf(...mergePlan.METHODS)(v, w)), stacks: flag, anyway: flag });
  const anyway = po.anyway === true;
  const method = (po.method as string | null | undefined) || 'squash';
  const numbers = ready.slice(0, mergePlan.MAX_READY).map((n) => check.prNumber(n));
  let rest: PlanData[] = others.slice(0, mergePlan.MAX_OTHERS).map((o) => check.obj(o, 'open pull request', { number: check.prNumber, head: oidArg }));
  const repoMethods = await github.repoMergeMethods(t);
  if (!repoMethods.allowed.includes(method)) throw planErr(`${methodName(method)} is off in this repo’s settings.`);
  const methods = { ...repoMethods, saved: savedMethod(s.repo.root), used: method };
  // Native stacks (AK-545): found among every open PR, then each member is checked like a ready PR.
  let found: PlanData[] = [];
  let chainFacts: PlanData = new Map();
  const openList = await github.openPrBranches(t).catch(() => []);
  if (po.stacks) {
    let total = 0;
    found = mergePlan.findStacks(openList, base).filter((st) => (total += st.prs.length) <= mergePlan.MAX_STACKED);
    // AK-555: which of them GitHub has as a stack (merged with `gh stack merge`; the rest one by one).
    if (found.length) chainFacts = await github.stackFacts({ ...t, numbers: found.flatMap((st) => st.prs) }).catch(() => new Map());
    // Plan each chain's bottom part only, cut where GitHub's stacks begin or end (AK-541): a mix of
    // a GitHub stack and plain PRs can't merge as one unit. What's above waits for it.
    found = found.map((st) => mergePlan.bottomPart(st, chainFacts)).filter(Boolean);
  }
  const inStack = new Set(found.flatMap((st) => st.prs));
  const singles = numbers.filter((n) => !inStack.has(n));
  rest = rest.filter((o) => !inStack.has(o.number));
  const asked = [...singles, ...inStack];
  // GitHub's own merge rules decide (AK-550): blockers per PR, each marked required or not.
  const infos = new Map<number, PlanData>(await Promise.all(asked.map(async (number): Promise<[number, PlanData]> => [number, await github.planFacts({ ...t, number }).catch((err: Error) => ({ error: err.message }))])));
  const snapOf = (info: PlanData) => ({ head: info.headOid, checks: info.checks, review: info.review });
  const prs: PlanData[] = [], skipped: { number: number; reason: string }[] = [], reasons = new Map<number, string>(), blockers: Record<number, PlanData[]> = {};
  const leaveOut = (n: number, list: PlanData[]) => { blockers[n] = list; reasons.set(n, mergePlan.blockerText(mergePlan.mainBlocker(list))); };
  for (const n of asked) {
    const info = infos.get(n);
    const list = info.headOid || info.error ? mergePlan.blockersOf(info) : [{ kind: 'error', required: true, detail: 'GitHub didn’t name its head commit.' }];
    if (list.length) blockers[n] = list;
    if (mergePlan.waits(list, anyway)) leaveOut(n, list);
  }
  // Never merge a PR into another PR's branch (AK-541): one that targets a branch other than the
  // plan's waits for the PR below it, whatever planFacts said.
  const baseOf = new Map(openList.map((p) => [p.number, p.baseBranch]));
  const prOn = new Map(openList.map((p) => [p.branch, p.number]));
  for (const n of singles) {
    const b = baseOf.get(n);
    if (b && b !== base) leaveOut(n, [{ kind: 'other', required: true, detail: prOn.has(b) ? `Waits for #${prOn.get(b)} below it` : `Targets ${b}` }]);
  }
  for (const n of singles) {
    if (reasons.has(n)) skipped.push({ number: n, reason: reasons.get(n) ?? '' });
    else prs.push({ number: n, head: infos.get(n).headOid, snap: snapOf(infos.get(n)) });
  }
  await r(s, ['fetch', '--no-tags', '--', remote.name, `refs/heads/${base}`]);
  const baseSha = (await r(s, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  const has = async (oid: string) => Boolean((await r(s, ['cat-file', '-t', oid], { allowCodes: [0, 1, 128] }).catch(() => '')).trim() === 'commit');
  const heads = [...prs, ...rest, ...[...inStack].filter((n) => infos.get(n).headOid).map((n) => ({ number: n, head: infos.get(n).headOid }))];
  const missing: string[] = [];
  // PRs GitHub says conflict with the base: fetched too, to name the files.
  const dirty = singles.filter((n) => infos.get(n).conflicts && infos.get(n).headOid).map((n) => ({ number: n, head: infos.get(n).headOid }));
  for (const p of [...heads, ...dirty]) if (!(await has(p.head))) missing.push(`refs/pull/${p.number}/head`);
  if (missing.length) await r(s, ['fetch', '--no-tags', '--', remote.name, ...new Set(missing)]);
  const sim = method === 'rebase' ? git.simulateRebase : git.simulateSquash;
  for (const p of dirty) {
    if (!(await has(p.head))) continue;
    const files = (await sim(s.repo.root, baseSha, p.head)).files;
    const b = (blockers[p.number] ?? []).find((x: PlanData) => x.kind === 'conflicts-base');
    if (!b || !files.length) continue;
    b.files = files;
    leaveOut(p.number, blockers[p.number] ?? []);
    const sk = skipped.find((x) => x.number === p.number);
    if (sk) sk.reason = reasons.get(p.number) ?? '';
  }
  const known: PlanData[] = [];
  for (const o of rest) if (await has(o.head)) known.push(o);
  for (const p of prs.splice(0)) { if (await has(p.head)) prs.push(p); else { blockers[p.number] = [{ kind: 'error', required: true, detail: 'Couldn’t fetch its head commit.' }]; skipped.push({ number: p.number, reason: 'Couldn’t fetch its head commit.' }); } }
  // A stack plans whole, at its bottom PR's place in Review's order (else after the single PRs),
  // only when every PR in it is ready.
  const stacks: PlanData[] = [];
  for (const st of found) {
    const stHeads = st.prs.map((n: number) => infos.get(n)?.headOid);
    const blocker = mergePlan.stackBlocker(st, reasons);
    if (blocker) for (const n of st.prs) if (n !== blocker.number) (blockers[n] ||= []).push({ kind: 'stack', required: true, number: blocker.number });
    // No history check of our own: GitHub merges a stack with merge commits in it (checked on a
    // throwaway repo, 2026-10-18), and it evaluates its own rules when the merge runs.
    const linear = !blocker && stHeads.every(Boolean);
    // The whole stack, or the longest bottom part that merges with the base (maybe just one PR).
    const part = !blocker && linear ? await mergePlan.cleanPart(st, stHeads, (head: string) => sim(s.repo.root, baseSha, head)) : null;
    const unit = { stack: st.id, prs: part?.prs || st.prs, head: part?.head || stHeads[stHeads.length - 1] };
    const partial = part?.partial || null;
    stacks.push({ id: st.id, prs: st.prs, linear, blocker, partial, native: mergePlan.isNative(st, chainFacts) });
    if (blocker || !linear) continue;
    const at = numbers.indexOf(st.prs[0]);
    const i = at < 0 ? -1 : prs.findIndex((p) => (p.stack ? numbers.indexOf(p.prs[0]) : numbers.indexOf(p.number)) > at);
    prs.splice(i < 0 ? prs.length : i, 0, unit);
  }
  const plan: PlanData = await mergePlan.planOrder({ prs, others: known, baseSha, merge: (tip: string, head: string) => sim(s.repo.root, tip, head) } as PlanData);
  for (const b of plan.blocked) if (b.number) (blockers[b.number] ||= []).push({ kind: 'conflicts-pr', required: true, with: b.with, files: b.files });
  const snapshots = Object.fromEntries([...prs.filter((p) => !p.stack).map((p) => [p.number, p.snap]), ...[...inStack].filter((n) => !reasons.has(n)).map((n) => [n, snapOf(infos.get(n))])]);
  // anyway: the PRs only Merge anyway takes (just checks GitHub doesn't require failing or running).
  const anywayable = asked.filter((n) => blockers[n] && mergePlan.anywayOnly(blockers[n]));
  // The repo's default branch as this clone knows it (local, no network): the sheet starts there.
  const defaultBranch = (await r(s, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote.name}/HEAD`], { allowCodes: [0, 1, 128] }).catch(() => '')).trim().replace(`${remote.name}/`, '') || null;
  return { ...plan, base, baseSha, skipped, snapshots, methods, stacks, blockers, anyway: anywayable, defaultBranch };
}));
// Chains vs GitHub stacks (AK-555): the open PR chains on `base`, whether each is a GitHub stack
// already and, if not, whether it can be linked as one (why not, when it can't), plus whether
// GitHub CLI's stack extension is installed. → { extension, chains: [{ id, prs, native, linkable,
// why }] }.
async function chainTarget(e: Ev, remoteName: unknown, base: unknown) {
  const s = session(e);
  if (!(await prEnabled(s.repo.root))) throw planErr('Pull requests are off for this repository.', 'gh-off');
  const remote = check.knownRemote(await git.getRemotes(s.repo.root), remoteName);
  return { remote, base: base == null ? null : check.rev(base, 'base branch'), t: { enabled: true, remotes: [remote] } };
}
handle('app:pr-chains', okCall(async (e, remoteName, baseName) => {
  const { base, t } = await chainTarget(e, remoteName, baseName);
  if (!base) throw new check.IpcArgError('Invalid base branch');
  const host = github.pickRemote(t.remotes)?.host;
  const [open, ext] = await Promise.all([github.openPrBranches(t), github.stackExtension(t).catch(() => ({ installed: false }))]);
  let total = 0;
  const chains = mergePlan.findChains(open, base).filter((c) => (total += c.prs.length) <= mergePlan.MAX_STACKED);
  const facts = chains.length ? await github.stackFacts({ ...t, numbers: chains.flatMap((c) => c.prs) }).catch(() => new Map()) : new Map();
  return {
    extension: ext.installed,
    chains: chains.map((c) => {
      const native = !c.branch && mergePlan.isNative(c, facts);
      // A chain that's partly a GitHub stack already can't be linked: GitHub refuses PRs in two stacks.
      const why = native ? null : c.prs.some((n) => facts.get(n)?.stack) ? 'Part of it is already a GitHub stack' : mergePlan.chainWhy(c, { host });
      return { id: c.id, prs: c.prs, native, linkable: !native && !why, why, ...(c.branch ? { branch: c.branch } : {}) };
    }),
  };
}));
// Installs GitHub CLI's stack extension (`gh extension install github/gh-stack`), on a click.
handle('app:pr-stack-install', okCall(async (e, remoteName) => github.installStackExtension((await chainTarget(e, remoteName, null)).t)));
// Links a chain as a GitHub stack, bottom to top, all or nothing (github.linkStack). Remote, and
// not undoable with ⌘Z. → { linked: true, stack } | { failed: { number, reason } }.
handle('app:pr-stack-link', okCall(async (e, remoteName, baseName, numbers) => {
  const { base, t } = await chainTarget(e, remoteName, baseName);
  if (!base || !Array.isArray(numbers) || numbers.length < 2 || numbers.length > mergePlan.MAX_STACK) throw new check.IpcArgError('Invalid stack');
  const ns = numbers.map((n) => check.prNumber(n));
  if (new Set(ns).size !== ns.length) throw new check.IpcArgError('Invalid stack');
  return github.linkStack({ ...t, base, numbers: ns });
}));
// One step of a plan: { snap, baseSha, method } from the plan (or the previous merge's commit), or
// for a stack (AK-545) { stack: [{ number, snap }] bottom…top, baseSha, method } with `number` its
// top PR (just the bottom PR when only it merges clean, AK-619). Every PR is checked before the
// merge. → { stop: reason } when something changed, else { merged: true, commit } (commit null
// when a merge queue took it, so the plan stops there), plus `cleaned` (cleanupMerged) when
// o.cleanup is true: only the sheet asks for it.
const nullable = (v: unknown, w: string) => (v === null ? v : check.str(v, w, { max: 32 }));
const snapArg = (v: unknown, w: string) => check.obj(v, w, { head: oidArg, checks: nullable, review: nullable });
handle('app:merge-plan-merge', okCall(async (e, remoteName, baseName, number, o) => {
  const { s, remote, base, t } = await planTarget(e, remoteName, baseName);
  check.prNumber(number);
  const stackArg = (v: unknown, w: string) => {
    if (v == null) return v;
    if (!Array.isArray(v) || v.length > mergePlan.MAX_STACK) throw new check.IpcArgError(`Invalid ${w}`);
    v.forEach((x: PlanData) => { check.obj(x, w, { number: check.prNumber, snap: snapArg }); if (!x.snap) throw new check.IpcArgError(`Invalid ${w}`); });
    if (!mergePlan.stackStepOk(v.map((x: PlanData) => x.number), number)) throw new check.IpcArgError(`Invalid ${w}`);
    return v;
  };
  const step: PlanData = check.obj(o, 'merge step', { baseSha: oidArg, snap: (v: unknown, w: string) => ((o as PlanData)?.stack ? v : snapArg(v, w)), method: (v, w) => (v == null ? v : check.oneOf(...mergePlan.METHODS)(v, w)), stack: stackArg, cleanup: (v, w) => (v == null ? v : check.bool(v, w)) });
  if (!step.stack && !step.snap) throw new check.IpcArgError('Invalid merge step');
  const method = step.method || 'squash';
  const steps = step.stack || [{ number, snap: step.snap }];
  const now = await Promise.all(steps.map((x: PlanData) => github.mergeInfo({ ...t, number: x.number }).catch(() => null)));
  for (let i = 0; i < steps.length; i++) {
    const why = mergePlan.changedSince(steps[i].snap, now[i]);
    if (why) return { stop: `#${steps[i].number}: ${why}` };
  }
  if ((await remoteBase(s, remote, base)) !== step.baseSha) return { stop: `${base} moved on GitHub since the plan` };
  // A chain GitHub has as a stack merges with `gh stack merge`; a plain chain (AK-555) one PR at a
  // time, bottom up, each one after the bottom retargeted to the base first. A step of one PR
  // (AK-619) is `gh stack merge <bottom>` or that PR's own merge.
  const facts = step.stack ? await github.stackFacts({ ...t, numbers: steps.map((x: PlanData) => x.number) }) : null;
  if (step.stack && mergePlan.isNative({ prs: steps.map((x: PlanData) => x.number) }, facts)) await github.mergeStack({ ...t, number, method });
  else if (step.stack) {
    const done: number[] = [];
    const stopAt = (n: number, why: string) => ({ stop: `#${n}: ${why}${done.length ? ` (${done.map((d) => `#${d}`).join(', ')} merged)` : ''}` });
    for (let i = 0; i < steps.length; i++) {
      const n = steps[i].number;
      try {
        if (i > 0 && facts?.get(n)?.baseBranch !== base) await github.retargetPr({ ...t, number: n, base });
        await mergeSoon({ ...t, number: n, method, matchHead: steps[i].snap.head }); } catch (caught) { const err = caught as Error & { code?: unknown };
        if (github.headMoved(err)) return stopAt(n, 'new commits were pushed since the plan');
        if (!done.length) throw err;
        return stopAt(n, err.message);
      }
      done.push(n);
    }
  } else {
    try { await github.mergePr({ ...t, number, method, matchHead: step.snap.head }); } catch (caught) { const err = caught as Error & { code?: unknown };
      if (github.headMoved(err)) return { stop: `#${number}: new commits were pushed since the plan` };
      throw err;
    }
  }
  const m: { state?: string; commit: string | null } = await github.mergedCommit({ ...t, number }).catch(() => ({ commit: null }));
  const res: { merged: boolean; commit: string | null; cleaned?: unknown } = { merged: true, commit: m.state === 'merged' ? m.commit : null };
  if (step.cleanup === true) {
    // Only PRs GitHub confirms merged; in a stack, each one is asked on its own.
    const states = await Promise.all(steps.map((x: PlanData) => (x.number === number ? m : github.mergedCommit({ ...t, number: x.number }).catch(() => null))));
    const merged = steps.map((x: PlanData, i: number) => ({ number: x.number, branch: now[i]?.branch, head: x.snap.head })).filter((x: PlanData, i: number) => states[i]?.state === 'merged');
    res.cleaned = await cleanupMerged(s, merged);
  }
  return res;
}));
// Right after a retarget GitHub may still be working out whether the PR merges: try again twice.
async function mergeSoon(args: github.GhCall): Promise<unknown> {
  for (let k = 0; ; k++) {
    try { return await github.mergePr(args); } catch (caught) { const err = caught as Error & { code?: unknown };
      if (k >= 2 || github.headMoved(err) || !/not mergeable|mergeab(?:le|ility) (?:state|status)|base branch was modified/i.test(err.message)) throw err;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}
// Clean up after merging (AK-543): remove the merged PRs' local worktrees and branches through
// Lanes → Clean up's path (git.cleanupLanes), as one undoable journal step. Never throws: the
// merge already happened. → { worktrees, branches, skipped: [{ name, message }], error? }
async function cleanupMerged(s: RepoSession, prs: { number: number; branch?: string | null; head?: string | null }[]) {
  if (!prs.length) return { worktrees: 0, branches: 0, skipped: [] };
  s.busy++;
  try {
    const worktrees = (await git.getWorktrees(s.repo.root)).map((w) => ({ ...w, elsewhere: ![undefined, s.win].includes(windowFor(w.path)) }));
    const local = new Set((await git.run(s.repo.root, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'])).split('\n').filter(Boolean));
    const { items, skipped } = mergePlan.cleanupItems(prs, local, worktrees);
    if (!items.length) return mergePlan.cleanupSummary({ removed: [], deleted: [], failed: [] }, skipped);
    const label = `Clean up after merging ${prs.map((p) => `#${p.number}`).join(', ')}`;
    return mergePlan.cleanupSummary(await s.journal.runCleanup(label, items), skipped);
  } catch (caught) { const err = caught as Error & { code?: unknown };
    return { worktrees: 0, branches: 0, skipped: [], error: err.message };
  } finally {
    s.busy--;
    s.pending.refs = s.pending.workdir = true;
    s.schedule();
    menuChanged();
  }
}
// The merge method last used in this repo (AK-545), remembered per repo in settings.
const methodName = (m: string): string | undefined => ({ squash: 'Squash and merge', merge: 'Merge commits', rebase: 'Rebase and merge' } as Record<string, string>)[m];
const MAX_SAVED_METHODS = 200;
const savedMethods = (): Record<string, string> => (readSettings().mergeMethods as Record<string, string> | undefined) || {};
function savedMethod(root: string | null | undefined): string | null {
  const m = root ? savedMethods()[root] : null;
  return (mergePlan.METHODS as readonly unknown[]).includes(m) ? m ?? null : null;
}
handle('app:merge-method-save', (e, method) => {
  const root = session(e).repo?.root;
  const m = check.oneOf(...mergePlan.METHODS)(method, 'merge method');
  if (!root) return { saved: null };
  const all: Record<string, string> = { ...savedMethods() };
  delete all[root];
  all[root] = m;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_METHODS))) delete all[k];
  writeSettings({ mergeMethods: all });
  return { saved: m };
});
type SendBackSaved = Parameters<typeof sendBack.resolveTemplates>[0];
// send-back.js (still JavaScript) infers `null` from its `root = null` default; it takes a repository root.
const sendBackRoot = (e: Ev): null => (session(e).repo?.root || null) as null;
handle('app:sendback-templates', (e) => sendBack.resolveTemplates(readSettings().sendBack as SendBackSaved, sendBackRoot(e)));
handle('app:sendback-template-save', (e, id, text, scope) => {
  const next = sendBack.saveTemplate(readSettings().sendBack as SendBackSaved, {
    root: sendBackRoot(e),
    id: check.oneOf(...sendBack.TEMPLATE_IDS)(id, 'template'),
    text: check.str(text ?? '', 'template', { max: sendBack.MAX_TEMPLATE, empty: true }),
    scope: check.oneOf('repo', 'default')(scope, 'template scope'),
  } as Parameters<typeof sendBack.saveTemplate>[1]); // send-back.js (JavaScript) infers only its defaulted keys
  writeSettings({ sendBack: next });
  return sendBack.resolveTemplates(next, sendBackRoot(e));
});

// Review a PR in the inbox: fetch its head into FETCH_HEAD only (no ref moves, so nothing to
// journal) and diff it locally against the base's remote-tracking branch. Plain `git fetch`, no
// `gh`, and only while pull requests are on here.
handle('app:pr-review-head', okCall(async (e, remoteName, number, base) => {
  const s = session(e);
  const root = s.repo.root;
  check.prNumber(number);
  if (!(await prEnabled(root))) throw Object.assign(new Error('Pull requests are off for this repository.'), { code: 'gh-off' });
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  const sha = await github.fetchPrHead((args) => r(s, args), remote.name, number);
  const ref = base ? `refs/remotes/${remote.name}/${check.rev(base, 'base branch')}` : null;
  const has = ref && (await r(s, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowCodes: [0, 1] })).trim();
  return { sha, base: has ? `${remote.name}/${base}` : null };
}));

// Check out a PR as a branch here, or as a branch in a new worktree (a new lane). `gh` says where
// the PR's head is; git fetches it and makes the ref changes, each one journaled so ⌘Z undoes it.
// A local branch that already points elsewhere only moves once the user has confirmed (`update`).
const prCheckoutOpts = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>; // keys and types checked below
  if (typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => !['worktree', 'dir', 'update', 'free', 'move', 'stash'].includes(k))) throw new check.IpcArgError('Invalid checkout options');
  const stash = o.stash == null ? null : check.obj(o.stash, 'stash', { message: (v, w) => check.str(v, w, { max: 4096 }), untracked: (v, w) => v == null || check.bool(v, w) });
  return { worktree: o.worktree == null ? false : check.bool(o.worktree, 'worktree'), dir: o.dir ? check.str(o.dir, 'worktree folder', { max: 4096 }) : null, update: o.update == null ? false : check.bool(o.update, 'update'), free: o.free ? check.absDir(o.free, 'worktree folder') : null, move: o.move == null ? false : check.bool(o.move, 'move'), stash };
};
handle('app:pr-checkout', okCall(async (e, number, opts) => {
  check.prNumber(number);
  const { worktree, dir, update, free, move, stash } = prCheckoutOpts(opts);
  const s = session(e);
  const root = s.repo.root;
  const { remote, head } = await github.viewPr({ enabled: await prEnabled(root), remotes: await prRemotes(root), number });
  const local = head.local;
  s.busy++;
  try {
    // No destination: only FETCH_HEAD changes, so there's nothing to journal yet.
    await r(s, ['fetch', '--no-tags', '--', remote.name, `refs/pull/${number}/head`]);
    const sha = (await r(s, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
    const tip = (await r(s, ['rev-parse', '-q', '--verify', `refs/heads/${local}`], { allowCodes: [0, 1] })).trim();
    if (tip && tip !== sha && !update) return { confirm: { branch: local, from: tip, to: sha } };
    const track = async () => {
      await r(s, ['config', `branch.${local}.remote`, remote.name]);
      await r(s, ['config', `branch.${local}.merge`, github.prUpstream(head)]);
    };
    if (!worktree) {
      const args = !tip ? ['checkout', '-b', local, sha] : tip !== sha ? ['checkout', '-B', local, sha] : ['checkout', local];
      // The branch is checked out in another worktree: the renderer offers to free it there (`free`).
      const held = tip && (await git.getWorktrees(root)).find((w) => !w.current && w.branch === local);
      if (held && !(free && git.samePath(held.path, free))) return { inUse: { branch: local, worktree: { name: held.name, path: held.path, missing: held.missing, elsewhere: ![undefined, s.win].includes(windowFor(held.path)) } } };
      if (held) {
        if (![undefined, s.win].includes(windowFor(held.path))) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
        // Bringing that worktree's changes along needs the branch where they were made.
        if (move && args.length > 2) throw new git.GitError(`${local} has to move to the pull request first. Commit or stash the changes in “${held.name}”.`);
        if (move) await s.journal.moveCheckout(`Check out #${number}`, local, held.path, stash as { message: string; untracked?: boolean | null } | null);
        else await s.journal.freeCheckout(`Check out #${number}`, local, held.path, args);
      } else await s.journal.record(`Check out #${number}`, 'checkout', () => r(s, args));
      await track();
      return { branch: local, sha };
    }
    // Moving an existing branch and adding its worktree are one journal step, so one ⌘Z undoes both.
    const wt = await s.journal.runWorktree('addWorktree', `New worktree for #${number}`, [{ dir, branch: local, base: tip === sha ? null : sha, force: Boolean(tip) && tip !== sha }]);
    await track();
    return { branch: local, sha, worktree: wt };
  } finally {
    s.busy--;
    s.pending.refs = s.pending.workdir = true;
    s.schedule();
    menuChanged();
  }
}));

// Create a PR from a local branch. Main works out what the branch needs (its GitHub head, whether
// it's pushed) itself, so the renderer only names the branch; a push happens only when the user
// ticked the confirm in the sheet, and `gh pr create` runs only on an up-to-date remote branch.
async function prBranch(s: RepoSession, rawBranch: unknown) {
  const branch = check.rev(rawBranch, 'branch');
  const root = s.repo.root;
  const remotes = await prRemotes(root);
  const enabled = await prEnabled(root);
  const target = github.pickRemote(remotes);
  if (!enabled) throw Object.assign(new Error('Pull requests are off.'), { code: 'gh-off' });
  if (!target) throw Object.assign(new Error('This repository has no GitHub remote.'), { code: 'gh-no-remote' });
  const line = (await r(s, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)', `refs/heads/${branch}`])).trim();
  if (!line) throw new git.GitError(`${branch} isn’t a local branch.`);
  const [upRemote, upRef, track] = line.split('\0');
  const { dest, head, push, pushArgs } = github.prPushPlan({ branch, upRemote, upRef, track, remotes, target });
  return { enabled, remotes, target, dest, head, push, pushArgs, branch };
}
handle('app:pr-create-info', okCall(async (e, branch) => {
  const s = session(e);
  const b = await prBranch(s, branch);
  const base = await github.defaultBranch({ enabled: b.enabled, remotes: b.remotes });
  // Commits not on the remote's base yet; without a remote base, just the branch tip.
  const baseRef = `refs/remotes/${b.target.name}/${base}`;
  const hasBase = (await r(s, ['rev-parse', '-q', '--verify', baseRef], { allowCodes: [0, 1] })).trim();
  const log = await r(s, ['log', '--format=%s%x00%b%x1e', '-n', hasBase ? '50' : '1', hasBase ? `${baseRef}..refs/heads/${branch}` : `refs/heads/${branch}`, '--']);
  return { branch, base, remote: b.target.name, head: b.head, push: b.push, ...github.prDraft(github.parseCommits(log)) };
}));
// "Draft with AI": the provider set up for commit messages, and only once the user has agreed
// to send it diffs (the commit composer asks); this sheet never widens that consent.
handle('app:pr-ai-draft', okCall(async (e, branch, base) => {
  const a = aiSettings();
  if (a.provider === 'off' || !a.consent.includes(a.provider)) throw Object.assign(new Error('Set up AI commit messages first.'), { code: 'ai-off' });
  const s = session(e);
  const b = await prBranch(s, branch);
  const baseName = check.rev(base, 'base');
  const baseRef = `refs/remotes/${b.target.name}/${baseName}`;
  const range = (await r(s, ['rev-parse', '-q', '--verify', baseRef], { allowCodes: [0, 1] })).trim() ? `${baseRef}...refs/heads/${branch}` : `refs/heads/${branch}^!`;
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  const [log, stat, diff] = await Promise.all([
    r(s, ['log', '--format=- %s', '-n', '50', range.replace('...', '..'), '--'], { env }),
    r(s, ['diff', '--stat=100', '--no-color', range, '--'], { env }),
    r(s, ['diff', '--no-color', '--no-ext-diff', '-M', range, '--'], { env }),
  ]);
  return ai.splitPr(await ai.generate(a, ai.buildPrPrompt({ branch: b.branch, base: baseName, log, stat, diff })));
}));
const prCreateOpts = (v: unknown) => check.obj(v, 'pull request', {
  base: (x, w) => check.rev(x, w),
  title: (x, w) => check.str(x, w, { max: 1024 }),
  body: (x, w) => check.str(x, w, { empty: true }),
  draft: check.bool,
  push: check.bool,
});
handle('app:pr-create', okCall(async (e, branch, opts) => {
  const o = prCreateOpts(opts);
  const s = session(e);
  const b = await prBranch(s, branch);
  if (b.push) {
    if (!o.push) throw Object.assign(new Error(`${branch} has commits that aren’t on GitHub yet. Push it first.`), { code: 'needs-push' });
    s.busy++;
    try {
      // A current branch already tracking GitHub takes the usual push path; anything else pushes
      // explicitly to the PR's remote, since the usual path would pick origin.
      if (!b.push.isNew && branch === (await git.getRefs(s.repo.root)).head.branch) await plainMutations.push(s);
      else await r(s, b.pushArgs ?? []);
    } finally {
      s.busy--;
      s.pending.refs = true;
      s.schedule();
    }
  }
  return github.createPr({ enabled: b.enabled, remotes: b.remotes, base: o.base, head: b.head, title: o.title, body: o.body, draft: o.draft });
}));

// `win`: the tab asking (see Tab).
async function bindRepo(win: Tab, dir: string) {
  const repo = await git.openRepo(dir);
  const opening = win.opening;
  win.opening = false;
  // Reuse the tab already showing this repository, in this window or another. A tab opened only for it closes.
  for (const [, s] of sessions) {
    if (s.repo.root === repo.root && s.win !== win && !s.win.isDestroyed()) {
      s.win.focus();
      if (opening) win.destroy();
      return { focused: true };
    }
  }
  // A tab showing another repository opens this one in a new tab; another worktree of its own repository
  // replaces it in place, as before tabs (AK-634).
  const cur = sessions.get(win.webContents.id)?.repo;
  if (cur && !git.samePath(cur.commonDir || cur.gitDir, repo.commonDir || repo.gitDir)) { win.host.add(repo.root); return { focused: true }; }
  sessions.get(win.webContents.id)?.dispose();
  sessions.set(win.webContents.id, new RepoSession(win, repo));
  addRecent(repo);
  // The base tip as of this open: where catch-up starts the first time (AK-281).
  tipOf(repo.root).then((tip) => catchupStore.noteOpen(catchupFile(), repo.root, tip)).catch((err: Error) => console.warn('could not note the base tip', err.message));
  win.setTitle(repo.name);
  win.setRepresentedFilename?.(repo.root);
  menuChanged();
  notifyWindows();
  return repo;
}

handle('app:open', async (e, dir) => {
  const win = tabFor(e);
  let target: string | null = null;
  try {
    target = dir == null ? null : check.absDir(dir);
    if (!target) {
      const res = await dialog.showOpenDialog(win.host.win, { properties: ['openDirectory', 'createDirectory'], message: 'Open a Git repository' });
      if (res.canceled) return { ok: null };
      target = res.filePaths[0] ?? '';
    }
    return { ok: await bindRepo(win, target) };
  } catch (caught) { const err = caught as Error & { code?: unknown };
    if (err.code === 'not-repo') return { notRepo: await notRepo(e.sender.id, target ?? '') };
    return { error: serializeError(err) };
  }
});
async function notRepo(id: number, dir: string) {
  notRepoDirs.set(id, dir);
  const repos = await git.findRepos(dir);
  return { dir, name: path.basename(dir), repos: repos.map((r) => ({ root: r.root, name: r.name, commonDir: r.commonDir, main: r.main })) };
}

handle('app:init-here', async (e, dir) => {
  const win = tabFor(e);
  try {
    const target = check.absDir(dir);
    if (notRepoDirs.get(e.sender.id) !== target) throw new Error('That folder wasn’t offered for a new repository.');
    notRepoDirs.delete(e.sender.id);
    await git.initRepo(target);
    return { ok: await bindRepo(win, target) };
  } catch (caught) { const err = caught as Error & { code?: unknown }; return { error: serializeError(err) }; }
});

handle('app:init', async (e) => {
  const win = tabFor(e);
  const res = await dialog.showOpenDialog(win.host.win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a folder for the new repository' });
  const folder = res.filePaths[0];
  if (res.canceled || !folder) return { ok: null };
  try { await git.initRepo(folder); return { ok: await bindRepo(win, folder) }; } catch (caught) { const err = caught as Error & { code?: unknown }; return { error: serializeError(err) }; }
});

handle('app:clone', async (e, url) => {
  const win = tabFor(e);
  let u: string;
  try { u = check.cloneUrl(url); } catch (caught) { const err = caught as Error & { code?: unknown }; return { error: serializeError(err) }; }
  const name = (u.split('/').pop() || 'repo').replace(/\.git$/, '');
  const res = await dialog.showSaveDialog(win.host.win, { defaultPath: name, buttonLabel: 'Clone', message: 'Clone repository to…' });
  if (res.canceled || !res.filePath) return { ok: null };
  const dest = res.filePath;
  try {
    await git.cloneRepo(u, dest, (line) => win.webContents.send('clone:progress', line));
    return { ok: await bindRepo(win, dest) };
  } catch (caught) { const err = caught as Error & { code?: unknown }; return { error: serializeError(err) }; }
});

// Closing a repository also takes it off the recent list.
handle('app:close-repo', (e) => {
  const root = sessions.get(e.sender.id)?.repo?.root;
  if (root) removeRecent(root);
  sessions.get(e.sender.id)?.dispose();
  sessions.delete(e.sender.id);
  tabOf(e)?.setTitle('Since');
  tabOf(e)?.setRepresentedFilename('');
  menuChanged();
  notifyWindows();
});

// A folder another worktree of this repository lives in, or throws.
const worktreeFolder = async (s: RepoSession, dir: unknown) => check.knownWorktree(await git.getWorktrees(s.repo.root), dir, git.samePath);
// `target` is relative to the repository root, or an absolute worktree folder of this repository.
const revealTarget = (s: RepoSession, target: unknown) => (typeof target === 'string' && path.isAbsolute(target) ? worktreeFolder(s, target) : check.insideRepo(s.repo.root, target));

handle('app:reveal', async (e, target) => {
  const s = session(e);
  if (target) shell.showItemInFolder(await revealTarget(s, target));
  else shell.openPath(s.repo.root);
});
handle('app:terminal', async (e, dir) => {
  const s = session(e);
  const target = dir ? await worktreeFolder(s, dir) : s.repo.root;
  if (isMac) spawn('open', ['-a', 'Terminal', target], { detached: true });
  else shell.openPath(target);
});
handle('app:open-file', (e, rel) => {
  const abs = check.insideRepo(session(e).repo.root, rel);
  // Apps, scripts and executables would run, not open: show them in Finder instead.
  if (check.runnable(abs)) { shell.showItemInFolder(abs); return 'revealed'; }
  return shell.openPath(abs);
});
handle('app:external', (_e, url) => shell.openExternal(check.webUrl(url)));
handle('app:copy', (_e, text) => clipboard.writeText(check.str(text, 'clipboard text', { max: 16 * 1024 * 1024, empty: true })));
handle('app:confirm', async (e, opts) => {
  const { message, detail, ok = 'OK', destructive } = check.confirmOptions(opts);
  const box: Electron.MessageBoxOptions = { type: destructive ? 'warning' : 'question', message, detail: detail ?? undefined, buttons: [ok ?? 'OK', 'Cancel'], defaultId: 0, cancelId: 1 };
  const win = windowOf(e);
  const res = await (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box));
  return res.response === 0;
});
handle('app:new-window', () => { createWindow(); });
handle('app:tabs', (e) => [tabOf(e)?.host.list() || [], hasClosedTabs()]);
// The tab strip and ⌘K: only this window's tabs.
handle('app:tab', (e, action, id) => {
  const tab = tabOf(e);
  if (!tab) return;
  const host = tab.host;
  const target = id == null ? tab : host.tabs.find((t) => t.id === check.int(id, 'tab'));
  switch (check.tabAction(action, 'tab action')) {
    case 'new': host.add(); break;
    case 'close': if (target) closeTab(target); break;
    case 'select': if (target) host.select(target); break;
    case 'reopen': reopenClosed(); break;
    default: host.step(action === 'next' ? 1 : -1);
  }
});
// Open another worktree of this tab's repository in a new tab, or focus the tab already showing it.
handle('app:open-window', async (e, dir) => {
  const target = await worktreeFolder(session(e), dir);
  const win = windowFor(target);
  if (win) win.focus(); else tabFor(e).host.add(target);
});
handle('app:handoff', async (e, payload) => {
  const s = session(e);
  const h = { ...check.handoff(payload) };
  const list = await git.getWorktrees(s.repo.root);
  h.dir = check.knownWorktree(list, h.dir, git.samePath);
  if (h.path) h.path = check.knownWorktree(list, h.path, git.samePath);
  let win = windowFor(h.dir) as Tab | undefined; // a session's window is a tab
  if (win === s.win) throw new Error('That worktree is open in this window.');
  if (!win) win = (s.win as Tab).host.add(h.dir);
  handoffs.set(win.webContents.id, h);
  win.focus();
  win.webContents.send('command', 'handoff');
});
handle('app:take-handoff', (e) => {
  const h = handoffs.get(e.sender.id) || null;
  handoffs.delete(e.sender.id);
  return h;
});

// Open a checked-out submodule of this window's repository as its own repository.
handle('app:open-submodule', async (e, p) => {
  const s = session(e);
  const want = check.repoPath(p, 'submodule');
  const sub = (await git.getSubmodules(s.repo.root)).find((x) => x.path === want);
  if (!sub) throw new Error('Not a submodule of this repository');
  if (!sub.head) throw new Error('That submodule isn’t checked out yet. Update it first.');
  const target = path.join(s.repo.root, sub.path);
  const win = windowFor(target);
  if (win) win.focus(); else tabFor(e).host.add(target);
});

