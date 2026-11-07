// Resizable panes (sidebar, Commit view file list, Stashes list, Catch up list). Pure logic, no DOM, so it can be unit-tested.
// Each pane has a default, a floor and a ceiling, and always leaves `keep` px for the content beside it,
// so neither side ever collapses. The floor wins when the window is too small for both.

interface Pane { label: string; def: number; min: number; max: number; keep: number }
export const PANES = {
  sidebar: { label: 'Sidebar width', def: 232, min: 180, max: 420, keep: 600 },
  commit: { label: 'File list width', def: 320, min: 240, max: 640, keep: 360 },
  stash: { label: 'Stash list width', def: 340, min: 240, max: 640, keep: 360 },
  catchup: { label: 'Since list width', def: 380, min: 280, max: 720, keep: 420 },
} satisfies Record<string, Pane>;
export type PaneId = keyof typeof PANES;
export type PaneSizes = Record<PaneId, number>;

// Arrow keys move the edge by STEP px, ⇧ by BIG_STEP.
export const STEP = 8;
export const BIG_STEP = 40;

// The width to use for pane `id` given a wanted width and the space the pane shares with its neighbour.
export function clampPane(id: PaneId, px: number, avail = Infinity): number {
  const p = PANES[id];
  const n = Number.isFinite(px) ? Math.round(px) : p.def;
  return Math.max(p.min, Math.min(n, p.max, avail - p.keep));
}

// The width after a key on a focused handle, or null when the key doesn't resize.
// Home/End jump to the floor/ceiling; Enter resets to the default.
export function stepPane(id: PaneId, px: number, key: string, shift = false, avail = Infinity): number | null {
  const p = PANES[id];
  const d = shift ? BIG_STEP : STEP;
  const next = ({ ArrowLeft: px - d, ArrowRight: px + d, Home: p.min, End: p.max, Enter: p.def } as Record<string, number>)[key];
  return next == null ? null : clampPane(id, next, avail);
}

// Saved sizes (user-wide pref) → a full, clamped set. Unknown or broken values fall back to the default.
export function loadSizes(saved: unknown): PaneSizes {
  const prefs = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  return Object.fromEntries((Object.keys(PANES) as PaneId[]).map((id) => [id, clampPane(id, Number(prefs[id]))])) as PaneSizes;
}

export const defaultSizes = (): PaneSizes => loadSizes({});
