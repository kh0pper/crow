/**
 * The fleet switch for PR 2: scripts/ops/browser-cdp-gate.sh.
 *
 * A --dry-run must print the plan and change nothing (and must not need docker or git:
 * the operator runs it before the window), and the script must never put the CDP token
 * on a command line or in an echo — the header and the grep pattern travel in 0600
 * files, `curl -H @file` and `grep -f file`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/ops/browser-cdp-gate.sh");
const SOURCE = readFileSync(SCRIPT, "utf8");
/** Code lines only: the header comment documents the tool, it does not run. */
const CODE = SOURCE.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** The real grep, for a stand-in that only fails on the pattern-file read. */
const REAL_GREP = (process.env.PATH || "")
  .split(":")
  .map((dir) => join(dir, "grep"))
  .find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/** A scratch instance with the browser bundle installed as it was before this change. */
function scratchInstance(t) {
  const home = mkdtempSync(join(tmpdir(), "crow-cdp-gate-home-"));
  const bundle = join(home, "bundles", "browser");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, ".env"), "CROW_BROWSER_VNC_TOKEN=" + "a".repeat(64) + "\nCROW_BROWSER_CDP_PORT=9222\nCROW_HOME=" + home + "\n", { mode: 0o600 });
  // Distinct sentinels, so "nothing changed" is provable.
  const sentinel = {
    "docker-compose.yml": "# PRE-GATE COMPOSE\n",
    "entrypoint.sh": "#!/bin/bash\n# PRE-GATE ENTRYPOINT\n",
    "Dockerfile": "# PRE-GATE DOCKERFILE\n",
  };
  for (const [f, text] of Object.entries(sentinel)) writeFileSync(join(bundle, f), text);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, bundle, sentinel };
}

/** The uid the script derives: the owner of the scratch home (0 only when run as root). */
const ROOT_FLAG = typeof process.getuid === "function" && process.getuid() === 0 ? ["--allow-root-gateway"] : [];

