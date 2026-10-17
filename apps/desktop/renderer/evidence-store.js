// Change facts and PR evidence for this window (AK-520), shared by Review's rows (lanes-view.js)
// and its reader (review-pane.js), so a row's chips and its reader read one copy.
//  - facts: change-facts.js for `base...head`, git only (the main process caches them per SHA pair
//    too). A head that isn't here (a PR not fetched yet) answers null and isn't asked again.
//  - evidence: github.evidence for a PR, per head commit. Only asked for while pull requests are
//    on, and only when its reader opens; the rows show what's already here (peekEvidence).

const facts = new Map(); // `${base}...${head}` → Promise<facts | null>
const factsDone = new Map(); // same key → facts | null, once known
const evidence = new Map(); // `${remote}#${number}@${head}` → Promise<evidence | null>
const evidenceDone = new Map();
const MAX = 200;

const trim = (m) => { while (m.size > MAX) m.delete(m.keys().next().value); };
const factsKey = (base, head) => `${base}...${head}`;
const evidenceKey = (remote, pr) => `${remote ?? ''}#${pr.number}@${pr.head || pr.updatedAt || ''}`;

export function factsFor(git, base, head) {
  if (!git || !base || !head) return Promise.resolve(null);
  const key = factsKey(base, head);
  if (!facts.has(key)) {
    facts.set(key, git('changeFacts', base, head).catch(() => null).then((f) => { factsDone.set(key, f || null); trim(factsDone); return f || null; }));
    trim(facts);
  }
  return facts.get(key);
}
// undefined: not asked yet; null: asked, nothing to show.
export const peekFacts = (base, head) => factsDone.get(factsKey(base, head));

export function evidenceFor(call, remote, pr) {
  if (!call || !pr?.number) return Promise.resolve(null);
  const key = evidenceKey(remote, pr);
  if (!evidence.has(key)) {
    const p = call('pr-evidence', remote, pr.number, { head: pr.head || null })
      .then((r) => (r?.ok ?? null), () => null)
      .then((ev) => { evidenceDone.set(key, ev); trim(evidenceDone); if (!ev) evidence.delete(key); return ev; });
    evidence.set(key, p);
    trim(evidence);
  }
  return evidence.get(key);
}
export const peekEvidence = (remote, pr) => (pr?.number ? evidenceDone.get(evidenceKey(remote, pr)) : undefined);
