'use strict';
// Review's catch-up card (AK-281): the checkpoint store (app data), git.landed (what reached the
// base since a checkpoint, with the force-push fallback) and the grouping. Git tests run in
// throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const github = require('../github');
const store = require('../catchup-store');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gitlanes-catchup-${p}-`)));
let clock = 1700000000;
const g = (dir, args) => git.run(dir, args, { env: { GIT_COMMITTER_DATE: `${clock} +0000`, GIT_AUTHOR_DATE: `${clock} +0000` } });
async function commit(dir, file, msg) {
  clock += 3600;
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  await g(dir, ['add', file]);
  await g(dir, ['commit', '-q', '-m', msg]);
  return (await g(dir, ['rev-parse', 'HEAD'])).trim();
}
async function repo() {
  const dir = tmp('repo');
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.name', 'Test']);
  await g(dir, ['config', 'user.email', 't@example.com']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, 'README.md', 'start');
  return dir;
}
const load = (p) => import(path.join(__dirname, '..', 'renderer', p));

test('checkpoint store: a week back at first, then the previous open’s tip; only Mark moves it', () => {
  const file = path.join(tmp('store'), 'catchup.json');
  const now = 1_800_000_000_000;
  // First open ever: nothing known, so the first catch-up starts a week back.
  store.noteOpen(file, '/r/a', { sha: 'a'.repeat(40), base: 'main', date: 1 }, now);
  assert.deepEqual(store.checkpoint(file, '/r/a', now), { sha: null, base: null, date: now - store.WEEK, source: 'week' });
  // Opening again doesn't move it.
  store.noteOpen(file, '/r/a', { sha: 'b'.repeat(40), base: 'main', date: 2 }, now + 1);
  assert.equal(store.checkpoint(file, '/r/a', now + 2).source, 'week');
  // Another repo opened twice before its first catch-up starts at the tip from the open before.
  store.noteOpen(file, '/r/b', { sha: 'c'.repeat(40), base: 'main', date: 3 }, now);
  store.noteOpen(file, '/r/b', { sha: 'd'.repeat(40), base: 'main', date: 4 }, now + 1);
  assert.deepEqual(store.checkpoint(file, '/r/b', now + 2), { sha: 'c'.repeat(40), base: 'main', date: 3, source: 'opened' });
  // Mark caught up moves it and hands back the one it replaced (for Undo).
  const before = store.mark(file, '/r/b', { sha: 'e'.repeat(40), base: 'main', date: 5 }, now + 3);
  assert.equal(before.sha, 'c'.repeat(40));
  assert.deepEqual(store.checkpoint(file, '/r/b'), { sha: 'e'.repeat(40), base: 'main', date: 5, source: 'mark', at: now + 3 });
  store.mark(file, '/r/b', before);
  assert.equal(store.checkpoint(file, '/r/b').sha, 'c'.repeat(40));
  // Kept per repository, outside it.
  assert.deepEqual(Object.keys(store.readAll(file)).sort(), ['/r/a', '/r/b']);
});

test('landed: commits after the checkpoint on the base, first parent, with their files', async () => {
  const dir = await repo();
  const cp = await commit(dir, 'apps/web/index.html', 'web: hero');
  await g(dir, ['checkout', '-q', '-b', 'feature']);
  await commit(dir, 'apps/desktop/main.js', 'AK-12 desktop work');
  await commit(dir, 'apps/desktop/git.js', 'more AK-12');
  await g(dir, ['checkout', '-q', 'main']);
  await commit(dir, 'docs/notes.md', 'docs: notes');
  clock += 60;
  await g(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from x/feature', 'feature']);
  const res = await git.landed(dir, { since: { sha: cp } });
  assert.equal(res.base, 'main');
  assert.equal(res.from, cp);
  assert.equal(res.fallback, null);
  assert.deepEqual(res.commits.map((c) => c.subject), ['Merge pull request #7 from x/feature', 'docs: notes']);
  assert.deepEqual(res.commits[0].files.sort(), ['apps/desktop/git.js', 'apps/desktop/main.js']);
  assert.deepEqual(res.commits[1].files, ['docs/notes.md']);
  assert.equal(res.commits[1].parent, cp);
  // Nothing since the tip; no checkpoint and no date: nothing at all.
  assert.deepEqual((await git.landed(dir, { since: { sha: res.baseSha } })).commits, []);
  assert.deepEqual((await git.landed(dir, {})).commits, []);
});

test('landed: since a date, and since a tag', async () => {
  const dir = await repo();
  await commit(dir, 'a.txt', 'old');
  const mid = (clock + 1800) * 1000;
  await g(dir, ['tag', 'v1']);
  await commit(dir, 'b.txt', 'new one');
  await commit(dir, 'c.txt', 'new two');
  assert.deepEqual((await git.landed(dir, { since: { date: mid } })).commits.map((c) => c.subject), ['new two', 'new one']);
  const byTag = await git.landed(dir, { since: { ref: 'refs/tags/v1' } });
  assert.deepEqual(byTag.commits.map((c) => c.subject), ['new two', 'new one']);
  assert.deepEqual(byTag.tags, ['v1']);
});

test('landed: a checkpoint lost to a force-push falls back to its date and says so', async () => {
  const dir = await repo();
  await commit(dir, 'a.txt', 'kept');
  const lost = await commit(dir, 'b.txt', 'rewritten away');
  await g(dir, ['reset', '-q', '--hard', 'HEAD~1']);
  await commit(dir, 'c.txt', 'after the force-push');
  const res = await git.landed(dir, { since: { sha: lost } });
  assert.deepEqual(res.fallback, { sha: lost, reason: 'unreachable' });
  assert.equal(res.from, null);
  assert.deepEqual(res.commits.map((c) => c.subject), ['after the force-push']);
  // A sha git doesn't know at all: the stored date is all there is.
  const gone = await git.landed(dir, { since: { sha: 'f'.repeat(40), date: (clock - 1800) * 1000 } });
  assert.equal(gone.fallback.reason, 'missing');
  assert.deepEqual(gone.commits.map((c) => c.subject), ['after the force-push']);
  const { sinceText } = await load('catchup.js');
  const t = sinceText({ ...res, kind: 'checkpoint', checkpoint: { sha: lost, base: 'main', date: 1 } });
  assert.match(t.warn, /no longer on main.*since its date/);
});

test('grouping: issue key first (labelled with its PR title), else area; merged PRs join by merge commit', async () => {
  const { landedEntries, groupLanded, issueKey, areaOf, sinceOptions, countsText } = await load('catchup.js');
  assert.equal(issueKey('feat: x (AK-281)'), 'AK-281');
  assert.equal(issueKey('no key', 'web2-1', 'WEB2-45 fix'), 'WEB2-45');
  assert.equal(issueKey('fix: read UTF-8 paths'), null);
  assert.equal(issueKey('use SHA-256 and ISO-8601 dates (AK-9)'), 'AK-9');
  assert.equal(issueKey('HTTP-2 support', 'WEB-3 HTTP-2'), 'WEB-3');
  assert.equal(areaOf('apps/web/src/x.astro'), 'apps/web');
  assert.equal(areaOf('docs/a.md'), 'docs');
  assert.equal(areaOf('README.md'), 'Top level');
  const sha = (c) => c.repeat(40);
  const commits = [
    { sha: sha('1'), parent: sha('0'), date: 5, author: 'a', subject: 'feat: catch up (AK-281) (#111)', files: ['apps/desktop/main.js'] },
    { sha: sha('2'), parent: sha('1'), date: 4, author: 'a', subject: 'fix typo in catch up', files: ['apps/desktop/x.js'] },
    { sha: sha('3'), parent: sha('2'), date: 3, author: 'b', subject: 'style: hero', files: ['apps/web/a.css', 'apps/web/b.css', 'docs/x.md'] },
    { sha: sha('4'), parent: sha('3'), date: 2, author: 'b', subject: 'more hero', files: ['apps/web/c.css'] },
  ];
  const merged = [
    { number: 111, title: 'feat(desktop): catch up on what landed (AK-281)', branch: 'ak-281-catch-up', merge: sha('1') },
    { number: 112, title: 'fix typo', branch: 'fix/AK-281-typo', merge: sha('2') },
    { number: 99, title: 'old one', branch: 'x', merge: sha('9') },
  ];
  const entries = landedEntries(commits, merged);
  assert.deepEqual(entries.map((e) => [e.kind, e.number ?? null, e.key, e.area]), [
    ['pr', 111, 'AK-281', 'apps/desktop'], ['pr', 112, 'AK-281', 'apps/desktop'], ['commit', null, null, 'apps/web'], ['commit', null, null, 'apps/web'],
  ]);
  const groups = groupLanded(entries);
  assert.deepEqual(groups.map((x) => [x.id, x.label, x.entries.length]), [
    ['key:AK-281', 'feat(desktop): catch up on what landed (AK-281)', 2],
    ['area:apps/web', 'apps/web', 2],
  ]);
  // Without PRs (PR features off): the same commits group by the key in their subjects, else by area.
  assert.deepEqual(groupLanded(landedEntries(commits, null)).map((x) => [x.id, x.label]), [
    ['area:apps/web', 'apps/web'], ['key:AK-281', 'feat: catch up (AK-281) (#111)'], ['area:apps/desktop', 'apps/desktop'],
  ]);
  assert.deepEqual(sinceOptions(['v2', 'v1']).map((o) => o.label), ['Last checkpoint', 'Yesterday', 'Last week', 'Tag v2', 'Tag v1']);
  const c = countsText({ entries, stuck: 1, ready: 2, prsOn: true, ci: { state: 'failing', failed: ['test'] }, base: 'main' });
  assert.deepEqual(c.parts, ['2 merged · 2 other commits', '1 stuck', '2 ready to merge']);
  assert.equal(c.ci.text, 'main CI failing: test');
  assert.deepEqual(countsText({ entries: landedEntries(commits), stuck: 0, ready: 0, prsOn: false, ci: null, base: 'main' }).parts, ['4 commits landed', '0 stuck']);
});

test('base CI: the newest run per workflow on the newest commit; cancelled runs don’t fail it', () => {
  const run = (headSha, workflowName, status, conclusion) => ({ headSha, workflowName, status, conclusion });
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.deepEqual(github.parseBaseCi(JSON.stringify([run(a, 'CI', 'completed', 'success'), run(a, 'CI', 'completed', 'failure'), run(b, 'Lint', 'completed', 'failure')])), { state: 'passing', sha: a, failed: [] });
  assert.deepEqual(github.parseBaseCi(JSON.stringify([run(a, 'CI', 'completed', 'failure'), run(a, 'Web', 'in_progress', '')])), { state: 'failing', sha: a, failed: ['CI'] });
  assert.equal(github.parseBaseCi(JSON.stringify([run(a, 'CI', 'queued', ''), run(a, 'Old', 'completed', 'cancelled')])).state, 'pending');
  assert.equal(github.parseBaseCi('[]'), null);
  assert.throws(() => github.parseBaseCi('{}'), /list/);
});

test('walk-through header: a short "since …" for every catch-up kind (AK-304)', async () => {
  const { sinceLabel } = await load('catchup.js');
  assert.equal(sinceLabel({ kind: 'checkpoint', checkpoint: { sha: 'a1b2c3d4e5f6' } }), 'since a1b2c3d');
  assert.equal(sinceLabel({ kind: 'tag', tag: 'v0.1.0' }), 'since tag v0.1.0');
  assert.equal(sinceLabel({ kind: 'yesterday' }), 'since yesterday');
  assert.equal(sinceLabel({ kind: 'week' }), 'since last week');
  assert.equal(sinceLabel({ kind: 'checkpoint', checkpoint: {} }), 'since checkpoint');
});

test('timeline: entries by day, newest first, Today and Yesterday, then dates (AK-365)', async () => {
  const { byDay, firstOf, headline, sincePhrase } = await load('catchup.js');
  const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();
  const now = at(16, 12);
  const e = (id, date, kind = 'pr') => ({ id, date, kind });
  const days = byDay([e('a', at(14, 9)), e('b', at(16, 8)), e('c', at(15, 23)), e('d', at(16, 11)), e('x', 0, 'commit')], { now, dateLabel: (ms) => `day ${new Date(ms).getDate()}` });
  assert.deepEqual(days.map((d) => [d.label, d.entries.map((x) => x.id)]), [
    ['Today', ['d', 'b']], ['Yesterday', ['c']], ['day 14', ['a']], ['Undated', ['x']],
  ]);
  // Just after midnight: yesterday evening is Yesterday, not Today.
  assert.deepEqual(byDay([e('m', at(15, 23))], { now: at(16, 0) + 60e3 }).map((d) => d.label), ['Yesterday']);
  assert.deepEqual(byDay([]), []);

  // The first n rows across days, and how many are left for "+ N more".
  const { days: top, more } = firstOf(days, 3);
  assert.deepEqual(top.map((d) => d.entries.length), [2, 1]);
  assert.equal(more, 2);
  assert.equal(firstOf(days, 10).more, 0);

  assert.deepEqual(headline([e('a'), e('b'), e('c', 0, 'commit')]), { count: 2, text: 'PRs merged', extra: '1 other commit' });
  assert.deepEqual(headline([e('a', 0, 'commit')]), { count: 1, text: 'commit landed', extra: null });
  assert.equal(headline([e('a')]).text, 'PR merged');
  assert.equal(sincePhrase({ since: 'checkpoint' }), 'since your checkpoint');
  assert.equal(sincePhrase({ since: 'tag', tag: 'v0.1.0' }), 'since tag v0.1.0');
});

test('the reader: stepping, diff counts, viewed and the description (AK-372)', async () => {
  const { stepId, diffCounts, firstUnviewed, readerDescription, landedEntries } = await load('catchup.js');
  const pr = (id) => ({ id, kind: 'pr' });
  const list = [pr('a'), pr('b'), pr('c')];
  assert.equal(stepId(list, 'b', 1), 'c');
  assert.equal(stepId(list, 'c', 1), 'c', 'stops at the end');
  assert.equal(stepId(list, 'a', -1), 'a', 'stops at the start');
  assert.equal(stepId(list, 'x', 1), 'a', 'not in the list: the first');
  assert.equal(stepId([], 'a', 1), null);
  const diff = { hunks: [{ lines: [{ t: ' ' }, { t: '+' }, { t: '+' }, { t: '-' }] }, { lines: [{ t: '-' }, { t: '+' }] }] };
  assert.deepEqual(diffCounts(diff), { add: 3, del: 2 });
  assert.deepEqual(diffCounts(null), { add: 0, del: 0 });
  assert.equal(firstUnviewed(['a', 'b', 'c'], new Set(['a'])), 'b');
  assert.equal(firstUnviewed(['a'], new Set(['a'])), null);
  assert.deepEqual(readerDescription({ body: 'Adds a skip link.\r\n\r\n\r\n<!-- template -->Tested.' }, 'ignored'), { text: 'Adds a skip link.\n\nTested.', from: 'pr' });
  assert.deepEqual(readerDescription({ body: '' }, 'Subject\n\nBody'), { text: '', from: 'pr' }, 'an empty PR body says so, no fallback');
  assert.deepEqual(readerDescription({}, 'Subject (#12)\n\n* first\n* second\n\nCo-authored-by: A <a@x>\nSigned-off-by: B <b@x>'), { text: '* first\n* second', from: 'commit' });
  assert.deepEqual(readerDescription({}, 'Just a subject'), { text: '', from: 'commit' });
  const [withBody, without] = landedEntries(
    [{ sha: 'm1', parent: 'p', date: 1, author: 'a', subject: 's', files: [] }, { sha: 'm2', parent: 'p', date: 1, author: 'a', subject: 's', files: [] }],
    [{ number: 1, title: 'One', merge: 'm1', body: 'Why' }, { number: 2, title: 'Two', merge: 'm2' }]);
  assert.equal(withBody.body, 'Why', 'the merged PR’s body when GitHub sent one');
  assert.equal('body' in without, false);
});

test('landed reads another branch when given a base ref (AK-374)', async () => {
  const dir = await repo();
  const start = (await g(dir, ['rev-parse', 'HEAD'])).trim();
  await g(dir, ['checkout', '-q', '-b', 'dev']);
  await commit(dir, 'a.txt', 'on dev');
  await g(dir, ['checkout', '-q', 'main']);
  await commit(dir, 'b.txt', 'on main');
  const def = await git.landed(dir, { since: { sha: start } });
  assert.equal(def.base, 'main');
  assert.deepEqual(def.commits.map((c) => c.subject), ['on main']);
  const dev = await git.landed(dir, { base: 'refs/heads/dev', since: { sha: start } });
  assert.equal(dev.base, 'dev');
  assert.deepEqual(dev.commits.map((c) => c.subject), ['on dev']);
  assert.equal((await git.laneBase(dir, 'refs/heads/dev')).ref, 'refs/heads/dev');
  await assert.rejects(git.landed(dir, { base: 'refs/heads/nope' }), /Unknown base/);
});

test('changeSize sums a change\'s file diffs for the reader head', async () => {
  const { changeSize } = await load('catchup.js');
  const d = (adds, dels) => ({ hunks: [{ lines: [...Array(adds).fill({ t: '+' }), ...Array(dels).fill({ t: '-' }), { t: ' ' }] }] });
  assert.deepEqual(changeSize([d(3, 1), d(0, 2)]), { additions: 3, deletions: 3, files: 2 });
  assert.deepEqual(changeSize([]), { additions: 0, deletions: 0, files: 0 });
});

test('a git-only reload that overtook a PR load keeps its merged PRs (AK-338)', async () => {
  const { withLateExtra } = await load('catchup.js');
  const extra = { merged: [{ number: 3 }], ci: null };
  assert.deepEqual(withLateExtra({ commits: [], merged: [] }, extra), { commits: [], merged: extra.merged, ci: null });
  assert.equal(withLateExtra(null, extra), null);
});

test('a root commit reads its whole tree as its files (AK-287)', async () => {
  const dir = tmp('root');
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.name', 'Test']);
  await g(dir, ['config', 'user.email', 't@example.com']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  const sha = await commit(dir, 'a/one.txt', 'first');
  assert.deepEqual((await git.commitDiffs(dir, sha)).map((d) => d.path), ['a/one.txt']);
});
