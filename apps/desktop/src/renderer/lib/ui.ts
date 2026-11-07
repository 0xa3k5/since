// Small DOM toolkit: hyperscript, icons, toasts, dialogs, menus, command palette, virtual list.
import * as keymap from '../palette/keymap.ts';

/** What h() appends: nodes and text. Lists are flattened; null, undefined and false are skipped. */
export type Child = Node | string | number | false | null | undefined | readonly Child[];
/** An `on…` prop: a listener for that DOM event. Its target is the element the event happened on. */
type Handlers = { [K in keyof HTMLElementEventMap as `on${K}`]?: ((e: HTMLElementEventMap[K] & { target: Element }) => unknown) | null | false };
/** h()'s props: `class` adds classes, `style` sets styles, `html` sets innerHTML, `on…` adds listeners; any other key
 * sets the DOM property of that name, or else the attribute (true sets it empty; null and false skip it). */
export type Props = Handlers & {
  class?: string | null | false;
  style?: { [K in keyof CSSStyleDeclaration]?: string | number } | null;
  html?: string | null;
  [key: string]: unknown;
};
type TagName<S extends string> = S extends `${infer N}.${string}` ? N : S;
/** The element h(tag) makes: an HTMLInputElement for 'input.search', an HTMLElement when the tag isn't a literal. */
export type ElementOf<S extends string> = TagName<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagName<S>] : HTMLElement;

/** A popover's body: its head (or null), its list, and whether the list scrolls. */
export type PopContent = [Node | null, Node, boolean];
declare global {
  interface HTMLElement {
    /** Builds the popover of an element with `data-pop` (see Popovers below). */
    popContent?: () => PopContent | null | undefined;
  }
}

export function h<S extends string>(tag: S, props?: Props | null, ...children: Child[]): ElementOf<S> {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el as ElementOf<S>;
}

function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E | null => root.querySelector<E>(sel);
/** The element an event happened on, when it is one (not the document or the window). */
const elOf = (t: EventTarget | null): Element | null => (t && 'closest' in t ? t as Element : null);

// --- Icons (16px, 1.5 stroke) ---------------------------------------------
const P: Record<string, string> = {
  map: '<circle cx="4" cy="4" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="7" r="1.6"/><path d="M4 5.6v4.8M4 7c0 0 0 0 0 0M10.4 7.4C7 8 5 8.2 4 10.4"/>',
  commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
  stash: '<path d="M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M1.8 3h12.4v2.5H1.8zM6.5 8.5h3"/>',
  history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8L2.5 5.9"/><path d="M2.5 2.8v3.1h3.1M8 5.2V8l2 1.4"/>',
  submodule: '<rect x="2" y="2" width="12" height="12" rx="2"/><rect x="5.5" y="5.5" width="5" height="5" rx="1"/>',
  reflog: '<path d="M3 3.5h10M3 8h10M3 12.5h6"/>',
  config: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2.5-7 4.5"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  cloud: '<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7 1 2.5 2.5 0 0 1-.3 5z"/>',
  fetch: '<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"/>',
  pull: '<path d="M8 2.5v9M4.5 8 8 11.5 11.5 8"/>',
  push: '<path d="M8 13.5v-9M4.5 8 8 4.5 11.5 8"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m2.5 11.5 3.5-3 3 2.5 2-1.5 2.5 2"/>',
  play: '<path d="M5.5 3.5v9l7-4.5z"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  'check-circle': '<circle cx="8" cy="8" r="6.5"/><path d="m5.2 8.2 2 2 3.6-3.8"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  pending: '<circle cx="8" cy="8" r="4.5"/>',
  comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  chevronLeft: '<path d="m10 4-4 4 4 4"/>',
  chevronDown: '<path d="m4 6 4 4 4-4"/>',
  chevronUp: '<path d="m4 10 4-4 4 4"/>',
  undo: '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>',
  redo: '<path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.8 6.2 2 1.8-2 1.8M8.5 10h2.7"/>',
  expand: '<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.5"/>',
  edit: '<path d="M10.5 2.8 13.2 5.5 6 12.7l-3.2.5.5-3.2z"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 3 4 5.5 4"/>',
  rebase: '<circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><path d="M4.5 11V8.5a2 2 0 0 1 2-2h3a2 2 0 0 0 2-2V5"/>',
  cherry: '<circle cx="5" cy="11" r="2.5"/><circle cx="11" cy="11.5" r="2"/><path d="M5 8.5c.5-3 2.5-5 6-6M11 9.5c0-3-1-5-0-7"/>',
  revert: '<path d="M3.5 5.5h6.5a3 3 0 0 1 0 6H6"/><path d="m6 3-2.5 2.5L6 8"/>',
  squash: '<path d="M8 2v4M5.5 4 8 6.5 10.5 4M8 14v-4M5.5 12 8 9.5l2.5 2.5M3 8h10"/>',
  swap: '<path d="M5 2.5v11M2.5 11 5 13.5 7.5 11M11 13.5v-11M8.5 5 11 2.5 13.5 5"/>',
  checkout: '<path d="M3 8h7.5M7.5 4.5 11 8l-3.5 3.5M13.5 3v10"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  diff: '<path d="M4.5 2v6M1.5 5h6M8.5 11h6M11.5 2.5l-7 11"/>',
  sidebar: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>',
  panelRight: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>',
  warning: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  file: '<path d="M4 1.8h5l3 3V14H4z"/><path d="M9 1.8v3h3"/>',
  restore: '<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1"/><path d="M2.5 2.5v3h3"/>',
  command: '<path d="M5.5 5.5h5v5h-5z"/><path d="M5.5 5.5H4a1.5 1.5 0 1 1 1.5-1.5zM10.5 5.5V4A1.5 1.5 0 1 1 12 5.5zM10.5 10.5H12a1.5 1.5 0 1 1-1.5 1.5zM5.5 10.5V12A1.5 1.5 0 1 1 4 10.5z"/>',
  split: '<path d="M8 2v12M3 5h3M3 8h3M10 8h3M10 11h3"/>',
  theme: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.4M8 12.8v1.4M14.2 8h-1.4M3.2 8H1.8M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1"/>',
  moon: '<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z"/>',
  catchup: '<path d="M4.5 2.5v11"/><circle cx="4.5" cy="5" r="1.4"/><circle cx="4.5" cy="11" r="1.4"/><path d="M8 5h5.5M8 11h5.5"/>',
  lanes: '<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="5" cy="4" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="7" cy="12" r="1.3"/>',
  worktree: '<rect x="2" y="2.5" width="5.5" height="4" rx="1"/><rect x="8.5" y="9.5" width="5.5" height="4" rx="1"/><path d="M4.75 6.5v3.5a1.5 1.5 0 0 0 1.5 1.5H8.5"/>',
  update: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.6 2.4v2.9h-2.9M8 5.5v5M6 8.6l2 1.9 2-1.9"/>',
  sparkle: '<path d="M7 2.5 8.3 6.2 12 7.5 8.3 8.8 7 12.5 5.7 8.8 2 7.5 5.7 6.2z"/><path d="M12.5 10.5v3M11 12h3"/>',
  key: '<circle cx="5" cy="11" r="2.5"/><path d="m6.8 9.2 6-6M11 5l1.5 1.5"/>',
  checks: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.4M8 10.8v.1"/>',
  sendBack: '<path d="M6 9.5 2.5 6 6 2.5"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7.5"/>',
  github: '<path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>',
};

