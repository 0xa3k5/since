// Autostash on branch switch. Since tries the plain checkout first; only when git refuses
// because local changes are in the way does it offer to stash them, then switch.
import type { Stash } from '../../shared/git-types.ts';

// The preference saved by "Don't ask again" (Preferences → Git).
export interface AutostashPref { ask: boolean; untracked: boolean }
export const AUTOSTASH_DEFAULT: AutostashPref = { ask: true, untracked: false };

// Why a failed checkout failed, from git's output: null when local changes aren't the reason.
// `untracked` means untracked files are in the way, so the stash must include them.
export function blockedCheckout(output: unknown): { untracked: boolean } | null {
  const s = String(output || '');
  const tracked = /would be overwritten by checkout|commit your changes or stash them before you switch/i.test(s);
  const untracked = /untracked working tree files would be (?:overwritten|removed) by checkout|move or remove them before you switch/i.test(s);
  return tracked || untracked ? { untracked } : null;
}

// Git refusing a merge, pull, cherry-pick, revert or reset over uncommitted changes.
export function blockedByChanges(output: unknown): boolean {
  return /would be overwritten by|commit your changes or stash them|you have unstaged changes|your index contains uncommitted changes|not uptodate\. cannot merge/i.test(String(output || ''));
}

export const stashMessage = (from: string | null | undefined, to: string): string => `Auto-stash on ${from || 'detached HEAD'} before switching to ${to}`;

// Whether to ask, and the untracked option to start from (or use, when not asking).
export function autostashPlan(pref: Partial<AutostashPref> | null | undefined, blocked: { untracked: boolean } | null | undefined): AutostashPref {
  const p = { ...AUTOSTASH_DEFAULT, ...pref };
  return { ask: p.ask, untracked: p.untracked || !!blocked?.untracked };
}

// Pending autostashes are { root, branch, sha }: offered back when `branch` is checked out again.
// Returns the record to offer and the list without it, dropping any whose stash is gone.
export interface AutostashRecord { root: string; branch: string; sha: string }
export interface ReturnOffer { offer: (AutostashRecord & { ref: string; message: string }) | null; records: AutostashRecord[] }
export function returnOffer(records: AutostashRecord[] | null | undefined, root: string, branch: string | null | undefined, stashes: Stash[]): ReturnOffer {
  const live = (records || []).filter((r) => r.root !== root || stashes.some((s) => s.sha === r.sha));
  const hit = branch ? live.find((r) => r.root === root && r.branch === branch) : undefined;
  // A hit is in `live`, so its stash is there.
  const stash = hit && stashes.find((s) => s.sha === hit.sha);
  return { offer: hit && stash ? { ...hit, ref: stash.ref, message: stash.message } : null, records: live.filter((r) => r !== hit) };
}

// The current stash@{N} of the stash with this sha (positions shift when others are stashed), or null.
export const stashRefBySha = (stashes: Stash[] | null | undefined, sha: string): string | null => (stashes || []).find((s) => s.sha === sha)?.ref || null;
