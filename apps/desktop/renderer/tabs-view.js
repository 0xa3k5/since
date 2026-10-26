// The window's tab strip (AK-634): one tab per repository, shown once there are two. Each tab's page draws it
// from the list main.js sends (`tabs`); `act(action, id)` asks main.js to select or close a tab.
import { h, icon } from './ui.js';

export function renderTabs(el, list, act) {
  const shown = list.length > 1;
  document.documentElement.classList.toggle('has-tabs', shown);
  el.hidden = !shown;
  el.replaceChildren(...(shown ? list.map((t) => h('div.tab' + (t.active ? '.active' : ''), {
    role: 'tab',
    'aria-selected': String(t.active),
    onclick: () => { if (!t.active) act('select', t.id); },
    // A middle click closes the tab, as in browsers.
    onauxclick: (e) => { if (e.button === 1) act('close', t.id); },
  },
  h('button.tab-close', { type: 'button', 'aria-label': `Close ${t.title}`, onclick: (e) => { e.stopPropagation(); act('close', t.id); } }, icon('x', 12)),
  h('span.tab-title', t.title))) : []));
}
