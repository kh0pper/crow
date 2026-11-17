/**
 * Browser CDP gate, PR 2 — the statics: Chromium runs on a pipe, the relay is the only
 * listener, the token travels as a file, and the bundle ships the new files on a version
 * bump (refreshFiles) with the registry mirroring the manifest exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const ENTRYPOINT = read("bundles/browser/entrypoint.sh");
const RELAY = read("bundles/browser/cdp-relay.mjs");
const COMPOSE = read("bundles/browser/docker-compose.yml");
const DOCKERFILE = read("bundles/browser/Dockerfile");
const MANIFEST = JSON.parse(read("bundles/browser/manifest.json"));
const REGISTRY = JSON.parse(read("registry/add-ons.json"));

/** Shell lines that are not comments: assertions are about what runs. */
const SHELL = ENTRYPOINT.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
/** JS lines that are not comments (whole-line `//`, `/*`, `*`). */
const JS = RELAY.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

test("neither the entrypoint nor the relay ever passes a debugging port or reopens the Origin check", () => {
  for (const [name, code] of [["entrypoint.sh", SHELL], ["cdp-relay.mjs", JS]]) {
    assert.doesNotMatch(code, /--remote-debugging-port/, name + " must not open a CDP port");
    assert.doesNotMatch(code, /--remote-debugging-address/, name);
    assert.doesNotMatch(code, /--remote-allow-origins/, name + " must not disable Chromium's Origin check");
  }
  // The one flag that replaces them, with the pipe on fds 3/4.
  assert.match(JS, /"--remote-debugging-pipe"/);
  assert.match(JS, /stdio: \["ignore", "inherit", "inherit", "pipe", "pipe"\]/);
  assert.match(JS, /method: "Browser\.close"/, "the relay closes Chromium itself");
  // The regexes above really do see the flags when they are there (a self-check).
  assert.match(RELAY, /--remote-debugging-pipe/);
});

test("the relay spawns Chromium in its own process group, and dies with it", () => {
  assert.match(JS, /detached: true/, "its own group: one kill reaches renderers and zygotes");
  assert.match(JS, /process\.kill\(-child\.pid, signal\)/, "kill the group, not just the browser process");
  assert.match(JS, /process\.exit\(code === null \? 1 : code\)/, "the relay exits with Chromium's code");
  assert.match(JS, /CROW_CDP_TOKEN_FILE|SECRET_ENV_RE/, "the child env is scrubbed");
  assert.match(JS, /if \(!SECRET_ENV_RE\.test\(k\)\) safeEnv\[k\] = v;/);
});