test("--dry-run prints the plan and changes nothing (no docker, no git, no backup)", (t) => {
  const { home, bundle, sentinel } = scratchInstance(t);
  const before = Object.fromEntries(Object.keys(sentinel).map((f) => [f, readFileSync(join(bundle, f), "utf8")]));
  const envBefore = readFileSync(join(bundle, ".env"), "utf8");

  const out = execFileSync("bash", [SCRIPT, home, "browser", "--dry-run", ...ROOT_FLAG], {
    encoding: "utf8",
    // No docker and no git on PATH: a dry run must not need either.
    env: { ...process.env, PATH: "/usr/bin:/bin", DOCKER: "/nonexistent/docker", GIT: "/nonexistent/git" },
    timeout: 30000,
  });

  assert.match(out, /plan \(dry run/);
  assert.match(out, /bundle dir:\s+\S*bundles\/browser/);
  assert.match(out, /would copy:\s+docker-compose\.yml Dockerfile entrypoint\.sh cdp-relay\.mjs/);
  assert.match(out, /would mint:\s+CROW_BROWSER_CDP_TOKEN/);
  // The relay's uid/gid travel with the compose run: CROW_GATEWAY_UID/GID from the home's owner.
  assert.match(out, new RegExp("would run:\\s+\\( cd \\S+bundles/browser && CROW_HOME=" + home + " CROW_GATEWAY_UID=" + process.getuid() + " CROW_GATEWAY_GID=" + process.getgid() + " docker compose -p browser up -d --build --force-recreate \\)"), "the plan's compose run carries both ids");
  assert.match(out, /relay uid:gid:\s+\d+:\d+/);
  assert.match(out, /curl -H @<0600 file>/, "the plan says the header travels in a file, not on the command line");
  assert.match(out, /a real run needs --from-sha/, "and that a real run needs the pre-change sha");
  assert.match(out, /dry run: .*nothing changed/);

  // Nothing changed: no file touched, no .env minted, no backup directory created.
  for (const [f, text] of Object.entries(before)) assert.equal(readFileSync(join(bundle, f), "utf8"), text, f + " is untouched");
  assert.equal(readFileSync(join(bundle, ".env"), "utf8"), envBefore, "no token was minted");
  assert.equal(existsSync(join(home, "browser-cdp-gate-backup")), false, "no backup was taken");
  assert.equal(existsSync(join(bundle, "cdp-relay.mjs")), false, "the relay was not copied in");
});

test("--dry-run still checks a --from-sha it is given, and refuses a missing instance", (t) => {
  const { home } = scratchInstance(t);
  const out = execFileSync("bash", [SCRIPT, home, "browser", "--dry-run", "--from-sha", "deadbeef", ...ROOT_FLAG], {
    encoding: "utf8",
    env: { ...process.env, GIT: "/nonexistent/git" },
    timeout: 30000,
  });
  assert.match(out, /pre-PR-2 sha:\s+deadbeef/);
  assert.match(out, /git is not available here/, "it says so instead of pretending to have verified the sha");

  const missing = join(home, "nope");
  let failed = null;
  try {
    execFileSync("bash", [SCRIPT, missing, "browser", "--dry-run", ...ROOT_FLAG], { encoding: "utf8", timeout: 30000 });
  } catch (err) { failed = err; }
  assert.ok(failed, "a missing <crow-home> is refused");
  assert.match(String(failed.stderr || ""), /REFUSED: <crow-home> is not a directory/);
});

test("the token never reaches a command line, an echo, or a stream the operator can see", () => {
  // The two carriers: curl's header file and grep's pattern file, both 0600.
  assert.match(CODE, /printf 'Authorization: Bearer %s\\n' "\$TOKEN" > "\$HDR"/, "the bearer header lives in a file");
  assert.match(CODE, /-H "@\$HDR"/, "curl reads the header from that file");
  assert.match(CODE, /printf '%s\\n' "\$TOKEN" > "\$TOK"/, "the token's own copy is a file too");
  assert.match(CODE, /grep -qFf "\$TOK"/, "grep reads the pattern from that file, never argv");
  assert.match(CODE, /TOKEN="\$\(sed -n "s\/\^\$\{KEY\}=\/\/p" "\$ENV_FILE"/, "read from the bundle .env");
  assert.match(CODE, /unset TOKEN/, "and dropped from the shell as soon as it is not needed");
  assert.doesNotMatch(CODE, /curl[^\n]*-H\s+"?Authorization/, "no Authorization header built on a command line");
  assert.doesNotMatch(CODE, /grep[^\n]*\$TOKEN/, "no token as a grep pattern in argv");
  assert.doesNotMatch(CODE, /(echo|say)[^\n]*\$TOKEN/, "no line that prints the token");
  // The only outputs the verification may print are these verdicts.
  assert.match(CODE, /ARGV_STATE='not found'/);
  assert.match(CODE, /INSPECT_STATE='cannot verify'/);
  assert.match(CODE, /LOGS_STATE='cannot verify'/);
  assert.match(CODE, /say "token in any \/proc\/<pid>\/cmdline: \$ARGV_STATE"/);
  assert.match(CODE, /say "token in docker inspect output:   \$INSPECT_STATE"/);
  assert.match(CODE, /say "token in the container log:       \$LOGS_STATE"/);
  // And the mint goes through PR 1's generator, which logs key names only.
  assert.match(CODE, /mintMissingFlaggedKeys\("browser", manifest, \{ destDir, crowHome/);
});

test("the switch takes its pre-change files from git, requires the sha, and prints the rollback", () => {
  assert.match(CODE, /\[ -n "\$FROM_SHA" \] \|\| fail "--from-sha /, "--from-sha is required for a real run");
  assert.match(CODE, /"\$GIT" -C "\$REPO" show "\$FROM_SHA:bundles\/browser\/\$f" > "\$BACKUP\/pre\/\$f"/, "the backup comes from the sha, never from the installed copy");
  assert.match(CODE, /grep -q -- '--remote-debugging-port'/, "and the sha must really be a pre-gate tree");
  assert.match(CODE, /cp -p "\$BUNDLE_DIR\/\$f" "\$BACKUP\/installed\/\$f"/, "what is installed now is kept as well, for the failure path");
  assert.match(CODE, /"\$DOCKER" compose -p "\$PROJECT" up -d --build --force-recreate/, "the recreate");
  assert.match(CODE, /say "rollback, exactly:"/);
  assert.match(CODE, /cp -p \$BACKUP\/pre\/docker-compose\.yml \$BUNDLE_DIR\/docker-compose\.yml/);
  assert.match(CODE, /rm -f \$BUNDLE_DIR\/cdp-relay\.mjs/);
  assert.match(CODE, /rolls FORWARD instead/, "a public install rolls forward, and the script says so");
  // The container's own project is checked before anything is recreated.
  assert.match(CODE, /com\.docker\.compose\.project/);
  assert.match(CODE, /refusing to recreate another instance's browser/);
  assert.match(CODE, /9222 proto tcp/, "it names the stale ufw rule the old manifest opened");
});

test("the script is a plain bash script that refuses to run outside tmux by default", () => {
  assert.match(SOURCE, /^#!\/usr\/bin\/env bash$/m);
  assert.match(CODE, /set -uo pipefail/);
  assert.match(CODE, /run this inside tmux or screen/, "a dropped SSH session mid-run is a prod outage");
  assert.match(CODE, /--no-tty-guard/);
  assert.ok(statSync(SCRIPT).isFile());
});
test("the compose project must be this instance's own: a co-hosted instance's name is read from its .env", (t) => {
  const { home } = scratchInstance(t);
  const env = join(home, "bundles", "browser", ".env");
  writeFileSync(env, readFileSync(env, "utf8") + "CROW_BROWSER_CONTAINER_NAME=crow-browser-second\n", { mode: 0o600 });
  // The primary's project name is refused for this instance: a wrong -p would replace the primary's browser.
  assert.throws(
    () => execFileSync("bash", [SCRIPT, home, "browser", "--dry-run", ...ROOT_FLAG], { encoding: "utf8", timeout: 30000, stdio: "pipe" }),
    (err) => /not this instance's project \('crow-browser-second'/.test(String(err.stderr)),
  );
  // Its own name is accepted, and the plan names its own container.
  const out = execFileSync("bash", [SCRIPT, home, "crow-browser-second", "--dry-run", ...ROOT_FLAG], { encoding: "utf8", timeout: 30000 });
  assert.match(out, /compose -p:\s+crow-browser-second \(service crow-browser-second\)/);
});

test("both ops scripts carry the relay's uid: from the home's owner, refusing root without the flag", () => {
  const SOURCE_PV = readFileSync(join(ROOT, "scripts/ops/browser-profile-to-volume.sh"), "utf8");
  const CODE_PV = SOURCE_PV.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  // Command blocks, not lines: a compose call continued over lines is still ONE call.
  const joinLines = (code) => code.replace(/\\\n\s*/g, " ").split("\n");
  for (const [name, code] of [["browser-cdp-gate.sh", CODE], ["browser-profile-to-volume.sh", CODE_PV]]) {
    assert.match(code, /stat -c %u "\$INSTANCE_HOME"/, name + " derives the uid from the home's owner");
    assert.match(code, /stat -c %g "\$INSTANCE_HOME"/, name + " derives the gid too");
    assert.match(code, /--allow-root-gateway/, name + " has the escape hatch");
    assert.match(code, /owned by root \(uid 0\)/, name + " refuses a root owner by default");
    const composeLines = joinLines(code).filter((l) => / compose (-p |--env-file )/.test(l));
    assert.ok(composeLines.length >= 1, name + " has compose invocations to check");
    for (const line of composeLines) {
      const printed = /^\s*(say|note|echo)\b/.test(line);
      const want = printed ? /CROW_GATEWAY_UID=\$RELAY_UID CROW_GATEWAY_GID=\$RELAY_GID/ : /CROW_GATEWAY_UID="\$RELAY_UID" CROW_GATEWAY_GID="\$RELAY_GID"/;
      assert.match(line, want, name + ": every compose run and every printed one carries the ids: " + line.trim());
    }
  }
});

// ─── The leak detector: a MATCH must never read as "not found", and a producer that
// cannot be read must never pass. ────────────────────────────────────────────────
//
// `producer | grep -qFf "$TOK"` ends grep at its first match and SIGPIPEs the producer;
// `set -o pipefail` then makes the pipeline fail, so the MATCH reads as "not found": a
// leaked token is reported clean and the gate passes. Both halves are tested here — a
// scratch copy of the OLD shape (proving the bug is real in this shell), and full runs of
// the REAL script with a stand-in docker/git/curl that leaks, stays clean, or fails.
// The `old` branch below is that proof, not a stand-in to be fixed: it names itself so the
// stub guard in tests/first-admin-pipefail.test.js exempts exactly that one line.

const PIPE_SHAPES = String.raw`#!/usr/bin/env bash
set -uo pipefail
TOK="$1"
producer() { printf '%s\n' "SUBJECT-TOKEN"; head -c 1048576 /dev/zero | tr '\0' 'x'; printf '\n'; }
case "$2" in
  old)  if producer | grep -qFf "$TOK" 2>/dev/null; then echo found; else echo 'not found'; fi ;; # pipefail-guard: deliberate old shape (positive control)
  here) OUT="$(producer)"; if grep -qFf "$TOK" <<<"$OUT" 2>/dev/null; then echo found; else echo 'not found'; fi ;;
  file) producer > "$3"; if grep -qFf "$TOK" -- "$3" 2>/dev/null; then echo found; else echo 'not found'; fi ;;
esac
`;

test("the old pipe shape reports a leak as 'not found' once the output is 1 MiB; the fix's two shapes report 'found'", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-gate-sigpipe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shape = join(dir, "shape.sh");
  writeFileSync(shape, PIPE_SHAPES);
  const tok = join(dir, "token");
  writeFileSync(tok, "SUBJECT-TOKEN\n", { mode: 0o600 });
  const run = (which) => execFileSync("bash", [shape, tok, which, join(dir, "dump-" + which)], { encoding: "utf8" }).trim();
  assert.equal(run("old"), "not found", "the pre-fix shape: SIGPIPE turns the match into a miss — this is the bug");
  assert.equal(run("here"), "found", "read whole, then grepped from a here-string");
  assert.equal(run("file"), "found", "or written to a file and grepped: nothing for the producer to SIGPIPE");
});

/**
 * The stand-in toolchain a full gate run needs: git (a pre-gate sha), docker (compose,
 * inspect, logs) and curl. FAKE_INSPECT / FAKE_LOGS script what the two leak probes see:
 * "leak" = the token FIRST and then ~1 MiB of noise (the shape that used to fail open),
 * "clean" = the noise only, "fail" = the producer errors ("cannot verify").
 */
function gateToolchain(t, home, { inspect = "clean", logs = "clean", grepBroken = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-gate-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };
  const docker = put("docker", String.raw`#!/usr/bin/env bash
tok="$(sed -n 's/^CROW_BROWSER_CDP_TOKEN=//p' "$FAKE_HOME/bundles/browser/.env")"
dump() { # clean | leak | fail
  case "$1" in
    fail) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
    leak) printf '%s\n' "$tok"; head -c 1048576 /dev/zero | tr '\0' 'x'; echo ;;
    *) head -c 1048576 /dev/zero | tr '\0' 'x'; echo ;;
  esac
}
fmt=""
for a in "$@"; do [ "$prev" = "--format" ] && fmt="$a"; prev="$a"; done
case "$1" in
  compose) case " $* " in *" version "*) echo "v2.27.0" ;; *" up "*) exit 0 ;; esac ;;
  inspect) case "$fmt" in
      '{{.Name}}') echo "/crow-browser" ;;
      *com.docker.compose.project*) echo "browser" ;;
      '') dump "$FAKE_INSPECT" ;;
    esac ;;
  logs) dump "$FAKE_LOGS" ;;
esac
exit 0
`);
  const git = put("git", String.raw`#!/usr/bin/env bash
# The pre-gate tree: all four files exist, and its entrypoint starts Chromium itself.
case " $* " in
  *" show "*) printf '#!/usr/bin/env bash\nchromium --remote-debugging-port=9222 &\n' ;;
esac
exit 0
`);
  const curl = put("curl", String.raw`#!/usr/bin/env bash
# 200 only when the bearer header travels in a file (-H @file), 401 otherwise.
for a in "$@"; do case "$a" in @*) printf 200; exit 0 ;; esac; done
printf 401
`);
  // A grep whose pattern-file read FAILS (rc 2), the way an unreadable 0600 token file does
  // for a dropped privilege or a bad mount. Everything else is the real grep.
  put("grep", `#!/usr/bin/env bash
if [ -n "\${FAKE_GREP_BROKEN:-}" ]; then
  case " $* " in *" -qFf "*) echo "grep: pattern file: Permission denied" >&2; exit 2 ;; esac
fi
exec ${REAL_GREP} "$@"
`);
  const basePath = process.env.PATH || "/usr/bin:/bin";
  return {
    dir,
    env: {
      DOCKER: docker,
      GIT: git,
      CURL: curl,
      FAKE_HOME: home,
      FAKE_INSPECT: inspect,
      FAKE_LOGS: logs,
      PATH: `${dir}:${basePath}`,
      ...(grepBroken ? { FAKE_GREP_BROKEN: "1" } : {}),
    },
  };
}

/** A full, non-dry gate run against the stand-in toolchain (recreate + verify included). */
function runGate(t, over = {}) {
  const { home } = scratchInstance(t);
  const tools = gateToolchain(t, home, over);
  const r = spawnSync("bash", [SCRIPT, home, "browser", "--no-tty-guard", "--from-sha", "deadbeef", ...ROOT_FLAG], {
    encoding: "utf8",
    env: { ...process.env, ...tools.env, CROW_GATE_CDP_WAIT: "1" },
    timeout: 180000,
  });
  return { code: r.status, out: `${r.stdout || ""}\n${r.stderr || ""}` };
}

test("a full run: a clean instance PASSES — the detectors are not simply always failing", (t) => {
  const r = runGate(t);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /token in any \/proc\/<pid>\/cmdline: not found/, r.out);
  assert.match(r.out, /token in docker inspect output: +not found/);
  assert.match(r.out, /token in the container log: +not found/);
  assert.match(r.out, /verified: the relay refuses an unauthenticated request/);
});

test("a full run: the token in the container log is 'found' and FAILS the gate (1 MiB of output and all)", (t) => {
  const r = runGate(t, { logs: "leak" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /token in the container log: +found/, r.out);
  assert.match(r.out, /token in docker inspect output: +not found/);
  assert.match(r.out, /VERIFICATION INCOMPLETE/);
  assert.doesNotMatch(r.out, /verified: the relay refuses an unauthenticated request/, "a leak is never verified");
});

test("a full run: the token in `docker inspect` output is 'found' and FAILS the gate", (t) => {
  const r = runGate(t, { inspect: "leak" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /token in docker inspect output: +found/, r.out);
  assert.match(r.out, /VERIFICATION INCOMPLETE/);
});

test("a full run: a producer that FAILS is 'cannot verify' and fails the gate, never 'not found'", (t) => {
  const logsDown = runGate(t, { logs: "fail" });
  assert.equal(logsDown.code, 1, logsDown.out);
  assert.match(logsDown.out, /token in the container log: +cannot verify/, logsDown.out);
  assert.match(logsDown.out, /VERIFICATION INCOMPLETE/);

  const inspectDown = runGate(t, { inspect: "fail" });
  assert.equal(inspectDown.code, 1, inspectDown.out);
  assert.match(inspectDown.out, /token in docker inspect output: +cannot verify/, inspectDown.out);
  assert.match(inspectDown.out, /VERIFICATION INCOMPLETE/);
});

/**
 * The detector's own failure was the other fail-open door: `grep` exits 2 when it cannot read
 * its pattern file (a 0600 token file the run cannot read, a bad argument), and the old
 * `if has_token …` read that as "no match" — a clean bill printed for a check that never ran.
 */
test("token_state: grep's exit 1 is 'not found'; a pattern file it cannot read is 'cannot verify'", (t) => {
  const start = SOURCE.indexOf("token_state() {");
  assert.ok(start > -1, "token_state is the one detector (the script defines it)");
  const end = SOURCE.indexOf("\n}\n", start);
  const fn = SOURCE.slice(start, end + 3);
  const dir = mkdtempSync(join(tmpdir(), "crow-cdp-token-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tok = join(dir, "token");
  writeFileSync(tok, "SUBJECT-TOKEN\n", { mode: 0o600 });
  const clean = join(dir, "clean");
  writeFileSync(clean, "nothing to see\n");
  const leak = join(dir, "leak");
  writeFileSync(leak, "x SUBJECT-TOKEN x\n");
  const missing = join(dir, "missing");
  const script = join(dir, "state.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nset -uo pipefail\nTOK="$1"\n${fn}\n` +
      `printf '%s|%s|%s|%s\\n' "$(token_state text "$2")" "$(token_state text "$3")" "$(token_state file "$4")" "$(token_state file "$5")"\n` +
      `printf '%s|%s\\n' "$(token_state file "$6")" "$(token_state file "$4")"\n`,
  );
  const [first, second] = execFileSync(
    "bash",
    [script, tok, "x SUBJECT-TOKEN x", "nothing here", clean, leak, missing],
    { encoding: "utf8" },
  ).trim().split("\n");
  assert.equal(first, "found|not found|not found|found", "the three real answers");
  assert.equal(second, "cannot verify|not found", "a file grep cannot open is not 'not found'");
  // A pattern file grep cannot read at all (a directory, an unreadable 0600 file): rc 2 every
  // time, so every answer is 'cannot verify' and the gate will fail.
  const bad = execFileSync(
    "bash",
    [script, dir, "x SUBJECT-TOKEN x", "nothing here", clean, leak, missing],
    { encoding: "utf8" },
  ).trim().split("\n");
  assert.equal(bad[0], "cannot verify|cannot verify|cannot verify|cannot verify");
  assert.equal(bad[1], "cannot verify|cannot verify");
});

test("a full run: a grep that cannot read its pattern file is 'cannot verify' everywhere and FAILS the gate", (t) => {
  const r = runGate(t, { grepBroken: true });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /token in any \/proc\/<pid>\/cmdline: cannot verify/, r.out);
  assert.match(r.out, /token in docker inspect output: +cannot verify/, r.out);
  assert.match(r.out, /token in the container log: +cannot verify/, r.out);
  assert.match(r.out, /VERIFICATION INCOMPLETE/);
  assert.doesNotMatch(r.out, /(cmdline|docker inspect output|in the container log): +not found/, "nothing a broken detector looked at may read as clean");
  assert.doesNotMatch(r.out, /verified: the relay refuses an unauthenticated request/);
});
