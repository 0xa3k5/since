// Copy for the resolve sheets that state the facts before the choice: the stopped operation
// (AK-584) and a diverged pull or rejected push (AK-585). Pure, so it's unit-tested.

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const noDot = (s) => (s || '').replace(/\.+$/, '');

// "Merging feature/conflict into feature/merging is stopped on 1 conflict." `info`: git opInfo.
export function opSentence(info, conflicts = 0) {
  if (!info) return '';
  const tail = conflicts ? `is stopped on ${plural(conflicts, 'conflict')}.` : 'is stopped.';
  const pick = (verb) => `${verb} ${(info.sha || '').slice(0, 7)} ${noDot(info.subject)}`.replace(/\s+$/, '');
  if (info.op === 'merge') return `Merging ${info.from} into ${info.branch || 'HEAD'} ${tail}`;
  if (info.op === 'cherry-pick') return `${pick('Cherry-picking')} ${tail}`;
  if (info.op === 'revert') return `${pick('Reverting')} ${tail}`;
  const what = `Rebasing ${info.branch || 'HEAD'}${info.onto ? ` onto ${info.onto}` : ''}`;
  if (!info.step || !info.total) return `${what} ${tail}`;
  return `${what} is stopped at ${info.step} of ${info.total}${info.subject ? `: ${noDot(info.subject)}` : ''}.`;
}
