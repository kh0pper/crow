/**
 * `scripts/crow-update.sh` must follow the same rules as the automatic updater
 * (audit N1c-3, S12).
 *
 * Two failure modes it used to have, both silent:
 *   - `git checkout <sha>` detaches HEAD, and then every auto-update tick skips
 *     with "not on main": a manual rollback stops all future updates;
 *   - `systemctl is-active` reports a Type=simple unit active while it is still
 *     about to crash, so the script declared success on a crash loop.
 *
 * Static assertions on purpose: the script restarts a real service.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "scripts", "crow-update.sh"), "utf8");
// Comments mention the forbidden commands on purpose; only code counts.
const code = src.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("the rollback moves main with reset --keep, never checkout", () => {
  assert.match(code, /git -c core\.hooksPath=\/dev\/null reset --keep "\$PREV_REF"/,
    "the rollback must reset --keep the saved ref with hooks disabled");
  assert.ok(!/\bgit\s+checkout\b/.test(code), "a checkout would detach HEAD and stop every future update");
  assert.ok(!/\bcheckout\s+"?\$\{?PREV_REF/.test(code), "no rollback path may checkout the previous ref");
});

test("success requires /health to answer 200 AND the restart counter to hold", () => {
  assert.match(code, /\/health/, "health must be checked over HTTP, not by the unit's active state");
  assert.match(code, /NRestarts/, "a supervised restart must be detected by the unit's restart counter");
  assert.match(
    code,
    /if wait_for_health && \[ "\$\(nrestarts\)" = "\$BEFORE_NRESTARTS" \]; then/,
    "both conditions must gate the success branch together",
  );
});

test("the health wait is bounded and the failure path restores the old code", () => {
  assert.match(code, /HEALTH_TIMEOUT_SECS="\$\{CROW_HEALTH_TIMEOUT_SECS:-90\}"/, "the default deadline is 90 s");
  assert.match(code, /rollback\n/, "the failure branch must call the rollback");
  assert.match(code, /exit 1/, "a failed update must exit non-zero");
});