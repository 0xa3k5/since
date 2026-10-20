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

module.exports = { readRecent, addRecent, removeRecent, MAX };
