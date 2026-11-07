import { h, $, icon, kbd, loading, VirtualList, timeAgo, fullDate, avatar, avatarStack } from '../lib/ui.ts';
import { paint, graphWidth, laneColor, readPalette } from './graph.ts';
import { statusBadge, fileName } from '../commit/diff.js';
import { rowDoubleClick } from './keys.js';
import * as keymap from '../palette/keymap.ts';
import { markdown } from '../lib/markdown.ts';
import { up } from '../lib/upcalls.ts';
import { state, ROW_H, isEditable, prop, personLink } from '../lib/app-helpers.ts';
import { mapView, sidebarEl, lanesPage } from '../shell/shell.ts';
import { git } from '../lib/bridge.ts';
import { wantDetails, refPill } from './load.js';
import { withHistoryMenu } from '../history/file-history.js';
import { openQuick } from './quick-view.js';

// Map view

const commitCache = new Map();
async function loadCommit(sha) {
  if (commitCache.has(sha)) return commitCache.get(sha);
  const p = git('commit', sha);
  commitCache.set(sha, p);
  if (commitCache.size > 300) commitCache.delete(commitCache.keys().next().value);
  p.catch(() => commitCache.delete(sha));
  return p;
}

function selectCommit(sha, align = 'nearest') {
  if (!sha) return;
  state.selected = sha;
  if (mapView) mapView.select(sha, align);
}

