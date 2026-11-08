import { h, contextMenu, timeAgo } from '../lib/ui.ts';
import { up } from '../lib/upcalls.ts';
import { state } from '../lib/app-helpers.ts';
import { act } from '../lib/bridge.ts';
import { historyTabs } from './snapshots.js';

// Reflog

function reflogView(): HTMLElement {
  const el = h('div.page.flush.history-page');
  el.append(h('div.page-head', null, h('div', null, h('h1', null, 'History & recovery'), historyTabs('reflog'))));
  const rows = h('div.table');
  for (const e of state.reflog) {
    rows.append(h('div.table-row', {
      ondblclick: () => { if (state.index.has(e.sha)) up.jumpTo(e.sha); else up.openQuick(e.sha); },
      oncontextmenu: (ev) => {
        ev.preventDefault();
        contextMenu(ev.clientX, ev.clientY, [
          { label: 'Quick View', icon: 'eye', run: () => up.openQuick(e.sha) },
          state.index.has(e.sha) ? { label: 'Show in Map', icon: 'map', run: () => up.jumpTo(e.sha) } : null,
          { label: 'Create Branch Here…', icon: 'branch', run: () => up.createBranch(e.sha) },
          { label: 'Checkout (detached)', icon: 'checkout', run: () => act(`Checkout ${e.sha.slice(0, 7)}`, 'checkout', [e.sha]) },
          { label: 'Copy SHA', icon: 'copy', run: () => up.copy(e.sha, 'Copied SHA') },
        ]);
      },
    },
      h('span.mono.dim', null, e.sha.slice(0, 7)),
      h('span.reflog-sel', null, e.selector.replace(/@\{\d+\}$/, '')),
      h('span.reflog-action', null, e.action),
      h('span.when', null, timeAgo(e.time)),
      !state.index.has(e.sha) ? h('span.badge.warn', { title: 'Not reachable from any branch or tag' }, 'Unreachable') : h('span'),
    ));
  }
  if (!state.reflog.length) rows.append(h('div.empty', null, 'Reflog is empty'));
  el.append(rows);
  return el;
}

export { reflogView };
