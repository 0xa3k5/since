// Recent-repository helpers for ⌘K and the Switch Repository… switcher, kept out of app.js so they can be unit-tested.

// Palette lists at most this many recent repositories; the Switch Repository… switcher shows them all.
export const PALETTE_RECENT_LIMIT = 8;

// Recent repositories other than the open one (`root`), newest first as stored, capped at `limit`.
export const otherRecent = (list, root, limit = Infinity) => (list || []).filter((x) => x.root !== root).slice(0, limit);
