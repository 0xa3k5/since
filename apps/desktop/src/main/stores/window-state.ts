// The size and place of the window closed last (window-state.json in userData), given back to the
// window that launch opens (AK-633).
import fs from 'node:fs';
import path from 'node:path';

// How much of the window's top edge, where it is dragged from, must be on a display to keep its position.
const SHOWN = { width: 120, height: 40 };

export interface Bounds { x?: number; y?: number; width: number; height: number }
export interface WindowState { bounds?: Bounds; maximized?: boolean }
/** A display's work area. */
export interface Area { x: number; y: number; width: number; height: number }

export function readState(file: string): WindowState | null {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as WindowState | null) || null; } catch { return null; }
}
export function saveState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (err) { console.warn('could not save the window state', (err as Error).message); }
}

// Saved bounds fitted to the displays' work areas: no larger than the display, and at the saved
// position only while its top edge is still on a display (a display may have been unplugged).
// Without a position the window opens centred.
export function fitState(state: WindowState | null | undefined, areas: readonly Area[] | null | undefined): { bounds: Bounds; maximized: boolean } | null {
  const saved = state?.bounds;
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || !areas?.length) return null;
  const b = saved as Required<Bounds>; // every field is a finite number (checked above)
  const shown = areas.find((a) => Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= SHOWN.width
    && b.y >= a.y && b.y + SHOWN.height <= a.y + a.height);
  const a = shown || (areas[0] as Area);
  const bounds: Bounds = { width: Math.round(Math.min(b.width, a.width)), height: Math.round(Math.min(b.height, a.height)) };
  if (shown) Object.assign(bounds, { x: Math.round(b.x), y: Math.round(b.y) });
  return { bounds, maximized: state?.maximized === true };
}

