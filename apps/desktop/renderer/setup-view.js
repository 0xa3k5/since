import { h, icon, kbd } from './ui.js';
import { SETUP_FEATURES, SETUP_LATER, setupSummary } from './setup.js';
import * as keymap from './keymap.js';

// The "choose your defaults" step (data in setup.js). Switches apply at once, so what you see is
// what you get; Continue (⌘↵) only marks the step done. Returns { el, refresh }.

const LATER_KEYS = { prs: 'P', ai: 'G' };

export function setupView({ mod, values, theme, themes, onToggle, onTheme, onDone, done = 'Continue' }) {
  let v = { ...values }, t = theme;
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
        icon('theme', 14),
        h('div.setup-text', null, h('div.setup-label', null, 'Appearance'), h('div.setup-detail', null, 'Follow the system, or pick one.')),
        h('div.setup-seg', { role: 'group', 'aria-label': 'Appearance' }, themes.map((x) => h('button', {
          type: 'button', 'aria-pressed': String(x.id === t), title: x.label,
          onclick: () => { t = x.id; onTheme(x.id); render(); refocus(x.label); },
        }, icon(x.icon, 12), x.label)))),
    );
    summary.textContent = setupSummary(v);
  }
  // Re-rendering replaces the buttons; keep focus on the one that was pressed.
  const refocus = (label) => (list.querySelector(`[aria-label="${CSS.escape(label)}"]`) || [...list.querySelectorAll('.setup-seg button')].find((b) => b.title === label))?.focus();

  const el = h('section.tour.setup', { 'aria-labelledby': 'setup-title' },
    h('div.tour-eyebrow', null, 'Welcome to GitLanes'),
    h('h2#setup-title', null, 'Choose your defaults'),
    h('p.setup-lede', null, 'These are on to start with. Turn off anything you don’t want.'),
    list,
    h('div.setup-later', null,
      h('div.setup-later-head', null, 'Later, in a repository'),
      SETUP_LATER.map((f) => h('div.setup-later-row', null, icon(f.icon, 14), h('span.setup-label', null, f.label), h('span.setup-detail', null, f.detail), kbd(mod, '⌥', LATER_KEYS[f.id])))),
    h('div.tour-foot', null, summary, h('button.btn.primary.small', { type: 'button', onclick: onDone }, done, kbd(mod, '↵'))),
  );
  el.addEventListener('keydown', (e) => {
    if (keymap.match('setup', e) === 'setup.done') { e.preventDefault(); e.stopPropagation(); onDone(); }
  });
  render();
  return { el, refresh: (values, theme) => { v = { ...values }; t = theme; render(); } };
}
