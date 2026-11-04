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
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/ops/browser-cdp-gate.sh");
const SOURCE = readFileSync(SCRIPT, "utf8");
/** Code lines only: the header comment documents the tool, it does not run. */
const CODE = SOURCE.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

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

test("--dry-run prints the plan and changes nothing (no docker, no git, no backup)", (t) => {
  const { home, bundle, sentinel } = scratchInstance(t);
  const before = Object.fromEntries(Object.keys(sentinel).map((f) => [f, readFileSync(join(bundle, f), "utf8")]));
  const envBefore = readFileSync(join(bundle, ".env"), "utf8");

  const out = execFileSync("bash", [SCRIPT, home, "browser", "--dry-run"], {
    encoding: "utf8",
    // No docker and no git on PATH: a dry run must not need either.
    env: { ...process.env, PATH: "/usr/bin:/bin", DOCKER: "/nonexistent/docker", GIT: "/nonexistent/git" },
    timeout: 30000,
  });

  assert.match(out, /plan \(dry run/);
  assert.match(out, /bundle dir:\s+\S*bundles\/browser/);
  assert.match(out, /would copy:\s+docker-compose\.yml Dockerfile entrypoint\.sh cdp-relay\.mjs/);
  assert.match(out, /would mint:\s+CROW_BROWSER_CDP_TOKEN/);
  assert.match(out, /would run:\s+\( cd \S+bundles\/browser && docker compose -p browser up -d --build --force-recreate \)/);
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
  const out = execFileSync("bash", [SCRIPT, home, "browser", "--dry-run", "--from-sha", "deadbeef"], {
    encoding: "utf8",
    env: { ...process.env, GIT: "/nonexistent/git" },
    timeout: 30000,
  });
  assert.match(out, /pre-PR-2 sha:\s+deadbeef/);
  assert.match(out, /git is not available here/, "it says so instead of pretending to have verified the sha");

  const missing = join(home, "nope");
  let failed = null;
  try {
    execFileSync("bash", [SCRIPT, missing, "browser", "--dry-run"], { encoding: "utf8", timeout: 30000 });
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
  assert.match(CODE, /echo found \|\| echo 'not found'/);
  assert.match(CODE, /token in any \/proc\/<pid>\/cmdline/);
  assert.match(CODE, /token in docker inspect output/);
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
    () => execFileSync("bash", [SCRIPT, home, "browser", "--dry-run"], { encoding: "utf8", timeout: 30000, stdio: "pipe" }),
    (err) => /not this instance's project \('crow-browser-second'/.test(String(err.stderr)),
  );
  // Its own name is accepted, and the plan names its own container.
  const out = execFileSync("bash", [SCRIPT, home, "crow-browser-second", "--dry-run"], { encoding: "utf8", timeout: 30000 });
  assert.match(out, /compose -p:\s+crow-browser-second \(service crow-browser-second\)/);
});
