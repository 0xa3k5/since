import { h, icon, avatar, tipFor } from './ui.js';
import * as keymap from './keymap.js';

// The reader (AK-381): one set of building blocks for Review's right-hand pane (review-pane.js +
// review-view.js) and Catch up's reader (catchup-view.js), so both read the same way.
//  - readerHead: "‹ 3 of 21 ›" on the right of the title (#number, then the title), then the meta
//    line: who made it (authorsEl: the person, "+", the agent, each with an initials avatar), branch → base, then whatever the screen adds (size, dates,
//    Catch up's "Merged"). Review adds its reviewers, merge order, status strip and actions below.
//  - descriptionBlock: the description (or commit message) clamped to a few lines, with "… Show
//    more" where the text is cut and "Show less" after the whole text. Open or closed sticks across
//    items and both screens. No key: it's a link-style button you can Tab to.
//  - fileCard: each file under a sticky header: fold chevron (▾ shows the code, ▴ folds it) · tick ·
//    path · +N −M. Clicking anywhere else on the header folds or unfolds it too.
//  - miniHeader: a slim bar (avatar, #number, title, the primary action) that fades in at the top of
//    the reader once its head has scrolled out of view (IntersectionObserver), and hides again.
//  - readerKey: the reader's keys once focus is in it (↵ from the list): ↑/↓ scroll by a few lines,
//    ⇧↑/⇧↓ four times as far (AK-390), Page Up/Down and Space by a page, ←/→ step the list's selection, , and . jump between files,
//    Esc goes back to the list. ↑/↓ never change the item here.

// Description open or closed, for every item on both screens.
let descOpen = false;

export const LINE = 20; // px: one line of the reader, for ↑/↓
const LINES = 3;
const FAST = 4; // ⇧↑/⇧↓: this many ↑/↓ steps at once
const PAGE_KEEP = 3; // lines of the last page kept in view after Page Down

// How far a reader key scrolls, in px (negative: up), for a reader `page` px tall; null when the key
// doesn't scroll.
export function scrollDelta(id, page = 0) {
  const p = Math.max(LINE, page - PAGE_KEEP * LINE);
  return { 'reader.down': LINES * LINE, 'reader.up': -LINES * LINE, 'reader.downFast': FAST * LINES * LINE, 'reader.upFast': -FAST * LINES * LINE, 'reader.pageDown': p, 'reader.pageUp': -p }[id] ?? null;
}

// The footer's "⇧↑↓ Faster" keycaps: the shared modifiers once, then both arrows.
export function fastKeys() {
  const up = keymap.keys('reader.upFast');
  const down = keymap.keys('reader.downFast');
  const same = up.length > 1 && up.length === down.length && up.slice(0, -1).every((k, i) => k === down[i]);
  return same ? [...up, down[down.length - 1]] : [...up, ...down];
}

