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

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `since-catchup-${p}-`)));
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

  assert.deepEqual(headline([e('a'), e('b'), e('c', 0, 'commit')]), { count: 2, text: 'PRs merged', extra: '1 other commit', total: 3 });
  assert.deepEqual(headline([e('a', 0, 'commit')]), { count: 1, text: 'commit landed', extra: null, total: 1 });
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

test('app:catchup options: default base, other branches and bad refs (AK-377)', async () => {
  const { catchupOptions, WEEK } = require('../catchup-store');
  const now = 1e12;
  const cp = { sha: 'a'.repeat(40), date: now - 1000 };
  let asked = 0;
  const ctx = { defaultRef: async () => { asked++; return 'refs/remotes/origin/main'; }, checkpoint: () => cp, now };
  const none = await catchupOptions(null, ctx);
  assert.deepEqual([none.kind, none.isDefault, none.base, none.cp, none.since], ['checkpoint', true, undefined, cp, { sha: cp.sha, date: cp.date }]);
  assert.equal(asked, 0); // no base: the default isn't looked up
  const same = await catchupOptions({ base: 'refs/remotes/origin/main' }, ctx);
  assert.deepEqual([same.kind, same.isDefault, same.base], ['checkpoint', true, undefined]);
  const other = await catchupOptions({ base: 'refs/heads/feature' }, ctx);
  assert.deepEqual([other.kind, other.isDefault, other.base, other.cp, other.since], ['week', false, 'refs/heads/feature', null, { date: now - WEEK }]);
  const tag = await catchupOptions({ since: 'tag', tag: 'v1', base: 'refs/heads/feature' }, ctx);
  assert.deepEqual([tag.kind, tag.since], ['tag', { ref: 'refs/tags/v1' }]);
  await assert.rejects(catchupOptions({ base: 'refs/tags/v1' }, ctx), /not a branch/);
  await assert.rejects(catchupOptions({ base: 'HEAD' }, ctx), /not a branch/);
  await assert.rejects(catchupOptions({ nope: 1 }, ctx), /Invalid catch-up options/);
});

test('merged stacks: GitHub stack facts per merged PR, joined onto the merged list (AK-616)', () => {
  const pr = (n, stack, stat = [10, 2, 3]) => ({ number: n, additions: stat[0], deletions: stat[1], changedFiles: stat[2], stack });
  const st = (number, size, parts) => ({ number, size, entries: { nodes: parts.map((n, i) => ({ position: i + 1, pullRequest: { number: n } })).reverse() } });
  const out = JSON.stringify({ data: { repository: { p41: pr(41, st(40, 3, [41, 42, 44])), p42: pr(42, st(40, 3, [41, 42, 44])), p50: pr(50, null), p51: { number: 99 } } } });
  const facts = github.parseMergedStacks(out, [41, 42, 50, 51, 60]);
  // Parts come back bottom first whatever order GitHub lists them in; a PR in no stack has none.
  assert.deepEqual(facts.get(41), { stack: { number: 40, size: 3, parts: [41, 42, 44] }, stat: { additions: 10, deletions: 2, files: 3 } });
  assert.deepEqual(facts.get(50), { stack: null, stat: { additions: 10, deletions: 2, files: 3 } });
  assert.equal(facts.has(51), false); // answered for another number
  assert.equal(facts.has(60), false); // missing
  assert.equal(github.parseMergedStacks(JSON.stringify({ data: { repository: { p7: pr(7, null, [1, 'x', 2]) } } }), [7]).get(7).stat, null);
  const merged = [{ number: 41, title: 'a' }, { number: 50, title: 'b' }, { number: 70, title: 'c' }];
  const joined = github.joinStacks(merged, facts);
  assert.deepEqual(joined[0].stack, { number: 40, size: 3, parts: [41, 42, 44] });
  assert.equal('stack' in joined[1], false);
  assert.equal(joined[2], merged[2]);
  // A failed lookup (null) leaves the list as it was: Catch up shows it ungrouped.
  assert.equal(github.joinStacks(merged, null), merged);
});

