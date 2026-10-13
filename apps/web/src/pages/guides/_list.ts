// The guides that exist, in reading order. Files starting with "_" are not routes.
// routes.ts (owned by the scaffold) lists the first four; the fifth is added here
// until routes.ts gains it (see the PR note).

import type { Route } from '../../routes';

export type Guide = Route & { summary: string };

export const GUIDE_LIST: Guide[] = [
  { href: '/guides/undo-rebase', label: 'How to undo a git rebase', summary: 'Find the commit your branch pointed to before the rebase and move it back.' },
  { href: '/guides/recover-deleted-branch', label: 'How to recover a deleted git branch', summary: 'Find the branch’s last commit in the reflog and recreate the branch there.' },
  { href: '/guides/undo-reset-hard', label: 'How to undo git reset --hard', summary: 'What you can get back after a hard reset, and what you can’t.' },
  { href: '/guides/squash-commits', label: 'How to squash git commits without an editor', summary: 'Combine commits with a soft reset, autosquash or an interactive rebase.' },
  { href: '/guides/edit-commit-message', label: 'How to change a git commit message', summary: 'Fix the last commit’s message, or an older one, and what to do if you already pushed.' },
];
