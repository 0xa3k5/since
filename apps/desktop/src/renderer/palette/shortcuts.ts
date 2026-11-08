import { COMMANDS, SCOPES, command, bindings, keys, type Command } from './keymap.ts';

/** One row of the Keyboard Shortcuts window: a command (and its pair), with every binding as keycaps. */
export interface ShortcutRow { ids: string[]; label: string; labels: string[]; section: string | undefined; keys: string[][]; custom: boolean }
export interface ShortcutSection { id: string; title: string | undefined; rows: ShortcutRow[] }

// The Keyboard Shortcuts window's contents, built from the keymap: one section per scope (the menu bar split by
// menu), every command once. A `pair` command (↓ ↑) shares a row with the command it pairs. `first` is the active
// view's scope, listed first; `custom` is a Set of command ids whose keys the user changed (marked in the list).

const MENUS: Record<string, string> = { file: 'File menu', edit: 'Edit menu', view: 'View menu', views: 'Views', repository: 'Repository menu', window: 'Window menu', help: 'Help menu' };

const sectionOf = (cmd: Command): string => (cmd.scope === 'menu' ? `menu:${cmd.group}` : cmd.scope);
const titleOf = (id: string): string | undefined => (id.startsWith('menu:') ? MENUS[id.slice(5)] : SCOPES[id]);

// Every binding of a command as keycaps: [['⌘', '1'], ['G', 'M']].
const allKeys = (id: string, mac?: boolean): string[][] => bindings(id, mac).map((_, index) => keys(id, { index, mac }) ?? []);

const WORDS: [RegExp, string][] = [[/\b(cmd|command|meta)\b/g, '⌘'], [/\b(ctrl|control)\b/g, '⌃'], [/\b(alt|opt|option)\b/g, '⌥'], [/\bshift\b/g, '⇧'],
  [/\b(esc|escape)\b/g, 'esc'], [/\b(enter|return)\b/g, '↵'], [/\b(up)\b/g, '↑'], [/\b(down)\b/g, '↓'], [/\b(left)\b/g, '←'], [/\b(right)\b/g, '→']];
const compact = (s: string) => s.toLowerCase().replace(/[\s+]/g, '');
// Modifier runs in macOS order, so ⌘⇧F and ⇧⌘F both find ⇧⌘F.
const MODS = '⌃⌥⇧⌘';
const modOrder = (s: string) => s.replace(/[⌃⌥⇧⌘]+/g, (m) => [...m].sort((a, b) => MODS.indexOf(a) - MODS.indexOf(b)).join(''));

/** Does a row match the search? Words match the label and section; key names and symbols match a binding. */
export function matches(row: Pick<ShortcutRow, 'labels' | 'section' | 'keys'>, query: string, mac?: boolean): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = `${row.labels.join(' ')} ${row.section}`.toLowerCase();
  if (q.split(/\s+/).every((w) => text.includes(w))) return true;
  let k = q;
  for (const [re, sym] of WORDS) k = k.replace(re, sym);
  if (!mac) k = k.replace(/⌃/g, 'ctrl');
  k = modOrder(compact(k));
  return row.keys.some((caps) => modOrder(compact(caps.join(''))).includes(k));
}

export function shortcutSections({ first = null, query = '', custom = new Set<string>(), mac }: { first?: string | null; query?: string; custom?: Set<string>; mac?: boolean } = {}): ShortcutSection[] {
  const paired = new Set(COMMANDS.map((c) => c.pair).filter(Boolean));
  const sections = new Map<string, ShortcutSection>();
  for (const cmd of COMMANDS) {
    if (paired.has(cmd.id)) continue;
    const id = sectionOf(cmd);
    let sec = sections.get(id);
    if (!sec) { sec = { id, title: titleOf(id), rows: [] }; sections.set(id, sec); }
    const ids = cmd.pair ? [cmd.id, cmd.pair] : [cmd.id];
    const main = allKeys(cmd.id, mac);
    const row: ShortcutRow = {
      ids,
      label: cmd.label,
      labels: ids.map((x) => command(x)?.label ?? x),
      section: sec.title,
      // A pair shows its two keys side by side: ↓ ↑.
      keys: cmd.pair ? [[...(main[0] ?? []), ...(keys(cmd.pair, { mac }) ?? [])], ...main.slice(1)].filter((k) => k.length) : main,
      custom: ids.some((x) => custom.has(x)),
    };
    // Commands with no default keys (⌘K and menu only) stay out of the list unless the user gave them some.
    if (!row.keys.length && !row.custom) continue;
    sec.rows.push(row);
  }
  // The active view's section first, then "anywhere", then the rest in keymap order.
  const order = [first, 'global'].filter((x): x is string => !!x && sections.has(x));
  const list = [...order.map((x) => sections.get(x)!), ...[...sections.values()].filter((s) => !order.includes(s.id))];
  return list.map((s) => ({ ...s, rows: s.rows.filter((r) => matches(r, query, mac)) })).filter((s) => s.rows.length);
}