function createMapView(container) {
  const wrap = h('div.map-wrap');
  const listWrap = h('div.map-list-wrap');
  // Double-click checks out a row, read off the second press (see rowDoubleClick).
  const dbl = rowDoubleClick();
  const scroller = h('div.map-list', { tabIndex: 0, onmousedown: (e) => dbl.listDown(e) });
  const canvas = h('canvas.graph-canvas');
  const detail = h('div.detail');
  listWrap.append(scroller, canvas);
  wrap.append(listWrap, detail);
  container.append(wrap);
  const ctx = canvas.getContext('2d');
  let results = null;
  let gw = graphWidth(state.graph.maxLanes);

  const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg-content').trim() || 'transparent';
  let bgColor = bg();
  let colors = readPalette();

  function rowFor(i) {
    const c = results ? results[i] : state.commits[i];
    const refs = state.byRef.get(c.sha) || [];
    const isSel = c.sha === state.selected;
    const pending = c.subject === null;
    if (pending) wantDetails(c.sha);
    const el = h('div.row' + (isSel ? '.selected' : '') + (c.sha === state.head.oid ? '.is-head' : '') + (pending ? '.pending' : ''), {
      onmousedown: (e) => {
        if (e.button !== 0) return;
        const hit = dbl.rowDown(e, c);
        if (results) { clearSearch(); select(c.sha, 'center'); } else select(c.sha);
        if (hit) up.checkoutSelected(hit, [e.clientX, e.clientY]);
      },
      oncontextmenu: (e) => { e.preventDefault(); select(c.sha); up.commitMenu(e.clientX, e.clientY, c); },
    },
      results ? null : h('span.graph-space', { style: { width: gw + 'px' } }),
      results ? h('span.result-dot', { style: { background: laneColor(state.graph, state.index.get(c.sha)) } }) : null,
      refs.length ? h('span.pills', null, refs.slice(0, 4).map(refPill), refs.length > 4 ? h('span.pill.more', null, `+${refs.length - 4}`) : null) : null,
      h('span.subject', null, pending ? '' : c.subject),
      pending ? h('span.meta', null, h('span.sha', null, c.sha.slice(0, 7))) : h('span.meta', null,
        c.coAuthors?.length ? avatarStack([{ name: c.author, email: c.email }, ...c.coAuthors].map(up.withProfile)) : avatar(c.author, c.email),
        h('span.author', null, c.author),
        h('span.sha', null, c.sha.slice(0, 7)),
        h('span.when', { title: fullDate(c.time) }, timeAgo(c.time)),
      ),
    );
    return el;
  }

  const vl = new VirtualList(scroller, {
    rowHeight: ROW_H,
    render: rowFor,
    onScroll: ({ first, last, top, height }) => {
      if (results) { canvas.style.display = 'none'; return; }
      canvas.style.display = '';
      const dpr = window.devicePixelRatio || 1;
      const w = gw, hh = height;
      if (canvas.width !== Math.ceil(w * dpr) || canvas.height !== Math.ceil(hh * dpr)) {
        canvas.width = Math.ceil(w * dpr); canvas.height = Math.ceil(hh * dpr);
        canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
      }
      paint(ctx, state.graph, { first, last, rowH: ROW_H, scrollTop: top, width: w, height: hh, headSha: state.head.oid, commits: state.commits, selected: state.selected, bg: bgColor, colors });
    },
  });

  function computeResults() {
    const q = state.search.trim().toLowerCase();
    if (!q) return null;
    const out = [];
    const refHit = new Set(state.refs.filter((r) => r.short.toLowerCase().includes(q)).map((r) => r.target));
    for (const c of state.commits) {
      if (c.sha.startsWith(q) || refHit.has(c.sha) || (c.subject !== null && (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)))) {
        out.push(c);
        if (out.length >= 2000) break;
      }
    }
    return out;
  }

  function refresh() {
    results = computeResults();
    gw = graphWidth(state.graph.maxLanes);
    bgColor = bg();
    colors = readPalette();
    listWrap.classList.toggle('searching', !!results);
    vl.setCount(results ? results.length : state.commits.length);
    shownGraph = state.graph;
    vl.layer.querySelector('.vl-empty')?.remove();
    if (results && !results.length) {
      vl.layer.append(h('div.vl-empty', null, `No commits match “${state.search}”`));
    }
    if (!state.commits.length && !results) {
      vl.layer.append(h('div.vl-empty', null, 'This repository has no commits yet. Make one in the Commit view.'));
    }
    renderDetail();
  }

  // More of the same history arrived: extend the list without re-rendering what is on screen.
  let shownGraph = null;
  function grow() {
    if (results || shownGraph !== state.graph) return refresh();
    const w = graphWidth(state.graph.maxLanes);
    if (w !== gw) { gw = w; vl.invalidate(); }
    vl.setCount(state.commits.length, { keep: true });
  }

  // Re-render rows that were drawn before their subject and author arrived.
  function refreshPending() {
    for (const [i, el] of vl.rows) {
      const c = results ? results[i] : state.commits[i];
      if (el.classList.contains('pending') && c && c.subject !== null) vl.refreshRow(i);
    }
  }

  function select(sha, align = 'nearest') {
    const prev = state.selected;
    state.selected = sha;
    if (!results) {
      const i = state.index.get(sha);
      const pi = state.index.get(prev);
      // Toggle the class, don't rebuild the rows: a rebuilt row under the pointer eats the double-click.
      if (pi != null) vl.rows.get(pi)?.classList.remove('selected');
      if (i != null) { vl.rows.get(i)?.classList.add('selected'); vl.scrollToIndex(i, align); }
      vl.schedule();
    }
    renderSidebarSelection();
    renderDetail();
  }

  function clearSearch() {
    state.search = '';
    const s = $('#map-search'); if (s) s.value = '';
    results = null;
    refresh();
  }

  let detailToken = 0;
  async function renderDetail() {
    wrap.classList.toggle('with-detail', state.detail && !!state.selected);
    if (!state.detail || !state.selected) { detail.replaceChildren(); return; }
    const sha = state.selected;
    const token = ++detailToken;
    const cached = commitCache.get(sha);
    if (!cached) {
      detail.classList.add('loading');
      detail.querySelector(':scope > .loading-state')?.remove();
      detail.prepend(loading('Loading commit…'));
    }
    let c;
    try { c = await loadCommit(sha); } catch (e) { detail.replaceChildren(h('div.empty', null, e.message)); return; }
    if (token !== detailToken) return;
    detail.classList.remove('loading');
    detail.replaceChildren(commitDetail(c));
  }

  scroller.addEventListener('keydown', (e) => {
    const list = results || state.commits;
    if (!list.length) return;
    const cur = results ? results.findIndex((c) => c.sha === state.selected) : state.index.get(state.selected) ?? -1;
    const move = (d) => { e.preventDefault(); const n = Math.max(0, Math.min(list.length - 1, cur + d)); select(list[n].sha); };
    const c = list[cur];
    const id = keymap.match('map', e);
    switch (id) {
      case 'commit.checkoutBranch': if (!isEditable(e.target)) { e.preventDefault(); if (c) up.checkoutSelected(c); } break;
      case 'map.copySha': if (!window.getSelection().toString()) { e.preventDefault(); up.copy(state.selected, 'Copied SHA'); } break;
      case 'map.copyLink': e.preventDefault(); up.copyCommitLink(state.selected); break;
      case 'map.next': move(1); break;
      case 'map.prev': move(-1); break;
      case 'map.pageDown': move(Math.floor(scroller.clientHeight / ROW_H)); break;
      case 'map.pageUp': move(-Math.floor(scroller.clientHeight / ROW_H)); break;
      case 'map.first': move(-list.length); break;
      case 'map.last': move(list.length); break;
      case 'map.quick': if (results) { clearSearch(); select(c.sha, 'center'); } else openQuick(state.selected); e.preventDefault(); break;
      case 'map.detail': e.preventDefault(); up.toggleDetail(); break;
      case 'map.clearSearch': if (results) clearSearch(); break;
      case 'map.head': if (state.head.oid) select(state.head.oid, 'center'); break;
      default: if (c && id) up.commitShortcut(e, id, c);
    }
  });

  refresh();
  // Read the selection on the frame: a jump right after this view opens (a sidebar PR or branch) has moved it by then.
  requestAnimationFrame(() => { const i = state.index.get(state.selected); if (i != null) vl.scrollToIndex(i, 'center'); });
  scroller.focus({ preventScroll: true });

  return {
    refresh,
    grow,
    refreshPending,
    lastVisible: () => (results ? 0 : vl.range().last),
    isVisible: (sha) => { const i = state.index.get(sha); return !results && i != null && vl.rows.has(i); },
    select,
    pickFirstResult: () => { if (results?.length) { const sha = results[0].sha; clearSearch(); select(sha, 'center'); scroller.focus(); } },
    focus: () => scroller.focus(),
    destroy: () => vl.destroy(),
  };
}

