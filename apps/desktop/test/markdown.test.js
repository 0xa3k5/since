'use strict';
// Markdown in commit messages and PR descriptions (renderer/markdown.js, AK-399): the parser.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/markdown.js');

test('parse: headings, lists, tasks, quotes, fences and rules; paragraphs keep their line breaks', async () => {
  const { parse } = await load();
  const blocks = parse('## Summary\nFirst line\nwrapped line\n\n- one\n- [x] two\n  more of two\n\n1. a\n2. b\n\n> quoted\n\n```js\nconst x = 1;\n\n```\n---\nCo-Authored-By: A <a@x>\nCo-Authored-By: B <b@x>');
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr', 'p']);
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[1].text, 'First line\nwrapped line');
  assert.deepEqual(blocks[2].items, [{ text: 'one' }, { text: 'two\nmore of two', checked: true }]);
  assert.equal(blocks[5].lang, 'js');
  assert.equal(blocks[5].text, 'const x = 1;\n');
  assert.equal(blocks[7].text, 'Co-Authored-By: A <a@x>\nCo-Authored-By: B <b@x>');
});

test('parse: a list right after a paragraph line starts a list; an unclosed fence runs to the end', async () => {
  const { parse } = await load();
  assert.deepEqual(parse('Changes:\n- a\n- b').map((b) => b.type), ['p', 'ul']);
  assert.deepEqual(parse('```\ncode'), [{ type: 'code', lang: '', text: 'code' }]);
  assert.deepEqual(parse(''), []);
});

test('inline: code, bold, italic, struck, links and bare links', async () => {
  const { inline } = await load();
  assert.deepEqual(inline('use `a*b*` and **bold** or *it* ~~no~~'), [
    { t: 'text', text: 'use ' }, { t: 'code', text: 'a*b*' }, { t: 'text', text: ' and ' },
    { t: 'strong', children: [{ t: 'text', text: 'bold' }] }, { t: 'text', text: ' or ' },
    { t: 'em', children: [{ t: 'text', text: 'it' }] }, { t: 'text', text: ' ' },
    { t: 'del', children: [{ t: 'text', text: 'no' }] },
  ]);
  assert.deepEqual(inline('see [docs](https://x.dev/a) or https://y.dev/b.'), [
    { t: 'text', text: 'see ' }, { t: 'link', href: 'https://x.dev/a', children: [{ t: 'text', text: 'docs' }] },
    { t: 'text', text: ' or ' }, { t: 'link', href: 'https://y.dev/b', children: [{ t: 'text', text: 'https://y.dev/b' }] }, { t: 'text', text: '.' },
  ]);
  assert.deepEqual(inline('a\nb'), [{ t: 'text', text: 'a' }, { t: 'br' }, { t: 'text', text: 'b' }]);
});

test('inline: snake_case and 2 * 3 * 4 stay text; unsafe links stay text; images show their alt as a link', async () => {
  const { inline } = await load();
  const flat = (nodes) => nodes.map((n) => n.text ?? '').join('');
  assert.equal(flat(inline('call do_this_now()')), 'call do_this_now()');
  assert.ok(inline('call do_this_now()').every((n) => n.t === 'text'));
  assert.ok(inline('2 * 3 * 4').every((n) => n.t === 'text'));
  assert.deepEqual(inline('[x](javascript:alert(1))')[0].t, 'text');
  assert.deepEqual(inline('![shot](https://x.dev/a.png)'), [{ t: 'link', href: 'https://x.dev/a.png', children: [{ t: 'text', text: 'shot' }] }]);
});
