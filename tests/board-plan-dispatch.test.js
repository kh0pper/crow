// tests/board-plan-dispatch.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlanFileLine, buildPlanPrompt } from "../scripts/pi-bots/plan_dispatch.mjs";

test("extractPlanFileLine finds the last well-formed marker, rejects escapes", () => {
  assert.equal(extractPlanFileLine("done\nPLAN_FILE: .pi/plans/2026-07-12-card-9-auth.md\n"),
    ".pi/plans/2026-07-12-card-9-auth.md");
  assert.equal(extractPlanFileLine("PLAN_FILE: .pi/plans/a.md\nPLAN_FILE: .pi/plans/b.md"),
    ".pi/plans/b.md");
  assert.equal(extractPlanFileLine("PLAN_FILE: /etc/passwd"), null);
  assert.equal(extractPlanFileLine("PLAN_FILE: ../escape.md"), null);
  assert.equal(extractPlanFileLine("no marker here"), null);
  assert.equal(extractPlanFileLine("PLAN_FILE:    \r\n"), null);
  assert.equal(extractPlanFileLine("PLAN_FILE:\n"), null);
});

test("buildPlanPrompt embeds card fields and the marker contract", () => {
  const p = buildPlanPrompt({ id: 9, title: "Add auth", description: "JWT please" }, ".pi/plans");
  assert.ok(p.includes("CARD #9"));
  assert.ok(p.includes("Add auth"));
  assert.ok(p.includes("JWT please"));
  assert.ok(p.includes("PLAN_FILE:"));
  assert.ok(p.includes(".pi/plans"));
});
