// Pull request data as the renderer reads it. src/main/github.ts builds these from `gh` output
// (normalizePr and the PR state readers); only the fields the TypeScript renderer reads are listed.

/** A pull request from the PR list (app:pr-list) or a PR's own state. */
export interface PullRequest {
  number: number;
  title: string;
  /** The head branch. */
  branch: string;
  /** The head commit; null when GitHub didn't send one. */
  head?: string | null;
  /** The head repository's owner; empty for a PR from this repository. */
  headOwner?: string;
  base: string;
  draft?: boolean;
  /** approved | changes | required, or null. */
  review?: string | null;
  /** pending | success | failure, or null. */
  checks?: string | null;
  author?: string;
  authorName?: string;
  /** The author is a bot. */
  bot?: boolean;
  url?: string | null;
  updatedAt?: string;
  /** open | closed | merged, on a PR's own state. */
  state?: string;
  /** The remote the PR belongs to, set on the review page. */
  remote?: string | null;
  mergeable?: boolean | null;
  /** behind, blocked, clean… (github.ts mergeFacts). */
  mergeState?: string | null;
  /** The description; missing in older list data. */
  body?: string;
  /** The names of the failing checks. */
  failing?: string[];
  checkCounts?: { passed: number; total: number } | null;
  size?: { additions?: number | null; deletions?: number | null; files?: number } | null;
  reviewRequests?: { login: string; name?: string; team?: boolean }[];
  reviews?: { login: string; name?: string; state: string; submittedAt?: string }[];
}

/** The PR list (app:pr-list): the GitHub remote, each remote's owner, and the open PRs. */
export interface PrList {
  remote: { name: string; owner: string } | null;
  owners?: Record<string, string>;
  prs: PullRequest[];
  at?: number;
}

/** A check on a PR's head (github.ts checkList): its result, and how long it ran in seconds. */
export interface EvidenceCheck { name: string; result: string; duration?: number; url?: string }
/** A PR's evidence for its reader (app:pr-evidence, github.ts buildEvidence); only the fields the TypeScript renderer reads. */
export interface PrEvidence {
  head: string | null;
  checks?: EvidenceCheck[];
  /** The head has CI set up and no checks ran on it. */
  ciMissing?: boolean;
  reviews?: { login: string; state: string }[];
  threads?: {
    open?: number; total?: number; outdated?: number;
    items?: { path?: string; line?: number | null; url?: string; author?: string; text?: string; outdated?: boolean }[];
  } | null;
  media?: PrMedia[];
  /** Check annotations: their level (failure, warning, notice), where, and the message. */
  annotations?: { level: string; path?: string | null; line?: number | null; check?: string; message: string }[];
  logs?: { run: string | number; log: string }[];
}
/** An image or video in a PR's description, comments or reviews (pr-media.ts); `id` fetches it. */
export interface PrMedia { id: string; kind: string; from?: string; author?: string; url?: string; alt?: string }

/** The PR settings (app:pr-state): on, hidden in this repository, the GitHub remote in use and the ones to choose from. */
/** A GitHub remote of the repository. */
export interface GhRemote { name: string; host: string; owner: string; repo: string }
export interface PrSettings {
  enabled: boolean; hidden?: boolean;
  /** Pull requests show for this repository: turned on, not hidden here, and it has a GitHub remote. */
  active?: boolean;
  /** `missing` when GitHub CLI isn't installed; `installUrl` is where to get it. */
  gh?: string; installUrl?: string;
  remote?: GhRemote | null;
  choices?: GhRemote[]; chosen?: string | null;
}

/** Who is looking (github.ts viewerFacts): their login and whether they can write. */
export interface Viewer { login?: string; write?: boolean }
