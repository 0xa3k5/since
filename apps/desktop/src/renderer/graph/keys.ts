// Pointer helpers for the commit map, kept out of app.js so they can be unit-tested. Keys live in keymap.js.

// Inner controls of a graph row that must not trigger the row's double-click checkout.
const ROW_CONTROLS = '.pill, .avatar, .avatar-stack, button, a, input';
export const isRowControl = (target: EventTarget | null | undefined): boolean => !!(target && 'closest' in target && (target as Element).closest(ROW_CONTROLS));

// Which row a double-click on the Map list means, read off the second mousedown (its click count)
// rather than the dblclick event, which Chromium drops when anything redraws the row mid-click.
// rowDown returns the row to check out, or null.
export interface RowDoubleClick<R> { rowDown(e: MouseEvent, row: R): R | null; listDown(e: MouseEvent): void }
export function rowDoubleClick<R>(): RowDoubleClick<R> {
  let armed: R | null = null;
  return {
    rowDown(e, row) {
      if (e.button !== 0 || isRowControl(e.target)) { armed = null; return null; }
      if (e.detail === 1) { armed = row; return null; }
      const hit = e.detail === 2 && armed === row ? row : null;
      armed = null;
      return hit;
    },
    listDown(e) { const t = e.target; if (!(t && 'closest' in t && (t as Element).closest('.row'))) armed = null; },
  };
}
