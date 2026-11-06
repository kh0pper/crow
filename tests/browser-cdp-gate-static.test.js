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

test("the entrypoint starts the relay, waits for its ready file, and keeps require_loopback on CDP_PORT", () => {
  assert.match(SHELL, /^RELAY="\$\(dirname "\$0"\)\/cdp-relay\.mjs"$/m, "the relay ships beside the entrypoint");
  assert.match(SHELL, /^node "\$RELAY" &$/m);
  assert.match(SHELL, /^RELAY_PID=\$!$/m);
  assert.match(SHELL, /^CDP_READY_FILE=\/tmp\/cdp-relay\.ready$/m);
  assert.match(SHELL, /\[ -s "\$CDP_READY_FILE" \]/, "readiness is the relay's own ready file");
  assert.match(SHELL, /require_loopback "\$\{CDP_PORT\}" cdp-relay/, "the relay must be loopback-only");
  assert.match(SHELL, /require_loopback "\$\{NOVNC_PORT\}" websockify/, "and so must noVNC (unchanged)");
  // Started before the readiness loop, and the pid is what gets supervised.
  assert.ok(SHELL.indexOf('node "$RELAY"') < SHELL.indexOf('[ -s "$CDP_READY_FILE" ]'), "the relay is launched before its ready file is awaited");
  assert.match(SHELL, /^wait "\$RELAY_PID"$/m, "the relay's pid replaces Chromium's for supervision");
  assert.doesNotMatch(SHELL, /CHROME_PID/, "nothing in the entrypoint starts Chromium any more");
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

test("the manifest bumps to 1.5.0, refreshes the four files, requires the token, and drops 9222 from ports", () => {
  assert.equal(MANIFEST.version, "1.5.1", "a minor bump: installed copies refresh");
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
  for (const lang of ["en", "es"]) {
    assert.match(MANIFEST.install_consent_messages[lang], /9222/);
    assert.match(MANIFEST.install_consent_messages[lang], /127\.0\.0\.1/);
    assert.doesNotMatch(MANIFEST.install_consent_messages[lang], /no tiene contraseña, así que|has no password, so/, "the consent text no longer says the port is ungated");
  }
});

test("the registry mirrors the manifest exactly (the browser entry is the manifest plus official:true)", () => {
  const entries = REGISTRY["add-ons"] || REGISTRY.addons || REGISTRY;
  const entry = entries.find((a) => a.id === "browser");
  assert.ok(entry, "the registry lists the browser");
  assert.deepEqual(entry, { ...MANIFEST, official: true }, "registry/add-ons.json is generated: rerun `npm run build-registry` after editing the manifest");
});

test("the image carries the relay, and only node: imports (no npm dependency on the gate's hop)", () => {
  assert.match(DOCKERFILE, /^COPY cdp-relay\.mjs \.\/$/m, "the relay must be in the image");
  assert.match(DOCKERFILE, /^COPY entrypoint\.sh \.\/$/m);
  const imports = [...RELAY.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 6, `expected the relay's imports, found ${imports.length}`);
  for (const specifier of imports) assert.match(specifier, /^node:/, "a bare import would need a package in the image: " + specifier);
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
});