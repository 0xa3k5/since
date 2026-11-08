// Managing remotes (Remotes section, ⌘K, Preferences → Repository). Pure logic, no DOM, so it can be unit-tested.

// The same rule as ipc.remoteName: one path component git accepts in refs/remotes/<name>/.
import type { Ref } from '../../shared/git-types.ts';

export function remoteNameError(name: string, remotes: readonly { name: string }[] = [], current: string | null = null): string | null {
  if (!name) return 'Enter a name';
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || name.endsWith('.lock') || name.endsWith('.')) return 'Use letters, digits, “.”, “_” and “-” only';
  if (name !== current && remotes.some((r) => r.name === name)) return `A remote named ${name} already exists`;
  return null;
}

// What removing `name` takes with it: its remote-tracking branches (not its HEAD) and the local branches tracking it.
export interface RemoteUsage { branches: number; tracking: string[] }
export function remoteUsage(refs: readonly Ref[], name: string): RemoteUsage {
  const p = `${name}/`;
  return {
    branches: refs.filter((r) => r.kind === 'remote' && r.short.startsWith(p) && r.short !== `${name}/HEAD`).length,
    tracking: refs.filter((r) => r.kind === 'branch' && r.upstream?.startsWith(p)).map((r) => r.short),
  };
}

// The confirmation text for removing a remote, or null when nothing tracks it (no confirmation needed).
export function removeRemoteWarning({ branches, tracking }: RemoteUsage, undoKey: string): string | null {
  if (!branches && !tracking.length) return null;
  const parts: string[] = [];
  if (branches) parts.push(`${branches} remote branch${branches > 1 ? 'es' : ''}`);
  if (tracking.length) parts.push(`the upstream of ${tracking.length > 3 ? `${tracking.slice(0, 3).join(', ')} and ${tracking.length - 3} more` : tracking.join(', ')}`);
  return `This also removes ${parts.join(' and ')}. Nothing changes on the server. You can undo this with ${undoKey}.`;
}
