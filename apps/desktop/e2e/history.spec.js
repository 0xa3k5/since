'use strict';
// Streamed history: opening another repository while one is still loading (AK-80).

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

test('opening another repository mid-load shows only its history', async ({ sandbox, launch }) => {
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

  // Record every history state from here on: A's cut-short history must never count as loaded,
  // not even for the moment before B's own load replaces it.
  await app.page.evaluate(() => {
    window.__states = [];
    const html = document.documentElement;
    new MutationObserver(() => window.__states.push([html.dataset.history, html.dataset.commits]))
      .observe(html, { attributes: true, attributeFilter: ['data-history', 'data-commits'] });
  });
  await app.app.evaluate(({ BrowserWindow }, dir) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'open', dir), b);
  await expect(app.page.locator('.sidebar .repo-name')).toHaveText('repo-b');
  await expect(root).toHaveAttribute('data-history', 'ready');
  await expect(root).toHaveAttribute('data-commits', '2');

  // Outlast A's held-back streams: nothing of A may arrive late.
  await app.page.waitForTimeout(5000);
  await expect(root).toHaveAttribute('data-commits', '2');
  await expect(root).toHaveAttribute('data-history', 'ready');
  await expect(app.page.locator('.map-list .row .subject')).toHaveText(['b two', 'b one']);
  await expect(app.page.locator('.toast.error')).toHaveCount(0);
  const states = await app.page.evaluate(() => window.__states);
  expect(states.filter(([history, commits]) => history === 'ready' && commits !== '2')).toEqual([]);
});
