/**
 * N3-4 phase 2b — Crow creates the admin login for Frigate, motionEye and Wallabag.
 *
 * Each of the three bundles now ships `scripts/first-admin.sh` and declares
 * `firstAdmin: { mode: "crow", via: "setup", ... }`, so the installer runs the script
 * once after `compose up` with the generated password as ONE line on stdin. What these
 * tests hold down:
 *
 *   1. a fresh app: exit 0, the password delivered on stdin and NEVER in a docker
 *      argument (that is what a process list would show),
 *   2. an app that already has its own admin: exit 3, and no set call at all,
 *   3. docker missing / the container not running: exit 4, nothing changed,
 *   4. a password the protocol refuses (short, empty): exit 1, and docker is not even
 *      asked,
 *   5. the app refusing the new login when it is proved: exit 1,
 *   6. Wallabag's missing schema installed, an existing one left alone,
 *   7. motionEye restarted after the password is set (the running server caches it),
 *   8. the three manifests carry what the contract, the runner and the card need.
 *
 * No docker here: a `docker` executable written into a temp dir sits first on PATH,
 * records every argv and the stdin it received, and replays canned answers. The scripts
 * only ever reach a container through `docker exec`/`inspect`/`restart`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = (id) => join(REPO, "bundles", id);

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";

const TMP = mkdtempSync(join(tmpdir(), "crow-fa-scripts-"));
const BIN = join(TMP, "bin");
const NO_DOCKER = join(TMP, "no-docker");
/** By absolute path: the "no docker at all" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(NO_DOCKER, { recursive: true });

/**
 * The stand-in docker. Every call is recorded as `<dir>/call.<n>.argv` (the arguments
 * joined by spaces) plus `<dir>/call.<n>.stdin`, and answered from `FAKE_<KEY>_<i>` env
 * vars — the i-th answer for that KEY, falling back to the KEY's default.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  'printf "%s" "$*" > "$dir/call.$n.argv"',
  'if [[ " $* " == *" -i "* ]]; then cat > "$dir/call.$n.stdin"; else : > "$dir/call.$n.stdin"; fi',
  "",
  "NEXT=\"\"",
  "# next KEY DEFAULT: the i-th answer for KEY (FAKE_<KEY>_0, _1, ...), else DEFAULT.",
  "next() {",
  '  local key="$1" dflt="$2" cf="$dir/counter.$1" i=0',
  '  if [ -f "$cf" ]; then i=$(cat "$cf"); fi',
  '  printf "%s\\n" "$((i + 1))" > "$cf"',
  '  local var="FAKE_${key}_${i}"',
  '  if [ -n "${!var:-}" ]; then NEXT="${!var}"; else NEXT="$dflt"; fi',
  "}",
  "",
  'case "${1:-}" in',
  '  inspect) next RUNNING true; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  restart) exit 0 ;;",
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  'case "$args" in',
  // Frigate: the sqlite probe, the internal-API set, the login proof on :8971.
  '  *password_changed_at*) next FRIGATE_STATE null; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  */api/users/*) next FRIGATE_SET_BODY \'{"success": true}\'; body="$NEXT"; next FRIGATE_SET_RC 0; printf "%s" "$body"; exit "$NEXT" ;;',
  '  *api/login*) next FRIGATE_LOGIN 200; printf "%s\\n" "$NEXT"; exit 0 ;;',
  // motionEye: the config probe, the set, the readiness probe, the login proof.
  '  *config.get_main*) next MOTIONEYE_STATE empty; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  *set_admin_password*) exit 0 ;;",
  '  *HTTPConnection*) next MOTIONEYE_UP 0; exit "$NEXT" ;;',
  '  *8765/login*) next MOTIONEYE_LOGIN 200; printf "%s\\n" "$NEXT"; exit 0 ;;',
  // Wallabag: the schema query, the install, the password change, the login checks.
  '  *wallabag_user*) next WALLABAG_SCHEMA 0; exit "$NEXT" ;;',
  "  *wallabag:install*) exit 0 ;;",
  '  *fos:user:change-password*) next WALLABAG_CHANGE "Changed password for user wallabag"; printf "%s\\n" "$NEXT"; next WALLABAG_CHANGE_RC 0; exit "$NEXT" ;;',
  '  *login_check*) next WALLABAG_LOGIN 0; exit "$NEXT" ;;',
  '  *:80/*) next WALLABAG_UP 0; exit "$NEXT" ;;',
  '  *) printf "fake docker: no answer for: %s\\n" "$args" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** One recorded call: the arguments it saw and whatever arrived on stdin. */
