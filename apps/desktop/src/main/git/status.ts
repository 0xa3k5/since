import fs from 'node:fs';
import path from 'node:path';
import { run, W_ENV } from './run.ts';
import type { DiffLine, FileDiff, Hunk, OperationInfo, OperationKind, StatusEntry, WorkStatus } from '../../shared/git-types.ts';

// Working copy

// `paths` limits it to those files.
export async function getStatus(cwd: string, paths?: readonly string[] | null): Promise<WorkStatus> {
  const out = await run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all', ...(paths ? ['--', ...paths] : [])], paths ? { env: W_ENV } : {});
  const staged: StatusEntry[] = [], unstaged: StatusEntry[] = [], conflicts: StatusEntry[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    const t = line[0];
    if (t === '1') {
      const f = line.split(' ');
      const xy = f[1] ?? '..', sub = f[2] ?? '';
      const p = f.slice(8).join(' ');
      if (xy[0] !== '.') staged.push({ path: p, status: xy.charAt(0) });
      // `inside`: a submodule whose checked-out commit is unchanged, only its own files.
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy.charAt(1), ...(sub[0] === 'S' && sub[1] === '.' && { inside: true as const }) });
    } else if (t === '2') {
      const f = line.split(' ');
      const xy = f[1] ?? '..';
      const p = f.slice(9).join(' ');
      const orig = parts[++i];
      if (xy[0] !== '.') staged.push({ path: p, oldPath: orig, status: xy.charAt(0) });
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy.charAt(1) });
    } else if (t === 'u') {
      const f = line.split(' ');
      conflicts.push({ path: f.slice(10).join(' '), status: 'U', xy: f[1] });
    } else if (t === '?') {
      unstaged.push({ path: line.slice(2), status: '?' });
    }
  }
  return { staged, unstaged, conflicts };
}

export async function getOperationState(gitDir: string): Promise<OperationKind | null> {
  const exists = (p: string) => fs.existsSync(path.join(gitDir, p));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  return null;
}

// What the stopped operation is doing, to name it (AK-584). merge: `from` merging into `branch`;
// cherry-pick/revert: the commit (`sha`, `subject`); rebase: `branch` onto `onto`, at `step` of
// `total`, on `subject`. null when nothing is stopped.
export async function getOperationInfo(cwd: string, gitDir: string): Promise<OperationInfo | null> {
  const op = await getOperationState(gitDir);
  if (!op) return null;
  const read = (p: string) => { try { return fs.readFileSync(path.join(gitDir, p), 'utf8').trim(); } catch { return ''; } };
  const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');
  const subjectOf = async (sha: string) => (sha ? (await run(cwd, ['log', '-1', '--format=%s', sha, '--']).catch(() => '')).trim() : '');
  // A branch whose tip is `sha` names it better than the sha itself.
  const nameOf = async (sha: string) => {
    const out = await run(cwd, ['for-each-ref', '--points-at', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']).catch(() => '');
    const ref = out.split('\n').find((r) => r && !r.endsWith('/HEAD'));
    return ref ? short(ref) : sha.slice(0, 7);
  };
  const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  if (op === 'merge') {
    const sha = read('MERGE_HEAD').split('\n')[0] ?? '';
    const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG'));
    return { op, branch, from: m?.[1] ?? await nameOf(sha), sha };
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

/** The file a working diff is for: its path, porcelain status, and the path before a rename. */
export interface DiffTarget { path: string; status?: string; oldPath?: string | null | undefined }

export async function workingDiff(cwd: string, file: DiffTarget, { staged }: { staged?: boolean }): Promise<FileDiff | null> {
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

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null, hunk: Hunk | null = null, oldNo = 0, newNo = 0;
  for (const l of text.split('\n')) {
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
      const [, oldStart = '', oldLines, newStart = '', newLines, context = ''] = m;
      hunk = { header: l, oldStart: +oldStart, oldLines: oldLines == null ? 1 : +oldLines, newStart: +newStart, newLines: newLines == null ? 1 : +newLines, context: context.trim(), lines: [] };
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
export function buildPartialPatch(fileDiff: Pick<FileDiff, 'header' | 'hunks'>, selected: Iterable<string>, mode: 'stage' | 'reverse'): string | null {
  const sel = new Set(selected); // keys "h:i"
  const out: string[] = [];
  for (const h of fileDiff.header) {
    if (h.startsWith('diff --git') || h.startsWith('---') || h.startsWith('+++') || h.startsWith('new file') || h.startsWith('deleted file') || h.startsWith('index ') || h.startsWith('old mode') || h.startsWith('new mode')) out.push(h);
  }
  // Ensure ---/+++ present (always true for text diffs).
  let any = false;
  fileDiff.hunks.forEach((h, hi) => {
    const body: string[] = [];
    let oldCount = 0, newCount = 0, changed = false;
    h.lines.forEach((ln: DiffLine, li) => {
      const isSel = sel.has(`${hi}:${li}`);
      const push = (t: DiffLine['t'], s: string, noEol: boolean | undefined) => {
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

export async function applyPatch(cwd: string, patch: string, { cached, reverse }: { cached?: boolean; reverse?: boolean }): Promise<void> {
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (cached) args.push('--cached');
  if (reverse) args.push('-R');
  args.push('-');
  await run(cwd, args, { input: patch, env: { GIT_OPTIONAL_LOCKS: '1' } });
}
