# Contributing to Since

Thanks for helping. Bug reports, fixes and small improvements are welcome. For a new feature or a
larger change, open an issue first so we can agree on the approach before you write the code.

## Setup

You need macOS, Node.js 24 (see `.nvmrc`), Git and pnpm. Use pnpm for everything; npm, yarn and bun
are blocked, and `package-lock.json` must never be committed.

    corepack enable
    pnpm install
    pnpm desktop [-- path/to/repo]
    pnpm test

The renderer is buildless: plain JavaScript, no frameworks and no bundler. See
[apps/desktop/README.md](apps/desktop/README.md) for the architecture and
[CLAUDE.md](CLAUDE.md) for the project rules in short form.

## Tests

- `pnpm test` runs the unit tests for every package. It must pass before you open a PR.
- The end-to-end tests open real Since windows. Run only the spec that covers your change, from
  `apps/desktop`: `pnpm exec playwright test -c e2e undo.spec.js --workers=1`. CI runs the full suite
  before releases.
- Tests that change a repository run only in temporary repos, never in your own.

## Rules for changes

- Everything that changes a local repo (refs, work tree, stashes, config) is undoable through
  `apps/desktop/journal.js`.
- Every IPC argument is validated in `apps/desktop/ipc.js`. The renderer stays sandboxed with no
  network access.
- No new network calls beyond those listed in [docs/security.md](docs/security.md). No telemetry,
  no accounts.
- Colours come from tokens (`var(--…)`), never hard-coded. Light and dark themes both have to work.
- New actions get a ⌘K entry. Add a keyboard shortcut only for a frequent action, and say why in the PR.
- UI text is labels, values, status, errors and short warnings about irreversible actions. No
  instructional copy in the app; that belongs in the website docs.

## Commits and pull requests

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/):

    <type>(<scope>): <summary>

- Types: `feat`, `fix`, `perf`, `refactor`, `style`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes: `desktop`, `web`, `tokens`, `release`, `ci`, `deps`. Omit the scope only if the change spans everything.
- Summary: imperative, lower case, no trailing period, 72 characters at most, and it says what changes
  for the user, e.g. `fix(desktop): keep branch checked out after undoing a conflicted rebase`.

PRs are squash-merged, so the PR title becomes the commit on `main`. Keep one change per PR.

### Sign your commits off (DCO)

Every commit must carry a `Signed-off-by` line. By adding it you certify the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or
otherwise have the right to submit it under the project's licence. Use `git commit -s`:

    Signed-off-by: Your Name <you@example.com>

A GitHub noreply address is fine.

### PR checklist

- [ ] `pnpm test` passes; paste the result in the PR.
- [ ] If the change touches a flow an e2e spec covers, that spec passes.
- [ ] UI changes include light and dark screenshots.
- [ ] Repo-changing actions are undoable, new IPC arguments are validated, no new network calls.
- [ ] Say what you didn't test and why.

## Licence

Since is licensed under [GPL-3.0-or-later](LICENSE). By contributing, you agree that your
contributions are licensed under the same terms.
