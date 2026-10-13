'use strict';
// Large-repository benchmark: `npm run bench [-- options]`.
//
// Opens each repository in the real app and records, from inside the window:
//   first paint   launch → first Map rows on screen
//   full graph    launch → every commit laid out (scrollable to the root)
//   all details   launch → subjects/authors loaded for every commit
//   scroll        frame rate while flinging two rows per frame, and while jumping randomly
//   memory        resident memory of all app processes after the history is loaded
//
// Each repository is opened once "cold" (git's commit-graph cache removed, as after a fresh
// clone) and then --runs times "warm" (the median is reported).
//
// Options:
//   --repos a,b      named repos: synthetic-100k, synthetic-250k, synthetic-1m, linux, chromium
//                    (default: synthetic-100k,synthetic-250k, plus linux/chromium when their paths are set)
//   --repo <path>    an existing repository (repeatable)
//   --runs <n>       warm runs per repo (default 3)
//   --dir <path>     where generated and cloned repos live (default $GITLANES_BENCH_DIR or ~/.cache/gitlanes-bench)
//   --linux <path>   / --chromium <path>   use an existing checkout instead of cloning
//   --clone          clone linux/chromium (commits only, root-only sparse checkout) if missing
//   --out <file>     write the results as JSON
//   --no-cold        skip the cold run (never done for --repo paths)

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generate } = require('./synth');

const APP = path.join(__dirname, '..');
const MIRRORS = { linux: 'https://github.com/torvalds/linux.git', chromium: 'https://github.com/chromium/chromium.git' };

function parseArgs(argv) {
  const o = { repos: null, repo: [], runs: 3, dir: process.env.GITLANES_BENCH_DIR || path.join(os.homedir(), '.cache', 'gitlanes-bench'), clone: false, cold: true, out: null, linux: process.env.GITLANES_BENCH_LINUX, chromium: process.env.GITLANES_BENCH_CHROMIUM };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--repos') o.repos = val().split(',').filter(Boolean);
    else if (a === '--repo') o.repo.push(path.resolve(val()));
    else if (a === '--runs') o.runs = +val();
    else if (a === '--dir') o.dir = path.resolve(val());
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--linux') o.linux = path.resolve(val());
    else if (a === '--chromium') o.chromium = path.resolve(val());
    else if (a === '--clone') o.clone = true;
    else if (a === '--no-cold') o.cold = false;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!o.repos) {
    o.repos = o.repo.length ? [] : ['synthetic-100k', 'synthetic-250k'];
    if (o.linux) o.repos.push('linux');
    if (o.chromium) o.repos.push('chromium');
  }
  return o;
}

const gitOut = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

async function prepare(name, o) {
  const m = /^synthetic-(\d+)(k|m)$/.exec(name);
  if (m) {
    const count = +m[1] * (m[2] === 'k' ? 1000 : 1000000);
    const dir = path.join(o.dir, name);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      console.log(`Generating ${name}…`);
      fs.rmSync(dir, { recursive: true, force: true });
      await generate(dir, count);
      gitOut(dir, ['pack-refs', '--all']);
    }
    return dir;
  }
  if (MIRRORS[name]) {
    const dir = o[name] || path.join(o.dir, name);
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (!o.clone) throw new Error(`${name}: no checkout at ${dir}. Pass --${name} <path> or --clone.`);
    // Commits only (no trees or blobs), then a root-only sparse checkout so the work tree stays tiny.
    console.log(`Cloning ${name} (commits only; this downloads a few hundred MB)…`);
    execFileSync('git', ['clone', '--filter=tree:0', '--no-checkout', MIRRORS[name], dir], { stdio: 'inherit' });
    execFileSync('git', ['sparse-checkout', 'set', '--cone', '--sparse-index'], { cwd: dir, stdio: 'inherit' });
    execFileSync('git', ['reset', '-q', '--hard', 'HEAD'], { cwd: dir, stdio: 'inherit' });
    return dir;
  }
  throw new Error(`Unknown repo ${name}`);
}

