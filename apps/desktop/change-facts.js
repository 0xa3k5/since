'use strict';
// Change facts: plain, deterministic facts about what a branch's diff did (`base...head`, so
// against the merge base), for the Review rows. Git only, no network, no risk score and no
// policy: each fact says what happened and where, and the reader decides what it means.
//
// Two levels:
// - `flag`: worth a look on its own. Dependencies changed, CI or build config changed, test files
//   deleted, tests skipped, mode changes, non-asset binaries, fragile files.
// - `info`: neutral detail. Test files changed (or "tests: none changed"), deleted files,
//   lockfile versions that moved without a direct dependency changing.
// Size and spread (lines, files, areas) are always returned separately in `size`.
//
// Rules worth knowing:
// - Assets (images, fonts, media) and generated files are left out of the line count; lockfiles
//   are counted on their own. Release-note folders (`.changeset/` and similar) are ignored.
// - Dependencies are compared as parsed manifests (before and after), so a package's own
//   `"version"` field never counts, and neither does a package of this repository (a workspace
//   package, found by name across every package.json at head, or a `workspace:`/`file:`/`link:`
//   spec): "Version Packages" releases stay quiet.
// - Lockfiles count when they change a direct dependency (bun.lock workspaces, pnpm-lock.yaml
//   importers, package-lock.json workspace entries), e.g. `next 15.5.21 → 15.5.24 (bun.lock)`.
//   Resolved versions that moved on their own (transitive packages, `latest` specs, lockfiles that
//   don't record direct dependencies) are an `info` line, not a flag.
// - Fragile file: a changed, non-test file whose share of fix/revert commits (subject starts with
//   `fix`, `fix(scope):`, `fix!:` or `Revert "`) over the 90 days before the merge base is at least
//   FRAGILE_SHARE, with at least FRAGILE_MIN_COMMITS commits in that window and FRAGILE_MIN_FIXES
//   of them fixes. Calibrated on the GitLanes clone (2026-10-17): the highest non-test share was
//   0.44 (renderer/lanes.js, 4 of 9), git.js 0.26 (11 of 43) and app.js 0.21 (27 of 128), so 0.5
//   keeps all of them quiet while a file that's fixed in half of its recent commits still shows.
//   Test files are left out: fixes add regression tests, which says nothing about the test.

const git = require('./git');

const FRAGILE_SHARE = 0.5;
const FRAGILE_MIN_COMMITS = 6;
const FRAGILE_MIN_FIXES = 3;
const FRAGILE_DAYS = 90;
const MAX_DETAILS = 8;

