'use strict';
// A long undo history: the Snapshots view loads the newest steps first, shows
// older ones on request (read back from archived pages), and restores from them.

const { test, expect } = require('./fixtures');
const git = require('../git');
const { Journal } = require('../journal');

const STEPS = 251; // odd, so scratch ends away from where the oldest step started

// Write STEPS journal entries that move `scratch` back and forth, the way the
// journal records them, without driving each one through the UI.
async function seed(sandbox, repo) {
  const one = sandbox.sha(repo, 'HEAD~2'), two = sandbox.sha(repo, 'HEAD~1');
  const main = sandbox.sha(repo);
  sandbox.git(repo, 'branch', 'scratch', one);
  const journal = new Journal(await git.openRepo(repo));
  const state = (oid) => ({ refs: { 'refs/heads/main': main, 'refs/heads/scratch': oid }, head: 'refs/heads/main', headOid: main });
  const at = (i) => (i % 2 ? two : one);
  for (let i = 1; i <= STEPS; i++) {
    journal.undo.hot.push({ id: i, label: `Move scratch #${i}`, method: 'resetBranch', time: Date.now() - (STEPS - i) * 60_000, before: state(at(i - 1)), after: state(at(i)) });
    await journal.archive(journal.undo);
  }
  for (const e of journal.undo.hot) await journal.pin(e.id, { objects: [one, two] });
  journal.persist();
  sandbox.git(repo, 'branch', '-f', 'scratch', at(STEPS));
  return { one };
}

for (const theme of ['light', 'dark']) {
  test(`Snapshots pages through a long history (${theme})`, async ({ sandbox, launch }, testInfo) => {
    const repo = sandbox.linear('long-history', ['one', 'two', 'three']);
    const { one } = await seed(sandbox, repo);
    const app = await launch(repo, { theme });
    await app.view('snapshots');
    const rows = app.page.locator('.timeline .tl-row');
    await expect(rows).toHaveCount(100);
    await expect(rows.first()).toContainText(`Move scratch #${STEPS}`);
    const more = app.page.locator('.tl-more button');
    await expect(more).toHaveText(`Show ${STEPS - 100} more`);
    await more.scrollIntoViewIfNeeded();
    const file = testInfo.outputPath(`${theme}-snapshots-more.png`);
    await app.page.screenshot({ path: file });
    await testInfo.attach(`${theme}-snapshots-more`, { path: file, contentType: 'image/png' });

    await more.click();
    await expect(rows).toHaveCount(STEPS);
    await expect(more).toHaveCount(0);
    await expect(rows.last()).toContainText('Move scratch #1');

    // The oldest entry lives in an archived page; restoring from it still works.
    await app.hoverClick(rows.last(), 'button:has-text("Restore before")');
    await app.dialog({ submit: 'Restore' });
    await app.toast('Restore before “Move scratch #1”');
    expect(sandbox.sha(repo, 'scratch')).toBe(one);
    await app.undo('Restore “Move scratch #1”');
    expect(sandbox.sha(repo, 'scratch')).not.toBe(one);
  });
}
