# Since

Since is a fast, keyboard-first Git client for macOS: Electron, TypeScript transpiled file by file
(no bundler, no frameworks), and the system `git`. The main screen is a live commit graph you operate on
directly, with undo/redo for every ref change. Positioning: supervise and land agent work.

**Non-goals:** no accounts or hosted service, no telemetry, Mac only (no Windows/Linux).

## Layout

- `apps/desktop`: the app.
  - `src/main/`: the main process. `main.ts` (entry, app lifecycle), `windows.ts`, `menu.ts`,
    `lockdown.ts` (session lock-down), `handlers/` (IPC handlers by area), `ipc.ts` (argument checks
    for every IPC call), `git/` (all git calls: `run.ts` spawns git, one module per area, `index.ts` exports them), `journal.ts` (undo/redo),
    `updater.ts`, `github.ts`, `ai.ts`, and `stores/` (recent repos, catch-up, window state, tabs)
  - `src/preload/preload.ts`: the sandboxed bridge (`window.since`)
  - `src/shared/channels.ts`: IPC channel names; `src/shared/ipc-contract.ts`: what each channel
    takes and returns, shared by main, preload and renderer
  - `src/renderer/`: the UI. `app.ts` wires the areas together, one folder per area
    (`graph/`, `commit/`, `history/`, `lanes/`, `review/`, `prs/`, `branches/`, `catchup/`,
    `palette/` with `keymap.ts`, `shell/`, `settings/`, `welcome/`) and `lib/` (DOM toolkit, helpers).
    Imports only point down; a lower module calls a higher one through `lib/upcalls.ts`, and the
    higher module declares the type of each upcall it registers next to its `Object.assign(up, …)`
  - `scripts/build.js`: builds `src/` into `out/`, which Electron runs and electron-builder packages.
    esbuild transpiles each `.ts` file on its own (no bundling); every other file is copied
  - `test/` (unit, `node --test`) and `e2e/` (Playwright specs) stay JavaScript; `tsconfig.tools.json`
    type-checks the build and release scripts in `scripts/` (`checkJs`)
- `apps/web`: the website (Astro).
- `packages/tokens`: design tokens (`tokens.json` → `tokens.css`), the source of truth for colours.
- `docs/`: security/network audit (`docs/security.md`), performance notes.

## Commands

pnpm only (never `npm`/`npx`/`yarn`, never commit `package-lock.json`).

- `pnpm install`
- `pnpm test`: type check (`tsc`, strict) and unit tests for every package. This is the local gate.
- `pnpm run desktop`: build `out/` and start the app. `pnpm --filter @gitsince/desktop watch`
  rebuilds each file as it changes; reload the window to pick it up.
- `pnpm run web` / `pnpm run web:build`: website dev server / build with link check.
- One e2e spec, one worker (in `apps/desktop`):
  `pnpm exec playwright test -c e2e undo.spec.js --workers=1`
- Never run the full e2e suite (`pnpm test:e2e`) locally unless asked; CI runs it before releases.
- Never sign builds. Packaged builds only when an issue asks, always unsigned:
  `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run dist`. Never call `codesign`, `notarytool` or `security`.

## Conventions

- New files are TypeScript: `strict`, erasable syntax only (no enums, namespaces or parameter
  properties), relative imports name the `.ts` file, and no `any` without a comment saying why.
- New actions get a ⌘K entry. Add a keyboard shortcut only for a frequent action in its context,
  with the reason in the PR body (keymap in `src/renderer/palette/keymap.ts`).
- No instructional or teaching copy in the UI: labels, values, status, errors and short warnings
  about irreversible actions only. Teaching goes on the website docs.
- Light and dark themes are both first-class for every UI change.
- Everything that changes a local repo (refs, work tree, stashes, config) is undoable through
  `journal.ts`. Identify stashes by SHA, not by `stash@{n}` index.
- Every IPC argument is validated in `ipc.ts`; the renderer is sandboxed and has no network.
- No network calls beyond those listed in `docs/security.md`.
- Use tokens (`var(--…)`) instead of hard-coded colours.
- No competitor names anywhere public-facing or shipped (code, UI, README, website, changelog).
- Destructive tests run only in temp repos.

## Pull requests

- One PR per issue, branched from the latest `main`, based on `main`, squash-merged.
- Title (becomes the commit on `main`) in Conventional Commits, ending with the issue key:
  `<type>(<scope>): <summary> (AK-NN)`. Types: feat, fix, perf, refactor, style, docs, test,
  build, ci, chore, revert. Scopes: desktop, web, tokens, release, ci, deps.
  Summary: imperative, lower case, no period, ≤72 characters.
- Related work ships as a stacked PR series (`[k/n]`, merged bottom-up, see `REVIEW.md`).
  Unrelated work is a separate PR on `main`. No other stacking.
- AK's feedback on an open PR goes into that same PR.
- UI changes include light and dark screenshots.
- End the PR body with the review brief (files, risky spots, tests, not tested, AK-only areas).
  What the reviewer checks is in `REVIEW.md`.

## Verification

Show evidence, don't claim success: paste the `pnpm test` result (and any spec you ran) in the PR.
Say plainly what wasn't tested and why.
