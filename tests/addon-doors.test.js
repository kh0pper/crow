/**
 * Add-on doors: the kiosk internal routes, Studio's agent routes and the browser
 * container door.
 *
 * The rule is the same everywhere: a request is a door request exactly when its
 * socket carries the add-on relay mark, and such a request is answered only with
 * that spawn's door token, for that add-on, method and full path. The mark is a
 * SOURCE ADDRESS, so this file makes real requests from 127.0.78.1 (Linux routes
 * every 127/8 address to lo) rather than setting a header: a header would prove
 * nothing about how the check reads the socket.
 *
 * Scratch homes and directories under mkdtemp; nothing here touches a live
 * instance.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import { clearAddonDoorToken, mintAddonDoorToken, validateAddonDoorToken } from "../servers/shared/addon-doors.js";
import { ADDON_RELAY_SOURCE_V4, isAddonRelayAddr } from "../servers/shared/bot-doors.js";
import { createKioskRuntime } from "../bundles/kiosk/server/runtime.js";
import { createKioskServer } from "../bundles/kiosk/server/server.js";
import { createHubClient } from "../bundles/studio/server/hub-client.js";
import { addonDoorsRouter } from "../servers/gateway/routes/addon-doors.js";

const T = mkdtempSync(join(tmpdir(), "addon-doors-"));
after(() => rmSync(T, { recursive: true, force: true }));

/** The relay mark a walled add-on's traffic arrives with. */
const MARK = ADDON_RELAY_SOURCE_V4;
const LOOPBACK = "127.0.0.1";
const LOOPBACK_ADDRS = new Set([LOOPBACK, "::1", "::ffff:127.0.0.1"]);

let seq = 0;
/** A fresh scratch directory. */
function scratch(name) {
  const dir = join(T, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sha256hex = (text) => createHash("sha256").update(String(text)).digest("hex");

/** The legacy announce token the stub validator's settings row holds. */
const LEGACY_ANNOUNCE = "legacy-announce-value";

/**
 * One HTTP request, optionally from a chosen source address.
 * @returns {Promise<{status: number, body: any}>}
 */
function request(port, { method = "GET", path = "/", token = null, localAddress = MARK, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      localAddress,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Listen on an ephemeral loopback port; close tears down every open connection. */
async function listen(app) {
  const server = http.createServer(app);
  const conns = new Set();
  server.on("connection", (conn) => { conns.add(conn); conn.on("close", () => conns.delete(conn)); });
  const close = server.close.bind(server);
  server.close = (cb) => { for (const conn of conns) conn.destroy(); return close(cb); };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

// --- kiosk ----------------------------------------------------------------

/**
 * The kiosk runtime on the fakes `tests/kiosk-routes.test.js` uses. The legacy
 * announce validator is a stub that follows the real one's shape: it compares
 * the sha256 of the presented token with the stored hash, so a planted hash is
 * visible on the legacy path and can be shown not to open the mark.
 */
async function kioskApp(t, { addonDoor = true } = {}) {
  const raw = createClient({ url: "file::memory:" });
  await raw.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT)");
  await raw.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('kiosk_announce_token_hash', ?)", args: [sha256hex(LEGACY_ANNOUNCE)] });
  const db = () => ({ execute: (q) => raw.execute(q), close() {} });
  const announceToken = {
    validate: async (handle, token) => {
      let stored = null;
      try {
        const r = await handle.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'kiosk_announce_token_hash'", args: [] });
        stored = r.rows?.[0]?.value ?? null;
      } catch { stored = null; }
      return typeof stored === "string" && stored !== "" && sha256hex(token) === stored;
    },
  };
  const rt = createKioskRuntime({
    Router: express.Router,
    json: express.json,
    WebSocketServer,
    isAllowedNetwork: () => true,
    csrfMiddleware: (req, res, next) => next(),
    openDb: db,
    deviceStore: { listDevices: async () => [], findDevice: async () => null, verifyToken: async () => null, normalizeKioskSettings: (x) => x },
    settings: { readSetting: async () => null, writeSetting: async () => {} },
    voice: { runVoiceTurn: async () => ({ route: "fast", timings: {} }), speakText: async () => true },
    announceToken,
    ...(addonDoor
      ? { addonDoor: { isAddonRelayed: (req) => isAddonRelayAddr(req.socket?.remoteAddress), validate: validateAddonDoorToken } }
      : {}),
    log: () => {},
  });
  const app = express();
  app.use(rt.router((req, res, next) => next()));
  const { server, port } = await listen(app);
  t.after(() => new Promise((resolve) => { rt.stop(); server.close(() => resolve()); }));
  return { rt, port, raw };
}

test("kiosk: a minted door token opens its own paths and nothing else", async (t) => {
  const { port } = await kioskApp(t);
  const token = mintAddonDoorToken("kiosk");

  const announce = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token, body: { text: "hello" } });
  assert.equal(announce.status, 200);
  const displays = await request(port, { path: "/api/kiosk/internal/displays", token });
  assert.equal(displays.status, 200);

  // A path kiosk has no door for.
  const turnCheck = await request(port, { method: "POST", path: "/api/kiosk/internal/turn-check", token, body: {} });
  assert.equal(turnCheck.status, 401);

  // A token minted for another add-on is worth nothing here.
  const studioToken = mintAddonDoorToken("studio");
  const wrongId = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: studioToken, body: { text: "x" } });
  assert.equal(wrongId.status, 401);

  // No token at all.
  const none = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", body: { text: "x" } });
  assert.equal(none.status, 401);
});

