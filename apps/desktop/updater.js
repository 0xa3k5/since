'use strict';
// Auto-update through Electron's built-in autoUpdater (Squirrel.Mac), so the app gains no runtime dependency.
//
// Each release publishes `update-mac-<arch>.json` (Squirrel's JSON feed format) next to the zipped app.
// We fetch that feed ourselves and only hand it to Squirrel when it names a newer version, so a stale or
// older feed can never start a download. Squirrel then downloads in the background, checks that the new
// bundle is signed by the same Developer ID as the running app, and swaps it in on restart (or next quit).
//
// Apart from git itself, the feed request and the download are the app's only network traffic. They carry
// no identifiers and no analytics.
// Loaded lazily so the pure helpers below also run under plain Node (unit tests, scripts/update-feed.js).
let app, autoUpdater, session;

const DAY = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 8_000;

// --- Pure helpers (unit tested) -------------------------------------------------

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? '').trim());
  return m ? { nums: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : [] } : null;
}

// Semver precedence: -1, 0 or 1. Anything unparsable sorts lowest, so it never counts as newer.
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

const feedName = (arch) => `update-mac-${arch}.json`;
const feedUrl = (base, arch) => `${String(base).replace(/\/+$/, '')}/${feedName(arch)}`;
const zipName = (version, arch) => `Since-${version}-${arch}-mac.zip`;

function buildFeed({ version, url, notes = '', pubDate = new Date().toISOString() }) {
  return {
    currentRelease: version,
    releases: [{ version, updateTo: { version, name: `Since ${version}`, pub_date: pubDate, notes, url } }],
  };
}

// Returns { version, url, notes } for the feed's current release, or throws on a malformed feed.
function readFeed(feed) {
  const version = feed?.currentRelease;
  const entry = feed?.releases?.find?.((r) => r?.version === version)?.updateTo;
  if (!parseVersion(version) || !entry || typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) {
    throw new Error('The update feed is malformed.');
  }
  return { version, url: entry.url, notes: entry.notes || '' };
}

// `codesign -dv` output -> true when the bundle carries a real signing identity. Ad-hoc signed (the default
// for an unsigned arm64 build) and unsigned bundles can't be updated by Squirrel, so we never hand them over.
function isSignedOutput(text) {
  const t = String(text || '');
  return /^Authority=/m.test(t) && !/^Signature=adhoc/m.test(t);
}

// --- Updater --------------------------------------------------------------------

// status: disabled | idle | checking | downloading | available | ready | error
let state = { status: 'idle' };
let config = null;
let onChange = () => {};
let lastCheck = 0;
let signed = null;

// The running bundle (Since.app/Contents/MacOS/Since -> Since.app) has a real signature.
function checkSigned() {
  signed ??= new Promise((resolve) => {
    const bundle = require('node:path').resolve(process.execPath, '../../..');
    require('node:child_process').execFile('codesign', ['-dv', '--verbose=2', bundle], (_err, stdout, stderr) => resolve(isSignedOutput(`${stdout}\n${stderr}`)));
  });
  return signed;
}

function set(patch) {
  state = { ...patch, current: app?.getVersion(), auto: auto() };
  onChange(state);
  return state;
}

// Apple silicon Macs running the Intel build under Rosetta move to the native build.
const arch = () => (app.runningUnderARM64Translation ? 'arm64' : process.arch);

const auto = () => config?.auto?.() !== false;

// The private session the feed is fetched in. main.js locks every session down to local files;
// this one may also reach the feed's host (feedOrigins), over https.
const PARTITION = 'since-updates';
// GitHub answers release downloads with a redirect to its asset hosts.
const GITHUB_ASSET_HOSTS = ['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'];
function feedOrigins(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  return [u.origin, ...(u.hostname === 'github.com' ? GITHUB_ASSET_HOSTS : [])];
}
const allowedOrigins = () => (config && state.status !== 'disabled' ? feedOrigins(config.url) : []);

/**
 * opts.auto() -> false turns off the launch and daily checks; manual checks still work. opts.feed: base URL holding update-mac-<arch>.json. opts.page: where to send people when
 * an update can't be installed in place. opts.onChange(state) runs after every state change.
 */
function init(opts) {
  ({ app, autoUpdater, session } = require('electron'));
  config = { ...opts, url: feedUrl(opts.feed, arch()) };
  onChange = opts.onChange || onChange;
  // Squirrel only works on a signed, packaged Mac app (signature checked on the first update found). Dev builds can still check (to test the UI)
  // when SINCE_UPDATE_FEED is set, and show "available" instead of installing.
  config.canInstall = app.isPackaged && process.platform === 'darwin';
  if (!app.isPackaged && !opts.devFeed) return set({ status: 'disabled' });
  if (opts.devFeed) config.url = feedUrl(opts.devFeed, arch());

  if (config.canInstall) {
    autoUpdater.on('update-downloaded', () => set({ status: 'ready', version: state.version }));
    autoUpdater.on('update-not-available', () => set({ status: 'idle' }));
    // Most often: an unsigned build, or the app runs from the DMG or a read-only folder.
    autoUpdater.on('error', (err) => {
      if (state.status === 'downloading') set({ status: 'available', version: state.version, error: err.message, manual: state.manual });
      else set({ status: 'error', error: err.message, manual: state.manual });
    });
  }
  setTimeout(() => { if (auto()) check(); }, FIRST_CHECK_DELAY).unref?.();
  // Hourly tick, checking once a day; also catches up after the Mac wakes from a long sleep.
  setInterval(() => { if (auto() && Date.now() - lastCheck >= DAY) check(); }, 60 * 60 * 1000).unref?.();
  return state;
}

async function check({ manual = false } = {}) {
  if (!config || state.status === 'disabled') return set({ status: 'disabled', manual });
  // Already found or fetching an update: just report where it stands.
  if (['checking', 'downloading', 'ready'].includes(state.status)) return set({ ...state, manual });
  lastCheck = Date.now();
  set({ status: 'checking', manual });
  try {
    // A private in-memory session: no cookies, cache or keychain access shared with anything else.
    const res = await session.fromPartition(PARTITION, { cache: false }).fetch(config.url, {
      headers: { 'Cache-Control': 'no-cache' }, credentials: 'omit', signal: AbortSignal.timeout(30_000),
    });
    // No published release carries a feed yet.
    if (res.status === 404) return set({ status: 'idle', manual });
    if (!res.ok) throw new Error(`The update server answered HTTP ${res.status}.`);
    const feed = readFeed(await res.json());
    if (compareVersions(feed.version, app.getVersion()) <= 0) return set({ status: 'idle', manual });
    if (!config.canInstall) return set({ status: 'available', version: feed.version, manual });
    if (!(await checkSigned())) return set({ status: 'available', version: feed.version, manual, error: 'This copy of Since isn’t signed.' });
    set({ status: 'downloading', version: feed.version, manual });
    autoUpdater.setFeedURL({ url: config.url, serverType: 'json' });
    autoUpdater.checkForUpdates();
    return state;
  } catch (err) {
    return set({ status: 'error', error: err.message, manual });
  }
}

function install() {
  if (state.status === 'ready') autoUpdater.quitAndInstall();
}

// Re-announces the state so the menu and windows pick up a changed setting.
const refresh = () => set({ ...state, manual: false });
const getState = () => state;
const page = () => config?.page || null;

module.exports = { PARTITION, feedOrigins, allowedOrigins, init, check, install, refresh, getState, page, isSignedOutput, compareVersions, parseVersion, buildFeed, readFeed, feedName, feedUrl, zipName };
