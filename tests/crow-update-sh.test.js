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
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateQuarantine } from "../servers/shared/update-quarantine.js";

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(REAL_APP_ROOT, "scripts", "crow-update.sh"), "utf8");
// Comments mention the forbidden commands on purpose; only code counts.
const code = src.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("every git command disables hooks and fsmonitor (F1)", () => {
  assert.match(code, /GIT_SAFE=\(-c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false\)/,
    "one array prefixes both flags, so no call site can forget them");
  assert.match(code, /git "\$\{GIT_SAFE\[@\]\}" pull --ff-only/,
    "the pull must not run the incoming commit's own hooks");
  assert.match(code, /git "\$\{GIT_SAFE\[@\]\}" reset --keep "\$PREV_REF"/,
    "the rollback must reset --keep the saved ref with hooks disabled");
  // Every EXECUTED git command (log/echo text does not count) carries the flags.
  const gitLines = code.split("\n").filter((l) => /\bgit\s+/.test(l) && !/^\s*(log|echo) /.test(l));
  assert.ok(gitLines.length >= 4, `expected the script's git commands, found ${gitLines.length}`);
  for (const line of gitLines) assert.match(line, /GIT_SAFE/, `a git command without the flags: ${line}`);
});

test("the rollback moves main with reset --keep, never checkout", () => {
  assert.match(code, /reset --keep "\$PREV_REF"/, "the rollback keeps HEAD attached to main");
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

/* ------------------------------------------------- a real run, with shims */

/**
 * Run the script against a scratch checkout with `git`, `npm`, `node`,
 * `systemctl`, `sudo` and `curl` shims on PATH. Nothing real is touched: no
 * service, no network, no checkout of ours.
 *
 * The `systemctl` shim models the one systemd behaviour S1 is about: a MANUAL
 * restart clears NRestarts. A live unit whose counter is already 7 (planned
 * restarts exit 1 under Restart=on-failure) therefore disagrees with a baseline
 * read BEFORE the restart, and a healthy update used to be rolled back.
 */
function harness({ nrestarts = "7", crash = false, resetFails = false, npmFailsAfter = 0, http = "200", healthTimeout = "2" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crow-update-sh-"));
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // The quarantine marker lands in the git dir the git shim reports.
  const gitDir = join(state, "gitdir");
  mkdirSync(gitDir, { recursive: true });
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  writeFileSync(join(state, "head"), `${A}\n`);
  writeFileSync(join(state, "prev_head"), `${A}\n`);
  writeFileSync(join(state, "new_head"), `${B}\n`);
  writeFileSync(join(state, "nrestarts"), `${nrestarts}\n`);
  writeFileSync(join(state, "restarts.log"), "");
  writeFileSync(join(state, "git.log"), "");

  const shim = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(p, 0o755);
  };
  shim("git", `printf '%s\\n' "$*" >> "$SHIM_STATE/git.log"
while [ "$1" = "-c" ]; do shift 2; done   # git -c k=v ... <cmd>
case "$1" in
  rev-parse)
    case "$2" in
      --short) cut -c1-8 < "$SHIM_STATE/head" ;;
      --absolute-git-dir) printf '%s\\n' "$SHIM_STATE/gitdir" ;;
      HEAD) cat "$SHIM_STATE/head" ;;
      *) exit 0 ;;
    esac ;;
  pull) cp "$SHIM_STATE/new_head" "$SHIM_STATE/head"; printf 'Fast-forward\\n' ;;
  reset)
    if [ -n "$SHIM_RESET_FAIL" ]; then
      printf 'error: Your local changes would be overwritten by reset.\\n' >&2
      exit 3
    fi
    cp "$SHIM_STATE/prev_head" "$SHIM_STATE/head"
    printf 'HEAD is now at %s\\n' "$(cut -c1-8 < "$SHIM_STATE/head")" ;;
  *) exit 0 ;;
esac
exit 0`);
  shim("npm", `printf 'npm %s\\n' "$*" >> "$SHIM_STATE/npm.log"
if [ -n "$SHIM_NPM_FAIL_AFTER" ] && [ "$(wc -l < "$SHIM_STATE/npm.log")" -ge "$SHIM_NPM_FAIL_AFTER" ]; then
  exit 1
fi
exit 0`);
  // The quarantine helper is the one node child that must really run: it writes
  // the marker this file reads back through the gateway's own reader.
  shim("node", `case "$1" in
  *write-update-quarantine.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;
  *) exit 0 ;;
esac`);
  shim("systemctl", `case "$1" in
  show) cat "$SHIM_STATE/nrestarts" ;;
  is-active) exit 0 ;;
  restart)
    printf 'restart\\n' >> "$SHIM_STATE/restarts.log"
    printf '0\\n' > "$SHIM_STATE/nrestarts"
    # Supervised restarts after the (crashing) start bump the counter again.
    [ -n "$SHIM_CRASH" ] && printf '2\\n' > "$SHIM_STATE/nrestarts"
    exit 0 ;;
esac
exit 0`);
  shim("sudo", 'exec "$@"');
  shim("curl", 'printf %s "$SHIM_HTTP"');

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CROW_DATA_DIR: root,
    CROW_HEALTH_TIMEOUT_SECS: healthTimeout,
    SHIM_STATE: state,
    SHIM_HTTP: http,
    SHIM_CRASH: crash ? "1" : "",
    SHIM_RESET_FAIL: resetFails ? "1" : "",
    SHIM_NPM_FAIL_AFTER: npmFailsAfter ? String(npmFailsAfter) : "",
  };
  const r = spawnSync("bash", [join(REAL_APP_ROOT, "scripts", "crow-update.sh")], {
    env, cwd: root, stdio: "pipe", timeout: 60000, encoding: "utf8",
  });
  const log = (() => { try { return readFileSync(join(root, "update.log"), "utf8"); } catch { return ""; } })();
  const restarts = (() => {
    try { return readFileSync(join(state, "restarts.log"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
  })();
  const gitLog = (() => { try { return readFileSync(join(state, "git.log"), "utf8"); } catch { return ""; } })();
  return { root, status: r.status, log, restarts, gitLog, prevRef: A, newRef: B, gitDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("behaviour: a healthy update on a unit that already restarted is NOT rolled back (S1)", () => {
  const h = harness({ nrestarts: "7", http: "200" });
  try {
    assert.equal(h.status, 0, `a healthy update must exit 0, log:\n${h.log}`);
    assert.ok(!/Rolling back to/.test(h.log),
      `the baseline must be read AFTER the restart, or 7 vs 0 looks like a crash loop:\n${h.log}`);
    assert.match(h.log, /Gateway restarted successfully/);
  } finally { h.cleanup(); }
});

test("behaviour: a refused rollback is logged, still restarts the service, exits 1 (S2)", () => {
  const h = harness({ nrestarts: "7", crash: true, resetFails: true, http: "000", healthTimeout: "0" });
  try {
    assert.equal(h.status, 1, `a failed update exits non-zero, not git's status, log:\n${h.log}\ngit:\n${h.gitLog}`);
    assert.match(h.log, /rollback refused/, `the refusal must be logged, not swallowed by set -e, git:\n${h.gitLog}`);
    assert.equal(h.restarts, 2,
      `the rollback must not stop the script before the restart (saw ${h.restarts}), log:\n${h.log}`);
    assert.match(h.log, /the rollback did not complete cleanly/);
    assert.equal(readUpdateQuarantine({ gitDir: h.gitDir }), null,
      "a rollback that never moved the tree must not quarantine the sha (the boot guard owns that case)");
  } finally { h.cleanup(); }
});

test("behaviour: the rollback quarantines the commit it moved off (F7)", () => {
  // Without this marker the next automatic tick re-pulls the sha the script just
  // rolled back and starts the same crash loop again.
  const h = harness({ nrestarts: "7", crash: true, http: "000", healthTimeout: "0" });
  try {
    assert.equal(h.status, 1, `log:\n${h.log}`);
    assert.match(h.log, /Rolling back to/);
    const marker = readUpdateQuarantine({ gitDir: h.gitDir });
    assert.ok(marker, `the rolled-back commit must be quarantined, log:\n${h.log}`);
    assert.equal(marker.sha, h.newRef, "the marker names the commit the rollback moved off");
    assert.equal(marker.previous, h.prevRef);
    assert.equal(marker.reason, "startup-crash");
    assert.equal(marker.by, "crow-update");
    assert.equal(marker.held, undefined, "the checkout is back on the previous commit, so the marker is ordinary");
    assert.equal(marker.expires_at, undefined, "startup-crash waits for main to move, not for a clock");
  } finally { h.cleanup(); }
});

test("behaviour: a failed npm install mid-rollback is logged and the restart still happens (S2)", () => {
  const h = harness({ nrestarts: "7", crash: true, npmFailsAfter: 2, http: "000", healthTimeout: "0" });
  try {
    assert.equal(h.status, 1, `log:\n${h.log}`);
    assert.match(h.log, /npm install failed during the rollback/);
    assert.equal(h.restarts, 2,
      `a failed npm must not exit mid-rollback (saw ${h.restarts} restarts), log:\n${h.log}`);
  } finally { h.cleanup(); }
});