# GitLanes

A fast, keyboard-first Git client for macOS with a live commit graph you operate on directly,
unlimited undo/redo for every ref change, and a calm, dense, dark-first design.

From the repository root:

    npm install
    npm run desktop [-- path/to/repo]
    npm test

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
Stashes · Snapshots (undo/redo/restore) · Unified reflog · Config editor · Fetch/Pull/Push · ⌘K command menu.

Not yet: commit splitter, external diff/merge tools, submodules, Sparkle updates, packaging/signing.
