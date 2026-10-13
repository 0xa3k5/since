# GitLanes

A fast, keyboard-first Git client for macOS. It brings [GitUp](https://gitup.co)'s live commit map and
undo-everything workflow to a small Electron app with a Linear-inspired design.

From the repository root:

    npm install
    npm run desktop [-- path/to/repo]
    npm test

## Architecture
- `git.js`: dependency-free git CLI layer (log/refs/status parsing, partial-line patches, history rewriting via scripted `rebase -i`, ref snapshots).
- `main.js`: windows, menu, IPC, FSEvents watcher (live refresh), unlimited undo/redo journal (`.git/gitlanes-history.json`).
- `renderer/`: buildless ES modules. Canvas commit graph + virtualized list, so 20k+ commits stay smooth.

## Features
The feature set was mapped from the actions in GitUp 1.4.1's interface files. No GitUp code is used.

Map (graph, branch/tag/remote pills, search, quick view, diff with HEAD) · commit actions: checkout, branch, tag,
merge, rebase onto, cherry-pick, revert, edit message, squash/fixup with parent, swap with parent, delete, move branch tip ·
Commit view with file/hunk/line staging, discard, amend, conflict resolution (ours/theirs/resolved) ·
Stashes · Snapshots (undo/redo/restore) · Unified reflog · Config editor · Fetch/Pull/Push · ⌘K command menu.

Not yet: commit splitter, external diff/merge tools, submodules, Sparkle updates, packaging/signing.
