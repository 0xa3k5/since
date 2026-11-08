// Opt-in AI commit messages. Since has no model and no server of its own: the staged diff
// goes to a tool the user already runs (Claude Code or the Codex CLI) or to a model on this Mac
// (Ollama). It's off until the user picks a provider, and main.js refuses to send anything to a
// provider until the user has seen the exact text that goes out and agreed to it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

interface CliProvider { label: string; bin: string; args: string[] }
interface LocalProvider { label: string; url: string; defaultModel: string }
export type ProviderId = 'claude' | 'codex' | 'ollama';
/** Saved under `ai` in settings.json. */
export interface AiSettings { provider: ProviderId | 'off'; model: string; consent: ProviderId[] }

export const PROVIDERS: { claude: CliProvider; codex: CliProvider; ollama: LocalProvider } = {
  // No tools and no MCP servers: the diff is untrusted text, and the user's own Claude Code
  // settings may allow Bash or skip permission prompts. `--tools=` keeps the variadic flag from
  // swallowing the next argument.
  claude: { label: 'Claude Code', bin: 'claude', args: ['-p', '--tools=', '--strict-mcp-config', '--output-format', 'text'] },
  // Read-only sandbox and no repo check: the CLI runs in an empty folder and only gets stdin.
  codex: { label: 'Codex CLI', bin: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'] },
  ollama: { label: 'Ollama (on this Mac)', url: 'http://127.0.0.1:11434/api/generate', defaultModel: 'llama3.2' },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
const isProvider = (id: unknown): id is ProviderId => (PROVIDER_IDS as readonly unknown[]).includes(id);

export const MAX_DIFF = 48 * 1024; // keeps the prompt within small local models' context
const TIMEOUT = 120_000;

export function buildPrompt({ diff, stat, branch }: { diff: string; stat: string; branch?: string | null }): string {
  const cut = diff.length > MAX_DIFF;
  return [
    'Write a git commit message for the staged changes below.',
    'Use the imperative mood. First line: a summary of at most 72 characters, no trailing period.',
    'If the change needs explaining, add a blank line and a short body wrapped at 72 characters.',
    'Reply with the commit message only: no quotes, no code fences, no commentary.',
    '',
    branch ? `Branch: ${branch}` : null,
    'Files changed:',
    stat.trimEnd(),
    '',
    cut ? `Diff (first ${MAX_DIFF / 1024} KB of ${Math.ceil(diff.length / 1024)} KB):` : 'Diff:',
    cut ? diff.slice(0, MAX_DIFF) : diff.trimEnd(),
  ].filter((l) => l !== null).join('\n') + '\n';
}

// A pull request description from a branch's commits and diff, for the create-PR sheet. Sent
// only to a provider the user already agreed to send commit diffs to.
export function buildPrPrompt({ branch, base, log, stat, diff }: { branch: string; base: string; log: string; stat: string; diff: string }): string {
  const cut = diff.length > MAX_DIFF;
  return [
    `Write a GitHub pull request title and description for merging ${branch} into ${base}.`,
    'First line: the title, at most 72 characters, imperative mood, no trailing period.',
    'Then a blank line and a short description in Markdown: what changes and why, as a few bullets.',
    'Reply with the title and description only: no quotes, no code fences, no commentary.',
    '',
    'Commits:',
    log.trimEnd(),
    '',
    'Files changed:',
    stat.trimEnd(),
    '',
    cut ? `Diff (first ${MAX_DIFF / 1024} KB of ${Math.ceil(diff.length / 1024)} KB):` : 'Diff:',
    cut ? diff.slice(0, MAX_DIFF) : diff.trimEnd(),
  ].join('\n') + '\n';
}

// Model output → { title, body }: the first line is the title, the rest the description.
export function splitPr(msg: string | null | undefined): { title: string; body: string } {
  const [first = '', ...rest] = String(msg || '').split('\n');
  return { title: first.replace(/^#+\s*|^title:\s*/i, '').trim(), body: rest.join('\n').trim() };
}

// Models like to wrap answers in fences or quotes, or lead with "Commit message:".
export function cleanMessage(out: unknown): string {
  let s = String(out || '').replace(/\r\n/g, '\n').trim();
  const fence = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) s = (fence[1] ?? '').trim();
  s = s.replace(/^(?:\*\*)?commit message:?(?:\*\*)?\s*\n?/i, '').trim();
  if (/^(["'`]).*\1$/s.test(s) && !s.slice(1, -1).includes(s.charAt(0))) s = s.slice(1, -1).trim();
  return s.replace(/\n{3,}/g, '\n\n');
}

export async function stagedChanges(run: (cwd: string, args: string[], opts: { env: Record<string, string> }) => Promise<string>, cwd: string, branch?: string | null): Promise<string> {
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  const stat = await run(cwd, ['diff', '--cached', '--stat=100', '--no-color'], { env });
  if (!stat.trim()) throw new Error('Nothing is staged. Stage some changes first.');
  const diff = await run(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M'], { env });
  return buildPrompt({ diff, stat, branch });
}

// Apps opened from the Dock get a bare PATH, so also look where these CLIs usually install.
export function searchDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '.local/bin', '.claude/local', '.npm-global/bin', '.volta/bin', '.bun/bin']
    .map((d) => (path.isAbsolute(d) ? d : path.join(home, d)));
  return [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...extra])];
}

export function findBinary(name: string, dirs = searchDirs()): string | null {
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

// `signal` (an AbortSignal) stops the CLI too: the promise rejects with an AbortError.
export function runCli(bin: string, args: readonly string[], input: string, { dirs = searchDirs(), timeout = TIMEOUT, env = {}, signal }: { dirs?: string[]; timeout?: number; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cancelled = () => Object.assign(new Error(`${path.basename(bin)} was cancelled`), { name: 'AbortError' });
    if (signal?.aborted) return reject(cancelled());
    // An empty folder, so the CLI never reads or edits the repository on its own.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'since-ai-'));
    const done = <T>(fn: (v: T) => void, v: T) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } fn(v); };
    // PATH includes the usual install folders: npm-installed CLIs start with `env node`.
    // Own process group, so a timeout stops the CLI and anything it started.
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env, PATH: dirs.join(path.delimiter) }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '', err = '';
    // Decode as a stream, so a character split across two chunks stays whole.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.on('data', (d: string) => { err += d; });
    // Without a pid (spawn failed) there is no process group to stop: never signal group 0, which is ours.
    const stop = () => { try { if (child.pid === undefined) throw new Error('no pid'); process.kill(-child.pid); } catch { child.kill(); } };
    const timer = setTimeout(() => { stop(); done(reject, new Error(`${path.basename(bin)} didn’t answer within ${timeout / 1000} s`)); }, timeout);
    const onAbort = () => { stop(); done(reject, cancelled()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: Error) => done(reject, e));
    child.on('close', (code: number | null) => {
      if (code === 0) done(resolve, out);
      else done(reject, new Error((err || out).trim().split('\n').slice(-4).join('\n') || `${path.basename(bin)} exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function runOllama(model: string, prompt: string, { fetchImpl = fetch, timeout = TIMEOUT }: { fetchImpl?: typeof fetch | undefined; timeout?: number | undefined } = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(PROVIDERS.ollama.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error('Couldn’t reach Ollama on this Mac. Is it running?');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; response?: string };
  if (!res.ok) throw new Error(body.error || `Ollama answered ${res.status}`);
  return body.response || '';
}

// Ties a consent to the exact text the user previewed.
export const promptHash = (prompt: string): string => crypto.createHash('sha256').update(prompt).digest('hex');

export async function generate({ provider, model }: { provider: string; model?: string | null }, prompt: string, { dirs, fetchImpl, timeout }: { dirs?: string[]; fetchImpl?: typeof fetch; timeout?: number } = {}): Promise<string> {
  if (!isProvider(provider)) throw new Error('AI commit messages are off. Pick a provider first.');
  const p = PROVIDERS[provider];
  let out: string;
  if (provider === 'ollama') {
    out = await runOllama(model || PROVIDERS.ollama.defaultModel, prompt, { fetchImpl, timeout });
  } else {
    const cli = PROVIDERS[provider];
    const bin = findBinary(cli.bin, dirs);
    if (!bin) throw new Error(`Couldn’t find the \`${cli.bin}\` command. Install ${cli.label} or pick another provider.`);
    out = await runCli(bin, cli.args, prompt, { ...(dirs ? { dirs } : {}), ...(timeout ? { timeout } : {}) });
  }
  const msg = cleanMessage(out);
  if (!msg) throw new Error(`${p.label} returned an empty message`);
  return msg;
}

// Saved under `ai` in settings.json: { provider, model, consent: [provider ids] }.
export function normalize(saved: { provider?: unknown; model?: unknown; consent?: unknown } = {}): AiSettings {
  return {
    provider: isProvider(saved.provider) ? saved.provider : 'off',
    model: typeof saved.model === 'string' ? saved.model : '',
    consent: Array.isArray(saved.consent) ? saved.consent.filter(isProvider) : [],
  };
}

