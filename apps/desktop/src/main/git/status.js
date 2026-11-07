'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { run, W_ENV } = require('./run');

// Working copy

// `paths` limits it to those files.
async function getStatus(cwd, paths) {
  const out = await run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all', ...(paths ? ['--', ...paths] : [])], paths ? { env: W_ENV } : {});
  const staged = [], unstaged = [], conflicts = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    const t = line[0];
    if (t === '1') {
      const f = line.split(' ');
      const xy = f[1];
      const p = f.slice(8).join(' ');
      if (xy[0] !== '.') staged.push({ path: p, status: xy[0] });
      // `inside`: a submodule whose checked-out commit is unchanged, only its own files.
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy[1], ...(f[2][0] === 'S' && f[2][1] === '.' && { inside: true }) });
    } else if (t === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const p = f.slice(9).join(' ');
      const orig = parts[++i];
      if (xy[0] !== '.') staged.push({ path: p, oldPath: orig, status: xy[0] });
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy[1] });
    } else if (t === 'u') {
      const f = line.split(' ');
      conflicts.push({ path: f.slice(10).join(' '), status: 'U', xy: f[1] });
    } else if (t === '?') {
      unstaged.push({ path: line.slice(2), status: '?' });
    }
  }
  return { staged, unstaged, conflicts };
}

async function getOperationState(gitDir) {
  const exists = (p) => fs.existsSync(path.join(gitDir, p));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  return null;
}

