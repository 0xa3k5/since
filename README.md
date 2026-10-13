# GitLanes

[![CI](https://github.com/0xa3k5/gitlanes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/0xa3k5/gitlanes/actions/workflows/ci.yml)

A fast, keyboard-first Git client for macOS, plus its website.

| Path | What |
|---|---|
| `apps/desktop` | The Electron app ([README](apps/desktop/README.md)) |
| `apps/web` | The website (Astro, static) |
| `packages/tokens` | Brand colour tokens for both themes, shared by the site (and mirrored in the desktop app) |

    npm install
    npm run desktop [-- path/to/repo]
    npm test
    npm run web          # website dev server
    npm run web:build    # static build into apps/web/dist, plus an internal link check
