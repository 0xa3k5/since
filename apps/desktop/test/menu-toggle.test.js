'use strict';
// A menu or popover's trigger toggles it (renderer/ui.js contextMenu and popovers, AK-635):
// pressing the trigger of an open menu doesn't close it, so the click that follows closes it
// instead of closing and reopening it. Runs ui.js against a minimal fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');

class Node {
  constructor(tag = '#text') { this.tag = tag; this.parentNode = null; this.children = []; this.attrs = {}; this.style = {}; this.className = ''; this.on = {}; }
  get classList() { const el = this; const set = () => new Set(el.className.split(' ').filter(Boolean)); const put = (s) => { el.className = [...s].join(' '); };
    return { add: (c) => put(set().add(c)), remove: (c) => { const s = set(); s.delete(c); put(s); }, contains: (c) => set().has(c) }; }
  append(...cs) { for (const c of cs) { c.remove(); c.parentNode = this; this.children.push(c); } }
  remove() { const p = this.parentNode; if (p) { p.children = p.children.filter((c) => c !== this); this.parentNode = null; } }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  get isConnected() { return document.body.contains(this); }
  closest(sel) {
    const ok = (n) => sel.split(',').some((s) => { const a = s.trim().match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); return a ? n.hasAttribute(a[1]) && (a[2] == null || n.attrs[a[1]] === a[2]) : n.tag === s.trim(); });
    for (let n = this; n; n = n.parentNode) if (ok(n)) return n;
    return null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, f) { (this.on[t] ||= []).push(f); }
  removeEventListener(t, f) { this.on[t] = (this.on[t] || []).filter((g) => g !== f); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  focus() {}
}
const doc = new Node('#doc');
Object.assign(doc, { body: new Node('body'), createElement: (t) => new Node(t), createTextNode: () => new Node() });
Object.assign(globalThis, { Node, document: doc, window: new Node('#win'), innerWidth: 1000, innerHeight: 800 });

// Capture phase, as the real listeners use it: window, then document.
function fire(type, target, extra = {}) {
  const e = { type, target, button: 0, key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {}, ...extra };
  for (const node of [window, document]) for (const f of [...(node.on[type] || [])]) f(e);
}
const tick = () => new Promise((r) => setTimeout(r));
const menus = () => document.body.children.filter((c) => c.classList.contains('menu'));
const popovers = () => document.body.children.filter((c) => c.classList.contains('popover'));

test('a menu trigger toggles its menu on click, ↵ and Space; outside presses and Esc still close it', async () => {
  const { h, contextMenu, closeMenu } = await import('../renderer/ui.js');
  const items = [{ label: 'One', run() {} }];
  const a = h('button', { 'aria-haspopup': 'menu' }), b = h('button'), other = h('div');
  document.body.append(a, b, other);
  // What the trigger's click handler does: open its menu.
  const click = (btn, opts) => { fire('mousedown', btn); fire('click', btn); contextMenu(0, 0, items, opts); };

  click(a);
  assert.equal(menus().length, 1);
  assert.equal(a.getAttribute('aria-expanded'), 'true');
  await tick();
  fire('mousedown', a);
  assert.equal(menus().length, 1, 'pressing the trigger keeps the menu (no close-and-reopen flash)');
  fire('click', a); contextMenu(0, 0, items);
  assert.equal(menus().length, 0, 'the click closes it');
  assert.equal(a.getAttribute('aria-expanded'), 'false');

  for (const key of ['Enter', ' ']) {
    fire('keydown', a, { key }); fire('click', a); contextMenu(0, 0, items);
    assert.equal(menus().length, 1);
    await tick();
    fire('keydown', a, { key }); fire('click', a); contextMenu(0, 0, items);
    assert.equal(menus().length, 0, `${key === ' ' ? 'Space' : key} on the trigger closes it`);
  }

  click(a); await tick();
  fire('mousedown', other);
  assert.equal(menus().length, 0, 'a press outside closes it');
  click(a); await tick();
  fire('mousedown', a, { button: 2 });
  assert.equal(menus().length, 0, 'a right press on the trigger closes it');
  click(a); await tick();
  fire('keydown', a, { key: 'Escape', code: 'Escape' });
  assert.equal(menus().length, 0, 'Esc closes it');

  click(a); await tick();
  click(b);
  assert.equal(menus().length, 1, "another trigger closes this menu and opens its own");
  await tick();
  click(b);
  assert.equal(menus().length, 0);

  // A menu opened after an await names its trigger; the last press may be elsewhere by then.
  fire('mousedown', other); fire('click', other);
  contextMenu(0, 0, items, { trigger: a }); await tick();
  click(a, { trigger: a });
  assert.equal(menus().length, 0);
  closeMenu();
});

test('↵ on an open popover trigger closes it', async () => {
  const { h } = await import('../renderer/ui.js');
  const t = h('button', { 'data-pop': '' });
  t.popContent = () => [h('div'), h('div')];
  document.body.append(t);
  fire('keydown', t, { key: 'Enter', code: 'Enter' });
  assert.equal(popovers().length, 1);
  fire('keydown', t, { key: 'Enter', code: 'Enter' });
  assert.equal(popovers().length, 0);
});