test("the relay has the two-uids shape: --supervise re-execs --attach through setpriv", () => {
  // The supervisor is what the entrypoint starts, as root; it must never drop privileges
  // in-process (that makes /proc unreadable), so it re-execs the relay instead.
  assert.match(JS, /if \(argv\.includes\("--supervise"\)\) return supervise\(\);/);
  assert.match(JS, /if \(argv\.includes\("--attach"\)\) return attach\(\);/);
  assert.match(JS, /const SETPRIV = "\/usr\/bin\/setpriv";/);
  for (const flag of ["--reuid", "--regid", "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs"]) {
    assert.ok(JS.includes(`"${flag}"`), "setpriv gets " + flag);
  }
  assert.match(JS, /"--", process\.execPath, SELF, "--attach"/, "the re-exec uses absolute paths (execPath and this file's URL)");
  assert.match(JS, /const SELF = fileURLToPath\(import\.meta\.url\)/, "no relative path");
  // The pipe arrives on fds 3/4, and the report on fd 5.
  assert.match(JS, /stdio: \["ignore", "inherit", "inherit", chrome\.stdio\[3\], chrome\.stdio\[4\], "pipe"\]/);
  assert.match(JS, /new net\.Socket\(\{ fd: 3/, "--attach writes to fd 3");
  assert.match(JS, /new net\.Socket\(\{ fd: 4/, "--attach reads fd 4");
  assert.match(JS, /ready \$\{JSON\.stringify\(\{ port: relay\.port, browser:/, "the ready line carries the port and browser");
  assert.match(JS, /writeSync\(5,/, "written to fd 5, the supervisor's report pipe");
  // The supervisor's copies of Chromium's pipe are destroyed in the same tick, unread.
  assert.match(JS, /for \(const stream of \[chrome\.stdio\[3\], chrome\.stdio\[4\]\]\) \{ try \{ stream\.destroy\(\); \} catch/);
  assert.match(JS, /CROW_CDP_RELAY_UID/);
  assert.match(JS, /CROW_CDP_RELAY_GID/);
  assert.match(JS, /uid !== euid/, "without root the relay must be on its own uid");
  // A pipe-mode relay has no child to signal: closing the pipe IS the kill.
  assert.match(JS, /killChromium\(signal = "SIGKILL"\) \{\n    if \(pipeMode\)/, "pipe mode destroys the pipe instead of signalling a child");
  assert.match(JS, /resolvePipeClosed\(\{ code: reason === "eof" \? 0 : 1/, "EOF is what ends a pipe-mode relay");
});

test("the entrypoint starts the supervisor, waits for its ready file, and keeps require_loopback on CDP_PORT", () => {
  assert.match(SHELL, /^RELAY="\$\(dirname "\$0"\)\/cdp-relay\.mjs"$/m, "the relay ships beside the entrypoint");
  assert.match(SHELL, /^node "\$RELAY" --supervise &$/m, "the supervisor is what runs (and re-execs the relay)");
  assert.match(SHELL, /^RELAY_PID=\$!$/m);
  assert.match(SHELL, /^CDP_READY_FILE=\/tmp\/cdp-relay\.ready$/m);
  assert.match(SHELL, /\[ -s "\$CDP_READY_FILE" \]/, "readiness is the ready file");
  assert.match(SHELL, /require_loopback "\$\{CDP_PORT\}" cdp-relay/, "the relay must be loopback-only");
  assert.match(SHELL, /require_loopback "\$\{NOVNC_PORT\}" websockify/, "and so must noVNC (unchanged)");
  // Started before the readiness loop, and the pid is what gets supervised.
  assert.ok(SHELL.indexOf('node "$RELAY"') < SHELL.indexOf('[ -s "$CDP_READY_FILE" ]'), "the relay is launched before its ready file is awaited");
  assert.match(SHELL, /^wait "\$RELAY_PID"$/m, "the supervisor's pid replaces Chromium's for supervision");
  // Nothing in the entrypoint starts Chromium any more: it only finds its pid to check it.
  assert.doesNotMatch(SHELL, /^"?\$CHROME_PATH"?\s+-/m, "the entrypoint never launches Chromium");
  assert.match(SHELL, /^CHROME_PID="\$\(child_pid_matching "\$RELAY_PID" chrome\)"$/m, "Chromium is found under the supervisor only to check it");
  assert.match(SHELL, /no_tcp_listeners "\$CHROME_PID" \/proc\/net\/tcp \/proc\/net\/tcp6/);
});

test("the relay listens as the gateway's uid: the ids are required, and the listener is checked", () => {
  // Never defaulted, and the fatal names where the value comes from.
  assert.match(SHELL, /^require_id CROW_RELAY_UID "\$\{CROW_RELAY_UID:-\}"$/m);
  assert.match(SHELL, /^require_id CROW_RELAY_GID "\$\{CROW_RELAY_GID:-\}"$/m);
  assert.match(SHELL, /CROW_GATEWAY_UID \/ CROW_GATEWAY_GID/);
  assert.doesNotMatch(SHELL, /CROW_RELAY_UID=0/, "never a default uid");
  assert.ok(SHELL.indexOf("require_id CROW_RELAY_UID") < SHELL.indexOf('Xvfb ":'), "checked before Xvfb");
  // Passed to the supervisor, which alone knows how to drop.
  assert.match(SHELL, /^export CROW_CDP_RELAY_UID="\$CROW_RELAY_UID"$/m);
  assert.match(SHELL, /^export CROW_CDP_RELAY_GID="\$CROW_RELAY_GID"$/m);
  // After the loopback check: every listener on the port must be that uid.
  assert.ok(SHELL.indexOf('listener_uid_is "${CDP_PORT}"') > SHELL.indexOf('require_loopback "${CDP_PORT}"'));
  assert.match(SHELL, /listener_uid_is "\$\{CDP_PORT\}" "\$CROW_RELAY_UID" \/proc\/net\/tcp \/proc\/net\/tcp6/);
  assert.match(SHELL, /die "the CDP relay is not running as the gateway's uid/);
  assert.match(SHELL, /print \$8/, "the uid column of every LISTEN row is what is compared");
});

test("the token reaches the relay's uid through a 0700 directory, never through an argv or an env value", () => {
  assert.match(SHELL, /^rm -rf \/run\/crow-cdp$/m, "a stale copy from an earlier start never survives");
  assert.match(SHELL, /^install -d -m 700 -o "\$CROW_RELAY_UID" -g "\$CROW_RELAY_GID" \/run\/crow-cdp \\$/m);
  assert.match(SHELL, /^install -m 400 -o "\$CROW_RELAY_UID" -g "\$CROW_RELAY_GID" "\$CDP_TOKEN_SRC" \/run\/crow-cdp\/token \\$/m);
  assert.match(SHELL, /^export CROW_CDP_TOKEN_FILE=\/run\/crow-cdp\/token$/m, "only the path is exported");
  assert.doesNotMatch(SHELL, /export CROW_CDP_TOKEN_FILE="\$CDP_TOKEN_SRC"/, "the root-only mount is not what the relay reads");
  assert.ok(SHELL.indexOf("install -m 400") > SHELL.indexOf("CDP_TOKEN_SRC") - 1);
  assert.ok(SHELL.indexOf("install -m 400") < SHELL.indexOf('node "$RELAY"'), "copied before the relay starts");
});

test("the CDP token arrives as a 0400 file, is checked before the browser starts, and never reaches an argv", () => {
  assert.match(COMPOSE, /- source: cdp_token\n\s+target: \/run\/secrets\/crow-cdp-token\n\s+mode: 0400/, "a root-only file, like the VNC token");
  assert.match(COMPOSE, /\n  cdp_token:\n    content: \$\{CROW_BROWSER_CDP_TOKEN:-\}\n/, "passed leniently: `:-`, never `:?`");
  assert.doesNotMatch(COMPOSE, /CROW_BROWSER_CDP_TOKEN:\?/, "`:?` would break Start before the mint has run");
  assert.doesNotMatch(COMPOSE, /^\s*command:/m, "no compose command line at all");
  assert.doesNotMatch(COMPOSE, /\n\s+- CROW_BROWSER_CDP_TOKEN=/, "never an environment variable (docker inspect would show it)");

  assert.match(SHELL, /^CDP_TOKEN_SRC=\/run\/secrets\/crow-cdp-token$/m);
  assert.ok(SHELL.indexOf("CDP_TOKEN_SRC") < SHELL.indexOf('node "$RELAY"'), "checked before the relay (and its browser) starts");
  assert.match(SHELL, /\[ -s "\$CDP_TOKEN_SRC" \] \|\| die "the CDP token/);
  assert.match(SHELL, /grep -qE '\^\[A-Za-z0-9_-\]\{32,256\}\$' "\$CDP_TOKEN_SRC"/);
  // The value itself never becomes a shell variable here: the relay reads the file.
  for (const line of SHELL.split("\n")) {
    assert.doesNotMatch(line, /CDP_TOKEN_VALUE|\$\(cat "\$CDP_TOKEN_SRC"\)/, "the entrypoint never copies the token into a variable: " + line.trim());
  }
  assert.doesNotMatch(SHELL, /export CROW_BROWSER_CDP_TOKEN/);
});

test("the manifest bumps to 1.7.0, refreshes the four files, requires the token, and drops 9222 from ports", () => {
  assert.equal(MANIFEST.version, "1.7.0", "the uid split changes the container, so installed copies must refresh");
  assert.deepEqual(
    MANIFEST.refreshFiles,
    ["docker-compose.yml", "Dockerfile", "entrypoint.sh", "cdp-relay.mjs"],
    "a version bump alone does not refresh these: they must be opted in",
  );
  assert.ok(MANIFEST.requires.env.includes("CROW_BROWSER_CDP_TOKEN"), "the container refuses to start without it");
  assert.deepEqual(MANIFEST.ports, [6080], "9222 is no longer opened to the tailnet at install");
  assert.ok(!MANIFEST.ports.includes(9222));
  assert.ok(!MANIFEST.server.envKeys.includes("CROW_BROWSER_CDP_TOKEN"), "never handed to the MCP server's env");
  assert.match(MANIFEST.notes, /pipe/);
  assert.match(MANIFEST.notes, /CROW_BROWSER_CDP_TOKEN/);
  assert.match(MANIFEST.notes, /CROW_GATEWAY_UID/, "the notes say how the relay's uid arrives");
  for (const lang of ["en", "es"]) {
    assert.match(MANIFEST.install_consent_messages[lang], /9222/);
    assert.match(MANIFEST.install_consent_messages[lang], /127\.0\.0\.1/);
    assert.doesNotMatch(MANIFEST.install_consent_messages[lang], /no tiene contraseña, así que|has no password, so/, "the consent text no longer says the port is ungated");
  }
  // The consent text says who answered on 9222 (the Crow user, not root), in both languages.
  assert.match(MANIFEST.install_consent_messages.en, /Crow user/);
  assert.match(MANIFEST.install_consent_messages.es, /usuario de Crow/);
});

test("the registry mirrors the manifest exactly (the browser entry is the manifest plus official:true)", () => {
  const entries = REGISTRY["add-ons"] || REGISTRY.addons || REGISTRY;
  const entry = entries.find((a) => a.id === "browser");
  assert.ok(entry, "the registry lists the browser");
  assert.deepEqual(entry, { ...MANIFEST, official: true }, "registry/add-ons.json is generated: rerun `npm run build-registry` after editing the manifest");
});

test("the image carries the relay, asserts setpriv, and imports only node: modules", () => {
  assert.match(DOCKERFILE, /^COPY cdp-relay\.mjs \.\/$/m, "the relay must be in the image");
  assert.match(DOCKERFILE, /^COPY entrypoint\.sh \.\/$/m);
  assert.match(DOCKERFILE, /^RUN test -x \/usr\/bin\/setpriv$/m, "the uid drop needs util-linux's setpriv: assert it, install nothing");
  assert.doesNotMatch(DOCKERFILE, /apt-get install[^\n]*setpriv/, "no new package for it (it is in the base image)");
  const imports = [...RELAY.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 6, `expected the relay's imports, found ${imports.length}`);
  for (const specifier of imports) assert.match(specifier, /^node:/, "a bare import would need a package in the image: " + specifier);
});

test("the compose passes the gateway's uid/gid leniently, and the entrypoint is what fails closed", () => {
  assert.match(COMPOSE, /^\s+- CROW_RELAY_UID=\$\{CROW_GATEWAY_UID:-\}$/m);
  assert.match(COMPOSE, /^\s+- CROW_RELAY_GID=\$\{CROW_GATEWAY_GID:-\}$/m);
  assert.doesNotMatch(COMPOSE, /CROW_GATEWAY_UID:\?/, "`:?` would hold the boot catch-up's compose refresh");
  assert.doesNotMatch(COMPOSE, /CROW_GATEWAY_GID:\?/);
  assert.match(COMPOSE, /the boot catch-up/, "the reason `:-` is used is written down");
});

test("every gateway compose run hands the two ids over: composeEnv sets them from its own process", () => {
  const guard = read("servers/gateway/compose-guard.js");
  assert.match(guard, /export function composeIdsEnv\(ids = \{\}\)/, "one place owns the rule");
  assert.match(guard, /env\.CROW_GATEWAY_UID = String\(uid\)/);
  assert.match(guard, /env\.CROW_GATEWAY_GID = String\(gid\)/);
  assert.match(guard, /return Object\.assign\(env, composeIdsEnv\(ids\)\);/, "composeEnv always adds them");
  // The two wrappers every bundle install/start path uses go through composeEnv itself.
  assert.match(read("servers/gateway/bundle-core.js"), /return composeEnvFor\(base, crowHome\)/, "bundle-core wraps it");
  assert.match(read("servers/gateway/routes/bundles.js"), /return coreComposeEnv\(base, CROW_HOME\)/, "routes/bundles.js wraps bundle-core");
  // The two direct compose runs that did not use composeEnv now get the ids as well.
  const panel = read("servers/gateway/dashboard/panels/extensions/data-queries.js");
  assert.match(panel, /env: composeEnv\(process\.env, CROW_DIR\)/, "the panel's `ps` uses the same env as install/start");
  assert.match(panel, /from "\.\.\/\.\.\/\.\.\/compose-guard\.js"/, "…from the one implementation");
  const doors = read("servers/gateway/routes/addon-doors.js");
  assert.match(doors, /Object\.assign\(env, composeIdsEnv\(\)\)/, "the browser door's compose recreate carries them");
  assert.match(doors, /from "\.\.\/compose-guard\.js"/);
  // The operator CLI runs `docker compose` for a bundle directly: it exports both ids for
  // every run below it (a compose that names them and gets an empty value stops the container).
  const cli = read("scripts/crow");
  assert.match(cli, /^CROW_GATEWAY_UID="\$\(stat -c %u "\$CROW_HOME"/m);
  assert.match(cli, /^CROW_GATEWAY_GID="\$\(stat -c %g "\$CROW_HOME"/m);
  assert.match(cli, /^export CROW_GATEWAY_UID CROW_GATEWAY_GID$/m);
});

test("the docs and the port registry say what changed (en + es)", () => {
  for (const f of ["docs/guide/browser-automation.md", "docs/es/guide/browser-automation.md"]) {
    const md = read(f);
    assert.match(md, /CROW_BROWSER_CDP_TOKEN/, f + " names the token");
    assert.doesNotMatch(md, /no tiene autenticación|has \*\*no authentication\*\*/, f + " no longer says the port is ungated");
    assert.doesNotMatch(md, /Proteger CDP es una tarea aparte|Gating CDP is tracked separately/, f + " the gate has shipped");
  }
  const ports = read("docs/developers/port-allocation.md");
  assert.match(ports, /^\| 9222 \| 127\.0\.0\.1 \| browser \(CDP relay\)/m, "a plain 9222 row for the relay");
  assert.match(ports, /CROW_BROWSER_CDP_PORT/, "and the r4-style override is named");
  assert.match(ports, /gateway's uid/, "and who answers on it");
});

test("the docs say the relay answers as the Crow user, in both languages", () => {
  assert.match(read("docs/guide/browser-automation.md"), /Crow user/);
  assert.match(read("docs/es/guide/browser-automation.md"), /usuario de Crow/);
  for (const f of ["docs/guide/browser-automation.md", "docs/es/guide/browser-automation.md"]) {
    assert.doesNotMatch(read(f), /relay runs as root|el relay se ejecuta como root/, f + " no longer says the relay is root's");
  }
});