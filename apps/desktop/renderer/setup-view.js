import { h, icon, kbd } from './ui.js';
import { SETUP_AI, SETUP_FEATURES, SETUP_PRS, setupSummary } from './setup.js';
import * as keymap from './keymap.js';

// The "choose your defaults" step (data in setup.js). Switches apply at once, so what you see is
// what you get; Continue (⌘↵) only marks the step done. Returns { el, refresh }.

// `ai` is the current provider's label (or 'Off'); `onAi` opens the picker and resolves to the new label.
// `pr` is { setup } when pull requests need GitHub CLI first: the row shows Set up… instead of a switch.
// `onPr` turns them on or off (or runs the set-up dialogs) and resolves to the new { on, setup }.
export function setupView({ mod, values, theme, themes, ai = 'Off', pr = {}, onToggle, onTheme, onAi, onPr, onDone, done = 'Continue' }) {
  let v = { ...values }, t = theme, a = ai, p = pr;
  const SET_UP = `${SETUP_PRS.label}: Set up`;
  const list = h('div.setup-list');
  const summary = h('span.setup-summary', { role: 'status', 'aria-live': 'polite' });

  const sw = (on, label, onclick) => h('button.switch' + (on ? '.on' : ''), { type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label, onclick }, h('span.switch-knob'));

  function render() {
    list.replaceChildren(
      ...SETUP_FEATURES.map((f) => h('div.setup-row', null,
        icon(f.icon, 14),
        h('div.setup-text', null, h('div.setup-label', null, f.label), h('div.setup-detail', null, f.detail)),
        sw(v[f.id], f.label, () => { v = { ...v, [f.id]: !v[f.id] }; onToggle(f.id, v[f.id]); render(); refocus(f.label); }))),
      h('div.setup-row', null,
        icon(SETUP_PRS.icon, 14),
        h('div.setup-text', null, h('div.setup-label', null, SETUP_PRS.label), h('div.setup-detail', null, SETUP_PRS.detail)),
        p.setup
          ? h('button.btn.subtle.small.setup-pick', { type: 'button', 'aria-label': SET_UP, onclick: () => pick() }, 'Set up…')
          : sw(v.prs, SETUP_PRS.label, () => pick())),
      h('div.setup-row', null,
        icon(SETUP_AI.icon, 14),
        h('div.setup-text', null, h('div.setup-label', null, SETUP_AI.label), h('div.setup-detail', null, SETUP_AI.detail)),
        h('button.btn.subtle.small.setup-pick', {
          type: 'button', 'aria-label': `${SETUP_AI.label}: ${a}`,
          onclick: async () => { const next = await onAi?.(); if (next) a = next; render(); refocus(`${SETUP_AI.label}: ${a}`); },
        }, a, icon('chevronDown', 12))),
      h('div.setup-row', null,
        icon('theme', 14),
        h('div.setup-text', null, h('div.setup-label', null, 'Appearance'), h('div.setup-detail', null, 'Follow the system, or pick one.')),
        h('div.setup-seg', { role: 'group', 'aria-label': 'Appearance' }, themes.map((x) => h('button', {
          type: 'button', 'aria-pressed': String(x.id === t), title: x.label,
          onclick: () => { t = x.id; onTheme(x.id); render(); refocus(x.label); },
        }, icon(x.icon, 12), x.label)))),
    );
    summary.textContent = setupSummary(v);
  }
  async function pick() {
    const next = await onPr?.(!v.prs);
    if (next) { v = { ...v, prs: next.on }; p = next; }
    render();
    refocus(p.setup ? SET_UP : SETUP_PRS.label);
  }
  // Re-rendering replaces the buttons; keep focus on the one that was pressed.
  const refocus = (label) => (list.querySelector(`[aria-label="${CSS.escape(label)}"]`) || [...list.querySelectorAll('.setup-seg button')].find((b) => b.title === label))?.focus();

  const el = h('section.tour.setup', { 'aria-labelledby': 'setup-title' },
    h('div.tour-eyebrow', null, 'Welcome to Since'),
    h('h2#setup-title', null, 'Choose your defaults'),
    h('p.setup-lede', null, 'These are on to start with. Turn off anything you don’t want.'),
    list,
    h('div.tour-foot', null, summary, h('button.btn.primary.small', { type: 'button', onclick: onDone }, done, kbd(mod, '↵'))),
  );
  el.addEventListener('keydown', (e) => {
    if (keymap.match('setup', e) === 'setup.done') { e.preventDefault(); e.stopPropagation(); onDone(); }
  });
  render();
  // Refreshing must not drop focus from the control the user is on.
  const refresh = (values, theme, ai = a, pr = p) => {
    const f = list.contains(document.activeElement) ? document.activeElement : null;
    const label = f?.getAttribute('aria-label');
    const key = f && (label === SET_UP || label === SETUP_PRS.label ? (pr.setup ? SET_UP : SETUP_PRS.label) : f.matches('.setup-pick') ? `${SETUP_AI.label}: ${ai}` : label || f.title);
    v = { ...values }; t = theme; a = ai; p = pr; render();
    if (key) refocus(key);
  };
  return { el, refresh };
}
