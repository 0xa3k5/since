// Change facts and PR evidence for this window (AK-520), shared by Review's rows (lanes-view.js)
// and its reader (review-pane.js), so a row's chips and its reader read one copy.
//  - facts: change-facts.js for `base...head`, git only (the main process caches them per SHA pair
//    too). A head that isn't here (a PR not fetched yet) answers null and isn't asked again.
//  - evidence: github.evidence for a PR, per head commit. Only asked for while pull requests are
//    on, and only when its reader opens; the rows show what's already here (peekEvidence).

import type { ChangeFacts } from '../../shared/git-types.ts';
import type { PrEvidence, PullRequest } from '../../shared/github-types.ts';
import type { IpcResult } from '../../shared/ipc-contract.ts';

type FactsGit = (method: 'changeFacts', base: string, head: string) => Promise<ChangeFacts | null | undefined>;
type EvidenceCall = (channel: 'pr-evidence', remote: string | null | undefined, number: number, opts: { head: string | null }) => Promise<IpcResult<PrEvidence | null> | null | undefined>;
type EvidencePr = Pick<PullRequest, 'number' | 'head' | 'updatedAt' | 'checks'>;

const facts = new Map<string, Promise<ChangeFacts | null>>(); // `${base}...${head}` → facts | null
const factsDone = new Map<string, ChangeFacts | null>(); // same key, once known
const evidence = new Map<string, Promise<PrEvidence | null>>(); // `${remote}#${number}@${head}` → evidence | null
const evidenceDone = new Map<string, PrEvidence | null>();
const MAX = 200;

const trim = (m: Map<string, unknown>) => { while (m.size > MAX) { const k = m.keys().next().value; if (k === undefined) break; m.delete(k); } };
const factsKey = (base: string, head: string) => `${base}...${head}`;
// The rollup state is in the key too, so a head whose checks moved on (running → failed) is asked again.
const evidenceKey = (remote: string | null | undefined, pr: EvidencePr) => `${remote ?? ''}#${pr.number}@${pr.head || pr.updatedAt || ''}:${pr.checks || ''}`;

export function factsFor(git: FactsGit | null | undefined, base: string | null | undefined, head: string | null | undefined): Promise<ChangeFacts | null> {
  if (!git || !base || !head) return Promise.resolve(null);
  const key = factsKey(base, head);
  let p = facts.get(key);
  if (!p) {
    p = git('changeFacts', base, head).catch(() => null).then((f) => { factsDone.set(key, f || null); trim(factsDone); return f || null; });
    facts.set(key, p);
    trim(facts);
  }
  return p;
}
// undefined: not asked yet; null: asked, nothing to show.
export const peekFacts = (base: string, head: string): ChangeFacts | null | undefined => factsDone.get(factsKey(base, head));

export function evidenceFor(call: EvidenceCall | null | undefined, remote: string | null | undefined, pr: EvidencePr | null | undefined): Promise<PrEvidence | null> {
  if (!call || !pr?.number) return Promise.resolve(null);
  const key = evidenceKey(remote, pr);
  let p = evidence.get(key);
  if (!p) {
    p = call('pr-evidence', remote, pr.number, { head: pr.head || null })
      .then((r) => (r?.ok ?? null), () => null)
      .then((ev) => { evidenceDone.set(key, ev); trim(evidenceDone); if (!ev) evidence.delete(key); return ev; });
    evidence.set(key, p);
    trim(evidence);
  }
  return p;
}
export const peekEvidence = (remote: string | null | undefined, pr: EvidencePr | null | undefined): PrEvidence | null | undefined => (pr?.number ? evidenceDone.get(evidenceKey(remote, pr)) : undefined);
