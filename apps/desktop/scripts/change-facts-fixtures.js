'use strict';
// Records the change-facts calibration fixtures (test/fixtures/change-facts/) from GitHub with
// `gh`. Run by hand when the calibration set changes; the unit tests never run it and stay
// offline: `node scripts/change-facts-fixtures.js`.
//
// Per pull request: numstat.txt and summary.txt (from `git apply --numstat --summary` on the
// full diff), patch.diff (only the files whose content change-facts reads: lockfiles and tests,
// as in the app) and meta.json (title, changed manifests before and after at the merge base and
// head, and the repository's own package names at head).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SETS = [
  { repo: '0xa3k5/gitlanes', from: 210, to: 219 },
  { repo: '0xa3k5/web3icons', from: 211, to: 224 },
];
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/;
const MANIFEST = /(^|\/)(package\.json|composer\.json|go\.mod|Cargo\.toml|pyproject\.toml|Gemfile|requirements[^/]*\.(txt|in))$/;
const TEST = /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'change-facts');

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const raw = (repo, file, ref) => { try { return gh('api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${file}?ref=${ref}`); } catch { return ''; } };

for (const { repo, from, to } of SETS) {
  const tree = JSON.parse(gh('api', `repos/${repo}/git/trees/HEAD?recursive=1`)).tree;
  const internal = tree.filter((t) => /(^|\/)package\.json$/.test(t.path) && !t.path.includes('node_modules/'))
    .flatMap((t) => { try { const n = JSON.parse(raw(repo, t.path, 'HEAD')).name; return n ? [n] : []; } catch { return []; } });
  for (let n = from; n <= to; n++) {
    let pr;
    try { pr = JSON.parse(gh('pr', 'view', String(n), '--repo', repo, '--json', 'title,baseRefOid,headRefOid')); } catch { console.log(`${repo}#${n}: not a pull request, skipped`); continue; }
    const diff = gh('pr', 'diff', String(n), '--repo', repo);
    // Outside any repository: inside one, `git apply` only reports paths under the current folder.
    const apply = (flag) => execFileSync('git', ['apply', flag], { cwd: os.tmpdir(), input: diff, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const numstat = apply('--numstat');
    const summary = apply('--summary');
    const keep = (file) => LOCKFILE.test(file) || TEST.test(file);
    const patch = diff.split(/(?=^diff --git )/m).filter((chunk) => keep((/ b\/(.+)$/m.exec(chunk) || [])[1] || '')).join('');
    const mergeBase = JSON.parse(gh('api', `repos/${repo}/compare/${pr.baseRefOid}...${pr.headRefOid}`)).merge_base_commit.sha;
    const manifests = {};
    for (const line of numstat.split('\n').filter(Boolean)) {
      const file = line.split('\t')[2];
      if (MANIFEST.test(file)) manifests[file] = { before: raw(repo, file, mergeBase), after: raw(repo, file, pr.headRefOid) };
    }
    const dir = path.join(OUT, `${repo.split('/')[1]}-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'numstat.txt'), numstat);
    fs.writeFileSync(path.join(dir, 'summary.txt'), summary);
    fs.writeFileSync(path.join(dir, 'patch.diff'), patch);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ repo, number: n, title: pr.title, manifests, internal }, null, 1) + '\n');
    console.log(`${repo}#${n}: ${pr.title}`);
  }
}
