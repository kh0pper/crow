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
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb, ensureAgentToken } from "../bundles/studio/server/web.js";

/** The project every song in these tests belongs to. */
const PROJECT = 21;

/** The dashboard's own author for a command sent from a browser. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/**
 * A project ACL that allows this project and refuses nothing. The hub maps its
 * errors exactly as it does the real module's.
 */
function fakeAcl() {
  async function assertProjectExists(_db, projectId) {
    if (Number(projectId) !== PROJECT) throw new AclError(`Project #${projectId} not found`, "not_found");
    return { id: PROJECT };
  }
  async function assertCapability(db, projectId) {
    return assertProjectExists(db, projectId);
  }
  async function appendAudit() {}
  return { assertProjectExists, assertCapability, appendAudit };
}

/** @returns {string|null} one cookie's value out of a Cookie header. */
function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Boot a gateway-shaped server for one test.
 * @param {import("node:test").TestContext} t
 * @param {{allowNetwork?: boolean}} [options]
 */
async function boot(t, { allowNetwork = true } = {}) {
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
    jsonParser: express.json({ limit: "2mb" }),
    auth: {
      isAllowedNetwork: () => allowNetwork,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
    },
    crowHome,
    bundleDir: null,
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
async function seedSong(hub) {
  const created = await hub.createSong({ project_id: PROJECT, title: "Session song", author: HUMAN });
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
    // An agent naming itself as a person is still an agent.
    author: { kind: "human", id: "bot:studio-test", label: "Studio test bot" },
  });
  assert.equal(sent.status, 200, `the agent command was refused: ${JSON.stringify(sent.body)}`);

  const update = await next((msg) => msg.type === "update");
  assert.equal(update.entry.author.kind, "agent");
  assert.equal(update.entry.author.id, "bot:studio-test");
  assert.equal(update.entry.author.label, "Studio test bot");
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

test("token file is mode 0600", () => {
  const crowHome = mkdtempSync(join(tmpdir(), "studio-home-"));
  const token = ensureAgentToken(crowHome);
  assert.match(token, /^[0-9a-f]{64}$/);

  const path = join(crowHome, "studio-agent-token");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), token);
  assert.equal(ensureAgentToken(crowHome), token, "a second call reads the same file back");
});