'use strict';
// Log streams owned by a repo session: a stream that is gone must never read as a finished log
// (AK-80, review of AK-43).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { LogStreams, CLOSED } = require('../log-streams');
const { generate } = require('../bench/synth');

async function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
}

async function readAll(logs, id) {
  let n = 0;
  for (let t; (t = await logs.read(id)) !== null;) {
    assert.notEqual(t, CLOSED);
    n += t.split('\x1e').length - 1;
  }
  return n;
}

test('log streams: end, close, dispose and stale ids', async () => {
  const dir = await tmp();
  await generate(dir, 3000);
  const ended = [];
  const logs = new LogStreams(dir, { onEnd: (l) => ended.push(l.opts.kind) });

  // Read to the end: null, once, and onEnd runs.
  const a = await logs.open({ kind: 'topo' });
  assert.equal(await readAll(logs, a.id), 3000);
  assert.deepEqual(ended, ['topo']);
  assert.equal(await logs.read(a.id), CLOSED, 'a finished stream is gone, not "done" again');

  // Closed mid-stream: the next read is CLOSED, not the end of the log.
  const b = await logs.open({ kind: 'topo', highWater: 100 });
  assert.ok(await logs.read(b.id));
  logs.close(b.id);
  assert.equal(await logs.read(b.id), CLOSED);

  // Disposed (repository replaced or closed) while a read is waiting on git.
  const c = await logs.open({ kind: 'details', batch: 1 << 30, linger: 5000 });
  await logs.read(c.id); // the first read returns at once; the second waits for more
  const pending = logs.read(c.id);
  logs.dispose();
  assert.equal(await pending, CLOSED);
  assert.equal(await logs.read(c.id), CLOSED);

  // A session opened afterwards never answers to the old session's ids.
  const next = new LogStreams(dir);
  const d = await next.open({ kind: 'topo' });
  assert.ok(d.id > c.id);
  for (const id of [a.id, b.id, c.id]) assert.equal(await next.read(id), CLOSED);
  assert.equal(await readAll(next, d.id), 3000);

  // Opening on a disposed session hands back an id that only ever reads CLOSED.
  const e = await logs.open({ kind: 'topo' });
  assert.equal(await logs.read(e.id), CLOSED);
  next.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('streamLog throws when git fails instead of ending the log', async () => {
  const s = git.streamLog(path.join(os.tmpdir(), 'gitlanes-no-such-dir-' + process.pid), { kind: 'topo' });
  await assert.rejects(s.read(), git.GitError);
  // An empty repository is a normal, empty log (git exits 128 there).
  const dir = await tmp();
  await git.run(dir, ['init', '-q']);
  assert.equal(await git.streamLog(dir, { kind: 'topo' }).read(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
