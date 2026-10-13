'use strict';
// Incremental graph layout, streamed history and scroll scaling (AK-43).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { generate } = require('../bench/synth');

// The one-shot layout the incremental engine replaced, kept verbatim as the reference.
function referenceLayout(commits) {
  const lanes = [];
  const laneColor = [];
  const rows = new Array(commits.length);
  let colorSeq = 0;
  let maxLanes = 1;

  const freeSlot = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let col = lanes.indexOf(c.sha);
    let color;
    const top = [];
    const pass = [];
    if (col === -1) {
      col = freeSlot();
      color = colorSeq++;
    } else {
      color = laneColor[col];
    }
    for (let j = 0; j < lanes.length; j++) {
      const s = lanes[j];
      if (s === null || s === undefined) continue;
      if (s === c.sha) { top.push(j, laneColor[j]); lanes[j] = null; }
      else pass.push(j, laneColor[j]);
    }
    const bottom = [];
    for (let p = 0; p < c.parents.length; p++) {
      const ps = c.parents[p];
      let k = lanes.indexOf(ps);
      const colFree = lanes[col] === null || lanes[col] === undefined;
      if (p === 0 && k > col && colFree) {
        // Keep the first-parent line straight; the other lane converges into it at the parent row.
        k = col;
        lanes[k] = ps;
        laneColor[k] = color;
      } else if (k === -1) {
        if (p === 0 && (lanes[col] === null || lanes[col] === undefined)) {
          k = col;
          laneColor[k] = color;
        } else {
          k = freeSlot();
          laneColor[k] = colorSeq++;
        }
        lanes[k] = ps;
      }
      bottom.push(k, laneColor[k]);
    }
    while (lanes.length && (lanes[lanes.length - 1] === null || lanes[lanes.length - 1] === undefined)) lanes.pop();
    if (lanes.length > maxLanes) maxLanes = lanes.length;
    if (col + 1 > maxLanes) maxLanes = col + 1;
    rows[i] = { col, color, top, pass, bottom, merge: c.parents.length > 1 };
  }
  return { rows, maxLanes };
}

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

// A random history in date order (children before parents): branches fork, merge (sometimes
// octopus), and sometimes start new roots.
function randomHistory(n, seed) {
  const rand = rng(seed);
  const open = []; // commits still waiting for a parent: [{ sha, parents }]
  const out = [];
  let id = n;
  const sha = () => `c${id--}`;
  // Build newest-first: each new commit is a parent of some open commits.
  for (let i = 0; i < n; i++) {
    const c = { sha: sha(), parents: [] };
    out.push(c);
    open.push(c);
  }
  // Wire parents: each commit's parents are later (older) commits.
  for (let i = 0; i < n; i++) {
    const c = out[i];
    if (i === n - 1 || rand() < 0.01) continue; // a root
    const k = 1 + (rand() < 0.15 ? 1 : 0) + (rand() < 0.02 ? 1 : 0);
    const used = new Set();
    for (let p = 0; p < k; p++) {
      const span = p === 0 ? 1 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 40);
      const j = Math.min(n - 1, i + span);
      if (j > i && !used.has(j)) { used.add(j); c.parents.push(out[j].sha); }
    }
  }
  return out.map((c) => ({ sha: c.sha, parents: c.parents }));
}

const rowsOf = (g, n) => Array.from({ length: n }, (_, i) => g.row(i));

test('incremental layout matches the one-shot layout', async () => {
  const { createGraph, layout } = await import('../renderer/graph.js');
  for (const seed of [1, 2, 3, 4, 5]) {
    const commits = randomHistory(1500, seed);
    const ref = referenceLayout(commits);
    const g = layout(commits);
    assert.equal(g.length, commits.length);
    assert.equal(g.maxLanes, ref.maxLanes);
    assert.deepEqual(rowsOf(g, commits.length), ref.rows);
    // Streamed in uneven chunks, as the log arrives.
    const rand = rng(seed + 100);
    const list = [];
    const inc = createGraph(list);
    for (let i = 0; i < commits.length;) {
      const k = 1 + Math.floor(rand() * 300);
      list.push(...commits.slice(i, i + k));
      inc.sync();
      i += k;
      if (rand() < 0.3) inc.row(Math.floor(rand() * list.length)); // reads between chunks
    }
    assert.deepEqual(rowsOf(inc, commits.length), ref.rows);
    for (let i = 0; i < commits.length; i++) assert.equal(inc.color(i), ref.rows[i].color);
  }
});

test('graph truncate and fork reuse the shared prefix', async () => {
  const { layout } = await import('../renderer/graph.js');
  const a = randomHistory(900, 7);
  const g = layout(a);
  const before = rowsOf(g, a.length);
  for (const m of [0, 1, 63, 64, 65, 500, 899]) {
    // A different history sharing a's first m commits.
    const b = a.slice(0, m).concat(randomHistory(400, m + 11).map((c) => ({ sha: 'x' + c.sha, parents: c.parents.map((p) => 'x' + p) })));
    const list = b.slice(0, m);
    const f = g.fork(list, m);
    list.push(...b.slice(m));
    f.sync();
    assert.deepEqual(rowsOf(f, b.length), referenceLayout(b).rows, `fork at ${m}`);
    assert.equal(f.maxLanes, referenceLayout(b).maxLanes);
  }
  assert.deepEqual(rowsOf(g, a.length), before, 'forks leave the original alone');
  g.truncate(300);
  a.length = 300;
  assert.equal(g.length, 300);
  assert.deepEqual(rowsOf(g, 300), referenceLayout(a).rows);
});

