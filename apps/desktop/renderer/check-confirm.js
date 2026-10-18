import { checkFailed, checkTally, duration } from './review-rows.js';

// Merging with a failing check (AK-521): every merge path (Merge…, the row button and M, the
// pane's Merge, ⇧M Merge all ready, Merge and tidy…) names the failing checks in its confirmation.
// It is a confirm, never a block: the button stays Merge and stays the default. Only when GitHub
// itself blocks the merge (gate.soft) does the existing "Merge anyway" tick apply.

// The failing checks to name: [{ name, duration }]. From the PR's evidence when its reader loaded it
// (it has durations), else from the names `gh` gave (merge info, the PR list).
export function failingChecks({ names = [], evidence = null } = {}) {
  const ev = Array.isArray(evidence?.checks) ? evidence.checks.filter(checkFailed) : [];
  if (ev.length) return ev.map((c) => ({ name: c.name, duration: Number.isFinite(c.duration) ? c.duration : null }));
  return (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n).map((name) => ({ name, duration: null }));
}

// How many other checks passed: from evidence, else from `gh`'s { passed, total }. null when unknown.
export function passedCount({ counts = null, evidence = null } = {}) {
  if (Array.isArray(evidence?.checks) && evidence.checks.length) return checkTally(evidence.checks).passed;
  return Number.isSafeInteger(counts?.passed) ? counts.passed : null;
}

// The confirm's lines: one per failing check, up to two, then "and N more"; then "5 other checks
// passed". null when nothing fails.
export function checkLines(failing, passed = null, max = 2) {
  if (!failing?.length) return null;
  const lines = failing.slice(0, max).map((c) => ({ name: c.name, text: c.duration != null ? `failed after ${duration(c.duration)}` : 'failed' }));
  const more = failing.length - lines.length;
  return {
    lines,
    more: more > 0 ? `and ${more} more failing check${more === 1 ? '' : 's'}` : null,
    passed: passed ? `${passed} other check${passed === 1 ? '' : 's'} passed` : null,
  };
}

// What the merge sheet does: { checks (checkLines, or null), submit, destructive, anyway }.
// gate: github.mergeGate. Failing checks alone never change the button or add the tick.
export function mergeConfirm({ gate, failing = [], passed = null }) {
  const anyway = Boolean(gate?.soft?.length);
  const checks = checkLines(failing, passed);
  return { checks, submit: anyway ? 'Merge anyway' : 'Merge', destructive: anyway, anyway };
}

// Whether a merge that already showed its confirm needs one more because checks failed since it
// was opened (e.g. Merge and tidy, which knows the PR list's checks, then asks GitHub).
export const needsCheckConfirm = (shown, failingNow) => Boolean(failingNow?.length) && !shown;
