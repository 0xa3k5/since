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
stashes, discard/reset, Snapshots, reflog recovery, config editing, undo/redo after each, and light/dark
smoke screenshots (saved under `test-results/`). CI runs the suite on macOS and uploads the results.
A known bug is kept as a `test.fail` so the suite flags when it is fixed.

## Architecture
- `git.js`: dependency-free git CLI layer (log/refs/status parsing, partial-line patches, history rewriting via scripted `rebase -i`, ref snapshots).
- `updater.js`: update checks and install (see Updates).
- `main.js`: windows, menu, IPC, FSEvents watcher (live refresh), unlimited undo/redo journal (`.git/gitlanes-history.json`).
- `renderer/`: buildless ES modules. Canvas commit graph + virtualized list, so 20k+ commits stay smooth.

## Features
Map (graph, branch/tag/remote pills, search, quick view, diff with HEAD) · commit actions: checkout, branch, tag,
merge, rebase onto, cherry-pick, revert, edit message, squash/fixup with parent, swap with parent, delete, move branch tip ·
Commit view with file/hunk/line staging, discard, amend, conflict resolution (ours/theirs/resolved) ·
Stashes · Snapshots (undo/redo/restore) · Unified reflog · Config editor · Fetch/Pull/Push · ⌘K command menu ·
Theme: System / Light / Dark (View → Theme, ⌃⌘T to cycle).

Not yet: commit splitter, external diff/merge tools, submodules.

## Updates
`updater.js` uses Electron's built-in `autoUpdater` (Squirrel.Mac), so it adds no dependency. The packaged app
checks a few seconds after launch and then once a day. It downloads in the background, then shows a
"Restart to update" toast. You can also check from GitLanes → Check for Updates… or ⌘K → "Check for updates".
If an update can't be installed in place (an unsigned build, or the app is running from the DMG), the toast
links to the download page instead. The update never checks the licence, because updates are free for life.

**Network:** the update check is the app's only network call apart from git itself. It is a plain GET for
`update-mac-<arch>.json` at the `updates.feed` URL in `package.json`, followed by the zip download when there is
a newer version. No identifiers, no analytics. Dev builds (`npm run desktop`) make no update request unless you
set `GITLANES_UPDATE_FEED=<base url>`, and even then they never install.

**Testing:** `npm run test:update -w @gitlanes/desktop` runs the full flow on macOS against two local test
releases. It packages 0.0.1 and 0.0.2, signs both with a throwaway self-signed certificate (Squirrel only
accepts an update signed by the same identity as the running app), serves 0.0.2's zip and feed from localhost,
and then checks that 0.0.1 downloads it, shows "Restart to update", installs it and relaunches as 0.0.2.
It takes a few minutes. Screenshots are saved to `test-results/update-e2e/`. `e2e/update.spec.js` covers the
check, the toasts and the ⌘K entries in the regular Playwright suite.

Packaging and releases: see the [root README](../../README.md#building-the-dmg).
