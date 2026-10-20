// Built-in 3-way conflict editor. Works on the conflict markers git writes into the
// working file (merge and diff3 styles), so merge, rebase, cherry-pick, revert and
// stash apply all look the same. The parsing and composing helpers are pure, for tests.

const MARK = 7; // git's default conflict-marker-size
const isMarker = (l, c) => l.length >= MARK && l.slice(0, MARK) === c.repeat(MARK) && (l.length === MARK || l[MARK] === ' ' || l[MARK] === '\r');
const markerLabel = (l) => l.slice(MARK).trim();

// Splits text into { type: 'text', lines } and { type: 'conflict', ours, base, theirs, *Label, raw }
// segments. Lines keep a trailing '\r', so joining with '\n' gives back the input.
export function parseConflicts(text) {
  const segs = [];
  let txt = [], cur = null, part = null;
  const flush = () => { if (txt.length) segs.push({ type: 'text', lines: txt }); txt = []; };
  for (const l of text.split('\n')) {
    if (!cur && isMarker(l, '<')) {
      flush();
      cur = { type: 'conflict', ours: [], base: null, theirs: [], oursLabel: markerLabel(l), baseLabel: '', theirsLabel: '', raw: [l] };
      part = 'ours';
      continue;
    }
    if (!cur) { txt.push(l); continue; }
    cur.raw.push(l);
    if (part === 'ours' && isMarker(l, '|')) { cur.base = []; cur.baseLabel = markerLabel(l); part = 'base'; }
    else if (part !== 'theirs' && isMarker(l, '=')) part = 'theirs';
    else if (part === 'theirs' && isMarker(l, '>')) { cur.theirsLabel = markerLabel(l); segs.push(cur); cur = null; }
    else cur[part].push(l);
  }
  // An unterminated block is not a conflict; keep its lines as plain text.
  if (cur) txt.push(...cur.raw);
  flush();
  return segs;
}

export const conflictCount = (segs) => segs.filter((s) => s.type === 'conflict').length;

// A choice for one block: which ours/theirs lines to keep, and whether theirs come first.
export function sideChoice(block, side) {
  return {
    ours: block.ours.map(() => side === 'ours' || side === 'both' || side === 'both-rev'),
    theirs: block.theirs.map(() => side === 'theirs' || side === 'both' || side === 'both-rev'),
    theirsFirst: side === 'both-rev',
  };
}

// The resolved lines of one block, or its raw lines (markers included) while unchosen.
export function blockResult(block, choice) {
  if (!choice) return block.raw;
  const ours = block.ours.filter((_, i) => choice.ours[i]);
  const theirs = block.theirs.filter((_, i) => choice.theirs[i]);
  return choice.theirsFirst ? [...theirs, ...ours] : [...ours, ...theirs];
}

// The file text for the given choices (one entry per conflict block, null = unresolved).
export function composeResult(segs, choices = []) {
  const out = [];
  let ci = 0;
  for (const s of segs) out.push(...(s.type === 'text' ? s.lines : blockResult(s, choices[ci++])));
  return out.join('\n');
}

export const hasMarkers = (text) => parseConflicts(text).some((s) => s.type === 'conflict');

// A textarea turns \r\n into \n; put CRLF back when the conflicted file used it.
export const keepLineEndings = (source, text) => (source?.includes('\r\n') && !text.includes('\r') ? text.replace(/\n/g, '\r\n') : text);
