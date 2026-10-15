// Every route on the site, used by the header, the footer and the 404 page.
// Stage-2 work edits only its own page files; add a route here when adding a page.

import { SHOW_PRICING } from './config';

export type Route = { href: string; label: string };

/** Pages that exist only while SHOW_PRICING is on (see astro.config.mjs). Nav links to them are dropped otherwise. */
const COMMERCE = new Set(['/pricing', '/licence']);
const live = (links: Route[]) => (SHOW_PRICING ? links : links.filter((r) => !COMMERCE.has(r.href)));

export const HEADER_NAV: Route[] = live([
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
]);

export const FOOTER_NAV: { title: string; links: Route[] }[] = [
  {
    title: 'Product',
    links: live([
      { href: '/features', label: 'Features' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/download', label: 'Download' },
      { href: '/changelog', label: 'Changelog' },
      { href: '/shortcuts', label: 'Shortcuts' },
    ]),
  },
  {
    title: 'Resources',
    links: live([
      { href: '/docs', label: 'Docs' },
      { href: '/guides', label: 'Guides' },
      { href: '/licence', label: 'Licence help' },
    ]),
  },
];

export const GUIDES: Route[] = [
  { href: '/guides/undo-rebase', label: 'How to undo a git rebase' },
  { href: '/guides/recover-deleted-branch', label: 'How to recover a deleted git branch' },
  { href: '/guides/squash-commits', label: 'How to squash git commits without an editor' },
  { href: '/guides/undo-reset-hard', label: 'How to undo git reset --hard' },
];
