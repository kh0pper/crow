// The browser's noVNC viewer has no password of its own (R1.2 PR 5 ruling:
// "Crow's own apps use loopback VNC gated by sign-in"). The viewer is reached
// only through the gateway's session-gated /proxy/browser/ route, so the
// container's VNC ports must listen on loopback ONLY: that binding is the
// security boundary now, and the entrypoint refuses to run without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, REPO), "utf8");
const ENTRYPOINT = read("bundles/browser/entrypoint.sh");
const COMPOSE = read("bundles/browser/docker-compose.yml");
const MANIFEST = JSON.parse(read("bundles/browser/manifest.json"));

/** The entrypoint without its comment lines (assertions are about what runs). */
const CODE = ENTRYPOINT.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** One shell command, its backslash continuations joined. */
function command(name) {
  const joined = CODE.replace(/\\\n\s*/g, " ");
  const lines = joined.split("\n").filter((l) => new RegExp("^\\s*(PYTHONPATH=\\S+\\s+)?" + name + "\\s").test(l));
  assert.equal(lines.length, 1, `exactly one ${name} command line`);
  return lines[0].trim();
}

test("x11vnc serves RFB on a unix socket only: no TCP port (v4 or v6), no password", () => {
  const x = command("x11vnc");
  assert.match(x, /\s-unixsock "\$RFB_SOCK"/, "-unixsock");
  assert.match(x, /\s-rfbport 0\s/, "-rfbport 0: no IPv4 listener");
  assert.match(x, /\s-rfbportv6 0\s/, "-rfbportv6 0: no IPv6 listener");
  assert.match(x, /\s-noipv6(\s|$)/);
  assert.match(x, /\s-nopw(\s|$)/, "-nopw");
  assert.doesNotMatch(x, /-passwd|-rfbauth|-usepw|-passwdfile/, "no VNC password of any kind");
  assert.match(CODE, /^VNC_DIR=\/run\/crow-vnc$/m);
  assert.match(CODE, /^RFB_SOCK="\$\{VNC_DIR\}\/rfb\.sock"$/m);
  assert.match(CODE, /mkdir -m 700 "\$VNC_DIR"/, "a root-only directory");
  assert.match(CODE, /chmod 600 "\$RFB_SOCK"/, "a root-only socket");
  assert.doesNotMatch(CODE, /RFB_PORT/, "no RFB TCP port anywhere");
});

