[
("export const byNumber = (count, n) =>", "/** A closed tab or window, for ⇧⌘T: its repositories, the one showing, and what else it kept. */\nexport interface ClosedEntry { roots: string[]; active?: string | null; [key: string]: unknown }\n\nexport const byNumber = (count: number, n: number): number =>"),
("export const step = (count, i, by) =>", "export const step = (count: number, i: number, by: number): number =>"),
("export const afterClose = (count, i) =>", "export const afterClose = (count: number, i: number): number =>"),
("export const reopenActive = (roots, active) => (roots.includes(active)", "export const reopenActive = (roots: readonly string[], active: string | null | undefined): number => (active != null && roots.includes(active)"),
("export const remember = (closed, entry, max = 20) =>", "export const remember = (closed: ClosedEntry[], entry: ClosedEntry, max = 20): ClosedEntry[] =>"),
("export function takeClosed(closed, ok) {\n  const rest = [...closed];\n  while (rest.length) {\n    const e = rest.pop();", "export function takeClosed(closed: readonly ClosedEntry[], ok: (root: string) => boolean): { entry: ClosedEntry | null; rest: ClosedEntry[] } {\n  const rest = [...closed];\n  while (rest.length) {\n    const e = rest.pop();\n    if (!e) break;"),
]
