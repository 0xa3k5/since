// Pointer helpers for the commit map, kept out of app.js so they can be unit-tested. Keys live in keymap.js.

// Inner controls of a graph row that must not trigger the row's double-click checkout.
const ROW_CONTROLS = '.pill, .avatar, .avatar-stack, button, a, input';
export const isRowControl = (target) => !!target?.closest?.(ROW_CONTROLS);

// Which row a double-click on the Map list means, read off the second mousedown (its click count)
// rather than the dblclick event, which Chromium drops when anything redraws the row mid-click.
// rowDown returns the row to check out, or null.
export function rowDoubleClick() {
  let armed = null;
  return {
    rowDown(e, row) {
      if (e.button !== 0 || isRowControl(e.target)) { armed = null; return null; }
      if (e.detail === 1) { armed = row; return null; }
      const hit = e.detail === 2 && armed === row ? row : null;
      armed = null;
      return hit;
    },
    listDown(e) { if (!e.target?.closest?.('.row')) armed = null; },
  };
}
