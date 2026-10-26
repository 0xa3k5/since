// Landing page questions. Answers are HTML; the FAQ JSON-LD on / uses the same list with the tags stripped.
import { LICENCE_NAME, PRODUCT_NAME, REPO_URL } from '../../config';

export type Question = { q: string; a: string };

export const FAQ: Question[] = [
  { q: 'Which agents does it work with?', a: `Any of them. ${PRODUCT_NAME} reads branches, worktrees and pull requests, so it doesn't matter what made them. It never launches or controls an agent.` },
  { q: 'Do I need GitHub?', a: 'For some of it. Since, the conflict forecast, the Map, committing and undo work on any git repo. Stuck CI, ready to merge and merging need GitHub and the <code>gh</code> CLI, which you turn on in settings. GitLab and Bitbucket aren\'t supported yet.' },
  { q: "Why not just use GitHub's web UI?", a: `GitHub shows you one PR at a time. ${PRODUCT_NAME} shows what changed since your own checkpoint, tries the ready PRs against each other on your Mac before you merge, and merges a whole stack in one step. It works on top of GitHub, not instead of it.` },
  { q: 'What about the Git client I use now?', a: `Keep it. ${PRODUCT_NAME} uses your system git and the same repo folder, so there's nothing to import or migrate. Use both.` },
  { q: 'Does it send my code anywhere?', a: `No. ${PRODUCT_NAME} is local-first: everything is worked out on your Mac, with your git. It talks to GitHub only when you turn pull request features on. AI commit messages are optional and can run fully on your Mac.` },
  { q: 'Is it free?', a: `Yes. ${PRODUCT_NAME} is free and open source under the ${LICENCE_NAME} licence. The code is <a href="${REPO_URL}">on GitHub</a>.` },
  { q: 'Windows or Linux?', a: 'Not yet. macOS 12 or later, Apple silicon and Intel. The merge plan and conflict forecast need git 2.38 or later.' },
];

export const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') } })),
};
