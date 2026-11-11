/**
 * The installer Caddy's admin API — a unix socket, never localhost:2019.
 *
 * Caddy's admin API defaults to a plain TCP listener on the local interface with
 * no authentication, so any local account (a default-tier bot included) could
 * POST /load and rewrite the HTTPS front door Caddy serves for Crow — which
 * defeats the dedicated proxy socket's premise, since a bot that can rewrite the
 * front door no longer needs to forge a proxy peer.
 *
 * So the installer's Caddyfile opens with a global block pinning
 * `admin unix//run/caddy/admin.sock`, and a caddy.service drop-in gives Caddy the
 * /run/caddy directory it cannot create itself (it runs as the caddy user). No
 * `|mode` suffix: Caddy's default for a unix address is 0200 — owner write only —
 * and the socket is created by the caddy user's own process. `admin off` is not
 * used, because `systemctl reload caddy` (the packaged ExecReload runs `caddy
 * reload`) must keep working.
 *
 * These tests pin:
 *   - the installer's Caddyfile heredoc: a global block FIRST, the socket line,
 *     no mode suffix, no `admin off`, and the drop-in written before the
 *     daemon-reload that reads it;
 *   - that nothing under scripts/ or servers/ names a TCP Caddy admin address or
 *     reloads Caddy through one (bundles/caddy is a separate, containerised
 *     product with its own socket and is deliberately out of scope);
 *   - the fix-it detector: fires on a Crow Caddyfile with no admin option,
 *     quiet on any admin option the owner chose (off, a socket, an address) and
 *     on a Caddyfile that does not front Crow, and never opens a connection;
 *   - scripts/fix-caddy-admin-socket.sh: static shape (bash -n, shellcheck when
 *     present, the verification sequence, a restore trap);
 *   - and its BEHAVIOUR, run for real against stubs on PATH: a fresh Caddyfile,
 *     an existing global block, an idempotent re-run, `admin off`, an operator's
 *     own admin line (refused, file untouched), and a failed verification that
 *     restores every file.
 *
 * Placeholder names only. Every service command is a stub that logs its argv.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import detector, {
  caddyAdminProblem,
  DEDUP_KEY,
} from "../servers/gateway/fix-it/detectors/caddy-admin-socket.js";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts", "crow-install.sh");
const FIX = join(ROOT, "scripts", "fix-caddy-admin-socket.sh");
const ADMIN_SOCKET_LINE = "admin unix//run/caddy/admin.sock";

// ─── the installer ───

const installerSrc = () => readFileSync(INSTALLER, "utf-8");
const fixSrc = () => readFileSync(FIX, "utf-8");

/** The installer's Caddyfile heredoc body (what Caddy actually gets). */
function caddyfileHeredoc(s) {
  const start = s.indexOf("sudo tee /etc/caddy/Caddyfile");
  const end = s.indexOf("\nEOF\n", start);
  assert.ok(start > -1 && end > -1, "the installer must write /etc/caddy/Caddyfile");
  return s.slice(s.indexOf("\n", start) + 1, end);
}

/** The drop-in heredoc body the installer writes for caddy.service. */
function adminDropInHeredoc(s) {
  const marker = "sudo tee /etc/systemd/system/caddy.service.d/crow-admin-socket.conf";
  const start = s.indexOf(marker);
  assert.ok(start > -1, "the installer must write the caddy.service drop-in");
  const end = s.indexOf("\nCADDYADMINEOF\n", start);
  assert.ok(end > -1);
  return s.slice(s.indexOf("\n", start) + 1, end);
}

