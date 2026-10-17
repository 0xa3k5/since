import { h, icon, avatar, tipFor } from './ui.js';
import * as keymap from './keymap.js';
import { markdown } from './markdown.js';
import { factLines, evidenceTabs, evidenceDefault, checkFailed, duration, checkLog } from './review-rows.js';

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
//  - factsBlock (AK-520): under the meta line, the size and spread (then whatever the screen adds,
//    Review's reviewers), then one line per change fact (label, then its detail cut to one line;
//    the whole text in its tooltip).
//  - evidenceStrip (AK-520): Review's tab set (Checks, CI didn't run, Annotations, Media, Open
//    threads), one open at a time; it opens on Checks when one fails, else it stays closed.
//    E (review.evidence) opens the next tab. Tabs with nothing in them aren't shown.
//  - mediaGallery (AK-521): the Media tab's 112×72 thumbnails (description, then comments, then
//    reviews), loaded by the main process (pr-media.js): images as data: URLs kept in memory only,
//    videos streamed from gitlanes-media: and never stored. I (review.media) opens the tab and
//    focuses the first one; ←/→ move between them; Space enlarges the focused one over the reader
//    (←/→ browse, K plays or pauses a video, Space or Esc closes).
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

// Who made it (AK-390): authors = [{ name, key, agent, title }] (review-rows.js authorsOf). One
// person is their avatar and name; two or more are one avatar group, names in its tooltip (AK-533).
export function authorsEl(authors = [], size = 16, cls = '') {
  const list = (authors || []).filter((a) => a?.name);
  if (!list.length) return null;
  if (list.length > 1) return authorsStack(list, size, '.reader-authors' + cls);
  const [a] = list;
  return h('span.reader-authors' + cls, { title: a.title || a.name },
    h('span.reader-author' + (a.agent ? '.agent' : ''), null, personAvatar(a.name, a.key || a.name, size), h('span.reader-author-name', null, a.name)));
}

