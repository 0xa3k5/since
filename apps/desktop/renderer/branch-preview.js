import { h, icon, timeAgo, fullDate, tipFor, loading } from './ui.js';
import { ACTIONS, aheadBehind, laneActions, laneTitle, laneKey, conflictText, canRemove } from './lanes.js';
import { statusBadge, fileName } from './diff.js';

// A branch at a glance, shared by Review's Everything else and Branches (AK-396): the pane's head
// (title, badges, branch, upstream, ↑↓, worktree, its actions), predicted conflicts, its commits and
// the files it changes against the base, then the way in as a muted line.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Why a done lane counts as merged, for its badge's tooltip.
export function doneText(l) {
  const why = l.done.reason === 'pr' ? `Pull request #${l.done.pr} was merged`
    : l.done.reason === 'key' ? `${l.done.key} is on the base branch`
      : l.done.reason === 'subject' ? 'A commit with its title is on the base branch'
        : l.merged === 'ancestor' ? 'Already part of the base branch' : 'Its changes are already on the base branch';
  return l.changes ? `${why} · ${l.changes} uncommitted file${l.changes === 1 ? '' : 's'}` : why;
}

// The lane's small badges: Conflicts, Base, This window, Merged, Gone, Missing.
export function laneBadges(l) {
  return [
    l.conflicts ? h('span.badge.warn.lanes-conflict', { title: l.conflicts.map((c) => conflictText(c, 10)).join('\n') }, icon('warning', 11), 'Conflicts') : null,
    l.isBase ? h('span.badge', { title: 'The base branch' }, 'Base') : null,
    l.worktree?.current ? h('span.badge.local', { title: 'Open in this window' }, 'This window') : null,
    l.done ? h('span.badge', { title: doneText(l) }, 'Merged') : null,
    l.upstreamGone ? h('span.badge.warn', { title: 'Its upstream branch was deleted' }, 'Gone') : null,
    l.worktree?.prunable ? h('span.badge.warn', { title: 'The worktree folder no longer exists' }, 'Missing') : null,
  ];
}

// A lane action as a small button (lanes.js ACTIONS); onRun(id) runs it.
export function laneActionBtn(id, onRun, inline = true) {
  const a = ACTIONS[id];
  return h(inline ? 'button.btn.subtle.lanes-fix-btn' : 'button.btn.subtle.lanes-step', {
    'data-tip': tipFor(a.label, a.keyId), 'aria-label': a.label,
    onclick: (e) => { e.stopPropagation(); onRun(id); },
    ondblclick: (e) => e.stopPropagation(),
  }, icon(a.icon, 12), h('span.btn-label', null, a.label));
}

// The pane. lane: the lane; key: the row's key (data-key); git(method, ...args) reads the files it
// changes (cached per branch tip in `cache`, a Map); onRun(id, lane) runs an action. `keys` maps an
// action id to the keymap id its tooltip shows (Branches has its own keys); `remove` adds Delete
// (undoable) at the end of the actions.
export function branchPreview({ lane: l, key, base = null, git = null, cache = new Map(), onRun, keys = null, remove = false }) {
  const ab = aheadBehind(l);
  const ids = [...laneActions(l), ...(l.branch && !l.isBase && base ? ['rebase'] : []), ...(!l.isBase && (l.branch || l.head) ? ['review'] : []), ...(remove && canRemove(l) ? ['delete'] : [])]
    .filter((id, i, all) => all.indexOf(id) === i && (id !== 'discard') && (remove || id !== 'delete'));
  const btn = (id) => {
    const b = laneActionBtn(id, () => onRun(id, l));
    if (keys?.[id]) b.dataset.tip = tipFor(ACTIONS[id].label, keys[id]);
    if (id === 'delete') b.classList.add('danger-hover');
    return b;
  };
  const section = (label, ...body) => h('section.branch-preview-section', null, h('div.lanes-group', null, label), ...body);
  const files = h('div.branch-preview-files');
  const el = h('div.review-pane.branch-preview', { 'data-key': key },
    h('div.review-pane-head', null,
      h('div.review-pane-title', null, h('div.quick-title', { title: laneTitle(l) }, icon(l.worktree ? 'worktree' : 'branch', 14), ' ', laneTitle(l)), ...laneBadges(l)),
      h('div.quick-meta.review-pane-meta', null,
        h('span.mono', null, l.name),
        h('span', null, l.upstream || (l.detached ? 'Detached HEAD' : 'Local branch')),
        ab ? h('span', { title: base ? `Ahead/behind ${base}` : '' }, ab) : null,
        l.worktree ? h('span.mono', { title: l.worktree.path }, tildify(l.worktree.path)) : null),
      ids.length ? h('div.review-pane-actions', null, ...ids.map(btn)) : null),
    h('div.branch-preview-body', null,
      l.conflicts ? section('Predicted conflicts', ...l.conflicts.map((c) => h('div.review-detail.warn', { title: c.files.join('\n') }, conflictText(c)))) : null,
      l.isBase ? null : section(l.ahead != null ? `Commits not on ${base || 'the base'} · ${l.ahead}` : 'Commits',
        l.ahead === 0 ? h('div.review-none', null, 'Nothing here that isn’t on the base.')
          : h('div.branch-preview-commit', null, icon('commit', 13), h('span.lanes-name', { title: l.title || '' }, l.title || l.name), l.activity ? h('span.review-row-age', { title: fullDate(l.activity / 1000) }, timeAgo(l.activity / 1000)) : null),
        l.ahead > 1 ? h('div.review-none', null, `and ${plural(l.ahead - 1, 'older commit')}: R reviews them all`) : null),
      l.isBase ? h('div.review-none', null, 'This is the base branch.') : section('Changed files', files)));
  el.lane = l;
  if (!l.isBase && git && (l.branch || l.head)) {
    const id = `${laneKey(l)}@${l.head || ''}@${base || ''}`;
    const show = (list) => files.replaceChildren(...(list.length ? list.map((f) => {
      const [name, dir] = fileName(f.path);
      return h('div.file-row', { title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, statusBadge(f.status), h('span.fname', null, name), h('span.fdir', null, dir),
        f.add || f.del ? h('span.stat.small', null, f.add ? h('span.add', null, '+' + f.add) : null, f.del ? h('span.del', null, '−' + f.del) : null) : null);
    }) : [h('div.review-none', null, 'No changes against the base.')]));
    if (cache.has(id)) show(cache.get(id));
    else {
      files.replaceChildren(loading('Reading its changes…'));
      git('branchReview', l.branch || l.head, base || undefined)
        .then((res) => { cache.set(id, res.files); if (files.isConnected) show(res.files); })
        .catch((e) => files.replaceChildren(h('div.review-none', null, `Couldn’t read its changes: ${e.message}`)));
    }
  }
  return el;
}
