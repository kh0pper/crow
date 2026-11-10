/**
 * N3-4 phase 2c — Crow creates the admin login for Linkding, Paperless-ngx and RomM.
 *
 * Each of the three bundles now ships `scripts/first-admin.sh` and declares
 * `firstAdmin: { mode: "crow", via: "setup", ... }`, so the installer runs the script once
 * after `compose up` with the generated password as ONE line on stdin. What these tests
 * hold down:
 *
 *   1. a fresh app: exit 0, the password delivered on stdin and NEVER in a docker argument
 *      (that is what a process list would show),
 *   2. an app that already has its own admin: exit 3, and no create call at all,
 *   3. docker missing / the container not running: exit 4, nothing changed,
 *   4. a password the protocol refuses (short, empty): exit 1, and docker is not even asked,
 *   5. an admin username that is not a plain account name: exit 1, docker not asked either,
 *   6. a login the app never accepts after the account was created: exit 5,
 *   7. a status word the script does not know, before the change: exit 1,
 *   8. Paperless-ngx's Django secret key reaching the container (the image refuses to start
 *      without it) and RomM's app container having a name the script can reach,
 *   9. the three manifests carry what the contract, the runner and the card need.
 *
 * No docker here: a `docker` executable written into a temp dir sits first on PATH, records
 * every argv and the stdin it received, and replays canned answers. The scripts only ever
 * reach a container through `docker exec`/`inspect`.
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

const TMP = mkdtempSync(join(tmpdir(), "crow-fa-scripts-2-"));
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
  'NEXT=""',
  "# next KEY DEFAULT: the i-th answer for KEY (FAKE_<KEY>_0, _1, ...), else DEFAULT.",
  "next() {",
  '  local key="$1" dflt="$2" cf="$dir/counter.$1" i=0',
  '  if [ -f "$cf" ]; then i=$(cat "$cf"); fi',
  '  printf "%s\\n" "$((i + 1))" > "$cf"',
  '  local var="FAKE_${key}_${i}"',
  '  if [ -n "${!var+x}" ]; then NEXT="${!var}"; else NEXT="$dflt"; fi',
  "}",
  "",
  'case "${1:-}" in',
  '  inspect) next RUNNING true; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  compose) next COMPOSE_ID crow-romm; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  'case "$args" in',
  // Linkding: the health probe, the user-count probe, the create, the login proof.
  '  *crow-linkding*USERS=*) next LINKDING_STATE "USERS=0"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-linkding*create_superuser*) next LINKDING_CREATE "CREATED"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-linkding*authenticate*) next LINKDING_LOGIN "LOGIN-OK"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-linkding*9090/health*) next LINKDING_UP 0; exit "$NEXT" ;;',
  // Paperless-ngx: the web probe, the superuser count, the create, the password check.
  '  *crow-paperless*USERS=*) next PAPERLESS_STATE "USERS=0"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-paperless*create_superuser*) next PAPERLESS_CREATE "CREATED"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-paperless*check_password*) next PAPERLESS_LOGIN "LOGIN-OK"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-paperless*localhost:8000*) next PAPERLESS_UP 0; exit "$NEXT" ;;',
  // RomM: the heartbeat (twice — detect prints a word, the wait only exits), the create,
  // the login proof.
  '  *crow-romm*SHOW_SETUP_WIZARD*) next ROMM_STATE "FRESH"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-romm*/api/users*) next ROMM_CREATE "CREATED"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-romm*/api/login*) next ROMM_LOGIN "LOGIN-OK"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *crow-romm*heartbeat*) next ROMM_UP 0; exit "$NEXT" ;;',
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
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  // cwd is the installed bundle dir: an empty temp dir unless the test seeds a `.env`.
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const res = spawnSync(BASH, [join(B(bundle), "scripts", "first-admin.sh")], {
    input: password,
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    env: {
      PATH: withDocker ? `${BIN}:/usr/bin:/bin` : `${NO_DOCKER}`,
      HOME: TMP,
      CROW_FIRST_ADMIN_USER: "admin",
      FAKE_DOCKER_DIR: callsDir,
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", calls: readCalls(callsDir) };
}

const CONTAINERS = { linkding: "crow-linkding", paperless: "crow-paperless", romm: "crow-romm" };
const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("");
const ran = (r, needle) => r.calls.some((c) => c.argv.includes(needle));
const count = (r, needle) => r.calls.filter((c) => c.argv.includes(needle)).length;

/** The whole point: the password is on a pipe, never in a command line, never printed. */
function assertPasswordStayedOutOfSight(r, password = PASSWORD) {
  assert.equal(argvText(r).includes(password), false, "no docker argument may carry the password");
  assert.equal(String(r.stdout).includes(password), false, "the script must not print the password");
  assert.equal(String(r.stderr).includes(password), false, "the script must not print the password");
}

// Per-app markers: what "create" and "prove" look like inside `docker exec`.
const CREATE = {
  linkding: "create_superuser",
  paperless: "create_superuser",
  romm: "/api/users",
};
const PROVE = {
  linkding: "authenticate",
  paperless: "check_password",
  romm: "/api/login",
};
const STATE = {
  linkding: ["LINKDING_STATE", "USERS=1"],
  paperless: ["PAPERLESS_STATE", "USERS=2"],
  romm: ["ROMM_STATE", "EXISTS"],
};

// ── every app: fresh install ────────────────────────────────────────────────────────

for (const app of ["linkding", "paperless", "romm"]) {
  test(`${app}: a fresh install gets the generated password, delivered on stdin only`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    assertPasswordStayedOutOfSight(r);
    // RomM first asks compose for its container id (no fixed name); then, like the others,
    // the container's state is checked before anything runs inside it.
    const lookups = app === "romm" ? 1 : 0;
    if (lookups) assert.equal(r.calls[0].argv.startsWith("compose ps -q romm"), true, "RomM's container comes from compose");
    assert.equal(r.calls[lookups].argv.startsWith("inspect"), true, "the container is checked before it is touched");
    assert.equal(r.calls[lookups].argv.includes(CONTAINERS[app]), true, "and the app's own container is the one named");
    const create = r.calls.find((c) => c.argv.includes(CREATE[app]));
    assert.ok(create, "the account is created through the app's own tooling");
    assert.equal(create.stdin, `admin\n${PASSWORD}\n`, "the username and the password arrive on stdin");
    assert.equal(create.argv.includes(PASSWORD), false, "never as an argument");
    assert.equal(r.calls.filter((c) => c.argv.includes(PROVE[app])).length, 1, "the new login is proved once");
    assert.equal(stdinText(r).includes(PASSWORD), true);
  });

  test(`${app}: an install that already has its own admin is left alone (exit 3)`, () => {
    const [key, word] = STATE[app];
    const r = run(app, { env: { [`FAKE_${key}_0`]: word } });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /already has an? (account|admin)/);
    assert.equal(ran(r, CREATE[app]), false, "no account may be created");
    assert.equal(ran(r, PROVE[app]), false, "nothing to prove");
  });

  test(`${app}: a container that is not running, or no docker at all, is exit 4`, () => {
    const stopped = run(app, { env: { FAKE_RUNNING_0: "false" } });
    assert.equal(stopped.status, 4);
    assert.equal(stopped.calls.length, app === "romm" ? 2 : 1, "only the lookup and the state check ran");
    const noDocker = run(app, { withDocker: false });
    assert.equal(noDocker.status, 4);
    assert.equal(noDocker.calls.length, 0);
  });

  test(`${app}: a password the protocol refuses never reaches docker`, () => {
    for (const password of ["", "\n", "short-pass\n"]) {
      const r = run(app, { password });
      assert.equal(r.status, 1, JSON.stringify(password));
      assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: docker was not called`);
    }
  });

  test(`${app}: an admin username that is not a plain account name is refused before anything runs`, () => {
    for (const user of ['ad"min', "admin name", "", "admin;rm -rf /"]) {
      const r = run(app, { env: { CROW_FIRST_ADMIN_USER: user } });
      assert.equal(r.status, 1, JSON.stringify(user));
      assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: docker was not called`);
    }
  });

  test(`${app}: a login the app never accepts after the create is kept, not thrown away (exit 5)`, () => {
    const key = app === "linkding" ? "LINKDING_LOGIN" : app === "paperless" ? "PAPERLESS_LOGIN" : "ROMM_LOGIN";
    const r = run(app, { env: { [`FAKE_${key}_0`]: "LOGIN-FAIL", [`FAKE_${key}_1`]: "LOGIN-FAIL", [`FAKE_${key}_2`]: "LOGIN-FAIL" } });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
    assert.equal(count(r, PROVE[app]), 3, "the proof is retried three times");
    assert.equal(ran(r, CREATE[app]), true, "the account really was created before the proof");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: a create step that answers with a word the script does not know changes nothing (exit 1)`, () => {
    const key = app === "linkding" ? "LINKDING_CREATE" : app === "paperless" ? "PAPERLESS_CREATE" : "ROMM_CREATE";
    const r = run(app, { env: { [`FAKE_${key}_0`]: "TRACEBACK-STUFF" } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /the login could not be confirmed/);
    assert.equal(ran(r, PROVE[app]), false, "no proof after an unconfirmed create");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: a detection step that answers with nothing usable changes nothing (exit 4)`, () => {
    const [key] = STATE[app];
    for (const answer of ["", "Traceback (most recent call last):", "SOMETHING-ELSE"]) {
      const r = run(app, { env: { [`FAKE_${key}_0`]: answer } });
      assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
      assert.match(r.stderr, /could not be read; nothing was changed/);
      assert.equal(ran(r, CREATE[app]), false, `${JSON.stringify(answer)}: no create`);
    }
  });
}

