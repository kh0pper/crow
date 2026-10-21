// Skills panel option C, PR 3: the Compare / Review view's line diff (no
// dependency: a small LCS, capped so a huge file can't stall the gateway).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, MAX_DIFF_LINES } from "../servers/shared/line-diff.js";

const ops = (d) => d.map((x) => x.op + x.text).join("|");

test("identical texts: every line is kept", () => {
  const d = lineDiff("a\nb\n", "a\nb\n");
  assert.equal(d.capped, false);
  assert.equal(ops(d.lines), " a| b");
});

test("additions, removals and changes, in order (CRLF reads as LF)", () => {
  assert.equal(ops(lineDiff("a\nb\nc", "a\nB\nc\nd").lines), " a|-b|+B| c|+d");
  assert.equal(ops(lineDiff("x\r\ny\r\n", "x\ny\n").lines), " x| y");
  assert.equal(ops(lineDiff("", "new").lines), "+new");
  assert.equal(ops(lineDiff("old", "").lines), "-old");
});

test("counts of added and removed lines", () => {
  const d = lineDiff("a\nb\nc", "a\nc\nd\ne");
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
});

test("over the cap it falls back to a whole-text replace instead of an LCS", () => {
  const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => "line " + i).join("\n");
  const t0 = Date.now();
  const d = lineDiff(big, big + "\nmore");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(d.capped, true);
  assert.equal(d.lines.filter((x) => x.op === "-").length, MAX_DIFF_LINES + 1);
  assert.equal(d.lines.filter((x) => x.op === "+").length, MAX_DIFF_LINES + 2);
  assert.equal(MAX_DIFF_LINES, 2000);
});
