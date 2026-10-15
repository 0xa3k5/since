// Every route on the site, used by the header, the footer and the 404 page.
// Stage-2 work edits only its own page files; add a route here when adding a page.

export type Route = { href: string; label: string };

export const HEADER_NAV: Route[] = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
];

export const FOOTER_NAV: { title: string; links: Route[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/download', label: 'Download' },
      { href: '/changelog', label: 'Changelog' },
      { href: '/shortcuts', label: 'Shortcuts' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { href: '/docs', label: 'Docs' },
      { href: '/guides', label: 'Guides' },
      { href: '/compare', label: 'Compare' },
      { href: '/licence', label: 'Licence help' },
    ],
  },
];

export const COMPARE: Route[] = [
  { href: '/compare/fork', label: 'Fork' },
  { href: '/compare/tower', label: 'Tower' },
  { href: '/compare/gitkraken', label: 'GitKraken' },
  { href: '/compare/sublime-merge', label: 'Sublime Merge' },
  { href: '/compare/sourcetree', label: 'Sourcetree' },
];

export const GUIDES: Route[] = [
  { href: '/guides/undo-rebase', label: 'How to undo a git rebase' },
  { href: '/guides/recover-deleted-branch', label: 'How to recover a deleted git branch' },
  { href: '/guides/squash-commits', label: 'How to squash git commits without an editor' },
  { href: '/guides/undo-reset-hard', label: 'How to undo git reset --hard' },
];