// The same people as one overlapping avatar group, no names (list rows, AK-400); like the map's
// co-author stack. The names are in its tooltip, one per line (AK-533).
export function authorsStack(authors = [], size = 14, cls = '') {
  const list = (authors || []).filter((a) => a?.name);
  if (!list.length) return null;
  return h('span.avatar-stack' + cls, { role: 'img', 'aria-label': list.map((a) => a.name).join(' and '), 'data-tip': list.map((a) => a.name).join('\n') },
    ...list.map((a) => { const av = personAvatar(a.name, a.key || a.name, size); av.title = ''; return av; }));
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
// text, its markdown shown as prose (markdown.js), clamped to a few lines with "… Show more" where
// it's cut (hidden when it all fits). text ''
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
    ? h('div.reader-desc-text', null, markdown(text), more)
    : h('div.reader-desc-text.clamped', null, markdown(text), h('span.reader-desc-cut', null, '… ', more));
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

// Ticking a file folds it: its code slides shut under the header (which stays where it is) and the
// files below glide up, instead of the card vanishing at once. A stuck header first takes the card's
// place at the top, the code kept on the same lines, so nothing jumps. replace() swaps in the folded
// card, which flashes once so the eye lands on it. Reduced motion: the swap alone, at once.
export function foldShut(card, scroller, replace) {
  const body = card?.querySelector(':scope > .review-file-body');
  const done = () => { const next = replace(); next?.classList.add('just-ticked'); return next; };
  if (!body || !scroller || matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
  const head = card.firstChild.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const lift = Math.max(0, head.top - card.getBoundingClientRect().top); // > 0 while the header is stuck
  const shown = Math.min(body.getBoundingClientRect().bottom, view.bottom) - head.bottom;
  if (shown <= 0) return done();
  const tick = card.querySelector('.review-tick'); // ticked at once; the folded card replaces it after
  tick?.classList.add('on');
  tick?.setAttribute('aria-checked', 'true');
  tick?.replaceChildren(icon('check', 12));
  scroller.scrollTop -= lift;
  body.classList.add('folding');
  body.style.height = `${shown}px`;
  body.scrollTop = lift;
  let over = false;
  const end = () => { if (over) return; over = true; if (card.isConnected) done(); };
  body.addEventListener('transitionend', (e) => { if (e.target === body && e.propertyName === 'height') end(); });
  setTimeout(end, 400); // in case the transition never runs
  requestAnimationFrame(() => requestAnimationFrame(() => { body.style.height = '0px'; body.style.opacity = '0'; }));
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

// ── Change facts and evidence (AK-520) ──

// "+128 −12 · 14 files · 3 folders · 2 assets · 1 lockfile", then `after` (on the same line), then a
// line per fact. null without facts.
export function factsBlock(facts, { after = null } = {}) {
  const f = factLines(facts);
  if (!f) return null;
  const sep = () => h('span.sep', { 'aria-hidden': 'true' }, '·');
  return h('div.reader-facts', { role: 'group', 'aria-label': 'Change facts' },
    h('div.facts-size', null,
      h('span.stat.small', { 'aria-label': `${f.added} added, ${f.deleted} removed` }, h('span.add', null, `+${f.added}`), h('span.del', null, `−${f.deleted}`)),
      ...f.size.flatMap((x) => [sep(), h('span', { title: x.title || null }, x.n == null ? x.label : [h('b', null, String(x.n)), ` ${x.label}`])]),
      after ? [sep(), after] : null),
    ...f.lines.map((l) => h('div.fact-line' + (l.flag ? '.flag' : ''), { title: l.title },
      h('span.fact-label', null, l.label),
      h('span.fact-detail.mono', null, l.detail))));
}

// Which tab is open per PR, and which failed checks show their log, for this window.
const evOpen = new Map();
const logOpen = new Set();
const annOpen = new Set();

// The strip at the top of a PR's reader. evidence: github.evidence, or undefined while it loads
// (a quiet line), or null (nothing to show: no strip). key: the PR, for the open tab; openUrl(url)
// opens a check in the browser; goTo { has(path), go(path, line) } finds a line in the PR's diff. Returns the element, with .next() for E (false when it has no tabs).
export function evidenceStrip({ evidence, key, openUrl = null, loadImage = null, goTo = null }) {
  if (evidence === undefined) return h('section.evidence.loading', { 'aria-label': 'Evidence', 'aria-busy': 'true' }, h('div.ev-note.muted', null, 'Loading checks and reviews…'));
  const tabs = evidenceTabs(evidence);
  if (!tabs.length) return null;
  if (!evOpen.has(key)) evOpen.set(key, evidenceDefault(evidence));
  const box = h('section.evidence', { 'aria-label': 'Evidence' });
  const open = tabs.some((t) => t.id === evOpen.get(key)) ? evOpen.get(key) : null;
  if (open) box.classList.add('open');
  const show = (id, focus = false) => {
    evOpen.set(key, id);
    const next = evidenceStrip({ evidence, key, openUrl, loadImage, goTo });
    box.replaceWith(next);
    if (focus) next.querySelector(id ? `.ev-tab[data-tab="${id}"]` : '.ev-tab')?.focus({ preventScroll: true });
  };
  // The same tab set as Review's lists (Needs you, Stuck, Ready…), counts after the label.
  const bar = h('div.review-tabs.ev-bar', { role: 'tablist', 'aria-label': 'Evidence' });
  let group = tabs[0].group;
  for (const t of tabs) {
    if (t.group !== group) { bar.append(h('span.sep', { 'aria-hidden': 'true' })); group = t.group; }
    const on = t.id === open;
    const n = t.tally
      ? h('span.review-tab-n', null, t.tally.failed ? h('span.fail', null, `${t.tally.failed} failed`) : null, t.tally.failed && (t.tally.passed || t.tally.running) ? ' · ' : null,
        t.tally.passed ? `${t.tally.passed} passed` : null, t.tally.passed && t.tally.running ? ' · ' : null, t.tally.running ? `${t.tally.running} running` : null)
      : t.count ? h('span.review-tab-n', null, String(t.count)) : null;
    bar.append(h('button.review-tab.ev-tab' + (t.kind ? `.${t.kind}` : ''), {
      role: 'tab', 'aria-selected': String(on), 'data-tab': t.id, 'data-tip': tipFor(on ? `Hide ${t.label.toLowerCase()}` : `Show ${t.label.toLowerCase()}`, 'review.evidence'),
      onclick: () => show(on ? null : t.id, true),
    }, t.icon ? icon(t.icon, 12) : null, t.label, n));
  }
  box.append(bar);
  if (open) box.append(h('div.ev-body', { role: 'tabpanel' }, ...evidenceBody(open, evidence, key, { openUrl, loadImage, goTo }, () => show(open))));
  box.next = () => {
    const i = tabs.findIndex((t) => t.id === open);
    show(i + 1 < tabs.length ? tabs[i + 1].id : null);
    return true;
  };
  // I: the Media tab, focused on its first thumbnail. False without media.
  box.media = () => {
    if (!tabs.some((t) => t.id === 'media')) return false;
    if (open !== 'media') show('media');
    document.querySelector('section.evidence .ev-thumb')?.focus({ preventScroll: false });
    return true;
  };
  return box;
}

// One row of the Annotations or Open threads tab: a button (↵ runs onOpen), then Go to line and
// Open on GitHub. ↑/↓ move between rows, G and O run the two buttons (keymap scope "evidence").
function evRow({ k, where, cls, label, main, title = null, expanded = null, onOpen = null, goto = null, github = null }) {
  const btn = h('button.ev-item', {
    type: 'button', 'data-k': k, 'aria-label': label, ...(expanded == null ? {} : { 'aria-expanded': String(expanded) }), ...(title ? { title } : {}),
    onclick: () => onOpen?.(),
    onkeydown: (e) => {
      const id = keymap.match('evidence', e);
      const run = id === 'evidence.open' ? onOpen : id === 'evidence.goto' ? goto : id === 'evidence.github' ? github?.run : null;
      if (id === 'evidence.next' || id === 'evidence.prev') {
        const all = [...btn.closest('.ev-body').querySelectorAll('.ev-item')];
        all[all.indexOf(btn) + (id === 'evidence.next' ? 1 : -1)]?.focus();
      } else if (run) run();
      else return;
      e.preventDefault(); e.stopPropagation();
    },
  }, ...main);
  return h('div.ev-line' + cls, null, btn,
    goto ? h('button.btn.ghost.icon-btn.ev-link', { type: 'button', 'data-tip': tipFor('Go to line', 'evidence.goto'), 'aria-label': `Go to ${where} in the diff`, onclick: goto }, icon('diff', 12)) : h('span'),
    github ? h('button.btn.ghost.icon-btn.ev-link', { type: 'button', 'data-tip': tipFor(github.tip, 'evidence.github'), 'aria-label': github.tip, onclick: github.run }, icon('external', 12)) : h('span'));
}
const refocus = (k) => document.querySelector(`section.evidence .ev-item[data-k="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });

const LEVEL_ICON = { failure: ['x', 'fail'], warning: ['warning', 'warn'], notice: ['pending', 'wait'] };

function evidenceBody(id, ev, key, { openUrl, loadImage, goTo }, redraw) {
  if (id === 'ci') {
    const head = ev.head ? ev.head.slice(0, 7) : null;
    return [h('div.ev-note', null, 'No checks ran on ', head ? h('span.mono', null, head) : 'the head', ', the head of this pull request.',
      h('span.muted', null, 'This repository has CI set up. Checks may need approval for outside contributors.'))];
  }
  if (id === 'checks') {
    const list = [...ev.checks].sort((a, b) => Number(checkFailed(b)) - Number(checkFailed(a)));
    return list.flatMap((c) => {
      const failed = checkFailed(c);
      const log = failed ? checkLog(c, ev.logs) : '';
      const k = `${key}\n${c.name}`;
      const expanded = Boolean(log) && logOpen.has(k);
      const toggle = () => { if (logOpen.has(k)) logOpen.delete(k); else logOpen.add(k); redraw(); };
      const [ic, cls] = failed ? [log ? (expanded ? 'chevronDown' : 'chevron') : 'x', 'fail'] : c.result === 'pending' ? ['pending', 'wait'] : c.result === 'success' ? ['check', 'pass'] : ['pending', 'wait'];
      const row = h('div.ev-row' + (log ? '.has-log' : ''), { title: `${c.name}: ${c.result}` },
        log ? h('button.ev-fold.' + cls, { 'aria-expanded': String(expanded), 'aria-label': `${expanded ? 'Hide' : 'Show'} the log of ${c.name}`, onclick: toggle }, icon(ic, 12)) : h('span.ev-icon.' + cls, null, icon(ic, 12)),
        h('span.name', null, c.name, c.result !== 'success' && !failed && c.result !== 'pending' ? h('span.muted', null, c.result) : null),
        h('span.dur', null, c.duration != null ? duration(c.duration) : c.result === 'pending' ? 'running' : ''),
        c.url && openUrl ? h('button.btn.ghost.icon-btn.ev-link', { 'data-tip': 'Open on GitHub', 'aria-label': `Open ${c.name} on GitHub`, onclick: () => openUrl(c.url) }, icon('external', 12)) : h('span'));
      if (!expanded) return [row];
      const lines = log.split('\n');
      return [row,
        h('pre.ev-log', null, ...lines.map((l) => h('span' + (/\berror\b|✖|##\[error\]/i.test(l) ? '.err' : ''), null, l + '\n'))),
        h('div.ev-log-foot', null, `Last ${lines.length} line${lines.length === 1 ? '' : 's'}`)];
    });
  }
  if (id === 'annotations') {
    return ev.annotations.flatMap((a, i) => {
      const [ic, cls] = LEVEL_ICON[a.level] || LEVEL_ICON.notice;
      const where = a.path ? `${a.path}${a.line ? `:${a.line}` : ''}` : a.check;
      const k = `${key}\n${i}\n${where}\n${a.message.slice(0, 80)}`;
      const first = a.message.split('\n')[0];
      const expanded = annOpen.has(k);
      const toggle = () => { if (annOpen.has(k)) annOpen.delete(k); else annOpen.add(k); redraw(); refocus(k); };
      const url = ev.checks?.find((c) => c.name === a.check)?.url;
      const row = evRow({
        k, where, cls: '.ev-ann', label: `${where}: ${first}`, title: expanded ? 'Hide the message' : 'Show the whole message', expanded, onOpen: toggle,
        main: [h('span.ev-icon.' + cls, null, icon(ic, 12)), h('span.where', null, where), h('span.msg', null, first), h('span.ev-chev', null, icon(expanded ? 'chevronDown' : 'chevron', 12))],
        goto: a.path && a.line && goTo?.has(a.path) ? () => goTo.go(a.path, a.line) : null,
        github: url && openUrl ? { tip: `Open the ${a.check} run on GitHub`, run: () => openUrl(url) } : null,
      });
      if (!expanded) return [row];
      return [row, h('pre.ev-ann-full', null, a.message, a.check ? h('span.muted', null, `\n${a.check}`) : null)];
    });
  }
  if (id === 'media') {
    const n = (k) => ev.media.filter((m) => m.kind === k).length;
    const parts = [n('image') ? `${n('image')} image${n('image') === 1 ? '' : 's'}` : null, n('video') ? `${n('video')} video${n('video') === 1 ? '' : 's'}` : null].filter(Boolean);
    const from = [...new Set(ev.media.map((m) => (m.from === 'description' ? 'the description' : m.from === 'review' ? 'reviews' : 'comments')))];
    return [h('div.ev-note', null, `${parts.join(' and ')} in ${from.join(', ')}`), mediaGallery(ev.media, { openUrl, loadImage })];
  }
  if (id === 'threads') {
    const t = ev.threads;
    const note = h('div.ev-note', null, `${t.open} open of ${t.total} review thread${t.total === 1 ? '' : 's'}`, t.outdated ? h('span.muted', null, `${t.outdated} on lines that changed since`) : null);
    return [note, ...(t.items || []).map((x, i) => {
      const where = `${x.path}${x.line ? `:${x.line}` : ''}`;
      const go = x.path && x.line && goTo?.has(x.path) ? () => goTo.go(x.path, x.line) : null;
      const open = x.url && openUrl ? () => openUrl(x.url) : null;
      return evRow({
        k: `${key}\nthread\n${i}\n${where}`, where, cls: '.ev-thread' + (x.outdated ? '.outdated' : ''),
        label: `${where}${x.author ? `, ${x.author}` : ''}: ${x.text}${x.outdated ? ' (outdated)' : ''}`,
        onOpen: go || open,
        main: [h('span.ev-icon.wait', null, icon('comment', 12)), h('span.where', null, where), h('span.msg', null, x.author ? h('span.who', null, x.author) : null, x.author ? ' · ' : null, x.text ? `“${x.text}”` : null)],
        title: x.outdated ? 'On a line that changed since' : null,
        goto: go, github: open ? { tip: 'Open the thread on GitHub', run: open } : null,
      });
    })];
  }
  return [];
}

// ── Media gallery (AK-521) ──

// Images this window has loaded: id → Promise<data: URL>. Memory only; the main process keeps its
// own capped copy (pr-media.js), so this stays small.
const images = new Map();
const MAX_IMAGES = 100;
function imageFor(m, loadImage) {
  if (!loadImage || m.kind !== 'image') return Promise.resolve(null);
  if (!images.has(m.id)) {
    images.set(m.id, Promise.resolve(loadImage(m.id)).then((u) => (typeof u === 'string' && u.startsWith('data:image/') ? u : null), () => null)
      .then((u) => { if (!u) images.delete(m.id); return u; }));
    while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);
  }
  return images.get(m.id);
}
const videoSrc = (m) => `gitlanes-media://video/${m.id}`;
const FROM = { description: 'the description', comment: 'a comment', review: 'a review' };
const fromText = (m) => `from ${FROM[m.from] || 'a comment'}${m.author && m.from !== 'description' ? ` by ${m.author}` : ''}`;
const fileName = (m) => { try { return decodeURIComponent(new URL(m.url).pathname.split('/').pop()) || m.kind; } catch { return m.kind; } };
const ORDER = { description: 0, comment: 1, review: 2 };

// The thumbnails, as a row of buttons. Space (a button's click) enlarges the focused one.
export function mediaGallery(list, { openUrl = null, loadImage = null } = {}) {
  const media = [...(list || [])].filter((m) => m?.id).sort((a, b) => (ORDER[a.from] ?? 1) - (ORDER[b.from] ?? 1));
  const grid = h('div.ev-media', { role: 'list', 'aria-label': 'Images and videos' });
  const thumbs = media.map((m, i) => {
    const label = m.alt || fileName(m);
    const pic = h('span.ev-thumb-pic');
    const btn = h('button.ev-thumb' + (m.kind === 'video' ? '.video' : ''), {
      role: 'listitem', 'aria-label': `${m.kind === 'video' ? 'Video' : 'Image'} ${i + 1} of ${media.length}: ${label}, ${fromText(m)}. Space to enlarge`,
      'data-tip': tipFor(`Enlarge ${m.kind === 'video' ? 'the video' : 'the image'}`, 'gallery.enlarge'),
      onclick: () => mediaView(media, i, { openUrl, loadImage, back: () => thumbs[i]?.focus({ preventScroll: true }) }),
      // Before the reader's own keys: ←/→ move between thumbnails here, not through the list.
      onkeydown: (e) => {
        const id = keymap.match('gallery', e);
        const d = id === 'gallery.next' ? 1 : id === 'gallery.prev' ? -1 : 0;
        if (id === 'gallery.enlarge') btn.click();
        else if (d) thumbs[(i + d + media.length) % media.length].focus();
        else return;
        e.preventDefault(); e.stopPropagation();
      },
    }, pic, m.kind === 'video' ? h('span.ev-thumb-play', { 'aria-hidden': 'true' }, icon('play', 10), h('span.len')) : null);
    if (m.kind === 'video') {
      const v = h('video', { src: videoSrc(m), preload: 'metadata', muted: true, playsInline: true, tabIndex: -1, 'aria-hidden': 'true' });
      v.muted = true;
      v.addEventListener('loadedmetadata', () => { const len = btn.querySelector('.len'); if (len && Number.isFinite(v.duration)) len.textContent = clock(v.duration); });
      pic.append(v);
    } else {
      pic.append(icon('image', 16));
      imageFor(m, loadImage).then((u) => { if (u) pic.replaceChildren(h('img', { src: u, alt: '', draggable: false })); else pic.classList.add('failed'); });
    }
    grid.append(h('div.ev-thumb-cell', null, btn, h('span.ev-thumb-from', { title: fromText(m) }, fromText(m).replace(/^from /, ''))));
    return btn;
  });
  return grid;
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// The enlarged view: over the reader on --scrim, with "2 of 3 · file · from the description", the
// keys and Open on GitHub. Videos play inline, muted at first, with their controls.
export function mediaView(media, start, { openUrl = null, loadImage = null, back = null } = {}) {
  let i = start;
  const stage = h('div.media-stage');
  const bar = h('div.media-bar');
  const overlay = h('div.media-view', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media', tabIndex: -1 }, h('div.media-box', null, bar, stage));
  const close = () => { overlay.remove(); back?.(); };
  const video = () => stage.querySelector('video');
  const draw = () => {
    const m = media[i];
    bar.replaceChildren(
      h('span.media-pos', null, `${i + 1} of ${media.length}`),
      h('span.sep', { 'aria-hidden': 'true' }, '·'), h('span.media-name.mono', { title: m.alt || fileName(m) }, fileName(m)),
      h('span.sep', { 'aria-hidden': 'true' }, '·'), h('span.muted', null, fromText(m)),
      h('span.media-keys.muted', null, media.length > 1 ? [kbdText(keyText('gallery.prev')), kbdText(keyText('gallery.next')), ' browse  '] : null, m.kind === 'video' ? [kbdText(keyText('gallery.play')), ' play  '] : null, kbdText(keyText('gallery.close')), ' close'),
      openUrl && m.url ? h('button.btn.ghost.small', { type: 'button', onclick: () => openUrl(m.url) }, icon('external', 12), 'Open on GitHub') : null,
      h('button.btn.ghost.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x', 12)));
    if (m.kind === 'video') {
      const v = h('video', { src: videoSrc(m), controls: true, autoplay: true, muted: true, playsInline: true, preload: 'auto' });
      v.muted = true;
      stage.replaceChildren(v);
    } else {
      stage.replaceChildren(h('div.media-loading.muted', null, 'Loading…'));
      imageFor(m, loadImage).then((u) => { if (media[i] !== m) return; stage.replaceChildren(u ? h('img', { src: u, alt: m.alt || fileName(m), draggable: false }) : h('div.media-loading.muted', null, 'Couldn’t load this image.')); });
    }
  };
  // Every key stays in the view: the reader and the list behind it don't move while it's open.
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    let id = keymap.match('gallery', e);
    if (id === 'gallery.enlarge' && e.target instanceof HTMLButtonElement) id = null; // Space presses the bar's buttons
    if (id === 'gallery.close' || id === 'gallery.enlarge') close();
    else if (id === 'gallery.next' || id === 'gallery.prev') { if (media.length > 1) { i = (i + (id === 'gallery.next' ? 1 : -1) + media.length) % media.length; draw(); } }
    else if (id === 'gallery.play') { const v = video(); if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } }
    else return; // Tab and the rest keep their defaults; menu shortcuts (⌘W) still work
    e.preventDefault();
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  draw();
  document.body.append(overlay);
  overlay.focus({ preventScroll: true });
  return { close, overlay };
}
const kbdText = (k) => h('kbd', null, k);
const keyText = (id) => keymap.keys(id).join('');
