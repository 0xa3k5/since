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
}

/** The PR list (app:pr-list): the GitHub remote, each remote's owner, and the open PRs. */
export interface PrList {
  remote: { name: string; owner: string } | null;
  owners?: Record<string, string>;
  prs: PullRequest[];
  at?: number;
}

/** Who is looking (github.ts viewerFacts): their login and whether they can write. */
export interface Viewer { login?: string; write?: boolean }
