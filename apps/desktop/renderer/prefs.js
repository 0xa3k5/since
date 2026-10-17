// The Preferences window (⌘,): its sections and rows, built from a snapshot of the saved choices. Pure data and
// helpers (no DOM); the view is prefs-view.js. Nothing new is stored here: every row reads and writes the same
// place as before (settings.json through the main process, or the renderer's saved prefs), so ⌘K, the menus and
// this window always agree.
//
// A row is { id, section, label, detail?, kind, value?, options?, keywords? } where kind is
//   switch   on/off; value is a boolean
//   choice   one of `options` ({ id, label, icon? }); value is the chosen id
//   action   a button that runs something (opens a dialog, resets…); value is the button label
//   info     read-only text; value is the text
//   config   one git config entry of the open repository; value is { key, value, scope }
// A row with `move: true` can also be moved up or down (act value 'up' / 'down'): the sidebar's sections.

export const PREF_SECTIONS = [
  { id: 'general', label: 'General', icon: 'config' },
  { id: 'git', label: 'Git', icon: 'branch' },
  { id: 'appearance', label: 'Appearance', icon: 'theme' },
  { id: 'sidebar', label: 'Sidebar', icon: 'sidebar' },
  { id: 'prs', label: 'Pull requests', icon: 'merge' },
  { id: 'keyboard', label: 'Keyboard', icon: 'command' },
  { id: 'repository', label: 'Repository', icon: 'folder' },
];

// `s` is the snapshot the app passes in:
//   { autoUpdate, licence, autostash: { ask, untracked }, ai, theme, themes, show: { tags, remotes, swatches,
//     agentLanes }, sidebarExpanded, sections: [{ id, label, icon, hidden }] (refs-tree order), prs: { enabled, hidden, remote, choices, chosen, gh } | null, repo, config: [{ key, value, scope }],
//   remotes: [{ name, url, label }] }
export function prefRows(s) {
  const show = s.show || {};
  const prs = s.prs || null;
  const rows = [
    { section: 'general', id: 'autoUpdate', kind: 'switch', value: s.autoUpdate !== false, label: 'Check for updates automatically', detail: 'At launch and once a day. Updates install when you restart.', keywords: 'update upgrade version' },
    { section: 'general', id: 'checkUpdates', kind: 'action', value: 'Check now', label: 'Check for updates', keywords: 'update upgrade version' },
    ...(s.licence ? [{ section: 'general', id: 'licence', kind: 'action', value: s.licence.licensed ? 'Licence…' : 'Enter key…', label: 'Licence', detail: s.licence.detail || null, keywords: 'license key trial buy' }] : []),
    { section: 'general', id: 'setup', kind: 'action', value: 'Open…', label: 'Choose your defaults', detail: 'The first-launch checklist of what GitLanes turns on.', keywords: 'setup welcome first run' },

    { section: 'git', id: 'autostashAsk', kind: 'switch', value: s.autostash?.ask !== false, label: 'Ask before auto-stashing on checkout', detail: 'Off: GitLanes stashes your changes, switches, and offers them back when you return.', keywords: 'autostash auto stash checkout switch' },
    { section: 'git', id: 'autostashUntracked', kind: 'switch', value: Boolean(s.autostash?.untracked), label: 'Include untracked files in auto-stashes', keywords: 'autostash auto stash untracked new files' },
    { section: 'git', id: 'identity', kind: 'action', value: 'Set…', label: 'Commit identity', detail: 'Name and email for this repository, and rules per remote.', keywords: 'user name email author', repo: true },
    { section: 'git', id: 'ai', kind: 'action', value: 'Choose…', label: 'AI commit messages', detail: s.ai && s.ai !== 'Off' ? `On, using ${s.ai}.` : 'Off. Pick a provider you trust.', keywords: 'ai llm claude codex ollama provider' },

    { section: 'appearance', id: 'theme', kind: 'choice', value: s.theme || 'system', options: s.themes || [], label: 'Theme', detail: 'Follow the system, or pick one.', keywords: 'appearance light dark mode' },
    { section: 'appearance', id: 'tags', kind: 'switch', value: show.tags !== false, label: 'Show tags on the graph', keywords: 'tags release map' },
    { section: 'appearance', id: 'remotes', kind: 'switch', value: show.remotes !== false, label: 'Show remote branches', keywords: 'remote origin branches map' },
    { section: 'appearance', id: 'swatches', kind: 'switch', value: show.swatches !== false, label: 'Colour swatches in diffs', detail: 'A small chip next to hex, rgb and hsl values.', keywords: 'color colour swatch preview' },
    { section: 'appearance', id: 'agentLanes', kind: 'switch', value: show.agentLanes !== false, label: 'Mark branches that look agent-made', detail: 'A badge in Review, from branch names and commit trailers.', keywords: 'agent ai badge' },

    { section: 'sidebar', id: 'sidebarExpanded', kind: 'switch', value: s.sidebarExpanded !== false, label: 'Expanded sidebar', detail: 'Off: a narrow rail of icons.', keywords: 'collapse rail minimize' },
    ...(s.sections || []).map((p, i, all) => ({
      section: 'sidebar', id: `section:${p.id}`, kind: 'switch', move: true, value: !p.hidden, label: p.label, icon: p.icon, fixed: Boolean(p.fixed),
      first: i === 0 || all[i - 1].group !== p.group, last: i === all.length - 1 || all[i + 1].group !== p.group,
      detail: i === 0 ? 'Pages, top to bottom. ⌥↑ ⌥↓ move the selected one; in the sidebar, long-press and drag.' : p.group !== all[i - 1].group ? 'Lists below the divider.' : null,
      keywords: 'sidebar section show hide order reorder move refs tree',
    })),
    { section: 'sidebar', id: 'resetPanes', kind: 'action', value: 'Reset', label: 'Pane sizes', detail: 'Restore the default widths of the sidebar and file lists.', keywords: 'resize width drag default' },

    { section: 'prs', id: 'prsOn', kind: 'switch', value: Boolean(prs?.enabled), label: 'Pull requests from GitHub', detail: prs?.gh === 'missing' ? 'Needs GitHub CLI (gh). Turning this on walks you through it.' : 'Uses your GitHub CLI login. Applies to every repository.', keywords: 'pr github gh enable' },
    ...(s.repo && prs?.enabled && prs.remote ? [{ section: 'prs', id: 'prsHidden', kind: 'switch', value: Boolean(prs.hidden), label: 'Hide pull requests in this repository', keywords: 'pr github gh hide show' }] : []),
    ...(s.repo ? [prRemoteRow(prs)] : []),

    { section: 'keyboard', id: 'shortcuts', kind: 'action', value: 'Customise…', label: 'Keyboard shortcuts', detail: 'Search every shortcut and change any of them.', keywords: 'keys keymap bindings hotkeys' },
    { section: 'keyboard', id: 'importShortcuts', kind: 'action', value: 'Import…', label: 'Import shortcuts', keywords: 'keys keymap bindings' },
    { section: 'keyboard', id: 'exportShortcuts', kind: 'action', value: 'Export…', label: 'Export shortcuts', keywords: 'keys keymap bindings' },
    { section: 'keyboard', id: 'resetShortcuts', kind: 'action', value: 'Reset…', label: 'Reset shortcuts to the defaults', keywords: 'keys keymap bindings' },
  ];
  if (s.repo) {
    rows.push({ section: 'repository', id: 'addRemote', kind: 'action', value: 'Add remote…', label: 'Remotes', detail: s.remotes?.length ? null : 'This repository has no remotes.', keywords: 'remote origin upstream fork url add' });
    for (const r of s.remotes || []) rows.push({ section: 'repository', id: `remote:${r.name}`, kind: 'action', value: 'Edit…', label: r.name, detail: r.label, keywords: 'remote url rename remove' });
    rows.push({ section: 'repository', id: 'addConfig', kind: 'action', value: 'Add option…', label: 'Git config', detail: 'Effective config of this repository. Local values can be edited.', keywords: 'git config option add' });
    for (const c of s.config || []) rows.push({ section: 'repository', id: `config:${c.scope}:${c.key}`, kind: 'config', value: c, label: c.key, keywords: `${c.value} ${c.scope}` });
  }
  return rows.filter((r) => !r.repo || s.repo);
}

