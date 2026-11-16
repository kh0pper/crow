/**
 * Studio web layer: the WebSocket upgrade gate, the hello/state handshake, the
 * live command path, the agent HTTP API and the boot token.
 *
 * Each test boots a real http server on 127.0.0.1:0 with the studio router and
 * its upgrade handler, a real session hub on a scratch crow.db, and fake
 * dashboard-auth helpers whose answers the test controls. The WebSocket
 * clients are the root `ws` package's, so the handshake, the headers and the
 * close codes are exercised exactly as a browser would meet them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { GENERAL_LIMITER_SKIP_PREFIXES, generalLimiterSkip } from "../servers/gateway/middleware/rate-limit.js";
import { isLocalPasswordSessionOn } from "../servers/gateway/dashboard/local-session.js";
import {
  deleteLocalSetting,
  readSetting,
  setSettingsSyncManager,
  writeSetting,
} from "../servers/gateway/dashboard/settings/registry.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb, ensureAgentToken } from "../bundles/studio/server/web.js";
import { buildLayoutOwnerCheck, buildLayoutTemplate } from "../bundles/studio/server/layout-template.js";
import studioPanel from "../bundles/studio/panel/studio.js";

/** The project every song in these tests belongs to. */
const PROJECT = 21;

/** A second project, so a bot's own project and another one both exist. */
const OTHER_PROJECT = 22;

/** The bot the scope tests speak as, and its linked project. */
const BOT = "bassbot";

/** Crow's voice bot: it reads every song and writes none. */
const VOICE_BOT = "crow.voice";

/** The body every write from Crow's voice is refused with. */
const READ_ONLY = Object.freeze({
  ok: false,
  code: "read_only",
  error: "Crow's voice can read songs but not change them; ask the project's bot.",
});

/** The dashboard's own author for a command sent from a browser. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/**
 * A project ACL that allows the two projects these tests use and records every
 * audit line the hub writes. The hub maps its errors exactly as it does the real
 * module's.
 * @returns {{assertProjectExists: Function, assertCapability: Function,
 *            appendAudit: Function, audit: object[]}}
 */
function fakeAcl() {
  const projects = new Set([PROJECT, OTHER_PROJECT]);
  const audit = [];
  async function assertProjectExists(_db, projectId) {
    const id = Number(projectId);
    if (!projects.has(id)) throw new AclError(`Project #${id} not found`, "not_found");
    return { id };
  }
  async function assertCapability(db, projectId) {
    return assertProjectExists(db, projectId);
  }
  async function appendAudit(_db, row) {
    audit.push(row);
  }
  return { assertProjectExists, assertCapability, appendAudit, audit };
}

/**
 * The bot scope the panel loader injects: each bot's linked project, and which
 * bot is Crow's voice. A bot the map does not name has no project.
 * @param {{projects?: Record<string, number>, voice?: string[]}} [scope]
 */
function botScope({ projects = {}, voice = [] } = {}) {
  return {
    projectOf: async (botId) => projects[botId] ?? null,
    isVoiceBot: (botId) => voice.includes(botId),
  };
}