// "3 of 21": where `id` sits in `list` (items with an `id`, or keys). → { at: 1-based or 0, of }
export function navPos(list = [], id = null) {
  const i = list.findIndex((x) => (x && typeof x === 'object' ? x.id ?? x.key : x) === id);
  return { at: i + 1, of: list.length };
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// A reader keydown: scrolls `scroller`, steps the list (onStep(±1)), jumps files (onFile(±1)) or
// goes back (onBack()). Returns the command it ran, or null to let the event through.
export function readerKey(e, { scroller, onStep = null, onFile = null, onBack = null }) {
  const id = keymap.match('reader', e);
  if (!id) return null;
  // Space on a focused button or box presses it; ↵ isn't a reader key at all.
  if ((id === 'reader.pageDown' || id === 'reader.pageUp') && e.target?.closest?.('button, input, select, a, textarea')) return null;
  const d = scrollDelta(id, scroller?.clientHeight || 0);
  if (d != null) { if (!scroller) return null; scroller.scrollBy({ top: d, behavior: reduced() ? 'auto' : 'smooth' }); }
  else if (id === 'reader.next' || id === 'reader.prev') { if (!onStep) return null; onStep(id === 'reader.next' ? 1 : -1); }
  else if (id === 'reader.nextFile' || id === 'reader.prevFile') { if (!onFile) return null; onFile(id === 'reader.nextFile' ? 1 : -1); }
  else if (id === 'reader.back') { if (!onBack) return null; onBack(); }
  else return null;
  e.preventDefault();
  e.stopPropagation();
  return id;
}

// An initials avatar whose tooltip is just the name (ui.js avatar wants an email for its colour and tooltip).
export function personAvatar(name, key = name, size = 18) {
  const a = avatar(name || '?', key || name || '?', size);
  a.title = name || '';
  return a;
}

// Who made it (AK-390): authors = [{ name, key, agent, title }] (review-rows.js authorsOf), each an
// initials avatar and its name, joined by "+": "(AK) AK + (CO) Claude Opus 5.5".
export function authorsEl(authors = [], size = 16, cls = '') {
  const list = (authors || []).filter((a) => a?.name);
  if (!list.length) return null;
  return h('span.reader-authors' + cls, { title: list.map((a) => a.title || a.name).join('\n') },
    ...list.flatMap((a, i) => [
      i ? h('span.reader-authors-plus', { 'aria-hidden': 'true' }, '+') : null,
      h('span.reader-author' + (a.agent ? '.agent' : ''), null, personAvatar(a.name, a.key || a.name, size), h('span.reader-author-name', null, a.name)),
    ]).filter(Boolean));
}

// "‹ 3 of 21 ›": nav = { at, of, onStep }. Nothing when the list has one item or fewer.
function navEl({ at, of, onStep }) {
  if (of < 2) return null;
  return h('div.reader-nav', { role: 'group', 'aria-label': 'Previous or next item' },
    h('button.btn.ghost.icon-btn.reader-nav-btn', { disabled: at <= 1, 'aria-label': 'Previous', 'data-tip': tipFor('Previous', 'reader.prev'), onclick: () => onStep(-1) }, icon('chevronLeft', 13)),
    h('span.reader-nav-pos', { 'aria-live': 'polite' }, at ? `${at} of ${of}` : `${of} items`),
    h('button.btn.ghost.icon-btn.reader-nav-btn', { disabled: !at || at >= of, 'aria-label': 'Next', 'data-tip': tipFor('Next', 'reader.next'), onclick: () => onStep(1) }, icon('chevron', 13)));
}

// The head. num: "#12", a short sha or an icon; authors: who made it (authorsEl), or author: one
// name shown (authorKey picks its colour);
// branch/base: "branch → base" (base alone: "on base"); badges sit after the title; meta after the
// branch; below: extra lines under the meta. nav: { at, of, onStep } or null.
export function readerHead({ num = null, numTip = '', title, badges = [], authors = null, author = null, authorKey = null, authorTip = null, branch = null, base = null, meta = [], below = [], nav = null }) {
  return h('header.reader-head', null,
    h('div.reader-title-row', null,
      h('h2.reader-title', { title }, num ? h('span.reader-num', { title: numTip || null }, num) : null, num ? ' ' : null, title),
      ...badges,
      nav ? navEl(nav) : null),
    h('div.reader-meta', null,
      authors ? authorsEl(authors, 16)
        : author ? h('span.reader-author', { title: authorTip || author }, personAvatar(author, authorKey || author, 16), h('span', null, author)) : null,
      branch ? h('span.reader-branch', null, h('span.mono', null, branch), base ? [h('span.reader-arrow', null, ' → '), h('span.mono', null, base)] : null)
        : base ? h('span.reader-branch', null, 'on ', h('span.mono', null, base)) : null,
      ...meta),
    ...below);
}

// The description box: `label` ("Description", "Commit message") and a `note` beside it, then the
// text clamped to a few lines with "… Show more" where it's cut (hidden when it all fits). text ''
// says `empty`; null (GitHub sent none) shows nothing.
export function descriptionBlock({ label = 'Description', note = null, text, empty = 'No description' }) {
  if (text == null) return null;
  const head = h('div.reader-desc-head', null, h('span', null, label), note);
  if (!text) return h('section.reader-desc', { 'aria-label': label }, head, h('div.reader-desc-text.none', null, empty));
  const args = { label, note, text, empty };
  const toggle = () => {
    descOpen = !descOpen;
    const next = descriptionBlock(args);
    box.replaceWith(next);
    next.querySelector('.reader-desc-more')?.focus({ preventScroll: true });
    // Show less from far down a long description: bring the box's top back into view.
    if (!descOpen) next.scrollIntoView({ block: 'nearest' });
  };
  const more = h('button.review-reason-link.reader-desc-more', { 'aria-expanded': String(descOpen), onclick: toggle }, descOpen ? 'Show less' : 'Show more');
  const body = descOpen
    ? h('div.reader-desc-text', null, text, ' ', more)
    : h('div.reader-desc-text.clamped', null, text, h('span.reader-desc-cut', null, '… ', more));
  const box = h('section.reader-desc' + (descOpen ? '.open' : ''), { 'aria-label': label }, head, body);
  // Show more only when the clamped text has more to show; re-checked as the reader resizes.
  if (!descOpen && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (!body.isConnected) { if (!box.isConnected) ro.disconnect(); return; }
      box.classList.toggle('fits', body.scrollHeight <= body.clientHeight + 1);
    });
    ro.observe(body);
  }
  return box;
}

