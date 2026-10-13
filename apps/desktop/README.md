# GitLanes

A fast, keyboard-first Git client for macOS with a live commit graph you operate on directly,
unlimited undo/redo for every ref change, and a calm, dense design with first-class light and dark themes.

From the repository root:

    npm install
    npm run desktop [-- path/to/repo]
    npm test            # unit tests (node:test)
    npm run test:e2e    # end-to-end UI tests (Playwright + Electron)

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
- `main.js`: windows, menu, IPC, FSEvents watcher (live refresh), unlimited undo/redo journal (`.git/gitlanes-history.json`).
- `renderer/`: buildless ES modules. Canvas commit graph + virtualized list. The log streams in from git
  (topology first, subjects and authors behind it) and the graph is laid out incrementally, so there is no
  commit cap: the 1.5M-commit Linux kernel opens in well under a second. See [docs/performance.md](../../docs/performance.md).

## Benchmark
`npm run bench` opens large repositories in the real app and records first paint, full graph, scroll frame rate and
memory. It generates synthetic 100k/250k-commit repos; pass `--linux <path>` (or `--clone`) for the Linux kernel.

## Features
Map (graph, branch/tag/remote pills, search, quick view, diff with HEAD) · commit actions: checkout, branch, tag,
merge, rebase onto, cherry-pick, revert, edit message, squash/fixup with parent, swap with parent, delete, move branch tip ·
Commit view with file/hunk/line staging, discard, amend, conflict resolution (ours/theirs/resolved) ·
Stashes · Snapshots (undo/redo/restore) · Unified reflog · Config editor · Fetch/Pull/Push · ⌘K command menu ·
Worktrees (⌘7): add (⌥⌘N, or W on a commit), switch the window (⌥⌘W) or open in a new window, lock/unlock, remove (blocked while
dirty, undoable); other worktrees' branches and detached HEADs are marked on the graph ·
Theme: System / Light / Dark (View → Theme, ⌃⌘T to cycle).

Not yet: commit splitter, external diff/merge tools, submodules, auto-updates.

Packaging and releases: see the [root README](../../README.md#building-the-dmg).
