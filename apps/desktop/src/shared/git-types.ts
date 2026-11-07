// The shapes the git layer (src/main/git/) returns, shared with the renderer, which gets them
// through IPC.

/** The git in use: its path and version, e.g. `{ path: '/usr/bin/git', version: '2.39.5' }`. */
export interface GitInfo { path: string; version: string }

/** One changed file in `git status`. `status` is the porcelain letter (M, A, D, R, C, U, ?). */
export interface StatusEntry {
  path: string;
  status: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  /** A submodule whose checked-out commit is unchanged, with changes only inside it. */
  inside?: true;
  /** A conflict's two-letter state (UU, AA, …). */
  xy?: string;
  /** The path goes through the Git LFS filter (markLfs). */
  lfs?: true;
}
export interface WorkStatus { staged: StatusEntry[]; unstaged: StatusEntry[]; conflicts: StatusEntry[] }

/** A diff line: context, removed or added, with its old and new line numbers. */
export interface DiffLine { t: ' ' | '-' | '+'; s: string; o: number | null; n: number | null; noEol?: boolean }
export interface Hunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; context: string; lines: DiffLine[] }
export interface FileDiff {
  header: string[]; hunks: Hunk[]; binary: boolean; oldPath: string | null; newPath: string | null;
  /** The file's path, for a commit's diffs (readCommitDiffs). */
  path?: string;
  /** A submodule bump: no lines to pick, it goes whole. */
  gitlink?: true;
}

export type OperationKind = 'rebase' | 'merge' | 'cherry-pick' | 'revert';
/** What a stopped rebase, merge, cherry-pick or revert is doing. */
export type OperationInfo =
  | { op: 'merge'; branch: string; from: string; sha: string }
  | { op: 'cherry-pick' | 'revert'; branch: string; sha: string; subject: string }
  | { op: 'rebase'; branch: string; onto: string; step: number; total: number; subject: string };

export interface ReflogEntry { sha: string; selector: string; action: string; time: number; subject: string }
export interface ConfigEntry { scope: string; key: string; value: string }
/** Who commits here: the configured user, the identities that made commits in this clone, and the remote URLs. */
export interface Identity { name: string; email: string; used: { email: string; name: string; count: number }[]; remotes: string[] }

/** A commit that touched a file, with the file's path at that commit. */
export interface FileHistoryEntry {
  sha: string; parents: string[]; author: string; email: string; time: number; subject: string;
  status: string; path: string; oldPath: string | null;
}
export interface FileHistoryPage { entries: FileHistoryEntry[]; next: { from: string; skip: number; path: string } | null }

export interface BlameCommit { sha: string; uncommitted: boolean; author: string; email: string; time: number; summary: string; path: string; boundary: boolean }
/** A blamed line; `commit` indexes into `Blame.commits`. */
export interface BlameLine { line: number; commit: number; text: string }
export interface Blame { commits: BlameCommit[]; lines: BlameLine[] }

/** A line of the unified (staged + unstaged) view of a file; changed lines say whether they are staged. */
export interface CombinedLine {
  t: ' ' | '-' | '+'; s: string; o: number | null; n: number | null;
  staged?: boolean;
  /** Replaces a staged line: it changed again after staging. */
  edited?: true;
  noEol?: true;
}
export interface CombinedHunk {
  header: string; oldStart: number; oldLines: number; newStart: number; newLines: number;
  /** null when the file came back collapsed and this hunk wasn't asked for. */
  lines: CombinedLine[] | null;
  total: number; staged: number; edited: boolean;
}
/** Why a file can only be staged whole: 'conflict', 'binary', 'renamed', 'deleted', 'typechange' or 'mode'. */
export type WholeFileReason = 'conflict' | 'binary' | 'renamed' | 'deleted' | 'typechange' | 'mode';
export interface CombinedDiff {
  path: string; oldPath: string | null; untracked: boolean; conflict: boolean; binary: boolean;
  /** Staged lines hidden by a later edit or removal. */
  hidden: number;
  wholeFile: WholeFileReason | null;
  staged: number; total: number; collapsed: boolean;
  state: 'none' | 'all' | 'partial';
  hunks: CombinedHunk[];
}

