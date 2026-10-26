'use strict';
// A stand-in for GitHub CLI in the e2e suite (AK-277). Sandbox.github() puts a `gh` on PATH that
// runs this file. It answers the calls Since makes from a JSON state file
// ($SINCE_FAKE_GH) and keeps the PRs' branches in a bare repository that stands in for
// github.com. Approving and merging change the state; a squash merge really lands on the base
// branch of the bare repository, so the app's fetch afterwards sees it. Every call is appended to
// the state's `log` file (one JSON array of args per line). Anything it doesn't know fails the way
// `gh` does: a message on stderr and exit code 1.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const file = process.env.SINCE_FAKE_GH;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(state.log, `${JSON.stringify(args)}\n`);

const git = (...a) => execFileSync('git', ['--git-dir', state.bare, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const print = (v) => process.stdout.write(typeof v === 'string' ? `${v}\n` : JSON.stringify(v));
function fail(msg) { process.stderr.write(`${msg}\n`); process.exit(1); }
const pick = (obj, fields) => Object.fromEntries(String(fields).split(',').map((f) => [f, obj[f] ?? null]));
const find = (n) => state.prs.find((p) => p.number === Number(n)) || fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
const approved = (p) => p.reviews.some((r) => r.state === 'APPROVED');
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Everything `gh pr view/list --json` can be asked for here; the caller's --json picks the fields.
function view(p) {
  const head = p.state === 'OPEN' ? git('rev-parse', `refs/heads/${p.headRefName}`) : p.headRefOid;
  const [additions, deletions, changedFiles] = git('diff', '--numstat', `${p.baseRefName}...${head}`).split('\n').filter(Boolean)
    .reduce(([a, d, n], l) => { const [x, y] = l.split('\t'); return [a + Number(x), d + Number(y), n + 1]; }, [0, 0, 0]);
  const ok = approved(p);
  return {
    number: p.number, title: p.title, body: p.body, state: p.state, url: `https://${state.host}/${state.owner}/${state.name}/pull/${p.number}`,
    headRefName: p.headRefName, headRefOid: head, baseRefName: p.baseRefName, headRepositoryOwner: { login: state.owner }, isCrossRepository: false,
    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: ok || !state.requireReview ? 'CLEAN' : 'BLOCKED',
    reviewDecision: ok ? 'APPROVED' : state.requireReview ? 'REVIEW_REQUIRED' : '',
    statusCheckRollup: [], latestReviews: p.reviews,
    reviewRequests: ok ? [] : [{ __typename: 'User', login: state.viewer }],
    author: { login: p.author, name: '', is_bot: false }, updatedAt: p.updatedAt,
    additions, deletions, changedFiles,
    mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null, mergedAt: p.mergedAt || null,
  };
}

const REPO = {
  squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, deleteBranchOnMerge: false,
  viewerPermission: 'WRITE', viewerDefaultMergeMethod: 'SQUASH', defaultBranchRef: { name: 'main' },
};

// GitHub squash-merges into the base: the merged tree, one commit on top of the base's tip.
function squash(p) {
  const base = `refs/heads/${p.baseRefName}`;
  const head = git('rev-parse', `refs/heads/${p.headRefName}`);
  const tree = git('merge-tree', '--write-tree', base, head);
  const commit = git('commit-tree', tree, '-p', base, '-m', `${p.title} (#${p.number})`);
  git('update-ref', base, commit);
  if (has('--delete-branch')) git('update-ref', '-d', `refs/heads/${p.headRefName}`);
  Object.assign(p, { state: 'MERGED', headRefOid: head, mergeCommit: commit, mergedAt: now(), updatedAt: now() });
}

const [cmd, sub] = args;
const query = (args.find((a) => a.startsWith('query=')) || '').slice('query='.length);
if (cmd === 'auth' && sub === 'status') print(`${state.host}\n  ✓ Logged in to ${state.host} account ${state.viewer}`);
else if (cmd === 'auth' && sub === 'token') print('gho_fake_e2e_token');
else if (cmd === 'api' && args.includes('user')) print(state.viewer);
else if (cmd === 'api' && args.includes('graphql') && query.includes('viewer{login} repository(owner:$owner,name:$name){viewerPermission}')) {
  print({ data: { viewer: { login: state.viewer }, repository: { viewerPermission: REPO.viewerPermission } } });
} else if (cmd === 'pr' && sub === 'list') {
  const want = flag('--state') === 'merged' ? 'MERGED' : 'OPEN';
  const search = flag('--search');
  const prs = state.prs.filter((p) => p.state === want && (search !== 'review-requested:@me' || !approved(p)));
  print(prs.map((p) => pick(view(p), flag('--json'))));
} else if (cmd === 'pr' && sub === 'view') print(pick(view(find(args[2])), flag('--json')));
else if (cmd === 'repo' && sub === 'view') print(pick(REPO, flag('--json')));
else if (cmd === 'run' && sub === 'list') print([]);
else if (cmd === 'pr' && sub === 'review' && has('--approve')) {
  const p = find(args[2]);
  if (p.author === state.viewer) fail('failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)');
  p.reviews = [{ author: { login: state.viewer, name: '' }, state: 'APPROVED', submittedAt: now() }];
  p.updatedAt = now();
  save();
} else if (cmd === 'pr' && sub === 'merge') {
  const p = find(args[2]);
  if (p.state !== 'OPEN') fail(`X Pull request ${state.owner}/${state.name}#${p.number} was already merged`);
  if (!has('--squash')) fail('fake gh: only --squash merges are supported');
  if (state.requireReview && !approved(p)) fail(`X Pull request ${state.owner}/${state.name}#${p.number} is not mergeable: the base branch policy prohibits the merge.`);
  squash(p);
  save();
} else fail(`fake gh: unsupported command: gh ${args.join(' ')}`);
