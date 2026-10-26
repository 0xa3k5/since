'use strict';
// Recent repositories (recent.json in userData): newest first, at most 20, folders that still exist.
const fs = require('node:fs');
const path = require('node:path');

const MAX = 20;

function readRecent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => fs.existsSync(r.root)); } catch { return []; }
}
function write(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX)));
}
function addRecent(file, repo) {
  const list = readRecent(file).filter((r) => r.root !== repo.root);
  list.unshift({ root: repo.root, name: repo.name, opened: Date.now() });
  write(file, list);
}
// Returns true when `root` was in the list.
function removeRecent(file, root) {
  const list = readRecent(file);
  const kept = list.filter((r) => r.root !== root);
  if (kept.length !== list.length) write(file, kept);
  return kept.length !== list.length;
}
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// The repository launch reopens (AK-633): `wanted` (the one the window closed last showed; null for the
// welcome screen) while it is still recent, else with nothing saved the newest recent one. Only while it
// is still a repository's top level: a folder whose .git is gone may sit inside another repository.
async function lastRepo(file, openRepo, wanted) {
  const list = readRecent(file);
  const root = wanted === undefined ? list[0]?.root : list.find((r) => r.root === wanted)?.root;
  if (!root) return null;
  try { return realpath((await openRepo(root)).root) === realpath(root) ? root : null; } catch { return null; }
}

module.exports = { readRecent, addRecent, removeRecent, lastRepo, MAX };