test('timeline: a merged stack is one item per day, its parts bottom first (AK-616)', async () => {
  const { landedEntries, byDay, groupStacks, landedItems, timelineRows, stackArrow, stackPlace, stackSize, headline } = await load('catchup.js');
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const now = at(20, 12);
  const stack = { number: 260, size: 4, parts: [257, 258, 259, 261] };
  const sha = (n) => String(n).padStart(40, 'a');
  const commits = [[261, at(20, 11, 3)], [259, at(20, 11, 2)], [300, at(20, 10)], [258, at(19, 9, 1)], [257, at(19, 9)], [400, at(18, 9)]]
    .map(([n, date]) => ({ sha: sha(n), subject: `s${n}`, date, files: ['a.js'] }));
  commits.push({ sha: 'b'.repeat(40), subject: 'loose', date: at(18, 8), files: [] });
  const merged = [257, 258, 259, 261, 300, 400].map((n) => ({ number: n, title: `t${n}`, merge: sha(n), ...(n < 300 ? { stack, stat: { additions: n - 250, deletions: 1, files: 2 } } : {}) }));
  const entries = landedEntries(commits, merged);
  assert.deepEqual(entries[0].stack, stack);
  assert.deepEqual(entries[0].stat, { additions: 11, deletions: 1, files: 2 });
  const days = groupStacks(byDay(entries, { now }));
  // Merged in pieces across days: one item per day, "N of size merged", at its newest part.
  assert.deepEqual(days.map((d) => d.entries.map((x) => x.id)), [
    [`stack:260:${days[0].id}`, 'pr:300'], [`stack:260:${days[1].id}`], ['pr:400', `commit:${'b'.repeat(40)}`],
  ]);
  const today = days[0].entries[0];
  assert.deepEqual([today.kind, today.lo, today.hi, today.title, today.date], ['stack', 259, 261, 'Stack · 2 of 4 merged', at(20, 11, 3)]);
  assert.deepEqual(today.parts.map((p) => p.number), [259, 261]);
  assert.deepEqual(stackSize(today), { additions: 20, deletions: 2, files: 4 });
  // The whole stack on one day: "Stack · 4 PRs", parts bottom first by GitHub's order, not by number.
  const whole = { number: 9, size: 3, parts: [12, 11, 13] };
  const one = groupStacks(byDay([13, 12, 11].map((n, i) => ({ id: `pr:${n}`, kind: 'pr', number: n, date: at(20, 9, 3 - i), stack: whole })), { now }))[0].entries;
  assert.deepEqual(one.map((x) => [x.title, x.lo, x.hi, x.parts.map((p) => p.number)]), [['Stack · 3 PRs', 12, 13, [12, 11, 13]]]);
  // One part on its own day stays a PR row; a PR in no stack is untouched.
  const lone = groupStacks(byDay([{ id: 'pr:5', kind: 'pr', number: 5, date: at(20, 9), stack }, { id: 'pr:6', kind: 'pr', number: 6, date: at(20, 8) }], { now }))[0].entries;
  assert.deepEqual(lone.map((x) => x.kind), ['pr', 'pr']);
  // Without stack facts (the lookup failed), nothing groups.
  assert.equal(landedItems(landedEntries(commits, merged.map(({ stack: _, ...p }) => p)), { now }).length, entries.length);

  // The head counts a stack once: "1 stack and 2 PRs merged", "2 stacks and 1 PR merged", "1 stack merged".
  const items = landedItems(entries, { now });
  const head = headline(items);
  assert.equal(`${head.count} ${head.text}`, '1 stack and 2 PRs merged');
  assert.deepEqual([head.extra, head.total], ['1 other commit', 4]);
  const st = (n) => ({ id: `stack:${n}`, kind: 'stack', stack: { number: n } });
  const sent = (list) => { const x = headline(list); return `${x.count} ${x.text}`; };
  assert.equal(sent([st(1), st(2), { kind: 'pr' }]), '2 stacks and 1 PR merged');
  assert.equal(sent([st(1)]), '1 stack merged');
  // A lone part of a stack shown elsewhere counts with that stack.
  assert.equal(sent([st(1), { kind: 'pr', stack: { number: 1 } }, { kind: 'pr', stack: { number: 2 } }]), '1 stack and 1 PR merged');

  // The reader's place: from GitHub's list of parts, else from the parts that merged with it.
  assert.equal(stackPlace(today.parts[0]), 'Stack #257 → #261 · 3 of 4');
  assert.equal(stackPlace({ number: 12, stack: { number: 9, size: 3 } }, { parts: [{ number: 11 }, { number: 12 }] }), 'Stack #11 → #12 · 2 of 3');
  assert.equal(stackPlace({ number: 300 }), null);

  // Keyboard: collapsed, ↑/↓ see the stack as one row; expanded, its parts sit under it, newest first.
  assert.deepEqual(timelineRows(days[0].entries).map((x) => x.id), [today.id, 'pr:300']);
  const opened = new Set([today.id]);
  assert.deepEqual(timelineRows(days[0].entries, opened).map((x) => x.id), [today.id, 'pr:261', 'pr:259', 'pr:300']);
  // → expands, ← collapses, ← on a part goes up to its stack; otherwise ←/→ step as before (null).
  assert.deepEqual(stackArrow(today, 1), { open: today.id });
  assert.equal(stackArrow(today, 1, { opened }), null);
  assert.deepEqual(stackArrow(today, -1, { opened }), { close: today.id });
  assert.equal(stackArrow(today, -1), null);
  assert.deepEqual(stackArrow(today.parts[0], -1, { opened, up: today }), { select: today.id });
  assert.equal(stackArrow(today.parts[0], 1, { opened, up: today }), null);
  assert.equal(stackArrow(entries[2], -1), null);
});