/** A Git LFS file: whether its content is here ('downloaded'), still the pointer text, or deleted. */
export interface LfsFile { path: string; stored: boolean; state: 'downloaded' | 'pointer' | 'missing'; size?: number; oid?: string }
/** `used`: the repository routes files through LFS. `installed`: git-lfs runs here. */
export interface LfsInfo { used: boolean; installed: boolean; version: string | null; patterns: string[]; files: LfsFile[]; truncated: boolean }

export type RefKind = 'branch' | 'remote' | 'tag';
export interface Ref {
  name: string; short: string; kind: RefKind; target: string; upstream: string | null;
  ahead: number; behind: number; gone: boolean; date: number;
}
export interface Head { detached: boolean; branch: string | null; oid: string | null }
export interface Refs { refs: Ref[]; head: Head }

export interface CoAuthor { name: string; email: string }
/** A commit in the log. */
export interface Commit { sha: string; parents: string[]; author: string; email: string; time: number; subject: string; coAuthors: CoAuthor[] }
export interface Signature { state: 'good' | 'expired' | 'revoked' | 'bad' | 'unverified'; signer: string }
/** A file a commit changed, with its line counts. */
export interface CommitFile { status: string; path: string; oldPath?: string; add: number; del: number; binary: boolean }
export interface CommitDetails {
  sha: string; parents: string[]; author: string; email: string; time: number;
  committer: string; committerEmail: string; commitTime: number;
  signature: Signature | null; coAuthors: CoAuthor[]; message: string; files: CommitFile[];
}

/** A stash entry. `ref` is `stash@{n}` for display only: stashes are identified by `sha`. */
export interface Stash { ref: string; sha: string; time: number; message: string }

/** A conflicted file for the conflict editor. Only 'text' files can be edited; the rest take a whole side. */
export interface ConflictFile {
  path: string; base: boolean; ours: boolean; theirs: boolean;
  kind: 'text' | 'binary' | 'missing' | 'large' | 'encoding';
  text: string | null;
}
/** Resolved files of a stopped operation, saved as a stash-shaped commit; `sha` null when they all matched HEAD. */
export interface SavedResolved { sha: string | null; paths: string[]; unchanged?: number }

export type RewriteOp = 'drop' | 'split' | 'reword' | 'squash' | 'fixup' | 'swapParent';

export type SubmoduleState = 'uninitialized' | 'outdated' | 'modified' | 'conflict' | 'clean';
export interface SubmoduleHead { sha: string; branch: string | null }
export interface Submodule { path: string; name: string; url: string; recorded: string | null; head: string | null; branch: string | null; state: SubmoduleState }

/** `setUrl` is the configured URL; `url` is after insteadOf rewriting. `web` is the https page, or null. */
export interface Remote { name: string; url: string; setUrl: string; web: string | null; label: string }
export interface DivergedCommit { sha: string; subject: string; author: string; date: number }
/** Why a pull diverged or a push was rejected: the commits on each side, the files a merge would conflict on. */
export interface Divergence {
  branch: string; upstream: string;
  theirs: DivergedCommit[]; theirsCount: number; ours: DivergedCommit[]; oursCount: number;
  /** [] merges clean, null when git can't tell. */
  conflicts: string[] | null;
  /** Some of ours are on a remote already, so rebasing them rewrites pushed commits. */
  shared: boolean;
}

/** A lane as the conflict forecast names it. */
export interface LaneWho { name: string; branch: string | null; worktree: { path: string } | null }
export interface ForecastPair { a: LaneWho; b: LaneWho | null; files: string[] }
export interface ConflictForecast { supported: boolean; pairs: ForecastPair[] }
/** A simulated merge: the commit when it merges clean, else null with the conflicting files. */
export interface MergeSim { files: string[]; commit: string | null }
export interface ConflictHunk { line: number; before: string[]; base: string[]; head: string[]; after: string[] }
export interface ConflictReview { supported: boolean; files: { path: string; hunks: ConflictHunk[]; inBase: boolean; inHead: boolean }[] }