function renderSidebarSelection() {
  if (!sidebarEl) return;
  sidebarEl.querySelectorAll('.sb-item.selected-ref').forEach((el) => el.classList.remove('selected-ref'));
  if (sbWorktree && state.selected !== state.worktrees.find((w) => w.path === sbWorktree)?.head) selectWorktreeRow(null);
}

// The worktree row selected in the sidebar (by path). It lasts until a different commit is selected.
let sbWorktree = null;
function selectWorktreeRow(path) {
  sbWorktree = path;
  sidebarEl?.querySelectorAll('.sb-worktree').forEach((el) => el.classList.toggle('selected', el.dataset.path === path));
}
function selectWorktreeItem(w) {
  if (state.view === 'map' && w.head && state.index.has(w.head)) up.jumpTo(w.head);
  selectWorktreeRow(w.path);
  sidebarEl?.querySelector(`.sb-worktree[data-path="${CSS.escape(w.path)}"]`)?.focus({ preventScroll: true });
}

// open(path): Open and a file row (the commit on its own page, at that file); close: a × at the end
// of the actions, for Review's commit pane (commitSide).
function commitDetail(c, { open = (path) => openQuick(c.sha, path), close = null } = {}) {
  const refs = state.byRef.get(c.sha) || [];
  const [subject, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  const add = c.files.reduce((a, f) => a + f.add, 0), del = c.files.reduce((a, f) => a + f.del, 0);
  return h('div.detail-inner', null,
    h('div.detail-head', null,
      h('div.detail-actions', null,
        h('button.btn.subtle', { onclick: () => up.checkoutCommit(c) }, icon('checkout', 14), 'Checkout'),
        h('button.btn.subtle', { onclick: () => up.createBranch(c.sha) }, icon('branch', 14), 'Branch'),
        h('button.icon-btn', { title: 'More actions', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); up.commitMenu(r.left, r.bottom + 4, c); } }, icon('more')),
        close ? h('button.icon-btn.detail-close', { 'data-tip': 'Close', 'aria-label': 'Close', onclick: close }, icon('x')) : null,
      ),
      h('h2.detail-title', null, subject),
      refs.length ? h('div.pills.wrap', null, refs.map(refPill)) : null,
      body ? markdown(body, '.detail-body') : null,
    ),
    h('div.props', null,
      prop('Author', personLink(c.author, c.email)),
      c.coAuthors?.length ? prop('Co-authors', h('span.prop-people', null, c.coAuthors.map((p) => personLink(p.name, p.email)))) : null,
      c.committer !== c.author ? prop('Committer', personLink(c.committer, c.committerEmail)) : null,
      prop('Date', h('span', { title: fullDate(c.time) }, fullDate(c.time))),
      c.signature ? prop('Signature', signatureBadge(c.signature)) : null,
      prop('Commit', h('button.mono-link', { onclick: () => up.copy(c.sha, 'Copied SHA') }, c.sha.slice(0, 12), icon('copy', 12))),
      c.parents.length ? prop(c.parents.length > 1 ? 'Parents' : 'Parent', h('span.parents', null, c.parents.map((p) => h('button.mono-link', { onclick: () => up.go(() => selectCommit(p, 'center')) }, p.slice(0, 7))))) : null,
    ),
    h('div.files-head', null, h('span', null, `${c.files.length} file${c.files.length === 1 ? '' : 's'} changed`), h('span.stat', null, h('span.add', null, `+${add}`), h('span.del', null, `−${del}`)),
      h('button.btn.ghost.small', { onclick: () => open() }, 'Open', close ? null : kbd(...keymap.keys('map.quick')))),
    h('div.file-list', null, c.files.slice(0, 500).map((f) => withHistoryMenu(fileRow(f, () => open(f.path)), f))),
  );
}

