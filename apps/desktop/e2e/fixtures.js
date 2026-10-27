'use strict';
// Shared fixtures for the end-to-end suite. Every test gets its own temp dir
// holding throwaway repositories, a private git config and the app's userData,
// so nothing touches a real repository or the developer's settings.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');

// Fixed author and dates keep history (and --date-order) deterministic.
let clock = 1_760_000_000;
function gitEnv(home) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

class Sandbox {
  constructor(dir) {
    this.dir = fs.realpathSync(dir);
    this.home = path.join(this.dir, 'home');
    fs.mkdirSync(this.home);
    fs.writeFileSync(path.join(this.home, 'gitconfig'), [
      '[user]', '\tname = E2E Tester', '\temail = e2e@example.com',
      '[init]', '\tdefaultBranch = main',
      '[commit]', '\tgpgsign = false',
      '[tag]', '\tgpgsign = false',
      '[advice]', '\tdetachedHead = false',
      '[pull]', '\trebase = false',
      '',
    ].join('\n'));
    this.env = gitEnv(this.home);
  }

  path(...p) { return path.join(this.dir, ...p); }

  git(cwd, ...args) {
    const t = String(++clock);
    return execFileSync('git', args, {
      cwd,
      env: { ...this.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  write(repo, file, content) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }

  read(repo, file) { return fs.readFileSync(path.join(repo, file), 'utf8'); }

  commit(repo, subject, files = { [`${subject}.txt`]: `${subject}\n` }) {
    for (const [f, c] of Object.entries(files)) this.write(repo, f, c);
    this.git(repo, 'add', '-A');
    this.git(repo, 'commit', '-q', '-m', subject);
    return this.git(repo, 'rev-parse', 'HEAD');
  }

  init(name) {
    const repo = this.path(name);
    fs.mkdirSync(repo, { recursive: true });
    this.git(repo, 'init', '-q');
    return repo;
  }

  // A linear history: one file per commit, so reordering never conflicts.
  linear(name, subjects = ['one', 'two', 'three', 'four']) {
    const repo = this.init(name);
    for (const s of subjects) this.commit(repo, s);
    return repo;
  }

  // main and feature both change conflict.txt.
  conflicted(name) {
    const repo = this.init(name);
    this.commit(repo, 'base', { 'conflict.txt': 'base\n', 'readme.txt': 'hello\n' });
    this.git(repo, 'checkout', '-q', '-b', 'feature');
    this.commit(repo, 'feature change', { 'conflict.txt': 'feature\n' });
    this.git(repo, 'checkout', '-q', 'main');
    this.commit(repo, 'main change', { 'conflict.txt': 'main\n' });
    return repo;
  }

  // A bare "remote" with history, plus a clone of it to work in.
  remote(name = 'origin') {
    const seed = this.linear(`${name}-seed`, ['first', 'second']);
    const bare = this.path(`${name}.git`);
    this.git(this.dir, 'clone', '-q', '--bare', seed, bare);
    fs.rmSync(seed, { recursive: true, force: true });
    return bare;
  }

  clone(url, name) {
    const dest = this.path(name);
    this.git(this.dir, 'clone', '-q', url, dest);
    return dest;
  }

  // A GitHub repository without the network (AK-277): the remote is git@github.com:<owner>/<name>.git,
  // but git's ssh (core.sshCommand) is a script that runs the command on a bare repository here,
  // and a fake `gh` (fake-gh.js) answers from a JSON state file. Each PR is a branch in the bare repository with
  // refs/pull/<n>/head; `local: true` also makes it a local branch in the clone. Pass `env` to
  // launch() so the app finds the fake `gh` first on PATH. → { repo, bare, env, calls(), pr(n) }.
  github({ owner = 'acme', name = 'widgets', viewer = 'e2e-reviewer', requireReview = true, prs = [] } = {}) {
    const url = `git@github.com:${owner}/${name}.git`;
    const bin = this.path('bin');
    fs.mkdirSync(bin);
    // git's "simple" ssh variant runs `<cmd> git@github.com "git-upload-pack '<owner>/<name>.git'"`.
    const ssh = path.join(bin, 'fake-ssh');
    fs.writeFileSync(ssh, `#!/bin/sh\nfor c; do :; done\ncd "${this.path('github.com')}" && exec sh -c "git \${c#git-}"\n`, { mode: 0o755 });
    this.git(this.dir, 'config', '--global', 'core.sshCommand', ssh);
    this.git(this.dir, 'config', '--global', 'ssh.variant', 'simple');
    const seed = this.linear('github-seed', ['first', 'second']);
    for (const p of prs) {
      this.git(seed, 'checkout', '-q', '-b', p.branch, 'main');
      this.commit(seed, p.title, p.files);
      this.git(seed, 'checkout', '-q', 'main');
    }
    const bare = this.path('github.com', owner, `${name}.git`);
    this.git(this.dir, 'clone', '-q', '--bare', seed, bare);
    fs.rmSync(seed, { recursive: true, force: true });
    for (const p of prs) this.git(bare, 'update-ref', `refs/pull/${p.number}/head`, `refs/heads/${p.branch}`);
    const repo = this.clone(url, name);
    for (const p of prs.filter((x) => x.local)) this.git(repo, 'branch', '-q', '--track', p.branch, `origin/${p.branch}`);

    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-gh.js')}" "$@"\n`, { mode: 0o755 });
    const file = this.path('gh-state.json');
    const log = this.path('gh-calls.log');
    fs.writeFileSync(log, '');
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(file, JSON.stringify({
      host: 'github.com', owner, name, viewer, requireReview, bare, log,
      prs: prs.map((p) => ({ number: p.number, title: p.title, body: p.body || '', headRefName: p.branch, baseRefName: 'main', author: p.author || 'agent-bot', state: 'OPEN', reviews: [], updatedAt: at })),
    }, null, 2));
    return {
      repo, bare,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SINCE_FAKE_GH: file },
      calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
      pr: (n) => JSON.parse(fs.readFileSync(file, 'utf8')).prs.find((p) => p.number === n),
    };
  }

  log(repo, ref = 'HEAD') { return this.git(repo, 'log', '--format=%s', ref).split('\n').filter(Boolean); }
  sha(repo, ref = 'HEAD') { return this.git(repo, 'rev-parse', ref); }
}

// Wrap a launched app with helpers for driving the UI.
class AppDriver {
  constructor(app, page, sandbox) {
    this.app = app;
    this.page = page;
    this.sb = sandbox;
  }

  row(subject) { return this.page.locator('.map-list .row').filter({ has: this.page.locator('.subject', { hasText: new RegExp(`^${escape(subject)}$`) }) }); }

  async selectRow(subject) {
    const row = this.row(subject);
    await row.click();
    await expect(row).toHaveClass(/selected/);
    await expect(this.page.locator('.map-list')).toBeFocused();
    return row;
  }

  // `item`: a label, or a path through submenus (['Rewrite', 'Split…']).
  async contextMenu(locator, item) {
    await locator.click({ button: 'right' });
    for (const label of [].concat(item)) await this.page.locator('.menu .menu-item', { hasText: label }).last().click();
  }

  async view(name) {
    // Pages sit in the nav (AK-491); the fold-out lists open their page on a double-click of the header; the reflog
    // tab of History opens with its chord (G R).
    const list = { worktrees: 'worktrees', remoteList: 'remotes', tagList: 'tags' }[name];
    if (name === 'reflog') await this.page.keyboard.press('g').then(() => this.page.keyboard.press('r'));
    else if (list) await this.page.locator(`[data-section="${list}"] .sb-section-head`).dblclick();
    else await this.page.locator(`.sb-nav [data-view="${{ snapshots: 'history', submoduleList: 'submodules' }[name] || name}"]`).click();
    await expect(this.page.locator('.content')).toHaveAttribute('data-view', name);
  }

  async palette(command) {
    await this.page.locator('.sb-top button[title^="Command menu"]').click();
    const input = this.page.locator('.palette-input');
    await input.fill(command);
    await expect(this.page.locator('.palette-item.active .palette-label')).toHaveText(command);
    await input.press('Enter');
    await expect(this.page.locator('.palette-overlay')).toHaveCount(0);
  }

  // Wait for act()'s success toast; act() refreshes state before showing it.
  async toast(text, kind = 'success') {
    const t = this.page.locator(`.toast.${kind}`, { hasText: text }).last();
    await expect(t).toBeVisible();
    await this.settle();
    return t;
  }

  // The file watcher refreshes the UI shortly after each git change. Wait until
  // the DOM has been quiet for a moment so the next step doesn't race a re-render.
  settle(quiet = 400) {
    return this.page.evaluate((ms) => new Promise((resolve) => {
      const done = () => { mo.disconnect(); clearTimeout(t); clearTimeout(max); resolve(); };
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ms); });
      let t = setTimeout(done, ms);
      const max = setTimeout(done, 5000);
      mo.observe(document.getElementById('app'), { subtree: true, childList: true, attributes: true, characterData: true });
    }), quiet);
  }

  // Row action buttons only show on hover, and a refresh can replace the row.
  async hoverClick(row, button) {
    await expect(async () => {
      await row.hover();
      await row.locator(button).click({ timeout: 1000 });
    }).toPass();
  }

  // `under`: overlays left open beneath the dialog (a dialog opened from Preferences).
  async dialog({ fields = {}, submit, under = 0 } = {}) {
    const d = this.page.locator('.overlay .dialog');
    await expect(d).toBeVisible();
    for (const [label, value] of Object.entries(fields)) {
      const field = d.locator('label', { hasText: label });
      const input = field.locator('input, textarea').first();
      if (typeof value === 'boolean') await input.setChecked(value);
      else await input.fill(value);
    }
    await d.locator('.dialog-foot button[type=submit]', submit ? { hasText: submit } : {}).click();
    await expect(this.page.locator('.overlay')).toHaveCount(under);
  }

  undoButton() { return this.page.locator('.topbar button[title^="Undo"]'); }
  redoButton() { return this.page.locator('.topbar button[title^="Redo"]'); }

  async undo(label) {
    await this.undoButton().click();
    await expect(this.page.locator('.toast', { hasText: label ? `Undid “${label}”` : 'Undid' }).last()).toBeVisible();
    await this.settle();
  }

  async redo(label) {
    await this.redoButton().click();
    await expect(this.page.locator('.toast', { hasText: label ? `Redid “${label}”` : 'Redid' }).last()).toBeVisible();
    await this.settle();
  }

  // Replace a native dialog in the main process for the rest of the test.
  async stubDialog(method, result) {
    await this.app.evaluate(({ dialog }, [m, r]) => { dialog[m] = async () => r; }, [method, result]);
  }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every window opens at this size, above the sidebar breakpoint, whatever the display (CI runners' screens
// are smaller and would put the sidebar in rail/overlay mode).
const WINDOW_SIZE = { width: 1360, height: 860 };
const SIDEBAR_BREAKPOINT = 1100; // renderer/sidebar.js
let loggedDisplay = false;

const test = base.extend({
  sandbox: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-e2e-'));
    const sb = new Sandbox(dir);
    await use(sb);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  // launch(repoPath?, { theme?, env?, settings? }) starts the app with its own userData, optionally opening a
  // repository. `settings` goes into settings.json (e.g. { github: { on: true } } turns pull requests on).
  launch: async ({ sandbox }, use, testInfo) => {
    const apps = [];
    await use(async (repo, { theme, env, settings } = {}) => {
      const userData = sandbox.path(`userdata-${apps.length}`);
      fs.mkdirSync(userData);
      if (theme || settings) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ...settings, ...(theme ? { theme } : {}) }));
      const app = await electron.launch({
        args: [APP_DIR, `--user-data-dir=${userData}`, ...(repo ? [repo] : [])],
        // Specs start on the Map (repositories open on Review otherwise); pass env SINCE_START_VIEW: '' for Review.
        env: { ...sandbox.env, SINCE_START_VIEW: 'map', SINCE_WINDOW_SIZE: `${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`, ...env },
        colorScheme: null, // let nativeTheme drive prefers-color-scheme, as in the real app
        cwd: sandbox.dir,
      });
      apps.push(app);
      const page = await app.firstWindow();
      page.on('pageerror', (err) => testInfo.attach('pageerror', { body: String(err.stack || err) }));
      await page.waitForLoadState('domcontentloaded');
      if (process.env.CI && !loggedDisplay) {
        loggedDisplay = true;
        console.log('display work area:', await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize));
      }
      // One clear failure here instead of many specs failing on a collapsed or overlaid sidebar.
      await expect.poll(() => page.evaluate(() => window.innerWidth), { message: 'window narrower than the sidebar breakpoint' })
        .toBeGreaterThanOrEqual(SIDEBAR_BREAKPOINT);
      const driver = new AppDriver(app, page, sandbox);
      if (repo) await expect(page.locator('.sidebar .repo-name')).toHaveText(path.basename(repo));
      await driver.settle();
      return driver;
    });
    for (const app of apps) {
      if (testInfo.status !== testInfo.expectedStatus) {
        const shot = await app.windows()[0]?.screenshot().catch(() => null);
        if (shot) await testInfo.attach('failure', { body: shot, contentType: 'image/png' });
      }
      await app.close().catch(() => {});
    }
  },
});

module.exports = { test, expect };
