import { h, icon, kbd } from './ui.js';
import { TOUR_COMMITS, TOUR_BRANCH, createTour, moveTip, undoTip, redoTip, tourHint } from './tour.js';

// Welcome-screen playground (state in tour.js). Not a step-by-step tour: a live mini graph you
// can poke at, plus three one-line facts. ⌘Z / ⇧⌘Z reach it through the app's undo/redo
// commands while no repository is open. Returns { el, undo, redo }.

const ROW = 26, LANE_X = [12, 28];
const cy = (i) => i * ROW + ROW / 2;

function lanes() {
  const at = new Map(TOUR_COMMITS.map((c, i) => [c.sha, i]));
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const root = svg('svg', { class: 'tour-lanes', width: 40, height: TOUR_COMMITS.length * ROW, 'aria-hidden': 'true' });
  for (const c of TOUR_COMMITS) {
    if (!c.parent) continue;
    const p = TOUR_COMMITS[at.get(c.parent)];
    const x1 = LANE_X[c.lane], y1 = cy(at.get(c.sha)), x2 = LANE_X[p.lane], y2 = cy(at.get(c.parent));
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}V${y2 - ROW}C${x1} ${y2 - ROW / 2} ${x2} ${y2 - ROW / 2} ${x2} ${y2 - 4}`;
    root.append(svg('path', { d, class: `lane-${c.lane}` }));
  }
  TOUR_COMMITS.forEach((c, i) => root.append(svg('circle', { cx: LANE_X[c.lane], cy: cy(i), r: 4, class: `lane-${c.lane}` })));
  return root;
}

export function tourView({ mod }) {
  let s = createTour();
  const rows = h('div.tour-rows');
  const hint = h('div.tour-hint', { role: 'status', 'aria-live': 'polite' });
  const undoBtn = h('button.icon-btn.tiny', { title: `Undo (${mod}Z)`, 'aria-label': 'Undo', onclick: () => set(undoTip(s)) }, icon('undo', 14));
  const redoBtn = h('button.icon-btn.tiny', { title: `Redo (${mod}⇧Z)`, 'aria-label': 'Redo', onclick: () => set(redoTip(s)) }, icon('redo', 14));
  const KEYS = { undo: [mod, 'Z'], redo: [mod, '⇧', 'Z'] };

  const pill = () => h('span.pill.tour-pill', null, icon('branch', 12), TOUR_BRANCH);

  function render() {
    rows.replaceChildren(...TOUR_COMMITS.map((c) => h('button.tour-row' + (c.sha === s.tip ? '.tip' : ''), {
      'aria-label': c.sha === s.tip ? `${c.message}, ${TOUR_BRANCH} is here` : `Move ${TOUR_BRANCH} to ${c.message}`,
      onclick: () => set(moveTip(s, c.sha)),
    }, h('span.tour-msg', null, c.message), c.sha === s.tip ? pill() : null)));
    const { text, keys } = tourHint(s);
    hint.replaceChildren(h('span', null, text), keys ? kbd(...KEYS[keys]) : null);
    undoBtn.disabled = !s.undo.length;
    redoBtn.disabled = !s.redo.length;
  }
  function set(next) {
    const focused = rows.contains(document.activeElement) ? [...rows.children].indexOf(document.activeElement) : -1;
    s = next;
    render();
    rows.children[focused]?.focus();
  }

  const el = h('section.tour', { 'aria-labelledby': 'tour-title' },
    h('div.tour-head', null,
      h('div', null, h('div.tour-eyebrow', null, 'Try it'), h('h2#tour-title', null, 'Your history is a map you can edit')),
      h('div.tour-tools', null, undoBtn, redoBtn)),
    h('div.tour-graph', null, lanes(), rows),
    hint,
    h('ul.tour-facts', null,
      h('li', null, icon('map', 14), h('span', null, h('b', null, 'Work on the graph.'), ' Select a commit, press one key: rebase, squash, cherry-pick, split.')),
      h('li', null, icon('undo', 14), h('span', null, h('b', null, 'Undo anything.'), ' Every branch, tag and HEAD change, without limit.')),
      h('li', null, icon('command', 14), h('span', null, h('b', null, 'Keyboard first.'), ' Every action has a shortcut and lives in '), kbd(mod, 'K'))),
  );
  render();
  return { el, undo: () => set(undoTip(s)), redo: () => set(redoTip(s)) };
}
