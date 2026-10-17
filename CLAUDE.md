# GitLanes

GitLanes is a fast, keyboard-first Git client for macOS: Electron, a buildless renderer (plain JS,
no frameworks), and the system `git`. The main screen is a live commit graph you operate on
directly, with undo/redo for every ref change. Positioning: supervise and land agent work.

**Non-goals:** no accounts or hosted service, no telemetry, Mac only (no Windows/Linux).

## Layout

- `apps/desktop`: the app.
  - `main.js` (window, menus, session lock-down), `ipc.js` (argument checks for every IPC call),
    `git.js` (all git calls), `journal.js` (undo/redo), `updater.js`, `licence/`
  - `renderer/`: buildless UI (`app.js`, `graph.js`, `keymap.js`, views), `tokens/`
  - `test/` (unit, `node --test`), `e2e/` (Playwright specs)
- `apps/web`: the website (Astro).
- `packages/tokens`: design tokens (`tokens.json` → `tokens.css`), the source of truth for colours.
- `docs/`: security/network audit (`docs/security.md`), performance notes.

## Commands

pnpm only (never `npm`/`npx`/`yarn`, never commit `package-lock.json`).

- `pnpm install`
- `pnpm test`: unit tests for every package. This is the local gate.
- `pnpm run desktop`: start the app.
- `pnpm run web` / `pnpm run web:build`: website dev server / build with link check.
- One e2e spec, one worker (in `apps/desktop`):
  `pnpm exec playwright test -c e2e undo.spec.js --workers=1`
- Never run the full e2e suite (`pnpm test:e2e`) locally unless asked; CI runs it before releases.
- Never sign builds. Packaged builds only when an issue asks, always unsigned:
  `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run dist`. Never call `codesign`, `notarytool` or `security`.

## Conventions

- Every action gets a keyboard shortcut and a ⌘K entry (keymap in `renderer/keymap.js`).
- Light and dark themes are both first-class for every UI change.
- Everything that changes a local repo (refs, work tree, stashes, config) is undoable through
  `journal.js`. Identify stashes by SHA, not by `stash@{n}` index.
- Every IPC argument is validated in `ipc.js`; the renderer is sandboxed and has no network.
- No network calls beyond those listed in `docs/security.md`.
- Use tokens (`var(--…)`) instead of hard-coded colours.
- No competitor names anywhere public-facing or shipped (code, UI, README, website, changelog).
- Destructive tests run only in temp repos.

## Pull requests

- One PR per issue, branched from the latest `main`, based on `main`, squash-merged.
- Title (becomes the commit on `main`) in Conventional Commits, ending with the issue key:
  `<type>(<scope>): <summary> (AK-NN)`. Types: feat, fix, perf, refactor, style, docs, test,
  build, ci, chore, revert. Scopes: desktop, web, tokens, licence, release, ci, deps.
  Summary: imperative, lower case, no period, ≤72 characters.
- No stacking across PRs, except a stacked series as defined in `REVIEW.md`.
- UI changes include light and dark screenshots.
- End the PR body with the review brief (files, risky spots, tests, not tested, AK-only areas).
  What the reviewer checks is in `REVIEW.md`.

## Verification

Show evidence, don't claim success: paste the `pnpm test` result (and any spec you ran) in the PR.
Say plainly what wasn't tested and why.
