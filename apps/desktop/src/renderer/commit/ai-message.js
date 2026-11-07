import { $, toast, dialog, confirm, prompt, palette } from '../lib/ui.ts';
import { up } from '../lib/upcalls.ts';
import { state, api } from '../lib/app-helpers.ts';

// Opt-in AI commit messages: the user's own Claude Code / Codex CLI, or Ollama on this Mac.
// Before the first use with a provider, the user sees the exact text that will be sent.

const aiOn = () => Boolean(state.ai && state.ai.provider !== 'off');
const showAiButton = () => { const b = $('.ai-btn'); if (b) b.hidden = !aiOn(); };

async function setupAi() {
  state.ai = await api.app('ai-settings');
  const current = state.ai.provider;
  const choice = await new Promise((resolve) => {
    palette(() => [
      ...state.ai.providers.map((p) => ({ group: 'AI commit messages', label: p.label, icon: 'sparkle', detail: p.id === current ? 'current' : p.id === 'ollama' ? 'local model' : 'your own CLI', keywords: `ai llm ${p.id}`, run: () => resolve(p) })),
      { group: 'AI commit messages', label: 'Off', icon: 'x', detail: current === 'off' ? 'current' : null, run: () => resolve({ id: 'off' }) },
    // Closing the palette without a pick leaves the setting alone.
    ], { placeholder: 'Write commit messages with…', onDismiss: () => resolve(null) });
  });
  if (!choice) return false;
  let model = '';
  if (choice.id === 'ollama') {
    model = await prompt('Ollama model', { label: 'Model name', value: state.ai.model || choice.defaultModel, submit: 'Use model', description: 'Any model you’ve pulled with `ollama pull`. Requests go to Ollama on this Mac only.' });
    if (model === null) return false;
  }
  state.ai = await api.app('ai-configure', choice.id, model);
  showAiButton();
  toast(aiOn() ? `AI commit messages use ${choice.label}` : 'AI commit messages are off');
  return aiOn();
}

async function writeMessageWithAi() {
  if (!state.repo) return;
  state.ai = await api.app('ai-settings');
  if (!aiOn() && !(await setupAi())) return;
  if (!state.status.staged.length) return toast('Stage some changes first');
  let res;
  for (;;) {
    let consent = false, hash = null;
    if (!state.ai.consented) {
      const preview = await api.app('ai-preview');
      if (preview.error) return toast('Couldn’t prepare the message', { kind: 'error', detail: preview.error.message });
      const label = state.ai.providers.find((p) => p.id === state.ai.provider).label;
      const ok = await dialog({
        title: `Send your staged changes to ${label}?`,
        description: state.ai.provider === 'ollama'
          ? 'Since sends exactly this text to Ollama on this Mac. It doesn’t leave your Mac unless your Ollama does.'
          : `Since passes exactly this text to your ${label} command, which sends it to that tool’s AI service under your own account. Since has no server of its own. You’re asked once per provider.`,
        fields: [{ name: 'text', multiline: true, rows: 14, value: preview.ok.prompt, readonly: true }],
        submit: 'Send', wide: true,
      });
      if (!ok) return;
      consent = true;
      hash = preview.ok.hash;
    }
    if (state.view !== 'commit') up.setView('commit');
    const busy = toast('Writing commit message…', { kind: 'busy', timeout: 0 });
    res = await api.app('ai-generate', consent, hash);
    busy.close();
    state.ai = await api.app('ai-settings');
    // Staging changed while the preview was open: nothing was sent, show the new text.
    if (res.error?.code === 'ai-prompt-changed') { toast(res.error.message); continue; }
    break;
  }
  if (res.error) return toast('Couldn’t write a commit message', { kind: 'error', detail: res.error.message });
  const ta = $('.composer-input');
  if (!ta) return;
  if (ta.value.trim() && ta.value.trim() !== res.ok && !(await confirm('Replace your message?', 'The message you’ve written so far will be replaced.', { submit: 'Replace' }))) return;
  ta.value = res.ok;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

export { aiOn, writeMessageWithAi, setupAi, showAiButton };
