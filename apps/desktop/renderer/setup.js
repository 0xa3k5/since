// First-run "choose your defaults" step on the welcome screen: the features GitLanes turns on for
// you, each with a switch, so people see what's on and can opt out before they start. Pure data
// and helpers (no DOM); the view is setup-view.js.

// Everything here is on by default; ids match the switch values below.
export const SETUP_FEATURES = [
  { id: 'autoUpdate', icon: 'update', label: 'Check for updates automatically', detail: 'At launch and once a day. Updates install when you restart.' },
  { id: 'tags', icon: 'tag', label: 'Show tags on the graph', detail: 'Release tags sit next to the commits they mark.' },
  { id: 'remotes', icon: 'cloud', label: 'Show remote branches', detail: 'See where origin is next to your own branches.' },
  { id: 'swatches', icon: 'theme', label: 'Colour swatches in diffs', detail: 'A small chip next to hex, rgb and hsl values.' },
];

// Off until you pick a provider; one choice for every repository, like the switches above.
export const SETUP_AI = { id: 'ai', icon: 'sparkle', label: 'AI commit messages', detail: 'Pick a provider you trust.' };

// Turned on later, per repository, because they need something from you first.
export const SETUP_LATER = [
  { id: 'prs', icon: 'merge', label: 'Pull requests from GitHub', detail: 'Uses your GitHub CLI login.' },
];

// The saved "done" flag. Old installs without it see the step once too.
export const SETUP_PREF = 'setup';
export const needsSetup = (pref) => !pref?.done;

// Current switch values from the app's saved choices. Unknown means on.
export const setupValues = ({ show = {}, autoUpdate } = {}) => ({
  autoUpdate: autoUpdate !== false,
  tags: show.tags !== false,
  remotes: show.remotes !== false,
  swatches: show.swatches !== false,
});

// How many of the defaults are on, for the summary line.
export const setupSummary = (values) => {
  const on = SETUP_FEATURES.filter((f) => values[f.id]).length;
  return on === SETUP_FEATURES.length ? 'All on. Change any of these later in ⌘K.' : `${on} of ${SETUP_FEATURES.length} on. Change any of these later in ⌘K.`;
};
