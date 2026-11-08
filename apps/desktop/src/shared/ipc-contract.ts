// The IPC contract between the main process, the preload bridge (`window.since`) and the
// renderer: which channels exist and what crosses them, so a call on a channel that doesn't
// exist, or a listener that expects the wrong payload, fails `tsc`. The main process still checks
// every argument at run time (src/main/ipc.js): the renderer is untrusted, and these types can't
// vouch for what it actually sends.
//
// Payloads typed `unknown` here get their real types when the main process that produces them
// moves to TypeScript.

import type { AppChannel, GitMethod, PushChannel } from './channels.ts';
import type { Aborted, BaseTouch, Blame, BranchReview, ChangeFacts, CombinedDiff, CommitDetails, ConfigEntry, ConflictReview, Divergence, FileDiff, FileHistoryPage, GitInfo, Identity, JournalList, LfsInfo, OperationInfo, ReflogEntry, Refs, RestorePreview, Stash, Submodule, WorkStatus, Worktree } from './git-types.ts';
import type { PrEvidence, PrSettings } from './github-types.ts';

export type Theme = 'system' | 'light' | 'dark';
/** A window's tab as its tab strip shows it. */
export interface TabInfo { id: number; title: string; active: boolean }
export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'available' | 'ready' | 'error' | 'disabled';
/** Where updating stands; `current` is the running version, `auto` whether daily checks are on. */
export interface UpdateState { status: UpdateStatus; version?: string | undefined; error?: string | undefined; manual?: boolean | undefined; current?: string | undefined; auto?: boolean }

/** A failure carried across IPC as data instead of a thrown error (serializeError in src/main/handlers/handle.js). */
export interface IpcError {
  message: string;
  stderr: string | null;
  code: string | number | null;
  /** The refs that moved since, when an undo or redo refuses with code 'moved' (journal.ts). */
  moved?: { ref: string; from: string | null; to: string | null }[];
  /** The step whose stash is gone, when an undo or redo refuses with code 'stash-gone' (journal.ts). */
  step?: { label: string; time: number; stash: { message: string; time: number | null } };
}

/** What a git call, or an app call wrapped in okCall, resolves to: the result or the failure. */
export type IpcResult<T> = { ok: T; error?: undefined } | { ok?: undefined; error: IpcError };

/** The arguments each push channel's listeners receive. */
export interface PushArgs extends Record<PushChannel, unknown[]> {
  'repo:changed': [changed: { refs: boolean; workdir: boolean }];
  command: [command: string, ...args: unknown[]];
  'clone:progress': [line: string];
  theme: [mode: Theme, opts: { announce: boolean }];
  update: [state: UpdateState & { page: string | null }];
  keymap: [overrides: unknown];
  'cleanup:progress': [progress: { done: number; total: number }];
  tabs: [tabs: TabInfo[], hasClosedTabs: boolean];
  git: [info: GitInfo | null];
}

/** What each git method resolves to, for the methods the TypeScript renderer reads so far. The rest resolve to unknown. */
export interface GitResults {
  divergence: Divergence;
  /** The diff between two commits, one entry per file. */
  compare: FileDiff[];
  branchReview: BranchReview;
  changeFacts: ChangeFacts;
  /** The commits on the base that touched each file. */
  baseTouches: Record<string, BaseTouch[]>;
  combinedDiff: CombinedDiff;
  /** One file's diff in a commit, or between two commits; null when its content didn't change. */
  commitFileDiff: FileDiff | null;
  /** What would conflict merging the second commit into the first (git merge-tree, read-only). */
  mergeConflicts: ConflictReview;
  fileHistory: FileHistoryPage;
  refs: Refs;
  opInfo: OperationInfo | null;
  status: WorkStatus;
  /** The undo and redo lists, newest last, up to the limit asked for. */
  history: JournalList;
  /** `elsewhere`: open in another Since window. */
  worktrees: (Worktree & { elsewhere: boolean })[];
  submodules: Submodule[];
  reflog: ReflogEntry[];
  config: ConfigEntry[];
  lfs: LfsInfo;
  /** A log stream: open it, read chunks until null (the end) or false (closed: another repository opened). */
  logOpen: { id: number; fast: boolean };
  logRead: string | null | false;
  /** The subject and author lines of these commits, in the log's text format. */
  logDetails: string;
  /** One commit's header and message. */
  commit: CommitDetails;
  /** The configured user, who made this clone's commits, and the remote URLs. */
  identity: Identity;
  /** Every file git tracks at HEAD. */
  trackedFiles: string[];
  /** The conflicted files the mergetool left. */
  mergetool: { remaining: string[] };
  /** What restoring the refs to before a journal entry would change. */
  previewRestore: RestorePreview;
  /** A commit's diff against its first parent, one entry per file. */
  commitDiffs: (FileDiff & { path: string })[];
  blame: Blame;
  /** The label of the step undone or redone; null when there was none. */
  undo: string | null;
  redo: string | null;
  stashes: Stash[];
  /** Undefined when nothing was stopped. */
  abortOp: Aborted | undefined;
  /** The abort, and what the method run after it returned. */
  abortAnd: Aborted & { result?: unknown };
}
export type GitResult<M extends GitMethod> = M extends keyof GitResults ? GitResults[M] : unknown;

