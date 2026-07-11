import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePlanRef, resolvePlanFile, containedRealPath }
  from "../servers/gateway/routes/plan-ref.js";

test("parsePlanRef accepts only well-formed refs", () => {
  assert.equal(parsePlanRef(null), null);
  assert.equal(parsePlanRef(""), null);
  assert.equal(parsePlanRef("not json"), null);
  assert.deepEqual(parsePlanRef('{"kind":"workspace"}'), { kind: "workspace" });
  assert.deepEqual(parsePlanRef('{"kind":"repo","path":".pi/plans/2026-07-12-x.md"}'),
    { kind: "repo", path: ".pi/plans/2026-07-12-x.md" });
  assert.equal(parsePlanRef('{"kind":"repo","path":"/etc/passwd"}'), null);      // absolute
  assert.equal(parsePlanRef('{"kind":"repo","path":"../../secrets.md"}'), null); // traversal
  assert.equal(parsePlanRef('{"kind":"repo"}'), null);                           // missing path
  assert.equal(parsePlanRef('{"kind":"other","path":"x.md"}'), null);            // unknown kind
});

test("resolvePlanFile: repo refs join under repoRoot; workspace falls through", () => {
  const r = resolvePlanFile({ kind: "repo", path: ".pi/plans/a.md" }, { repoRoot: "/repo", workspaceInfo: null });
  assert.deepEqual(r, { path: "/repo/.pi/plans/a.md", root: "/repo", kind: "repo" });
  assert.equal(resolvePlanFile({ kind: "repo", path: "a.md" }, { repoRoot: null, workspaceInfo: null }), null);
  const w = resolvePlanFile({ kind: "workspace" },
    { repoRoot: null, workspaceInfo: { path: "/ws/plans/7.md", sessionDir: "/ws" } });
  assert.deepEqual(w, { path: "/ws/plans/7.md", root: "/ws", kind: "workspace" });
  assert.equal(resolvePlanFile(null, { repoRoot: "/repo", workspaceInfo: null }), null);
});

test("containedRealPath refuses symlink escapes, allows real children", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pr-out-"));
  mkdirSync(join(root, "plans"));
  writeFileSync(join(root, "plans", "ok.md"), "x");
  assert.ok(containedRealPath(join(root, "plans", "ok.md"), root));
  assert.ok(containedRealPath(join(root, "plans", "new.md"), root)); // not-yet-existing file, real parent
  writeFileSync(join(outside, "evil.md"), "x");
  symlinkSync(join(outside, "evil.md"), join(root, "plans", "link.md"));
  assert.equal(containedRealPath(join(root, "plans", "link.md"), root), null);
});
