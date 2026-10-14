// Pointer helpers for the commit map, kept out of app.js so they can be unit-tested. Keys live in keymap.js.

// Inner controls of a graph row that must not trigger the row's double-click checkout.
const ROW_CONTROLS = '.pill, .avatar, .avatar-stack, button, a, input';
export const isRowControl = (target) => !!target?.closest?.(ROW_CONTROLS);