/** @returns {string|null} one cookie's value out of a Cookie header. */
function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The loopback addresses a local caller can arrive on. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Headers that mean a forwarder is in the path (peer-class.js's own list). */
const FORWARDING = ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"];

/**
 * The test's own `classifyPeer`: the same rule the real module applies on the
 * local branch — a loopback socket, with no forwarding header and no
 * tailscale-* header, is "local"; everything else is "remote".
 * @param {object} req
 * @returns {{via: "local"|"remote"}}
 */
function classifyPeer(req) {
  const address = String(req?.socket?.remoteAddress || "");
  const headers = req?.headers || {};
  const forwarded = FORWARDING.some((name) => {
    const value = headers[name];
    return value != null && String(value).trim() !== "";
  }) || Object.keys(headers).some((name) => name.toLowerCase().startsWith("tailscale-"));
  return { via: LOOPBACK.has(address) && !forwarded ? "local" : "remote" };
}

/** The instance-local setting key the operator's default layout template lives under. */
const LAYOUT_TEMPLATE_KEY = "studio.layout_template";

/** The instance id these tests pin: 32 hex characters, the shape the registry requires. */
const INSTANCE_ID = "0123456789abcdef0123456789abcdef";

/** The cookie value of the owner's own password session at this dashboard. */
const OWNER_SESSION = "owner-session";

/** The cookie value of a session a peer sign-in minted (scopes 'dashboard sso'). */
const SSO_SESSION = "sso-session";

/**
 * The dashboard's settings tables, created as `scripts/init-db.js` creates them,
 * for a scratch database that otherwise carries only the studio tables.
 * @param {object} db
 * @returns {Promise<void>}
 */
async function initSettingsTables(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dashboard_settings_overrides (
      key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (key, instance_id)
    );
  `);
}

/**
 * The dashboard's `oauth_tokens` table, created as `scripts/init-db.js` creates
 * it, for the owner check's own test: a dashboard session's token is stored as
 * its sha256 hash, never the value the browser holds.
 * @param {object} db
 * @returns {Promise<void>}
 */
async function initSessionTable(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token TEXT PRIMARY KEY,
      token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
      client_id TEXT NOT NULL,
      scopes TEXT DEFAULT '',
      resource TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/**
 * One dashboard session row: the cookie value's sha256 hash under the client id
 * the dashboard's own logins use, with the scopes that decide what kind of
 * session it is.
 * @param {object} db
 * @param {string} cookieValue the value the browser would hold
 * @param {string} scopes "dashboard" for a password login here, "dashboard sso"
 *   for a session a peer sign-in minted
 * @returns {Promise<void>}
 */
async function seedSession(db, cookieValue, scopes) {
  await db.execute({
    sql:
      "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) " +
      "VALUES (?, 'access', 'dashboard', ?, '2999-01-01 00:00:00')",
    args: [createHash("sha256").update(cookieValue).digest("hex"), scopes],
  });
}

/**
 * The layout-template store the panel loader injects: the SAME three calls the
 * panel loader builds (`buildLayoutTemplate`, from `server/layout-template.js`),
 * over this test's database, so what the routes wire and what a test wires
 * cannot drift apart. The instance id is pinned to a scratch data dir for the
 * length of the test, so the read and the write meet on the same rows and never
 * near a real instance's settings.
 * @param {import("node:test").TestContext} t
 * @param {object} db
 * @returns {{read: Function, write: Function, clear: Function}|null}
 */
function settingsTemplate(t, db) {
  const dataDir = mkdtempSync(join(tmpdir(), "studio-settings-"));
  writeFileSync(join(dataDir, "instance-id"), INSTANCE_ID);
  const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR };
  process.env.CROW_HOME = join(dataDir, "home");
  process.env.CROW_DATA_DIR = dataDir;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // The registry module as `buildLayoutTemplate` takes it: the three calls the
  // routes hand it are the registry's own, over this test's client.
  return buildLayoutTemplate({ readSetting, writeSetting, deleteLocalSetting }, db);
}

/**
 * A settings error the way the dashboard's registry raises one: a code of its
 * own and a message that names an absolute path or the SQL that broke.
 * @param {string} message
 * @param {string} code
 * @returns {Error}
 */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The template store of an instance whose settings registry is broken: every
 * call throws a coded error. What the route answers may contain neither the
 * path nor the SQL text.
 * @returns {{read: Function, write: Function, clear: Function}}
 */
function failingTemplate() {
  const fail = (err) => async () => {
    throw err;
  };
  return {
    read: fail(codedError("/secret/path/data/instance-id", "INSTANCE_ID_UNREADABLE")),
    write: fail(codedError("SQLITE_ERROR: no such table: dashboard_settings_overrides", "SQLITE_ERROR")),
    clear: fail(codedError("SQLITE_READONLY: attempt to write a readonly database", "SQLITE_READONLY")),
  };
}

/**
 * The dashboard's session check as the panel receives it: a request without the
 * session cookie is refused 401 before any route runs. The gateway supplies the
 * real one; this is its shape, for the one test that needs the check in front of
 * the router (every other test hands the router a pass-through, because its
 * callers are the ones a real check has already let through).
 * @param {object} req
 * @param {object} res
 * @param {Function} next
 */
function sessionGate(req, res, next) {
  if (cookieOf(req.headers.cookie, "crow_session") !== "good") {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

/**
 * The dashboard's session check as the real owner rule needs it: the cookie IS
 * the session, and it is handed on as `req.dashboardSession`, which is what
 * `isLocalPasswordSessionOn` hashes and looks up in `oauth_tokens`.
 * @param {object} req
 * @param {object} _res
 * @param {Function} next
 */
function ownerSessionGate(req, _res, next) {
  req.dashboardSession = cookieOf(req.headers.cookie, "crow_session");
  return next();
}

/**
 * Boot a gateway-shaped server for one test.
 * @param {import("node:test").TestContext} t
 * @param {{allowNetwork?: boolean, botScope?: object, settings?: boolean,
 *          auth?: Function, owner?: boolean|null, localOwner?: boolean,
 *          templateStore?: Function}} [options]
 *   `settings: true` gives the web layer the operator's default layout template,
 *   wired the way the panel loader wires it, over the dashboard's settings
 *   tables on this test's own database. `auth` is the dashboard session check the
 *   router sits behind; without one the router sees a pass-through. `owner` is
 *   what the injected owner check answers (`true` by default, the owner at this
 *   machine's dashboard; `false` the peer session the rule refuses; `null` wires
 *   no check at all, the case a caller that forgot one lands in).
 *   `localOwner: true` wires the REAL rule instead (`isLocalPasswordSessionOn`,
 *   through `buildLayoutOwnerCheck`) over this test's own `oauth_tokens` rows,
 *   and hands the router the session gate that sets `req.dashboardSession`.
 *   `templateStore(db)` replaces the store, for the cases where it fails.
 */
async function boot(
  t,
  {
    allowNetwork = true,
    botScope = null,
    settings = false,
    auth = null,
    owner = true,
    localOwner = false,
    templateStore = null,
  } = {},
) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const acl = fakeAcl();
  const crowHome = mkdtempSync(join(tmpdir(), "studio-home-"));

  // The owner check the real rule is built over: one password login at this
  // machine's dashboard, and one session a peer sign-in minted.
  let realOwnerCheck = null;
  if (localOwner) {
    await initSessionTable(db);
    await seedSession(db, OWNER_SESSION, "dashboard");
    await seedSession(db, SSO_SESSION, "dashboard sso");
    realOwnerCheck = buildLayoutOwnerCheck(isLocalPasswordSessionOn, db);
  }

  // The hub is built first and its broadcast reaches the web layer created
  // just after it, exactly as the panel loader wires the two together.
  const webRef = { web: null };
  const hub = createHub({
    db,
    acl,
    onBroadcast: (song_id, payload) => webRef.web?.broadcast(song_id, payload),
  });

  // The template store, when the test asks for one: the real settings registry
  // over tables created as the schema creates them, with the instance id
  // pinned to a scratch data dir so a run reads back exactly what it wrote. A
  // test that hands its own store gets that one instead.
  let layoutTemplate = null;
  if (templateStore) {
    await initSettingsTables(db);
    layoutTemplate = templateStore(db);
  } else if (settings) {
    await initSettingsTables(db);
    layoutTemplate = settingsTemplate(t, db);
  }

  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => allowNetwork,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer,
    },
    crowHome,
    bundleDir: null,
    botScope,
    layoutTemplate,
    // The owner check the template's writes sit behind, the way the panel
    // loader wires `isLocalPasswordSessionOn` (through `buildLayoutOwnerCheck`).
    // `owner: null` omits it.
    ...(realOwnerCheck
      ? { isOwner: realOwnerCheck }
      : owner === null
        ? {}
        : { isOwner: async () => owner === true }),
  });
  webRef.web = web;

  const app = express();
  // One test answers as a caller behind a proxy: only what the agent routes
  // read (the peer address) is replaced, and only when the test asks for it.
  app.use((req, _res, next) => {
    if (req.headers["x-studio-test-peer"] === "remote") {
      Object.defineProperty(req, "socket", { value: { remoteAddress: "100.64.20.9" }, configurable: true });
    }
    next();
  });
  // The gateway parses JSON for every route before the panel router (1 MB cap),
  // so the studio routes read `req.body` without a parser of their own.
  app.use(express.json({ limit: "1mb" }));
  app.use(web.router(auth || (localOwner ? ownerSessionGate : (_req, _res, next) => next())));

  const server = createServer(app);
  const upgrades = web.attachUpgrade(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    upgrades.close();
    try {
      server.closeAllConnections?.();
    } catch {
      // Nothing left to close.
    }
    server.close(() => resolve());
  }));

  const { port } = server.address();
  return { db, acl, hub, web, server, port, crowHome, base: `http://127.0.0.1:${port}` };
}

/** Create one song with a track and a scene, through the hub. */
async function seedSong(hub, projectId = PROJECT, title = "Session song") {
  const created = await hub.createSong({ project_id: projectId, title, author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  for (const [command, args] of [
    ["track.add", { id: "bass", name: "Bass" }],
    ["scene.add", { id: "verse", name: "Verse" }],
  ]) {
    const result = await hub.runCommand({ song_id: created.song_id, cmd_id: null, command, args, author: HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }
  return created.song_id;
}

/** Open a WebSocket to the studio path with the headers a dashboard page sends. */
function connect(t, port, { cookie = "crow_session=good; crow_csrf=csrf-ok", origin } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/studio/ws`, {
    headers: {
      Cookie: cookie,
      Origin: origin ?? `http://127.0.0.1:${port}`,
    },
  });
  t.after(() => {
    try {
      ws.terminate();
    } catch {
      // Already gone.
    }
  });
  ws.on("error", () => {
    // A test that expects an error asserts on the close code or the status.
  });
  return ws;
}

/** Resolve when the socket is open. */
async function opened(ws) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("close", () => reject(new Error("the socket closed before it opened")));
  });
}

/**
 * Collect frames from a socket and hand them back by predicate.
 * @returns {(predicate?: (msg: object) => boolean, timeoutMs?: number) => Promise<object>}
 */
function collector(ws) {
  const queue = [];
  const waiters = new Set();
  ws.on("message", (raw) => {
    queue.push(JSON.parse(String(raw)));
    for (const waiter of [...waiters]) waiter();
  });
  return (predicate = () => true, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      let timer = null;
      const check = () => {
        const at = queue.findIndex(predicate);
        if (at < 0) return false;
        const [msg] = queue.splice(at, 1);
        waiters.delete(check);
        clearTimeout(timer);
        resolve(msg);
        return true;
      };
      timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      if (!check()) waiters.add(check);
    });
}