// Which remote this repository's PR features use (AK-461). With two or more GitHub remotes it's a choice:
// Automatic (origin when it's on GitHub, else the first GitHub remote) or one of them by name. Remote option ids are
// prefixed so a remote literally named `auto` can't collide with Automatic (AK-484).
export const PR_REMOTE_AUTO = 'auto';
const prRemoteId = (name) => `remote:${name}`;
// The remote name an option id stands for, or null for Automatic.
export const prRemoteChoice = (id) => (id?.startsWith('remote:') ? id.slice(7) : null);
function prRemoteRow(prs) {
  const base = { section: 'prs', id: 'prRemote', label: 'Remote for pull requests', keywords: 'pr github remote origin fork upstream push' };
  const choices = prs?.choices || [];
  if (choices.length < 2) return { ...base, kind: 'info', value: prs?.remote ? `${prs.remote.name} (${prs.remote.owner}/${prs.remote.repo})` : 'No GitHub remote', detail: 'origin when it is on GitHub, else the first GitHub remote.' };
  return {
    ...base, kind: 'choice', value: prs.chosen ? prRemoteId(prs.chosen) : PR_REMOTE_AUTO,
    options: [{ id: PR_REMOTE_AUTO, label: 'Automatic' }, ...choices.map((c) => ({ id: prRemoteId(c.name), label: c.name }))],
    detail: `Lists, reviews and new pull requests use ${prs.remote.owner}/${prs.remote.repo}. New branches push there too.`,
  };
}

// Rows grouped by section, in section order, keeping only rows that match every word of `query` (label, detail,
// keywords, section name or the shown value). Sections with no match are left out.
export function prefSections(rows, query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (r, sec) => [r.label, r.detail, r.keywords, sec.label, typeof r.value === 'string' ? r.value : r.value?.value].filter(Boolean).join(' ').toLowerCase();
  return PREF_SECTIONS.map((sec) => ({
    ...sec,
    rows: rows.filter((r) => r.section === sec.id && words.every((w) => text(r, sec).includes(w))),
  })).filter((sec) => sec.rows.length);
}

// The option after (dir 1) or before (dir -1) the current one, wrapping.
export function nextChoice(row, dir) {
  const ids = row.options.map((o) => o.id);
  const i = ids.indexOf(row.value);
  return ids[(i + dir + ids.length) % ids.length];
}
