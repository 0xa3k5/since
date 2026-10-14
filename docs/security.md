# Security and network audit

GitLanes runs your system `git` on repositories you open. It has no account, no server and no
telemetry. This page records what the app is allowed to do and the network audit behind the
website's "no telemetry, no account" claim. It was last checked on 2026-10-13 against `main`
at `b084e11` plus the AK-48 changes (Electron 44.7.0).

## Network: what leaves your Mac

**`git` talks to the network only when you ask it to.** Apart from git, the app makes two kinds
of request of its own, both from the main process: the update check and licence validation. The
renderer makes none. The opt-in pull request features work like git: GitLanes runs your GitHub
CLI (`gh`), and the connection happens inside `gh`, under your `gh` login. GitLanes never sees
or stores a GitHub token, and opens no connection for them itself.

| What | When | Who connects | To where |
| --- | --- | --- | --- |
| Clone | You choose *Clone Repository…* | `git clone` | The URL you typed |
| Fetch | You press *Fetch* (⌘⇧F) | `git fetch --all --prune --tags` | Your configured remotes |
| Pull | You press *Pull* (⌘⇧L) | `git pull` | The current branch's upstream |
| Push, push tags, delete remote branch | You press *Push* (⌘⇧P) or pick the menu item | `git push` | Your configured remotes |
| Open in hosting service, View on hosting service | You pick the menu item | Your default browser, not GitLanes | The remote's web page |
| Update check | At launch and about daily (*Automatically check for updates*, can be switched off), or *Check for Updates…* | The updater's private `gitlanes-updates` session | `https://github.com` (the update feed) and GitHub's release-asset hosts it redirects to |
| Update download | When a newer signed version is found | macOS's updater (Squirrel) | The release zip named by the feed |
| Licence validation | Activating a key, at launch and about daily | Main process | Polar's licence API (`api.polar.sh`) |
| PR set-up check | You turn on *Pull requests* for this repository (off by default, per repository) | `gh auth status --hostname <host>` | Your GitHub host (`github.com` or your GitHub Enterprise host) |
| PR status | Pull requests are on for this repository and you fetch (⌘⇧F), refresh PRs (⌘⌥⇧P), turn them on, or approve or close one; or the lanes overview asks for its PRs (`app:lanes-list` with `prs: true`; without it, or with pull requests off, the lanes list is local git only) | `gh pr list --repo …` | `api.github.com`, or your GitHub Enterprise host |
| PR inbox | Pull requests are on and the lanes overview shows its *Inbox* tab (⌘⇧I, or Tab in the overview), on the same refreshes as its PR status | `gh pr list --repo … --search review-requested:@me --json number` per refresh, and `gh api user --hostname <host> --jq .login` once per host per session (your login, to find your own PRs). The PR status call above also asks for `mergeable`. *Merge all ready* (⇧M) runs `gh pr merge --repo … --squash` once per PR after one confirmation | `api.github.com`, or your GitHub Enterprise host |
| PR actions: approve, merge, close | Pull requests are on and you pick *Approve…* (⌘⌥⇧A), *Merge…* (⌘⌥⇧M) or *Close…* (⌘⌥⇧W) | `gh pr view`, `gh repo view`, `gh pr review --approve`, `gh pr merge`, `gh pr close` (all with `--repo`) | `api.github.com`, or your GitHub Enterprise host |
| New pull request | Pull requests are on and you pick *New Pull Request…* (⌘⌥⇧N) and confirm the sheet; a branch that isn’t on GitHub yet is pushed first only if you tick the push box | `gh repo view --json defaultBranchRef` when the sheet opens, `gh pr create --repo … --head … --body-file -` when you confirm. *Draft with AI* sends the branch’s commits and diff to the AI provider you already set up for commit messages (see above) | `api.github.com`, or your GitHub Enterprise host; the push goes to your remote like any push |

There is no background or scheduled fetch, and no PR polling: while a repository's pull request
toggle is off, `gh` is never even looked up (`test/github.test.js` checks this). Git may also reach the network through your own
configuration (hooks, credential helpers, Git LFS filters on checkout, `includeIf` or
`url.*.insteadOf` rules). Those run under your settings, exactly as they would in a terminal.

