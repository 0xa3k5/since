// Facts for the comparison pages. Files starting with "_" are not routes.
// Every competitor cell cites at least one source; every source carries the date it was checked.
// Recheck all of it each quarter and on publish day (website plan §7.4), then bump `checked`.
// GitLanes cells describe only what is merged on main.

import { PRICE_LATER, PRICE_NOW } from '../../config';

export type Source = { id: string; title: string; url: string; note?: string };
export type Row = { label: string; us: string; them: string; src: string[] };

export type Competitor = {
  slug: string;
  name: string;
  /** Date every source on the page was last checked, YYYY-MM-DD. */
  checked: string;
  title: string;
  description: string;
  intro: string;
  chooseUs: string[];
  chooseThem: string[];
  rows: Row[];
  differences: { title: string; body: string }[];
  betterChoice: string[];
  switching: string[];
  sources: Source[];
};

export const CHECKED = '2026-10-13';

const price = `$${PRICE_NOW} once at launch, $${PRICE_LATER} later. Lifetime updates. 14-day free trial.`;

/** GitLanes facts shared by every page, so the five tables never disagree with each other. */
export const US = {
  price,
  platforms: 'macOS only.',
  account: 'None.',
  undo: '⌘Z / ⌘⇧Z steps back and forward through every operation, with no step limit: branch, tag and HEAD changes, plus discarded files and hard resets. The history is saved in the repo, so it survives a restart.',
  keyboard: 'Single-key commit actions on the graph (E edit message, S squash, F fixup, R rebase, M merge…), arrow keys to move, ⌘K command menu.',
  history: 'Edit message, squash or fixup with parent, delete a commit, move a branch tip, all by key on the graph. No drag and drop.',
  splitter: 'Not yet.',
  worktrees: 'Not yet.',
  submodulesLfs: 'Submodules: not yet. LFS works through your own git, with no special UI.',
  forge: 'Opens the commit or branch on your hosting service. No pull request features.',
  ai: 'None.',
  tech: 'Electron, using the git installed on your Mac.',
};