/** Resolve with the close code the server chose. */
function closeCode(ws) {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

/**
 * Attempt an upgrade and report the HTTP status the server refused it with.
 * Never resolves for an accepted upgrade: that is a test failure, not a code.
 */
function refusedUpgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/studio/ws`, { headers });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        // Already gone.
      }
      fn(value);
    };
    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode;
      res.destroy();
      finish(resolve, status);
    });
    ws.on("open", () => finish(reject, new Error("the upgrade was accepted")));
    ws.on("error", () => {
      // unexpected-response settles first; a bare error means no answer.
    });
    const timer = setTimeout(() => finish(reject, new Error("the upgrade got no answer")), 3000);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** POST one agent command; returns the parsed body and the status. */
async function agentCommand(base, token, songId, body) {
  const response = await fetch(`${base}/api/studio/agent/songs/${songId}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-studio-token": token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * GET one agent route as the caller presents itself. A read has no body, so the
 * MCP client's author arrives in the `x-studio-author` header; without one the
 * caller is the operator's own MCP session.
 */
async function agentGet(base, token, path, authorId = null) {
  const headers = { "x-studio-token": token };
  if (authorId) headers["x-studio-author"] = authorId;
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

/** POST any other agent route (create, undo, redo). */
async function agentPost(base, token, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-studio-token": token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("upgrade without session is refused 401", async (t) => {
  const { port } = await boot(t);
  const status = await refusedUpgrade(port, { Origin: `http://127.0.0.1:${port}` });
  assert.equal(status, 401);
});

test("upgrade with tailscale-funnel-request is refused 403", async (t) => {
  const { port } = await boot(t);
  const status = await refusedUpgrade(port, {
    Cookie: "crow_session=good; crow_csrf=csrf-ok",
    Origin: `http://127.0.0.1:${port}`,
    "tailscale-funnel-request": "1",
  });
  assert.equal(status, 403);
});

test("cross-origin upgrade refused 403", async (t) => {
  const { port } = await boot(t);
  const status = await refusedUpgrade(port, {
    Cookie: "crow_session=good; crow_csrf=csrf-ok",
    Origin: "http://other.invalid",
  });
  assert.equal(status, 403);
});

test("hello without valid csrf closes 4401", async (t) => {
  const { port, hub } = await boot(t);
  const songId = await seedSong(hub);
  const ws = connect(t, port);
  const next = collector(ws);
  await opened(ws);

  const closed = closeCode(ws);
  ws.send(JSON.stringify({ type: "hello", csrf: "not-the-token", song_id: songId, client_id: "a" }));
  assert.equal(await closed, 4401);
  await Promise.resolve();
  // Nothing was sent on a refused hello.
  await assert.rejects(() => next(() => true, 200));
});

test("two clients: command from A arrives as update at B with entry.author.kind human", async (t) => {
  const { port, hub } = await boot(t);
  const songId = await seedSong(hub);

  const a = connect(t, port);
  const b = connect(t, port);
  const nextA = collector(a);
  const nextB = collector(b);
  await Promise.all([opened(a), opened(b)]);

  a.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: songId, client_id: "client-a" }));
  b.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: songId, client_id: "client-b" }));

  const stateA = await nextA((msg) => msg.type === "state");
  const stateB = await nextB((msg) => msg.type === "state");
  assert.ok(stateA.update.length > 0, "the state frame carries the encoded song");
  assert.ok(Array.isArray(stateA.history));
  assert.ok(Array.isArray(stateB.presence));

  a.send(JSON.stringify({
    type: "command",
    cmd_id: "cmd-a-1",
    command: "scene.add",
    args: { id: "chorus", name: "Chorus" },
  }));

  const result = await nextA((msg) => msg.type === "result" && msg.cmd_id === "cmd-a-1");
  assert.equal(result.ok, true, `the command was refused: ${result.error}`);

  const update = await nextB((msg) => msg.type === "update");
  assert.equal(update.entry.command, "scene.add");
  assert.equal(update.entry.author.kind, "human");
  assert.equal(update.entry.author.id, "local");
  assert.ok(update.update.length > 0, "the update frame carries a Yjs update");

  // The edit is part of the song's history and the document.
  const openedSong = await hub.openSong(songId);
  assert.ok(openedSong.snapshot.scenes.some((scene) => scene.id === "chorus"));
});

test("agent API without token 401, from non-loopback 403", async (t) => {
  const { base, crowHome } = await boot(t);
  const token = ensureAgentToken(crowHome);

  const unauthenticated = await fetch(`${base}/api/studio/agent/songs`);
  assert.equal(unauthenticated.status, 401);

  const remote = await fetch(`${base}/api/studio/agent/songs`, {
    headers: { "x-studio-token": token, "x-studio-test-peer": "remote" },
  });
  assert.equal(remote.status, 403);

  const allowed = await fetch(`${base}/api/studio/agent/songs`, {
    headers: { "x-studio-token": token },
  });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(await allowed.json()));
});

test("agent request carrying x-forwarded-for is refused 403", async (t) => {
  const { base, crowHome } = await boot(t);
  const token = ensureAgentToken(crowHome);

  // Serve proxies tailnet traffic from a loopback socket, so the address alone
  // says nothing: the forwarding header is what marks the caller as remote.
  const response = await fetch(`${base}/api/studio/agent/songs`, {
    headers: { "x-studio-token": token, "x-forwarded-for": "100.64.20.9" },
  });
  assert.equal(response.status, 403);
});

test("agent request carrying a tailscale-user-login header is refused 403", async (t) => {
  const { base, crowHome } = await boot(t);
  const token = ensureAgentToken(crowHome);

  // A Serve request names the tailnet user; a local caller never can.
  const response = await fetch(`${base}/api/studio/agent/songs`, {
    headers: { "x-studio-token": token, "tailscale-user-login": "someuser" },
  });
  assert.equal(response.status, 403);
});

test("agent command arrives at WS client tagged kind agent", async (t) => {
  const { base, port, hub, crowHome } = await boot(t);
  const songId = await seedSong(hub);
  const token = ensureAgentToken(crowHome);

  const ws = connect(t, port);
  const next = collector(ws);
  await opened(ws);
  ws.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: songId, client_id: "client-agent" }));
  await next((msg) => msg.type === "state");

  const sent = await agentCommand(base, token, songId, {
    cmd_id: "agent-1",
    command: "scene.add",
    args: { id: "intro", name: "Intro" },
    // An agent naming itself as a person is still an agent. (Its id must not
    // look like a Crow bot's `bot:<id>`, which the agent routes scope to that
    // bot's own project — see the bot scope tests at the end of this file.)
    author: { kind: "human", id: "mcp", label: "Agent (MCP)" },
  });
  assert.equal(sent.status, 200, `the agent command was refused: ${JSON.stringify(sent.body)}`);

  const update = await next((msg) => msg.type === "update");
  assert.equal(update.entry.author.kind, "agent");
  assert.equal(update.entry.author.id, "agent:mcp");
  assert.equal(update.entry.author.label, "Agent (MCP)");
});

test("an agent sending author id local can never act as the person", async (t) => {
  const { base, hub, crowHome } = await boot(t);
  const songId = await seedSong(hub);
  const token = ensureAgentToken(crowHome);

  const sent = await agentCommand(base, token, songId, {
    cmd_id: "agent-local-1",
    command: "scene.add",
    args: { id: "agent-local", name: "Agent local" },
    author: { id: "local", label: "You" },
  });
  // "agent:local" is neither the operator's MCP session nor a bot, so the
  // agent API fails closed: the song is not there for it, and nothing is written.
  assert.equal(sent.status, 404);
  const history = await hub.history(songId, { limit: 50 });
  const entries = Array.isArray(history) ? history : history.entries || [];
  assert.equal(entries.some((entry) => entry.command === "scene.add" && entry.args?.id === "agent-local"), false);
});

test("resent command with same cmd_id applies once", async (t) => {
  const { base, hub, crowHome } = await boot(t);
  const songId = await seedSong(hub);
  const token = ensureAgentToken(crowHome);
  const body = {
    cmd_id: "resent-1",
    command: "scene.add",
    args: { id: "intro", name: "Intro" },
    author: { id: "mcp", label: "Agent (MCP)" },
  };

  const first = await agentCommand(base, token, songId, body);
  const second = await agentCommand(base, token, songId, body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body, "the original result comes back");

  const history = await hub.history(songId, { limit: 50 });
  const applied = history.filter(
    (entry) => entry.command === "scene.add" && entry.args?.id === "intro",
  );
  assert.equal(applied.length, 1, "the resent command was applied once");
  assert.equal(applied[0].id, first.body.entry.id);
});

test("two hellos back to back join only the first song", async (t) => {
  const { port, hub } = await boot(t);
  const firstSong = await seedSong(hub);
  const other = await hub.createSong({ project_id: PROJECT, title: "Other song", author: HUMAN });
  assert.equal(other.ok, true, `createSong was refused: ${other.error}`);

  const ws = connect(t, port);
  const next = collector(ws);
  await opened(ws);

  // No await between them: the second hello arrives while the first is still
  // opening its song.
  ws.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: firstSong, client_id: "client-a" }));
  ws.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: other.song_id, client_id: "client-a" }));

  const state = await next((msg) => msg.type === "state");
  assert.ok(state.update.length > 0, "the first hello was answered with its song");
  const refused = await next((msg) => msg.type === "error");
  assert.equal(refused.error, "bad message");

  // The second hello joined no room: a step on that song never reaches this
  // socket, while one on the first song does. The frames arrive in the order
  // the steps ran, so a socket in both rooms is handed the wrong entry first.
  const elsewhere = await hub.runCommand({
    song_id: other.song_id,
    cmd_id: null,
    command: "scene.add",
    args: { id: "other-scene", name: "Other" },
    author: HUMAN,
  });
  assert.equal(elsewhere.ok, true, `the other song's step was refused: ${elsewhere.error}`);
  const here = await hub.runCommand({
    song_id: firstSong,
    cmd_id: null,
    command: "scene.add",
    args: { id: "first-scene", name: "First" },
    author: HUMAN,
  });
  assert.equal(here.ok, true, `the first song's step was refused: ${here.error}`);

  const update = await next((msg) => msg.type === "update");
  assert.equal(update.entry.args.id, "first-scene");
});

