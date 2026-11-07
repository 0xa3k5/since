[
("import * as git from './git/index.ts';\n", "import * as git from './git/index.ts';\nimport type { LogStream, StreamLogOptions } from './git/log.ts';\n\n/** An open log stream and what it was opened with. */\nexport interface OpenLog { stream: LogStream; opts: StreamLogOptions | undefined; fast: boolean }\n"),
("export const CLOSED = false;", "export const CLOSED = false as const;"),
("export class LogStreams {\n  // onEnd(log) runs once a stream has been read to the end.\n  constructor(root, { max = 6, onEnd } = {}) {", "export class LogStreams {\n  root: string;\n  max: number;\n  onEnd: ((log: OpenLog) => void) | undefined;\n  logs: Map<number, OpenLog>;\n  disposed: boolean;\n  // onEnd(log) runs once a stream has been read to the end.\n  constructor(root: string, { max = 6, onEnd }: { max?: number; onEnd?: (log: OpenLog) => void } = {}) {"),
("  async open(opts) {", "  async open(opts?: StreamLogOptions): Promise<{ id: number; fast: boolean }> {"),
("  async read(id) {", "  async read(id: number): Promise<string | null | typeof CLOSED> {"),
("  close(id) {", "  close(id: number): void {"),
("  dispose() {", "  dispose(): void {"),
]
