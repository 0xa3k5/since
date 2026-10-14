# Performance

GitLanes opens very large histories without a commit cap. On an M1 Pro, the full Linux kernel history
(1,485,146 commits) shows its first rows **0.3 s after the window loads** (0.54 s from launch) and is laid out
end to end in **3.5 s**. Scrolling stays at the display's refresh rate (120 fps).

All numbers on this page come from `pnpm bench` (see [Reproducing](#reproducing)). They were measured on
2026-10-13 on an Apple M1 Pro (16 GB, macOS 27.0, git 2.49.0, 120 Hz display), median of 3 runs.

## Quotable numbers

Safe to use in marketing as written (machine: M1 Pro, 16 GB):

- "Opens the 1.5-million-commit Linux kernel history in about half a second, and the whole graph in 3.5 seconds."
- "First rows on screen within 0.4 s of the window opening, from 100k to 1.5M commits."
- "Smooth 120 fps scrolling through 1.5 million commits."
- "No commit limit."

Please keep the machine next to any number, and don't round 0.54 s down to "instant".

## Budgets

| Budget | Target | Result (warm) | |
|---|---|---|---|
| First paint, 100k commits, from window load | < 500 ms | 267 ms | ✅ |
| First paint, 100k commits, from app launch | < 1,000 ms | 530 ms | ✅ |
| First paint, 1.5M commits (Linux), from window load | < 500 ms | 286 ms | ✅ |
| Full graph, 100k commits | < 1.5 s | 0.70 s | ✅ |
| Full graph, 1.5M commits | < 5 s | 3.5 s | ✅ |
| Scroll, any size: p95 frame time | < 16.7 ms (60 fps) | ≤ 10.3 ms | ✅ |
| Memory after loading 100k commits (all processes, idle) | < 800 MB | ~550 MB | ✅ |
| Memory after loading 1.5M commits (all processes, idle) | < 1.5 GB | ~1.35 GB | ✅ (tight) |

"Warm" means git's commit-graph file exists, which is the normal state of any repository GitLanes has opened
once (see [Cold opens](#cold-opens-fresh-clones)).

## Before and after

Before = `main` at `45077fa`, which loaded at most 20,000 commits. After = this change, which loads everything.
Times are from app launch unless noted.

### Warm opens

| Repo | Commits shown (before → after) | First paint | Full graph | Scroll fps (p95) | Jump fps (p95) |
|---|---|---|---|---|---|
| synthetic 100k | 20,000 → 100,000 | 1,177 → **530 ms** | 1,177 → **697 ms** | 117.5 (10.0) → 120.1 (9.9) | 99.5 (13.0) → 110.2 (9.7) |
| synthetic 250k | 20,000 → 250,000 | 934 → **560 ms** | 934 → **1,003 ms** | 117.7 (10.1) → 120.0 (10.1) | 110.7 (10.7) → 110.3 (9.8) |
| synthetic 1M | 20,000 → 1,000,000 | 2,363 → **641 ms** | 2,363 → **2,590 ms** | 116.4 (10.0) → 119.8 (10.2) | 108.3 (12.1) → 110.8 (9.8) |
| Linux kernel | 20,000 → 1,485,146 | 2,359 → **540 ms** | 2,359 → **3,504 ms** | 117.7 (10.0) → 120.0 (10.1) | 82.0 (13.9) → 105.0 (10.7) |

First paint measured from window load instead of app launch: 810 → 267 ms (100k), 2,053 → 286 ms (Linux).

### Cold opens (fresh clones)

| Repo | First paint | Full graph |
|---|---|---|
| synthetic 100k | 1,825 → **638 ms** | 1,825 → **1,257 ms** |
| synthetic 1M | 9,421 → **1,080 ms** | 9,421 → **7,365 ms** |
| Linux kernel | 26,446 → **707 ms** | 26,447 → **18,266 ms** |

A fresh clone usually has no commit-graph file. Without it, git has to walk the entire history before it can print
a date-ordered log. GitLanes now shows the newest 1,000 commits immediately (in plain date order, which streams
at once) and fills in the ordered graph when git gets there. After that first load it writes the commit-graph in
the background (`git commit-graph write --reachable`, the same file `git gc` and `git maintenance` write), so
every later open is warm.

### Memory

Resident memory of all app processes, measured by the benchmark right after its scroll tests:

| Repo | Before (20k commits) | After (all commits) |
|---|---|---|
| synthetic 100k | 610 MB | 1,169 MB |
| synthetic 1M | 376 MB | 1,442 MB |
| Linux kernel | 729 MB | 1,604 MB |

This is the honest cost of having every commit in memory. Measured idle after loading (no scrolling, after a GC),
the renderer's JS heap is 45 MB for 100k commits (about 550 MB across all processes) and 853 MB for the Linux
kernel (about 1.35 GB across all processes). The benchmark's figures run higher because they include the garbage
and GPU memory left by the jump-scroll test. Reducing per-commit memory is the main follow-up (see below).

## How it works

- **Streaming log.** The main process streams `git log` as raw text in batches and the renderer parses it.
  Cloning objects across IPC was the old bottleneck: 4.9 s just to transfer the Linux topology as objects,
  versus 0.2 s as text.
- **Topology first.** The graph needs only commit and parent hashes, which git reads straight from the
  commit-graph without opening commit objects (3.5 s for all of Linux). Subjects, authors and dates come in a
  second stream behind it (14 s for Linux); rows that are on screen before their details arrive are fetched
  on demand, so jumping to the end of history never shows blanks for long.
- **Incremental layout.** Lanes are laid out as commits arrive, with lane lookups through a map instead of
  scanning every open lane (Linux runs up to 590 lanes wide): all of Linux lays out in about 1.3 s. Only each
  row's lane and colour are stored; the lines through a row are rebuilt on demand from a checkpoint every 256 rows,
  only for the rows on screen.
- **Painting only what's visible.** The canvas paints visible rows only, and lanes past the 28th, which all share
  the last column, are drawn once.
- **Reloads keep what's unchanged.** The log only reloads when a branch, tag or HEAD actually moves. A reload is
  replayed against the history on screen: the unchanged prefix is kept, commits we already have keep their
  details, and only new commits are fetched.
- **Very tall lists.** Browsers can't lay out elements taller than about 33 million pixels (about a million rows).
  Past 16.7 million pixels the scrollbar is scaled, so the list can scroll through any number of commits.
- **No network from history reads.** In partial clones, `git log` could stall on a lazy fetch (Linux has tags
  pointing at trees); history reads run with `GIT_NO_LAZY_FETCH=1`.

## Known limits and follow-ups

- **Memory** grows with history size (about 575 bytes of JS heap per commit). Storing hashes and parents in typed
  arrays instead of one object per commit would roughly halve it.
- **Search** runs over the commits whose details have loaded; on a cold Linux open that's complete after ~20 s.
- **Cold first open** of a huge fresh clone shows its first rows fast, but the full ordered graph waits for git's
  full-history walk (18 s for Linux). Later opens are warm.
- The synthetic repos have ~24 concurrent branches; real repositories vary (Linux peaks at 590 lanes).

## Reproducing

```sh
pnpm install
pnpm bench                                  # synthetic 100k and 250k (generated on first run)
pnpm bench -- --repos synthetic-1m          # 1M commits
pnpm bench -- --linux ~/src/linux           # an existing Linux checkout
pnpm bench -- --repos linux --clone         # clone Linux (commits only, root-only sparse checkout)
pnpm bench -- --repo path/to/repo --runs 5  # any repository (never modified)
pnpm bench -- --out results.json
```

The lanes overview's data (`git.lanes()`, no window) has its own case: a generated repository with 200 branches
and 15 worktrees, about 0.2 s per call on an M1 Pro with git 2.49.

```sh
pnpm --filter @gitlanes/desktop bench:lanes                          # 200 branches, 15 worktrees
pnpm --filter @gitlanes/desktop bench:lanes -- --branches 500 --worktrees 30
```

The conflict forecast (`git.forecastConflicts()`) runs after the lanes list shows, never before it. It merges
each active lane with the base and pairs of active lanes with `git merge-tree --write-tree` (objects only, no
refs or worktrees touched), four at a time and at most 45 lane pairs (the 10 newest active lanes). Results are
cached by the two tips, so a refresh after a commit re-runs only the pairs whose tip moved, and a newer list
cancels the forecast still running. Lanes merged, missing or untouched for 14 days are skipped; on git before
2.38 there is no forecast.

The app opens in a real window at 1440×900; keep the machine otherwise idle. Generated and cloned repositories
live in `~/.cache/gitlanes-bench` (override with `--dir`). Cold runs delete the commit-graph file, so they're only
done for repositories the benchmark owns. The raw results behind this page are in
[`docs/bench/2026-10-13-m1pro-before.json`](bench/2026-10-13-m1pro-before.json) and
[`docs/bench/2026-10-13-m1pro-after.json`](bench/2026-10-13-m1pro-after.json).
