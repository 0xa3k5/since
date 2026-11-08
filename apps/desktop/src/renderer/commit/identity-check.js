import { toast, dialog } from '../lib/ui.ts';
import { checkIdentity, matchRule, suggestPattern, upsertRule } from './identity.ts';
import { loadPref, state, savePref } from '../lib/app-helpers.ts';
import { git } from '../lib/bridge.ts';
import { refreshAux } from '../graph/load.js';

// Commit identity: warn before committing as someone this repo doesn't usually commit as, or
// as anyone but the email a user rule assigns to its remotes. Rules and per-repo dismissals are
// app preferences; the fix writes user.name / user.email to the repo's own .git/config.

const identityPrefs = () => loadPref('identity', { rules: [], ignored: {} });

async function setIdentity(name, email, current) {
  try {
    if (name && name !== current.name) await git('setConfig', 'user.name', name, { __label: 'Set user.name' });
    if (email !== current.email) await git('setConfig', 'user.email', email, { __label: 'Set user.email' });
    toast(`This repository now commits as ${email}`, { kind: 'success' });
    return true;
  } catch (e) {
    toast('Couldn’t set the commit identity', { kind: 'error', detail: e.message });
    return false;
  } finally {
    refreshAux();
  }
}

// True when the commit may go ahead: the identity looks right, the user fixed it, or chose to
// commit anyway.
async function identityOk() {
  let id;
  try { id = await git('identity'); } catch { return true; }
  const prefs = identityPrefs();
  const w = checkIdentity(id, prefs.rules, prefs.ignored[state.repo.root] || []);
  if (!w) return true;
  const who = (x) => x.name ? `${x.name} <${x.email}>` : x.email;
  const now = id.email || 'not set';
  const v = await dialog({
    title: 'Commit with this identity?',
    description: w.reason === 'rule'
      ? `Repositories on “${w.pattern}” commit as ${w.expected.email}, but user.email here is ${now}.`
      : `This clone made ${w.count} commits as ${w.expected.email}, but user.email is now ${now}.`,
    fields: [
      { name: 'fix', type: 'checkbox', label: `Use ${who(w.expected)} for this repository`, value: true },
      ...(id.email ? [{ name: 'ignore', type: 'checkbox', label: `Don’t warn about ${id.email} in this repository`, value: false }] : []),
    ],
    submit: 'Commit',
  });
  if (!v) return false;
  if (v.fix) return setIdentity(w.expected.name, w.expected.email, id);
  if (v.ignore) {
    const ignored = { ...prefs.ignored, [state.repo.root]: [...(prefs.ignored[state.repo.root] || []), id.email] };
    savePref('identity', { ...prefs, ignored });
  }
  return true;
}

// ⌘⌥I: set this repo's identity, optionally as a rule for every repo on matching remotes.
async function openIdentity() {
  if (!state.repo) return;
  let id;
  try { id = await git('identity'); } catch (e) { toast('Couldn’t read the commit identity', { kind: 'error', detail: e.message }); return; }
  const prefs = identityPrefs();
  const rule = matchRule(prefs.rules, id.remotes);
  const v = await dialog({
    title: 'Commit identity',
    description: 'Saved to this repository’s .git/config. Add a remote pattern to be warned whenever a repository on it commits as anyone else.',
    fields: [
      { name: 'name', label: 'Name', value: id.name },
      { name: 'email', label: 'Email', value: id.email, placeholder: 'you@example.com' },
      { name: 'pattern', label: 'Rule for remotes containing (optional)', value: rule?.pattern || '', placeholder: suggestPattern(id.remotes[0]) || 'github.com/acme' },
    ],
    submit: 'Save',
  });
  if (!v) return;
  const name = v.name.trim(), email = v.email.trim(), pattern = v.pattern.trim();
  if (!email) { toast('Enter an email', { kind: 'error' }); return; }
  if (!(await setIdentity(name, email, id))) return;
  if (pattern) savePref('identity', { ...prefs, rules: upsertRule(prefs.rules, { pattern, email, name }) });
}

export { identityOk, openIdentity };