function commitGraphFiles(dir) {
  const info = path.join(gitOut(dir, ['rev-parse', '--git-common-dir']).replace(/^(?!\/)/, dir + '/'), 'objects', 'info');
  return [path.join(info, 'commit-graph'), path.join(info, 'commit-graphs')];
}
const hasCommitGraph = (dir) => commitGraphFiles(dir).some((f) => fs.existsSync(f));
const dropCommitGraph = (dir) => { for (const f of commitGraphFiles(dir)) fs.rmSync(f, { recursive: true, force: true }); };

function runApp(repo) {
  const electron = require('electron'); // path to the binary when required from node
  const out = path.join(os.tmpdir(), `gitlanes-bench-${process.pid}-${Date.now()}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [APP, repo], { env: { ...process.env, GITLANES_BENCH: out }, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', () => {
      try { const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); r.error ? reject(new Error(r.error)) : resolve(r); } catch (e) { reject(new Error(`app exited without results (${e.message})`)); }
    });
  });
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
function summarize(runs) {
  const pick = (f) => median(runs.map(f));
  return {
    commits: runs[0].commits,
    firstPaintMs: pick((r) => r.firstPaintMs),
    firstPaintFromLoadMs: pick((r) => r.firstPaintFromLoadMs),
    fullGraphMs: pick((r) => r.fullGraphMs),
    allDetailsMs: pick((r) => r.allDetailsMs),
    scrollFps: pick((r) => r.scroll.fps),
    scrollP95Ms: pick((r) => r.scroll.p95),
    jumpFps: pick((r) => r.jump.fps),
    jumpP95Ms: pick((r) => r.jump.p95),
    memoryMB: pick((r) => r.memory.totalMB),
    rendererMB: pick((r) => r.memory.rendererMB),
  };
}

function table(rows) {
  const cols = ['repo', 'mode', 'commits', 'firstPaintMs', 'fullGraphMs', 'allDetailsMs', 'scrollFps', 'scrollP95Ms', 'jumpFps', 'jumpP95Ms', 'memoryMB'];
  const head = ['Repo', 'Open', 'Commits', 'First paint', 'Full graph', 'All details', 'Scroll fps', 'p95 ms', 'Jump fps', 'p95 ms', 'RSS MB'];
  const cells = rows.map((r) => cols.map((c) => (typeof r[c] === 'number' ? r[c].toLocaleString('en-US') : String(r[c] ?? ''))));
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => '| ' + c.map((x, i) => (i < 2 ? x.padEnd(w[i]) : x.padStart(w[i]))).join(' | ') + ' |';
  return [line(head), '|' + w.map((n, i) => (i < 2 ? '-' : '') + '-'.repeat(n) + (i < 2 ? '-' : ':') + '|').join(''), ...cells.map(line)].join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  fs.mkdirSync(o.dir, { recursive: true });
  const targets = [];
  // Checkouts the user pointed us at (--linux, --chromium) are theirs: never drop their commit-graph.
  for (const name of o.repos) targets.push({ name, dir: await prepare(name, o), managed: !o[name] });
  for (const dir of o.repo) targets.push({ name: path.basename(dir), dir, managed: false });

  const results = [];
  const machine = `${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB, macOS ${os.release()}, git ${gitOut(APP, ['--version']).replace('git version ', '')}`;
  console.log(machine);
  for (const t of targets) {
    // Cold runs delete git's commit-graph cache, so only do that to repos the benchmark owns.
    if (o.cold && t.managed) {
      dropCommitGraph(t.dir);
      process.stdout.write(`${t.name}: cold… `);
      const r = await runApp(t.dir);
      results.push({ repo: t.name, mode: 'cold', ...summarize([r]) });
      console.log(`${r.firstPaintMs} ms first paint`);
    }
    // The app writes git's commit-graph itself; make sure warm runs see one either way.
    if (!hasCommitGraph(t.dir)) execFileSync('git', ['commit-graph', 'write', '--reachable'], { cwd: t.dir });
    const runs = [];
    for (let i = 0; i < o.runs; i++) {
      process.stdout.write(`${t.name}: warm ${i + 1}/${o.runs}… `);
      const r = await runApp(t.dir);
      runs.push(r);
      console.log(`${r.firstPaintMs} ms first paint`);
    }
    if (runs.length) results.push({ repo: t.name, mode: 'warm', ...summarize(runs) });
  }
  console.log('\n' + table(results));
  if (o.out) fs.writeFileSync(o.out, JSON.stringify({ machine, date: new Date().toISOString(), results }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