/** A repository opened in a window: its work tree, this worktree's admin dir and the shared one. */
export interface RepoInfo { root: string; gitDir: string; commonDir: string; name: string }
/** A repository (or worktree of one) found inside a folder. */
export interface FoundRepo { root: string; name: string; commonDir: string; main: boolean }
export interface Worktree {
  path: string; name: string; head: string | null; branch: string | null;
  detached: boolean; bare: boolean; main: boolean; current: boolean;
  locked: boolean; lockReason: string;
  /** Its folder is gone (git calls it prunable). */
  missing: boolean;
}
/** A worktree's changes stashed before it was removed; `kept` leaves the stash in the list. */
export interface SavedWorktree { sha: string; message: string; kept: boolean }
/** Something Clean up couldn't remove, and why. `op` names an operation stopped in the worktree. */
export interface CleanupFailure { name: string; message: string; op?: string; worktree?: string }
export interface CleanupRemoved { path: string; branch: string | null; head: string | null; pruned: boolean; lost: number; saved?: SavedWorktree }
export interface CleanupResult { removed: CleanupRemoved[]; deleted: string[]; failed: CleanupFailure[] }

/** Why a lane counts as shipped; `sha` the base commit with the same key, subject or change, `pr` its pull request. */
export interface LaneDone { reason: 'merged' | 'pr' | 'key' | 'subject' | 'net-patch'; pr?: number; key?: string; sha?: string | undefined }
export interface AgentGuess { reason: 'trailer' | 'branch prefix'; match: string }
export interface LaneWorktree { path: string; short: string; main: boolean; current: boolean; locked: boolean; prunable: boolean }
/** One local branch or worktree, measured against the repository's base branch. */
export interface Lane {
  name: string; branch: string | null; head: string | null; detached: boolean; isBase: boolean;
  worktree: LaneWorktree | null; upstream: string | null; upstreamGone: boolean;
  /** Newest commit or uncommitted edit, in ms. */
  activity: number | null;
  ahead: number | null; behind: number | null;
  /** Uncommitted files in its worktree. */
  changes: number | null;
  merged: 'ancestor' | 'squash' | null; mergedAs: string | null; done: LaneDone | null;
  title: string; nothingAhead: boolean;
  /** Only agent bookkeeping commits ahead (baseline, swept-up scratch files). */
  noWork: boolean;
  agent: AgentGuess | null;
}
export interface LanesResult { base: string | null; baseRef: string | null; baseSha: string | null; lanes: Lane[] }

export interface LandedCommit { sha: string; parent: string | null; date: number; author: string; subject: string; files: string[] }
/** What reached the base since a checkpoint (Review's catch-up card). */
export interface Landed {
  base: string; baseSha: string; baseDate: number; from: string | null; date: number | null;
  fallback: { sha: string | undefined; reason: 'unreachable' | 'missing' } | null;
  commits: LandedCommit[]; truncated: boolean; tags: string[];
}
export interface ReviewCommit { sha: string; subject: string; author: string; email: string; time: number; coAuthors: CoAuthor[] }
/** A branch's whole change against its base, as a pull request shows it. Each file carries its blob at the tip. */
export interface BranchReview {
  branch: string; base: string; baseSha: string; mergeBase: string; tip: string;
  files: (CommitFile & { blob: string | null })[];
  commits: ReviewCommit[]; commitCount: number;
}
export interface BaseTouch { sha: string; subject: string; pr: number | null }

/** What merging a lane's branch into its base would do. `blocker` stops everything; `mergeBlocker` only merging here. */
export interface MergeLanePlan {
  branch: string; head: string; base: string | null; baseSha: string | null;
  commits: { subject: string; body: string }[]; conflicts: string[];
  worktree: { path: string; name: string } | null;
  /** The branch is checked out in this window or the main worktree: merged but kept. */
  keep: 'current' | 'main' | null;
  baseWorktree: { path: string; name: string } | null;
  blocker: string | null; blockerOp: string | null; mergeBlocker: string | null; mergeBlockerCode?: string;
}