test('parseLog and details', async () => {
  const { parseLog, createHistory } = await import('../renderer/log.js');
  const topo = 'a\0b c\x1e\nb\0d\x1e\nc\0d\x1e\nd\0\x1e\n';
  const commits = parseLog(topo, 'topo');
  assert.deepEqual(commits.map((c) => [c.sha, c.parents]), [['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', []]]);
  assert.equal(commits[0].subject, null);
  const full = parseLog('a\0b\0Ann\0ann@x\x00100\0Fix: it\x1e\n', 'full');
  assert.deepEqual(full[0], { sha: 'a', parents: ['b'], author: 'Ann', email: 'ann@x', time: 100, subject: 'Fix: it' });

  const h = createHistory();
  // Details may arrive before the commit itself.
  assert.equal(h.fill('d\0Dee\0dee@x\x00400\0root\x1e\n'), 0);
  h.add(commits);
  assert.equal(h.commits[3].subject, 'root');
  assert.equal(h.fill('b\0Bo\0bo@x\x00200\0Two\x1e\nzz\0Z\0z@x\x001\0gone\x1e\n'), 1);
  assert.equal(h.commits[h.index.get('b')].author, 'Bo');
  assert.deepEqual(h.missingDetails(), ['a', 'c']);
  assert.equal(h.graph.length, 4);
});

test('merge keeps an unchanged history and rebuilds from the first difference', async () => {
  const { createHistory, createMerge } = await import('../renderer/log.js');
  const base = randomHistory(2000, 9);
  const cur = createHistory().add(base.map((c) => ({ ...c, subject: 's' })));
  cur.complete = true;
  const feed = (list, chunk = 333) => {
    const m = createMerge(cur);
    for (let i = 0; i < list.length; i += chunk) m.push(list.slice(i, i + chunk).map((c) => ({ ...c, subject: null })));
    return m.finish();
  };
  assert.equal(feed(base), null, 'same log: nothing to do');

  // A new commit on top.
  const top = [{ sha: 'new', parents: [base[0].sha] }, ...base];
  const next = feed(top);
  assert.equal(next.length, top.length);
  assert.deepEqual(next.missingDetails(), ['new']);
  assert.deepEqual(rowsOf(next.graph, top.length), referenceLayout(top).rows);
  assert.equal(cur.length, base.length, 'current history untouched');

  // History that diverges halfway, and one that got shorter.
  const half = base.slice(0, 1000).concat({ sha: 'other', parents: [] });
  const n2 = feed(half);
  assert.equal(n2.length, 1001);
  assert.equal(n2.commits[999], cur.commits[999], 'shared prefix reuses commit objects');
  assert.deepEqual(rowsOf(n2.graph, half.length), referenceLayout(half).rows);
  const short = feed(base.slice(0, 1500));
  assert.equal(short.length, 1500);
  assert.equal(short.complete, true);
});

test('scrollMap scales lists taller than the browser allows', async () => {
  const { scrollMap, MAX_SCROLL } = await import('../renderer/ui.js');
  const small = scrollMap(1000, 32, 800);
  assert.equal(small.scale, 1);
  assert.equal(small.spacer, 32000);
  const big = scrollMap(1500000, 32, 800);
  assert.equal(big.spacer, MAX_SCROLL);
  // The bottom of the scrollbar shows the last row.
  assert.equal(Math.round(big.toVirtual(MAX_SCROLL - 800)), 1500000 * 32 - 800);
  assert.equal(Math.round(big.toScroll(big.toVirtual(12345))), 12345);
});

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

async function readAll(stream) {
  const parts = [];
  for (let t; (t = await stream.read()) !== null;) parts.push(t);
  return parts;
}

test('streamLog streams the same history as getLog', async () => {
  const { parseLog, createHistory } = await import('../renderer/log.js');
  const dir = await repo();
  assert.deepEqual(await readAll(git.streamLog(dir, { kind: 'topo' })), [], 'no commits yet');
  fs.rmSync(dir, { recursive: true });
  await generate(dir, 3000); // branches, merges and tags

  const expected = await git.getLog(dir);
  assert.equal(expected.length, 3000);
  // A tiny buffer forces many reads and pauses.
  const parts = await readAll(git.streamLog(dir, { kind: 'topo', highWater: 4096 }));
  assert.ok(parts.length > 1);
  const h = createHistory();
  for (const p of parts) h.add(parseLog(p, 'topo'));
  assert.deepEqual(h.commits.map((c) => [c.sha, c.parents]), expected.map((c) => [c.sha, c.parents]));
  for (const p of await readAll(git.streamLog(dir, { kind: 'details' }))) h.fill(p);
  assert.deepEqual(h.commits.map((c) => c.subject), expected.map((c) => c.subject));
  assert.deepEqual(h.missingDetails(), []);

  const preview = parseLog((await readAll(git.streamLog(dir, { kind: 'full', preview: true, limit: 10 }))).join(''), 'full');
  assert.equal(preview.length, 10);
  for (const c of preview) assert.equal(c.subject, expected[h.index.get(c.sha)].subject);

  const picked = [expected[5].sha, expected[0].sha];
  const d = createHistory().add(parseLog(picked.map((s) => `${s}\0\x1e`).join(''), 'topo'));
  d.fill(await git.getLogDetails(dir, picked));
  assert.deepEqual(d.commits.map((c) => c.subject), [expected[5].subject, expected[0].subject]);

  // Closing early stops git.
  const s = git.streamLog(dir, { kind: 'topo', highWater: 100 });
  await s.read();
  s.close();
  assert.equal(await s.read(), null);

  assert.equal(await git.hasCommitGraph(dir), false);
  await git.writeCommitGraph(dir);
  assert.equal(await git.hasCommitGraph(dir), true);
});