// One file under a sticky header. checked: reviewed or viewed (the tick); collapsed: its code is
// folded; onToggle() folds or unfolds, onCheck() ticks; lead and tail sit before and after the path;
// body: the code's container (an empty one to fill later when not given). Shown: the path as shown.
export function fileCard({ path, shown = path, lead = [], tail = [], add = 0, del = 0, checked = false, checkLabel = `Viewed ${path}`, checkTip = 'Viewed', onCheck, collapsed = false, onToggle, body = null, cls = '' }) {
  return h('section.review-file.reader-file' + cls + (checked ? '.reviewed' : '') + (collapsed ? '.folded' : ''), { role: 'listitem', 'data-path': path, 'aria-label': path },
    h('div.review-file-head', { title: `${path}\n${collapsed ? 'Click to show the code' : 'Click to fold'}`, onclick: () => onToggle() },
      h('button.review-file-fold', {
        'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Show' : 'Fold'} ${path}`,
        onclick: (e) => { e.stopPropagation(); onToggle(); },
      }, icon(collapsed ? 'chevronDown' : 'chevronUp', 12)),
      h('button.review-tick' + (checked ? '.on' : ''), {
        role: 'checkbox', 'aria-checked': String(checked), 'aria-label': checkLabel, title: checkTip,
        onclick: (e) => { e.stopPropagation(); onCheck(); },
      }, checked ? icon('check', 12) : null),
      ...lead,
      h('span.mono.review-file-path', null, shown),
      ...tail,
      h('span.spacer'),
      add || del ? h('span.stat.small', { 'aria-label': `${add} added, ${del} removed` }, h('span.add', null, `+${add}`), h('span.del', null, `−${del}`)) : null),
    collapsed ? null : body || h('div.review-file-body'));
}

// The slim bar at the top of `scroller`: set(content) fills it, watch(head) shows it once `head` has
// scrolled out of view above. el goes first in the scroller; it takes no room in the flow.
export function miniHeader(scroller) {
  const bar = h('div.reader-mini-bar');
  const el = h('div.reader-mini', { 'aria-hidden': 'true', inert: true }, bar);
  let io = null;
  const show = (on) => {
    el.classList.toggle('on', on);
    el.inert = !on;
    el.setAttribute('aria-hidden', String(!on));
    scroller.classList.toggle('mini-on', on);
  };
  return {
    el,
    watch(head) {
      io?.disconnect();
      // No show(false) here: the observer's first call sets it, so a re-rendered head doesn't flicker.
      if (!head || typeof IntersectionObserver !== 'function') return show(false);
      io = new IntersectionObserver(([x]) => show(!x.isIntersecting && x.boundingClientRect.top < (x.rootBounds?.top ?? 0)), { root: scroller });
      io.observe(head);
    },
    set(...children) { bar.replaceChildren(...children.flat().filter(Boolean)); },
    destroy() { io?.disconnect(); },
  };
}

// The bar's contents: avatar (or who made it, authors), #number, the title (truncated), then the
// primary action, if any ({ label, icon, run }).
export function miniContent({ authors = null, author = null, authorKey = null, num = null, title, action = null }) {
  return [
    authors?.length ? authorsEl(authors, 16, '.reader-mini-authors') : author ? personAvatar(author, authorKey || author, 16) : null,
    num ? h('span.reader-num', null, num) : null,
    h('span.reader-mini-title', { title }, title),
    action ? h('button.btn.primary.small.reader-mini-act', { onclick: () => action.run() }, action.icon ? icon(action.icon, 13) : null, action.label) : null,
  ];
}