function readCalls(dir) {
  const out = [];
  for (let i = 0; existsSync(join(dir, `call.${i}.argv`)); i++) {
    out.push({
      argv: readFileSync(join(dir, `call.${i}.argv`), "utf8"),
      stdin: readFileSync(join(dir, `call.${i}.stdin`), "utf8"),
    });
  }
  return out;
}

/** Run a bundle's setup script with the password on stdin, as the installer does. */
function run(bundle, { password = `${PASSWORD}\n`, env = {}, withDocker = true } = {}) {
  const dir = mkdtempSync(join(TMP, "calls-"));
  const res = spawnSync(BASH, [join(B(bundle), "scripts", "first-admin.sh")], {
    input: password,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: withDocker ? `${BIN}:/usr/bin:/bin` : `${NO_DOCKER}`,
      HOME: TMP,
      CROW_FIRST_ADMIN_USER: bundle === "wallabag" ? "wallabag" : "admin",
      FAKE_DOCKER_DIR: dir,
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", calls: readCalls(dir) };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("");
const ran = (r, needle) => r.calls.some((c) => c.argv.includes(needle));
const indexOf = (r, needle) => r.calls.findIndex((c) => c.argv.includes(needle));

/** The whole point: the password is on a pipe, never in a command line, never printed. */
function assertPasswordStayedOutOfSight(r, password = PASSWORD) {
  assert.equal(argvText(r).includes(password), false, "no docker argument may carry the password");
  assert.equal(String(r.stdout).includes(password), false, "the script must not print the password");
  assert.equal(String(r.stderr).includes(password), false, "the script must not print the password");
}

// ── Frigate ─────────────────────────────────────────────────────────────────────────

test("frigate: a fresh install gets the generated password, delivered on stdin only", () => {
  const r = run("frigate");
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(r.calls[0].argv.startsWith("inspect"), true, "the container is checked before it is touched");
  // The untouched install is detected from Frigate's own user table.
  assert.equal(ran(r, "password_changed_at"), true);
  const set = r.calls.find((c) => c.argv.includes("/api/users/"));
  assert.ok(set, "the password is set through Frigate's internal API");
  assert.equal(set.stdin, `{"password":"${PASSWORD}"}`, "the JSON body — and so the password — arrives on stdin");
  assert.equal(ran(r, "api/login"), true, "the new login is proved on the authenticated port");
  assert.equal(stdinText(r).includes(PASSWORD), true);
});

test("frigate: an admin whose password was already changed is left alone (exit 3)", () => {
  for (const state of ["changed", "nouser"]) {
    const r = run("frigate", { env: { FAKE_FRIGATE_STATE_0: state } });
    assert.equal(r.status, 3, `${state}: ${r.stderr}`);
    assert.equal(ran(r, "/api/users/"), false, `${state}: no password may be set`);
    assert.equal(ran(r, "api/login"), false, `${state}: nothing to prove`);
  }
});

test("frigate: a container that is not running, or no docker at all, is exit 4", () => {
  const stopped = run("frigate", { env: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4);
  assert.equal(stopped.calls.length, 1, "only the state check ran");
  const noDocker = run("frigate", { withDocker: false });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
});

test("frigate: a password the protocol refuses never reaches docker", () => {
  for (const password of ["", "\n", "short-pass\n", 'quote"inside-it\n']) {
    const r = run("frigate", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: docker was not called`);
  }
});

test("frigate: a login that Frigate refuses is a failure, not a success", () => {
  const r = run("frigate", { env: { FAKE_FRIGATE_LOGIN_0: "401" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not accept the new login/);
  assertPasswordStayedOutOfSight(r);
});

test("frigate: a password API that answers without success is a failure", () => {
  const r = run("frigate", { env: { FAKE_FRIGATE_SET_RC_0: "1", FAKE_FRIGATE_SET_BODY_0: '{"detail":"nope"}' } });
  assert.equal(r.status, 1);
  assert.equal(ran(r, "api/login"), false, "no proof after a refused set");
});

// ── motionEye ──────────────────────────────────────────────────────────────────────

test("motioneye: a fresh install gets the password, then the container is restarted", () => {
  const r = run("motioneye");
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(ran(r, "config.get_main"), true, "the empty password is detected first");
  const setAt = indexOf(r, "set_admin_password");
  const restartAt = indexOf(r, "restart");
  assert.ok(setAt > 0, "the password is set through motionEye's own module");
  assert.equal(r.calls[setAt].stdin, `${PASSWORD}\n`, "the password arrives on stdin");
  assert.ok(restartAt > setAt, "a restart must follow: the running server caches its config");
  assert.equal(ran(r, "8765/login"), true, "the new login is proved");
});

test("motioneye: an install that already has a password is left alone (exit 3)", () => {
  const r = run("motioneye", { env: { FAKE_MOTIONEYE_STATE_0: "set" } });
  assert.equal(r.status, 3);
  assert.equal(ran(r, "set_admin_password"), false);
  assert.equal(ran(r, "restart"), false, "nothing changed, so nothing to restart");
});

test("motioneye: a configuration that cannot be read is a failure (exit 1)", () => {
  const r = run("motioneye", { env: { FAKE_MOTIONEYE_STATE_0: "traceback" } });
  assert.equal(r.status, 1);
  assert.equal(ran(r, "set_admin_password"), false);
});

test("motioneye: not running / no docker is exit 4", () => {
  const stopped = run("motioneye", { env: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4);
  assert.equal(stopped.calls.length, 1);
  const noDocker = run("motioneye", { withDocker: false });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
});

test("motioneye: a password the protocol refuses never reaches docker", () => {
  for (const password of ["", "short-pass\n"]) {
    const r = run("motioneye", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0);
  }
});

test("motioneye: a login that motionEye refuses is a failure", () => {
  const r = run("motioneye", { env: { FAKE_MOTIONEYE_LOGIN_0: "401" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not accept the new login/);
  assertPasswordStayedOutOfSight(r);
});

// ── Wallabag ───────────────────────────────────────────────────────────────────────

test("wallabag: no schema is installed, then the shipped default login is replaced", () => {
  const r = run("wallabag", { env: { FAKE_WALLABAG_SCHEMA_0: "255" } });
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(ran(r, "wallabag:install"), true, "a fresh install has no tables: the script installs them");
  const change = r.calls.find((c) => c.argv.includes("fos:user:change-password"));
  assert.ok(change, "the password is changed through Wallabag's console");
  assert.equal(change.stdin, `${PASSWORD}\n`, "the password goes to the prompt on stdin, never as an argument");
  const logins = r.calls.filter((c) => c.argv.includes("login_check"));
  assert.equal(logins.length, 2, "the default login is checked, then the new one");
  assert.equal(logins[0].stdin, "wallabag\n", "the shipped default login: the account name as the password");
  assert.equal(logins[1].stdin, `${PASSWORD}\n`, "the proof gets the new password on stdin");
});

test("wallabag: an existing schema is never installed again", () => {
  const r = run("wallabag", { env: { FAKE_WALLABAG_SCHEMA_0: "0" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ran(r, "wallabag:install"), false, "the tables are already there");
  assert.equal(ran(r, "fos:user:change-password"), true);
});

test("wallabag: an install whose default login no longer works is left alone (exit 3)", () => {
  const r = run("wallabag", { env: { FAKE_WALLABAG_LOGIN_0: "1" } });
  assert.equal(r.status, 3);
  assert.equal(ran(r, "fos:user:change-password"), false, "Crow must not overwrite a login it does not know");
});

test("wallabag: a login page that cannot be checked is a failure, not a refusal", () => {
  const r = run("wallabag", { env: { FAKE_WALLABAG_LOGIN_0: "2" } });
  assert.equal(r.status, 1);
  assert.equal(ran(r, "fos:user:change-password"), false);
});

test("wallabag: the new password failing the proof is a failure", () => {
  const r = run("wallabag", { env: { FAKE_WALLABAG_LOGIN_0: "0", FAKE_WALLABAG_LOGIN_1: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not accept the new login/);
  assertPasswordStayedOutOfSight(r);
});

test("wallabag: a password the protocol refuses never reaches docker", () => {
  for (const password of ["", "short-pass\n"]) {
    const r = run("wallabag", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0);
  }
});

test("wallabag: not running / no docker is exit 4", () => {
  const stopped = run("wallabag", { env: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4);
  assert.equal(stopped.calls.length, 1);
  const noDocker = run("wallabag", { withDocker: false });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
});

// ── the declarations that put those scripts to work ────────────────────────────────

const CONVERTED = {
  frigate: { user: "admin", secretEnv: "FRIGATE_PASSWORD", userEnv: "FRIGATE_USER", timeout_s: 180 },
  motioneye: { user: "admin", secretEnv: "MOTIONEYE_ADMIN_PASSWORD", userEnv: undefined, timeout_s: 180 },
  wallabag: { user: "wallabag", secretEnv: "WALLABAG_PASSWORD", userEnv: "WALLABAG_USERNAME", timeout_s: 240 },
};

const manifestOf = (id) => JSON.parse(readFileSync(join(B(id), "manifest.json"), "utf8"));

test("each converted manifest passes the bundle contract and declares the setup script", () => {
  const bundleExists = (id) => existsSync(join(REPO, "bundles", id, "manifest.json"));
  for (const [id, want] of Object.entries(CONVERTED)) {
    const manifest = manifestOf(id);
    const { errors } = validateManifest(manifest, B(id), { bundleExists });
    assert.deepEqual((errors || []).filter((e) => e.startsWith("firstAdmin")), [], `${id}: firstAdmin`);
    assert.deepEqual(
      { mode: manifest.firstAdmin.mode, via: manifest.firstAdmin.via, script: manifest.firstAdmin.setup.script },
      { mode: "crow", via: "setup", script: "scripts/first-admin.sh" },
      id,
    );
    assert.equal(manifest.firstAdmin.user, want.user, `${id}: the account Crow creates`);
    assert.equal(manifest.firstAdmin.secretEnv, want.secretEnv, `${id}: where the keychain keeps the password`);
    assert.equal(manifest.firstAdmin.userEnv, want.userEnv, `${id}: userEnv only where .env carries the username`);
    assert.equal(manifest.firstAdmin.setup.timeout_s, want.timeout_s, `${id}: enough time for a slow first start`);
    assert.equal(manifest.firstAdmin.note, undefined, `${id}: a crow-created login has no note to read`);
    const script = readFileSync(join(B(id), manifest.firstAdmin.setup.script), "utf8");
    assert.match(script, /^#!\/usr\/bin\/env bash/, `${id}: the script is bash`);
    assert.match(script, /set -euo pipefail/, `${id}: fail fast`);
    // It reads the password from stdin and names the container it may override for tests.
    assert.match(script, /IFS= read -r PW/, `${id}: reads the password from stdin`);
    assert.equal(script.includes("CROW_FA_CONTAINER"), true, `${id}: the container name is overridable for tests`);
  }
});

test("the committed registry carries the same declarations (it is generated from the manifests)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  for (const id of Object.keys(CONVERTED)) {
    const entry = registry.find((e) => e.id === id);
    assert.ok(entry, `registry/add-ons.json has an entry for ${id}`);
    assert.deepEqual(entry, { ...manifestOf(id), official: true }, `${id}: registry copy of the manifest`);
  }
});