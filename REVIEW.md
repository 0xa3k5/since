# Reviewing GitLanes PRs

What the reviewer checks before a squash merge. Working rules for authors are in `CLAUDE.md`.

## What failure looks like (blocks the merge)

- Data loss, or a change to refs, the work tree or stashes that ⌘Z can't undo exactly.
- The wrong stash or branch: identity taken from a `stash@{n}` index or a name instead of a SHA.
- Secrets or credentials shown in the UI or written to logs.
- An IPC call whose arguments aren't validated in `apps/desktop/ipc.js`.
- A network call beyond the ones documented in `docs/security.md`.
- Breaking the update feed, its signature checks, or the licence checks.
- A keyboard trap, or an action without a shortcut and a ⌘K entry.

## Findings

- Tag each finding **Important**, **Nit** or **Pre-existing**, with `file:line` evidence.
- Nits are capped at 3. No style-only findings.
- Findings in the PR's own new code are fixed in that PR: by the reviewer if small and
  mechanical, otherwise one send-back to the author.
- Only Pre-existing findings become follow-up issues.

## Review levels

- **Docs-only:** docs, comments, copy. Check facts against the code and commands.
- **Light:** small, contained changes. Read the diff, run `pnpm test` on the PR merged with `main`.
- **Full:** core, git, journal, IPC, main-process or wide changes. Light, plus trace the risky
  paths and run the relevant e2e spec with `--workers=1`.

**Critical paths always need AK** (the reviewer posts a verdict, AK merges):
signing, notarization, secrets and publishing; the auto-update feed and its signature checks;
licence validation, Polar product/price IDs, prices and legal terms; history rewrites.

## Verdict

- The verdict comment starts with a count, e.g. `0 Important · 2 Nits · 1 Pre-existing`.
- At most one fix round. If it still doesn't pass, it goes to AK.

## Stacked series

The only allowed stacking: one feature split by one author into at most 4 parts on the same issue
(or its sub-issues). Part 1 is based on `main`, part k on part k-1's branch. Titles end with
`[k/n]`; each body starts with `Stacked series k/n · depends on #<PR>` (part 1: `· base`). Every part
passes tests on its own. Merged strictly bottom-up; each next part is rebased onto `main` after
the squash.

## Known recurring issues

Append here when a kind of finding repeats.

- **Stash identity:** stashes are identified by SHA. A `stash@{n}` index shifts as soon as another
  stash is pushed or dropped, so drop/apply/undo can hit the wrong stash.
- **Remotes and `insteadOf`:** `git remote -v` shows URLs after `url.<base>.insteadOf` rewriting,
  which differ from what is configured. Use the rewritten `url` for display and web links, and the
  configured `setUrl` (`getRemotes` in `git.js`) for editing a remote and its undo, so undo never
  writes the rewritten URL into config.