test("installer: the Caddyfile opens with a global block that pins the admin API to a unix socket", () => {
  const block = caddyfileHeredoc(installerSrc());
  // A global options block must be the FIRST block of the file, and this one
  // must come before the site block.
  assert.ok(block.startsWith("{\n\t" + ADMIN_SOCKET_LINE + "\n}\n"), "a global block with the admin line comes first");
  assert.ok(block.indexOf(ADMIN_SOCKET_LINE) < block.indexOf("${MDNS_HOST} {"), "the admin line precedes the site block");
  // No |mode suffix: 0200 (Caddy's default for a unix address, owner write
  // only) is stricter than any mode a shell could name here.
  assert.doesNotMatch(block, /admin[^\n]*\|/, "the admin line carries no |mode suffix");
  // never `admin off` — that would make `caddy reload` impossible.
  assert.doesNotMatch(block, /admin[ \t]+off\b/, "the admin API stays reachable for a reload");
  // The site block is unchanged.
  assert.match(block, /^\$\{MDNS_HOST\} \{$/m);
  assert.match(block, /^\tadmin unix\/\/run\/caddy\/admin\.sock$/m);
  assert.match(block, /reverse_proxy unix\/\/run\/crow-proxy\/gateway\.sock/);
});

test("installer: the caddy.service drop-in creates /run/caddy, and is written before the daemon-reload", () => {
  const s = installerSrc();
  const dropIn = adminDropInHeredoc(s);
  assert.match(dropIn, /^\[Service\]$/m);
  const svc = dropIn.slice(dropIn.indexOf("[Service]"));
  assert.match(svc, /^RuntimeDirectory=caddy$/m);
  assert.match(svc, /^RuntimeDirectoryMode=0750$/m);
  assert.doesNotMatch(dropIn.slice(0, dropIn.indexOf("[Service]")), /^\s*RuntimeDirectory/m, "the keys stay under [Service]");

  // Caddy runs as the caddy user and cannot create a directory under /run, so
  // systemd makes it — and the drop-in has to exist before the reload that
  // reads it.
  const mkdirIdx = s.indexOf("sudo mkdir -p /etc/systemd/system/caddy.service.d");
  const teeIdx = s.indexOf("sudo tee /etc/systemd/system/caddy.service.d/crow-admin-socket.conf");
  const reloadIdx = s.indexOf("sudo systemctl daemon-reload");
  assert.ok(mkdirIdx > -1 && teeIdx > mkdirIdx, "the drop-in directory is created before the file");
  assert.ok(reloadIdx > teeIdx, "the drop-in is written before systemctl daemon-reload");

  // The socket is created by Caddy as it starts, so the installer waits for it
  // and warns (never aborts: the front door still serves).
  const restartIdx = s.indexOf("sudo systemctl restart caddy\n");
  const waitIdx = s.indexOf("sudo test -S /run/caddy/admin.sock");
  assert.ok(restartIdx > -1 && waitIdx > restartIdx, "the socket is waited for after the restart");
  assert.match(s.slice(waitIdx), /warn "Caddy's admin socket/);

  // Nowhere in the installer is Caddy's admin API a TCP address.
  assert.doesNotMatch(s, /localhost:2019/);
  assert.doesNotMatch(s, /127\.0\.0\.1:2019/);
});

// ─── no TCP Caddy admin target anywhere in our own servers/scripts ───

const SKIP_DIRS = new Set(["node_modules", "bundles", ".git"]);

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const isCommentLine = (t) => t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

test("no Caddy admin TCP address is written or dialled under scripts/ or servers/", () => {
  // bundles/caddy is a separate containerised Caddy with its own admin socket and
  // its own tests; it is not this machine's Caddy.
  const offenders = [];
  for (const dir of ["scripts", "servers"]) {
    for (const file of walkFiles(join(ROOT, dir))) {
      const buf = readFileSync(file);
      if (buf.includes(0)) continue; // a binary payload is not a Caddy config
      const text = buf.toString("utf8");
      if (!text.includes(":2019")) continue;
      const rel = file.slice(ROOT.length + 1);
      for (const line of text.split("\n")) {
        if (!line.includes(":2019")) continue;
        const trimmed = line.trim();
        // The one place the old default may appear in code is the repair
        // script's connection-only probe; anything else must be a comment.
        const probe = rel === "scripts/fix-caddy-admin-socket.sh" && trimmed.includes("/dev/tcp/127.0.0.1/2019");
        if (!isCommentLine(trimmed) && !probe) offenders.push(`${rel}: ${trimmed.slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "Caddy's admin API must be a unix socket here, never a TCP address");
});

test("scripts/ never reloads Caddy through its admin address (the packaged ExecReload reads the Caddyfile)", () => {
  const offenders = [];
  for (const file of walkFiles(join(ROOT, "scripts"))) {
    if (!file.endsWith(".sh") && !file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!/caddy[^\n]*reload/i.test(line)) continue;
      const trimmed = line.trim();
      if (isCommentLine(trimmed)) continue;
      if (trimmed.includes("--address")) offenders.push(`${file.slice(ROOT.length + 1)}: ${trimmed.slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], "a reload must go through the Caddyfile's own admin address, never a hard-coded one");
});

// ─── the fix-it detector ───

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-caddy-admin-socket-"));
let fixtureSeq = 0;
function fixture(text) {
  const p = join(FIXTURES, `caddyfile-${(fixtureSeq += 1)}`);
  writeFileSync(p, text);
  return p;
}
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

const CROW_SOCKETFILE = "example.local {\n\ttls internal\n\treverse_proxy unix//run/crow-proxy/gateway.sock\n}\n";
const CROW_LOOPBACKFILE = "example.local {\n\ttls internal\n\treverse_proxy localhost:3001\n}\n";
const withGlobal = (option) => `{\n\t${option}\n}\n\n${CROW_SOCKETFILE}`;

test("detector fires on a Crow Caddyfile with no admin option, and names the exact command", () => {
  const problem = caddyAdminProblem({ caddyfile: fixture(CROW_SOCKETFILE) });
  assert.ok(problem, "a Crow Caddyfile with no admin line leaves Caddy's admin API on its local default");
  assert.match(problem.title, /admin API/);
  assert.match(problem.why, /any program or bot on this machine/);
  assert.match(problem.why, /Crow does not run as root/);
  assert.match(problem.fixCommand, /^sudo bash .*scripts\/fix-caddy-admin-socket\.sh$/);
  assert.ok(problem.why.includes(problem.fixCommand), "the card text carries the command");
  assert.equal(problem.context.fixCommand, problem.fixCommand);
  assert.match(problem.context.caddyfile, /caddyfile-\d+$/);

  // The legacy loopback Caddyfile is Crow's too (it is the same front door,
  // just before the proxy-socket change).
  assert.ok(caddyAdminProblem({ caddyfile: fixture(CROW_LOOPBACKFILE) }), "the legacy loopback Caddyfile fires too");
});

test("detector stays quiet on every admin option the owner may have chosen", () => {
  for (const option of [
    "admin off",
    "admin unix//run/caddy/admin.sock",
    "admin unix//srv/caddy/run/admin.sock",
    "admin localhost:2019",
    "admin :2019 {",
    "admin 0.0.0.0:2019",
  ]) {
    assert.equal(caddyAdminProblem({ caddyfile: fixture(withGlobal(option)) }), null, `must not fire on: ${option}`);
  }
});

test("detector stays quiet on a Caddyfile that is not Crow's, and on an unreadable file", () => {
  assert.equal(caddyAdminProblem({ caddyfile: fixture("example.local {\n\trespond \"hi\"\n}\n") }), null);
  assert.equal(caddyAdminProblem({ caddyfile: fixture("example.local {\n\treverse_proxy localhost:8080\n}\n") }), null);
  assert.equal(caddyAdminProblem({ caddyfile: join(FIXTURES, "no-such-caddyfile") }), null);
  // An unreadable path is a no-Caddy machine, not a problem to report.
  assert.equal(caddyAdminProblem({ caddyfile: FIXTURES, readFile: () => { throw new Error("EACCES"); } }), null);
});

test("detector: a comment mentioning admin is not an admin option", () => {
  const commented = `# admin off\n#admin localhost:2019\n${CROW_SOCKETFILE}`;
  assert.ok(caddyAdminProblem({ caddyfile: fixture(commented) }), "a commented admin line does not count");
  // …and a directive that merely contains the word does not either.
  const site = "example.local {\n\treverse_proxy unix//run/crow-proxy/gateway.sock\n\trespond \"admin :2019\" 200\n}\n";
  assert.ok(caddyAdminProblem({ caddyfile: fixture(site) }));
});

test("detector.check upserts one warn card with no remedy, and resolves it once the line is there", async () => {
  const items = [];
  const resolved = [];
  const store = {
    upsertItem: async (i) => { items.push(i); return { id: 1, notify: true }; },
    resolveByKey: async (source, key) => { resolved.push([source, key]); },
  };

  const open = fixture(CROW_SOCKETFILE);
  await detector.check(store, { caddyfile: open });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "caddy-admin-socket");
  assert.equal(items[0].dedupKey, DEDUP_KEY);
  assert.equal(items[0].severity, "warn");
  assert.deepEqual(items[0].remedies, [], "not one-click: the gateway cannot write /etc as root");
  assert.match(items[0].why, /sudo bash .*fix-caddy-admin-socket\.sh/, "the card names the exact command");
  assert.equal(items[0].context.caddyfile, open);
  assert.deepEqual(resolved, [], "nothing to resolve while the problem is there");

  await detector.check(store, { caddyfile: fixture(withGlobal("admin unix//run/caddy/admin.sock")) });
  assert.equal(items.length, 1, "no card once the Caddyfile pins the admin socket");
  assert.deepEqual(resolved, [["caddy-admin-socket", DEDUP_KEY]], "the stale card is resolved");

  // A store without resolveByKey (or one that throws) must not break boot.
  await detector.check({ upsertItem: async () => ({ id: 1, notify: false }) }, { caddyfile: open });
  await detector.check({ upsertItem: async () => ({ id: 1, notify: false }), resolveByKey: async () => { throw new Error("no row"); } },
    { caddyfile: fixture(CROW_SOCKETFILE) });
});

test("detector ships as a boot check: no events, an onEvent that does nothing", async () => {
  assert.equal(detector.source, "caddy-admin-socket");
  assert.deepEqual(detector.events, []);
  assert.equal(await detector.onEvent(), undefined);
});

// ─── scripts/fix-caddy-admin-socket.sh: static shape ───

test("fix-caddy-admin-socket.sh: bash -n parses", () => {
  execFileSync("bash", ["-n", FIX]);
});

test("fix-caddy-admin-socket.sh: shellcheck passes when available (skips otherwise)", (t) => {
  const which = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("shellcheck not installed");
  const r = spawnSync("shellcheck", [FIX], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout);
});

test("fix-caddy-admin-socket.sh: the socket is the default, the drop-in is written, the order is validate → restart → verify", () => {
  const s = fixSrc();
  // Defaults, overridable for tests only.
  assert.match(s, /CADDYFILE="\$\{CROW_CADDYFILE:-\/etc\/caddy\/Caddyfile\}"/);
  assert.match(s, /SYSTEMD_DIR="\$\{CROW_SYSTEMD_DIR:-\/etc\/systemd\/system\}/);
  assert.match(s, /ADMIN_SOCKET="\$\{CROW_CADDY_ADMIN_SOCKET:-\/run\/caddy\/admin\.sock\}"/);
  assert.match(s, /ADMIN_LINE="admin unix\/\$ADMIN_SOCKET"/, "so the default line is exactly " + ADMIN_SOCKET_LINE);
  assert.match(s, /^set -uo pipefail$/m);
  // Refuses without sudo and without a caddy user, changing nothing.
  assert.match(s, /"Run this with sudo/);
  assert.match(s, /getent passwd "\$CADDY_USER"/);
  // Backups first, and a restore trap that restarts Caddy the way it was.
  assert.match(s, /cp -a "\$CADDYFILE" "\$BACKUP_DIR\/Caddyfile"/);
  assert.match(s, /trap restore ERR/);
  assert.match(s, /restoring the previous setup/);
  assert.match(s, /restore_file "\$BACKUP_DIR\/crow-admin-socket\.conf" "\$DROP_IN"/);
  assert.match(s, /^trap - ERR$/m, "success clears the trap");
  // The drop-in content, the same one the installer writes.
  assert.match(s, /^RuntimeDirectory=caddy$/m);
  assert.match(s, /^RuntimeDirectoryMode=0750$/m);
  // The order: validate, daemon-reload, a FULL restart, the socket, health, a reload.
  // Only unindented lines: the restore function repeats two of these calls.
  const at = (needle) => {
    const i = s.indexOf(needle);
    assert.ok(i > -1, `the script must contain: ${needle}`);
    return i;
  };
  const validate = at('caddy validate --config "$CADDYFILE"\n');
  const reload = at("\nsystemctl daemon-reload\n");
  const restart = at('\nsystemctl restart "$CADDY_UNIT_NAME"\n');
  const sock = at('[ -S "$ADMIN_SOCKET" ]');
  const health = at('HEALTH_CODE="$(curl');
  const sysReload = at('if ! systemctl reload "$CADDY_UNIT_NAME"');
  assert.ok(validate < reload && reload < restart && restart < sock && sock < health && health < sysReload,
    "validate → daemon-reload → restart → socket → /health → systemctl reload");
  assert.doesNotMatch(s, /^[ \t]*caddy reload/m, "a reload cannot move the admin address, so the move is a restart");
  assert.match(s, /the OLD admin address/);
  assert.match(s, /--resolve "\$SITE_HOST:\$SITE_PORT:127\.0\.0\.1"/);
  assert.match(s, /if \[ "\$HEALTH_CODE" != "200" \]/);
  assert.match(s, /Already set up/);
  // The operator's own admin line is their choice: refused, nothing changed.
  assert.match(s, /your own choice, not Crow's/);
  // No group membership is touched, and no request is ever sent to the old port.
  assert.doesNotMatch(s, /usermod/);
  assert.doesNotMatch(s, /curl[^\n]*2019/);
  assert.doesNotMatch(s, /POST[^\n]*2019/);
  // Only the connection-only probe mentions the old address in code.
  assert.match(s, /\(exec 3<>\/dev\/tcp\/127\.0\.0\.1\/2019\) 2>\/dev\/null/);
});

// ─── scripts/fix-caddy-admin-socket.sh: behaviour, with stubs on PATH ───

const TMP = mkdtempSync(join(tmpdir(), "crow-caddy-admin-run-"));
const ADMIN_SOCKET_PATH = join(TMP, "admin.sock");
const REAL_PATH = process.env.PATH;
let sockServer;

before(async () => {
  // A real unix socket: `[ -S "$ADMIN_SOCKET" ]` is a filesystem test, and this
  // is the closest thing to the socket Caddy would create.
  sockServer = net.createServer((c) => c.destroy());
  await new Promise((done, fail) => {
    sockServer.once("error", fail);
    sockServer.listen(ADMIN_SOCKET_PATH, done);
  });
});

after(() => {
  sockServer.close();
  rmSync(TMP, { recursive: true, force: true });
});

/** A scratch world: stub binaries, a Caddyfile, a systemd dir, a call log. */
function world(caddyfileText, { dropIn = false } = {}) {
  const dir = mkdtempSync(join(TMP, "w-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const stub = (name, lines) => {
    const p = join(bin, name);
    writeFileSync(p, ["#!/bin/bash", `echo "${name} $*" >> "${log}"`, ...lines, "exit 0", ""].join("\n"));
    chmodSync(p, 0o755);
  };
  // `id -u` says root; everything else is the real tool.
  stub("id", ['if [ "$1" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi']);
  stub("getent", []); // the caddy user exists
  stub("caddy", []);
  stub("systemctl", ['if [ "$1" = "reload" ]; then exit "${STUB_RELOAD_RC:-0}"; fi']);
  stub("curl", ['printf "%s" "${STUB_CURL_CODE:-200}"']);

  const caddyfile = join(dir, "Caddyfile");
  writeFileSync(caddyfile, caddyfileText);
  const systemdDir = join(dir, "systemd");
  mkdirSync(systemdDir);
  const dropInPath = join(systemdDir, "caddy.service.d", "crow-admin-socket.conf");
  if (dropIn) {
    mkdirSync(join(systemdDir, "caddy.service.d"), { recursive: true });
    writeFileSync(dropInPath, "[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0750\n");
  }
  return {
    dir,
    log,
    caddyfile,
    systemdDir,
    dropInPath,
    env: {
      PATH: `${bin}:${REAL_PATH}`,
      CROW_CADDYFILE: caddyfile,
      CROW_SYSTEMD_DIR: systemdDir,
      CROW_CADDY_ADMIN_SOCKET: ADMIN_SOCKET_PATH,
      CROW_FIX_RETRY_SLEEP: "0",
      STUB_LOG: log,
      STUB_CURL_CODE: "200",
      STUB_RELOAD_RC: "0",
    },
  };
}

function runFix(w, extra = {}) {
  writeFileSync(w.log, "");
  const r = spawnSync("bash", [FIX], { encoding: "utf-8", env: { ...w.env, ...extra } });
  const calls = readFileSync(w.log, "utf-8").split("\n").filter(Boolean).map((l) => l.replace(/\s+/g, " ").trim());
  return { ...r, calls };
}

const indexOfCall = (calls, needle) => calls.findIndex((c) => c.includes(needle));
const serviceCalls = (calls) => calls.filter((c) => c.startsWith("systemctl "));

test("repair: a fresh Crow Caddyfile gets the admin block FIRST, plus the drop-in, and services in order", () => {
  const w = world(`example.local {\n    tls internal\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n`);
  const r = runFix(w);
  assert.equal(r.status, 0, r.stderr);

  const after = readFileSync(w.caddyfile, "utf-8");
  assert.ok(after.startsWith(`{\n\tadmin unix/${ADMIN_SOCKET_PATH}\n}\n\n`), `global block first, got:\n${after}`);
  // The site block is untouched, below it.
  assert.ok(after.includes("example.local {\n    tls internal\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n"));
  assert.equal(after.split("\n").filter((l) => l.trim() === "{").length, 1, "exactly one global block");

  // The drop-in.
  assert.equal(readFileSync(w.dropInPath, "utf-8").match(/^RuntimeDirectory=caddy$/gm).length, 1);
  assert.match(readFileSync(w.dropInPath, "utf-8"), /^RuntimeDirectoryMode=0750$/m);

  // Order of service calls: validate, daemon-reload, restart, health, reload.
  const validate = indexOfCall(r.calls, "caddy validate");
  const daemon = indexOfCall(r.calls, "systemctl daemon-reload");
  const restart = indexOfCall(r.calls, "systemctl restart caddy");
  const health = indexOfCall(r.calls, "curl ");
  const reload = indexOfCall(r.calls, "systemctl reload caddy");
  assert.ok(validate > -1, `validate must run, calls: ${r.calls.join(" | ")}`);
  assert.ok(validate < daemon && daemon < restart && restart < health && health < reload,
    `order was: ${r.calls.join(" | ")}`);
  assert.match(r.stdout, /Done: Caddy's admin API is on unix\//);
});

test("repair: an existing global block keeps its options and gets the admin line inside it", () => {
  const w = world(`{\n\temail a@example.com\n}\n\nexample.local {\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n`);
  const r = runFix(w);
  assert.equal(r.status, 0, r.stderr);

  const after = readFileSync(w.caddyfile, "utf-8");
  assert.ok(after.startsWith(`{\n\tadmin unix/${ADMIN_SOCKET_PATH}\n\temail a@example.com\n}\n\n`), `got:\n${after}`);
  assert.match(after, /email a@example\.com/, "the owner's own global option survives");
  assert.equal(after.split("\n").filter((l) => l.trim() === "{").length, 1, "one global block, never a second");
});

test("repair: a re-run says Already set up and restarts nothing", () => {
  const w = world(`example.local {\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n`);
  assert.equal(runFix(w).status, 0);
  const first = readFileSync(w.caddyfile, "utf-8");

  const again = runFix(w);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Already set up/);
  assert.deepEqual(serviceCalls(again.calls), [], "an already-fixed install is not restarted");
  assert.equal(readFileSync(w.caddyfile, "utf-8"), first, "the Caddyfile is untouched");
});

test("repair: `admin off` is the owner's own choice — exit 0, nothing changed, nothing restarted", () => {
  const original = "{\n\tadmin off\n}\n\nexample.local {\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n";
  const w = world(original);
  const r = runFix(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already set up/);
  assert.equal(readFileSync(w.caddyfile, "utf-8"), original);
  assert.equal(existsSync(w.dropInPath), false);
  assert.deepEqual(serviceCalls(r.calls), [], "nothing is restarted");
});

test("repair: an operator's own TCP admin line is refused, and the file stays byte-identical", () => {
  const original = "{\n\tadmin localhost:2019\n}\n\nexample.local {\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n";
  const w = world(original);
  const r = runFix(w);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /your own choice, not Crow's/);
  assert.equal(readFileSync(w.caddyfile, "utf-8"), original);
  assert.equal(existsSync(w.dropInPath), false);
  assert.deepEqual(serviceCalls(r.calls), [], "nothing is restarted when the script refuses");
});

test("repair: a failed health check restores the Caddyfile, removes the drop-in and restarts Caddy", () => {
  const original = "example.local {\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n";
  const w = world(original);
  const r = runFix(w, { STUB_CURL_CODE: "502" });
  assert.notEqual(r.status, 0, "a health check that is not 200 fails the run");
  assert.match(r.stderr, /answered '502' instead of 200/);
  assert.equal(readFileSync(w.caddyfile, "utf-8"), original, "the Caddyfile is put back byte for byte");
  assert.equal(existsSync(w.dropInPath), false, "the drop-in this run created is removed again");
  // One restart for the fix, one for the restore.
  assert.equal(r.calls.filter((c) => c.startsWith("systemctl restart caddy")).length, 2,
    `the restore restarts Caddy, calls: ${r.calls.join(" | ")}`);
  assert.ok(indexOfCall(r.calls, "systemctl reload caddy") === -1, "a failed run never reaches the reload check");
});

test("repair: a reload that fails also restores everything", () => {
  const original = "example.local {\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n";
  const w = world(original);
  const r = runFix(w, { STUB_RELOAD_RC: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /systemctl reload caddy\.service' failed/);
  assert.equal(readFileSync(w.caddyfile, "utf-8"), original);
  assert.equal(existsSync(w.dropInPath), false);
});

test("repair: a Caddyfile without a Crow upstream is still handled — the rewrite is the only change", () => {
  // The script does not judge whose Caddyfile it is (only the detector does);
  // it rewrites whatever it is pointed at, which is what the overrides are for.
  const w = world("other.local {\n    respond \"hi\"\n}\n");
  const r = runFix(w);
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(w.caddyfile, "utf-8");
  assert.ok(after.startsWith(`{\n\tadmin unix/${ADMIN_SOCKET_PATH}\n}\n\n`));
  assert.ok(after.includes('other.local {\n    respond "hi"\n}\n'));
});