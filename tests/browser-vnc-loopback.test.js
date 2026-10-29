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
  const lines = joined.split("\n").filter((l) => new RegExp("^\\s*" + name + "\\s").test(l));
  assert.equal(lines.length, 1, `exactly one ${name} command line`);
  return lines[0].trim();
}

test("x11vnc listens on loopback only, with no password and no nag", () => {
  const x = command("x11vnc");
  assert.match(x, /\s-localhost(\s|$)/, "-localhost");
  assert.match(x, /\s-nopw(\s|$)/, "-nopw");
  assert.match(x, /\s-rfbport "\$\{RFB_PORT\}"/);
  assert.doesNotMatch(x, /-passwd|-rfbauth|-usepw|-passwdfile/, "no VNC password of any kind");
});

test("websockify binds 127.0.0.1 and forwards to the loopback RFB port", () => {
  const w = command("websockify");
  assert.match(w, /\s"127\.0\.0\.1:\$\{NOVNC_PORT\}"\s+"127\.0\.0\.1:\$\{RFB_PORT\}"/);
  assert.doesNotMatch(w, /\s"?\$\{NOVNC_PORT\}"?\s/, "never a bare port (that is every interface)");
});

test("the entrypoint no longer needs VNC_PASSWORD, and an old one is ignored without printing it", () => {
  assert.doesNotMatch(CODE, /die "VNC_PASSWORD/, "a missing password is not fatal");
  assert.doesNotMatch(CODE, /\$\{?VNC_PASSWORD\}?(?!:-)/, "the value is never used or echoed");
  assert.doesNotMatch(CODE, /-passwd/);
});

test("both VNC ports are checked for loopback-only listeners before Chromium starts", () => {
  const rfb = CODE.indexOf('require_loopback "${RFB_PORT}"');
  const web = CODE.indexOf('require_loopback "${NOVNC_PORT}"');
  const chrome = CODE.indexOf("--remote-debugging-port");
  assert.ok(rfb > -1, "RFB port checked");
  assert.ok(web > -1, "noVNC port checked");
  assert.ok(rfb < chrome && web < chrome, "before Chromium launches");
  assert.ok(CODE.indexOf("x11vnc -display") < rfb, "after x11vnc starts");
  assert.ok(CODE.indexOf("websockify --web") < web, "after websockify starts");
  // A failed check takes the container down: require_loopback ends in die.
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

test("compose passes no VNC password, and its volume, container name and project name are unchanged", () => {
  assert.doesNotMatch(COMPOSE, /VNC_PASSWORD/);
  const volumes = COMPOSE.split("\n").filter((l) => /^\s+- \$\{CROW_HOME/.test(l));
  assert.deepEqual(volumes.map((l) => l.trim()), [
    "- ${CROW_HOME:?CROW_HOME is required so each instance writes downloads to its own directory}/browser-downloads:/downloads",
  ], "the one bind mount, as before");
  assert.match(COMPOSE, /^name: \$\{CROW_BROWSER_CONTAINER_NAME:-browser\}$/m);
  assert.match(COMPOSE, /^\s+container_name: \$\{CROW_BROWSER_CONTAINER_NAME:-crow-browser\}$/m);
  assert.match(COMPOSE, /^\s+network_mode: host$/m);
  assert.doesNotMatch(COMPOSE, /^\s*ports:/m, "no published ports (host networking)");
  assert.match(ENTRYPOINT, /--user-data-dir=\/root\/\.config\/chromium-crow/, "the profile path is unchanged");
});

test("the manifest declares no VNC password and says the viewer is loopback-only behind sign-in", () => {
  assert.equal(MANIFEST.version, "1.3.12");
  assert.doesNotMatch(JSON.stringify(MANIFEST), /VNC_PASSWORD/);
  assert.ok(!(MANIFEST.requires?.env || []).length, "nothing required at install");
  for (const lang of ["en", "es"]) {
    const msg = MANIFEST.install_consent_messages[lang];
    assert.match(msg, /127\.0\.0\.1/);
    assert.doesNotMatch(msg, /every network interface|todas las interfaces/);
    assert.doesNotMatch(msg, /VNC password|contraseña VNC/);
  }
  const reg = JSON.parse(read("registry/add-ons.json"));
  const entry = (reg["add-ons"] || reg.addons || reg).find?.((a) => a.id === "browser");
  assert.ok(entry, "the registry lists the browser");
  assert.equal(entry.version, "1.3.12");
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
    assert.doesNotMatch(panel[k], /password/i, k);
  }
  const { NOVNC_PAGE_QUERY } = await import("../servers/gateway/apps/catalog.js");
  assert.match(NOVNC_PAGE_QUERY, /autoconnect=true/);
  assert.doesNotMatch(NOVNC_PAGE_QUERY, /password/i);
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
