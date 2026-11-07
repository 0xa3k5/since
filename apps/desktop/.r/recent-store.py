[
("const MAX = 20;", "export const MAX = 20;\n\nexport interface RecentRepo { root: string; name: string; opened: number }\ntype OpenRepo = (root: string) => Promise<{ root: string }>;"),
("export function readRecent(file) {\n  try { return JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) =>", "export function readRecent(file: string): RecentRepo[] {\n  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as RecentRepo[]).filter((r) =>"),
("function write(file, list) {", "function write(file: string, list: RecentRepo[]): void {"),
("export function addRecent(file, repo) {", "export function addRecent(file: string, repo: { root: string; name: string }): void {"),
("export function removeRecent(file, root) {", "export function removeRecent(file: string, root: string): boolean {"),
("const realpath = (p) =>", "const realpath = (p: string): string =>"),
("export async function lastRepo(file, openRepo, wanted) {", "export async function lastRepo(file: string, openRepo: OpenRepo, wanted?: string | null): Promise<string | null> {"),
("export async function lastTabs(file, openRepo, wanted) {\n  if (wanted === undefined) { const root = await lastRepo(file, openRepo); return root ? [root] : []; }\n  const roots = [];", "export async function lastTabs(file: string, openRepo: OpenRepo, wanted?: readonly (string | null)[]): Promise<string[]> {\n  if (wanted === undefined) { const root = await lastRepo(file, openRepo); return root ? [root] : []; }\n  const roots: string[] = [];"),
]
