# Reviewing GitLanes PRs

What the reviewer checks before a squash merge. Working rules for authors are in `CLAUDE.md`.

## What failure looks like (blocks the merge)

- Data loss, or a change to refs, the work tree or stashes that ⌘Z can't undo exactly.
- The wrong stash or branch: identity taken from a `stash@{n}` index or a name instead of a SHA.
- Secrets or credentials shown in the UI or written to logs.
- An IPC call whose arguments aren't validated in `apps/desktop/ipc.js`.
- A network call beyond the ones documented in `docs/security.md`.
- Breaking the update feed, its signature checks, or the licence checks.
- A keyboard trap.
- A diff to `CLAUDE.md` or `REVIEW.md` that the issue didn't ask for (agent runtimes write their own
  `CLAUDE.md` into worktrees; it must never be committed over the repo's file).

## Findings

- Tag each finding **Important**, **Nit** or **Pre-existing**, with `file:line` evidence.
- Nits are capped at 3. No style-only findings.
- Findings in the PR's own new code are fixed in that PR: by the reviewer if small and
  mechanical, otherwise one send-back to the author.
- Only Pre-existing findings become follow-up issues.
- Always **Important**: a new keyboard shortcut without a stated reason in the PR body, and new
  instructional or teaching text in the UI (hint lines, how-to notes, long descriptions).

## Review levels

- **Docs-only:** docs, comments, copy. Check facts against the code and commands.
- **Light:** small, contained changes. Read the diff, run `pnpm test` on the PR merged with `main`.
- **Full:** core, git, journal, IPC, main-process or wide changes. Light, plus trace the risky
  paths and run the relevant e2e spec with `--workers=1`.

**Critical paths always need AK** (the reviewer posts a verdict, AK merges):
signing, notarization, secrets and publishing; the auto-update feed and its signature checks;
licence validation, Polar product/price IDs, prices and legal terms; history rewrites.

**`feat` PRs** (new user-facing features or behaviour) are reviewed as usual but merged by AK, not
the reviewer: post the verdict and assign AK.

## Verdict

- The verdict comment starts with a count, e.g. `0 Important · 2 Nits · 1 Pre-existing`.
- At most one fix round. If it still doesn't pass, it goes to AK.

## Stacked series

The only allowed stacking: one feature split by one author into at most 4 parts on the same issue
(or its sub-issues). Never on another agent's or another issue's PR unless AK says so.

A series is a **native GitHub stack**, made with GitHub's stack extension
(`gh extension install github/gh-stack`; check that `gh stack --help` works). A plain chain of
`gh pr create --base <previous branch>` is not a stack: GitHub shows no stack view for it, can't
merge it as a stack, and won't rebase and retarget the next part after a merge.

- Part 1 is based on `main`, part k on part k-1's branch. Every part passes tests on its own.
- Author: put a local branch at the end of each part, then one command, bottom to top:
  `gh stack link --open <branch 1> <branch 2> …`. It pushes the branches, opens the PRs with the
  right bases and registers the stack. Then set titles and bodies with `gh pr edit`. PRs that
  already exist are joined with `gh stack link <PR 1> <PR 2> …`.
- A part never merges the branch below into itself: when the part below changes, rebase onto it.
- Titles end with `[k/n]`; each body starts with `Stacked series k/n · depends on #<PR>`
  (part 1: `· base`).
- Reviewer: check that GitHub shows the series as a stack:
  `gh api graphql -f query='{ repository(owner:"0xa3k5", name:"gitlanes") { pullRequest(number:<PR>) { stack { number size } } } }'`
  must return a stack whose `size` is n. If it is `null`, ask the author for `gh stack link`.
- Merged strictly bottom-up, one reviewed part at a time: `gh stack merge <PR k> --squash --yes`
  (no `--delete-branch`). GitHub then rebases and retargets the next part onto `main`. If it can't,
  rebase by hand after the squash: `git rebase --onto origin/main <old part k tip> <part k+1>`. Delete the part branches after the last part has merged.

## Known recurring issues

Append here when a kind of finding repeats.

- **Stash identity:** stashes are identified by SHA. A `stash@{n}` index shifts as soon as another
  stash is pushed or dropped, so drop/apply/undo can hit the wrong stash.
- **Remotes and `insteadOf`:** `git remote -v` shows URLs after `url.<base>.insteadOf` rewriting,
  which differ from what is configured. Use the rewritten `url` for display and web links, and the
  configured `setUrl` (`getRemotes` in `git.js`) for editing a remote and its undo, so undo never
  writes the rewritten URL into config.