export const COMPETITORS: Competitor[] = [
  {
    slug: 'fork',
    name: 'Fork',
    checked: CHECKED,
    title: 'GitLanes vs Fork: an alternative for Mac',
    description: 'GitLanes vs Fork: multi-step undo for every branch change, single-key history edits, and a lower one-time price. Facts and sources inside.',
    intro: 'Fork and GitLanes are both one-time purchases with no subscription. Fork is the older, broader app. GitLanes is narrower and built around two things: a commit graph you edit with single keys, and ⌘Z for every change you make to it.',
    chooseUs: [
      'You want ⌘Z to step back through rebases, resets, merges and deleted branches.',
      'You prefer editing history from the keyboard over dragging commits.',
      'You only use a Mac and want to pay less once.',
    ],
    chooseThem: [
      'You need Windows as well as macOS.',
      'You rely on worktrees, submodules or AI commit messages today.',
      'You prefer drag and drop for merging, rebasing and reordering.',
    ],
    rows: [
      { label: 'Price and model', us: US.price, them: '$59.99 one-time. One user, up to 3 machines.', src: ['F2'] },
      { label: 'Platforms', us: US.platforms, them: 'macOS and Windows.', src: ['F1'] },
      { label: 'Undo of branch and history changes', us: US.undo, them: 'No general multi-step undo found in its docs or release notes (unverified).', src: ['F3', 'F4'] },
      { label: 'Keyboard and command palette', us: US.keyboard, them: 'Quick Launch command palette (⌘P).', src: ['F4'] },
      { label: 'History editing', us: US.history, them: 'Interactive rebase, plus drag to merge, rebase, reorder or squash.', src: ['F4'] },
      { label: 'Commit splitter', us: US.splitter, them: 'Not verified.', src: ['F3'] },
      { label: 'Worktrees', us: US.worktrees, them: 'Yes (added in 2.68).', src: ['F3'] },
      { label: 'AI commit messages', us: US.ai, them: 'Yes. Version 2.70 added Cursor as an agent for commit messages.', src: ['F3'] },
      { label: 'Tech', us: US.tech, them: 'Commonly reported as native; not stated on its site (unverified).', src: ['F1'] },
    ],
    differences: [
      { title: 'Undo that goes back more than one step', body: 'Every operation you run in GitLanes is recorded before it happens. ⌘Z restores branches, tags, HEAD and any files the operation overwrote, one step at a time, and the Edit menu names the step it will undo.' },
      { title: 'History edits are single keys', body: 'Select a commit on the graph and press E to edit its message, S to squash it into its parent or F to fix it up. There is no rebase script to write and no drag target to hit.' },
      { title: 'A lower one-time price', body: `GitLanes costs $${PRICE_NOW} at launch and $${PRICE_LATER} later, with lifetime updates. Fork is $59.99 for one user on up to three machines.` },
    ],
    betterChoice: [
      'Fork runs on Windows as well as macOS. GitLanes is Mac-only.',
      'Fork has worktrees, AI commit messages, drag and drop and a repository manager with tabs today. GitLanes has none of these yet.',
      'Fork has a long release history with roughly monthly Mac updates.',
    ],
    switching: [
      'Both apps work on ordinary git repositories, so there is nothing to import or convert. Open the same folder in GitLanes and your branches, stashes and remotes are already there.',
      'GitLanes uses the git installed on your Mac, so your existing config, credentials, hooks and SSH keys keep working.',
      'You can keep both installed and use whichever suits the task.',
    ],
    sources: [
      { id: 'F1', title: 'Fork home page', url: 'https://git-fork.com' },
      { id: 'F2', title: 'Fork: buy a licence', url: 'https://fork.dev/buy' },
      { id: 'F3', title: 'Fork release notes (2.68–2.70)', url: 'https://fork.dev/releasenotes' },
      { id: 'F4', title: 'Fork blog', url: 'https://fork.dev/blog' },
    ],
  },
  {
    slug: 'tower',
    name: 'Tower',
    checked: CHECKED,
    title: 'GitLanes vs Tower: an alternative for Mac',
    description: 'A Tower alternative you pay for once: undo, keyboard-first history editing and no subscription. GitLanes vs Tower, with sources.',
    intro: 'Tower is a mature, team-oriented client sold by yearly subscription. GitLanes is a smaller, Mac-only app you buy once. Both let you undo with ⌘Z. They differ most in price model, in how you edit history and in team features.',
    chooseUs: [
      'You would rather pay once than renew every year.',
      'You want to edit history with single keys instead of drag and drop.',
      'You work alone and don’t need pull request or team features in the client.',
    ],
    chooseThem: [
      'You want pull requests, stacked branches or Graphite inside your Git client.',
      'You need worktrees, submodules or Windows.',
      'Your team wants managed licences or single sign-on.',
    ],
    rows: [
      { label: 'Price and model', us: US.price, them: 'Yearly subscription per user: Basic $69, Pro $129, Enterprise $149. 30-day trial of Pro. Free for students, educators and non-profits.', src: ['T1'] },
      { label: 'Platforms', us: US.platforms, them: 'macOS and Windows; one licence covers both.', src: ['T1'] },
      { label: 'Undo of branch and history changes', us: US.undo, them: '“Undo anything” with ⌘Z, including local changes, reverted commits and deleted branches.', src: ['T4'] },
      { label: 'Keyboard and command palette', us: US.keyboard, them: 'Keyboard shortcuts; history editing is built around drag and drop.', src: ['T5'] },
      { label: 'History editing', us: US.history, them: 'Drag-and-drop interactive rebase.', src: ['T5'] },
      { label: 'Stacked branches', us: 'Not yet.', them: 'Yes, in Pro and above, with Graphite support.', src: ['T1', 'T5'] },
      { label: 'Commit splitter', us: US.splitter, them: 'No dedicated splitter found (unverified).', src: ['T4'] },
      { label: 'Pull requests', us: US.forge, them: 'Yes, from Basic up.', src: ['T1'] },
      { label: 'AI commit messages', us: US.ai, them: 'Yes (since Tower 16), using your own local Claude Code or Codex.', src: ['T3', 'T7'] },
      { label: 'Tech', us: US.tech, them: 'Native Mac app.', src: ['T1'] },
    ],
    differences: [
      { title: 'Pay once, keep every update', body: `GitLanes is $${PRICE_NOW} at launch and $${PRICE_LATER} later, once, with lifetime updates and no renewal. Tower Basic is $69 per user per year.` },
      { title: 'History edits are single keys', body: 'Select a commit and press E, S or F to edit its message, squash or fix it up. You never leave the keyboard or open a rebase editor.' },
      { title: 'Undo you can read ahead', body: 'The Edit menu names the exact step ⌘Z will undo, and the Snapshots view (⌘4) lists every recorded operation so you can restore the state before any of them.' },
    ],
    betterChoice: [
      'Tower has pull requests, stacked branches, Graphite and team management. GitLanes has none of these.',
      'Tower runs on Windows and is a native Mac app.',
      'Tower already has worktrees and AI commit messages.',
      'Tower’s free licences for students, educators and non-profits make it the cheaper option for those groups.',
    ],
    switching: [
      'Both apps work on ordinary git repositories, so there is nothing to import. Open the same folder in GitLanes.',
      'GitLanes uses the git installed on your Mac, so your config, credentials, hooks and SSH keys keep working.',
      'Try GitLanes for 14 days alongside Tower before your next renewal comes up.',
    ],
    sources: [
      { id: 'T1', title: 'Tower pricing', url: 'https://www.git-tower.com/pricing' },
      { id: 'T3', title: 'Tower 16 for Mac: AI Commits', url: 'https://www.git-tower.com/blog/tower-mac-16' },
      { id: 'T4', title: 'Tower features', url: 'https://www.git-tower.com/features' },
      { id: 'T5', title: 'Tower drag and drop; Graphite guide', url: 'https://www.git-tower.com/features/drag-and-drop', note: 'and https://www.git-tower.com/help/guides/workflows/graphite-managing/mac' },
      { id: 'T7', title: 'Tower help: committing with AI', url: 'https://www.git-tower.com/help/guides/working-copy/committing-with-ai/mac' },
    ],
  },
  {
    slug: 'gitkraken',
    name: 'GitKraken',
    checked: CHECKED,
    title: 'GitLanes vs GitKraken: an alternative for Mac',
    description: 'A GitKraken alternative for Mac with no account and no subscription, plus undo for every branch change. Facts and sources inside.',
    intro: 'GitKraken Desktop is a cross-platform client with a large feature set, sold by yearly subscription and tied to an account. GitLanes is a Mac-only app with no account that you buy once, focused on editing and undoing history from the keyboard.',
    chooseUs: [
      'You don’t want to sign in to use your Git client.',
      'You want to undo more than the last action.',
      'You would rather pay once than every year.',
    ],
    chooseThem: [
      'You need Windows or Linux.',
      'You want forge, issue-tracker and AI features inside the client.',
      'You coordinate several AI agents across worktrees.',
    ],
    rows: [
      { label: 'Price and model', us: US.price, them: 'Yearly subscription. List prices: Pro $120/yr (up to 2 seats), Advanced $168/yr, Business $216/yr. Free Community plan for public and local repos.', src: ['K2', 'K3'] },
      { label: 'Account', us: US.account, them: 'Required, including on the free plan (unverified: the pricing page is ambiguous).', src: ['K1', 'K2'] },
      { label: 'Platforms', us: US.platforms, them: 'macOS, Windows and Linux.', src: ['K1'] },
      { label: 'Undo of branch and history changes', us: US.undo, them: '“The most recent supported action only.”', src: ['K6'] },
      { label: 'Keyboard and command palette', us: US.keyboard, them: 'Command palette (⌘P).', src: ['K11'] },
      { label: 'History editing', us: US.history, them: 'Interactive rebase view and drag and drop.', src: ['K12'] },
      { label: 'Commit splitter', us: US.splitter, them: 'No manual splitter (requested since 2021). AI Commit Composer can regroup changes.', src: ['K10', 'K13'] },
      { label: 'Worktrees', us: US.worktrees, them: 'Yes, with agent sessions per worktree.', src: ['K5'] },
      { label: 'Forge and AI', us: `${US.forge} No AI.`, them: 'Integrations with hosting services and issue trackers; AI commit messages, conflict resolution and Commit Composer.', src: ['K1', 'K13'] },
      { label: 'Large repositories', us: 'The graph shows the full history, streamed in from git as it loads.', them: 'Official help suggests limiting the number of commits in the graph for performance.', src: ['K9'] },
      { label: 'Tech', us: US.tech, them: 'Electron (widely reported; not stated on an official page, unverified).', src: ['K1'] },
    ],
    differences: [
      { title: 'No account', body: 'GitLanes opens your repository straight away. There is nothing to sign in to, and your licence key is the only thing you keep.' },
      { title: 'Undo that goes back further', body: 'GitKraken can undo the most recent supported action. GitLanes keeps every operation, and ⌘Z walks back through them one at a time, including resets and discarded files.' },
      { title: 'One payment', body: `GitLanes is $${PRICE_NOW} at launch and $${PRICE_LATER} later, once, with lifetime updates. GitKraken Pro lists at $120 a year.` },
    ],
    betterChoice: [
      'GitKraken runs on Windows and Linux as well as macOS.',
      'It integrates with hosting services and issue trackers, and has AI features and agent sessions. GitLanes has none of these.',
      'Its free Community plan costs nothing for public and local repositories.',
      'It already supports worktrees and workspaces across many repositories.',
    ],
    switching: [
      'Both apps work on ordinary git repositories, so there is nothing to import. Open the same folder in GitLanes.',
      'GitLanes uses the git installed on your Mac, so your config, credentials and SSH keys keep working without signing in to anything.',
      'GitKraken workspaces and integrations stay in GitKraken; GitLanes works one repository per window.',
    ],
    sources: [
      { id: 'K1', title: 'GitKraken Desktop', url: 'https://www.gitkraken.com/git-client' },
      { id: 'K2', title: 'GitKraken pricing', url: 'https://www.gitkraken.com/pricing' },
      { id: 'K3', title: 'GitKraken plan price list (endpoint used by the pricing page)', url: 'https://api.gitkraken.com/plan/chargebee' },
      { id: 'K5', title: 'GitKraken Desktop release notes', url: 'https://help.gitkraken.com/gitkraken-desktop/current/' },
      { id: 'K6', title: 'GitKraken help: undo and redo', url: 'https://help.gitkraken.com/gitkraken-client/undo-and-redo' },
      { id: 'K9', title: 'GitKraken help: performance issues', url: 'https://help.gitkraken.com/gitkraken-desktop/performance-issues/' },
      { id: 'K10', title: 'GitKraken feedback: split commit request', url: 'https://feedback.gitkraken.com/suggestions/191932/comment/655142' },
      { id: 'K11', title: 'GitKraken help: command palette', url: 'https://help.gitkraken.com/gitkraken-desktop/command-palette/' },
      { id: 'K12', title: 'GitKraken help: interactive rebase', url: 'https://help.gitkraken.com/gitkraken-desktop/interactive-rebase/' },
      { id: 'K13', title: 'GitKraken help: GitKraken AI', url: 'https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/' },
    ],
  },
  {
    slug: 'sublime-merge',
    name: 'Sublime Merge',
    checked: CHECKED,
    title: 'GitLanes vs Sublime Merge: an alternative for Mac',
    description: 'GitLanes vs Sublime Merge: history editing on the graph, an undo history that survives restarts, and lifetime updates. Facts and sources inside.',
    intro: 'Sublime Merge and GitLanes both suit people who like the keyboard. Sublime Merge is cross-platform, with a strong diff and merge tool. GitLanes is Mac-only and centres on editing the commit graph directly and undoing any step.',
    chooseUs: [
      'You want to squash, fix up and reword commits straight from the graph.',
      'You want an undo history of your own operations that survives a restart.',
      'You want lifetime updates from a single payment.',
    ],
    chooseThem: [
      'You need Windows or Linux.',
      'You want a 3-way merge editor and custom key bindings.',
      'You want to keep evaluating for free with no time limit.',
    ],
    rows: [
      { label: 'Price and model', us: US.price, them: '$99 one-time with 3 years of updates. Business: $75 per user per year. Evaluation has no time limit.', src: ['S4'] },
      { label: 'Platforms', us: US.platforms, them: 'macOS, Windows and Linux.', src: ['S1'] },
      { label: 'Undo of branch and history changes', us: US.undo, them: 'Repository → Undo / Redo steps back and forward through the reflog.', src: ['S6'] },
      { label: 'Keyboard and command palette', us: US.keyboard, them: 'Command palette and customisable key bindings.', src: ['S10'] },
      { label: 'History editing', us: US.history, them: 'Edit, squash and reword from the commit context menu.', src: ['S5', 'S6'] },
      { label: 'Merge conflicts', us: 'Pick ours or theirs per file, then mark resolved. No 3-way editor.', them: '3-way merge tool.', src: ['S2'] },
      { label: 'Worktrees', us: US.worktrees, them: 'Yes (added in build 2130).', src: ['S1'] },
      { label: 'Forge and AI', us: `${US.forge} No AI.`, them: 'No pull request features and no AI.', src: ['S3'] },
      { label: 'Tech', us: US.tech, them: 'Custom C++ UI toolkit shared with Sublime Text, plus its own git-reading library.', src: ['S2'] },
    ],
    differences: [
      { title: 'Edit history where you see it', body: 'Select any commit on the current branch and press E, S or F. GitLanes rewrites the commits above it and keeps your branch where you expect.' },
      { title: 'An undo history of your own operations', body: 'GitLanes records each operation with the refs and files it changed, and saves that history inside the repository. ⌘Z after a restart still undoes the last thing you did.' },
      { title: 'Updates for life', body: `GitLanes is $${PRICE_NOW} at launch and $${PRICE_LATER} later, with every future update included. A Sublime Merge licence is $99 with three years of updates.` },
    ],
    betterChoice: [
      'Sublime Merge runs on Windows and Linux as well as macOS.',
      'Its 3-way merge tool, diff and blame views are more capable than GitLanes’ conflict handling.',
      'It has customisable key bindings and worktrees today.',
      'You can evaluate it with no time limit.',
    ],
    switching: [
      'Both apps work on ordinary git repositories, so there is nothing to import. Open the same folder in GitLanes.',
      'GitLanes uses the git installed on your Mac, so your config, credentials, hooks and SSH keys keep working.',
      'Sublime Merge can stay installed as your merge tool for hard conflicts.',
    ],
    sources: [
      { id: 'S1', title: 'Sublime Merge download and build notes', url: 'https://www.sublimemerge.com/download' },
      { id: 'S2', title: 'Sublime Merge home page', url: 'https://www.sublimemerge.com/' },
      { id: 'S3', title: 'Sublime Merge FAQ', url: 'https://www.sublimemerge.com/docs/faq' },
      { id: 'S4', title: 'Sublime HQ store: Sublime Merge', url: 'https://www.sublimehq.com/store/merge' },
      { id: 'S5', title: 'Sublime Merge docs: getting started', url: 'https://www.sublimemerge.com/docs/getting_started' },
      { id: 'S6', title: 'Sublime Merge blog: creating and updating commits', url: 'https://www.sublimemerge.com/blog/sublime-merge-git-tips-creating-updating-commits' },
      { id: 'S10', title: 'Sublime Merge docs: key bindings', url: 'https://www.sublimemerge.com/docs/key_bindings' },
    ],
  },
  {
    slug: 'sourcetree',
    name: 'Sourcetree',
    checked: CHECKED,
    title: 'GitLanes vs Sourcetree: an alternative for Mac',
    description: 'A Sourcetree alternative for Mac with undo, a ⌘K command menu and a live commit graph. GitLanes vs Sourcetree, with sources.',
    intro: 'Sourcetree is free and has been around for years. Its recent Mac releases contain fixes only. GitLanes is a paid, actively developed Mac app built around undo and the keyboard.',
    chooseUs: [
      'You want ⌘Z to reverse a rebase, reset or deleted branch.',
      'You want to drive your Git client from the keyboard, with a ⌘K command menu.',
      'You want a client that is still adding features.',
    ],
    chooseThem: [
      'You need a free client.',
      'Your team works in Bitbucket.',
      'You need Windows, or rely on submodules today.',
    ],
    rows: [
      { label: 'Price and model', us: US.price, them: 'Free.', src: ['ST1'] },
      { label: 'Platforms', us: US.platforms, them: 'macOS and Windows.', src: ['ST1'] },
      { label: 'Recent development', us: 'In active development.', them: 'Latest Mac release 4.2.19 contains fixes only.', src: ['ST2', 'ST3'] },
      { label: 'Undo of branch and history changes', us: US.undo, them: 'No undo found (unverified).', src: ['ST1'] },
      { label: 'Keyboard and command palette', us: US.keyboard, them: 'No command palette found (unverified).', src: ['ST1'] },
      { label: 'Submodules and LFS', us: US.submodulesLfs, them: 'Yes, both.', src: ['ST1'] },
      { label: 'Forge integration', us: US.forge, them: 'Bitbucket and other hosting accounts.', src: ['ST1'] },
      { label: 'Large repositories', us: 'The graph shows the full history, streamed in from git as it loads.', them: 'Long-standing public bug reports about slowness on large repositories.', src: ['ST4', 'ST5'] },
    ],
    differences: [
      { title: 'Undo for every step', body: 'GitLanes records each operation before it runs. ⌘Z puts branches, tags, HEAD and any overwritten files back, and ⌘⇧Z redoes it.' },
      { title: 'Keyboard first', body: 'j and k move through the graph, single keys act on the selected commit, and ⌘K finds any command by name.' },
      { title: 'Live graph', body: 'GitLanes watches your repository and refreshes the graph when anything changes, including commands you run in the terminal.' },
    ],
    betterChoice: [
      'Sourcetree is free. GitLanes costs money after the 14-day trial.',
      'It integrates with Bitbucket and has submodule support today.',
      'It runs on Windows as well as macOS.',
    ],
    switching: [
      'Both apps work on ordinary git repositories, so there is nothing to import. Open the same folder in GitLanes.',
      'GitLanes uses the git installed on your Mac, so your config, credentials and SSH keys keep working.',
      'Hosting accounts you added in Sourcetree stay there; GitLanes pushes and pulls with your normal git credentials.',
    ],
    sources: [
      { id: 'ST1', title: 'Sourcetree home page', url: 'https://www.sourcetreeapp.com/' },
      { id: 'ST2', title: 'Sourcetree download archives', url: 'https://www.sourcetreeapp.com/download-archives' },
      { id: 'ST3', title: 'Sourcetree 4.2.19 release notes', url: 'https://product-downloads.atlassian.com/software/sourcetree/ReleaseNotes/Sourcetree_4.2.19.html' },
      { id: 'ST4', title: 'Atlassian issue SRCTREE-1462', url: 'https://jira.atlassian.com/browse/SRCTREE-1462' },
      { id: 'ST5', title: 'Atlassian issue SRCTREE-6538', url: 'https://jira.atlassian.com/browse/SRCTREE-6538' },
    ],
  },
];

export const bySlug = (slug: string) => {
  const c = COMPETITORS.find((x) => x.slug === slug);
  if (!c) throw new Error(`No comparison data for ${slug}`);
  return c;
};
