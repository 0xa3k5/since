// Builds the /shortcuts table from the desktop app's own source, so the site can't drift from the app.
// Generated: menu accelerators (main.js), commit actions (commitMenu), views (VIEWS + "g then x"), the ⌘K command list.
// Hand-described: keys handled inline in the map, Quick View and Commit view. test/keymap.test.mjs checks those
// against the source in both directions, so a key added or removed in the app fails `npm test` until this file follows.
import fs from 'node:fs';
import path from 'node:path';

/** Finds apps/desktop from the current directory (the build runs in apps/web; tests may run from the root). */
export function findDesktop(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    for (const c of [path.join(dir, 'apps/desktop'), path.join(dir, '../desktop')]) {
      if (fs.existsSync(path.join(c, 'main.js')) && fs.existsSync(path.join(c, 'renderer/app.js'))) return c;
    }
    if (path.dirname(dir) === dir) throw new Error(`apps/desktop not found from ${start}`);
  }
}

export function readSources(desktop = findDesktop()) {
  return {
    main: fs.readFileSync(path.join(desktop, 'main.js'), 'utf8'),
    app: fs.readFileSync(path.join(desktop, 'renderer/app.js'), 'utf8'),
  };
}

// ---------------------------------------------------------------- Key formatting

const MODS = { Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Cmd: '⌘', CmdOrCtrl: '⌘', Command: '⌘', CommandOrControl: '⌘' };
const MOD_ORDER = ['⌃', '⌥', '⇧', '⌘'];
const KEY_NAMES = { Enter: '↵', Return: '↵', Backspace: '⌫', Delete: '⌫', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space', Space: 'Space', PageUp: 'Page Up', PageDown: 'Page Down' };

/** "CmdOrCtrl+Shift+N" → ["⇧", "⌘", "N"] in macOS modifier order. */
export function formatAccelerator(acc) {
  const parts = acc.split('+');
  const key = parts.pop().replace(/\\\\/g, '\\');
  const mods = parts.map((p) => MODS[p] ?? p).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)];
}

/** The text between `anchor` and the end of the block that follows it (first `close` after it). */
export function slice(src, anchor, close = '\n  });') {
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error(`keymap: anchor not found in app source: ${anchor}`);
  const j = src.indexOf(close, i);
  return src.slice(i, j === -1 ? undefined : j);
}

// ---------------------------------------------------------------- Generated parts