test("a superseded socket's close leaves the live client's presence alone", async (t) => {
  const { port, hub } = await boot(t);
  const songId = await seedSong(hub);

  const a = connect(t, port);
  const nextA = collector(a);
  await opened(a);
  a.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: songId, client_id: "shared-client" }));
  await nextA((msg) => msg.type === "state");
  a.send(JSON.stringify({ type: "focus", ref: "clip:clip-x" }));
  const presence = await nextA((msg) => msg.type === "presence");
  assert.deepEqual(presence.presence.map((entry) => entry.client_id), ["shared-client"]);

  // The same client reconnects: the server closes the old socket with 4000.
  const aClosed = closeCode(a);
  const b = connect(t, port);
  const nextB = collector(b);
  await opened(b);
  b.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: songId, client_id: "shared-client" }));
  await nextB((msg) => msg.type === "state");
  assert.equal(await aClosed, 4000, "the reconnect superseded the old socket");

  // The room no longer holds the old socket, so its close may not speak for the
  // client: the live socket's focus is still there for the agent rules to see.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const live = hub.presence(songId);
  assert.equal(live.length, 1, "the live client is still present");
  assert.equal(live[0].client_id, "shared-client");
  assert.equal(live[0].focus, "clip:clip-x");
});

const INTERNAL_TEXT = "Studio hit an internal error.";

/** What a caller is told when it runs a command only Studio itself may run. */
const STUDIO_ONLY_TEXT = "This command can only be run by Studio itself.";

/**
 * A take in the shape a recording client uploads, for the crafted `take.add`
 * requests below. `take.add` is Studio's own step, so none of these may land.
 * @returns {object}
 */
function craftedTake() {
  return {
    id: "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70",
    storage_key: "studio/song/takes/6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70.wav",
    rate: 48000,
    channels: 2,
    frames: 48000,
    offset_frames: 0,
    compensated: false,
    bpm: 120,
    recorded_at: "2026-11-02T12:00:00.000Z",
    author_label: "the operator",
    discarded: false,
  };
}

test("an internal error does not leak its message", async (t) => {
  const { base, hub, crowHome } = await boot(t);
  const token = ensureAgentToken(crowHome);
  hub.listSongs = async () => {
    throw new Error("SQLITE secret path");
  };

  const logged = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    logged.push(args);
  };
  t.after(() => {
    console.warn = realWarn;
  });

  const response = await fetch(`${base}/api/studio/agent/songs`, {
    headers: { "x-studio-token": token },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { ok: false, code: "internal", error: INTERNAL_TEXT });
  assert.equal(JSON.stringify(body).includes("SQLITE"), false, "the real message stays in the log");
  assert.ok(logged.some((args) => args[0] === "[studio]"), "the real error is logged");
});

test("a coded error this module does not answer is not repeated to the caller either", async (t) => {
  const { base, hub, crowHome } = await boot(t);
  const token = ensureAgentToken(crowHome);
  // A code outside STATUS_BY_CODE belongs to somebody else's vocabulary (the
  // settings registry's, SQLite's) and its message names a path or a query.
  hub.listSongs = async () => {
    throw Object.assign(new Error("SQLITE_ERROR: no such table: /secret/path"), { code: "SQLITE_ERROR" });
  };

  const logged = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    logged.push(args);
  };
  t.after(() => {
    console.warn = realWarn;
  });

  const response = await fetch(`${base}/api/studio/agent/songs`, {
    headers: { "x-studio-token": token },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, INTERNAL_TEXT, "the fixed sentence, not the store's own");
  const text = JSON.stringify(body);
  assert.equal(text.includes("SQLITE"), false, "the query text stays in the log");
  assert.equal(text.includes("/secret/path"), false, "and so does the path");
  assert.ok(logged.some((args) => args[0] === "[studio]"), "the real error is logged");
});

test("take.add over the agent HTTP route is refused with 403 and the studio-only message", async (t) => {
  const { base, hub, crowHome } = await boot(t);
  const songId = await seedSong(hub);
  const token = ensureAgentToken(crowHome);

  // A crafted agent request carrying a whole, valid-looking take: the hub
  // refuses the command itself, before it looks at the song or the arguments.
  const sent = await agentCommand(base, token, songId, {
    cmd_id: "take-add-agent-route",
    command: "take.add",
    args: { clip_id: "gtr-take", take: craftedTake() },
    author: { id: "mcp", label: "Agent (MCP)" },
  });

  assert.equal(sent.status, 403, `expected 403, got ${sent.status}: ${JSON.stringify(sent.body)}`);
  assert.deepEqual(sent.body, { ok: false, code: "studio_only", error: STUDIO_ONLY_TEXT });
  assert.deepEqual((await hub.openSong(songId)).snapshot.takes, {}, "the refused take wrote nothing");
});

test("take.add in a WS command frame is refused with the studio-only message, even with internal:true in the frame", async (t) => {
  const { port, hub } = await boot(t);
  const songId = await seedSong(hub);

  const ws = connect(t, port);
  const next = collector(ws);
  await opened(ws);
  ws.send(JSON.stringify({ type: "hello", csrf: "csrf-ok", song_id: songId, client_id: "client-take" }));
  await next((msg) => msg.type === "state");

  // Only the gateway process itself may say a command comes from Studio, so a
  // frame's own word on it counts for nothing.
  ws.send(JSON.stringify({
    type: "command",
    cmd_id: "take-add-ws",
    command: "take.add",
    args: { clip_id: "gtr-take", take: craftedTake() },
    internal: true,
  }));

  const result = await next((msg) => msg.type === "result");
  assert.equal(result.ok, false, `the frame was accepted: ${JSON.stringify(result)}`);
  assert.equal(result.code, "studio_only");
  assert.equal(result.error, STUDIO_ONLY_TEXT);
  assert.deepEqual((await hub.openSong(songId)).snapshot.takes, {}, "the refused take wrote nothing");
});

test("the 21st socket for one session is refused", async (t) => {
  const { port } = await boot(t);
  const sockets = [];
  for (let i = 0; i < 20; i += 1) sockets.push(connect(t, port));
  await Promise.all(sockets.map((ws) => opened(ws)));

  const status = await refusedUpgrade(port, {
    Cookie: "crow_session=good; crow_csrf=csrf-ok",
    Origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(status, 429);
});

test("the general limiter never counts the studio agent API", () => {
  assert.ok(GENERAL_LIMITER_SKIP_PREFIXES.includes("/api/studio/agent/"));
  for (const path of ["/api/studio/agent/songs", "/api/studio/agent/songs/abc/command"]) {
    assert.equal(generalLimiterSkip({ path }), true, path);
  }
  for (const path of ["/api/studio/agent", "/api/studio/agentx/songs", "/api/studio/songs"]) {
    assert.equal(generalLimiterSkip({ path }), false, path);
  }
});

test("token file is mode 0600", () => {
  const crowHome = mkdtempSync(join(tmpdir(), "studio-home-"));
  const token = ensureAgentToken(crowHome);
  assert.match(token, /^[0-9a-f]{64}$/);

  const path = join(crowHome, "studio-agent-token");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), token);
  assert.equal(ensureAgentToken(crowHome), token, "a second call reads the same file back");
});

// ---- bot project scope (the operator's rule: a bot sees only its project) --

/** The author id a Crow bot's MCP call arrives as. */
const botHeader = (botId) => `bot:${botId}`;

/** The body author the MCP layer sends for a bot. */
const botAuthor = (botId) => ({ id: botHeader(botId), label: `Bot ${botId}` });

