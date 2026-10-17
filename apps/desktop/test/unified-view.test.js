'use strict';
// The unified changes view's helpers (renderer/unified.js) and its Preferences row.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/unified.js');

test('changedFiles lists each path once, conflicts first, keeping the staged status and old path', async () => {
  const { changedFiles } = await load();
  const files = changedFiles({
    conflicts: [{ path: 'c.js', status: 'U' }],
    unstaged: [{ path: 'a.js', status: 'M' }, { path: 'new.js', status: '?' }],
    staged: [{ path: 'a.js', status: 'R', oldPath: 'old.js' }, { path: 'b.js', status: 'M' }],
  });
  assert.deepEqual(files.map((f) => f.path), ['c.js', 'a.js', 'new.js', 'b.js']);
  const a = files[1];
  assert.equal(a.status, 'R');
  assert.equal(a.oldPath, 'old.js');
  assert.deepEqual(a.lists, ['unstaged', 'staged']);
  assert.deepEqual(changedFiles({}), []);
});

test('the commit box counts staged lines, files with something staged and lines left', async () => {
  const { commitSummary, summaryText } = await load();
  const s = commitSummary([{ staged: 8, total: 22 }, { staged: 6, total: 6 }, { staged: 0, total: 33 }, null]);
  assert.deepEqual(s, { lines: 14, files: 2, left: 47 });
  assert.equal(summaryText(s), '14 lines in 2 files will be committed · 47 left');
  assert.equal(summaryText({ lines: 1, files: 1, left: 0 }), '1 line in 1 file will be committed');
  assert.equal(summaryText({ lines: 0, files: 0, left: 5 }), 'Nothing staged · 5 left');
  assert.equal(summaryText({ lines: 0, files: 0, left: 0 }), 'Nothing to commit');
});

test('header counts and tick rules', async () => {
  const { stagedText, tickStages, hunkState, linesStage } = await load();
  assert.equal(stagedText(8, 22), '8 of 22 lines staged');
  assert.equal(stagedText(3, 3), 'All 3 lines staged');
  assert.equal(stagedText(0, 1), '1 line, none staged');
  assert.equal(tickStages('all'), false);
  assert.equal(tickStages('partial'), true);
  assert.equal(tickStages('none'), true);
  assert.equal(hunkState({ staged: 2, total: 2 }), 'all');
  assert.equal(hunkState({ staged: 1, total: 2 }), 'partial');
  assert.equal(hunkState({ staged: 0, total: 2 }), 'none');
  assert.equal(linesStage([{ staged: true }, { staged: false }]), true);
  assert.equal(linesStage([{ staged: true }, { staged: true }]), false);
});

test('big files and (optionally) fully staged files start folded; the user’s choice wins', async () => {
  const { folded, BIG_FILE_LINES } = await load();
  assert.equal(folded({ total: BIG_FILE_LINES + 1, state: 'none' }, {}), true);
  assert.equal(folded({ total: 10, state: 'all' }, { foldStaged: false }), false);
  assert.equal(folded({ total: 10, state: 'all' }, { foldStaged: true }), true);
  assert.equal(folded({ total: 10, state: 'partial' }, { foldStaged: true }), false);
  assert.equal(folded({ total: 900, state: 'none' }, { user: false }), false);
});

test('whole-file reasons read as sentences', async () => {
  const { wholeFileText } = await load();
  assert.equal(wholeFileText({ wholeFile: 'renamed', oldPath: 'a.js' }), 'Renamed from a.js. It stages as a whole file.');
  assert.match(wholeFileText({ wholeFile: 'binary' }), /^Binary file/);
  assert.equal(wholeFileText({ wholeFile: null }), null);
});

test('cursor steps clamp, and line ranges include both ends in page order', async () => {
  const { stepCursor, lineRange } = await load();
  assert.equal(stepCursor(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(stepCursor(['a', 'b', 'c'], 'c', 1), 'c');
  assert.equal(stepCursor(['a', 'b', 'c'], 'a', -1), 'a');
  assert.equal(stepCursor(['a', 'b'], 'gone', 1), 'a');
  assert.equal(stepCursor([], 'a', 1), null);
  assert.deepEqual(lineRange(['0:1', '0:2', '1:0', '1:3'], '1:3', '0:2'), ['0:2', '1:0', '1:3']);
  assert.deepEqual(lineRange(['0:1'], 'x', '0:1'), ['0:1']);
});

test('Preferences → Git has the one-list switch, off by default', async () => {
  const { prefRows } = await import('../renderer/prefs.js');
  const row = (show) => prefRows({ show, themes: [] }).find((r) => r.id === 'unified');
  assert.equal(row({}).section, 'git');
  assert.equal(row({}).value, false);
  assert.equal(row({ unified: true }).value, true);
});