test("kiosk: the mark never accepts the legacy announce token, and loopback never accepts a door token", async (t) => {
  const { port } = await kioskApp(t);
  const legacy = LEGACY_ANNOUNCE;

  const fromMark = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: legacy, body: { text: "hi" } });
  assert.equal(fromMark.status, 401);

  const fromLoopback = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: legacy, localAddress: LOOPBACK, body: { text: "hi" } });
  assert.equal(fromLoopback.status, 200);

  const door = mintAddonDoorToken("kiosk");
  const doorOnLoopback = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: door, localAddress: LOOPBACK, body: { text: "hi" } });
  assert.equal(doorOnLoopback.status, 401);
});

test("kiosk: a token hash planted in the settings table does not open the mark", async (t) => {
  const { port, raw } = await kioskApp(t);
  const chosen = "planted-value-not-a-door-token";
  await raw.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('kiosk_announce_token_hash', ?)", args: [sha256hex(chosen)] });
  const stored = await raw.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'kiosk_announce_token_hash'", args: [] });
  assert.equal(stored.rows[0].value, sha256hex(chosen));

  const fromMark = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: chosen, body: { text: "hi" } });
  assert.equal(fromMark.status, 401);

  const fromLoopback = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: chosen, localAddress: LOOPBACK, body: { text: "hi" } });
  assert.equal(fromLoopback.status, 200);
});

test("kiosk: without the door wiring a marked socket is not loopback", async (t) => {
  const { port } = await kioskApp(t, { addonDoor: false });
  const r = await request(port, { method: "POST", path: "/api/kiosk/internal/announce", token: mintAddonDoorToken("kiosk"), body: { text: "hi" } });
  assert.equal(r.status, 403);
  assert.equal(r.body?.error, "loopback_only");
});

test("kiosk call(): the door token file is the only credential read when it is set", async () => {
  const dir = scratch("kiosk-mcp");
  const doorFile = join(dir, "door-token");
  const doorToken = "d".repeat(64);
  writeFileSync(doorFile, `  ${doorToken}\n`);

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return { ok: true, json: async () => ({ displays: [] }) };
  };
  await createKioskServer({ fetchImpl, tokenPath: join(dir, "announce-token"), doorTokenFile: doorFile })
    ._registeredTools.crow_kiosk_list_displays.handler({}, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, `Bearer ${doorToken}`);
  assert.ok(calls[0].url.endsWith("/api/kiosk/internal/displays"));

  // The announce token file is readable, and still not a fallback.
  writeFileSync(join(dir, "announce-token"), "a".repeat(64));
  const out = await createKioskServer({ fetchImpl, tokenPath: join(dir, "announce-token"), doorTokenFile: join(dir, "gone") })
    ._registeredTools.crow_kiosk_list_displays.handler({}, {});
  assert.equal(calls.length, 1, "no request is made without a door token");
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /kiosk door token missing/);
});

// --- studio ---------------------------------------------------------------