test("a bot lists only its own project's songs", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: { [BOT]: PROJECT } }) });
  const token = ensureAgentToken(crowHome);
  const mine = await seedSong(hub, PROJECT, "Mine");
  const theirs = await seedSong(hub, OTHER_PROJECT, "Theirs");

  const listed = await agentGet(base, token, "/api/studio/agent/songs", botHeader(BOT));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((song) => song.id), [mine], "only the bot's own project");

  // Asking for another project is an empty list, never an error: the bot
  // cannot tell a project with songs from one without.
  const asked = await agentGet(
    base,
    token,
    `/api/studio/agent/songs?project_id=${OTHER_PROJECT}`,
    botHeader(BOT),
  );
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body, []);

  // The same token with no bot author is the operator's MCP session: full access.
  const operator = await agentGet(base, token, "/api/studio/agent/songs");
  assert.deepEqual(operator.body.map((song) => song.id).sort(), [mine, theirs].sort());
});

test("a bot cannot read, edit, undo or render-snapshot a song in another project (404 like a missing song)", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: { [BOT]: PROJECT } }) });
  const token = ensureAgentToken(crowHome);
  const mine = await seedSong(hub, PROJECT, "Mine");
  const theirs = await seedSong(hub, OTHER_PROJECT, "Theirs");
  const missing = "no-such-song";
  const author = botAuthor(BOT);
  /** The body the hub itself answers a song id it does not have with. */
  const absentBody = (id) => ({ ok: false, code: "not_found", error: `There is no song "${id}".` });
  const before = (await hub.openSong(theirs)).snapshot;

  // The reads: a hidden song answers exactly like a song that does not exist.
  for (const tail of ["snapshot", "history"]) {
    const hidden = await agentGet(base, token, `/api/studio/agent/songs/${theirs}/${tail}`, botHeader(BOT));
    const absent = await agentGet(base, token, `/api/studio/agent/songs/${missing}/${tail}`, botHeader(BOT));
    assert.equal(hidden.status, 404, `${tail}: a song in another project is not readable`);
    assert.equal(absent.status, 404, `${tail}: a missing song is a 404`);
    assert.deepEqual(hidden.body, absentBody(theirs), `${tail}: the body a missing song gets`);
    assert.deepEqual(absent.body, absentBody(missing), `${tail}: the body a missing song gets`);
  }

  // The writes: the same body, and nothing applied.
  const command = await agentCommand(base, token, theirs, {
    cmd_id: "bot-hidden-1",
    command: "scene.add",
    args: { id: "secret", name: "Secret" },
    author,
  });
  const commandMissing = await agentCommand(base, token, missing, {
    cmd_id: "bot-hidden-2",
    command: "scene.add",
    args: { id: "secret", name: "Secret" },
    author,
  });
  assert.equal(command.status, 404);
  assert.deepEqual(command.body, absentBody(theirs));
  assert.deepEqual(commandMissing.body, absentBody(missing));

  for (const [kind, cmd_id] of [["undo", "bot-hidden-undo"], ["redo", "bot-hidden-redo"]]) {
    const hidden = await agentPost(base, token, `/api/studio/agent/songs/${theirs}/${kind}`, {
      cmd_id,
      entry_id: "any-entry",
      author,
    });
    const absent = await agentPost(base, token, `/api/studio/agent/songs/${missing}/${kind}`, {
      cmd_id: `${cmd_id}-2`,
      entry_id: "any-entry",
      author,
    });
    assert.equal(hidden.status, 404, `${kind}: refused`);
    assert.deepEqual(hidden.body, absentBody(theirs), `${kind}: the body a missing song gets`);
    assert.deepEqual(absent.body, absentBody(missing), `${kind}: the body a missing song gets`);
  }

  const after = (await hub.openSong(theirs)).snapshot;
  assert.deepEqual(after, before, "no step landed on the other project's song");

  // The bot's own project keeps working, reads and writes alike.
  const ownSnapshot = await agentGet(base, token, `/api/studio/agent/songs/${mine}/snapshot`, botHeader(BOT));
  assert.equal(ownSnapshot.status, 200);
  assert.equal(ownSnapshot.body.project_id, PROJECT, "the snapshot names the song's own project");
  const ownHistory = await agentGet(base, token, `/api/studio/agent/songs/${mine}/history`, botHeader(BOT));
  assert.equal(ownHistory.status, 200);
  const ownCommand = await agentCommand(base, token, mine, {
    cmd_id: "bot-own-1",
    command: "scene.add",
    args: { id: "bridge", name: "Bridge" },
    author,
  });
  assert.equal(ownCommand.status, 200, `the bot's own song was refused: ${JSON.stringify(ownCommand.body)}`);
});

test("a bot cannot create a song in another project", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: { [BOT]: PROJECT } }) });
  const token = ensureAgentToken(crowHome);
  const author = botAuthor(BOT);

  const foreign = await agentPost(base, token, "/api/studio/agent/songs", {
    project_id: OTHER_PROJECT,
    title: "Sneaky",
    author,
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.ok, false);
  assert.equal(foreign.body.code, "not_found");
  assert.deepEqual(await hub.listSongs({ project_ids: [OTHER_PROJECT] }), [], "nothing was created elsewhere");

  const own = await agentPost(base, token, "/api/studio/agent/songs", {
    project_id: PROJECT,
    title: "Mine",
    author,
  });
  assert.equal(own.status, 200, `the bot's own project was refused: ${JSON.stringify(own.body)}`);
  assert.match(own.body.song_id, /^[0-9a-f-]{36}$/);
});

test("a bot with no project sees nothing", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: {} }) });
  const token = ensureAgentToken(crowHome);
  const songId = await seedSong(hub, PROJECT);
  const lonely = "lonelybot";

  const listed = await agentGet(base, token, "/api/studio/agent/songs", botHeader(lonely));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [], "a bot with no project has no songs");

  const snapshot = await agentGet(base, token, `/api/studio/agent/songs/${songId}/snapshot`, botHeader(lonely));
  assert.equal(snapshot.status, 404);
  assert.equal(snapshot.body.code, "not_found");

  const command = await agentCommand(base, token, songId, {
    cmd_id: "lonely-1",
    command: "scene.add",
    args: { id: "x", name: "X" },
    author: botAuthor(lonely),
  });
  assert.equal(command.status, 404);

  const created = await agentPost(base, token, "/api/studio/agent/songs", {
    project_id: PROJECT,
    title: "Not mine",
    author: botAuthor(lonely),
  });
  assert.equal(created.status, 404);
  const titles = (await hub.listSongs({})).map((song) => song.title);
  assert.deepEqual(titles, ["Session song"], "the bot's neighbour gained no song");
});

test("Crow's voice reads every song but cannot change one", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: {}, voice: [VOICE_BOT] }) });
  const token = ensureAgentToken(crowHome);
  const mine = await seedSong(hub, PROJECT, "Mine");
  const theirs = await seedSong(hub, OTHER_PROJECT, "Theirs");
  const author = botAuthor(VOICE_BOT);
  const before = (await hub.openSong(theirs)).snapshot;

  const listed = await agentGet(base, token, "/api/studio/agent/songs", botHeader(VOICE_BOT));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((song) => song.id).sort(), [mine, theirs].sort(), "every song");

  for (const tail of ["snapshot", "history"]) {
    const read = await agentGet(base, token, `/api/studio/agent/songs/${theirs}/${tail}`, botHeader(VOICE_BOT));
    assert.equal(read.status, 200, `the voice bot reads ${tail} of any song`);
  }

  const command = await agentCommand(base, token, theirs, {
    cmd_id: "voice-1",
    command: "scene.add",
    args: { id: "x", name: "X" },
    author,
  });
  assert.equal(command.status, 403);
  assert.deepEqual(command.body, READ_ONLY);

  for (const [kind, cmd_id] of [["undo", "voice-undo"], ["redo", "voice-redo"]]) {
    const refused = await agentPost(base, token, `/api/studio/agent/songs/${theirs}/${kind}`, {
      cmd_id,
      entry_id: "any-entry",
      author,
    });
    assert.equal(refused.status, 403, `${kind}: refused`);
    assert.deepEqual(refused.body, READ_ONLY);
  }

  const created = await agentPost(base, token, "/api/studio/agent/songs", {
    project_id: PROJECT,
    title: "Voice song",
    author,
  });
  assert.equal(created.status, 403);
  assert.deepEqual(created.body, READ_ONLY);

  const after = (await hub.openSong(theirs)).snapshot;
  assert.deepEqual(after, before, "the voice bot changed nothing");
});

