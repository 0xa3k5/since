'use strict';
// Streamed history: opening another repository while one is still loading (AK-80) opens it in its own tab (AK-634).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { test, expect } = require('./fixtures');
const { generate } = require('../bench/synth');

// A `git` on PATH that holds back repository A's ordered logs (topology and details; the
// preview has no --date-order), so A is reliably still loading when B is opened.
function slowGitFor(sandbox, repo, seconds) {
  const real = execFileSync('which', ['git'], { env: sandbox.env, encoding: 'utf8' }).trim();
  const bin = sandbox.path('slow-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(sandbox.path('slow-bin', 'git'), [
    '#!/bin/sh',
    `if [ "$(pwd -P)" = '${repo}' ]; then case " $* " in *' --date-order '*) sleep ${seconds} ;; esac; fi`,
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  sandbox.env = { ...sandbox.env, PATH: `${bin}:${sandbox.env.PATH}` };
}

test('opening another repository mid-load opens it in its own tab', async ({ sandbox, launch }) => {
  // More commits than the preview shows, so A can't be complete before its ordered log arrives.
  const a = sandbox.path('repo-a');
  await generate(a, 1500, { tags: 0 });
  const b = sandbox.linear('repo-b', ['b one', 'b two']);
  slowGitFor(sandbox, a, 4);

  const app = await launch(a);
  const root = app.page.locator('html');
  // A's preview is on screen; its ordered history is still on its way.
  await expect(root).toHaveAttribute('data-commits', '1000');
  await expect(root).toHaveAttribute('data-history', 'loading');

  // B opens in a new tab: a page of its own, so nothing of A's held-back streams can reach it.
  const opened = app.app.waitForEvent('window');
  await app.app.evaluate(({ webContents }, dir) => webContents.getAllWebContents().find((w) => w.getURL().startsWith('file:')).send('command', 'open', dir), b);
  const page = await opened;
  const rootB = page.locator('html');
  await expect(page.locator('.sidebar .repo-name')).toHaveText('repo-b');
  await expect(rootB).toHaveAttribute('data-history', 'ready');
  await expect(rootB).toHaveAttribute('data-commits', '2');
  await expect(page.locator('.map-list .row .subject')).toHaveText(['b two', 'b one']);
  await expect(page.locator('.tabstrip .tab-title')).toHaveText(['repo-a', 'repo-b']);
  await expect(page.locator('.toast.error')).toHaveCount(0);
  // A's tab, behind it, still finishes its own history.
  await expect(root).toHaveAttribute('data-history', 'ready', { timeout: 15_000 });
  await expect(app.page.locator('.sidebar .repo-name')).toHaveText('repo-a');
});
