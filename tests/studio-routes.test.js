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
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { GENERAL_LIMITER_SKIP_PREFIXES, generalLimiterSkip } from "../servers/gateway/middleware/rate-limit.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb, ensureAgentToken } from "../bundles/studio/server/web.js";

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

/**
 * Boot a gateway-shaped server for one test.
 * @param {import("node:test").TestContext} t
 * @param {{allowNetwork?: boolean, botScope?: object}} [options]
 */
async function boot(t, { allowNetwork = true, botScope = null } = {}) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const acl = fakeAcl();
  const crowHome = mkdtempSync(join(tmpdir(), "studio-home-"));

  // The hub is built first and its broadcast reaches the web layer created
  // just after it, exactly as the panel loader wires the two together.
  const webRef = { web: null };
  const hub = createHub({
    db,
    acl,
    onBroadcast: (song_id, payload) => webRef.web?.broadcast(song_id, payload),
  });

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
  app.use(web.router((_req, _res, next) => next()));

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