test("the operator's MCP (no bot) keeps full access", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: { [BOT]: PROJECT } }) });
  const token = ensureAgentToken(crowHome);
  const theirs = await seedSong(hub, OTHER_PROJECT, "Theirs");
  const operator = { id: "mcp", label: "Agent (MCP)" };

  const listed = await agentGet(base, token, "/api/studio/agent/songs", "mcp");
  assert.deepEqual(listed.body.map((song) => song.id), [theirs]);

  const snapshot = await agentGet(base, token, `/api/studio/agent/songs/${theirs}/snapshot`, "mcp");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.project_id, OTHER_PROJECT);

  const command = await agentCommand(base, token, theirs, {
    cmd_id: "operator-1",
    command: "scene.add",
    args: { id: "intro", name: "Intro" },
    author: operator,
  });
  assert.equal(command.status, 200, `the operator's step was refused: ${JSON.stringify(command.body)}`);

  const created = await agentPost(base, token, "/api/studio/agent/songs", {
    project_id: OTHER_PROJECT,
    title: "Operator's song",
    author: operator,
  });
  assert.equal(created.status, 200, `the operator could not create a song: ${JSON.stringify(created.body)}`);
});

test("an audit line keeps a bot's bare id and files the operator's MCP as an unattributed local caller", async (t) => {
  const { base, hub, crowHome, acl } = await boot(t, { botScope: botScope({ projects: { [BOT]: PROJECT } }) });
  const token = ensureAgentToken(crowHome);
  const songId = await seedSong(hub, PROJECT);

  const bot = await agentCommand(base, token, songId, {
    cmd_id: "audit-bot-1",
    command: "scene.add",
    args: { id: "bot-scene", name: "Bot scene" },
    author: botAuthor(BOT),
  });
  assert.equal(bot.status, 200, `the bot's step was refused: ${JSON.stringify(bot.body)}`);

  const operator = await agentCommand(base, token, songId, {
    cmd_id: "audit-mcp-1",
    command: "scene.add",
    args: { id: "mcp-scene", name: "MCP scene" },
    author: { id: "mcp", label: "Agent (MCP)" },
  });
  assert.equal(operator.status, 200, `the operator's step was refused: ${JSON.stringify(operator.body)}`);

  const botRows = acl.audit.filter((row) => row.actor_type === "bot" && row.actor_id === BOT);
  assert.equal(botRows.length, 1, "the bot's step is filed under its bare bot id");
  const agentRows = acl.audit.filter((row) => row.actor_type === "local" && row.actor_id === "unknown");
  assert.equal(agentRows.length, 1, "the operator's MCP session is filed like any unattributed local caller");
  assert.ok(
    acl.audit.some((row) => row.actor_type === "local" && row.actor_id === "local"),
    "the operator's own dashboard steps stay local",
  );
  assert.equal(
    acl.audit.some((row) => String(row.actor_id ?? "").startsWith("agent:")),
    false,
    "the transport's prefix never reaches the timeline",
  );
});
test("an agent that is neither the operator's MCP nor a bot sees nothing (fail closed)", async (t) => {
  const { base, hub, crowHome } = await boot(t, { botScope: botScope({ projects: { [BOT]: PROJECT } }) });
  const token = ensureAgentToken(crowHome);
  const songId = await seedSong(hub, PROJECT);

  const listed = await agentGet(base, token, "/api/studio/agent/songs", "other");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [], "an unknown caller lists nothing");

  const snapshot = await agentGet(base, token, `/api/studio/agent/songs/${songId}/snapshot`, "other");
  assert.equal(snapshot.status, 404);

  const command = await agentCommand(base, token, songId, {
    cmd_id: "other-1",
    command: "scene.add",
    args: { id: "y", name: "Y" },
    author: { id: "other", label: "Unknown caller" },
  });
  assert.equal(command.status, 404);

  // The operator's own MCP session keeps its access.
  const operator = await agentGet(base, token, "/api/studio/agent/songs", "mcp");
  assert.equal(operator.status, 200);
  assert.equal(operator.body.length, 1);
});

// ---- the operator's default layout template ------------------------------

/** The headers the Studio page sends with a read: a dashboard session and the CSRF token. */
const PAGE_HEADERS = Object.freeze({
  cookie: "crow_session=good; crow_csrf=csrf-ok",
  "x-crow-csrf": "csrf-ok",
});

/** Those same headers, for a call that carries a JSON body. */
const JSON_HEADERS = Object.freeze({ ...PAGE_HEADERS, "content-type": "application/json" });

/**
 * The headers a caller off this machine sends with the owner's own session: the
 * test's stand-in for a peer address the owner rule can tell from this box.
 */
const OWNER_HEADERS = Object.freeze({
  cookie: `crow_session=${OWNER_SESSION}; crow_csrf=csrf-ok`,
  "x-crow-csrf": "csrf-ok",
  "x-studio-test-peer": "remote",
});
/** One default layout: the editor alone, full width, on a laptop in compose. */
const TEMPLATE = Object.freeze({
  v: 1,
  layouts: { "compose.laptop": { v: 1, shown: [{ id: "editor", size: "l" }] } },
});

/** GET the operator's default layout template. */
async function getTemplate(base, headers = PAGE_HEADERS) {
  const response = await fetch(`${base}/api/studio/layout-template`, { headers });
  return { status: response.status, body: await response.json() };
}

/** PUT one default layout template. */
async function putTemplate(base, template, headers = JSON_HEADERS) {
  const response = await fetch(`${base}/api/studio/layout-template`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ template }),
  });
  return { status: response.status, body: await response.json() };
}

/** DELETE the operator's saved default. */
async function deleteTemplate(base, headers = PAGE_HEADERS) {
  const response = await fetch(`${base}/api/studio/layout-template`, { method: "DELETE", headers });
  return { status: response.status, body: await response.json() };
}

/** Every row the template key has in the per-instance settings table. */
async function localRows(db) {
  const { rows } = await db.execute({
    sql: "SELECT key, instance_id, value FROM dashboard_settings_overrides WHERE key = ?",
    args: [LAYOUT_TEMPLATE_KEY],
  });
  return rows;
}

/** Every row the template key has in the settings table peers are emitted from. */
async function globalRows(db) {
  const { rows } = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key = ?",
    args: [LAYOUT_TEMPLATE_KEY],
  });
  return rows;
}

/** A response fake with the two properties the panel handler uses. */
function fakeRes() {
  return {
    headersSent: false,
    html: "",
    send(body) {
      this.html = String(body);
      this.headersSent = true;
    },
    type() {
      return this;
    },
  };
}

