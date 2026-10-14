'use strict';
// Opt-in AI commit messages: prompt building, answer clean-up, finding and running the user's
// CLI, and the Ollama request. Fake CLIs and a temp repo live in the temp dir; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ai = require('../ai');
const git = require('../git');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-ai-test-'));

function fakeCli(dir, name, script) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

test('buildPrompt includes the stat and diff, and caps a large diff', () => {
  const small = ai.buildPrompt({ diff: 'diff --git a/x b/x\n+hi\n', stat: ' x | 1 +\n', branch: 'main' });
  assert.match(small, /Branch: main/);
  assert.match(small, / x \| 1 \+/);
  assert.match(small, /\+hi/);
  const big = ai.buildPrompt({ diff: 'a'.repeat(ai.MAX_DIFF * 2), stat: ' x | 1 +\n' });
  assert.ok(big.length < ai.MAX_DIFF + 2000);
  assert.match(big, /first 48 KB of 96 KB/);
  assert.doesNotMatch(big, /Branch:/);
});

test('cleanMessage strips fences, labels and quotes', () => {
  assert.equal(ai.cleanMessage('```\nAdd login\n\nBody here\n```'), 'Add login\n\nBody here');
  assert.equal(ai.cleanMessage('Commit message:\nFix crash on open'), 'Fix crash on open');
  assert.equal(ai.cleanMessage('"Fix crash on open"\n'), 'Fix crash on open');
  assert.equal(ai.cleanMessage('Fix "quoted" thing'), 'Fix "quoted" thing');
  assert.equal(ai.cleanMessage('A\n\n\n\nB'), 'A\n\nB');
});

test('stagedChanges builds the prompt from the index only', () => {
  const repo = tmp();
  const g = (...a) => execFileSync('git', a, { cwd: repo });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  g('add', '.'); g('commit', '-qm', 'init');
  return (async () => {
    await assert.rejects(ai.stagedChanges(git.run, repo, 'main'), /Nothing is staged/);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nstaged line\n');
    g('add', 'a.txt');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'unstaged secret\n');
    const prompt = await ai.stagedChanges(git.run, repo, 'main');
    assert.match(prompt, /\+staged line/);
    assert.doesNotMatch(prompt, /unstaged secret/);
  })();
});

test('findBinary searches the given folders for an executable', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claude'), 'not executable');
  assert.equal(ai.findBinary('claude', [dir]), null);
  const p = fakeCli(dir, 'claude', 'true');
  assert.equal(ai.findBinary('claude', ['/nonexistent', dir]), p);
  assert.ok(ai.searchDirs({ PATH: '/x/bin' }, '/home/u').includes('/home/u/.local/bin'));
});

test('generate runs the CLI with the prompt on stdin, outside the repo', async () => {
  const dir = tmp();
  fakeCli(dir, 'claude', 'printf "\\`\\`\\`\\nGot: "; head -c 9; printf "\\n\\`\\`\\`\\n"; pwd >&2; pwd > "$(dirname "$0")/cwd"');
  const msg = await ai.generate({ provider: 'claude' }, 'Write the message', { dirs: [dir, '/usr/bin', '/bin'] });
  assert.equal(msg, 'Got: Write the');
  const cwd = fs.readFileSync(path.join(dir, 'cwd'), 'utf8').trim();
  assert.match(cwd, /gitlanes-ai-/);
  assert.equal(fs.existsSync(cwd), false, 'temp folder is removed');
});

test('generate reports a missing CLI, a failing CLI and a timeout', async () => {
  const dir = tmp();
  await assert.rejects(ai.generate({ provider: 'codex' }, 'x', { dirs: [dir] }), /Couldn’t find the `codex` command/);
  fakeCli(dir, 'codex', 'cat >/dev/null; echo "not logged in" >&2; exit 3');
  await assert.rejects(ai.generate({ provider: 'codex' }, 'x', { dirs: [dir, '/bin', '/usr/bin'] }), /not logged in/);
  fakeCli(dir, 'claude', 'sleep 5');
  await assert.rejects(ai.generate({ provider: 'claude' }, 'x', { dirs: [dir, '/bin', '/usr/bin'], timeout: 200 }), /didn’t answer/);
  await assert.rejects(ai.generate({ provider: 'off' }, 'x'), /off/);
});

test('generate asks Ollama on localhost with the chosen model', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ response: 'Add tests\n' }) }; };
  assert.equal(await ai.generate({ provider: 'ollama', model: 'qwen' }, 'P', { fetchImpl }), 'Add tests');
  assert.equal(seen.url, 'http://127.0.0.1:11434/api/generate');
  assert.deepEqual(seen.body, { model: 'qwen', prompt: 'P', stream: false });
  await ai.generate({ provider: 'ollama', model: '' }, 'P', { fetchImpl });
  assert.equal(seen.body.model, 'llama3.2');
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(ai.generate({ provider: 'ollama' }, 'P', { fetchImpl: down }), /Is it running/);
  const missing = async () => ({ ok: false, status: 404, json: async () => ({ error: 'model "x" not found' }) });
  await assert.rejects(ai.generate({ provider: 'ollama', model: 'x' }, 'P', { fetchImpl: missing }), /not found/);
});

test('normalize keeps AI off unless a known provider is saved', () => {
  assert.deepEqual(ai.normalize(undefined), { provider: 'off', model: '', consent: [] });
  assert.deepEqual(ai.normalize({ provider: 'gpt', consent: ['claude', 'evil'] }), { provider: 'off', model: '', consent: ['claude'] });
  assert.equal(ai.normalize({ provider: 'ollama', model: 'qwen' }).model, 'qwen');
});

test('Claude Code runs with no tools and no MCP servers, like Codex runs read-only', () => {
  const { args } = ai.PROVIDERS.claude;
  assert.ok(args.includes('--tools='), 'built-in tools are off');
  assert.ok(args.includes('--strict-mcp-config'), 'user MCP servers are skipped');
  assert.ok(!args.includes('--tools'), 'variadic form would swallow the next argument');
  assert.deepEqual(ai.PROVIDERS.codex.args.slice(2, 4), ['--sandbox', 'read-only']);
});

test('promptHash ties consent to the exact previewed text', () => {
  assert.equal(ai.promptHash('a\n'), ai.promptHash('a\n'));
  assert.notEqual(ai.promptHash('a\n'), ai.promptHash('a \n'));
  assert.match(ai.promptHash('x'), /^[0-9a-f]{64}$/);
});

test('runCli keeps a UTF-8 character that is split across output chunks', async () => {
  const dir = tmp();
  // "é" is 0xC3 0xA9; write the two bytes separately.
  const p = fakeCli(dir, 'claude', 'cat >/dev/null; printf "caf\\303"; sleep 0.2; printf "\\251\\n"');
  assert.equal(await ai.runCli(p, [], 'x', { dirs: [dir, '/usr/bin', '/bin'] }), 'café\n');
});
