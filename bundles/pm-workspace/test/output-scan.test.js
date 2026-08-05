import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRules, scanText, redact } from "../server/output-scan.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Compiled rules, the shape loadRules() produces (string patterns are the
// FILE format only; scanText takes compiled RegExp — review round 1 finding 3).
const RULES = [
  { name: "github-token", pattern: /ghp_[A-Za-z0-9]{36}/g, severity: "secret" },
  { name: "ssh-key-block", pattern: /BEGIN (OPENSSH|RSA) PRIVATE KEY/g, severity: "secret" },
];
const FILE_RULES = [
  { name: "github-token", pattern: "ghp_[A-Za-z0-9]{36}", severity: "secret" },
  { name: "ssh-key-block", pattern: "BEGIN (OPENSSH|RSA) PRIVATE KEY", severity: "secret" },
];

test("clean text passes", () => {
  assert.equal(scanText("A perfectly ordinary draft paragraph.", RULES).length, 0);
});

test("seeded token is caught and redacted", () => {
  const text = "leaked: ghp_" + "a".repeat(36) + " end";
  const findings = scanText(text, RULES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, "github-token");
  const red = redact(text, findings);
  assert.ok(!red.includes("ghp_" + "a".repeat(36)));
  assert.ok(red.includes("[REDACTED:github-token]"));
});

test("redact coalesces overlapping spans (review round 1, CRITICAL 1)", () => {
  // The ssn-shaped rule matches a substring INSIDE the slack-token match —
  // a naive per-finding replace-from-the-end corrupts the outer span's
  // stale offset once the inner one has already shifted the string, and
  // raw tail bytes of the token survive. This must not happen.
  const text = "note xoxb-1234567890-345-67-8901-SECRETTAILXYZ end";
  const rules = [
    { name: "slack-token", pattern: /xoxb-1234567890-345-67-8901-SECRETTAILXYZ/g, severity: "secret" },
    { name: "ssn", pattern: /345-67-8901/g, severity: "secret" },
  ];
  const findings = scanText(text, rules);
  assert.equal(findings.length, 2);
  const out = redact(text, findings);
  assert.ok(!/xoxb|345-67-8901|SECRETTAIL/.test(out), `raw token bytes leaked: ${out}`);
  const markers = out.match(/\[REDACTED:[^\]]*\]/g) || [];
  assert.equal(markers.length, 1, `expected exactly one merged marker, got: ${out}`);
});

test("loadRules compiles patterns from a JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  const p = join(dir, "rules.json");
  writeFileSync(p, JSON.stringify({ rules: FILE_RULES }));
  const rules = loadRules(p);
  assert.equal(rules.length, 2);
  assert.ok(rules[0].pattern instanceof RegExp);
  assert.equal(scanText("token ghp_" + "b".repeat(36), rules).length, 1);
});