Every Electron session is locked to local files; the `gitlanes-updates` session alone may also
reach the feed's origin, over HTTPS only (`ipc.requestAllowed`, `updater.feedOrigins`;
`test/ipc.test.js` checks the allow-list). Development builds have no update feed unless
`GITLANES_UPDATE_FEED` is set, which may then be a local `http://127.0.0.1` server.

### How this was checked

- **Code.** The main process (`main.js`, `git.js`, `journal.js`, `ipc.js`) requires none of
  Node's `http`, `https`, `net`, `tls`, `dns` or `dgram` modules, and uses neither Electron's
  `net`, `autoUpdater` nor `crashReporter`. The app has no runtime npm dependencies
  (`test/packaging.test.js` enforces this). The only git subcommands that use the network
  (`clone`, `fetch`, `pull`, `push`) are started from the user actions listed above.
  `test/packaging.test.js` checks that no packaged main-process file requires a Node network
  module or Electron's `net`, and that `git.js`, `ai.js` and `github.js` never call `fetch`;
  the only requests the app makes itself are the update check (`updater.js`) and licence
  validation (`licence/stores.js`).
- **GitHub CLI calls.** `github.js` spawns `gh` the same way `ai.js` spawns AI CLIs: the binary
  is resolved on the extended `PATH`, runs in an empty temp folder with prompts off, has a
  30-second timeout after which its whole process group is killed. Every PR call passes `--repo` for a
  GitHub remote of this repository. `ipc.js` checks what the renderer sends first: the PR number
  must be a positive integer (`prNumber`) and the remote must be one of this repository's
  remotes (`knownRemote`); merge method and flags are checked against fixed lists
  (`test/ipc.test.js`).
- **Renderer, enforced.** The page's Content-Security-Policy has `default-src 'none'` and
  `connect-src 'none'`, and every session cancels requests that aren't `file:`, `data:` or
  DevTools (the updater's session may also reach the update feed's host). `e2e/security.spec.js` checks that `fetch`, `WebSocket` and remote images fail.
- **Runtime.** `e2e/security.spec.js` drives the app through every view, then lists the
  sockets held by the main process and all its helpers with `lsof`. Apart from Playwright's own
  loopback debugger connections, there are none (in development the updater has no feed, and
  e2e runs use a mock licence store). The packaged app (`electron-builder --dir`) was
  also run on a repository for 20 seconds with `lsof` sampling every 5 seconds: no sockets at all.
- **Chromium features that would phone home** are off: spellcheck (which downloads
  dictionaries) is disabled, and Electron ships without Google's Safe Browsing, sync or update
  services.

## Electron hardening

| Measure | Where |
| --- | --- |
| `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every window, plus `app.enableSandbox()` for any other renderer | `main.js` `createWindow`, lockdown section |
| `webviewTag: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `navigateOnDragDrop: false`, `safeDialogs: true` | `createWindow` |
| DevTools only in development builds (or with `GITLANES_DEVTOOLS=1`) | `createWindow`, View menu |
| Narrow preload API: `gitlanes.git(method, …)`, `gitlanes.app(channel, …)` and four listen-only event channels. No Node objects cross the bridge | `preload.js` |
| Strict CSP: `default-src 'none'`, scripts and styles only from the bundle, no inline script or style, no `eval`, no remote origins, `object-src`, `base-uri`, `form-action` and `frame-src` all `'none'` | `renderer/index.html` |
| No navigation, redirects, `window.open` or `<webview>` in any webContents. `http(s)` links open in the default browser; everything else is dropped | `web-contents-created` handler |
| Every permission request (camera, notifications, clipboard-read, HID, USB, …) is denied | `lockDownSession` |
| Network requests other than `file:`/`data:`/DevTools are cancelled in every session; the updater's own session may also reach the update feed's host over HTTPS | `lockDownSession` |
| IPC only from our own page: each handler checks the sender is the main frame of `renderer/index.html` in the app bundle | `handle()` in `main.js` |
| Every IPC argument is validated before use (below) | `ipc.js` |

### IPC argument validation

