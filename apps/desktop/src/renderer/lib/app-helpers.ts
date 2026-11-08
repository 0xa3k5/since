import { h, icon, avatar, type Child } from './ui.ts';
import { createHistory, type History } from '../graph/log.ts';
import * as keymap from '../palette/keymap.ts';
import { authorProfile } from './profile.ts';
import { up } from './upcalls.ts';
import type {
  CommitFile, ConfigEntry, FileDiff, GitInfo, Head, JournalList, LfsInfo, OperationInfo, OperationKind, Ref, ReflogEntry, Remote, RepoInfo, Stash, Submodule, WorkStatus, Worktree,
} from '../../shared/git-types.ts';
import type { AiState, Theme } from '../../shared/ipc-contract.ts';
import type { PullRequest } from '../../shared/github-types.ts';

// Small helpers the views share: labels, paths, links and tooltips.

// First letter up, for lower-case labels shown as captions.
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const api = window.since;
const ROW_H = 32;
const isMac = navigator.platform.startsWith('Mac');
const MOD = isMac ? '⌘' : 'Ctrl';

/** A part of the state whose module is still JavaScript. It gets its real type when that module moves (SNC-696). */
type Later = unknown;
/** Where the commit viewer's Back goes: a file's history, or Review (the page, and the lanes row it was on). */
export type QuickBack = { path: string } | { review: ReviewTarget | null; lanes: unknown };
/** The commit viewer: the commit and the file it opened on; `file` and `parent` once it has read the commit. */
export interface QuickState { sha: string; path?: string | null; back?: QuickBack | null; file?: CommitFile | null; parent?: string | null }
/** A label on a commit row: a ref, HEAD when it's detached, or another worktree's detached HEAD. */
export type PillRef = Ref | { kind: 'head'; short: string } | { kind: 'worktree'; short: string; worktree: Worktree };
/** File history & blame: the file it shows. */
export interface FileHistoryState { path: string }
export type View =
  | 'map' | 'commit' | 'lanes' | 'branches' | 'catchup' | 'worktrees' | 'stashes' | 'reflog' | 'snapshots'
  | 'submoduleList' | 'remoteList' | 'tagList';
/** Which sidebar rows show, in what order (Preferences → Sidebar). */
export interface SidebarSections { order?: string[]; hidden?: string[] }
/** What the map shows (View menu). */
export interface Show { tags: boolean; remotes: boolean; swatches: boolean; agentLanes: boolean; unified: boolean }
/** The Commit view: the list and file on screen, the selected files, and the picked lines of the diff. */
export interface CommitViewState {
  list: 'unstaged' | 'staged' | 'conflicts'; path: string | null; sel: Set<string>; anchor: string | null;
  lines: Set<string>; diff: FileDiff | null; full: boolean;
}
/** What the review page shows: the lane (and the revision reviewed), its base, where it came from, and the PR in PR mode. */
export interface ReviewTarget {
  lane: { key: string; name: string; rev: string | null };
  base: string | null;
  source: { name: string; branch: string | null; head: string | null };
  pr?: PullRequest & { remote?: string | null };
}

/** The Split commit view: the commit, and the branch it's on when that isn't this one. */
export interface SplitState { sha: string; branch: string | null }

export interface AppState {
  repo: RepoInfo | null;
  view: View;
  sidebar: { expanded: boolean; pinned: boolean; hover: boolean };
  panes: Record<string, number> | null;
  refs: Ref[];
  head: Head;
  hist: History;
  commits: History['commits'];
  logKey: string;
  graph: History['graph'] | null;
  index: Map<string, number>;
  byRef: Map<string, PillRef[]>;
  selected: string | null;
  detail: boolean;
  quick: QuickState | null;
  split: SplitState | null;
  status: WorkStatus;
  opState: OperationKind | null;
  opInfo: OperationInfo | null;
  lfs: LfsInfo | null;
  show: Show;
  search: string;
  stashes: Stash[];
  history: JournalList;
  historyLimit: number;
  snapSel: number | null;
  reflog: ReflogEntry[];
  config: ConfigEntry[];
  remotes: Remote[];
  worktrees: Worktree[];
  submodules: Submodule[];
  cv: CommitViewState;
  amend: boolean;
  collapsed: Record<string, boolean>;
  sections: SidebarSections;
  theme: Theme;
  prs: Later;
  review?: ReviewTarget | null;
  fileHistory?: FileHistoryState | null;
  ai?: AiState | null;
  gitInfo?: GitInfo | null;
}