const IGNORED = /^(\.changeset|\.changes|changelog\.d|newsfragments)\//;
const ASSET = /\.(svg|png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|heic|psd|pdf|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|webm|wav|ogg)$/i;
const GENERATED = /(\.min\.(js|css)|\.map|\.snap|\.pb\.go|[._]generated\.[^/]+)$|(^|\/)(__snapshots__|dist)\//;
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/;
const MANIFEST = /(^|\/)(package\.json|composer\.json|go\.mod|Cargo\.toml|pyproject\.toml|Gemfile|requirements[^/]*\.(txt|in))$/;
const CI = /^\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|^\.circleci\/|(^|\/)Dockerfile[^/]*$|(^|\/)[^/]+\.Dockerfile$|(^|\/)(GNU)?[Mm]akefile$|\.tf$/;
const TEST = /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const SKIP = /\.skip\(|\bxit\(|\bxdescribe\(|\.todo\(|@Ignore\b|pytest\.mark\.skip|\{\s*skip\s*:|@unittest\.skip|\bt\.Skip\(/;
const AREA_ROOTS = new Set(['apps', 'packages', 'libs', 'services', 'crates', 'modules', 'plugins', 'tools']);
const FIX = /^(fix(\(|:|!)|Revert ")/;

const isTest = (p) => TEST.test(p);
const area = (p) => {
  const parts = p.split('/');
  if (parts.length === 1) return '.';
  return AREA_ROOTS.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
};

// ---------------------------------------------------------------------------
// Parsing git's output

// "apps/{a => b}/x.js" or "a => b": the old and the new path.
function renamePaths(p) {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (brace) return [brace[1] + brace[2] + brace[4], brace[1] + brace[3] + brace[4]].map((x) => x.replace(/\/\//g, '/'));
  const plain = /^(.*) => (.*)$/.exec(p);
  return plain ? [plain[1], plain[2]] : [p, p];
}

// `git diff --numstat`: [{ path, from, added, deleted, binary }] (`from` is the old path of a rename)
function parseNumstat(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [a, d, ...rest] = line.split('\t');
    const binary = a === '-';
    const [from, path] = renamePaths(rest.join('\t'));
    return { path, from, added: binary ? 0 : +a, deleted: binary ? 0 : +d, binary };
  });
}

// `git diff --summary`: created, deleted and mode-changed paths.
function parseSummary(text) {
  const out = { created: new Map(), deleted: new Set(), modes: [] };
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^ create mode (\d+) (.+)$/.exec(line))) out.created.set(m[2], m[1]);
    else if ((m = /^ delete mode \d+ (.+)$/.exec(line))) out.deleted.add(m[1]);
    else if ((m = /^ mode change (\d+) => (\d+) (.+)$/.exec(line))) out.modes.push({ path: m[3], from: m[1], to: m[2] });
  }
  return out;
}

// A unified diff, split per file: [{ path, hunks: [{ header, lines }] }] (lines keep their +/-/space).
function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      file = { path: m ? m[1] : '', hunks: [] };
      files.push(file);
      hunk = null;
    } else if (!file) continue;
    else if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') file.path = line.slice(6); }
    else if (line.startsWith('@@')) { hunk = { header: line.replace(/^@@[^@]*@@ ?/, ''), lines: [] }; file.hunks.push(hunk); }
    else if (hunk && /^[ +-]/.test(line)) hunk.lines.push(line);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Dependencies: manifests

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const LOCAL_SPEC = /^(workspace|file|link|portal):/;

function jsonDeps(text, sections) {
  const out = new Map();
  if (!text) return out;
  let json;
  try { json = JSON.parse(text); } catch { return out; }
  for (const s of sections) {
    const deps = json?.[s];
    if (deps && typeof deps === 'object') for (const [k, v] of Object.entries(deps)) out.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return out;
}

function goModDeps(text) {
  const out = new Map();
  let block = false;
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === 'require (') { block = true; continue; }
    if (block && line === ')') { block = false; continue; }
    const m = block ? /^(\S+)\s+(\S+)$/.exec(line) : /^require\s+(\S+)\s+(\S+)$/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

// Cargo.toml and pyproject.toml: `key = value` lines inside dependency tables, plus PEP 621
// `dependencies = [...]` arrays. Values are compared as written, whitespace collapsed.
const pep508 = (s) => { const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(s); return m ? [m[1].toLowerCase(), m[3].trim() || '*'] : null; };
function tomlDeps(text) {
  const out = new Map();
  let section = '';
  let table = null; // [dependencies.serde]
  let array = false;
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const head = /^\[+([^\]]+)\]+$/.exec(line);
    if (head) {
      section = head[1].trim();
      array = false;
      const t = /^(?:.*\.)?(?:dev-|build-)?dependencies\.([^.]+)$/.exec(section);
      table = t ? t[1].replace(/"/g, '') : null;
      continue;
    }
    if (array) {
      for (const m of line.matchAll(/["']([^"']+)["']/g)) { const d = pep508(m[1]); if (d) out.set(d[0], d[1]); }
      if (line.includes(']')) array = false;
      continue;
    }
    const kv = /^("?[^"=\s]+"?)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    const value = kv[2].replace(/\s+/g, ' ');
    if (table) { if (key === 'version') out.set(table, value.replace(/"/g, '')); continue; }
    const depTable = /(^|\.)(dev-|build-)?dependencies$/.test(section) || /^tool\.poetry\.(group\.[^.]+\.)?(dev-)?dependencies$/.test(section);
    const pepArray = (section === 'project' && key === 'dependencies') || section === 'project.optional-dependencies';
    if (pepArray && value.startsWith('[')) {
      for (const m of value.matchAll(/["']([^"']+)["']/g)) { const d = pep508(m[1]); if (d) out.set(d[0], d[1]); }
      array = !value.includes(']');
    } else if (depTable) {
      const v = /^\{.*\bversion\s*=\s*"([^"]+)"/.exec(value);
      out.set(key, v ? v[1] : value.replace(/^"(.*)"$/, '$1'));
    }
  }
  return out;
}

function requirementsDeps(text) {
  const out = new Map();
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || /^[#-]/.test(line)) continue;
    const d = pep508(line.split(';')[0]);
    if (d) out.set(d[0], d[1]);
  }
  return out;
}

function gemfileDeps(text) {
  const out = new Map();
  for (const line of (text || '').split('\n')) {
    const m = /^\s*gem\s+['"]([^'"]+)['"]((?:\s*,\s*['"][^'"]*['"])*)/.exec(line);
    if (m) out.set(m[1], [...m[2].matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1]).join(', ') || '*');
  }
  return out;
}

function manifestDeps(file, text) {
  const base = file.split('/').pop();
  if (base === 'package.json') return jsonDeps(text, NPM_SECTIONS);
  if (base === 'composer.json') return jsonDeps(text, ['require', 'require-dev']);
  if (base === 'go.mod') return goModDeps(text);
  if (base === 'Cargo.toml' || base === 'pyproject.toml') return tomlDeps(text);
  if (base === 'Gemfile') return gemfileDeps(text);
  return requirementsDeps(text);
}

// Names of this repository's own packages: every package.json "name" given, plus the names in the
// changed package.json files themselves.
function internalNames(internal, manifests) {
  const names = new Set(internal || []);
  for (const [p, { before, after }] of Object.entries(manifests || {})) {
    if (!p.endsWith('package.json')) continue;
    for (const t of [before, after]) { try { const n = JSON.parse(t || '{}').name; if (n) names.add(n); } catch { /* not JSON */ } }
  }
  return names;
}

function diffMaps(before, after, file, isInternal) {
  const out = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(name);
    const b = after.get(name);
    if (a === b || isInternal(name, a) || isInternal(name, b)) continue;
    out.push({ name, from: a ?? null, to: b ?? null, file });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies: lockfiles. Returns { direct: [{ name, from, to }], resolved: [...] } from the
// changed lines of one lockfile.

function lockChanges(file, hunks) {
  const base = file.split('/').pop();
  const direct = { removed: new Map(), added: new Map() };
  const resolved = { removed: new Map(), added: new Map() };
  const put = (side, sign, name, version) => {
    if (!name || !version) return;
    const map = sign === '-' ? side.removed : side.added;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(version);
  };
  for (const h of hunks) {
    let section = /^([A-Za-z]\w*):/.exec(h.header)?.[1] || '';
    let key = null; // the entry a following version line belongs to
    let block = null; // package-lock.json: the dependency block of a workspace entry
    for (const raw of h.lines) {
      const sign = raw[0];
      const line = raw.slice(1);
      let m;
      if (base === 'bun.lock') {
        if ((m = /^\s+"([^"]+)":\s*\["((?:@[^"@/]+\/)?[^"@]+)@([^"]+)"/.exec(line))) { if (sign !== ' ') put(resolved, sign, m[1], m[3]); }
        else if ((m = /^\s{6,}"([^"]+)":\s*"([^"]*)",?$/.exec(line)) && !['name', 'version'].includes(m[1])) { if (sign !== ' ') put(direct, sign, m[1], m[2]); }
      } else if (base === 'pnpm-lock.yaml') {
        if ((m = /^([A-Za-z]\w*):/.exec(line))) { section = m[1]; continue; }
        if (section === 'importers') {
          if ((m = /^\s{6}'?([^'\s:][^'\s]*?)'?:\s*$/.exec(line))) key = m[1];
          else if ((m = /^\s+specifier:\s*'?([^'\s]+)'?/.exec(line)) && sign !== ' ') put(direct, sign, key, m[1]);
        } else if ((m = /^\s{2}'?\/?(@?[^@\s'/]+(?:\/[^@\s'/]+)?)@([^(:'\s]+)/.exec(line)) && sign !== ' ') put(resolved, sign, m[1], m[2]);
      } else if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
        if ((m = /^ {4}"([^"]*)": \{/.exec(line))) { key = m[1]; block = null; continue; }
        if ((m = /^ {6}"(dependencies|devDependencies|peerDependencies|optionalDependencies)": \{/.exec(line))) { block = m[1]; continue; }
        if (/^ {6}\}/.test(line)) { block = null; continue; }
        if (sign === ' ' || key == null) continue;
        if (key.startsWith('node_modules/') || key.includes('/node_modules/')) {
          if ((m = /^ {6}"version": "([^"]+)"/.exec(line))) put(resolved, sign, key.replace(/^.*node_modules\//, ''), m[1]);
        } else if (block && (m = /^ {8}"([^"]+)": "([^"]*)"/.exec(line))) put(direct, sign, m[1], m[2]);
      } else if (base === 'go.sum') {
        if ((m = /^(\S+) (v[^\s/]+)(\/go\.mod)? h1:/.exec(line)) && sign !== ' ') put(resolved, sign, m[1], m[2]);
      } else if (base === 'Gemfile.lock') {
        if ((m = /^ {4}([\w.-]+) \(([^)]+)\)$/.exec(line)) && sign !== ' ') put(resolved, sign, m[1], m[2]);
      } else if (base === 'yarn.lock') {
        if ((m = /^"?(@?[^@\s"]+)@/.exec(line))) key = m[1];
        else if ((m = /^\s+version:? "?([^"\s]+)"?/.exec(line)) && sign !== ' ') put(resolved, sign, key, m[1]);
      } else {
        // Cargo.lock, poetry.lock, uv.lock, composer.lock: a name line, then a version line.
        if ((m = /^\s*"?name"?\s*[=:]\s*"([^"]+)"/.exec(line))) key = m[1];
        else if ((m = /^\s*"?version"?\s*[=:]\s*"([^"]+)"/.exec(line)) && sign !== ' ') put(resolved, sign, key, m[1]);
      }
    }
  }
  const pairs = (side) => [...new Set([...side.removed.keys(), ...side.added.keys()])].flatMap((name) => {
    const a = [...(side.removed.get(name) || [])].sort();
    const b = [...(side.added.get(name) || [])].sort();
    if (a.join() === b.join()) return [];
    return [{ name, from: a.join(', ') || null, to: b.join(', ') || null, file }];
  });
  return { direct: pairs(direct), resolved: pairs(resolved) };
}

const describeDep = (d) => (d.from == null ? `${d.name} ${d.to} added (${d.file})` : d.to == null ? `${d.name} ${d.from} removed (${d.file})` : `${d.name} ${d.from} → ${d.to} (${d.file})`);

const listed = (items) => (items.length > MAX_DETAILS ? [...items.slice(0, MAX_DETAILS), `and ${items.length - MAX_DETAILS} more`] : items);

// ---------------------------------------------------------------------------
// Fragile files

// history: [{ subject, files }] for the 90 days before the merge base (git log --name-only).
function fragileFiles(history, paths) {
  const want = new Set(paths.filter((p) => !isTest(p)));
  const stats = new Map();
  for (const c of history) {
    const fix = FIX.test(c.subject);
    for (const f of new Set(c.files)) {
      if (!want.has(f)) continue;
      const s = stats.get(f) || { commits: 0, fixes: 0 };
      s.commits++;
      if (fix) s.fixes++;
      stats.set(f, s);
    }
  }
  return [...stats].filter(([, s]) => s.commits >= FRAGILE_MIN_COMMITS && s.fixes >= FRAGILE_MIN_FIXES && s.fixes / s.commits >= FRAGILE_SHARE)
    .map(([path, s]) => ({ path, ...s, share: Math.round((s.fixes / s.commits) * 100) / 100 }))
    .sort((a, b) => b.share - a.share || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Facts from git's output (pure, so the tests can feed recorded fixtures).
//   numstat, summary, patch: `git diff --numstat`, `--summary` and the patch of the same range
//   manifests: { [path]: { before, after } } for changed manifests ('' when missing)
//   internal: names of this repository's own packages
//   history: see fragileFiles

function analyze({ numstat = '', summary = '', patch = '', manifests = {}, internal = [], history = [] }) {
  const sum = parseSummary(summary);
  const files = parseNumstat(numstat).filter((f) => !IGNORED.test(f.path));
  const paths = files.map((f) => f.path);
  const facts = [];
  const flag = (id, title, details, extra = {}) => facts.push({ id, level: 'flag', title, details: listed(details), ...extra });
  const info = (id, title, details = [], extra = {}) => facts.push({ id, level: 'info', title, details: listed(details), ...extra });

  // Size and spread
  const size = { files: files.length, added: 0, deleted: 0, lines: 0, areas: [], lockfiles: [], assets: 0, generated: 0 };
  const areas = new Map();
  for (const f of files) {
    if (LOCKFILE.test(f.path)) { size.lockfiles.push({ path: f.path, added: f.added, deleted: f.deleted }); continue; }
    if (ASSET.test(f.path)) { size.assets++; continue; }
    if (GENERATED.test(f.path)) { size.generated++; continue; }
    size.added += f.added;
    size.deleted += f.deleted;
    const a = areas.get(area(f.path)) || { area: area(f.path), files: 0, lines: 0 };
    a.files++;
    a.lines += f.added + f.deleted;
    areas.set(a.area, a);
  }
  size.lines = size.added + size.deleted;
  size.areas = [...areas.values()].sort((a, b) => b.lines - a.lines || a.area.localeCompare(b.area));

  // Dependencies
  const names = internalNames(internal, manifests);
  const isInternal = (name, spec) => names.has(name) || (spec != null && LOCAL_SPEC.test(spec));
  const deps = [];
  for (const p of paths.filter((x) => MANIFEST.test(x))) {
    const m = manifests[p] || {};
    deps.push(...diffMaps(manifestDeps(p, m.before), manifestDeps(p, m.after), p, isInternal));
  }
  const drift = [];
  const patchFiles = parsePatch(patch).filter((f) => !IGNORED.test(f.path));
  for (const f of patchFiles.filter((x) => LOCKFILE.test(x.path))) {
    const { direct, resolved } = lockChanges(f.path, f.hunks);
    for (const d of direct) if (!isInternal(d.name, d.from) && !isInternal(d.name, d.to)) deps.push(d);
    for (const d of resolved) if (!isInternal(d.name, d.from) && !isInternal(d.name, d.to) && !deps.some((x) => x.name === d.name)) drift.push(d);
  }
  if (deps.length) flag('dependencies', 'Dependencies changed', deps.map(describeDep), { paths: [...new Set(deps.map((d) => d.file))] });

  // CI or build config
  const ci = paths.filter((p) => CI.test(p));
  if (ci.length) flag('ci', 'CI or build config changed', ci, { paths: ci });

  // Tests
  const deletedTests = paths.filter((p) => isTest(p) && sum.deleted.has(p));
  if (deletedTests.length) flag('tests-deleted', 'Test files deleted', deletedTests, { paths: deletedTests });
  const skips = [];
  for (const f of patchFiles.filter((x) => isTest(x.path))) {
    for (const h of f.hunks) for (const l of h.lines) if (l[0] === '+' && SKIP.test(l)) skips.push(`${f.path}: ${l.slice(1).trim().slice(0, 120)}`);
  }
  if (skips.length) flag('tests-skipped', 'Tests skipped', skips, { paths: [...new Set(skips.map((s) => s.split(': ')[0]))] });

  // Mode changes and binaries
  const modes = sum.modes.filter((m) => !IGNORED.test(m.path));
  if (modes.length) flag('modes', 'File mode changed', modes.map((m) => `${m.path} ${m.from} → ${m.to}`), { paths: modes.map((m) => m.path) });
  const binaries = files.filter((f) => f.binary && !ASSET.test(f.path) && !GENERATED.test(f.path)).map((f) => f.path);
  if (binaries.length) flag('binaries', 'Binary files changed', binaries, { paths: binaries });

  // Fragile files
  const fragile = fragileFiles(history, paths.filter((p) => !sum.deleted.has(p)));
  if (fragile.length) flag('fragile', 'Often-fixed files changed', fragile.map((f) => `${f.path}: ${f.fixes} of ${f.commits} commits in ${FRAGILE_DAYS} days were fixes`), { paths: fragile.map((f) => f.path) });

  // Neutral details
  const tests = paths.filter(isTest);
  if (tests.length) info('tests-changed', `${tests.length} test ${tests.length === 1 ? 'file' : 'files'} changed`, tests, { count: tests.length, paths: tests });
  else info('tests-changed', 'tests: none changed', [], { count: 0 });
  const deleted = paths.filter((p) => sum.deleted.has(p) && !isTest(p));
  if (deleted.length) info('deleted', `${deleted.length} ${deleted.length === 1 ? 'file' : 'files'} deleted`, deleted, { paths: deleted });
  if (drift.length) info('lockfile-drift', 'Locked versions moved', drift.map(describeDep), { paths: [...new Set(drift.map((d) => d.file))] });

  return { size, facts };
}

// ---------------------------------------------------------------------------
// From a repository. Cached per (merge base, head): the same pair always gives the same facts.

const cache = new Map();
const CACHE_MAX = 200;

async function readBlobs(root, specs) {
  if (!specs.length) return [];
  const out = await git.run(root, ['cat-file', '--batch'], { input: specs.join('\n') + '\n', encoding: 'buffer' });
  const blobs = [];
  let i = 0;
  for (let n = 0; n < specs.length; n++) {
    const nl = out.indexOf(10, i);
    const head = out.subarray(i, nl).toString();
    if (/ missing$/.test(head)) { blobs.push(''); i = nl + 1; continue; }
    const len = +head.split(' ')[2];
    blobs.push(out.subarray(nl + 1, nl + 1 + len).toString('utf8'));
    i = nl + 1 + len + 1;
  }
  return blobs;
}

async function changeFacts(root, base, head) {
  const [baseSha, headSha] = (await git.run(root, ['rev-parse', `${base}^{commit}`, `${head}^{commit}`])).trim().split('\n');
  const key = `${baseSha}..${headSha}`;
  if (cache.has(key)) return cache.get(key);
  const mergeBase = (await git.run(root, ['merge-base', baseSha, headSha], { allowCodes: [0, 1] })).trim();
  if (!mergeBase) throw new git.GitError('These branches have no common history.');
  const range = [mergeBase, headSha];
  const diff = (...args) => git.run(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', ...args, ...range]);
  const [numstat, summary] = await Promise.all([diff('--numstat'), diff('--summary')]);
  const changed = parseNumstat(numstat).filter((f) => !IGNORED.test(f.path));
  const paths = changed.map((f) => f.path);
  const oldPath = new Map(changed.map((f) => [f.path, f.from]));
  // The patch is only read for files whose content matters (lockfiles and tests). A rename needs
  // both sides in the pathspec, or git shows the new path as a whole added file.
  const patched = paths.filter((p) => LOCKFILE.test(p) || isTest(p)).flatMap((p) => [...new Set([oldPath.get(p), p])]);
  const manifestPaths = paths.filter((p) => MANIFEST.test(p));
  const [patch, manifestBlobs, tree, baseTime] = await Promise.all([
    patched.length ? diff('-U3', '--', ...patched.map((p) => `:(literal)${p}`)) : '',
    readBlobs(root, manifestPaths.flatMap((p) => [`${mergeBase}:${oldPath.get(p)}`, `${headSha}:${p}`])),
    git.run(root, ['ls-tree', '-r', '--name-only', '-z', headSha]),
    git.run(root, ['log', '-1', '--format=%ct', mergeBase]),
  ]);
  const manifests = {};
  manifestPaths.forEach((p, i) => { manifests[p] = { before: manifestBlobs[2 * i], after: manifestBlobs[2 * i + 1] }; });
  const pkgs = tree.split('\0').filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)node_modules\//.test(p)).slice(0, 2000);
  const internal = (await readBlobs(root, pkgs.map((p) => `${headSha}:${p}`))).flatMap((t) => { try { const n = JSON.parse(t).name; return n ? [n] : []; } catch { return []; } });
  // Fragility is about the files before this change, so the branch's own commits don't count.
  const history = await recentHistory(root, mergeBase, +baseTime.trim(), paths.filter((p) => !isTest(p)));
  const result = { base: baseSha, head: headSha, mergeBase, ...analyze({ numstat, summary, patch, manifests, internal, history }) };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

async function recentHistory(root, tip, tipTime, paths) {
  if (!paths.length) return [];
  const since = new Date((tipTime - FRAGILE_DAYS * 86400) * 1000).toISOString();
  const out = await git.run(root, ['-c', 'core.quotePath=false', 'log', '--no-merges', `--since=${since}`, '--format=%x1e%s', '--name-only', tip, '--', ...paths.map((p) => `:(literal)${p}`)]);
  return out.split('\x1e').filter((c) => c.trim()).map((c) => {
    const [subject, ...files] = c.split('\n');
    return { subject, files: files.filter(Boolean) };
  });
}

module.exports = {
  changeFacts, analyze, fragileFiles, parseNumstat, parseSummary, parsePatch, lockChanges, manifestDeps,
  FRAGILE_SHARE, FRAGILE_MIN_COMMITS, FRAGILE_MIN_FIXES, FRAGILE_DAYS,
  _clearCache: () => cache.clear(),
};