/** Menu bar items with an accelerator, grouped by top-level menu. */
export function menuShortcuts(main) {
  const consts = Object.fromEntries([...main.matchAll(/const (\w+_ACCELERATOR) = isMac \? '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const menus = [...main.matchAll(/\n {6}label: '(\w[\w ]*)',\s*\n\s*submenu:/g)].map((m) => ({ name: m[1], at: m.index }));
  // Items before the first named menu sit in the app menu (its label is app.name, not a string).
  const menuAt = (i) => menus.filter((m) => m.at < i).at(-1)?.name ?? 'App';
  const out = [];
  for (const m of main.matchAll(/item\((.+?), '([^']+)', '\w+'/g)) {
    const label = [...m[1].matchAll(/'([^']+)'/g)].at(-1)?.[1];
    if (label) out.push({ menu: menuAt(m.index), label, keys: formatAccelerator(m[2]) });
  }
  for (const m of main.matchAll(/\{ label: '([^']+)', accelerator: (?:'([^']+)'|(\w+_ACCELERATOR))/g)) {
    out.push({ menu: menuAt(m.index), label: m[1], keys: formatAccelerator(m[2] ?? consts[m[3]]) });
  }
  return out;
}

/** Single-key commit actions, with the labels the app's commit menu shows. */
export function commitActions(app) {
  const menu = slice(app, 'function commitMenu', '\n}\n');
  return [...menu.matchAll(/\{ label: '([^']+)', icon: '[^']+', kbd: '([^']+)'/g)].map((m) => ({ label: m[1], keys: [m[2]] }));
}

/** Views: ⌘1–6 and "G then letter". */
export function views(app) {
  const g = Object.fromEntries([...slice(app, '"G then X" navigation', '\n});').matchAll(/(\w): '(\w+)'/g)].map((m) => [m[2], m[1]]));
  return [...app.matchAll(/\{ id: '(\w+)', label: '(\w+)', icon: '\w+', key: '(\d)' \}/g)].map((m) => ({
    label: m[2], keys: ['⌘', m[3]], alt: g[m[1]] ? ['G', g[m[1]].toUpperCase()] : null,
  }));
}

/** Fixed ⌘K commands (branch, ref and commit entries are added per repository and are left out). */
export function paletteCommands(app) {
  const body = slice(app, 'function openPalette', '\n}\n');
  return [...body.matchAll(/add\('(\w+)', (?:'([^']+)'|[^,]*\? '[^']+' : '([^']+)')/g)].map((m) => ({ group: m[1], label: m[2] ?? m[3] }));
}

// ---------------------------------------------------------------- Hand-described parts

/**
 * Keys handled inline. `scope` names the handler; `src` lists the key literals the test looks for in it.
 * Keep `src` in the exact spelling of `e.key` (e.g. ' ' for Space).
 */
export const INLINE = {
  map: {
    title: 'Map',
    anchor: "scroller.addEventListener('keydown'",
    keys: [
      { label: 'Next / previous commit', keys: ['J', 'K'], alt: ['↓', '↑'], src: ['j', 'k', 'ArrowDown', 'ArrowUp'] },
      { label: 'Page down / up', keys: ['Page Down', 'Page Up'], src: ['PageDown', 'PageUp'] },
      { label: 'First / last commit', keys: ['Home', 'End'], src: ['Home', 'End'] },
      { label: 'Quick View (or pick the search result)', keys: ['↵'], src: ['Enter'] },
      { label: 'Show or hide the detail panel', keys: ['Space'], src: [' '] },
      { label: 'Clear search', keys: ['Esc'], src: ['Escape'] },
      { label: 'Jump to HEAD', keys: ['H'], src: ['h'] },
      { label: 'Copy SHA', keys: ['⌘', 'C'], src: ['c'] },
    ],
  },
  quick: {
    title: 'Quick View',
    anchor: "if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeQuick(); }",
    keys: [
      { label: 'Next / previous file', keys: ['J', 'K'], alt: ['↓', '↑'], src: ['j', 'k', 'ArrowDown', 'ArrowUp'] },
      { label: 'Back to the map', keys: ['Esc'], alt: ['Space'], src: ['Escape', ' '] },
    ],
  },
  commit: {
    title: 'Commit view',
    anchor: 'if (e.target === textarea) return;',
    keys: [
      { label: 'Next / previous file', keys: ['J', 'K'], alt: ['↓', '↑'], src: ['j', 'k', 'ArrowDown', 'ArrowUp'] },
      { label: 'Stage or unstage the selected file', keys: ['↵'], src: ['Enter'] },
      { label: 'Discard the selected unstaged file (undoable)', keys: ['⌫'], src: ['Backspace', 'Delete'] },
      { label: 'Write the commit message', keys: ['C'], src: ['c'] },
    ],
  },
  global: {
    title: 'Anywhere in a repository',
    anchor: "window.addEventListener('keydown'",
    close: '\n});',
    keys: [
      { label: 'Search commits', keys: ['/'], src: ['/'] },
      { label: 'Go to a view: G, then M, C, S, H or R', keys: ['G'], src: ['g'] },
      { label: 'Close Quick View', keys: ['Esc'], src: ['Escape'] },
    ],
  },
};

/** Commit message box: ⌘↵ commits. Lives on the textarea, not in the view handler. */
export const COMMIT_MESSAGE = { label: 'Commit', keys: ['⌘', '↵'], anchor: "textarea.addEventListener('keydown'", src: ['Enter'] };

/** Every key literal a handler compares `e.key` with (or switches on). */
export function handlerKeys(src) {
  return new Set([...src.matchAll(/(?:e\.key === |case |\bk === )'([^']+)'/g)].map((m) => m[1]));
}

// ---------------------------------------------------------------- The page model

export function loadKeymap(sources = readSources()) {
  const { main, app } = sources;
  const menu = menuShortcuts(main);
  const actions = commitActions(app);
  const byMenu = (name) => menu.filter((s) => s.menu === name).map(({ label, keys }) => ({ label, keys }));
  const groups = [
    { id: 'map', title: 'Map', note: 'With the commit list focused.', items: INLINE.map.keys },
    { id: 'commit-actions', title: 'Commit actions', note: 'Single keys on the selected commit in the map. Every change to history can be undone with ⌘Z.', items: actions },
    { id: 'views', title: 'Views', note: 'Press G, then the letter, or use ⌘ and the number.', items: views(app) },
    { id: 'commit-view', title: 'Commit view', items: [...INLINE.commit.keys, { label: COMMIT_MESSAGE.label, keys: COMMIT_MESSAGE.keys }] },
    { id: 'quick-view', title: 'Quick View', items: INLINE.quick.keys },
    { id: 'global', title: 'Anywhere in a repository', items: INLINE.global.keys },
    { id: 'edit', title: 'Edit menu', items: byMenu('Edit') },
    { id: 'repository', title: 'Repository menu', items: byMenu('Repository') },
    { id: 'file', title: 'File menu', items: [...byMenu('App'), ...byMenu('File')] },
    { id: 'view', title: 'View menu', items: byMenu('View').filter((s) => !/^(Map|Commit|Stashes|Snapshots|Reflog|Configuration)$/.test(s.label)) },
  ];
  return { groups, palette: paletteCommands(app) };
}