test("studio readToken: CROW_ADDON_DOOR_TOKEN_FILE is the only file read when it is set", async () => {
  const dir = scratch("studio-client");
  const tokenPath = join(dir, "studio-agent-token");
  const doorPath = join(dir, "door-token");
  writeFileSync(tokenPath, "boot-token\n");
  writeFileSync(doorPath, "door-value\n");

  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options.headers["x-studio-token"]);
    return { status: 200, json: async () => [] };
  };
  const client = createHubClient({ baseUrl: "http://studio.example.test", tokenPath, fetchImpl });
  const saved = process.env.CROW_ADDON_DOOR_TOKEN_FILE;
  try {
    process.env.CROW_ADDON_DOOR_TOKEN_FILE = doorPath;
    assert.deepEqual(await client.listSongs(), []);
    assert.deepEqual(seen, ["door-value"]);

    // A door file that cannot be read is no token at all: the boot file is not a fallback.
    process.env.CROW_ADDON_DOOR_TOKEN_FILE = join(dir, "missing");
    const out = await client.listSongs();
    assert.equal(out.code, "unavailable");
    assert.equal(seen.length, 1, "no request without a token");

    delete process.env.CROW_ADDON_DOOR_TOKEN_FILE;
    await client.listSongs();
    assert.deepEqual(seen, ["door-value", "boot-token"]);
  } finally {
    if (saved === undefined) delete process.env.CROW_ADDON_DOOR_TOKEN_FILE;
    else process.env.CROW_ADDON_DOOR_TOKEN_FILE = saved;
  }
});

/** A gateway-shaped Studio web app on a scratch home, with the door wiring the panel passes. */
async function studioApp(t) {
  // The Studio web layer reads the bundle's own dependencies (its package.json); a checkout
  // without them installed answers null, and the caller skips this case.
  const mod = await import("../bundles/studio/server/web.js").catch(() => null);
  if (!mod?.createStudioWeb) return null;
  const { createStudioWeb, ensureAgentToken } = mod;
  const crowHome = scratch("studio-home");
  const bootToken = ensureAgentToken(crowHome);
  const hub = {
    listSongs: async () => [],
    openSong: async () => ({ snapshot: {}, doc: {} }),
    runCommand: async () => ({ ok: true }),
    history: async () => [],
    undo: async () => ({ ok: true }),
    redo: async () => ({ ok: true }),
    createSong: async () => ({ ok: true, song_id: "song-1" }),
  };
  const web = createStudioWeb({
    hub,
    Router: express.Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: () => null,
      verifySession: async () => null,
      csrfTokenAccepted: () => false,
      classifyPeer: (req) => ({ via: LOOPBACK_ADDRS.has(String(req.socket?.remoteAddress || "")) ? "local" : "remote" }),
      isAddonRelayed: (req) => isAddonRelayAddr(req.socket?.remoteAddress),
      validateAddonDoor: validateAddonDoorToken,
    },
    crowHome,
    bundleDir: null,
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The dashboard's own session check, which these tests never satisfy.
  app.use(web.router((req, res) => res.status(401).json({ error: "login" })));
  const { server, port } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { port, bootToken, crowHome };
}

test("studio agent routes: a marked socket is judged by the door token alone", async (t) => {
  const app = await studioApp(t);
  if (!app) return t.skip("the studio bundle's dependencies are not installed in this checkout");
  const { port, bootToken } = app;
  const doorToken = mintAddonDoorToken("studio");

  const listed = await request(port, { path: "/api/studio/agent/songs", token: doorToken, headers: { "x-studio-token": doorToken } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, []);

  // The door is a prefix grant: a song's own agent route is inside it.
  const nested = await request(port, { path: "/api/studio/agent/songs/song-1/snapshot", token: doorToken, headers: { "x-studio-token": doorToken } });
  assert.equal(nested.status, 404, "past the guard: the stub hub has no such song");

  // The boot token is not a door token.
  const boot = await request(port, { path: "/api/studio/agent/songs", token: bootToken, headers: { "x-studio-token": bootToken } });
  assert.equal(boot.status, 401);

  // Another add-on's door token, and no token at all.
  const kioskToken = mintAddonDoorToken("kiosk");
  const wrongId = await request(port, { path: "/api/studio/agent/songs", token: kioskToken, headers: { "x-studio-token": kioskToken } });
  assert.equal(wrongId.status, 401);
  const none = await request(port, { path: "/api/studio/agent/songs" });
  assert.equal(none.status, 401);

  // A door token does not open a path outside the door: the dashboard routes keep
  // their own session check.
  const dashboard = await request(port, { path: "/api/studio/songs", token: doorToken, headers: { "x-studio-token": doorToken } });
  assert.equal(dashboard.status, 401);
});

test("studio agent routes: a local caller with the boot token is unchanged", async (t) => {
  const app = await studioApp(t);
  if (!app) return t.skip("the studio bundle's dependencies are not installed in this checkout");
  const { port, bootToken } = app;
  const listed = await request(port, { path: "/api/studio/agent/songs", token: bootToken, localAddress: LOOPBACK, headers: { "x-studio-token": bootToken } });
  assert.equal(listed.status, 200);

  const wrong = await request(port, { path: "/api/studio/agent/songs", token: "nope", localAddress: LOOPBACK, headers: { "x-studio-token": "nope" } });
  assert.equal(wrong.status, 401);

  // A door token from a plain loopback socket is not accepted either.
  const doorToken = mintAddonDoorToken("studio");
  const doorOnLoopback = await request(port, { path: "/api/studio/agent/songs", token: doorToken, localAddress: LOOPBACK, headers: { "x-studio-token": doorToken } });
  assert.equal(doorOnLoopback.status, 401);
});

// --- browser --------------------------------------------------------------

/** A gateway-shaped app over the browser door route, with a scratch home and a fake runner. */
async function browserApp(t, { env = null } = {}) {
  const crowHome = scratch("browser-home");
  mkdirSync(join(crowHome, "bundles", "browser"), { recursive: true });
  if (env !== null) writeFileSync(join(crowHome, "bundles", "browser", ".env"), env);
  const calls = [];
  const runner = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: "", stderr: "" }; };
  const app = express();
  app.use(addonDoorsRouter({ crowHome, runner }));
  const { server, port } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { port, calls, crowHome };
}

