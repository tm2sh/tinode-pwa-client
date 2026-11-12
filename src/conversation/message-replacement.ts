export function replacementMessageSeq(value: unknown, topicKey: string, seq: number): number | undefined {
  if (typeof value !== 'string') return;
  const match = /^(?:((?:usr|grp|chn)[A-Za-z0-9_-]+))?:([1-9][0-9]*)$/.exec(value);
  if (!match || (match[1] && match[1] !== topicKey)) return;
  const original = Number(match[2]);
  if (Number.isSafeInteger(original) && original < seq) return original;
}
