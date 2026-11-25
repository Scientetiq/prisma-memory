export function timeHash(hash: string): number | null {
  const m = /^#t-(\d{1,6})$/.exec(hash);
  return m ? Number(m[1]) : null;
}

export function nearestTimeAnchor(secs: readonly number[], n: number, truncated = false): { sec: number; beyond: boolean } | null {
  if (!secs.length) return null;
  const sorted = [...secs].sort((a, b) => a - b);
  let best = sorted[0]!;
  for (const s of sorted) { if (s <= n) best = s; else break; }
  const last = sorted[sorted.length - 1]!;
  return { sec: best, beyond: truncated && n > last };
}
