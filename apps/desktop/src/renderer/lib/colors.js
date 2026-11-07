// Finds CSS colour codes in a line of code, for the swatches in diffs.
// Strict on purpose: hashes, issue refs (#123), URL fragments and #define must not match.

export const MAX_PER_LINE = 20;

// #rgb, #rgba, #rrggbb, #rrggbbaa. Not after a word char, -, /, ?, =, & or # (ids, URLs, &#123;),
// not a markdown link target ([Usage](#add)), and not followed by more word chars (#define, #deadbeef1).
const HEX = /(?<![\w\-/?=&#])(?<!\]\()#([0-9a-f]{3,8})(?![\w-])/gi;
// Colour functions. The argument may not nest parens (var(), calc()); CSS.supports would reject most anyway.
const FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()\n]{1,120}\)/gi;

const cache = new Map();
function supported(value) {
  const css = globalThis.CSS;
  if (!css?.supports) return true;
  let ok = cache.get(value);
  if (ok === undefined) {
    ok = css.supports('color', value);
    if (cache.size > 2000) cache.clear();
    cache.set(value, ok);
  }
  return ok;
}

// Short codes that are all digits (#123) or all letters (#bad, #cafe, #fade) read as issue refs or
// words in prose. Only accept them in a CSS-ish position: right after `:`, `=`, `,`, a quote or a
// function's `(`, or right before `;`, `}` or `!important`. A code that ends an indented declaration
// with no `;` (`  border: 1px solid #fff`, Stylus `  color #fff`) counts too.
function cssPosition(text, start, end) {
  const before = text.slice(Math.max(0, start - 8), start);
  if (/(?:[:=,]|['"`]|[\w-]\()\s*$/.test(before) || /^\s*(?:[;}]|!\s*important)/i.test(text.slice(end, end + 16))) return true;
  return /^\s*$/.test(text.slice(end)) && /^\s+[a-z][\w-]*(?:\s*:[^:;{}]*|\s+)$/i.test(text.slice(0, start));
}

// Returns [{ start, end, value }] sorted by position, at most `max` entries.
export function findColors(text, { max = MAX_PER_LINE, isColor = supported } = {}) {
  if (!text || (!text.includes('#') && !text.includes('('))) return [];
  const out = [];
  for (const m of text.matchAll(HEX)) {
    const n = m[1].length;
    if (n === 5 || n === 7) continue;
    const end = m.index + m[0].length;
    if (n <= 4 && /^(?:\d+|[a-f]+)$/i.test(m[1]) && !cssPosition(text, m.index, end)) continue;
    out.push({ start: m.index, end, value: m[0] });
  }
  if (text.includes('(')) {
    for (const m of text.matchAll(FN)) {
      const value = m[0];
      if (/^color\(/i.test(value) && !/^color\(\s*display-p3\s/i.test(value)) continue;
      out.push({ start: m.index, end: m.index + value.length, value });
    }
  }
  out.sort((a, b) => a.start - b.start);
  const res = [];
  for (const c of out) {
    if (res.length >= max) break;
    if (isColor(c.value)) res.push(c);
  }
  return res;
}
