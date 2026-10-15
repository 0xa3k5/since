// Landing page questions. Answers are HTML; the FAQ JSON-LD on / uses the same list with the tags stripped.
import { PRODUCT_NAME } from '../../config';
import { MACS_PER_LICENCE } from '../commerce/links';

export type Question = { q: string; a: string };

export const FAQ: Question[] = [
  { q: 'Which agents does it work with?', a: `Any of them. ${PRODUCT_NAME} reads branches, worktrees and pull requests, so it doesn't matter what made them. It never launches or controls an agent.` },
  { q: 'Do I need GitHub?', a: 'For some of it. Catch-up, the conflict forecast, the Map, committing and undo work on any git repo. Stuck CI, ready to merge, merging and posting a prompt as a PR comment need GitHub and the <code>gh</code> CLI, which you turn on in settings. GitLab and Bitbucket aren\'t supported yet.' },
  { q: "Why not just use GitHub's web UI?", a: `GitHub shows you one PR at a time. ${PRODUCT_NAME} shows what changed since your own checkpoint, tries the ready PRs against each other on your Mac before you merge, and writes the prompt that sends stuck work back. It works on top of GitHub, not instead of it.` },
  { q: 'What about the Git client I use now?', a: `Keep it. ${PRODUCT_NAME} uses your system git and the same repo folder, so there's nothing to import or migrate. Use both.` },
  { q: 'Does it send my code anywhere?', a: `No. ${PRODUCT_NAME} is local-first: everything is worked out on your Mac, with your git. It talks to GitHub only when you turn pull request features on. AI commit messages are optional and can run fully on your Mac. Activating a licence needs a connection once.` },
  { q: 'What happens when the trial ends?', a: `${PRODUCT_NAME} stays open in read-only mode. You can still browse history and diffs, but anything that changes a repository waits until you enter a licence key. Nothing is deleted.` },
  { q: 'How many Macs can I use it on?', a: `One licence covers up to ${MACS_PER_LICENCE} of your Macs at once.` },
  { q: 'Windows or Linux?', a: 'Not yet. macOS 12 or later, Apple silicon and Intel. The merge plan and conflict forecast need git 2.38 or later.' },
];

export const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') } })),
};