/** The dashboard layout stand-in: the body surrounded by a marker. */
function layoutFor({ content }) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>MARKER${content}</body></html>`;
}

/**
 * One song's Studio page, exactly as the panel route renders it.
 * @param {string} songId
 * @returns {Promise<string>} the page HTML
 */
async function studioSongPage(songId) {
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query: { song: songId }, headers: {} },
    res,
    { db: { async execute() { return { rows: [] }; } }, layout: layoutFor },
  );
  assert.equal(res.headersSent, true, "the panel route should have sent a page");
  return res.html;
}

test("the default layout template starts empty, round-trips and can be cleared", async (t) => {
  const { base } = await boot(t, { settings: true });

  const nothing = await getTemplate(base);
  assert.equal(nothing.status, 200);
  assert.deepEqual(nothing.body, { template: null }, "an operator who never saved one has no template");

  const saved = await putTemplate(base, TEMPLATE);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { template: TEMPLATE }, "the answer is the canonical template");

  const back = await getTemplate(base);
  assert.equal(back.status, 200);
  assert.deepEqual(back.body, saved.body, "what was saved is what comes back");

  const cleared = await deleteTemplate(base);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { template: null });
  assert.deepEqual((await getTemplate(base)).body, { template: null }, "and it is gone");
});

test("a template over 8 KB, at the wrong version or naming an unknown widget is refused and stores nothing", async (t) => {
  const { base, db } = await boot(t, { settings: true });

  const refused = [
    ["over the 8 KB cap", { v: 1, layouts: {}, pad: "x".repeat(8192) }],
    ["the wrong version", { v: 2, layouts: {} }],
    ["no layouts table", { v: 1 }],
    [
      "a widget this Studio does not have",
      { v: 1, layouts: { "compose.laptop": { v: 1, shown: [{ id: "not-a-widget", size: "m" }] } } },
    ],
    ["nothing at all", null],
  ];
  for (const [why, template] of refused) {
    const answer = await putTemplate(base, template);
    assert.equal(answer.status, 400, why);
    assert.equal(typeof answer.body.error, "string", `${why}: the caller is told why`);
  }

  assert.deepEqual((await getTemplate(base)).body, { template: null }, "nothing was kept");
  assert.deepEqual(await localRows(db), [], "and no row was written");
  assert.deepEqual(await globalRows(db), [], "in either settings table");
});

test("a template that is not exactly what this Studio saves is refused and stores nothing", async (t) => {
  const { base, db } = await boot(t, { settings: true });
  const saved = await putTemplate(base, TEMPLATE);
  assert.equal(saved.status, 200);
  const rowsBefore = await localRows(db);

  // Every one of these normalizes into something else: an unknown mode or width
  // key is dropped, an extra key disappears, an illegal size becomes a legal
  // one, a repeated id keeps only its first row, and an empty entry becomes the
  // built-in default. A value being SAVED must be refused instead.
  const refused = [
    ["a mode and width this Studio does not lay out for", { "compose.huge": { v: 1, shown: [{ id: "editor", size: "m" }] } }],
    ["an entry with a key that is not the version or the list", { "compose.laptop": { v: 1, shown: [{ id: "editor", size: "m" }], pad: 1 } }],
    ["an entry the wrong version", { "compose.laptop": { v: 2, shown: [{ id: "editor", size: "m" }] } }],
    ["an entry with no shown list", { "compose.laptop": { v: 1 } }],
    ["an entry whose shown is not a list", { "compose.laptop": { v: 1, shown: { id: "editor", size: "m" } } }],
    ["an entry that shows nothing", { "compose.laptop": { v: 1, shown: [] } }],
    ["a size this widget may not take", { "compose.laptop": { v: 1, shown: [{ id: "midi", size: "l" }] } }],
    [
      "the same widget twice",
      { "compose.laptop": { v: 1, shown: [{ id: "editor", size: "m" }, { id: "editor", size: "l" }] } },
    ],
    ["a row with a key that is not the id or the size", { "compose.laptop": { v: 1, shown: [{ id: "editor", size: "m", x: 0 }] } }],
    ["a row that is not an object", { "compose.laptop": { v: 1, shown: ["editor"] } }],
  ];
  for (const [why, layouts] of refused) {
    const answer = await putTemplate(base, { v: 1, layouts });
    assert.equal(answer.status, 400, why);
    assert.equal(typeof answer.body.error, "string", `${why}: the caller is told why`);
    assert.deepEqual(await localRows(db), rowsBefore, `${why}: the stored template is unchanged`);
  }

  // A key BESIDE the version and the layouts table: `parseTemplate` drops it,
  // so a value being saved may not carry one for the default of every song on
  // every device.
  const extra = await putTemplate(base, { v: 1, layouts: TEMPLATE.layouts, extra: "x" });
  assert.equal(extra.status, 400, "a top-level key besides v and layouts");
  assert.equal(typeof extra.body.error, "string", "the caller is told why");
  assert.deepEqual(await localRows(db), rowsBefore, "the extra key stored nothing");

  assert.deepEqual((await getTemplate(base)).body, saved.body, "what was kept is still the saved one");
});

test("a template write or clear without the CSRF header is refused", async (t) => {
  const { base, db } = await boot(t, { settings: true });
  const noCsrf = { cookie: "crow_session=good" };

  const put = await putTemplate(base, TEMPLATE, { ...noCsrf, "content-type": "application/json" });
  assert.equal(put.status, 403);
  const clear = await deleteTemplate(base, noCsrf);
  assert.equal(clear.status, 403);

  assert.deepEqual(await localRows(db), [], "nothing was written");
});

test("a template write or clear with the wrong CSRF token is refused", async (t) => {
  const { base, db } = await boot(t, { settings: true });

  // The session is there and the header is there: what is wrong is the token,
  // which is the double-submit check's whole point.
  const wrong = { ...JSON_HEADERS, "x-crow-csrf": "wrong" };
  const put = await putTemplate(base, TEMPLATE, wrong);
  assert.equal(put.status, 403);
  const clear = await deleteTemplate(base, { ...PAGE_HEADERS, "x-crow-csrf": "wrong" });
  assert.equal(clear.status, 403);

  assert.deepEqual(await localRows(db), [], "nothing was written and nothing was cleared");
});

test("an agent caller cannot change the operator's default template", async (t) => {
  const { base, db, crowHome } = await boot(t, { settings: true });
  const token = ensureAgentToken(crowHome);

  const put = await putTemplate(base, TEMPLATE, { ...JSON_HEADERS, "x-studio-token": token });
  assert.equal(put.status, 403);
  assert.equal(typeof put.body.error, "string", "the agent is told it is the operator's own");

  const clear = await deleteTemplate(base, { ...PAGE_HEADERS, "x-studio-token": token });
  assert.equal(clear.status, 403);

  assert.deepEqual(await localRows(db), [], "nothing was written and nothing was cleared");
});

test("an unauthenticated caller is refused on the template routes as on the other studio routes", async (t) => {
  const { base } = await boot(t, { settings: true, auth: sessionGate });

  const songs = await fetch(`${base}/api/studio/songs`);
  assert.equal(songs.status, 401);

  assert.equal((await getTemplate(base, {})).status, songs.status);
  assert.equal((await putTemplate(base, TEMPLATE, { "content-type": "application/json" })).status, songs.status);
  assert.equal((await deleteTemplate(base, {})).status, songs.status);
});

test("the template lands in the per-instance settings table and is never emitted to a peer", async (t) => {
  const { base, db } = await boot(t, { settings: true });
  const emitted = [];
  setSettingsSyncManager({
    feedsDisabled: false,
    emitChange: async (table, op, row) => {
      emitted.push({ table, op, row });
      return null;
    },
  });
  t.after(() => setSettingsSyncManager(null));

  const saved = await putTemplate(base, TEMPLATE);
  assert.equal(saved.status, 200);

  const local = await localRows(db);
  assert.equal(local.length, 1, "one row, in the per-instance table");
  assert.equal(local[0].key, LAYOUT_TEMPLATE_KEY);
  assert.equal(local[0].instance_id, INSTANCE_ID, "keyed by this instance");
  assert.deepEqual(JSON.parse(local[0].value), saved.body.template, "holding the canonical template");

  assert.deepEqual(await globalRows(db), [], "dashboard_settings keeps no row, so nothing can replicate");
  assert.deepEqual(emitted, [], "and no change was emitted");

  await deleteTemplate(base);
  assert.deepEqual(await localRows(db), [], "a clear removes the row rather than writing an empty one");
  assert.deepEqual(emitted, []);

  // The recorder is live, so the empty list above means the template never
  // emits: a key that IS meant to replicate takes the same path and does.
  await writeSetting(db, "unified_dashboard_enabled", "true", { scope: "global" });
  assert.equal(emitted.length, 1, "a syncable key emits");
  assert.deepEqual(await globalRows(db), [], "and the template still holds no synced row");
});

test("with no settings registry the template routes answer 503 and the page still renders", async (t) => {
  const { base } = await boot(t);

  assert.equal((await getTemplate(base)).status, 503);
  assert.equal((await putTemplate(base, TEMPLATE)).status, 503);
  assert.equal((await deleteTemplate(base)).status, 503);

  // The page is a shell the client fills in: it asks for the template at boot
  // and keeps the built-in default when the answer is not a template.
  const html = await studioSongPage("song-1");
  assert.ok(html.includes('data-role="grid-wrap"'), "the grid is on the page");
  assert.ok(html.includes('id="st-ask"'), "so is the ask box");
});

test("only the owner may change the default template, and the read stays open", async (t) => {
  const { base, db } = await boot(t, { settings: true, owner: true });

  const saved = await putTemplate(base, TEMPLATE);
  assert.equal(saved.status, 200, `the owner's own write: ${JSON.stringify(saved.body)}`);
  assert.equal((await getTemplate(base)).body.template !== null, true, "the owner's template was kept");
  assert.equal((await deleteTemplate(base)).status, 200, "the owner's own clear");
  assert.deepEqual(await localRows(db), [], "and it is gone");
});

