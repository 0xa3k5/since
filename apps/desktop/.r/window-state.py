[
("const SHOWN = { width: 120, height: 40 };", "const SHOWN = { width: 120, height: 40 };\n\nexport interface Bounds { x?: number; y?: number; width: number; height: number }\nexport interface WindowState { bounds?: Bounds; maximized?: boolean }\n/** A display's work area. */\nexport interface Area { x: number; y: number; width: number; height: number }"),
("export function readState(file) {\n  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || null; }", "export function readState(file: string): WindowState | null {\n  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as WindowState | null) || null; }"),
("export function saveState(file, state) {", "export function saveState(file: string, state: WindowState): void {"),
("  } catch (err) { console.warn('could not save the window state', err.message); }", "  } catch (err) { console.warn('could not save the window state', (err as Error).message); }"),
("export function fitState(state, areas) {\n  const b = state?.bounds;\n  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || !areas?.length) return null;", "export function fitState(state: WindowState | null | undefined, areas: readonly Area[] | null | undefined): { bounds: Bounds; maximized: boolean } | null {\n  const saved = state?.bounds;\n  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || !areas?.length) return null;\n  const b = saved as Required<Bounds>; // every field is a finite number (checked above)"),
("  const a = shown || areas[0];\n  const bounds = {", "  const a = shown || (areas[0] as Area);\n  const bounds: Bounds = {"),
("  return { bounds, maximized: state.maximized === true };", "  return { bounds, maximized: state?.maximized === true };"),
]
