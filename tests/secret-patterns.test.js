/**
 * A git-free slice of the public-hygiene guard: the runtime tree must never carry
 * a secret-shaped literal.
 *
 * scripts/check-public-hygiene.mjs is the real gate (CI `static-checks`, the
 * pre-push hook, and tests/public-hygiene.test.js's "tracked tree is clean"). It
 * needs git, which a scratch worktree, a tarball export or a sandbox does not
 * have — and it is skipped there. This scans the same RULES over the directories
 * that hold code, straight from disk, using the same exported `checkContent` and
 * the same allowlist, so the list of secret shapes is never itself a hole:
 *
 *   - servers/shared/history/secret-patterns.js is the one list of secret shapes,
 *     imported by the hygiene guard AND the history sweep. It is a tracked file in
 *     a public repository that spells the very things it hunts, so its own source
 *     must stay clean (the character-class forms — `gh[opsur]_`, not a real key —
 *     are what keep it that way; see the module comment there);
 *   - servers/shared/secret-detect.js and the history modules are runtime code and
 *     must not import the CI script for the same reason.
 *
 * Every pattern must also be GLOBAL: the sweep rewrites with String#replace and the
 * scanner iterates with matchAll, and a non-global pattern would silently keep
 * every occurrence after the first in a stored version.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { checkContent, loadAllowlist } from "../scripts/check-public-hygiene.mjs";
import { SECRET_PATTERNS } from "../servers/shared/history/secret-patterns.js";

const ROOT = new URL("..", import.meta.url).pathname;
// The RUNTIME tree only: it is what ships and what a bundle copies, and it is small
// enough to scan on every run. (tests/ and docs/ hold fixtures and prose whose
// secrets the tracked-tree scan and the allowlist cover.)
const SCANNED = ["servers", "scripts"];
const TEXT = /\.(js|mjs|cjs|ts|json|md|sh|txt|ya?ml)$/;

/** Every text file under `dir`, recursively (node_modules and dotfiles skipped). */
function textFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) textFiles(path, out);
    else if (TEXT.test(entry)) out.push(path);
  }
  return out;
}

test("the shared secret-pattern list feeds the guard, and every pattern is global", () => {
  assert.ok(SECRET_PATTERNS.length >= 15, "the list is the real one, not a stub");
  assert.ok(Object.isFrozen(SECRET_PATTERNS), "read-only data: nothing rewrites the list at runtime");
  for (const [name, pattern] of SECRET_PATTERNS) {
    assert.ok(pattern instanceof RegExp, `${name}: a RegExp`);
    assert.ok(pattern.global, `${name}: must be global (String#replace / matchAll)`);
  }
});

test("no secret-shaped literal in servers/ or scripts/", () => {
  const allow = loadAllowlist(readFileSync(join(ROOT, "scripts/public-hygiene-allowlist.txt"), "utf8"));
  const violations = [];
  for (const dir of SCANNED) {
    for (const path of textFiles(join(ROOT, dir))) {
      const text = readFileSync(path, "utf8");
      // The rule this test is about is the secret one; paths are the tracked-tree
      // test's job, and `light` skips the sudo/mail/phone rules that fixtures use.
      for (const found of checkContent(path.slice(ROOT.length), text, { allow, light: true })) {
        if (found.rule.startsWith("secret pattern:")) violations.push(found);
      }
    }
  }
  assert.deepEqual(violations.map((v) => `${v.path}:${v.line} ${v.rule}`), []);
});