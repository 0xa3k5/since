'use strict';
// The size and place of the window closed last (window-state.json in userData), given back to the
// window that launch opens (AK-633).
const fs = require('node:fs');
const path = require('node:path');

// How much of the window's top edge, where it is dragged from, must be on a display to keep its position.
const SHOWN = { width: 120, height: 40 };

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || null; } catch { return null; }
}
function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (err) { console.warn('could not save the window state', err.message); }
}

// Saved bounds fitted to the displays' work areas: no larger than the display, and at the saved
// position only while its top edge is still on a display (a display may have been unplugged).
// Without a position the window opens centred.
function fitState(state, areas) {
  const b = state?.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || !areas?.length) return null;
  const shown = areas.find((a) => Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= SHOWN.width
    && b.y >= a.y && b.y + SHOWN.height <= a.y + a.height);
  const a = shown || areas[0];
  const bounds = { width: Math.round(Math.min(b.width, a.width)), height: Math.round(Math.min(b.height, a.height)) };
  if (shown) Object.assign(bounds, { x: Math.round(b.x), y: Math.round(b.y) });
  return { bounds, maximized: state.maximized === true };
}

module.exports = { readState, saveState, fitState };