const CONTAINER_PATH = "/api/addon-doors/browser/container";
const SCRATCH_ENV = "CROW_BROWSER_CONTAINER_NAME=crow-browser-gate7\n";

test("browser door: only a marked socket, and only this spawn's browser token", async (t) => {
  const { port, calls } = await browserApp(t, { env: SCRATCH_ENV });
  const token = mintAddonDoorToken("browser");

  const plain = await request(port, { method: "POST", path: CONTAINER_PATH, token, localAddress: LOOPBACK, body: { action: "restart" } });
  assert.equal(plain.status, 403);
  assert.equal(calls.length, 0, "no docker call from a non-marked socket");

  const kioskToken = mintAddonDoorToken("kiosk");
  const wrongId = await request(port, { method: "POST", path: CONTAINER_PATH, token: kioskToken, body: { action: "restart" } });
  assert.equal(wrongId.status, 401);
  assert.equal(calls.length, 0);

  const none = await request(port, { method: "POST", path: CONTAINER_PATH, body: { action: "restart" } });
  assert.equal(none.status, 401);
  assert.equal(calls.length, 0);
});

test("browser door: restart runs docker restart with this instance's container name", async (t) => {
  const { port, calls } = await browserApp(t, { env: SCRATCH_ENV });
  const token = mintAddonDoorToken("browser");
  const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "restart" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "docker");
  assert.deepEqual(calls[0].args, ["restart", "crow-browser-gate7"]);
  assert.equal(calls[0].options.timeout, 30000);
});

test("browser door: recreate runs the fixed compose argv with the validated proxy in the env", async (t) => {
  const { port, calls, crowHome } = await browserApp(t, { env: SCRATCH_ENV });
  const token = mintAddonDoorToken("browser");
  const proxy = "http://proxy.example.test:3128";
  const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "recreate", proxy_url: proxy } });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "docker");
  assert.deepEqual(calls[0].args, [
    "compose",
    "-f",
    join(crowHome, "bundles", "browser", "docker-compose.yml"),
    "up",
    "-d",
    "--force-recreate",
  ]);
  assert.equal(calls[0].options.cwd, join(crowHome, "bundles", "browser"));
  assert.equal(calls[0].options.timeout, 90000);
  assert.equal(calls[0].options.env.CROW_BROWSER_PROXY, proxy);
  assert.equal(calls[0].options.env.CROW_HOME, crowHome);
});

test("browser door: a recreate with no proxy_url leaves the proxy variable unset", async (t) => {
  const { port, calls } = await browserApp(t, { env: SCRATCH_ENV });
  const token = mintAddonDoorToken("browser");
  const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "recreate" } });
  assert.equal(r.status, 200);
  assert.equal(Object.hasOwn(calls[0].options.env, "CROW_BROWSER_PROXY"), false);
});

