'use strict';
// Synthetic history generator for the benchmark. Writes a repository with `count`
// commits through `git fast-import`: a mainline plus up to `maxFeatures` concurrent
// feature branches that fork, interleave and merge back, so the graph has realistic
// lane pressure. Deterministic for a given count and seed.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const AUTHORS = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov', 'Ken Thompson', 'Margaret Hamilton', 'Donald Knuth', 'Frances Allen', 'Linus Torvalds', 'Radia Perlman', 'John McCarthy'];
const VERBS = ['Fix', 'Add', 'Remove', 'Refactor', 'Update', 'Rename', 'Speed up', 'Document', 'Simplify', 'Test'];
const NOUNS = ['parser', 'scheduler', 'cache', 'lane layout', 'diff view', 'config loader', 'network client', 'build script', 'error message', 'keyboard handler', 'allocator', 'logging'];

function generate(dir, count, { seed = 1, maxFeatures = 24, tags = 400, authors = AUTHORS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const child = spawn('git', ['fast-import', '--quiet', '--done'], { cwd: dir, stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => child.on('close', (code) => (code ? rej(new Error(`fast-import exited ${code}`)) : res())));

  let buf = '';
  const flush = () => { if (buf) { child.stdin.write(buf); buf = ''; } };
  let mark = 0;
  let time = 1500000000;
  const features = []; // { name, tip }
  const deleted = [];
  let main = 0;
  let featureSeq = 0;
  const tagEvery = Math.max(1, Math.floor(count / tags));

  const commit = (branch, parents, msg) => {
    mark++;
    time += 1 + Math.floor(rand() * 600);
    const who = pick(authors);
    const email = who.toLowerCase().replace(/\s+/g, '.') + '@example.com';
    const data = `${msg}\n`;
    buf += `commit refs/heads/${branch}\nmark :${mark}\nauthor ${who} <${email}> ${time} +0000\ncommitter ${who} <${email}> ${time} +0000\ndata ${Buffer.byteLength(data)}\n${data}`;
    if (parents[0]) buf += `from :${parents[0]}\n`;
    for (let i = 1; i < parents.length; i++) buf += `merge :${parents[i]}\n`;
    buf += `M 644 inline f\ndata 2\n${mark % 10}\n\n`;
    if (buf.length > 1 << 20) flush();
    return mark;
  };

  for (let n = 0; n < count; n++) {
    const r = rand();
    if (!main) { main = commit('main', [], 'Initial commit'); continue; }
    if (features.length && r < 0.06) {
      const i = Math.floor(rand() * features.length);
      const f = features.splice(i, 1)[0];
      main = commit('main', [main, f.tip], `Merge branch '${f.name}'`);
      if (rand() < 0.9) deleted.push(f.name); // most merged branches get deleted
    } else if (features.length < maxFeatures && r < 0.12) {
      const name = `feature/${++featureSeq}-${pick(NOUNS).replace(/\s+/g, '-')}`;
      features.push({ name, tip: commit(name, [main], `${pick(VERBS)} ${pick(NOUNS)}`) });
    } else if (features.length && r < 0.6) {
      const f = pick(features);
      f.tip = commit(f.name, [f.tip], `${pick(VERBS)} ${pick(NOUNS)}`);
    } else {
      main = commit('main', [main], `${pick(VERBS)} ${pick(NOUNS)}`);
    }
    if (n % tagEvery === 0 && n) buf += `reset refs/tags/v${Math.floor(n / tagEvery)}\nfrom :${main}\n\n`;
  }
  buf += 'done\n';
  flush();
  child.stdin.end();
  return done.then(() => {
    if (deleted.length) execFileSync('git', ['update-ref', '--stdin'], { cwd: dir, input: deleted.map((b) => `delete refs/heads/${b}\n`).join('') });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
    return dir;
  });
}

module.exports = { generate };

if (require.main === module) {
  const [dir, count] = process.argv.slice(2);
  if (!dir || !count) { console.error('usage: node bench/synth.js <dir> <commits>'); process.exit(1); }
  generate(dir, +count).then(() => console.log(`wrote ${count} commits to ${dir}`));
}