export function icon(name: string, size = 16): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

// The "Shift" brand mark (build/icon.svg master: half-discs r 92, gap 16, slide 32, 64% of the tile).
// Draws only the mark; the tile is the container's background.
export function brandMark(size: number): SVGSVGElement {
  const span = document.createElement('span');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 256 256" aria-hidden="true"><g transform="translate(128 128) scale(0.64) translate(-128 -128)"><path d="M20 118A92 92 0 0 1 204 118Z" fill="var(--brand-ink)"/><path d="M236 134A92 92 0 0 1 52 134Z" fill="var(--brand-cream)"/></g></svg>`;
  return span.firstElementChild as SVGSVGElement;
}

// --- Formatting --------------------------------------------------------------
const MIN = 60, HOUR = 3600, DAY = 86400;
/** `t` in Unix seconds. */
export function timeAgo(t: number): string {
  const d = Date.now() / 1000 - t;
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d`;
  const date = new Date(t * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
// "2h ago", but "just now" and "Oct 3" as they are.
export const ago = (t: number): string => { const s = timeAgo(t); return /^\d+[mhd]$/.test(s) ? `${s} ago` : s; };
export const fullDate = (t: number): string => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function hash(s: string): number { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return Math.abs(x); }
export function avatar(name: string, email?: string, size = 18): HTMLElement {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return h('span.avatar', { title: `${name} <${email}>`, style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px', background: `var(--lane-${hash(email || name) % 10})` } }, initials);
}

/** Someone in an avatar group. `open` runs when their popover row is picked; `sub` replaces the email under the name. */
export interface Person { name: string; email?: string; key?: string; agent?: boolean; sub?: string | null; open?: (() => void) | null }

// Overlapping avatars for [{ name, email }], at most `max`, then a +N chip. Who they are is in
// the group's popover (AK-535): people take the peoplePop fields (open, sub, agent).
export function avatarStack(people: Person[], size = 18, max = 3): HTMLElement {
  const rest = people.slice(max);
  const quiet = (el: HTMLElement) => { el.title = ''; return el; };
  const el = h('span.avatar-stack', { tabindex: '0', title: '', 'data-pop': '', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': people.map((p) => p.name).join(' and ') },
    people.slice(0, max).map((p) => { const a = quiet(avatar(p.name, p.email || p.key || p.name, size)); if (p.agent) a.classList.add('agent'); return a; }),
    rest.length ? h('span.avatar.more', { 'aria-hidden': 'true', style: { height: size + 'px', minWidth: size + 'px', fontSize: Math.round(size * 0.42) + 'px' } }, `+${rest.length}`) : null);
  el.popContent = () => peoplePop(people);
  return el;
}

// Popover order for [{ name, agent }]: agents first, then people; above 8 a count header shows
// and the list scrolls.
export const POP_ROWS = 8;
export function peopleOrder<T extends { agent?: boolean }>(people: T[] = []): { agents: T[]; humans: T[]; head: boolean } {
  const agents = people.filter((p) => p.agent), humans = people.filter((p) => !p.agent);
  return { agents, humans, head: people.length > POP_ROWS };
}

// The popover body for an avatar group: one row per person with their avatar, name and email (sub),
// or an "agent" tag. A row with `open` runs it when picked; the others are plain.
function peoplePop(people: Person[], label = 'Authors'): PopContent {
  const { agents, humans, head } = peopleOrder(people);
  const row = (p: Person) => {
    const a = avatar(p.name, p.email || p.key || p.name, 20);
    a.title = '';
    if (p.agent) a.classList.add('agent');
    const sub = p.agent ? h('span.pop-tag', null, 'agent') : (p.sub ?? p.email) ? h('span.pop-sub', null, p.sub ?? p.email) : null;
    const { open } = p;
    return h('button.pop-row', { type: 'button', tabindex: '-1', 'aria-disabled': open ? null : 'true', onclick: open ? () => { closePopover(); open(); } : null },
      a, h('span.pop-text', null, h('span.pop-name', null, p.name), sub));
  };
  const list = h('div.popover-list', { role: 'group', 'aria-label': label },
    agents.map(row), agents.length && humans.length ? h('div.popover-sep', { role: 'separator' }) : null, humans.map(row));
  if (head) {
    const edge = () => list.classList.toggle('fade', list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    list.addEventListener('scroll', edge);
    requestAnimationFrame(edge);
  }
  return [head ? h('div.popover-head', null, h('span', null, label), h('span.count', null, String(people.length))) : null, list, head];
}

// Quiet placeholder for slow loads (huge commits, big diffs). It fades in after a short delay,
// so fast loads never flash it.
export const loading = (label = 'Loading…'): HTMLElement => h('div.loading-state', { role: 'status', 'aria-live': 'polite' }, h('span.spinner'), h('span', null, label));

export const kbd = (...keys: string[]): HTMLElement => h('span.kbd-group', null, keys.map((k) => h('kbd', null, k)));

// --- Toasts --------------------------------------------------------------------
// `action` is one inline text link (Undo). `actions` is a choice: a row of buttons under the text
// (the first, or any with `primary`, is the primary one) plus a dismiss button; the title stays on one line.
// A toast with `actions` stays until the user does something else (a click or key outside it).
// Toasts group into one stack: the newest in front, up to two peeking behind it. Hovering or focusing
// the stack fans it out and holds every timer until the pointer or focus leaves.
export interface ToastAction { label: string; run: () => unknown; primary?: boolean }
export interface ToastOptions {
  kind?: 'info' | 'success' | 'warn' | 'error' | 'busy';
  action?: ToastAction | null;
  actions?: ToastAction[];
  /** Milliseconds before it closes (doubled for errors); 0 keeps it open. */
  timeout?: number;
  detail?: Child;
}
export interface Toast { close(): void; update(message: string): void }
interface Shown { el: HTMLElement; h: number; pause(): void; resume(): void }
const TOAST_GAP = 8, TOAST_PEEK = 8, TOAST_SHOWN = 3;
const toasts = new Set<Shown>();

function toastRoot(): HTMLElement {
  const root = $('#toasts');
  if (!root) throw new Error('index.html has no #toasts');
  if (root.dataset.stack) return root;
  root.dataset.stack = '1';
  const fan = (open: boolean) => {
    if (open === root.classList.contains('expanded')) return;
    root.classList.toggle('expanded', open);
    for (const t of toasts) open ? t.pause() : t.resume();
    layoutToasts(root);
  };
  const held = () => root.matches(':hover') || root.contains(document.activeElement);
  root.addEventListener('pointerover', () => fan(true));
  root.addEventListener('pointerleave', () => fan(held()));
  root.addEventListener('focusin', () => fan(true));
  root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget as Node | null)) fan(root.matches(':hover')); });
  return root;
}

function layoutToasts(root: HTMLElement): void {
  const live = [...toasts].reverse();
  if (!live.length) root.classList.remove('expanded');
  const open = root.classList.contains('expanded');
  let y = 0;
  live.forEach((t, i) => {
    t.el.style.setProperty('--i', String(i));
    t.el.style.setProperty('--y', `${y}px`);
    t.el.classList.toggle('front', i === 0);
    t.el.classList.toggle('buried', !open && i >= TOAST_SHOWN);
    t.el.inert = !open && i > 0;
    y += t.h + TOAST_GAP;
  });
  const front = live[0]?.h || 0;
  root.style.setProperty('--front-h', `${front}px`);
  root.style.height = `${open ? Math.max(0, y - TOAST_GAP) : front + TOAST_PEEK * Math.min(live.length - 1, TOAST_SHOWN - 1)}px`;
}

export function toast(message: string, { kind = 'info', action, actions = [], timeout = 4200, detail }: ToastOptions = {}): Toast {
  const root = toastRoot();
  const run = (a: ToastAction) => () => { a.run(); close(); };
  const choice = actions.length > 0;
  const primary = actions.find((a) => a.primary) || actions[0];
  const title = h('div.toast-title', null, message);
  const el = h('div.toast.' + kind + (choice ? '.choice' : ''), null,
    kind === 'error' || kind === 'warn' ? icon('warning') : kind === 'success' ? icon('check') : kind === 'busy' ? h('span.spinner') : null,
    h('div.toast-body', null, title, detail ? h('div.toast-detail', null, detail) : null,
      choice ? h('div.toast-actions', null, actions.map((a) => h('button.btn.small.' + (a === primary ? 'primary' : 'subtle'), { onclick: run(a) }, a.label))) : null),
    action ? h('button.toast-action', { onclick: run(action) }, action.label) : null,
    choice ? h('button.icon-btn.tiny.toast-close', { 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => close() }, icon('x', 12)) : null,
  );
  const measure = () => { el.style.height = 'auto'; t.h = el.offsetHeight; el.style.height = ''; el.style.setProperty('--h', `${t.h}px`); };
  let timer = 0, left = timeout && (kind === 'error' ? timeout * 2 : timeout), since = 0;
  const t: Shown = {
    el, h: 0,
    pause() { if (!timer) return; clearTimeout(timer); timer = 0; left -= Date.now() - since; },
    resume() { if (timer || !left || choice) return; since = Date.now(); timer = setTimeout(close, Math.max(left, 1200)); },
  };
  root.append(el);
  measure();
  toasts.add(t);
  layoutToasts(root);
  requestAnimationFrame(() => el.classList.add('in'));
  const elsewhere = (e: PointerEvent | KeyboardEvent) => { if (!el.contains(e.target as Node | null) && !('key' in e && MODIFIERS.has(e.key))) close(); };
  function close() {
    if (!toasts.delete(t)) return;
    clearTimeout(timer);
    removeEventListener('pointerdown', elsewhere, true); removeEventListener('keydown', elsewhere, true);
    el.classList.remove('in'); el.classList.add('out');
    layoutToasts(root);
    setTimeout(() => el.remove(), 180);
  }
  if (choice) setTimeout(() => { if (el.isConnected) { addEventListener('pointerdown', elsewhere, true); addEventListener('keydown', elsewhere, true); } });
  else if (!root.classList.contains('expanded')) t.resume();
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  return { close, update: (m) => { title.textContent = m; if (toasts.has(t)) { measure(); layoutToasts(root); } } };
}

const MODIFIERS = new Set(['Meta', 'Shift', 'Alt', 'Control', 'CapsLock']);

// --- Modal dialogs -------------------------------------------------------------
// `gate` names a checkbox field that must be ticked before submit is enabled ("merge anyway").
// `content`: elements shown above the fields (e.g. a list of what the action touches).
// A `required` text field left blank keeps the dialog open and marks the field.
// `alt`: a second way to submit (e.g. "Keep branch"); its result carries `alt: true`.
type Input = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
/** The dialog's inputs by field name, as an extra action (a `button` field) sees them. */
export type Inputs = Record<string, Input>;
export interface CheckboxField { type: 'checkbox'; name: string; label: string; value?: boolean }
/** An extra action inside the sheet (e.g. "Draft with AI"); `run` gets the live inputs. */
export interface ButtonField { type: 'button'; label: string; icon?: string; run: (inputs: Inputs) => unknown }
export interface SelectField {
  type: 'select'; name: string; label?: string; value?: string; options: { value: string; label: string }[];
  /** The line under the select for the current choice. */
  note?: (value: string) => { text?: string; warn?: boolean } | null | undefined;
}
export interface TextField {
  type?: 'text'; name: string; label?: string; value?: string; placeholder?: string;
  multiline?: boolean; rows?: number; readonly?: boolean; required?: boolean;
}
export type Field = CheckboxField | ButtonField | SelectField | TextField;
export interface DialogOptions<F> {
  title: string; description?: Child; content?: Child[]; fields?: readonly F[];
  submit?: string; destructive?: boolean; wide?: boolean; gate?: string | null | false; alt?: string | null;
}
/** What a dialog resolves to: each named field's value (a checkbox's is a boolean), and `alt` from the second submit. */
export type DialogResult<F> = { [E in Extract<F, { name: string }> as E['name']]: E extends CheckboxField ? boolean : string } & { alt?: true };

export function dialog<const F extends Field | null | false | undefined = Field>(
  { title, description, content = [], fields = [], submit = 'Continue', destructive = false, wide = false, gate, alt }: DialogOptions<F>,
): Promise<DialogResult<F> | null> {
  return new Promise((resolve) => {
    const inputs: Inputs = {};
    const prev = document.activeElement as HTMLElement | null;
    const all: readonly (Field | null | false | undefined)[] = fields;
    const list = all.filter((f): f is Field => Boolean(f));
    const send = (extra?: { alt: true }) => {
      const blank = list.find((f): f is TextField => (f.type === undefined || f.type === 'text') && !!f.required && !inputs[f.name]?.value.trim());
      if (blank) { inputs[blank.name]?.setAttribute('aria-invalid', 'true'); inputs[blank.name]?.focus(); return; }
      const values = Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' && 'checked' in el ? el.checked : el.value]);
      finish({ ...Object.fromEntries(values), ...extra } as DialogResult<F>);
    };
    let form: HTMLFormElement | null = null;
    const body = list.length || content.length ? h('div.dialog-body', null, ...content, ...list.map((f) => {
      if (f.type === 'checkbox') {
        const box = h('input', { type: 'checkbox', checked: !!f.value });
        inputs[f.name] = box;
        return h('label.check', null, box, h('span', null, f.label));
      }
      if (f.type === 'button') {
        const btn: HTMLButtonElement = h('button.btn.ghost', { type: 'button', onclick: async () => { btn.disabled = true; try { await f.run(inputs); } finally { btn.disabled = false; } } }, f.icon ? icon(f.icon) : null, f.label);
        return h('div.field', null, btn);
      }
      if (f.type === 'select') {
        const select = h('select.input', null, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
        inputs[f.name] = select;
        const noteOf = f.note;
        const note = noteOf ? h('div.field-note') : null;
        if (note && noteOf) {
          const sync = () => { const n = noteOf(select.value); note.textContent = n?.text || ''; note.classList.toggle('warn', Boolean(n?.warn)); };
          select.addEventListener('change', sync);
          sync();
        }
        return h('label.field', null, f.label ? h('span.field-label', null, f.label) : null, select, note);
      }
      const input: HTMLElement & (HTMLTextAreaElement | HTMLInputElement) = f.multiline
        ? h('textarea.input', { rows: f.rows || 6, placeholder: f.placeholder || '', value: f.value || '', spellcheck: false, readonly: f.readonly })
        : h('input.input', { type: 'text', placeholder: f.placeholder || '', value: f.value || '', spellcheck: false, autocomplete: 'off' });
      inputs[f.name] = input;
      const el: HTMLElement = input;
      if (f.multiline) el.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.submit') form?.requestSubmit(); });
      if (f.required) el.addEventListener('input', () => el.removeAttribute('aria-invalid'));
      return h('label.field', null, f.label ? h('span.field-label', null, f.label) : null, input);
    })) : null;
    const submitBtn = h('button.btn.' + (destructive ? 'danger' : 'primary'), { type: 'submit' }, submit, kbd('↵')) as HTMLButtonElement;
    form = h('form.dialog' + (wide ? '.wide' : ''), { onsubmit: (e) => { e.preventDefault(); send(); } },
      h('div.dialog-head', null, h('div.dialog-title', null, title), description ? h('div.dialog-desc', null, description) : null),
      body,
      h('div.dialog-foot', null,
        h('button.btn.ghost' + (alt ? '.sheet-cancel' : ''), { type: 'button', onclick: () => finish(null) }, 'Cancel', kbd(...(keymap.keys('dialog.cancel') ?? []))),
        alt ? h('button.btn.subtle', { type: 'button', onclick: () => send({ alt: true }) }, alt) : null,
        submitBtn,
      ),
    ) as HTMLFormElement;
    const gateBox = gate ? inputs[gate] : undefined;
    if (gateBox && 'checked' in gateBox) {
      const sync = () => { submitBtn.disabled = !gateBox.checked; };
      gateBox.addEventListener('change', sync);
      sync();
    }
    const overlay: HTMLElement = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) finish(null); } }, form);
    overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); finish(null); } });
    document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('in'));
    const first = Object.values(inputs).find((i) => i.type !== 'checkbox' && i.tagName !== 'SELECT');
    (first || form.querySelector<HTMLElement>('.btn.primary:not(:disabled), .btn.danger:not(:disabled)') || form.querySelector<HTMLElement>('.btn.ghost'))?.focus();
    if (first?.tagName === 'INPUT') (first as HTMLInputElement).select();
    function finish(v: DialogResult<F> | null) {
      overlay.classList.remove('in');
      setTimeout(() => overlay.remove(), 120);
      prev?.focus?.();
      resolve(v);
    }
  });
}

export const confirm = (title: string, description?: Child, { submit = 'Confirm', destructive = true }: { submit?: string; destructive?: boolean } = {}): Promise<boolean> =>
  dialog({ title, description, submit, destructive }).then((v) => v !== null);

export interface PromptOptions { label?: string; value?: string; placeholder?: string; submit?: string; description?: Child; multiline?: boolean }
export const prompt = (title: string, { label, value, placeholder, submit = 'Create', description, multiline }: PromptOptions = {}): Promise<string | null> =>
  dialog({ title, description, submit, fields: [{ name: 'v', label, value, placeholder, multiline }] }).then((v) => (v ? v.v.trim() : null));

// --- Resolve sheet --------------------------------------------------------------
// A blocked action, offered with fixes: `title` names the action, `reason` says in one line what's
// blocking it, `actions` fix the cause and then do it (the first is the primary, Enter). Optional
// `pick` ({ label, options, value }) chooses a target, e.g. "Switch to [main ▾]"; optional
// `checkbox` ({ label, checked }), e.g. "Stash 3 uncommitted changes". Resolves to
// { id, value, checked } for the chosen action, or null on Cancel / Escape.
export const ref = (name: string): HTMLElement => h('span.ref', null, name);

export interface SheetAction { id: string; label: string; primary?: boolean; danger?: boolean; sub?: string; confirm?: { note: string; label: string } | null }
// Footer order, left to right: secondary actions, then the primary (rightmost, Enter).
export function sheetActions<A extends SheetAction>(actions: readonly (A | null | false | undefined)[] = []): A[] {
  const list = actions.filter((a): a is A => Boolean(a)).map((a, i) => ({ ...a, primary: i === 0 && a.primary !== false }));
  return [...list.slice(1), ...list.slice(0, 1)];
}

export interface SheetOptions {
  title: string;
  reason?: string | null;
  rows?: readonly (readonly [Child, Child, (string | null)?])[] | null;
  lists?: readonly { title: string; rows: readonly (readonly [string, string, string, string])[]; more?: number }[] | null;
  forecast?: { text: string; ok: boolean } | null;
  actions?: readonly (SheetAction | null | false | undefined)[];
  pick?: { label?: string; options: { value: string; label?: string }[]; value?: string } | null;
  checkbox?: { label: string; checked?: boolean } | null;
  anchor?: HTMLElement | null;
}
export interface SheetResult { id: string; value?: string; checked?: boolean }

// `rows`: [[name, value, id?]] shown under the reason (what moved, say); a row with an id is a
// button that closes the sheet with that id. `lists`: [{ title, rows: [[sha, subject, author, age]], more }]
// commit lists (AK-585); `forecast`: { text, ok } the deciding fact under them. An action's `sub` is
// what you end up with, shown inside its button. An action with `confirm` ({ note, label }) asks once
// more in the footer before it resolves (force push). `anchor`: an element to open next to, as a
// non-modal panel (AK-598): nothing behind it dims, a click outside or Esc cancels, focus goes back.
export function resolveSheet({ title, reason, rows, lists, forecast, actions = [], pick, checkbox, anchor }: SheetOptions): Promise<SheetResult | null> {
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    let value = pick?.value ?? pick?.options?.[0]?.value;
    const labelOf = (v: string | undefined) => pick?.options.find((o) => o.value === v)?.label ?? v;
    const pickLabel = h('span', null, labelOf(value));
    const pickBtn: HTMLElement | null = pick ? h('button.btn.subtle.small.sheet-pick', {
      type: 'button', 'aria-haspopup': 'menu',
      onclick: () => {
        if (!pickBtn) return;
        const r = pickBtn.getBoundingClientRect();
        contextMenu(r.left, r.bottom + 4, pick.options.map((o) => ({
          label: o.label ?? o.value, icon: o.value === value ? 'check' : null,
          run: () => { value = o.value; pickLabel.textContent = labelOf(value) ?? ''; pickBtn.focus(); },
        })), { focus: Math.max(0, pick.options.findIndex((o) => o.value === value)) });
      },
    }, pickLabel, icon('chevronDown', 12)) : null;
    const box = checkbox ? h('input', { type: 'checkbox', checked: !!checkbox.checked }) : null;
    let confirming: SheetAction | null = null;
    const choose = (a: SheetAction) => (a.confirm && confirming !== a ? ask(a, a.confirm) : finish({ id: a.id, value, checked: box ? box.checked : undefined }));
    const ordered = sheetActions(actions);
    const primary = ordered.find((a) => a.primary);
    const pop = anchor?.isConnected && anchor.offsetParent ? anchor : null;
    const foot = h('div.dialog-foot', null, footButtons());
    const form = h('form.dialog.resolve-sheet' + (pop ? '.sheet-pop' : ''), { role: 'dialog', 'aria-modal': pop ? 'false' : 'true', onsubmit: (e) => { e.preventDefault(); if (confirming) choose(confirming); else if (primary) choose(primary); } },
      h('div.dialog-head', null,
        h('div.dialog-title', null, title),
        reason ? h('div.sheet-reason', null, icon('warning', 14), h('span', null, reason)) : null),
      pick || checkbox || rows?.length || lists?.length || forecast ? h('div.dialog-body', null,
        lists?.length ? lists.map((l) => h('div.sheet-list', null,
          h('div.sheet-list-title', null, l.title),
          h('div.sheet-rows', null, l.rows.map(([sha, subject, author, age]) => h('div.sheet-row.sheet-commit', null,
            h('span.sheet-sha', null, sha), h('span.sheet-row-name', null, subject), h('span.sheet-row-value', null, author), h('span.sheet-row-value', null, age))),
          l.more ? h('div.sheet-row.sheet-more', null, `+${l.more} more`) : null))) : null,
        forecast ? h('div.sheet-forecast' + (forecast.ok ? '.ok' : '.warn'), null, icon(forecast.ok ? 'check' : 'warning', 14), h('span', null, forecast.text)) : null,
        rows?.length ? h('div.sheet-rows', null, rows.map(([name, value, id]) => id
          ? h('button.sheet-row.sheet-row-link', { type: 'button', onclick: () => finish({ id }) }, h('span.sheet-row-name', null, name), h('span.sheet-row-value', null, value))
          : h('div.sheet-row', null, h('span.sheet-row-name', null, name), h('span.sheet-row-value', null, value)))) : null,
        pick ? h('div.sheet-pick-row', null, pick.label ? h('span', null, pick.label) : null, pickBtn) : null,
        checkbox ? h('label.check', null, box, h('span', null, checkbox.label)) : null) : null,
      foot,
    );
    function footButtons(): HTMLElement[] {
      return [h('button.btn.ghost.sheet-cancel', { type: 'button', onclick: () => finish(null) }, 'Cancel', kbd(...(keymap.keys('dialog.cancel') ?? []))),
        ...ordered.map((a) => {
          const cls = 'button.btn.' + (a.danger ? 'danger' : a.primary ? 'primary' : 'subtle');
          return a.primary ? h(cls, { type: 'submit' }, a.label, kbd('↵')) : h(cls, { type: 'button', onclick: () => choose(a) }, a.label);
        })];
    }
    // The irreversible action's second step: its note, Back, and the action itself (Enter).
    function ask(a: SheetAction, confirm: { note: string; label: string }) {
      confirming = a;
      foot.replaceChildren(h('span.sheet-confirm-note', null, confirm.note),
        h('button.btn.ghost', { type: 'button', onclick: () => { confirming = null; foot.replaceChildren(...footButtons()); foot.querySelector<HTMLElement>('button[type=submit], .btn.subtle')?.focus(); } }, 'Back'),
        h('button.btn.danger', { type: 'submit' }, confirm.label, kbd('↵')));
      foot.querySelector<HTMLElement>('.btn.danger')?.focus();
    }
    const cancelKey = (e: KeyboardEvent) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); finish(null); } };
    const outside = (e: PointerEvent) => { const t = e.target as Node | null; if (!form.contains(t) && !elOf(t)?.closest('.menu')) finish(null); };
    let overlay: HTMLElement | null = null;
    if (pop) {
      form.addEventListener('keydown', cancelKey);
      document.body.append(form);
      placeSheet(form, pop);
      pop.classList.add('is-open');
      addEventListener('pointerdown', outside, true);
      requestAnimationFrame(() => form.classList.add('in'));
    } else {
      const o: HTMLElement = h('div.overlay', { onmousedown: (e) => { if (e.target === o) finish(null); } }, form);
      overlay = o;
      o.addEventListener('keydown', cancelKey);
      document.body.append(o);
      requestAnimationFrame(() => o.classList.add('in'));
    }
    (form.querySelector<HTMLElement>('button[type=submit]') || form.querySelector<HTMLElement>('.sheet-row-link') || form.querySelector<HTMLElement>('.sheet-cancel'))?.focus();
    function finish(v: SheetResult | null) {
      closeMenu();
      if (pop) {
        removeEventListener('pointerdown', outside, true);
        pop.classList.remove('is-open');
        form.remove();
        if (pop.isConnected) pop.focus();
      } else if (overlay) {
        const o = overlay;
        o.classList.remove('in');
        setTimeout(() => o.remove(), 120);
        prev?.focus?.();
      }
      resolve(v);
    }
  });
}

// Next to `anchor`: below it, or above it when it sits in the lower half (the sidebar's Pull and
// Push), kept inside the window.
function placeSheet(el: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  const up = r.top > innerHeight / 2;
  el.classList.toggle('up', up);
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8)) + 'px';
  if (up) el.style.bottom = Math.max(8, innerHeight - r.top + 8) + 'px';
  else el.style.top = Math.min(r.bottom + 8, Math.max(8, innerHeight - t.height - 8)) + 'px';
}

// --- Context menu ---------------------------------------------------------------
/** A context-menu row. `lead` replaces the icon; `why` is a greyed item's reason; `submenu` opens beside it. */
export interface MenuItem {
  label: string; run?: (() => unknown) | null; icon?: string | null; lead?: Node | null; kbd?: string | readonly string[] | null;
  disabled?: boolean; danger?: boolean; gated?: boolean; why?: string | null; submenu?: readonly MenuEntry[] | null;
}
/** A menu entry: an item, a section heading, or '-' for a separator. Null and false are skipped. */
export type MenuEntry = MenuItem | { section: string } | '-' | null | false | undefined;
interface Level { el: HTMLElement; actionable: HTMLElement[]; idx: number; owner: HTMLElement | null }
interface Point { x: number; y: number }
let openMenu: { trigger: Element | null; close(): void; cleanup(): void } | null = null;
// The button just clicked (by pointer, ↵ or Space) until the next press: the trigger of a menu
// opened from it.
let pressed: Element | null = null;
if (typeof document !== 'undefined') {
  for (const ev of ['mousedown', 'keydown', 'contextmenu']) document.addEventListener(ev, () => { pressed = null; }, true);
  document.addEventListener('click', (e) => { pressed = elOf(e.target)?.closest('button, [role="button"]') || null; }, true);
}
// Where the last chosen menu item was, so a question about it can open on the same spot.
let anchor: Point | null = null;
export const menuAnchor = (): Point | null => anchor;
// `focus`: index of the actionable item highlighted on open, so Enter picks it (a popover's default).
// An item with `submenu` (items) opens them in a menu beside it: on hover, click, → or Enter; ← or
// Esc closes it again. While the pointer heads for an open submenu across other rows, the switch
// waits a moment so a diagonal move doesn't close it.
// `trigger`: the button it opens from (by default the one just clicked or pressed). Clicking or
// pressing it again closes the menu: pressing it doesn't count as a click outside, so the click
// that follows closes the menu rather than reopening it.
export function contextMenu(x: number, y: number, items: readonly MenuEntry[], { focus = -1, trigger = pressed }: { focus?: number; trigger?: Element | null } = {}): void {
  if (trigger && openMenu?.trigger === trigger) return closeMenu();
  closeMenu();
  const levels: Level[] = []; // open menus, root first
  let cur = 0; // the level the keys move through
  let hoverT = 0;
  let pts: Point[] = [];
  const closeFrom = (d: number) => {
    while (levels.length > d) {
      const l = levels.pop();
      l?.el.remove();
      if (l?.owner) { l.owner.classList.remove('open'); l.owner.setAttribute('aria-expanded', 'false'); }
    }
    cur = Math.min(cur, levels.length - 1);
  };
  function focusItem(d: number, i: number) {
    const l = levels[d];
    if (!l) return;
    l.actionable.forEach((a) => a.classList.remove('active'));
    l.idx = i;
    l.actionable[i]?.classList.add('active');
  }
  // Opens item `el`'s submenu (level d + 1) beside it, unless it's already open.
  function openSub(d: number, el: HTMLElement, it: MenuItem, { keys = false } = {}) {
    const parent = levels[d];
    if (!parent || !it.submenu) return;
    if (levels[d + 1]?.owner !== el) {
      closeFrom(d + 1);
      const r = el.getBoundingClientRect();
      const pr = parent.el.getBoundingClientRect();
      const sub = build(it.submenu, d + 1, el);
      const sr = sub.el.getBoundingClientRect();
      const left = pr.right + 2 + sr.width > innerWidth - 8 ? pr.left - sr.width - 2 : pr.right + 2;
      sub.el.style.left = Math.max(8, left) + 'px';
      sub.el.style.top = Math.max(8, Math.min(r.top - 4, innerHeight - sr.height - 8)) + 'px';
      el.classList.add('open');
      el.setAttribute('aria-expanded', 'true');
    }
    if (keys) { cur = d + 1; focusItem(d + 1, 0); }
  }
  // Is the pointer moving towards level d + 1 (inside the triangle from its last spot to the
  // submenu's near edge)?
  function aiming(d: number): boolean {
    const sub = levels[d + 1];
    const [a, p] = pts;
    if (!sub || !a || !p) return false;
    const r = sub.el.getBoundingClientRect();
    const ex = r.left >= a.x ? r.left : r.right;
    const side = (p1: Point, p2: Point, q: Point) => (p2.x - p1.x) * (q.y - p1.y) - (p2.y - p1.y) * (q.x - p1.x);
    const t = { x: ex, y: r.top - 8 }, b = { x: ex, y: r.bottom + 8 };
    const s1 = side(a, t, p), s2 = side(t, b, p), s3 = side(b, a, p);
    return !((s1 < 0 || s2 < 0 || s3 < 0) && (s1 > 0 || s2 > 0 || s3 > 0));
  }
  function build(list: readonly MenuEntry[], d: number, owner: HTMLElement | null): Level {
    const menu = h('div.menu' + (d ? '.submenu' : ''), { role: 'menu' });
    const level: Level = { el: menu, actionable: [], idx: -1, owner };
    levels[d] = level;
    for (const it of list) {
      if (!it) continue;
      if (it === '-') { menu.append(h('div.menu-sep')); continue; }
      if ('section' in it) { menu.append(h('div.menu-section', null, it.section)); continue; }
      const el: HTMLElement = h('button.menu-item' + (it.danger ? '.danger' : '') + (it.gated ? '.gated' : ''), {
        disabled: it.disabled,
        'aria-haspopup': it.submenu ? 'menu' : null,
        'aria-expanded': it.submenu ? 'false' : null,
        onclick: () => {
          if (it.submenu) return openSub(d, el, it, { keys: true });
          const r = el.getBoundingClientRect();
          anchor = { x: r.left, y: r.top };
          closeMenu();
          it.run?.();
          setTimeout(() => { anchor = null; });
        },
        onmouseenter: () => {
          clearTimeout(hoverT);
          const go = () => {
            cur = d;
            focusItem(d, level.actionable.indexOf(el));
            if (it.submenu) openSub(d, el, it);
            else closeFrom(d + 1);
          };
          if (aiming(d)) hoverT = setTimeout(go, 300);
          else go();
        },
      }, it.lead || (it.icon ? icon(it.icon) : h('span.icon')),
      // `why`: a greyed item's reason, a few words under its label.
      it.why ? h('span.menu-label', null, it.label, h('small.menu-why', null, it.why)) : h('span.menu-label', null, it.label),
      it.kbd?.length ? kbd(...([] as string[]).concat(it.kbd)) : null,
      it.submenu ? h('span.menu-chev', null, icon('chevron', 12)) : null);
      if (!it.disabled) level.actionable.push(el);
      menu.append(el);
    }
    menu.addEventListener('mousemove', (e) => { pts = [pts[1] || { x: e.clientX, y: e.clientY }, { x: e.clientX, y: e.clientY }]; });
    // Back on the submenu: its row in the parent stays the highlighted one.
    if (owner) menu.addEventListener('mouseenter', () => { clearTimeout(hoverT); focusItem(d - 1, levels[d - 1]?.actionable.indexOf(owner) ?? -1); });
    document.body.append(menu);
    return level;
  }
  const root = build(items, 0, null);
  const r = root.el.getBoundingClientRect();
  root.el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  root.el.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  if (focus >= 0) focusItem(0, focus);
  const onKey = (e: KeyboardEvent) => {
    const id = keymap.match('dialog', e);
    const l = levels[cur];
    if (!l) return;
    const n = l.actionable.length;
    const it = l.actionable[l.idx];
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (id === 'dialog.cancel') { stop(); if (cur > 0) { closeFrom(cur); } else closeMenu(); }
    else if (id === 'menu.back' && cur > 0) { stop(); closeFrom(cur); }
    else if (id === 'menu.open' && it?.getAttribute('aria-haspopup')) { stop(); it.click(); }
    else if (id === 'menu.next') { stop(); focusItem(cur, (l.idx + 1) % n); }
    else if (id === 'menu.prev') { stop(); focusItem(cur, (l.idx - 1 + n) % n); }
    else if (id === 'menu.choose' && it) { stop(); it.click(); }
  };
  const inside = (t: Node | null) => levels.some((l) => l.el.contains(t));
  const onDown = (e: MouseEvent) => { const t = e.target as Node | null; if (!inside(t) && !(e.button === 0 && trigger?.contains(t))) closeMenu(); };
  window.addEventListener('keydown', onKey, true);
  // Deferred so the press that opened the menu doesn't close it. A menu closed before then (Esc, or another menu at
  // once) clears the timer: a late listener would outlive it and close every later menu on its first press.
  const listen = setTimeout(() => window.addEventListener('mousedown', onDown, true));
  window.addEventListener('blur', closeMenu);
  const owns = trigger?.hasAttribute('aria-haspopup');
  if (owns) trigger?.setAttribute('aria-expanded', 'true');
  openMenu = { trigger, close: () => { clearTimeout(hoverT); closeFrom(0); if (owns) trigger?.setAttribute('aria-expanded', 'false'); }, cleanup: () => { clearTimeout(listen); window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown, true); window.removeEventListener('blur', closeMenu); } };
}
export function closeMenu(): void {
  if (!openMenu) return;
  openMenu.cleanup();
  openMenu.close();
  openMenu = null;
}

// --- Tooltips ---------------------------------------------------------------
// Icon-only buttons carry their name and key in `data-tip` (see tipFor): shown on hover after a
// moment and at once on keyboard focus, kept inside the window. One tooltip at a time.
export const tipFor = (label: string, keyId?: string | null): string => [label, keyId ? (keymap.keys(keyId) ?? []).join('') : ''].filter(Boolean).join('  ');
let tipEl: HTMLElement | null = null;
let tipTimer = 0;
let tipTarget: Element | null = null;
function showTip(target: HTMLElement) {
  const text = target.dataset.tip;
  if (!text || !target.isConnected) return;
  tipEl ||= h('div.tooltip', { role: 'tooltip' });
  tipEl.textContent = text;
  document.body.append(tipEl);
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const below = r.bottom + 6 + t.height < innerHeight - 4;
  tipEl.style.left = Math.max(4, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 4)) + 'px';
  tipEl.style.top = (below ? r.bottom + 6 : r.top - 6 - t.height) + 'px';
  tipTarget = target;
}
function hideTip() { clearTimeout(tipTimer); tipEl?.remove(); tipTarget = null; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerover', (e) => {
    const t = elOf(e.target)?.closest<HTMLElement>('[data-tip]') ?? null;
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    if (!t.hasAttribute('title')) t.setAttribute('title', ''); // no native tooltip from a titled row around it
    tipTimer = setTimeout(() => showTip(t), 450);
  });
  document.addEventListener('focusin', (e) => {
    const t = elOf(e.target)?.closest<HTMLElement>('[data-tip]');
    hideTip();
    if (t && t.matches(':focus-visible')) showTip(t);
  });
  // Any key hides it (Tab shows the next one on focus).
  for (const ev of ['focusout', 'pointerdown', 'scroll', 'keydown']) document.addEventListener(ev, hideTip, true);
}

// --- Popovers ----------------------------------------------------------------
// Richer than a tooltip (AK-535): an element with `data-pop` and a `popContent()` builder opens a
// small panel on hover after the tooltip delay, or on click, ↵ or ↓ with its rows focused (the
// dialog keys: ↑↓ move, Esc closes). It stays open while the pointer is over the element or the
// panel; a click elsewhere or focus leaving closes it. One at a time, kept inside the window.
// held: opened by click or key, so leaving with the pointer keeps it
let pop: { el: HTMLElement; target: HTMLElement; held: boolean } | null = null;
let popTimer = 0, popLeave = 0;
const popRows = (): HTMLElement[] => [...(pop?.el.querySelectorAll<HTMLElement>('.pop-row') || [])];
function placePop(el: HTMLElement, target: HTMLElement) {
  const r = target.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  const below = r.bottom + 6 + t.height < innerHeight - 4;
  el.style.left = Math.max(4, Math.min(r.left, innerWidth - t.width - 4)) + 'px';
  el.style.top = Math.max(4, below ? r.bottom + 6 : r.top - 6 - t.height) + 'px';
}
function popKeys(e: KeyboardEvent) {
  e.stopPropagation(); // the list underneath keeps its keys
  const rows = popRows(), at = rows.indexOf(document.activeElement as HTMLElement);
  const id = keymap.match('dialog', e);
  if (id === 'dialog.cancel') { e.preventDefault(); closePopover({ refocus: true }); }
  else if (id === 'menu.next') { e.preventDefault(); rows[(at + 1) % rows.length]?.focus(); }
  else if (id === 'menu.prev') { e.preventDefault(); rows[at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length]?.focus(); }
}
function openPopover(target: HTMLElement, { held = false, focus = false } = {}) {
  clearTimeout(popTimer); clearTimeout(popLeave);
  if (pop?.target !== target) {
    closePopover();
    const built = target.popContent?.();
    if (!built || !target.isConnected) return;
    const [head, list, scrolls] = built;
    hideTip();
    const el = h('div.popover' + (scrolls ? '.scrolls' : ''), { role: 'dialog', 'aria-label': target.getAttribute('aria-label') || '', onkeydown: popKeys }, head, list);
    document.body.append(el);
    placePop(el, target);
    target.classList.add('is-open');
    target.setAttribute('aria-expanded', 'true');
    pop = { el, target, held };
  }
  pop.held ||= held;
  if (focus) popRows()[0]?.focus();
}
function closePopover({ refocus = false } = {}) {
  clearTimeout(popTimer); clearTimeout(popLeave);
  if (!pop) return;
  const { el, target } = pop;
  pop = null;
  el.remove();
  target.classList.remove('is-open');
  target.setAttribute('aria-expanded', 'false');
  if (refocus && target.isConnected) target.focus();
}
if (typeof document !== 'undefined') {
  const inPop = (n: EventTarget | null) => !!pop && (pop.el.contains(n as Node | null) || pop.target.contains(n as Node | null));
  const popOf = (e: Event) => elOf(e.target)?.closest<HTMLElement>('[data-pop]') ?? null;
  document.addEventListener('pointerover', (e) => {
    if (inPop(e.target)) { clearTimeout(popLeave); return; }
    const t = popOf(e);
    clearTimeout(popTimer);
    if (pop && !pop.held) popLeave = setTimeout(() => closePopover(), 150);
    if (t) popTimer = setTimeout(() => { if (!pop?.held) openPopover(t); }, 450);
  });
  // A group's click is its own: it doesn't select or open the row around it.
  for (const ev of ['mousedown', 'dblclick']) {
    document.addEventListener(ev, (e) => { if (popOf(e)) e.stopPropagation(); }, true);
  }
  document.addEventListener('click', (e) => {
    const t = popOf(e);
    if (t) { e.stopPropagation(); e.preventDefault(); if (pop?.target === t && pop.held) closePopover(); else openPopover(t, { held: true }); }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (pop && !inPop(e.target)) closePopover(); }, true);
  document.addEventListener('keydown', (e) => {
    const t = popOf(e);
    if (!t || e.target !== t) return;
    const id = keymap.match('dialog', e);
    if (id === 'menu.choose' && pop?.target === t && pop.held) { e.preventDefault(); e.stopPropagation(); closePopover(); }
    else if (id === 'menu.choose' || id === 'menu.next') { e.preventDefault(); e.stopPropagation(); openPopover(t, { held: true, focus: true }); }
    else if (id === 'dialog.cancel' && pop?.target === t) { e.preventDefault(); e.stopPropagation(); closePopover(); }
  }, true);
  document.addEventListener('focusout', (e) => {
    if (pop && inPop(e.target) && !inPop(e.relatedTarget)) closePopover();
  });
  document.addEventListener('scroll', (e) => { if (pop && !pop.el.contains(e.target as Node | null)) closePopover(); }, true);
}

// --- Command palette ---------------------------------------------------------------
function fuzzy(q: string, s: string): number {
  if (!q) return 1;
  q = q.toLowerCase(); s = s.toLowerCase();
  const direct = s.indexOf(q);
  if (direct !== -1) return 1000 - direct - s.length * 0.01;
  let score = 0, j = 0, streak = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { j++; streak++; score += streak * 2 + (i === 0 || s[i - 1] === ' ' || s[i - 1] === '/' ? 6 : 0); } else streak = 0;
  }
  return j === q.length ? score : 0;
}

/** A ⌘K row. `keywords` match but don't show; `detail` shows after the label. */
export interface PaletteItem {
  label: string; run: () => unknown; group?: string | null; keywords?: string | null; icon?: string | null;
  detail?: Child; kbd?: string | readonly string[] | null; gated?: boolean;
}
let closeOpenPalette: (() => void) | null = null;
// Closes the open palette, if any (its key toggles it). True when one was open.
export function closePalette(): boolean {
  if (!closeOpenPalette) return false;
  closeOpenPalette();
  return true;
}
export function palette(getItems: () => PaletteItem[], { placeholder = 'Type a command or search…', onDismiss }: { placeholder?: string; onDismiss?: () => void } = {}): { refresh(): void } | null {
  if ($('.palette-overlay:not(.closing)')) return null;
  const prev = document.activeElement as HTMLElement | null;
  const input = h('input.palette-input', { placeholder, spellcheck: false, autocomplete: 'off' });
  const list = h('div.palette-list');
  const box = h('div.palette', null, h('div.palette-head', null, icon('search'), input), list);
  const overlay: HTMLElement = h('div.overlay.palette-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  let results: PaletteItem[] = [], idx = 0;
  let all = getItems();
  function render() {
    const q = input.value.trim();
    results = all
      .map((it) => ({ it, s: fuzzy(q, (it.group || '') + ' ' + it.label + ' ' + (it.keywords || '')) * (fuzzy(q, it.label) ? 2 : 1) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .slice(0, 60)
      .map((r) => r.it);
    idx = Math.min(idx, Math.max(0, results.length - 1));
    list.replaceChildren();
    let group: string | null | undefined = null;
    results.forEach((it, i) => {
      if (!q && it.group !== group) { group = it.group; list.append(h('div.palette-group', null, group)); }
      const row = h('div.palette-item' + (i === idx ? '.active' : '') + (it.gated ? '.gated' : ''), {
        onmousemove: () => { if (idx !== i) { idx = i; mark(); } },
        onclick: () => choose(i),
      }, icon(it.icon || 'command'), h('span.palette-label', null, it.label), it.detail ? h('span.palette-detail', null, it.detail) : null, it.kbd?.length ? kbd(...([] as string[]).concat(it.kbd)) : null);
      list.append(row);
    });
    if (!results.length) list.append(h('div.palette-empty', null, 'No results'));
  }
  function mark() {
    list.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('active', i === idx));
    list.querySelectorAll('.palette-item')[idx]?.scrollIntoView({ block: 'nearest' });
  }
  function choose(i: number) { const it = results[i]; close(Boolean(it)); if (it) setTimeout(() => it.run(), 0); }
  function close(picked?: boolean) { closeOpenPalette = null; overlay.classList.remove('in'); overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 100); prev?.focus?.(); if (!picked) onDismiss?.(); }
  input.addEventListener('input', () => { idx = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const id = keymap.match('dialog', e);
    if (id === 'menu.next') { e.preventDefault(); idx = Math.min(idx + 1, results.length - 1); mark(); }
    else if (id === 'menu.prev') { e.preventDefault(); idx = Math.max(idx - 1, 0); mark(); }
    else if (id === 'menu.choose') { e.preventDefault(); choose(idx); }
    else if (id === 'dialog.cancel') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  document.body.append(overlay);
  closeOpenPalette = () => close();
  render();
  requestAnimationFrame(() => overlay.classList.add('in'));
  input.focus();
  // refresh(): re-read the items (e.g. once async entries arrive) and keep the typed query.
  return { refresh: () => { if (overlay.isConnected && !overlay.classList.contains('closing')) { all = getItems(); render(); } } };
}

// --- Virtual list -----------------------------------------------------------------
// Browsers cannot lay out arbitrarily tall elements (Chromium tops out near 33.5M px, about a
// million 32px rows). Past MAX_SCROLL the scrollbar is scaled: scrollTop maps proportionally onto
// the list's virtual height, and rows are positioned relative to the viewport.
export const MAX_SCROLL = 1 << 24;

export interface ScrollMap { spacer: number; scale: number; toVirtual(top: number): number; toScroll(v: number): number }
// Virtual offset (px into the full list) for a scrollTop, and back.
export function scrollMap(count: number, rowHeight: number, viewport: number): ScrollMap {
  const full = count * rowHeight;
  const spacer = Math.min(full, MAX_SCROLL);
  const scale = full > spacer && spacer > viewport ? (full - viewport) / (spacer - viewport) : 1;
  return { spacer, scale, toVirtual: (top) => top * scale, toScroll: (v) => v / scale };
}

/** The rows a VirtualList shows: first and last index, and the viewport's top (virtual px) and height. */
export interface VisibleRange { first: number; last: number; top: number; height: number }
export interface VirtualListOptions { rowHeight: number; render: (i: number) => HTMLElement; onScroll?: (range: VisibleRange) => void; overscan?: number }

// Renders only visible rows; recycles row elements by index.
export class VirtualList {
  el: HTMLElement;
  rowHeight: number;
  render: (i: number) => HTMLElement;
  onScroll: ((range: VisibleRange) => void) | undefined;
  overscan: number;
  count = 0;
  mapH = 0;
  map: ScrollMap;
  shift = 0;
  spacer: HTMLElement;
  layer: HTMLElement;
  rows = new Map<number, HTMLElement>();
  frame = 0;
  ro: ResizeObserver;
  constructor(container: HTMLElement, { rowHeight, render, onScroll, overscan = 8 }: VirtualListOptions) {
    this.el = container;
    this.rowHeight = rowHeight;
    this.render = render;
    this.onScroll = onScroll;
    this.overscan = overscan;
    this.map = scrollMap(0, rowHeight, 0);
    this.spacer = h('div.vl-spacer');
    this.layer = h('div.vl-layer');
    this.el.append(this.spacer, this.layer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.el);
  }
  // `keep` leaves rendered rows alone (rows were only appended).
  setCount(n: number, { keep = false } = {}): void {
    this.count = n;
    this.mapH = this.el.clientHeight;
    this.map = scrollMap(n, this.rowHeight, this.mapH);
    this.spacer.style.height = this.map.spacer + 'px';
    if (keep) this.schedule(); else this.invalidate();
  }
  invalidate(): void { for (const [, el] of this.rows) el.remove(); this.rows.clear(); this.schedule(); }
  schedule(): void { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); }); }
  range(): VisibleRange {
    const hgt = this.el.clientHeight;
    const top = this.map.toVirtual(this.el.scrollTop);
    const first = Math.max(0, Math.floor(top / this.rowHeight) - this.overscan);
    const last = Math.min(this.count - 1, Math.ceil((top + hgt) / this.rowHeight) + this.overscan);
    return { first, last, top, height: hgt };
  }
  place(i: number, el: HTMLElement): void { el.style.transform = `translateY(${i * this.rowHeight - this.shift}px)`; }
  update(): void {
    if (this.el.clientHeight !== this.mapH) { this.mapH = this.el.clientHeight; this.map = scrollMap(this.count, this.rowHeight, this.mapH); }
    const { first, last, top, height } = this.range();
    const shift = top - this.el.scrollTop;
    for (const [i, el] of this.rows) if (i < first || i > last) { el.remove(); this.rows.delete(i); }
    if (shift !== this.shift) { this.shift = shift; for (const [i, el] of this.rows) this.place(i, el); }
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const el = this.render(i);
      this.place(i, el);
      el.style.height = this.rowHeight + 'px';
      this.rows.set(i, el);
      frag.append(el);
    }
    this.layer.append(frag);
    this.onScroll?.({ first, last, top, height });
  }
  refreshRow(i: number): void { const el = this.rows.get(i); if (el) { el.remove(); this.rows.delete(i); this.schedule(); } }
  scrollToIndex(i: number, align: 'nearest' | 'center' = 'nearest'): void {
    const y = i * this.rowHeight, top = this.map.toVirtual(this.el.scrollTop), hgt = this.el.clientHeight;
    let v: number | null = null;
    if (align === 'center') v = y - hgt / 2 + this.rowHeight / 2;
    else if (y < top) v = y;
    else if (y + this.rowHeight > top + hgt) v = y + this.rowHeight - hgt;
    if (v !== null) this.el.scrollTop = this.map.toScroll(Math.max(0, v));
  }
  destroy(): void { this.ro.disconnect(); cancelAnimationFrame(this.frame); }
}