const state: AppState = {
  repo: null,
  view: 'map',
  // expanded: saved choice for wide windows; pinned/hover: the overlay on narrow ones (see sidebar.js).
  sidebar: { expanded: loadPref('sidebar', { expanded: true }).expanded, pinned: false, hover: false },
  panes: null, // pane widths in px (pane-size.js), saved for every repository
  refs: [],
  head: { branch: null, oid: null, detached: false },
  hist: createHistory(), // the history on screen; commits/index/graph below are its parts
  commits: [],
  logKey: '',
  graph: null,
  index: new Map(),
  byRef: new Map(),
  selected: null,
  detail: true,
  quick: null,
  split: null,
  status: { staged: [], unstaged: [], conflicts: [] },
  opState: null,
  opInfo: null,
  lfs: null, // { used, installed, version, patterns, files }; see git.getLfs
  show: loadPref('show', { tags: true, remotes: true, swatches: true, agentLanes: true, unified: false }),
  search: '',
  stashes: [],
  history: { undo: [], redo: [], undoCount: 0, redoCount: 0 },
  historyLimit: 100, // snapshots loaded per stack; older ones load on request
  snapSel: null, // selected row in the Snapshots view (journal entry id)
  reflog: [],
  config: [],
  remotes: [],
  worktrees: [],
  submodules: [], // see git.getSubmodules
  cv: { list: 'unstaged', path: null, sel: new Set<string>(), anchor: null, lines: new Set<string>(), diff: null, full: false },
  amend: false,
  collapsed: loadPref('collapsed', {}),
  sections: loadPref('sidebarSections', {}), // which refs-tree sections show, in what order (Preferences → Sidebar)
  theme: 'system',
  prs: null, // pull requests from GitHub (see loadPrs); null until known
};

function loadPref<T extends object>(k: string, d: T): T { try { return { ...d, ...JSON.parse(localStorage.getItem('pref:' + k) ?? 'null') }; } catch { return d; } }
function savePref(k: string, v: unknown): void { try { localStorage.setItem('pref:' + k, JSON.stringify(v)); } catch { /* ignore */ } }
const baseName = (p: string): string => p.split('/').pop() ?? p;

// A person in the commit details; a link to their GitHub profile when we can place them.
function personLink(name: string, email: string): HTMLElement {
  const p = authorProfile(email, up.originRemote()?.web);
  const body = [avatar(name, email, 18), h('span.person-name', null, name)];
  if (!p) return h('span.prop-person', { title: `${name} <${email}>` }, ...body);
  return h('a.prop-person.person-link', { href: p.url, title: `${p.label}\n${name} <${email}>`, onclick: (e) => { e.preventDefault(); api.app('external', p.url); } }, ...body, icon('external', 12));
}

const prop = (label: Child, value: Child): HTMLElement => h('div.prop', null, h('span.prop-label', null, label), h('span.prop-value', null, value));

// Paths as shown: the home folder as ~, and the folder a path is in.

const tildify = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~');
const parentDir = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';
function tildePath(p: string): string { return p.replace(/^\/Users\/[^/]+/, '~'); }

// A tooltip with the command's current keys: "Pull (⌘⇧L)", or just the label when it has none.
const keyText = (id: string): string => (keymap.keys(id) ?? []).join('') || 'the Command Menu';
function tip(label: string, ...ids: string[]): string {
  const k = ids.map((id) => (keymap.keys(id) ?? []).join('')).filter(Boolean);
  return k.length ? `${label} (${k.join(', ')})` : label;
}

function isEditable(el: Element | null | undefined): boolean { return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable); }

export { state, loadPref, api, tildePath, savePref, tip, MOD, ROW_H, isEditable, prop, personLink, baseName, keyText, sentence, tildify, parentDir, isMac };
