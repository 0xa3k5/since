// IPC for opt-in AI commit messages (ai.js).
import * as git from '../git/index.ts';
import * as check from '../ipc.ts';
import * as ai from '../ai.ts';
import { readSettings, writeSettings } from '../settings.ts';
import { session } from '../session.ts';
import { handle, okCall } from './handle.ts';

// ---------------------------------------------------------------------------
// Opt-in AI commit messages (ai.js). The prompt is always built here from the staged diff, never
// taken from the renderer, and nothing is sent to a provider the user hasn't agreed to.

export const aiSettings = (): ai.AiSettings => ai.normalize(readSettings().ai);
const aiState = () => {
  const a = aiSettings();
  return { ...a, consented: (a.consent as string[]).includes(a.provider), providers: ai.PROVIDER_IDS.map((id) => { const p = ai.PROVIDERS[id]; return { id, label: p.label, defaultModel: ('defaultModel' in p && p.defaultModel) || null }; }) };
};
async function aiPrompt(e: { sender: { id: number } }): Promise<string> {
  const root = session(e).repo.root;
  const branch = (await git.run(root, ['branch', '--show-current']).catch(() => '')).trim();
  return ai.stagedChanges(git.run, root, branch);
}
handle('app:ai-settings', () => aiState());
handle('app:ai-configure', (_e, provider, model) => {
  const chosen = check.oneOf('off', ...ai.PROVIDER_IDS)(provider, 'AI provider');
  writeSettings({ ai: { ...aiSettings(), provider: chosen, model: check.str(model ?? '', 'model', { max: 200, empty: true }).trim() } });
  return aiState();
});
handle('app:ai-preview', okCall(async (e) => {
  const prompt = await aiPrompt(e);
  return { ...aiState(), prompt, hash: ai.promptHash(prompt) };
}));
// The first send to a provider carries the hash of the previewed text; if staging changed while
// the preview was open, nothing is sent and the renderer shows the new text instead.
handle('app:ai-generate', okCall(async (e, consent, hash) => {
  const a = aiSettings();
  if (a.provider === 'off') throw new Error('AI commit messages are off.');
  const prompt = await aiPrompt(e);
  if (!a.consent.includes(a.provider)) {
    if (check.bool(consent, 'consent') !== true) throw new Error('Review what will be sent first.');
    if (check.str(hash, 'hash', { max: 64 }) !== ai.promptHash(prompt)) {
      throw Object.assign(new Error('Your staged changes changed while you were reviewing them.'), { code: 'ai-prompt-changed' });
    }
    writeSettings({ ai: { ...a, consent: [...a.consent, a.provider] } });
  }
  return ai.generate(a, prompt);
}));