test("browser door: every proxy form the browser documents is carried through", async (t) => {
  const { port, calls } = await browserApp(t, { env: SCRATCH_ENV });
  const token = mintAddonDoorToken("browser");
  const accepted = [
    "",
    "http://proxy.example.test:3128",
    "https://proxy.example.test:8443/",
    "socks5://proxy.example.test:1080",
    "socks5h://proxy.example.test:1080",
  ];
  for (const proxy of accepted) {
    const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "recreate", proxy_url: proxy } });
    assert.equal(r.status, 200, `proxy_url ${proxy || "(cleared)"} is accepted`);
  }
  assert.deepEqual(calls.map((c) => c.options.env.CROW_BROWSER_PROXY), accepted);
  for (const call of calls) assert.deepEqual(call.args.slice(0, 3), ["compose", "-f", join(call.options.cwd, "docker-compose.yml")]);
});

test("browser door: a proxy_url the browser would not accept is refused", async (t) => {
  const { port, calls } = await browserApp(t, { env: SCRATCH_ENV });
  const token = mintAddonDoorToken("browser");
  const bad = [
    "http://u:p@h:1",
    "file:///etc",
    "http://h",
    `http://h:${"1".repeat(600)}`,
    "http://host.example.test:99999",
    "http://host.example.test:3128/path",
    "http://host.example.test:3128?x=1",
    "socks5://host.example.test:1080#frag",
    "http://ho st.example.test:3128",
    "://nope",
    42,
  ];
  for (const proxy of bad) {
    const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "recreate", proxy_url: proxy } });
    assert.equal(r.status, 400, `proxy_url ${String(proxy).slice(0, 32)} is refused`);
  }
  assert.equal(calls.length, 0);

  // proxy_url is a recreate-only field, and the action is one of two words.
  const restartWithProxy = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "restart", proxy_url: "" } });
  assert.equal(restartWithProxy.status, 400);
  const unknownAction = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "down" } });
  assert.equal(unknownAction.status, 400);
  const noBody = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: [] });
  assert.equal(noBody.status, 400);
  assert.equal(calls.length, 0);
});

test("browser door: a container name docker would not accept stops the call", async (t) => {
  const { port, calls } = await browserApp(t, { env: "CROW_BROWSER_CONTAINER_NAME='crow-browser;rm -rf /'\n" });
  const token = mintAddonDoorToken("browser");
  const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "restart" } });
  assert.equal(r.status, 500);
  assert.equal(r.body?.error, "browser container name is invalid");
  assert.equal(calls.length, 0);
});

test("browser door: a docker failure is one fixed sentence, never docker's output", async (t) => {
  const crowHome = scratch("browser-fail");
  mkdirSync(join(crowHome, "bundles", "browser"), { recursive: true });
  writeFileSync(join(crowHome, "bundles", "browser", ".env"), SCRATCH_ENV);
  const app = express();
  app.use(addonDoorsRouter({ crowHome, runner: async () => { throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"); } }));
  const { server, port } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const token = mintAddonDoorToken("browser");
  const r = await request(port, { method: "POST", path: CONTAINER_PATH, token, body: { action: "restart" } });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { ok: false, error: "docker failed" });
});

// --- retirement -----------------------------------------------------------

test("a cleared door token opens nothing, on any door", async (t) => {
  const kiosk = await kioskApp(t);
  const browser = await browserApp(t, { env: SCRATCH_ENV });

  const kioskToken = mintAddonDoorToken("kiosk");
  const browserToken = mintAddonDoorToken("browser");
  assert.equal((await request(kiosk.port, { method: "POST", path: "/api/kiosk/internal/announce", token: kioskToken, body: { text: "x" } })).status, 200);
  assert.equal((await request(browser.port, { method: "POST", path: CONTAINER_PATH, token: browserToken, body: { action: "restart" } })).status, 200);

  clearAddonDoorToken("kiosk", kioskToken);
  clearAddonDoorToken("browser", browserToken);

  assert.equal((await request(kiosk.port, { method: "POST", path: "/api/kiosk/internal/announce", token: kioskToken, body: { text: "x" } })).status, 401);
  assert.equal((await request(browser.port, { method: "POST", path: CONTAINER_PATH, token: browserToken, body: { action: "restart" } })).status, 401);
  assert.equal(browser.calls.length, 1, "the second request never reached docker");
});