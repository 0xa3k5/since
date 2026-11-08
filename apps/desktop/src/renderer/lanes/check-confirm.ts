import { checkFailed, checkTally, duration } from '../review/review-rows.js';
import type { EvidenceCheck } from '../../shared/github-types.ts';

export interface FailingCheck { name: string; duration: number | null }
type Evidence = { checks?: readonly EvidenceCheck[] } | null;

// Merging with a failing check (AK-521): every merge path (Merge…, the row button and M, the
// pane's Merge, Merge all ready, Merge and tidy…) names the failing checks in its confirmation.
// It is a confirm, never a block: the button stays Merge and stays the default. Only when GitHub
// itself blocks the merge (gate.soft) does the existing "Merge anyway" tick apply.

// The failing checks to name: [{ name, duration }]. From the PR's evidence when its reader loaded it
// (it has durations), else from the names `gh` gave (merge info, the PR list).
export function failingChecks({ names = [], evidence = null }: { names?: unknown; evidence?: Evidence } = {}): FailingCheck[] {
  const checks = evidence?.checks;
  const ev: EvidenceCheck[] = Array.isArray(checks) ? checks.filter(checkFailed) : [];
  if (ev.length) return ev.map((c) => ({ name: c.name, duration: typeof c.duration === 'number' && Number.isFinite(c.duration) ? c.duration : null }));
  return (Array.isArray(names) ? names : []).filter((n: unknown): n is string => typeof n === 'string' && !!n).map((name) => ({ name, duration: null }));
}

// How many other checks passed: from evidence, else from `gh`'s { passed, total }. null when unknown.
export function passedCount({ counts = null, evidence = null }: { counts?: { passed?: unknown } | null; evidence?: Evidence } = {}): number | null {
  const checks = evidence?.checks;
  if (Array.isArray(checks) && checks.length) return checkTally(checks).passed;
  const p = counts?.passed;
  return typeof p === 'number' && Number.isSafeInteger(p) ? p : null;
}

// The confirm's lines: one per failing check, up to two, then "and N more"; then "5 other checks
// passed". null when nothing fails.
export interface CheckLines { lines: { name: string; text: string }[]; more: string | null; passed: string | null }
export function checkLines(failing: readonly FailingCheck[] | null | undefined, passed: number | null = null, max = 2): CheckLines | null {
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
export function mergeConfirm({ gate, failing = [], passed = null }: { gate?: { soft?: readonly unknown[] | null } | null; failing?: readonly FailingCheck[]; passed?: number | null }): { checks: CheckLines | null; submit: string; destructive: boolean; anyway: boolean } {
  const anyway = Boolean(gate?.soft?.length);
  const checks = checkLines(failing, passed);
  return { checks, submit: anyway ? 'Merge anyway' : 'Merge', destructive: anyway, anyway };
}

// Whether a merge that already showed its confirm needs one more because checks failed since it
// was opened (e.g. Merge and tidy, which knows the PR list's checks, then asks GitHub).
export const needsCheckConfirm = (shown: boolean, failingNow: readonly unknown[] | null | undefined): boolean => Boolean(failingNow?.length) && !shown;
