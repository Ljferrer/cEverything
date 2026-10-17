// PURE unified-diff composition for patch (old_string/new_string) and write_file tool calls. No Node imports.

function splitLines(text) {
  if (text === '' || text === null || text === undefined) return [];
  return String(text).replace(/\n$/, '').split('\n');
}

const MAX_LCS_CELLS = 400_000;

/** Line diff → ops [{ t: ' '|'-'|'+', line }]. LCS (minimal) when small enough, else prefix/suffix trimming. */
export function diffLines(oldLines, newLines) {
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: oldLines[i] });
  if (a.length && b.length && a.length * b.length <= MAX_LCS_CELLS) {
    // classic LCS table, then walk back
    const n = a.length; const m = b.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
      else { ops.push({ t: '+', line: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', line: a[i++] });
    while (j < m) ops.push({ t: '+', line: b[j++] });
  } else {
    for (const line of a) ops.push({ t: '-', line });
    for (const line of b) ops.push({ t: '+', line });
  }
  for (let i = oldLines.length - suf; i < oldLines.length; i++) ops.push({ t: ' ', line: oldLines[i] });
  return ops;
}

/** Compose a unified diff (one hunk, ≤ 2 context lines at each end) for a replaced block. */
export function composeUnifiedDiff(path, oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines, newLines);
  let first = 0; while (first < ops.length && ops[first].t === ' ') first++;
  let last = ops.length; while (last > first && ops[last - 1].t === ' ') last--;
  const body = first >= ops.length ? [] : ops.slice(Math.max(0, first - 2), Math.min(ops.length, last + 2));
  let added = 0; let removed = 0; let oldCount = 0; let newCount = 0;
  for (const op of body) {
    if (op.t === '+') { added++; newCount++; } else if (op.t === '-') { removed++; oldCount++; } else { oldCount++; newCount++; }
  }
  const p = path || 'file';
  const lines = [`--- a/${p}`, `+++ b/${p}`, `@@ -1,${oldCount} +1,${newCount} @@`, ...body.map((op) => `${op.t}${op.line}`)];
  return { diff: lines.join('\n'), added, removed };
}

export function diffStats(diff) {
  let added = 0; let removed = 0;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}

