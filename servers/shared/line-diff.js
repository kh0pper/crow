/**
 * A line diff for skill files (Skills panel Compare / Review). A plain LCS
 * table: skill files are small. Above MAX_DIFF_LINES on either side it does
 * not build the table (O(n·m) memory) and shows the old text removed and the
 * new text added instead. No imports.
 */
export const MAX_DIFF_LINES = 2000;

const splitLines = (s) => {
  const t = String(s ?? "").replace(/\r\n/g, "\n");
  if (!t) return [];
  const a = t.split("\n");
  if (a[a.length - 1] === "") a.pop();
  return a;
};

/**
 * @returns {{ lines: Array<{op: " "|"-"|"+", text: string}>, added: number, removed: number, capped: boolean }}
 */
export function lineDiff(oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText);
  const out = [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    for (const x of a) out.push({ op: "-", text: x });
    for (const x of b) out.push({ op: "+", text: x });
    return { lines: out, added: b.length, removed: a.length, capped: true };
  }
  const n = a.length, m = b.length;
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i] }); i++; j++; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { out.push({ op: "-", text: a[i++] }); removed++; }
    else { out.push({ op: "+", text: b[j++] }); added++; }
  }
  while (i < n) { out.push({ op: "-", text: a[i++] }); removed++; }
  while (j < m) { out.push({ op: "+", text: b[j++] }); added++; }
  return { lines: out, added, removed, capped: false };
}