test("a session that is not the owner is refused the template's write and clear", async (t) => {
  // The peer-minted session: `isLocalPasswordSessionOn` answers false for scopes
  // 'dashboard sso' and for a signed peer call.
  const { base, db } = await boot(t, { settings: true, owner: false });

  const put = await putTemplate(base, TEMPLATE);
  assert.equal(put.status, 403);
  assert.equal(typeof put.body.error, "string", "the caller is told it is the owner's");
  const clear = await deleteTemplate(base);
  assert.equal(clear.status, 403);

  assert.deepEqual(await localRows(db), [], "nothing was written and nothing was cleared");

  // The read is any signed-in caller's: every device a song opens on needs it.
  const read = await getTemplate(base);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { template: null });
});

test("with no owner check wired the template's write and clear are refused", async (t) => {
  const { base, db } = await boot(t, { settings: true, owner: null });

  assert.equal((await putTemplate(base, TEMPLATE)).status, 403);
  assert.equal((await deleteTemplate(base)).status, 403);
  assert.deepEqual(await localRows(db), [], "a caller that wired no check gets no write");
  assert.equal((await getTemplate(base)).status, 200, "the read is unaffected");
});

test("the owner check built over no rule allows nobody", () => {
  const db = { execute: async () => ({ rows: [] }) };
  assert.equal(buildLayoutOwnerCheck(undefined, db)({ headers: {} }), false);
  assert.equal(buildLayoutOwnerCheck(null, db)({ headers: {} }), false);
});

test("the owner check built over a rule is that rule, asked over this client", async () => {
  const db = { marker: "scratch" };
  const check = buildLayoutOwnerCheck(async (client, req) => client === db && req.owner === true, db);
  assert.equal(await check({ owner: true }), true);
  assert.equal(await check({ owner: false }), false);
});

test("the real owner rule: a local password session writes and clears, a peer-minted session is refused", async (t) => {
  const { base, db } = await boot(t, { settings: true, localOwner: true });
  const ssoHeaders = { ...OWNER_HEADERS, cookie: `crow_session=${SSO_SESSION}; crow_csrf=csrf-ok` };
  const ssoJson = { ...ssoHeaders, "content-type": "application/json" };
  const ownerJson = { ...OWNER_HEADERS, "content-type": "application/json" };

  // The owner's own session, from this machine itself: the rule takes the
  // owner's turn away from anything that starts on this box.
  const loopback = await putTemplate(base, TEMPLATE, {
    cookie: OWNER_HEADERS.cookie,
    "x-crow-csrf": OWNER_HEADERS["x-crow-csrf"],
    "content-type": "application/json",
  });
  assert.equal(loopback.status, 403, "a loopback caller is never the owner");
  assert.equal(typeof loopback.body.error, "string", "and it is told it is the owner's");
  assert.deepEqual(await localRows(db), [], "and it stored nothing");

  const saved = await putTemplate(base, TEMPLATE, ownerJson);
  assert.equal(saved.status, 200, `the owner's own write: ${JSON.stringify(saved.body)}`);
  assert.deepEqual(saved.body, { template: TEMPLATE });
  const rows = await localRows(db);
  assert.equal(rows.length, 1, "one row, keyed by this instance");
  assert.equal(rows[0].key, LAYOUT_TEMPLATE_KEY);
  assert.deepEqual(JSON.parse(rows[0].value), TEMPLATE);

  // The same requests with the session a peer sign-in minted: refused, and the
  // owner's own template is untouched.
  const peerWrite = await putTemplate(base, { v: 1, layouts: {} }, ssoJson);
  assert.equal(peerWrite.status, 403, "a peer-minted session is not the owner");
  assert.equal(typeof peerWrite.body.error, "string", "the caller is told it is the owner's");
  assert.equal(loopback.body.error, peerWrite.body.error, "the same refusal the loopback caller got");
  const peerClear = await deleteTemplate(base, ssoHeaders);
  assert.equal(peerClear.status, 403);
  assert.deepEqual(await localRows(db), rows, "nothing the refused session sent was written");

  // The read is any signed-in caller's, on either session.
  assert.equal((await getTemplate(base, ssoHeaders)).status, 200);

  const cleared = await deleteTemplate(base, OWNER_HEADERS);
  assert.equal(cleared.status, 200, `the owner's own clear: ${JSON.stringify(cleared.body)}`);
  assert.deepEqual(await localRows(db), [], "and it is gone");
});

test("a settings store that fails is answered with one fixed sentence and never its own text", async (t) => {
  const { base } = await boot(t, { templateStore: () => failingTemplate() });

  const logged = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    logged.push(args);
  };
  t.after(() => {
    console.warn = realWarn;
  });

  const read = await getTemplate(base);
  const write = await putTemplate(base, TEMPLATE);
  const clear = await deleteTemplate(base);

  for (const [why, answer] of [["read", read], ["write", write], ["clear", clear]]) {
    assert.equal(answer.status, 500, `${why}: a store that failed is not the caller's fault`);
    assert.equal(typeof answer.body.error, "string", `${why}: there is one sentence`);
    const text = JSON.stringify(answer.body);
    assert.equal(text.includes("/secret/path"), false, `${why}: the path stays in the log`);
    assert.equal(text.toLowerCase().includes("sqlite"), false, `${why}: so does the query text`);
  }
  assert.equal(read.body.error, write.body.error, "every failure gets the same sentence");
  assert.equal(write.body.error, clear.body.error, "every failure gets the same sentence");
  assert.equal(logged.filter((args) => args[0] === "[studio] default layout template:").length, 3, "each failure is logged");
});

/**
 * The fixed sentence each of the instrument library's own failure codes is
 * answered with: the library's messages are written for the log (a network
 * refusal carries the fetch error's raw text), so none of them is repeated.
 */
const LIBRARY_FAILED_TEXT = Object.freeze({
  network: "The instrument download failed; nothing was kept.",
  redirect: "The instrument download was refused; nothing was kept.",
  timeout: "The instrument download took too long; nothing was kept.",
});

test("a library failure code is answered with its fixed sentence, never the transfer's own text", async (t) => {
  const { base, hub, crowHome } = await boot(t);
  const token = ensureAgentToken(crowHome);

  const logged = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    logged.push(args);
  };
  t.after(() => {
    console.warn = realWarn;
  });

  // A refusal the library raises: the code is its own, the status the transfer's
  // (502 for a network that is down or a redirect it refused, 504 for a timeout),
  // and the message names a path and a query. The read is where a route meets it.
  for (const [code, status] of [["network", 502], ["redirect", 502], ["timeout", 504]]) {
    hub.listSongs = async () => {
      throw Object.assign(new Error(`${code}: /secret/path SQLITE_ERROR: no such table`), { code });
    };

    const response = await fetch(`${base}/api/studio/agent/songs`, {
      headers: { "x-studio-token": token },
    });
    assert.equal(response.status, status, `${code}: the code's own status`);
    const body = await response.json();
    assert.deepEqual(body, { ok: false, code, error: LIBRARY_FAILED_TEXT[code] }, `${code}: one fixed sentence`);
    const text = JSON.stringify(body);
    assert.equal(text.includes("/secret/path"), false, `${code}: the path stays in the log`);
    assert.equal(text.includes("SQLITE"), false, `${code}: so does the query text`);
  }

  assert.ok(
    logged.some((args) => args[0] === "[studio]" && String(args[1]?.message).includes("/secret/path")),
    "the real refusal is logged",
  );
});
