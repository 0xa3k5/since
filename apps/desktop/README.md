# GitLanes

A fast, keyboard-first Git client for macOS with a live commit graph you operate on directly,
unlimited undo/redo for every ref change, and a calm, dense design with first-class light and dark themes.

From the repository root:

    npm install
    npm run desktop [-- path/to/repo]
    npm test

## Architecture
- `git.js`: dependency-free git CLI layer (log/refs/status parsing, partial-line patches, history rewriting via scripted `rebase -i`, ref snapshots).
- `main.js`: windows, menu, IPC, FSEvents watcher (live refresh), unlimited undo/redo journal (`.git/gitlanes-history.json`).
- `renderer/`: buildless ES modules. Canvas commit graph + virtualized list, so 20k+ commits stay smooth.

## Features
Map (graph, branch/tag/remote pills, search, quick view, diff with HEAD) · commit actions: checkout, branch, tag,
merge, rebase onto, cherry-pick, revert, edit message, squash/fixup with parent, swap with parent, delete, move branch tip ·
Commit view with file/hunk/line staging, discard, amend, conflict resolution (ours/theirs/resolved) ·
Stashes · Snapshots (undo/redo/restore) · Unified reflog · Config editor · Fetch/Pull/Push · ⌘K command menu ·
Theme: System / Light / Dark (View → Theme, ⌃⌘T to cycle).

Not yet: commit splitter, external diff/merge tools, submodules, auto-updates.

## Trial and licence
`licence/` (main process) owns the 14-day local trial and licence keys; `renderer/licence.js` is the UI
(topbar chip, licence window, ⌥⌘L, ⌘K). After the trial GitLanes stays read-only: reads and fetch work,
changes are refused until a licence is added. Keys are Polar licence keys, activated per Mac and validated
once per session; the last good validation is cached (signed) so the app works offline for 30 days.

- Store profile: `GITLANES_STORE=sandbox` (default) `| production | mock`. Values live in `licence/config.js`.
  `GITLANES_STORE=production npm run dist` bakes the profile into a release.
- `GITLANES_STORE=mock npm run desktop` accepts any `GL-TEST-…` key (`GL-TEST-REVOKED…`, `GL-TEST-FULL…`,
  `GL-TEST-OFFLINE…` exercise the failure paths).
- `GITLANES_CLOCK_OFFSET_DAYS=20` (unpackaged builds only) moves the clock forward to see later trial days.
  The trial starts on first launch, so launch once without it first.

Packaging and releases: see the [root README](../../README.md#building-the-dmg).
