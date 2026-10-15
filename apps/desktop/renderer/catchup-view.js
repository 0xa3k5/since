import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast } from './ui.js';
import { landedEntries, groupLanded, sinceOptions, sinceText, countsText, TOP } from './catchup.js';
import * as keymap from './keymap.js';

// Review's catch-up card (AK-281), at the top of the list: where you're caught up to, counts for
// merged / stuck / ready to merge and the base's CI, what landed grouped by issue key or area, and
// three actions: Since… (⇧T), Walk through what landed (⇧↵) and Mark caught up (⇧C). The checkpoint
// lives in app data (main process) and only moves on Mark caught up, which Undo on its
// toast puts back. With PRs off it's git log alone.
//
// load(opts) → app:catchup; mark(to) → app:catchup-mark (returns the checkpoint it replaced);
// prsOn() reads the setting; onWalk() starts the walk-through (lanes-view.js); onChange() asks
// the list to re-render (the card's height changed).
const short = (s) => (s || '').slice(0, 7);
const ago = (ms) => timeAgo(ms / 1000);

export function catchupCard({ load, mark, prsOn, onWalk = () => {}, onChange = () => {} }) {
  const el = h('section.review-catchup-card', { 'aria-label': 'Catch up' });
  let res = null;
  let entries = [];
  let since = { since: 'checkpoint' };
  let counts = { stuck: 0, ready: 0 };
  let more = false;
  let failed = null;
  let seq = 0;
  let extra = null; // { merged, ci } from the last load with PRs, kept on local-only refreshes

  const btn = (label, keyId, onclick, cls = 'button.btn.subtle.small') => h(cls, { title: `${label.replace(/[ ↵▸…]+$/, '')} (${keymap.keys(keyId).join(' or ')})`, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label, kbd(...keymap.keys(keyId)));

  function render() {
    if (!res && !failed) return el.replaceChildren(h('div.muted.small', null, 'Catching up…'));
    if (failed) return el.replaceChildren(h('div.muted.small', null, `Couldn’t read what landed: ${failed}`));
    const head = sinceText(res, { short, ago });
    const c = countsText({ entries, stuck: counts.stuck, ready: counts.ready, prsOn: prsOn(), ci: res.ci, base: res.base });
    const groups = groupLanded(entries);
    const top = more ? groups : groups.slice(0, TOP);
    const sinceBtn = btn('Since… ', 'lanes.since', (e) => pickSince(e.currentTarget), 'button.btn.ghost.small.catchup-since');
    el.replaceChildren(...[
      h('div.catchup-head', null,
        h('span.catchup-title', { title: res.checkpoint?.at ? `Marked ${fullDate(res.checkpoint.at / 1000)}` : '' }, head.text),
        sinceBtn),
      head.warn ? h('div.catchup-warn', null, icon('warning', 12), head.warn) : null,
      h('div.catchup-counts', null,
        ...c.parts.map((p) => h('span', null, p)),
        c.ci ? h('span.catchup-ci.' + c.ci.state, null, h('span.pr-ci.' + c.ci.state, null, '●'), c.ci.text) : null),
      entries.length ? h('ul.catchup-groups', null,
        ...top.map((g) => h('li.catchup-group', { title: g.entries.map((e) => (e.kind === 'pr' ? `#${e.number} ${e.title}` : `${short(e.sha)} ${e.title}`)).join('\n') },
          h('span.badge' + (g.key ? '' : '.muted'), null, g.key || g.area),
          h('span.catchup-label', null, g.key ? g.label : `${g.entries.length} change${g.entries.length === 1 ? '' : 's'}`),
          g.entries.length > 1 && g.key ? h('span.muted', null, `· ${g.entries.length}`) : null)),
        groups.length > TOP ? h('li', null, h('button.btn.ghost.small.catchup-more', { onclick: (e) => { e.stopPropagation(); more = !more; render(); onChange(); } }, more ? 'Show fewer ▴' : `+${groups.length - TOP} more ▸`)) : null)
        : h('div.muted.small', null, `Nothing new on ${res.base}.`),
      res.truncated ? h('div.muted.small', null, `Showing the newest ${entries.length}.`) : null,
      h('div.catchup-actions', null,
        entries.length ? btn('Walk through', 'lanes.walk', () => onWalk(), 'button.btn.primary.small') : null,
        btn('Mark caught up', 'lanes.caughtUp', () => markCaughtUp())),
    ].filter(Boolean));
  }

  async function reload({ prs = false } = {}) {
    const n = ++seq;
    const withPrs = Boolean(prs && prsOn());
    try {
      const r = await load({ ...since, prs: withPrs });
      if (n !== seq) return;
      failed = null;
      if (withPrs) extra = r ? { merged: r.merged, ci: r.ci } : null;
      if (!prsOn()) extra = null;
      res = r && { ...r, ...(withPrs || !extra ? {} : extra) };
      entries = res ? landedEntries(res.commits, res.merged) : [];
      if (r?.prError) toast('Could not load merged pull requests', { kind: 'error', detail: r.prError.message });
    } catch (e) {
      if (n !== seq) return;
      failed = e.message;
    }
    if (!res && !failed) return el.replaceChildren(); // no base branch: no card
    render();
    onChange();
  }

  function pickSince(anchor = el.querySelector('.catchup-since')) {
    const r = anchor?.getBoundingClientRect() || { left: 0, bottom: 0 };
    const cur = since.since === 'tag' ? `tag:${since.tag}` : since.since;
    contextMenu(r.left, r.bottom, sinceOptions(res?.tags || []).map((o) => ({
      label: o.label, icon: (o.kind === 'tag' ? `tag:${o.tag}` : o.kind) === cur ? 'check' : undefined,
      run: () => { since = o.kind === 'tag' ? { since: 'tag', tag: o.tag } : { since: o.kind }; more = false; reload({ prs: true }); },
    })));
  }

  async function markCaughtUp() {
    if (!res) return;
    const to = { sha: res.baseSha, base: res.base, date: res.baseDate };
    try {
      const before = await mark(to);
      since = { since: 'checkpoint' };
      more = false;
      await reload({ prs: true });
      toast(`Caught up to ${short(to.sha)} on ${to.base}`, { kind: 'success', action: { label: 'Undo', run: async () => { await mark(before); reload({ prs: true }); } } });
    } catch (e) {
      toast('Couldn’t mark caught up', { kind: 'error', detail: e.message });
    }
  }

  // What the walk-through steps through: the merged PRs, or the commits when none came with a PR.
  const walkList = () => { const prs = entries.filter((e) => e.kind === 'pr'); return prs.length ? prs : entries; };
  const setCounts = (c) => { if (c.stuck === counts.stuck && c.ready === counts.ready) return; counts = c; if (res) render(); };

  render();
  return { el, reload, setCounts, walkList, pickSince: () => pickSince(), markCaughtUp, base: () => res?.base || null };
}
