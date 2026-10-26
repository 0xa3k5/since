// Every route on the site, used by the header, the footer and the 404 page.
// Stage-2 work edits only its own page files; add a route here when adding a page.

import { REPO_URL } from './config';

export type Route = { href: string; label: string };

export const HEADER_NAV: Route[] = [
  { href: '/features', label: 'Features' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
];

export const FOOTER_NAV: { title: string; links: Route[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features' },
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
      { href: REPO_URL, label: 'Source code' },
    ],
  },
];

export const GUIDES: Route[] = [
  { href: '/guides/undo-rebase', label: 'How to undo a git rebase' },
  { href: '/guides/recover-deleted-branch', label: 'How to recover a deleted git branch' },
  { href: '/guides/squash-commits', label: 'How to squash git commits without an editor' },
  { href: '/guides/undo-reset-hard', label: 'How to undo git reset --hard' },
];
