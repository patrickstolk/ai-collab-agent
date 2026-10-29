// Regel-voor-regel verschil (LCS) tussen twee versies van een tekstbestand.
export function lineDiff(a, b, maxLines = 4000) {
  const A = a.replace(/\r\n/g, '\n').split('\n');
  const B = b.replace(/\r\n/g, '\n').split('\n');
  if (A.length > maxLines || B.length > maxLines || A.length * B.length > 8e6) {
    return { tooLarge: true, ops: [] };
  }
  // gemeenschappelijk begin en einde overslaan om de matrix klein te houden
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const a2 = A.slice(start, endA);
  const b2 = B.slice(start, endB);
  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = A.slice(0, start).map((l) => ({ t: '=', l }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) { ops.push({ t: '=', l: a2[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', l: a2[i++] }); }
    else { ops.push({ t: '+', l: b2[j++] }); }
  }
  while (i < n) ops.push({ t: '-', l: a2[i++] });
  while (j < m) ops.push({ t: '+', l: b2[j++] });
  for (const l of A.slice(endA)) ops.push({ t: '=', l });
  return { tooLarge: false, ops, added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length };
}
