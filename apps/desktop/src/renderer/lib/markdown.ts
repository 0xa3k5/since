import { h, type Child } from './ui.ts';

// Markdown in commit messages and PR descriptions (AK-399), shown as prose. A small subset, cheap
// to parse, and never HTML: everything is built as DOM nodes, so a message can't inject markup.
//  - Blocks: paragraphs, # headings, - * + and 1. lists (with [ ] / [x] tasks), > quotes, ``` code
//    fences, --- rules. Line breaks inside a paragraph stay (wrapped commit bodies, trailers).
//  - Inline: `code`, **bold**, *italic* / _italic_, ~~struck~~, [links](https://…) and bare
//    https:// links. Links open in the browser; images show as a link with their alt text.
//  - Anything else (tables, raw HTML) stays as the plain text it was.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+/;

export interface ListItem { text: string; checked?: boolean }
export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'ul' | 'ol'; start: number; items: ListItem[] };
export type Inline =
  | { t: 'text'; text: string }
  | { t: 'br' }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] };

// src → blocks: { type: 'p' | 'h' | 'code' | 'quote' | 'ul' | 'ol' | 'hr', … }.
export function parse(src: unknown = ''): Block[] {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const at = (k: number) => lines[k] ?? '';
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) { i++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const mark = fence[1] ?? '```';
      const close = new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`);
      const code: string[] = [];
      for (i++; i < lines.length && !close.test(at(i)); i++) code.push(at(i));
      i++;
      blocks.push({ type: 'code', lang: fence[2] || '', text: code.join('\n') });
      continue;
    }
    const head = line.match(HEADING);
    if (head) { blocks.push({ type: 'h', level: (head[1] ?? '').length, text: head[2] ?? '' }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(at(i)); i++) inner.push(at(i).replace(QUOTE, ''));
      blocks.push({ type: 'quote', blocks: parse(inner.join('\n')) });
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      const marker = item[2] ?? '';
      const ordered = /\d/.test(marker);
      const items: ListItem[] = [];
      for (; i < lines.length; i++) {
        const l = at(i);
        const m = l.match(ITEM);
        const last = items[items.length - 1];
        if (m && /\d/.test(m[2] ?? '') === ordered && (m[1] ?? '').length <= (item[1] ?? '').length + 1) {
          const body = m[3] ?? '';
          const task = body.match(TASK);
          items.push({ text: task ? body.slice(task[0].length) : body, ...(task ? { checked: task[1] !== ' ' } : {}) });
        } else if (l.trim() && /^\s/.test(l) && last) {
          // An indented line carries on the item above (or is a nested item: kept as its text).
          last.text += '\n' + l.trim();
        } else break;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', start: ordered ? parseInt(marker, 10) : 1, items });
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && at(i).trim(); i++) {
      const l = at(i);
      if (para.length && (FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || ITEM.test(l))) break;
      para.push(l.trim());
    }
    blocks.push({ type: 'p', text: para.join('\n') });
  }
  return blocks;
}

// _ inside a word (snake_case) isn't emphasis: the lookbehind skips it in the regex itself, so the
// parse stays linear on identifier-heavy text (AK-406).
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|(\*\*|__)(?=\S)([\s\S]*?\S)\3|(\*|(?<!\w)_)(?=\S)([\s\S]*?\S)\5(?![\w*])|~~(?=\S)([\s\S]*?\S)~~|(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~])/;

// text → inline nodes: { t: 'text' | 'br' | 'code' | 'strong' | 'em' | 'del' | 'link', … }.
export function inline(text: unknown = ''): Inline[] {
  const out: Inline[] = [];
  let rest = String(text);
  const plain = (s: string) => s.split('\n').forEach((part, k) => { if (k) out.push({ t: 'br' }); if (part) out.push({ t: 'text', text: part }); });
  while (rest) {
    const m = rest.match(INLINE);
    if (!m) { plain(rest); break; }
    const index = m.index ?? 0;
    if (index) plain(rest.slice(0, index));
    if (m[1]) out.push({ t: 'code', text: (m[2] ?? '').replace(/^ (.*) $/, '$1') });
    else if (m[3]) out.push({ t: 'strong', children: inline(m[4]) });
    else if (m[5]) out.push({ t: 'em', children: inline(m[6]) });
    else if (m[7]) out.push({ t: 'del', children: inline(m[7]) });
    else if (m[10]) out.push(safeHref(m[10]) ? { t: 'link', href: m[10], children: m[8] ? [{ t: 'text', text: m[9] || m[10] }] : inline(m[9] || m[10]) } : { t: 'text', text: m[0] });
    else out.push({ t: 'link', href: m[11] ?? '', children: [{ t: 'text', text: m[11] ?? '' }] });
    rest = rest.slice(index + m[0].length);
  }
  return out;
}

// Only web links open (app:external takes http(s) alone); anything else (mailto:, javascript:, file:,
// relative paths) stays text (AK-408).
export const safeHref = (href: string): boolean => /^https?:\/\//i.test(href);

const open = (e: Event, href: string) => { e.preventDefault(); window.since?.app('external', href)?.catch(() => {}); };

function inlineEl(n: Inline): Child {
  switch (n.t) {
    case 'br': return h('br');
    case 'code': return h('code.md-code', null, n.text);
    case 'strong': return h('strong', null, n.children.map(inlineEl));
    case 'em': return h('em', null, n.children.map(inlineEl));
    case 'del': return h('del', null, n.children.map(inlineEl));
    case 'link': return h('a.md-link', { href: n.href, title: n.href, onclick: (e) => open(e, n.href) }, n.children.map(inlineEl));
    default: return n.text;
  }
}

function blockEl(b: Block): HTMLElement {
  const text = (s: string) => inline(s).map(inlineEl);
  switch (b.type) {
    case 'h': return h('p.md-h.md-h' + Math.min(b.level, 3), { role: 'heading', 'aria-level': String(b.level + 2) }, text(b.text));
    case 'code': return h('pre.md-pre', b.lang ? { 'data-lang': b.lang } : null, h('code', null, b.text));
    case 'hr': return h('hr.md-hr');
    case 'quote': return h('blockquote.md-quote', null, b.blocks.map(blockEl));
    case 'ul':
    case 'ol': return h(b.type + '.md-list', b.type === 'ol' && b.start !== 1 ? { start: b.start } : null, b.items.map((it) =>
      h('li' + ('checked' in it ? '.md-task' : ''), null,
        'checked' in it ? h('input.md-check', { type: 'checkbox', checked: it.checked, disabled: true, 'aria-label': it.checked ? 'Done' : 'Not done' }) : null,
        text(it.text))));
    default: return h('p', null, text(b.text));
  }
}

// The rendered text, in a div.md (cls adds classes, e.g. '.detail-body').
export function markdown(src: unknown, cls = ''): HTMLElement {
  return h('div.md' + cls, null, parse(src).map(blockEl));
}
