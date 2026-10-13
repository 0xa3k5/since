'use strict';
// In-app benchmark probe. Loaded by main.js only when GITLANES_BENCH is set (see bench/bench.js).
// It watches the Map from inside the page, so it measures what a user sees: the first painted
// rows, the full graph, scroll frame times and memory. Results go to GITLANES_BENCH as JSON.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Runs inside the renderer. Only relies on the DOM, so it works against older builds too.
async function probe(opts) {
  const now = () => performance.now();
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(now())));
  const until = async (fn, timeout) => {
    const end = now() + timeout;
    while (!fn()) { if (now() > end) throw new Error('timeout'); await frame(); }
    return now();
  };
  const ds = document.documentElement.dataset;
  const out = {};
  out.firstPaint = await until(() => document.querySelector('.map-list .row'), opts.timeout);
  // Builds that stream the log mark progress on <html>; older builds load everything up front.
  out.fullGraph = await until(() => ds.history !== 'loading', opts.timeout);
  out.allDetails = await until(() => ds.details !== 'loading', opts.timeout);
  const list = document.querySelector('.map-list');
  out.commits = ds.commits ? +ds.commits : Math.round(document.querySelector('.vl-spacer').offsetHeight / 32);

  const measure = async (ms, step) => {
    const times = [];
    let last = await frame();
    const end = last + ms;
    let i = 0;
    while (last < end) {
      step(i++);
      const t = await frame();
      times.push(t - last);
      last = t;
    }
    times.sort((a, b) => a - b);
    const total = times.reduce((a, b) => a + b, 0);
    return {
      fps: +(times.length / (total / 1000)).toFixed(1),
      p95: +times[Math.floor(times.length * 0.95)].toFixed(1),
      worst: +times[times.length - 1].toFixed(1),
      longFrames: times.filter((t) => t > 33.4).length,
      frames: times.length,
    };
  };
  list.focus();
  await frame();
  // A fast, steady trackpad fling: two rows per frame.
  out.scroll = await measure(opts.scrollMs, () => { list.scrollTop += 64; });
  // Dragging the scrollbar across the whole history: a new random position every frame.
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  out.jump = await measure(opts.scrollMs, () => { list.scrollTop = rand() * (list.scrollHeight - list.clientHeight); });
  return out;
}

module.exports = function bench(app) {
  const outFile = process.env.GITLANES_BENCH;
  const t0 = performance.timeOrigin; // process start, epoch ms
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-bench-profile-')));
  const opts = { timeout: +(process.env.GITLANES_BENCH_TIMEOUT || 600000), scrollMs: +(process.env.GITLANES_BENCH_SCROLL_MS || 3000) };

  const memory = () => {
    const procs = app.getAppMetrics();
    const mb = (kb) => Math.round(kb / 1024);
    const renderer = procs.filter((p) => p.type === 'Tab').reduce((a, p) => a + p.memory.workingSetSize, 0);
    return { totalMB: mb(procs.reduce((a, p) => a + p.memory.workingSetSize, 0)), rendererMB: mb(renderer), mainMB: Math.round(process.memoryUsage().rss / 1048576) };
  };

  return {
    attach(win) {
      win.setBounds({ width: 1440, height: 900 });
      win.webContents.once('did-finish-load', async () => {
        let result;
        try {
          const navStart = await win.webContents.executeJavaScript('performance.timeOrigin');
          const r = await win.webContents.executeJavaScript(`(${probe})(${JSON.stringify(opts)})`);
          const fromLaunch = (t) => Math.round(navStart + t - t0);
          result = {
            commits: r.commits,
            firstPaintMs: fromLaunch(r.firstPaint),
            firstPaintFromLoadMs: Math.round(r.firstPaint),
            fullGraphMs: fromLaunch(r.fullGraph),
            allDetailsMs: fromLaunch(r.allDetails),
            scroll: r.scroll,
            jump: r.jump,
          };
          await new Promise((res) => setTimeout(res, 1000));
          result.memory = memory();
        } catch (e) {
          result = { error: e.message };
        }
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
        app.exit(0);
      });
    },
  };
};