// ── the scripts reach the app where its own container listens ───────────────────────

test("each script waits on the app's container-side port (the one its compose healthcheck uses)", () => {
  for (const app of ["linkding", "paperless", "romm"]) {
    const compose = readFileSync(join(B(app), "docker-compose.yml"), "utf8");
    // The healthcheck's own URL: the app container's port, not the host mapping.
    const testLine = compose.split("\n").find((l) => /^\s*test:\s*\[/.test(l)) || "";
    const probe = /http:\/\/localhost:(\d+)/.exec(testLine);
    assert.ok(probe, `${app}: the compose healthcheck carries a URL`);
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    assert.equal(script.includes(`:${probe[1]}`), true, `${app}: the script must reach the app on port ${probe[1]}`);
  }
});

// ── Paperless-ngx: the Django secret key ────────────────────────────────────────────

test("paperless: the compose passes PAPERLESS_SECRET_KEY (the image refuses to start without one)", () => {
  const compose = readFileSync(join(B("paperless"), "docker-compose.yml"), "utf8");
  assert.match(compose, /PAPERLESS_SECRET_KEY=\$\{PAPERLESS_SECRET_KEY:\?Set PAPERLESS_SECRET_KEY\}/, "a hard failure, not a fallback value");
});

test("paperless: the manifest generates PAPERLESS_SECRET_KEY the way it generates the database password", () => {
  const manifest = JSON.parse(readFileSync(join(B("paperless"), "manifest.json"), "utf8"));
  const spec = (manifest.env_vars || []).find((v) => v.name === "PAPERLESS_SECRET_KEY");
  assert.ok(spec, "the key is declared, or Crow has nothing to put in the .env");
  assert.deepEqual(
    { secret: spec.secret, generate: spec.generate, required: spec.required },
    { secret: true, generate: "secret", required: false },
    "generated at install, hidden from the forms, never install-blocking",
  );
  const dbSpec = (manifest.env_vars || []).find((v) => v.name === "PAPERLESS_DB_PASSWORD");
  assert.deepEqual(
    { secret: spec.secret, generate: spec.generate, required: spec.required },
    { secret: dbSpec.secret, generate: dbSpec.generate, required: dbSpec.required },
    "the same shape as the password it sits beside",
  );
});

// ── RomM: the app container has a name the script can reach ─────────────────────────

test("romm: the container is found through compose in the installed dir, not a fixed name", () => {
  const compose = readFileSync(join(B("romm"), "docker-compose.yml"), "utf8");
  assert.equal(/container_name: crow-romm/.test(compose), false, "existing installs keep their own compose file");
  const script = readFileSync(join(B("romm"), "scripts", "first-admin.sh"), "utf8");
  assert.match(script, /docker compose ps -q romm/);
  const r = run("romm", { env: { FAKE_COMPOSE_ID_0: "" } });
  assert.equal(r.status, 4, "no running romm service → not running");
});

// ── the declarations that put those scripts to work ────────────────────────────────

const CONVERTED = {
  linkding: { user: "admin", secretEnv: "LINKDING_ADMIN_PASSWORD", timeout_s: 180 },
  paperless: { user: "admin", secretEnv: "PAPERLESS_ADMIN_PASSWORD", timeout_s: 240 },
  romm: { user: "admin", secretEnv: "ROMM_ADMIN_PASSWORD", timeout_s: 240 },
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
    assert.equal(manifest.firstAdmin.setup.timeout_s, want.timeout_s, `${id}: enough time for a slow first start`);
    assert.equal(manifest.firstAdmin.note, undefined, `${id}: a crow-created login has no note to read`);
    const script = readFileSync(join(B(id), manifest.firstAdmin.setup.script), "utf8");
    assert.match(script, /^#!\/usr\/bin\/env bash/, `${id}: the script is bash`);
    assert.match(script, /set -euo pipefail/, `${id}: fail fast`);
    // It reads the password from stdin and prints no secret back.
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