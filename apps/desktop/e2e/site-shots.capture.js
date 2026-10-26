'use strict';
// Landing page app shots: regenerates the dark-theme screenshots in apps/web/src/assets/app/ from
// the real app, driven against a made-up product repository ("orbit", remote acme/orbit) with
// made-up people, issue keys and pull requests (seeded by orbit-demo.js). Nothing touches the
// network: a fake `gh` answers every GitHub question from demo JSON, and a `git` shim points fetches
// of the GitHub remote at a local bare repository. Not part of the e2e suite (its testMatch is
// *.spec.js). Run it with:
//
//   pnpm --filter @gitsince/desktop exec playwright test -c e2e/site-shots.config.js
//
// One app launch; the window is set to 1440×900 and captured at the display's scale (2x on Retina).

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');

const OUT = path.join(__dirname, '..', '..', 'web', 'src', 'assets', 'app');
const NOW = Date.now();
const { seedOrbit } = require('./orbit-demo');

// ---------------------------------------------------------------------------------------------

test('landing page app shots (dark, and light where the site swaps)', async ({ sandbox, launch }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });

  const { repo, bin, checkpoint, checkpointAt, g, write, sub } = seedOrbit(sandbox, { now: NOW });

  // --- Launch (Review is the start view), 1440×900, dark.
  const app = await launch(repo, { theme: 'dark', env: { SINCE_START_VIEW: '', PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const { page } = app;
  await app.app.evaluate(({ BaseWindow }) => { const w = BaseWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
  // The catch-up checkpoint: caught up three and a half days ago, then reload so Review picks it up.
  await page.evaluate((cp) => window.since.app('catchup-mark', cp), { sha: checkpoint, base: 'origin/main', date: checkpointAt, source: 'mark' });
  // Refresh pull requests first: the sidebar keeps them in its cache, and refreshing after the reload
  // would race Review's catch-up load (which then shows commits instead of merged PRs).
  await app.palette('Refresh pull requests');
  await expect(page.locator('.toast', { hasText: '7 open pull requests' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.sidebar .repo-name')).toHaveText('orbit');
  // Toasts never show in a shot (inline styles are blocked by the CSP; CSSOM isn't).
  const quiet = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

  const LEAKS = ['E2E', 'tmp', '/var/', '/Users', '/private', 'since-e2e', 'Tester', 'orbit-remote'];
  const shot = async (name) => {
    await app.settle(500);
    await page.waitForTimeout(300);
    await quiet();
    const text = await page.evaluate(() => document.body.innerText);
    for (const bad of LEAKS) expect(text, `${name}: “${bad}” is on screen`).not.toContain(bad);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const main = await page.evaluate(() => (document.querySelector('.overlay') || document.querySelector('.content')).innerText);
    console.log(`\n== ${name}\n${main.replace(/\n{2,}/g, '\n').slice(0, 2500)}`);
  };
  // The site shows the hero and the Git client tabs in the visitor's theme: shoot those dark, then light.
  const twin = async (name) => {
    await shot(`${name}-dark`);
    await app.palette('Theme: Light');
    await shot(`${name}-light`);
    await app.palette('Theme: Dark');
  };
  const split = page.locator('.review-split');

  // 1. Review: Stuck and Ready to merge.
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await page.locator('.review-reload').click(); // stage counts need a PR load (#143)
  await expect(page.locator('.review-tab[data-tab="stuck"] .review-tab-n')).toHaveText('2', { timeout: 40_000 });
  await expect(page.locator('.review-tab[data-tab="ready"] .review-tab-n')).toHaveText('3');
  // Evidence shots (AK-520), only with EVIDENCE_SHOTS=<dir>: the stuck PR with failing checks in the
  // pane (facts line, evidence strip open on Checks, chips on the rows), dark then light, and stop.
  if (process.env.EVIDENCE_SHOTS) {
    const dir = process.env.EVIDENCE_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    await page.locator('.lanes-row[data-key="pr:230"]').click({ position: { x: 8, y: 8 } });
    const pane = page.locator('.review-pane');
    await expect(pane.locator('.evidence .ev-tab[aria-selected="true"]')).toContainText('Checks', { timeout: 30_000 });
    await expect(pane.locator('.reader-facts')).toBeVisible({ timeout: 30_000 });
    await pane.locator('.ev-fold').first().click();
    await expect(pane.locator('.ev-log')).toBeVisible();
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await app.palette('Theme: Light');
      await app.settle(500);
      await page.waitForTimeout(400);
      await quiet();
      await page.screenshot({ path: path.join(dir, `evidence-${theme}.png`) });
      await pane.locator('.ev-tab[data-tab="annotations"]').click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(dir, `evidence-annotations-${theme}.png`) });
      // AK-530: an annotation opened in place, and the open threads.
      await pane.locator('.ev-ann .ev-item').first().click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(dir, `evidence-annotation-open-${theme}.png`) });
      await pane.locator('.ev-ann .ev-item').first().click();
      await pane.locator('.ev-tab[data-tab="threads"]').click();
      await page.waitForTimeout(200);
      await pane.locator('.ev-thread .ev-item').first().focus();
      await page.screenshot({ path: path.join(dir, `evidence-threads-${theme}.png`) });
      await pane.locator('.ev-tab[data-tab="checks"]').click();
    }
    console.log('\n== rows\n' + (await page.locator('.lanes-list').innerText()).slice(0, 1500));
    console.log('\n== pane head\n' + (await pane.locator('.review-pane-head').innerText()).slice(0, 1500));
    return;
  }

  // Media gallery and failing-check merge confirm shots (AK-521), only with MEDIA_SHOTS=<dir>. Image
  // fetches in the main process are stubbed with two drawn PNGs (no network); the video 404s.
  if (process.env.MEDIA_SHOTS) {
    const dir = process.env.MEDIA_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    const pngs = { 'invoice-preview': demoPng(640, 420, [232, 89, 12], [250, 240, 230]), 'line-items': demoPng(640, 420, [60, 52, 46], [244, 242, 240]) };
    await app.app.evaluate((_e, imgs) => {
      globalThis.fetch = async (url) => {
        const k = Object.keys(imgs).find((x) => String(url).includes(x));
        if (!k) return new Response(null, { status: 404 });
        const b = Buffer.from(imgs[k], 'base64');
        return new Response(b, { headers: { 'content-type': 'image/png', 'content-length': String(b.length) } });
      };
    }, pngs);
    await page.locator('.lanes-row[data-key="pr:230"]').click({ position: { x: 8, y: 8 } });
    const pane = page.locator('.review-pane');
    await expect(pane.locator('.ev-tab[data-tab="media"]')).toBeVisible({ timeout: 30_000 });
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await app.palette('Theme: Light');
      await pane.locator('.reader-scroll, .review-pane').first().click({ position: { x: 4, y: 4 } }).catch(() => {});
      if (!(await pane.locator('.ev-tab[data-tab="media"].on').count())) await pane.locator('.ev-tab[data-tab="media"]').click();
      await expect(pane.locator('.ev-thumb img')).toHaveCount(2, { timeout: 20_000 });
      await app.settle(400);
      await quiet();
      await page.screenshot({ path: path.join(dir, `gallery-${theme}.png`) });
      await pane.locator('.ev-thumb').first().focus();
      await page.keyboard.press('Space');
      await expect(page.locator('.media-view .media-stage img')).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.media-view .media-pos')).toHaveText('2 of 3');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, `gallery-enlarged-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.locator('.media-view')).toHaveCount(0);
      // For the merge sheet only: failing checks GitHub doesn't require (no branch protection, no
      // review needed), so it shows the plain confirm. The fake `gh` rereads its data on every call.
      const ghData = JSON.parse(fs.readFileSync(path.join(bin, 'gh-data.json'), 'utf8'));
      Object.assign(ghData.open.find((x) => x.number === 230), { mergeStateStatus: 'UNSTABLE', reviewDecision: '' });
      fs.writeFileSync(path.join(bin, 'gh-data.json'), JSON.stringify(ghData));
      // By hand, not app.palette(): Merge pull request… opens a second palette to pick the PR.
      await page.locator('.sb-top button[title^="Command menu"]').click();
      await page.locator('.palette-input').fill('Merge pull request…');
      await expect(page.locator('.palette-item.active .palette-label')).toHaveText('Merge pull request…');
      await page.locator('.palette-input').press('Enter');
      const pick = page.locator('.palette-input[placeholder="Merge pull request…"]');
      await expect(pick).toBeVisible();
      await expect(page.locator('.palette-overlay')).toHaveCount(1);
      await pick.fill('#230');
      await pick.press('Enter');
      await expect(page.locator('.pr-check-fail')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await quiet();
      await page.screenshot({ path: path.join(dir, `merge-confirm-${theme}.png`) });
      console.log(`\n== merge confirm (${theme})\n` + (await page.locator('.dialog').innerText()).slice(0, 800));
      await page.keyboard.press('Escape');
      await expect(page.locator('.pr-check-fail')).toHaveCount(0);
    }
    return;
  }

  await expect(page.locator('.review-pane .review-file').first()).toBeVisible();
  await twin('review');

  // 2. Catch up (AK-365): Reload joins the merged PRs on; the reader beside the list shows the first PR's diff.
  await app.view('catchup');
  const catchup = page.locator('.page.catchup');
  await catchup.press('Meta+R');
  await expect(catchup.locator('.catchup-sentence')).toContainText('14 PRs merged', { timeout: 40_000 });
  await expect(catchup.locator('.reader-title-row')).toContainText('#225');
  await expect(catchup.locator('.review-file').first()).toContainText('jitter');
  await shot('catchup-dark');
  await app.view('lanes');

  // 3. A ready PR in the pane, two files ticked as reviewed.
  const row231 = page.locator('.lanes-row[data-key="pr:231"]');
  await row231.click({ position: { x: 8, y: 8 } });
  const pane = page.locator('.review-pane');
  // Files are cards in the reader: ticking one folds it, so the chart's code moves up.
  await expect(pane.locator('.review-file')).toHaveCount(5);
  await pane.locator('.review-file[data-path$="/usage.ts"] .review-tick').click();
  await pane.locator('.review-file[data-path$="/usage.test.ts"] .review-tick').click();
  await expect(pane.locator('.review-file.reviewed')).toHaveCount(2);
  await expect(pane.locator('.review-file[data-path$="/UsageChart.tsx"]')).toContainText('ResponsiveContainer');
  await shot('review-pr-dark');

  // 4. Merge plan for the ready PRs. For this shot only, GitHub says #233 is behind a base that must
  // be up to date, so the sheet names a blocker (the fake `gh` rereads its data on every call).
  const planData = JSON.parse(fs.readFileSync(path.join(bin, 'gh-data.json'), 'utf8'));
  planData.open.find((x) => x.number === 233).mergeStateStatus = 'BEHIND';
  fs.writeFileSync(path.join(bin, 'gh-data.json'), JSON.stringify(planData));
  await split.focus();
  await page.keyboard.press('Shift+P');
  const plan = page.locator('.mergeplan-sheet');
  await expect(plan.locator('.mergeplan-row')).toHaveCount(3, { timeout: 20_000 });
  await expect(plan).toContainText('It’s behind its base');
  await shot('merge-plan-dark');
  await page.keyboard.press('Escape');
  await expect(plan).toHaveCount(0);

  // 5. Clean up.
  await page.keyboard.press('Meta+Alt+Backspace');
  const cleanup = page.locator('.cleanup-panel');
  await expect(cleanup.locator('.cleanup-item').first()).toBeVisible({ timeout: 20_000 });
  await shot('cleanup-dark');
  await page.keyboard.press('Escape');

  // 6. Map.
  await app.view('map');
  await expect(app.row('Merge branch \'release/2.3\'')).toHaveCount(1);
  await expect(app.row('fix(billing): add jitter to the retry backoff (ORB-142) (#225)')).toHaveCount(1);
  await app.row('fix(billing): add jitter to the retry backoff (ORB-142) (#225)').click();
  expect((await app.row('fix(billing): add jitter to the retry backoff (ORB-142) (#225)').boundingBox()).y).toBeLessThan(300);
  await twin('map');

  // 7. Commit: staged and unstaged changes, a diff open.
  write({
    'packages/billing/src/receipts.ts': sub("template: retried ? 'receipt-after-retry' : 'receipt',", "template: retried ? 'receipt-after-retry' : 'receipt',\n    replyTo: 'billing@acme.dev',"),
    'apps/web/src/pages/Billing.tsx': sub('<PageHeader title="Billing" description="Your plan, this month’s usage and past invoices" />', '<PageHeader\n        title="Billing"\n        description="Your plan, this month’s usage and past invoices"\n        actions={<Button variant="ghost" onClick={() => api.portal(workspaceId)}>Manage payment method</Button>}\n      />'),
    'packages/billing/src/proration.ts': "import type { Invoice } from './types';\n\n// Credit for the unused part of the period when a workspace changes plan mid-cycle.\nexport function prorate(amountCents: number, periodStart: Date, periodEnd: Date, changedAt: Date): number {\n  const total = periodEnd.getTime() - periodStart.getTime();\n  const unused = periodEnd.getTime() - changedAt.getTime();\n  return Math.round((amountCents * unused) / total);\n}\n\nexport const isProrated = (inv: Invoice) => inv.number.endsWith('-P');\n",
  });
  g(['add', 'packages/billing/src/proration.ts', 'packages/billing/src/receipts.ts']);
  await app.view('commit');
  await expect(page.locator('.cv-section .file-row')).toHaveCount(3);
  await page.locator('textarea.composer-input[placeholder="Commit message"]').fill('feat(billing): prorate plan changes mid-cycle (ORB-181)\n\nCredit the unused part of the period and reply-to billing on receipts.');
  await page.locator('.cv-section .file-row', { hasText: 'Billing.tsx' }).click();
  await expect(page.locator('.diff-scroll')).toContainText('Manage payment method');
  await twin('commit');

  // 8. The conflict editor: merging the hard-declines branch into main stops on retry.ts.
  await page.locator('textarea.composer-input[placeholder="Commit message"]').fill('');
  g(['reset', '-q', '--hard']);
  g(['clean', '-qfd']);
  g(['merge', 'agent/orb-176-hard-declines'], { ok: [1] });
  await expect(page.locator('.banner')).toContainText('is stopped on 1 conflict', { timeout: 15_000 });
  await app.view('commit');
  await page.locator('.cv-section', { hasText: 'Conflicts' }).locator('.file-row', { hasText: 'retry.ts' }).click();
  await expect(page.locator('.cf-block').first()).toBeVisible();
  await twin('conflict');
});

// A w×h PNG (base64): a soft two-colour diagonal with a few bars, standing in for a PR screenshot.
function demoPng(w, hgt, fg, bg) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const bar = y > 60 && (y - 60) % 56 < 22 && x > 40 && x < 40 + ((y * 7) % 380) + 120;
      const t = bar ? 0.85 : 0.08 + 0.12 * (x + y) / (w + hgt);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bg[c] * (1 - t) + fg[c] * t);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
