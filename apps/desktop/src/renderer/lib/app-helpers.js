import { h, icon, avatar } from './ui.ts';
import { createHistory } from '../graph/log.js';
import * as keymap from '../palette/keymap.ts';
import { authorProfile } from './profile.ts';
import { up } from './upcalls.ts';

// Small helpers the views share: labels, paths, links and tooltips.

// First letter up, for lower-case labels shown as captions.
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const api = window.since;
const ROW_H = 32;
const isMac = navigator.platform.startsWith('Mac');
const MOD = isMac ? '⌘' : 'Ctrl';

const state = {
  repo: null,
  view: 'map',
  // expanded: saved choice for wide windows; pinned/hover: the overlay on narrow ones (see sidebar.js).
  sidebar: { expanded: loadPref('sidebar', { expanded: true }).expanded, pinned: false, hover: false },
  panes: null, // pane widths in px (pane-size.js), saved for every repository
  refs: [],
  head: { branch: null, oid: null, detached: false },
  hist: createHistory(), // the history on screen; commits/index/graph below are its parts
  commits: [],
  logKey: '',
  graph: null,
  index: new Map(),
  byRef: new Map(),
  selected: null,
  detail: true,
  quick: null,
  split: null,
  status: { staged: [], unstaged: [], conflicts: [] },
  opState: null,
  opInfo: null,
  lfs: null, // { used, installed, version, patterns, files }; see git.getLfs
  show: loadPref('show', { tags: true, remotes: true, swatches: true, agentLanes: true, unified: false }),
  search: '',
  stashes: [],
  history: { undo: [], redo: [], undoCount: 0, redoCount: 0 },
  historyLimit: 100, // snapshots loaded per stack; older ones load on request
  snapSel: null, // selected row in the Snapshots view (journal entry id)
  reflog: [],
  config: [],
  remotes: [],
  worktrees: [],
  submodules: [], // see git.getSubmodules
  cv: { list: 'unstaged', path: null, sel: new Set(), anchor: null, lines: new Set(), diff: null, full: false },
  amend: false,
  collapsed: loadPref('collapsed', {}),
  sections: loadPref('sidebarSections', {}), // which refs-tree sections show, in what order (Preferences → Sidebar)
  theme: 'system',
  prs: null, // pull requests from GitHub (see loadPrs); null until known
};

function loadPref(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem('pref:' + k)) }; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem('pref:' + k, JSON.stringify(v)); } catch { /* ignore */ } }
const baseName = (p) => p.split('/').pop();

// A person in the commit details; a link to their GitHub profile when we can place them.
function personLink(name, email) {
  const p = authorProfile(email, up.originRemote()?.web);
  const body = [avatar(name, email, 18), h('span.person-name', null, name)];
  if (!p) return h('span.prop-person', { title: `${name} <${email}>` }, ...body);
  return h('a.prop-person.person-link', { href: p.url, title: `${p.label}\n${name} <${email}>`, onclick: (e) => { e.preventDefault(); api.app('external', p.url); } }, ...body, icon('external', 12));
}

const prop = (label, value) => h('div.prop', null, h('span.prop-label', null, label), h('span.prop-value', null, value));

// Paths as shown: the home folder as ~, and the folder a path is in.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const parentDir = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
function tildePath(p) { return p.replace(/^\/Users\/[^/]+/, '~'); }

// A tooltip with the command's current keys: "Pull (⌘⇧L)", or just the label when it has none.
const keyText = (id) => keymap.keys(id).join('') || 'the Command Menu';
function tip(label, ...ids) {
  const k = ids.map((id) => keymap.keys(id).join('')).filter(Boolean);
  return k.length ? `${label} (${k.join(', ')})` : label;
}

function isEditable(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }

export { state, loadPref, api, tildePath, savePref, tip, MOD, ROW_H, isEditable, prop, personLink, baseName, keyText, sentence, tildify, parentDir, isMac };