/** The AI commit-message settings as app:ai-settings sends them (handlers/ai.ts aiState). */
export interface AiState {
  provider: string; model: string; consent: string[];
  /** The user has seen what goes to this provider. */
  consented: boolean;
  providers: { id: string; label: string; defaultModel?: string }[];
}

/** The Send back templates in effect: each one's text and where it comes from. */
export type SendBackTemplates = Record<'conflict' | 'ci' | 'both', { text: string; from: 'repo' | 'default' | 'builtin' }>;

/** What each app channel resolves to, for the channels the TypeScript renderer reads so far. The rest resolve to unknown. */
export interface AppResults {
  'git-info': IpcResult<GitInfo | null>;
  /** ok is null when the file picker was cancelled. */
  'git-choose': IpcResult<GitInfo | null>;
  'git-use': IpcResult<GitInfo>;
  'set-auto-update': UpdateState;
  'ai-settings': AiState;
  'ai-configure': AiState;
  /** The exact text that will be sent, and its hash for the consent check. */
  'ai-preview': IpcResult<AiState & { prompt: string; hash: string }>;
  /** The commit message. */
  'ai-generate': IpcResult<string>;
  /** The PR's head, fetched into FETCH_HEAD, and the base to diff against. */
  'pr-review-head': IpcResult<{ sha: string; base: string | null }>;
  'pr-stack-install': IpcResult<unknown>;
  'pr-evidence': IpcResult<PrEvidence | null>;
  /** An image from a PR, as a data: URL. */
  'pr-media-image': IpcResult<string | null>;
  'pr-state': PrSettings;
  /** The file the shortcuts went to; null when the save dialog was cancelled. */
  'keymap-export': string | null;
  'sendback-templates': SendBackTemplates;
  'sendback-template-save': SendBackTemplates;
  /** The last lines of the failed GitHub Actions log; null when there's none. */
  'pr-failed-log': IpcResult<{ log: string | null }>;
  'pr-comment': IpcResult<unknown>;
  /** `failed`: the PR GitHub refused and why; then nothing was linked. */
  'pr-stack-link': IpcResult<{ failed?: { number: number; reason: string } | null }>;
}
export type AppResult<C extends AppChannel> = C extends keyof AppResults ? AppResults[C] : unknown;

/** `window.since`, as src/preload/preload.ts exposes it. */
export interface SinceBridge {
  git<M extends GitMethod>(method: M, ...args: unknown[]): Promise<IpcResult<GitResult<M>>>;
  app<C extends AppChannel>(channel: C, ...args: unknown[]): Promise<AppResult<C>>;
  /** Listens to a push channel; returns the function that stops listening. */
  on<C extends PushChannel>(channel: C, fn: (...args: PushArgs[C]) => void): () => void;
}

// PushArgs has an entry for every push channel and no others.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type PushArgsMatchPush = Assert<Same<keyof PushArgs, PushChannel>>;
