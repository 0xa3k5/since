'use strict';
// Lanes benchmark: `pnpm --filter @gitlanes/desktop bench:lanes [-- --branches 200 --worktrees 15 --shipped 0 --runs 5 --dir <path>]`.
// Shipped case: `-- --branches 60 --shipped 50`.
//
// Times git.lanes() (the lanes overview's data) on a generated repository: a 5,000-commit main,
// --branches branches forking from it with 1–4 commits each (every fifth one squash-merged back,
// every seventh one with an agent trailer), and --worktrees linked worktrees with dirty files.
// The first --shipped branches look like agent task branches that already shipped: a baseline
// commit, the work, a merge of main, then squash-merged onto main under another subject.
// Prints the cold and median warm time. Runs in the main process only, no app window.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BRANCHES = Number(arg('branches', 200));
const WORKTREES = Number(arg('worktrees', 15));
const RUNS = Number(arg('runs', 5));
const SHIPPED = Math.min(Number(arg('shipped', 0)), BRANCHES);
const DIR = arg('dir', path.join(process.env.GITLANES_BENCH_DIR || path.join(os.homedir(), '.cache', 'gitlanes-bench'), `lanes-${BRANCHES}-${WORKTREES}${SHIPPED ? `-s${SHIPPED}` : ''}`));
const MAIN = 5000;
const FILES = 200;

const branchName = (b) => (b % 9 === 0 ? `claude/task-${b}` : `feature-${b}`);

function generate(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  let s = 1;
  const rand = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
  let buf = '';
  let mark = 0;
  let time = 1600000000;
  const files = Array.from({ length: FILES }, (_, i) => `f${i}\n`);
  const commit = (ref, from, msg, edits, merge) => {
    mark++; time += 60;
    buf += `commit ${ref}\nmark :${mark}\ncommitter Bench <b@example.com> ${time} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${from ? `from :${from}\n` : ''}${merge ? `merge :${merge}\n` : ''}`;
    for (const [f, text] of edits) buf += `M 100644 inline src/${f}.txt\ndata ${Buffer.byteLength(text)}\n${text}\n`;
    buf += '\n';
    return mark;
  };
  const mains = [];
  let tip = 0;
  for (let i = 0; i < MAIN; i++) {
    const f = Math.floor(rand() * FILES);
    files[f] += `main ${i}\n`;
    tip = commit('refs/heads/main', tip, `Main change ${i}`, i ? [[`f${f}`, files[f]]] : files.map((t, k) => [`f${k}`, t]));
    mains.push(tip);
  }
  const landed = new Map(); // src path → content squash-merged onto main
  for (let b = 0; b < BRANCHES; b++) {
    const ref = `refs/heads/${branchName(b)}`;
    let from = mains[Math.floor(MAIN * 0.8 + rand() * MAIN * 0.2)];
    const n = 1 + Math.floor(rand() * 4);
    if (b < SHIPPED) {
      from = commit(ref, tip, 'chore(agent): baseline — the task worktree started here', []);
      for (let k = 0; k < n; k++) from = commit(ref, from, `Shipped ${b} step ${k}`, [[`s${b}`, `shipped ${b} step ${k}\n`]]);
      from = commit(ref, from, 'Merge branch main', [...files.map((t, k) => [`f${k}`, t]), ...landed], tip);
      landed.set(`s${b}`, `shipped ${b} step ${n - 1}\n`);
      tip = commit('refs/heads/main', tip, `Land work ${b} (#${1000 + b})`, [[`s${b}`, landed.get(`s${b}`)]]);
      continue;
    }
    for (let k = 0; k < n; k++) from = commit(ref, from, `Branch ${b} step ${k}${b % 7 === 0 ? '\n\nCo-Authored-By: Agent <noreply@anthropic.com>' : ''}`, [[`b${b}`, `branch ${b} step ${k}\n`]]);
    if (b % 5 === 0) tip = commit('refs/heads/main', tip, `Branch ${b} (#${b})`, [[`b${b}`, `branch ${b} step ${n - 1}\n`]]);
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: buf, maxBuffer: 1 << 30 });
  execFileSync('git', ['checkout', '-q', '-f', 'main'], { cwd: dir });
  for (let w = 0; w < WORKTREES; w++) {
    const wt = `${dir}-wt${w}`;
    fs.rmSync(wt, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-q', wt, branchName(w * 2 + 1)], { cwd: dir });
    for (let k = 0; k < 5; k++) fs.appendFileSync(path.join(wt, 'src', `f${k}.txt`), 'dirty\n');
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIR, '.git'))) { console.log(`Generating ${DIR}…`); generate(DIR); }
  const time = async () => { const t = process.hrtime.bigint(); const r = await git.lanes(DIR); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
  const [cold, res] = await time();
  // Warm: the base's squash data cached (the base hasn't moved). Uncached: as if it just moved.
  const warm = [];
  const uncached = [];
  for (let i = 0; i < RUNS; i++) warm.push((await time())[0]);
  for (let i = 0; i < RUNS; i++) { git.clearBaseSquashCache(); uncached.push((await time())[0]); }
  warm.sort((a, b) => a - b);
  uncached.sort((a, b) => a - b);
  const count = (f) => res.lanes.filter(f).length;
  console.log(`lanes(): ${res.lanes.length} lanes (${count((l) => l.worktree)} worktrees, ${count((l) => l.merged)} merged, ${count((l) => l.done)} done, ${count((l) => l.agent)} agent) vs ${res.base}`);
  console.log(`  cold ${cold.toFixed(0)} ms · warm median ${warm[Math.floor(warm.length / 2)].toFixed(0)} ms · base moved median ${uncached[Math.floor(uncached.length / 2)].toFixed(0)} ms (${RUNS} runs each)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