// Review's commit pane (AK-640): the map's commit details on the right of `host` (Review's pane or the
// review page), over the diff. The same commit again, × or Esc closes it; mark(sha or null) follows it.
// Open shows just that commit's changes on a page of its own; Back (or Esc) returns to Review as it was.
function commitSide(host, sha, mark = () => {}) {
  const old = host.querySelector(':scope > .commit-side');
  old?.remove();
  if (old?.dataset.sha === sha) return mark(null);
  const close = () => { el.remove(); mark(null); };
  const back = () => ({ review: state.review, lanes: up.lanesOpen() ? lanesPage?.location() : null });
  const el = h('aside.detail.commit-side', { tabIndex: -1, 'data-sha': sha, 'aria-label': `Commit ${sha.slice(0, 7)}` }, loading('Loading commit…'));
  el.addEventListener('keydown', (e) => { if (keymap.match('review', e) === 'review.close' && !e.target.closest?.('input, textarea')) { e.preventDefault(); e.stopPropagation(); close(); } });
  loadCommit(sha).then((c) => { if (el.isConnected) el.replaceChildren(commitDetail(c, { open: (path) => openQuick(sha, path, back()), close })); },
    (e) => { if (el.isConnected) el.replaceChildren(h('div.empty', null, e.message)); });
  host.classList.add('commit-side-host');
  host.append(el);
  mark(sha);
}

const SIGNATURE_LABELS = { good: 'Verified', expired: 'Expired', revoked: 'Revoked', bad: 'Bad signature', unverified: 'Signed, not verified' };
const SIGNATURE_TIPS = { unverified: 'Signed, but the key is not in your keyring or allowed signers file' };
const signatureBadge = ({ state, signer }) => h(`span.sig-badge.sig-${state}`, { title: [SIGNATURE_TIPS[state], signer].filter(Boolean).join(' · ') || null },
  SIGNATURE_LABELS[state], signer ? h('span.sig-signer', null, signer) : null);

function fileRow(f, onclick, extra) {
  const [name, dir] = fileName(f.path);
  return h('div.file-row', { onclick, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path },
    statusBadge(f.status),
    h('span.fname', null, name),
    f.lfs ? up.lfsBadge() : null,
    h('span.fdir', null, dir),
    f.add != null && (f.add || f.del) ? h('span.stat.small', null, f.add ? h('span.add', null, '+' + f.add) : null, f.del ? h('span.del', null, '−' + f.del) : null) : null,
    extra || null,
  );
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { loadCommit, selectCommit, fileRow });

export { selectCommit, sbWorktree, selectWorktreeItem, commitSide, createMapView, loadCommit, fileRow, commitCache };
