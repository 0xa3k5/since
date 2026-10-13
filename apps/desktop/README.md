# GitLanes

A fast, keyboard-first Git client for macOS with a live commit graph you operate on directly,
unlimited undo/redo for every ref change, and a calm, dense design with first-class light and dark themes.

From the repository root:

    pnpm install
    pnpm desktop [-- path/to/repo]
    pnpm test        # unit tests (node:test)
    pnpm test:e2e    # end-to-end UI tests (Playwright + Electron)

## End-to-end tests
`e2e/` drives the real app with Playwright's Electron support. Each test builds throwaway repositories
(and bare "remotes") in a temp dir, with its own git config and app userData, so it never touches a real
repository or your settings. Native open/save dialogs are stubbed in the main process. Covered: history
rewriting from the Map, merge/rebase conflicts (ours/theirs/manual, continue/abort), clone/fetch/pull/push,
stashes, discard/reset, Snapshots, reflog recovery, config editing, worktrees, undo/redo after each, and light/dark
smoke screenshots (saved under `test-results/`). CI runs the suite on macOS and uploads the results.
A known bug is kept as a `test.fail` so the suite flags when it is fixed.

## Architecture
- `git.js`: dependency-free git CLI layer (log/refs/status parsing, partial-line patches, history rewriting via scripted `rebase -i`, ref snapshots).
- `updater.js`: update checks and install (see Updates).
- `main.js`: windows, menu, IPC, FSEvents watcher (live refresh), unlimited undo/redo journal (`.git/gitlanes-history.json`).
- `ipc.js`: argument checks for every IPC call. The renderer is sandboxed, has no network access and only reaches git through these checks; see [docs/security.md](../../docs/security.md).
- `renderer/`: buildless ES modules. Canvas commit graph + virtualized list. The log streams in from git
  (topology first, subjects and authors behind it) and the graph is laid out incrementally, so there is no
  commit cap: the 1.5M-commit Linux kernel opens in well under a second. See [docs/performance.md](../../docs/performance.md).

## Benchmark
`pnpm bench` opens large repositories in the real app and records first paint, full graph, scroll frame rate and
memory. It generates synthetic 100k/250k-commit repos; pass `--linux <path>` (or `--clone`) for the Linux kernel.

## Features
Map (graph, branch/tag/remote pills, search, quick view, diff with HEAD) · commit actions: checkout, branch, tag,
merge, rebase onto, cherry-pick, revert, edit message, squash/fixup with parent, swap with parent, split commit by lines (⇧S), delete, move branch tip ·
Commit view with file/hunk/line staging, discard, amend, conflict resolution (ours/theirs/resolved) ·
Stashes · Snapshots (undo/redo/restore) · Unified reflog · Config editor · Fetch/Pull/Push · ⌘K command menu ·
Worktrees (⌘7): add (⌥⌘N, or W on a commit), switch the window (⌥⌘W) or open in a new window, lock/unlock, remove (blocked while
dirty, undoable); other worktrees' branches and detached HEADs are marked on the graph ·
Theme: System / Light / Dark (View → Theme, ⌃⌘T to cycle).

Not yet: external diff/merge tools, submodules.

## Trial and licence
`licence/` (main process) owns the 14-day local trial and licence keys; `renderer/licence.js` is the UI
(topbar chip, licence window, ⌥⌘L, ⌘K). After the trial GitLanes stays read-only: reads and fetch work,
changes are refused until a licence is added (undo, redo, restore and abort still work). Keys are Polar
licence keys, activated per Mac and validated at launch, about daily while running, and before a change is
refused; the last good validation is cached (signed) so the app works offline for 30 days. Only Polar's own
error replies can revoke a key, and a revoked key is kept (marked revoked) so it can be re-checked or
deactivated. A clock set far forward is remembered and can end the trial early; that's a known trade-off of
not letting a rolled-back clock extend it.

- Store profile (unpackaged): `GITLANES_STORE=sandbox` (default) `| production | mock`. Values live in `licence/config.js`.
- Packaged builds ignore `GITLANES_STORE` at run time and never use `mock`; they use the profile baked in by
  `pnpm dist`: `production` by default (the build fails until its values are filled in), or
  `GITLANES_STORE=sandbox pnpm dist` for a test build. CI bakes `sandbox` except for final release tags.
- `GITLANES_TRIAL_MIRROR=<file>` (unpackaged only) moves the trial mirror; e2e uses it so runs don't touch your real trial.
- `GITLANES_STORE=mock pnpm desktop` accepts any `GL-TEST-…` key (`GL-TEST-REVOKED…`, `GL-TEST-FULL…`,
  `GL-TEST-OFFLINE…` exercise the failure paths).
- `GITLANES_CLOCK_OFFSET_DAYS=20` (unpackaged builds only) moves the clock forward to see later trial days.
  The trial starts on first launch, so launch once without it first.

## Updates
`updater.js` uses Electron's built-in `autoUpdater` (Squirrel.Mac), so it adds no dependency. The packaged app
checks a few seconds after launch and then once a day. It downloads in the background, then shows a
"Restart to update" toast. You can also check from GitLanes → Check for Updates… or ⌘K → "Check for updates".
If an update can't be installed in place (an unsigned build, or the app is running from the DMG), the toast
links to the download page instead. The update never checks the licence, because updates are free for life.
Turn off the launch and daily checks with GitLanes → Automatically Check for Updates or ⌘K → "Turn off automatic
update checks"; manual checks still work. Builds without a real signing identity (unsigned or ad-hoc signed)
never hand the download to Squirrel; they show the download link instead.

**Network:** the update check is the app's only network call apart from git itself. It is a plain GET for
`update-mac-<arch>.json` at the `updates.feed` URL in `package.json`, followed by the zip download when there is
a newer version. No identifiers, no analytics. Dev builds (`pnpm desktop`) make no update request unless you
set `GITLANES_UPDATE_FEED=<base url>`, and even then they never install.

**Testing:** `pnpm --filter @gitlanes/desktop test:update` runs the full flow on macOS against two local test
releases. It packages 0.0.1 and 0.0.2, signs both with a throwaway self-signed certificate (Squirrel only
accepts an update signed by the same identity as the running app), serves 0.0.2's zip and feed from localhost,
and then checks that 0.0.1 downloads it, shows "Restart to update", installs it and relaunches as 0.0.2.
It takes a few minutes. Screenshots are saved to `test-results/update-e2e/`. `e2e/update.spec.js` covers the
check, the toasts and the ⌘K entries in the regular Playwright suite.

Packaging and releases: see the [root README](../../README.md#building-the-dmg).