Each of the 64 git methods has a schema in `ipc.js`; methods without one are refused. The checks
are aimed at what a compromised renderer could try:

- **Option injection.** Ref and revision arguments may not start with `-` and may not contain
  whitespace or control characters, so `--upload-pack=…` or `-Xtheirs` can never be smuggled
  in as a branch name. The commit passed to history rewriting must be a hex object id.
- **Paths.** File paths must be repository-relative, with no `..` segments. *Open* and
  *Reveal in Finder* also resolve the path and refuse anything outside the repository root.
- **Worktree folders.** The worktree calls (`worktreeChanges`, `lockWorktree`, `unlockWorktree`,
  `removeWorktree`) and `app:open-window`, `app:terminal` and `app:reveal` take an absolute
  folder; main.js accepts it only if it is in the open repository's `git worktree list`
  (`ipc.knownWorktree`). *Reveal* takes either that or a repository-relative path. A new
  worktree (`addWorktree`) is checked for shape only: branch and base are revisions, and git
  creates the folder.
- **Shapes.** Exact types and fields: booleans are booleans, lists are lists, unexpected object
  fields are refused, and config keys must look like `section.name`.
- **Config that runs code.** The config editor refuses keys whose value git runs or loads:
  `core.fsmonitor`, `core.sshCommand`, `core.hooksPath`, `core.editor`/`pager`/`askPass`,
  `alias.*`, `filter.*`, `credential.*helper`, `gpg.*program`, `diff.*.textconv`,
  `merge.*.driver`, `include*`, `protocol.*`, `url.*` and similar (`ipc.safeConfigKey`). Change
  those in a terminal. Removing a key is always allowed.
- **Opening files.** *Open file* hands documents to their default app, but apps, scripts,
  installers, link files and anything with an execute bit (`ipc.runnable`) are revealed in Finder
  instead, so opening never runs code.
- **URLs.** `app:external` opens only `http:`/`https:` URLs without embedded credentials.
  Clone URLs may be `https`, `http`, `ssh`, `git`, `file`, scp-style `user@host:path` or a local
  path. Git's command-running transport helpers (`ext::`, `fd::`, `<helper>::`) are refused,
  and `git clone` also runs with `GIT_ALLOW_PROTOCOL=file:git:http:https:ssh` and `--` before
  the URL.

Validation already caught one real bug: the sidebar *Push* button passed its click event as the
`force` flag. It arrived in the main process as a truthy object, so that button ran
`git push --force-with-lease` instead of a plain push. Fixed in AK-48.

## Packaging (AK-41)

The DMG build sets these Electron fuses (`electron-builder.config.js`, checked by
`test/packaging.test.js` and confirmed on a built app with `pnpm dlx @electron/fuses read`):

| Fuse | Value | Why |
| --- | --- | --- |
| `RunAsNode` | off | `ELECTRON_RUN_AS_NODE` can't turn the signed app into a Node interpreter |
| `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` can't inject code |
| `EnableNodeCliInspectArguments` | off | `--inspect` can't attach a debugger to the shipped app |
| `EnableEmbeddedAsarIntegrityValidation` | on | A modified `app.asar` won't load |
| `OnlyLoadAppFromAsar` | on | The app can't be swapped for a loose `app/` folder |
| `EnableCookieEncryption` | on | Cookies, if any, are encrypted at rest |

AK-48 also fixed the packaged file list: `journal.js` (the undo journal from AK-40) was not
included, so the DMG would have failed at startup with "Cannot find module './journal'". A test
now follows every local `require()` from `main.js` and fails if a file isn't packaged.

### Not done yet

- **`GrantFileProtocolExtraPrivileges` fuse.** It is still on. Turning it off requires serving
  the renderer from a custom `app://` protocol instead of `file://`, because the renderer's ES
  module imports rely on those privileges. Worth doing, but it is a separate change.
- **Hardened runtime and notarization** are on only when a Developer ID certificate is present
  (AK-41). Unsigned builds are ad-hoc signed without hardened runtime.

## Reporting a vulnerability

Until the website's security page (AK-65) is live, report issues privately to the owner rather
than in a public GitHub issue.
