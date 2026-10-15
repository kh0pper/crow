// The bundle skill ledger (bundles/skill-history.json, plan S2 fix 3 / review
// H3): a build-time, append-only record of the sha256 of every version each
// shipped skill has had, LF-normalised. The boot-time skill sync reads it to
// tell an unedited stale copy (safe to refresh) from a user edit (kept) with
// no runtime git. `--check` runs in CI static-checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { skillHash } from "../servers/gateway/bundle-skill-sync.js";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "build-skill-history.mjs");
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

test("the repo ledger covers every shipped skill's current text (--check)", () => {
  const r = run(["--check"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("skillHash is CRLF-insensitive and content-sensitive", () => {
  assert.equal(skillHash("# a\r\nline\r\n"), skillHash("# a\nline\n"));
  assert.equal(skillHash(Buffer.from("# a\r\n")), skillHash("# a\n"));
  assert.notEqual(skillHash("# a\n"), skillHash("# b\n"));
  assert.match(skillHash("x"), /^[0-9a-f]{64}$/);
});

test("--check fails when a skill is edited without updating the ledger; the default run appends, never drops", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-history-"));
  try {
    put(root, "bundles/alpha/manifest.json", JSON.stringify({ id: "alpha", version: "1.0.0", skills: ["skills/alpha.md"] }));
    put(root, "bundles/alpha/skills/alpha.md", "# alpha v1\n");
    put(root, "bundles/beta/manifest.json", JSON.stringify({ id: "beta", version: "1.0.0" }));
    let r = run(["--root", root, "--check"]);
    assert.equal(r.status, 1, "no ledger yet: the check fails");
    r = run(["--root", root]);
    assert.equal(r.status, 0, r.stderr);
    const v1 = skillHash("# alpha v1\n");
    let ledger = JSON.parse(readFileSync(join(root, "bundles", "skill-history.json"), "utf8"));
    assert.deepEqual(ledger, { "alpha/skills/alpha.md": [v1] });
    assert.equal(run(["--root", root, "--check"]).status, 0);
    // An edit without a ledger update fails the check, naming the skill.
    put(root, "bundles/alpha/skills/alpha.md", "# alpha v2\n");
    r = run(["--root", root, "--check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /alpha\/skills\/alpha\.md/);
    // The default run appends: the old hash stays, in order.
    assert.equal(run(["--root", root]).status, 0);
    ledger = JSON.parse(readFileSync(join(root, "bundles", "skill-history.json"), "utf8"));
    assert.deepEqual(ledger["alpha/skills/alpha.md"], [v1, skillHash("# alpha v2\n")]);
    // A CRLF checkout of the same text is already covered.
    put(root, "bundles/alpha/skills/alpha.md", "# alpha v2\r\n");
    assert.equal(run(["--root", root, "--check"]).status, 0, "CRLF-normalised");
    // A malformed ledger fails the check.
    writeFileSync(join(root, "bundles", "skill-history.json"), "{ not json");
    assert.equal(run(["--root", root, "--check"]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
