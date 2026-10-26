import { h, icon, kbd } from './ui.js';
import * as keymap from './keymap.js';
import {
  LESSONS, TOUR_BRANCH, TOUR_FEATURE, createTour, setLesson, select, moveTip, squash, rebase, cherryPick,
  undoTip, redoTip, filterCommands, tourHint,
} from './tour.js';

// Welcome-screen onboarding (state in tour.js): four short lessons on one live mini graph you can
// poke at. ⌘Z / ⇧⌘Z reach it through the app's undo/redo commands while no repository is open.
// Returns { el, undo, redo }.

const ROW = 26, LANE_X = [12, 28];
const cy = (i) => i * ROW + ROW / 2;

function lanes(commits) {
  const at = new Map(commits.map((c, i) => [c.sha, i]));
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const root = svg('svg', { class: 'tour-lanes', width: 40, height: commits.length * ROW, 'aria-hidden': 'true' });
  for (const c of commits) {
    if (!c.parent) continue;
    const p = commits[at.get(c.parent)];
    const x1 = LANE_X[c.lane], y1 = cy(at.get(c.sha)), x2 = LANE_X[p.lane], y2 = cy(at.get(c.parent));
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}V${y2 - ROW}C${x1} ${y2 - ROW / 2} ${x2} ${y2 - ROW / 2} ${x2} ${y2 - 4}`;
    root.append(svg('path', { d, class: `lane-${c.lane}` }));
  }
  commits.forEach((c, i) => root.append(svg('circle', { cx: LANE_X[c.lane], cy: cy(i), r: 4, class: `lane-${c.lane}` })));
  return root;
}

export function tourView({ mod }) {
  let s = createTour();
  let query = '';
  const KEYS = { undo: [mod, 'Z'], redo: [mod, '⇧', 'Z'], palette: [mod, 'K'] };
  const tabs = h('div.tour-tabs', { role: 'tablist', 'aria-label': 'Lessons' });
  const title = h('h2#tour-title');
  const stage = h('div.tour-stage', { id: 'tour-stage', role: 'tabpanel' });
  const hint = h('div.tour-hint', { role: 'status', 'aria-live': 'polite' });
  const step = h('span.tour-step');
  const next = h('button.btn.ghost.small', { onclick: () => go(1) });

  const pill = (name, cls) => h('span.pill.tour-pill' + cls, null, icon('branch', 12), name);
  const go = (d) => {
    const i = LESSONS.findIndex((l) => l.id === s.lesson);
    set(setLesson(s, LESSONS[(i + d + LESSONS.length) % LESSONS.length].id));
    tabs.querySelector('[aria-selected="true"]')?.focus();
  };

  function onRow(sha) {
    set(s.lesson === 'graph' ? moveTip(s, sha) : select(s, sha));
  }

  function graph() {
    const featureTip = s.commits.find((c) => c.lane === 1)?.sha;
    const rows = h('div.tour-rows', { role: 'listbox', 'aria-label': 'Pretend repository' },
      s.commits.map((c) => h('button.tour-row' + (c.sha === s.tip ? '.tip' : '') + (c.sha === s.sel && s.lesson !== 'graph' ? '.sel' : ''), {
        role: 'option',
        'aria-selected': String(c.sha === s.sel && s.lesson !== 'graph'),
        'aria-label': s.lesson === 'graph' && c.sha !== s.tip ? `Move ${TOUR_BRANCH} to ${c.message}` : c.message,
        'data-sha': c.sha,
        onclick: () => onRow(c.sha),
      }, h('span.tour-msg', null, c.message),
      c.sha === featureTip ? pill(TOUR_FEATURE, '.feature') : null,
      c.sha === s.tip ? pill(TOUR_BRANCH, '.main') : null)));
    rows.addEventListener('keydown', (e) => {
      const id = keymap.match('tour', e);
      // The rewrite lesson answers the Map's own keys (S, R, P), so it follows the user's bindings.
      const op = { 'commit.squash': squash, 'commit.rebase': rebase, 'commit.cherryPick': cherryPick }[keymap.match('map', e)];
      if (id === 'tour.next' || id === 'tour.prev') {
        e.preventDefault();
        (id === 'tour.next' ? e.target.nextElementSibling : e.target.previousElementSibling)?.focus();
      } else if (s.lesson === 'rewrite' && op) {
        e.preventDefault();
        const here = e.target.dataset?.sha ? select(s, e.target.dataset.sha) : s;
        set(op(here));
      }
    });
    return h('div.tour-graph', null, lanes(s.commits), rows);
  }

  function palette() {
    const list = h('div.tour-cmds', { role: 'listbox', 'aria-label': 'Commands' });
    const fill = () => {
      const found = filterCommands(query);
      list.replaceChildren(...(found.length ? found.map((c) => h('button.tour-cmd' + (c.lesson ? '' : '.static'), {
        role: 'option',
        title: c.lesson ? `Show ${LESSONS.find((l) => l.id === c.lesson).label}` : undefined,
        onclick: () => c.lesson && set(setLesson(s, c.lesson)),
      }, icon(c.icon, 14), h('span.tour-msg', null, c.label), c.key ? kbd(c.key) : null))
        : [h('div.tour-empty', null, 'No matching commands')]));
    };
    const input = h('input.input.tour-search', {
      type: 'search', placeholder: 'Search commands…', 'aria-label': 'Search commands', value: query,
      oninput: (e) => { query = e.target.value; fill(); },
      onkeydown: (e) => { if (e.key === 'Enter') list.querySelector('button')?.click(); },
    });
    fill();
    return h('div.tour-palette', null, h('div.tour-search-wrap', null, icon('search', 14), input), list);
  }

  function render() {
    const lesson = LESSONS.find((l) => l.id === s.lesson);
    const i = LESSONS.indexOf(lesson);
    tabs.replaceChildren(...LESSONS.map((l) => h('button.tour-tab', {
      role: 'tab', 'aria-selected': String(l === lesson), 'aria-controls': 'tour-stage', tabIndex: l === lesson ? 0 : -1,
      onclick: () => set(setLesson(s, l.id)),
    }, l.label)));
    title.textContent = lesson.title;
    stage.replaceChildren(s.lesson === 'palette' ? palette() : graph());
    if (s.lesson === 'undo') {
      stage.append(h('div.tour-tools', null,
        h('button.btn.ghost.small', { disabled: !s.undo.length, onclick: () => set(undoTip(s)) }, icon('undo', 14), 'Undo', kbd(...KEYS.undo)),
        h('button.btn.ghost.small', { disabled: !s.redo.length, onclick: () => set(redoTip(s)) }, icon('redo', 14), 'Redo', kbd(...KEYS.redo))));
    }
    const { text, keys } = tourHint(s);
    hint.replaceChildren(h('span', null, text), keys ? kbd(...KEYS[keys]) : null);
    step.textContent = `${i + 1} of ${LESSONS.length}`;
    next.replaceChildren(i === LESSONS.length - 1 ? 'Start over' : `Next: ${LESSONS[i + 1].label}`);
  }

  // Re-render, keeping focus on the same row or field.
  function set(nextState) {
    const a = document.activeElement;
    const sha = stage.contains(a) ? a.dataset?.sha : null;
    const search = a?.classList?.contains('tour-search');
    s = nextState;
    render();
    const target = (sha && stage.querySelector(`[data-sha="${CSS.escape(sha)}"]`)) || (search && stage.querySelector('.tour-search'));
    // The row was squashed away, or a search result opened another lesson: land on the selection (or the first row)
    // so the keys keep working instead of focus falling back to <body>.
    if (target) target.focus();
    else if (sha || search) (stage.querySelector(`[data-sha="${CSS.escape(s.sel || '')}"]`) || stage.querySelector('.tour-row, .tour-search'))?.focus();
  }

  tabs.addEventListener('keydown', (e) => {
    const id = keymap.match('tour', e);
    if (id === 'tour.nextTab' || id === 'tour.prevTab') { e.preventDefault(); go(id === 'tour.nextTab' ? 1 : -1); }
  });

  const el = h('section.tour', { 'aria-labelledby': 'tour-title' },
    h('div.tour-eyebrow', null, 'Get to know Since'),
    title,
    tabs,
    stage,
    hint,
    h('div.tour-foot', null, step, next),
  );
  render();
  return { el, undo: () => set(undoTip(s)), redo: () => set(redoTip(s)) };
}
