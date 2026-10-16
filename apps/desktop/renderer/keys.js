// Pointer helpers for the commit map, kept out of app.js so they can be unit-tested. Keys live in keymap.js.

// Inner controls of a graph row that must not trigger the row's double-click checkout.
const ROW_CONTROLS = '.pill, .avatar, .avatar-stack, button, a, input';
export const isRowControl = (target) => !!target?.closest?.(ROW_CONTROLS);

// Which row a double-click on the Map list means. The first press selects (and redraws) its row,
// so the second press and the dblclick land on the list, not on the row: remember the first one.
export function rowDoubleClick() {
  let armed = null;
  return {
    rowDown(e, row) { if (e.detail === 1) armed = isRowControl(e.target) ? null : row; },
    listDown(e) { if (e.detail === 1 && !e.target?.closest?.('.row')) armed = null; },
    dblclick(e) { return e.button === 0 && !isRowControl(e.target) ? armed : null; },
  };
}
