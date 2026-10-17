// Back and forward (⌘[ ⌘]): the window's navigation history, kept out of app.js so it can be unit-tested.
// An entry is a snapshot of where the user was ({ key, …whatever app.js needs to put them back }); `key` names
// the place, so a jump that lands where it started records nothing. Only jumps are recorded, never list moves.

// Oldest entries drop off past this many steps back.
export const NAV_LIMIT = 100;

export function createNav(limit = NAV_LIMIT) {
  let back = [];
  let fwd = [];
  return {
    get canBack() { return back.length > 0; },
    get canForward() { return fwd.length > 0; },
    // The user jumped from `from` to the place named `toKey`: remember `from`, and forget what was ahead.
    record(from, toKey) {
      if (!from || from.key === toKey) return false;
      back.push(from);
      if (back.length > limit) back.shift();
      fwd = [];
      return true;
    },
    // One step back from `here`: the entry to restore, or null. `here` becomes the step forward.
    back(here) {
      const to = back.pop();
      if (!to) return null;
      if (here) fwd.push(here);
      return to;
    },
    forward(here) {
      const to = fwd.pop();
      if (!to) return null;
      if (here) back.push(here);
      return to;
    },
    clear() { back = []; fwd = []; },
  };
}