test("websockify binds 127.0.0.1 and reaches RFB only through the token file (Host-header token)", () => {
  const w = command("websockify");
  assert.match(w, /^PYTHONPATH="\$VNC_DIR" websockify /);
  assert.match(w, /--token-plugin crow_quiet_token\.QuietTokenFile --token-source "\$TOKEN_FILE"/, "the lookup that never logs the token");
  assert.match(CODE, /class QuietTokenFile\(ReadOnlyTokenFile\):/);
  assert.match(CODE, /raise WebSockifyServer\.EClose\("token not accepted"\)/, "a miss is refused with a fixed message");
  assert.match(w, /\s--host-token\s/);
  assert.match(w, /\s"127\.0\.0\.1:\$\{NOVNC_PORT\}"\s*&$/, "127.0.0.1 only, and no fixed target");
  assert.doesNotMatch(w, /--unix-target|127\.0\.0\.1:\$\{RFB/, "no target reachable without a token");
  assert.match(CODE, /printf '%s: unix_socket:%s\\n' "\$VNC_TOKEN_VALUE" "\$RFB_SOCK" > "\$TOKEN_FILE"/, "token → the socket");
  assert.match(CODE, /\( umask 077; printf/, "the token file is written 0600");
});

test("the token: required and well-formed, out of the environment before any child starts, never printed", () => {
  const unset = CODE.indexOf("unset VNC_TOKEN\n");
  assert.ok(unset > -1);
  for (const child of ["Xvfb \":", "x11vnc -display", "websockify --web", "--remote-debugging-port"]) {
    assert.ok(unset < CODE.indexOf(child), "unset before " + child);
  }
  assert.ok(CODE.indexOf("unset VNC_TOKEN_VALUE") < CODE.indexOf("Xvfb \":"), "the copy is dropped too");
  assert.match(CODE, /\[\[ "\$VNC_TOKEN_VALUE" =~ \^\[A-Za-z0-9_-\]\{32,256\}\$ \]\]/);
  assert.match(CODE, /^TOKEN_SRC=\/run\/secrets\/crow-vnc-token$/m, "from a file, not the environment");
  assert.match(CODE, /VNC_TOKEN_VALUE="\$\(tr -d '\\r\\n' < "\$TOKEN_SRC" 2>\/dev\/null\)"/);
  assert.doesNotMatch(CODE, /\$\{VNC_TOKEN:-/, "the env var is never read");
  assert.match(CODE, /die "the viewer token \(\$\{TOKEN_SRC\}\) is missing or malformed/);
  for (const line of CODE.split("\n")) {
    // Only the printf that writes the token file (redirected into it) may name the value.
    if (/> "\$TOKEN_FILE"/.test(line)) continue;
    if (/\b(log|echo|die|printf)\b/.test(line)) assert.doesNotMatch(line, /\$\{?VNC_TOKEN/, "never printed: " + line.trim());
  }
});

test("the entrypoint no longer needs VNC_PASSWORD, and an old one is ignored without printing it", () => {
  assert.doesNotMatch(CODE, /die "VNC_PASSWORD/, "a missing password is not fatal");
  assert.doesNotMatch(CODE, /\$\{?VNC_PASSWORD\}?(?!:-)/, "the value is never used or echoed");
  assert.doesNotMatch(CODE, /-passwd/);
});

test("before Chromium starts: x11vnc owns no TCP listener, noVNC listens on loopback only", () => {
  const rfb = CODE.indexOf('no_tcp_listeners "$X11VNC_PID" /proc/net/tcp /proc/net/tcp6');
  const web = CODE.indexOf('require_loopback "${NOVNC_PORT}"');
  const chrome = CODE.indexOf("--remote-debugging-port");
  assert.ok(rfb > -1 && web > -1);
  assert.ok(rfb < chrome && web < chrome, "before Chromium launches");
  assert.ok(CODE.indexOf("x11vnc -display") < rfb, "after x11vnc starts");
  assert.ok(CODE.indexOf("websockify --web") < web, "after websockify starts");
  assert.match(CODE.slice(rfb, rfb + 200), /\|\| die "x11vnc is listening on a TCP port/);
  const fn = CODE.slice(CODE.indexOf("require_loopback() {"), CODE.indexOf("\n}\n", CODE.indexOf("require_loopback() {")));
  assert.match(fn, /die /, "a non-loopback listener is fatal");
  assert.match(fn, /\/proc\/net\/tcp6?/, "reads the kernel's socket tables");
});

// ---- the check itself, run by bash against fixture socket tables -----------

const HDR = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const hexPort = (p) => p.toString(16).padStart(4, "0").toUpperCase();
const row = (addr, port, st = "0A") => `   0: ${addr}:${hexPort(port)} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0`;
const V4_LOOP = "0100007F", V4_ANY = "00000000", V4_LAN = "ED00000A";
const V6_LOOP = "00000000000000000000000001000000", V6_ANY = "00000000000000000000000000000000";
const V6_MAPPED_LOOP = "0000000000000000FFFF00000100007F";

function loopbackOnly(port, tcp, tcp6) {
  const start = ENTRYPOINT.indexOf("loopback_only() {");
  assert.ok(start > -1, "loopback_only is defined");
  const end = ENTRYPOINT.indexOf("\n}\n", start);
  const fn = ENTRYPOINT.slice(start, end + 2);
  const dir = mkdtempSync(join(tmpdir(), "crow-vnc-loop-"));
  try {
    writeFileSync(join(dir, "tcp"), [HDR, ...tcp].join("\n") + "\n");
    writeFileSync(join(dir, "tcp6"), [HDR, ...tcp6].join("\n") + "\n");
    writeFileSync(join(dir, "check.sh"), fn + '\nloopback_only "$1" "$2/tcp" "$2/tcp6"\n');
    try {
      execFileSync("bash", [join(dir, "check.sh"), String(port), dir], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("loopback_only: passes only when the port has listeners and every one is loopback", () => {
  assert.equal(loopbackOnly(6080, [row(V4_LOOP, 6080)], []), true, "127.0.0.1 only");
  assert.equal(loopbackOnly(6080, [row(V4_LOOP, 6080)], [row(V6_LOOP, 6080)]), true, "127.0.0.1 and ::1");
  assert.equal(loopbackOnly(5900, [], [row(V6_MAPPED_LOOP, 5900)]), true, "::ffff:127.0.0.1");
  assert.equal(loopbackOnly(6080, [row(V4_ANY, 6080)], []), false, "0.0.0.0");
  assert.equal(loopbackOnly(6080, [row(V4_LOOP, 6080)], [row(V6_ANY, 6080)]), false, ":: alongside loopback");
  assert.equal(loopbackOnly(6080, [row(V4_LAN, 6080)], []), false, "a LAN address");
  assert.equal(loopbackOnly(6080, [], []), false, "nothing listening is a failure too");
  assert.equal(loopbackOnly(6080, [row(V4_ANY, 6080, "01")], []), false, "an established connection is not a listener");
  assert.equal(loopbackOnly(6081, [row(V4_LOOP, 6081), row(V4_ANY, 6080)], []), true, "another port's wildcard listener is not ours");
});

// ---- compose, manifest, env template ---------------------------------------

test("compose passes the token (required), no VNC password, and its downloads mount, names and networking are unchanged", () => {
  assert.doesNotMatch(COMPOSE, /VNC_PASSWORD/);
  assert.doesNotMatch(COMPOSE, /^\s+- VNC_TOKEN=/m, "never an environment variable (it would show in docker inspect)");
  assert.match(COMPOSE, /\n {4}configs:\n {6}- source: vnc_token\n {8}target: \/run\/secrets\/crow-vnc-token\n {8}mode: 0400\n/, "a 0400 file");
  assert.match(COMPOSE, /\nconfigs:\n  vnc_token:\n    content: \$\{CROW_BROWSER_VNC_TOKEN:\?[^}]+\}\n/, "required: compose refuses to start without it");
  assert.match(COMPOSE, /^\s+stop_grace_period: 30s$/m, "Chromium gets time to flush on a stop");
  assert.match(COMPOSE, /^\s+- CROW_INSTANCE=\$\{CROW_HOME:\?[^}]+\}$/m);
  assert.doesNotMatch(COMPOSE, /-p browser down/, "no advice to run another project's -p");
  assert.doesNotMatch(COMPOSE, /RFB_PORT/);
  const volumes = COMPOSE.split("\n").filter((l) => /^\s+- (\$\{CROW_HOME|chromium-profile:)/.test(l));
  assert.deepEqual(volumes.map((l) => l.trim()), [
    "- ${CROW_HOME:?CROW_HOME is required so each instance writes downloads to its own directory}/browser-downloads:/downloads",
    "- chromium-profile:/root/.config/chromium-crow",
  ], "the downloads bind mount as before, plus the profile's named volume");
  // A NAMED volume (compose prefixes it with the project: one per instance), never a bind or external one.
  assert.match(COMPOSE, /\nvolumes:\n  chromium-profile:\n    name: \$\{CROW_BROWSER_CONTAINER_NAME:-browser\}_chromium-profile\n/, "an explicit per-instance name from this bundle's .env, not from -p; '_' so no bundle id can claim it by prefix");
  assert.match(COMPOSE, /needs Docker Compose 2\.23\.1 or newer/, "the configs: content: minimum is documented");
  // The token's directory and the profile volume never overlap.
  const profile = "/root/.config/chromium-crow", vncDir = /^VNC_DIR=(\S+)$/m.exec(ENTRYPOINT)[1];
  assert.ok(!vncDir.startsWith(profile) && !profile.startsWith(vncDir), vncDir + " vs " + profile);
  assert.ok(volumes.every((l) => !/:\/run\b/.test(l)), "no volume over /run (the token's directory)");
  assert.ok(!"/run/secrets/crow-vnc-token".startsWith(vncDir + "/"), "the token file is outside websockify's directory, which the entrypoint recreates");
  assert.match(COMPOSE, /^name: \$\{CROW_BROWSER_CONTAINER_NAME:-browser\}$/m);
  assert.match(COMPOSE, /^\s+container_name: \$\{CROW_BROWSER_CONTAINER_NAME:-crow-browser\}$/m);
  assert.match(COMPOSE, /^\s+network_mode: host$/m);
  assert.doesNotMatch(COMPOSE, /^\s*ports:/m, "no published ports (host networking)");
  assert.match(ENTRYPOINT, /--user-data-dir=\/root\/\.config\/chromium-crow/, "the profile path is unchanged");
});

test("the manifest declares no VNC password and says the viewer is loopback-only behind sign-in", () => {
  assert.equal(MANIFEST.version, "1.4.2");
  assert.doesNotMatch(JSON.stringify(MANIFEST), /VNC_PASSWORD/);
  assert.deepEqual(MANIFEST.requires.env, ["CROW_BROWSER_VNC_TOKEN"]);
  const tok = MANIFEST.env_vars.find((v) => v.name === "CROW_BROWSER_VNC_TOKEN");
  assert.equal(tok.generate, "hex32", "Crow generates 32 random bytes per install");
  assert.equal(tok.secret, true);
  assert.equal(tok.propagate, false, "never copied into the gateway .env");
  assert.ok(!tok.keychain, "not a human credential: never shown in Settings → Passwords");
  assert.ok(!MANIFEST.server.envKeys.includes("CROW_BROWSER_VNC_TOKEN"), "never handed to the MCP server (a bot's process)");
  assert.equal(MANIFEST.webUI.wsHostTokenEnv, "CROW_BROWSER_VNC_TOKEN", "the gateway proxy adds it");
  assert.ok(!MANIFEST.ports.includes(5900), "no RFB port");
  for (const lang of ["en", "es"]) {
    const msg = MANIFEST.install_consent_messages[lang];
    assert.match(msg, /127\.0\.0\.1/);
    assert.doesNotMatch(msg, /every network interface|todas las interfaces/);
    assert.doesNotMatch(msg, /VNC password|contraseña VNC/);
  }
  const reg = JSON.parse(read("registry/add-ons.json"));
  const entry = (reg["add-ons"] || reg.addons || reg).find?.((a) => a.id === "browser");
  assert.ok(entry, "the registry lists the browser");
  assert.equal(entry.version, "1.4.2");
  assert.doesNotMatch(JSON.stringify(entry), /VNC_PASSWORD/);
  assert.doesNotMatch(read("bundles/browser/.env.example"), /VNC_PASSWORD/);
});

test("the browser MCP server no longer reads or passes a VNC password", () => {
  for (const f of ["server/server.js", "server/instance.js", "server/index.js", "panel/browser.js", "panel/routes.js"]) {
    const src = read("bundles/browser/" + f);
    assert.doesNotMatch(src, /VNC_PASSWORD|vncpw/i, f);
  }
});

// ---- URLs: no viewer link ever carries a password ---------------------------

test("no noVNC URL built anywhere carries a password, and the full-page links autoconnect", async () => {
  const files = [
    "bundles/browser/panel/browser.js",
    "servers/gateway/dashboard/perch-hub/take-over.js",
    "servers/gateway/dashboard/perch-hub/browser-tile.js",
    "servers/gateway/apps/catalog.js",
    "servers/gateway/apps/app-tile.js",
    "servers/gateway/routes/perch-interactive-api.js",
  ];
  for (const f of files) assert.doesNotMatch(read(f), /[?&]password=/i, f);
  const panel = await import("../bundles/browser/panel/browser.js");
  for (const k of ["VNC_VIEW_ONLY", "VNC_INTERACTIVE"]) {
    assert.match(panel[k], /^\/proxy\/browser\/vnc\.html\?/, k);
    assert.match(panel[k], /autoconnect=true/, k);
    assert.match(panel[k], /[?&]path=proxy\/browser\/websockify(&|$)/, k + ": names its own websockify");
    assert.doesNotMatch(panel[k], /password/i, k);
  }
  const { NOVNC_PAGE_PARAMS } = await import("../servers/gateway/apps/catalog.js");
  assert.equal(NOVNC_PAGE_PARAMS.autoconnect, "true");
  assert.doesNotMatch(JSON.stringify(NOVNC_PAGE_PARAMS), /password/i);
  // The skill and docs never send a raw-port VNC URL or ask for a VNC password.
  const skill = read("bundles/browser/skills/crow-browser.md");
  assert.doesNotMatch(skill, /localhost:6080|and the VNC password/);
  assert.match(skill, /no VNC password/, "the skill says the viewer needs none");
});

test("docs (en + es) no longer tell anyone to enter a VNC password or open the raw port", () => {
  const docs = ["docs/guide/browser-automation.md", "docs/es/guide/browser-automation.md"];
  for (const f of docs) {
    const md = read(f);
    assert.doesNotMatch(md, /enter a VNC password|VNC password is required|ingresa una contraseña de VNC|se requiere contraseña de VNC/i, f);
    assert.doesNotMatch(md, /localhost:6080/, f);
    assert.match(md, /127\.0\.0\.1/, f + " says the viewer listens on loopback only");
  }
  for (const f of readdirSync(new URL("bundles/browser/skills/", REPO))) {
    assert.doesNotMatch(read("bundles/browser/skills/" + f), /localhost:6080/, f);
  }
});

test("the X display: a real per-start cookie, no TCP and no abstract (host-wide) socket; x11vnc -noremote", () => {
  const x = command("Xvfb");
  assert.match(x, /-auth "\$XAUTHORITY" -nolisten tcp -nolisten local/);
  assert.doesNotMatch(x, /\s-ac(\s|$)/, "access control stays on");
  assert.match(CODE, /xauth -q -f "\$XAUTHORITY" add ":\$\{DISP_NUM\}" \. "\$\(od -An -N16 -tx1 \/dev\/urandom/);
  assert.match(CODE, /chmod 600 "\$XAUTHORITY"/);
  assert.ok(CODE.indexOf("xauth -q") < CODE.indexOf("Xvfb \":"), "the cookie exists before Xvfb starts");
  assert.match(CODE, /grep -q "@\/tmp\/\.X11-unix\/X\$\{DISP_NUM\}\\\$" \/proc\/net\/unix/, "refuses if an abstract X socket is up");
  assert.match(command("x11vnc"), /\s-noremote\s/);
});

test("a graceful stop: SIGTERM goes to Chromium, which gets time to flush before the rest stops", () => {
  const fn = CODE.slice(CODE.indexOf("shutdown() {"), CODE.indexOf("\n}\n", CODE.indexOf("shutdown() {")));
  assert.match(fn, /cdp_close \|\| true/, "CDP Browser.close first: Chromium's SIGTERM path does not commit cookies");
  assert.match(CODE, /"method": "Browser\.close"/);
  assert.match(fn, /kill -TERM "\$CHROME_PID"/, "SIGTERM only as the fallback");
  assert.ok(fn.indexOf("cdp_close") < fn.indexOf("kill -TERM"));
  assert.match(fn, /kill -0 "\$CHROME_PID"/, "waits for Chromium");
  assert.ok(fn.indexOf("kill -TERM") < fn.indexOf('kill "$X11VNC_PID"'), "Chromium first, the display after");
  assert.match(CODE, /^trap shutdown TERM INT$/m);
  assert.ok(CODE.indexOf("trap shutdown TERM INT") < CODE.lastIndexOf('wait "$CHROME_PID"'));
});

test("the instance marker: the profile names its Crow instance, and a different one refuses to start", () => {
  assert.match(CODE, /^INSTANCE_MARKER="\$\{PROFILE_DIR\}\/\.crow-instance"$/m);
  assert.match(CODE, /\[ -n "\$CROW_INSTANCE" \] \|\| die/);
  assert.match(CODE, /\[ "\$\(realpath -m -- "\$\(cat "\$INSTANCE_MARKER"\)"\)" = "\$CROW_INSTANCE" \] \\\n\s+\|\| die "this browser profile belongs to the Crow instance/);
  assert.ok(CODE.indexOf("INSTANCE_MARKER\" ]") < CODE.indexOf("--remote-debugging-port"), "checked before Chromium opens the profile");
});

test("round 3: Browser.close is bounded (timeout 10), and the marker compares canonical paths on both sides", () => {
  assert.match(CODE, /^  timeout 10 python3 - "\$CDP_PORT" <<'PY' >\/dev\/null 2>&1$/m);
  const fn = CODE.slice(CODE.indexOf("shutdown() {"), CODE.indexOf("\n}\n", CODE.indexOf("shutdown() {")));
  assert.match(fn, /for i in \$\(seq 1 30\); do/, "15 s for Chromium to close itself, inside the 30 s grace period");
  assert.match(CODE, /CROW_INSTANCE="\$\(realpath -m -- "\$CROW_INSTANCE"\)"/);
  assert.match(CODE, /\[ "\$\(realpath -m -- "\$\(cat "\$INSTANCE_MARKER"\)"\)" = "\$CROW_INSTANCE" \]/);
  const script = readFileSync(new URL("scripts/ops/browser-profile-to-volume.sh", REPO), "utf8");
  assert.match(script, /^  timeout 10 python3 - "\$1" <<'PY' >\/dev\/null 2>&1$/m);
  assert.match(script, /^INSTANCE_HOME="\$\(realpath -m -- /m);
});

test("F6: the proxy_url relaunch passes a canonical CROW_HOME (the profile marker compares the host path)", () => {
  const src = read("bundles/browser/server/server.js");
  assert.match(src, /export function canonicalCrowHome\(env = process\.env\)/);
  assert.match(src, /try \{ return \{ CROW_HOME: realpathSync\(env\.CROW_HOME\) \}; \}/);
  assert.match(src, /env: \{ \.\.\.process\.env, \.\.\.canonicalCrowHome\(\), CROW_BROWSER_PROXY: proxy_url \}/);
});