// What the stopped operation is doing, to name it (AK-584). merge: `from` merging into `branch`;
// cherry-pick/revert: the commit (`sha`, `subject`); rebase: `branch` onto `onto`, at `step` of
// `total`, on `subject`. null when nothing is stopped.
async function getOperationInfo(cwd, gitDir) {
  const op = await getOperationState(gitDir);
  if (!op) return null;
  const read = (p) => { try { return fs.readFileSync(path.join(gitDir, p), 'utf8').trim(); } catch { return ''; } };
  const short = (ref) => ref.replace(/^refs\/(heads|remotes)\//, '');
  const subjectOf = async (sha) => (sha ? (await run(cwd, ['log', '-1', '--format=%s', sha, '--']).catch(() => '')).trim() : '');
  // A branch whose tip is `sha` names it better than the sha itself.
  const nameOf = async (sha) => {
    const out = await run(cwd, ['for-each-ref', '--points-at', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']).catch(() => '');
    const ref = out.split('\n').find((r) => r && !r.endsWith('/HEAD'));
    return ref ? short(ref) : sha.slice(0, 7);
  };
  const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  if (op === 'merge') {
    const sha = read('MERGE_HEAD').split('\n')[0];
    const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG'));
    return { op, branch, from: m ? m[1] : await nameOf(sha), sha };
  }
  if (op === 'cherry-pick' || op === 'revert') {
    const sha = read(op === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD');
    return { op, branch, sha, subject: await subjectOf(sha) };
  }
  const dir = fs.existsSync(path.join(gitDir, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
  const merge = dir === 'rebase-merge';
  const onto = read(`${dir}/onto`);
  const step = Number(read(merge ? `${dir}/msgnum` : `${dir}/next`)) || 0;
  const total = Number(read(merge ? `${dir}/end` : `${dir}/last`)) || 0;
  const stopped = read(`${dir}/stopped-sha`) || read(`${dir}/original-commit`);
  const subject = (merge ? read(`${dir}/message`).split('\n')[0] : '') || await subjectOf(stopped);
  return { op, branch: short(read(`${dir}/head-name`)) || branch, onto: onto ? await nameOf(onto) : '', step, total, subject };
}

async function workingDiff(cwd, file, { staged }) {
  if (file.status === '?') {
    const out = await run(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path], { allowCodes: [0, 1] });
    return parseDiff(out)[0] || null;
  }
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--cached', '-M');
  args.push('--', file.path);
  if (file.oldPath) args.push(file.oldPath);
  const out = await run(cwd, args);
  return parseDiff(out)[0] || null;
}

function parseDiff(text) {
  const files = [];
  let cur = null, hunk = null, oldNo = 0, newNo = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      cur = { header: [l], hunks: [], binary: false, oldPath: null, newPath: null };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (!hunk) {
      if (l.startsWith('--- ')) cur.oldPath = l.slice(4).replace(/^a\//, '');
      else if (l.startsWith('+++ ')) cur.newPath = l.slice(4).replace(/^b\//, '');
      else if (l.startsWith('Binary files')) cur.binary = true;
      if (!l.startsWith('@@')) { cur.header.push(l); continue; }
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(l);
      if (!m) continue;
      hunk = { header: l, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], context: m[5].trim(), lines: [] };
      oldNo = hunk.oldStart; newNo = hunk.newStart;
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = l[0];
    if (c === ' ') hunk.lines.push({ t: ' ', s: l.slice(1), o: oldNo++, n: newNo++ });
    else if (c === '-') hunk.lines.push({ t: '-', s: l.slice(1), o: oldNo++, n: null });
    else if (c === '+') hunk.lines.push({ t: '+', s: l.slice(1), o: null, n: newNo++ });
    else if (c === '\\') { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noEol = true; }
  }
  return files;
}

// Build a patch containing only the selected lines of a file diff.
// mode 'stage': applied forward to the index. Unselected '-' become context; unselected '+' vanish.
// mode 'reverse': applied with -R (unstage / discard). Unselected '+' become context; unselected '-' vanish.
function buildPartialPatch(fileDiff, selected, mode) {
  const sel = new Set(selected); // keys "h:i"
  const out = [];
  for (const h of fileDiff.header) {
    if (h.startsWith('diff --git') || h.startsWith('---') || h.startsWith('+++') || h.startsWith('new file') || h.startsWith('deleted file') || h.startsWith('index ') || h.startsWith('old mode') || h.startsWith('new mode')) out.push(h);
  }
  // Ensure ---/+++ present (always true for text diffs).
  let any = false;
  fileDiff.hunks.forEach((h, hi) => {
    const body = [];
    let oldCount = 0, newCount = 0, changed = false;
    h.lines.forEach((ln, li) => {
      const isSel = sel.has(`${hi}:${li}`);
      const push = (t, s, noEol) => {
        body.push(t + s);
        if (noEol) body.push('\\ No newline at end of file');
        if (t !== '+') oldCount++;
        if (t !== '-') newCount++;
      };
      if (ln.t === ' ') push(' ', ln.s, ln.noEol);
      else if (ln.t === '-') {
        if (isSel) { push('-', ln.s, ln.noEol); changed = true; }
        else if (mode === 'stage' && ln.noEol && h.lines.some((l, j) => j > li && l.t === '+' && sel.has(`${hi}:${j}`))) {
          // The old last line stays but gains a newline, so selected lines added after it don't join onto it.
          push('-', ln.s, true); push('+', ln.s, false); changed = true;
        } else if (mode === 'stage') push(' ', ln.s, ln.noEol);
      } else if (ln.t === '+') {
        if (isSel) { push('+', ln.s, ln.noEol); changed = true; }
        else if (mode === 'reverse') push(' ', ln.s, ln.noEol);
      }
    });
    if (!changed) return;
    any = true;
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`);
    out.push(...body);
  });
  return any ? out.join('\n') + '\n' : null;
}

async function applyPatch(cwd, patch, { cached, reverse }) {
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (cached) args.push('--cached');
  if (reverse) args.push('-R');
  args.push('-');
  await run(cwd, args, { input: patch, env: { GIT_OPTIONAL_LOCKS: '1' } });
}

module.exports = { getStatus, parseDiff, workingDiff, buildPartialPatch, applyPatch, getOperationState, getOperationInfo };
