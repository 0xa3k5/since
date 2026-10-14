// Builds the /shortcuts table from the desktop app's keymap registry (apps/desktop/renderer/keymap.js), the same
// list the app's handlers, menus and ⌘K read, so the site can't drift from the app. The ⌘K command list is read
// from the app's source, since those are commands rather than keys.
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS, keys } from '../../../desktop/renderer/keymap.js';

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
  return { app: fs.readFileSync(path.join(desktop, 'renderer/app.js'), 'utf8') };
}

/** The text between `anchor` and the end of the block that follows it (first `close` after it). */
export function slice(src, anchor, close = '\n  });') {
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error(`keymap: anchor not found in app source: ${anchor}`);
  const j = src.indexOf(close, i);
  return src.slice(i, j === -1 ? undefined : j);
}

/** Fixed ⌘K commands (branch, ref and commit entries are added per repository and are left out). */
export function paletteCommands(app) {
  const body = slice(app, 'function openPalette', '\n}\n');
  return [...body.matchAll(/add\('(\w+)', (?:'([^']+)'|[^,]*\? '[^']+' : '([^']+)')/g)].map((m) => ({ group: m[1], label: m[2] ?? m[3] }));
}

// The page always shows macOS keys.
const mac = (id, index = 0) => keys(id, { mac: true, index });
const same = (a, b) => a?.join() === b?.join();

/** One table row: a command's keys, its pair's keys after them (↓ ↑), and a different second binding as `alt`. */
export function row(cmd) {
  const main = mac(cmd.id);
  const second = mac(cmd.id, 1);
  return {
    label: cmd.label,
    keys: cmd.pair ? [...main, ...mac(cmd.pair)] : main,
    alt: second && !same(second, main) ? second : null,
  };
}

export const GROUPS = [
  { id: 'map', title: 'Map', note: 'With the commit list focused.' },
  { id: 'commit-actions', title: 'Commit actions', note: 'Single keys on the selected commit in the map. Every change to history can be undone with ⌘Z.' },
  { id: 'views', title: 'Views', note: 'Press G, then the letter, or use ⌘ and the number.' },
  { id: 'commit-view', title: 'Commit view' },
  { id: 'quick-view', title: 'Quick View' },
  { id: 'global', title: 'Anywhere in a repository' },
  { id: 'edit', title: 'Edit menu' },
  { id: 'repository', title: 'Repository menu' },
  { id: 'file', title: 'File menu' },
  { id: 'view', title: 'View menu' },
];

export function loadKeymap(sources = readSources()) {
  const groups = GROUPS.map((g) => ({
    ...g,
    items: COMMANDS.filter((c) => c.group === g.id && !c.role).map(row),
  }));
  return { groups, palette: paletteCommands(sources.app) };
}
