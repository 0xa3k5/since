'use strict';
// Opt-in AI commit messages. GitLanes has no model and no server of its own: the staged diff
// goes to a tool the user already runs (Claude Code or the Codex CLI) or to a model on this Mac
// (Ollama). It's off until the user picks a provider, and main.js refuses to send anything to a
// provider until the user has seen the exact text that goes out and agreed to it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PROVIDERS = {
  // No tools and no MCP servers: the diff is untrusted text, and the user's own Claude Code
  // settings may allow Bash or skip permission prompts. `--tools=` keeps the variadic flag from
  // swallowing the next argument.
  claude: { label: 'Claude Code', bin: 'claude', args: ['-p', '--tools=', '--strict-mcp-config', '--output-format', 'text'] },
  // Read-only sandbox and no repo check: the CLI runs in an empty folder and only gets stdin.
  codex: { label: 'Codex CLI', bin: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'] },
  ollama: { label: 'Ollama (on this Mac)', url: 'http://127.0.0.1:11434/api/generate', defaultModel: 'llama3.2' },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

const MAX_DIFF = 48 * 1024; // keeps the prompt within small local models' context
const TIMEOUT = 120_000;

function buildPrompt({ diff, stat, branch }) {
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
function buildPrPrompt({ branch, base, log, stat, diff }) {
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
function splitPr(msg) {
  const [first, ...rest] = String(msg || '').split('\n');
  return { title: first.replace(/^#+\s*|^title:\s*/i, '').trim(), body: rest.join('\n').trim() };
}

// Models like to wrap answers in fences or quotes, or lead with "Commit message:".
function cleanMessage(out) {
  let s = String(out || '').replace(/\r\n/g, '\n').trim();
  const fence = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(?:\*\*)?commit message:?(?:\*\*)?\s*\n?/i, '').trim();
  if (/^(["'`]).*\1$/s.test(s) && !s.slice(1, -1).includes(s[0])) s = s.slice(1, -1).trim();
  return s.replace(/\n{3,}/g, '\n\n');
}

async function stagedChanges(run, cwd, branch) {
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  const stat = await run(cwd, ['diff', '--cached', '--stat=100', '--no-color'], { env });
  if (!stat.trim()) throw new Error('Nothing is staged. Stage some changes first.');
  const diff = await run(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M'], { env });
  return buildPrompt({ diff, stat, branch });
}

// Apps opened from the Dock get a bare PATH, so also look where these CLIs usually install.
function searchDirs(env = process.env, home = os.homedir()) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '.local/bin', '.claude/local', '.npm-global/bin', '.volta/bin', '.bun/bin']
    .map((d) => (path.isAbsolute(d) ? d : path.join(home, d)));
  return [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...extra])];
}

function findBinary(name, dirs = searchDirs()) {
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

// `signal` (an AbortSignal) stops the CLI too: the promise rejects with an AbortError.
function runCli(bin, args, input, { dirs = searchDirs(), timeout = TIMEOUT, env = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const cancelled = () => Object.assign(new Error(`${path.basename(bin)} was cancelled`), { name: 'AbortError' });
    if (signal?.aborted) return reject(cancelled());
    // An empty folder, so the CLI never reads or edits the repository on its own.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-ai-'));
    const done = (fn, v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } fn(v); };
    // PATH includes the usual install folders: npm-installed CLIs start with `env node`.
    // Own process group, so a timeout stops the CLI and anything it started.
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env, PATH: dirs.join(path.delimiter) }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '', err = '';
    // Decode as a stream, so a character split across two chunks stays whole.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const stop = () => { try { process.kill(-child.pid); } catch { child.kill(); } };
    const timer = setTimeout(() => { stop(); done(reject, new Error(`${path.basename(bin)} didn’t answer within ${timeout / 1000} s`)); }, timeout);
    const onAbort = () => { stop(); done(reject, cancelled()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      if (code === 0) done(resolve, out);
      else done(reject, new Error((err || out).trim().split('\n').slice(-4).join('\n') || `${path.basename(bin)} exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function runOllama(model, prompt, { fetchImpl = fetch, timeout = TIMEOUT } = {}) {
  let res;
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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Ollama answered ${res.status}`);
  return body.response || '';
}

// Ties a consent to the exact text the user previewed.
const promptHash = (prompt) => crypto.createHash('sha256').update(prompt).digest('hex');

async function generate({ provider, model }, prompt, { dirs, fetchImpl, timeout } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('AI commit messages are off. Pick a provider first.');
  let out;
  if (provider === 'ollama') {
    out = await runOllama(model || p.defaultModel, prompt, { fetchImpl, timeout });
  } else {
    const bin = findBinary(p.bin, dirs);
    if (!bin) throw new Error(`Couldn’t find the \`${p.bin}\` command. Install ${p.label} or pick another provider.`);
    out = await runCli(bin, p.args, prompt, { dirs, timeout });
  }
  const msg = cleanMessage(out);
  if (!msg) throw new Error(`${p.label} returned an empty message`);
  return msg;
}

// Saved under `ai` in settings.json: { provider, model, consent: [provider ids] }.
function normalize(saved = {}) {
  return {
    provider: PROVIDER_IDS.includes(saved.provider) ? saved.provider : 'off',
    model: typeof saved.model === 'string' ? saved.model : '',
    consent: Array.isArray(saved.consent) ? saved.consent.filter((c) => PROVIDER_IDS.includes(c)) : [],
  };
}

module.exports = { PROVIDERS, PROVIDER_IDS, MAX_DIFF, buildPrompt, buildPrPrompt, splitPr, promptHash, cleanMessage, stagedChanges, searchDirs, findBinary, runCli, runOllama, generate, normalize };
