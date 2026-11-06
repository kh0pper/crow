/**
 * Security audit N1a-9: GET /api/turn-credentials must not hand working TURN
 * relay credentials to anyone who can reach the gateway.
 *
 * The real mountPublicEndpoints() on a real express app, the real funnel
 * middleware mounted exactly where servers/gateway/index.js mounts it (before
 * every router), a scratch init-db'd crow.db with a seeded dashboard session,
 * the real bot-actor MAC signer, and the real room stores
 * (servers/sharing/rooms.js + routes/calls-rooms.js). No stubs for the three
 * verifiers — only the relay db (the .well-known handlers' table) is stubbed,
 * and those routes are not exercised here.
 *
 * Request budget: the route keeps its 10/min rate limiter, so this file makes
 * 9 requests to it. Every request here comes from one loopback address, which
 * is one bucket.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const root = mkdtempSync(join(tmpdir(), "turn-auth-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
// The TURN secret/URL are only what the handler signs with; never real values.
process.env.TURN_SECRET = "test-turn-shared-secret";
process.env.TURN_URL = "turn:crow.example.ts.net:3478?transport=udp";
const REPO = new URL("..", import.meta.url).pathname;

const { default: express } = await import("express");
const { mountPublicEndpoints } = await import("../servers/gateway/boot/public-endpoints.js");
const {
  rejectFunneledMiddleware, PUBLIC_FUNNEL_PREFIXES, effectiveFunnelPrefixes, isFunnelPublicPath,
} = await import("../servers/gateway/funnel.js");
const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
// The real room verifiers: the sharing server's singleton store (what the
// companion's /client-ws handshake validates against) and the calls rooms
// created by POST /api/rooms.
const { _activeRooms, validateRoomToken } = await import("../servers/sharing/rooms.js");
const { createCallRoom } = await import("../servers/gateway/routes/calls-rooms.js");
const { initGatewayActorKey, signActor, signBoardActor } = await import("../scripts/pi-bots/actor-sig.mjs");

const PATH = "/api/turn-credentials";
const SESSION = "turn-session-token";
// Serve's shape, from a tailnet node (servers/shared/peer-class.js "serve"):
// a loopback socket owned by a Serve uid, one overlay X-Forwarded-For, and an
// X-Forwarded-Host. This is how the operator's browser reaches the gateway.
const SERVE = serveHeaders("tester@example.invalid", "100.64.20.5");
// This process stands in for tailscaled (the gateway honours Serve's headers
// only on a socket owned by a Serve uid; tests/fixtures/serve-peer.mjs).
actAsServe();

let server = null;
let base = "";
let companionRoom = null;
let callsRoom = null;

before(async () => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const raw = new Database(join(root, "master", "crow.db"));
  raw.prepare(
    "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
  ).run(hashToken(SESSION), new Date(Date.now() + 86_400_000).toISOString());
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();

  // A companion room, in the shape sendRoomInvite() (servers/sharing/rooms.js)
  // writes it: this is the invitation URL a REMOTE guest opens.
  companionRoom = { room: "room-companion-1", token: "companion-token-1" };
  _activeRooms.set(companionRoom.room, {
    token: companionRoom.token,
    hostCrowId: "crow:host-example",
    hostName: "host",
    companionUrl: "/companion/?room=" + companionRoom.room + "&token=" + companionRoom.token,
    createdAt: Date.now(),
    participants: new Set(),
  });

  // A calls room, exactly as POST /api/rooms creates one.
  callsRoom = createCallRoom("host");

  const app = express();
  // index.js's order: the Funnel refusal is mounted before every router.
  app.use(rejectFunneledMiddleware());
  await mountPublicEndpoints(app, {
    // Only the .well-known handlers read this; nothing here touches them.
    relayDb: { execute: async () => ({ rows: [] }) },
    validateRoomToken,
  });
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  _activeRooms.delete(companionRoom?.room);
  if (server) server.close();
  rmSync(root, { recursive: true, force: true });
});

/** A TURN request. `serve` sends Tailscale Serve's headers (an operator's browser). */
async function turn({ headers = {}, serve = false, query = "" } = {}) {
  const h = serve ? { ...SERVE, ...headers } : { ...headers };
  const r = await fetch(base + PATH + query, { headers: h });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
}

const CREDENTIAL_KEYS = ["urls", "username", "credential", "ttl"];
const assertNoCredentials = (r, label) => {
  assert.equal(r.status, 401, label + ": expected 401, got " + r.status + " " + r.text);
  for (const k of CREDENTIAL_KEYS) {
    assert.equal(r.body?.[k], undefined, label + ": the 401 body must not carry " + k);
  }
  assert.equal(/credential|username|turn:/i.test(r.text), false, label + ": no credential material in the body");
};
const assertCredentials = (r, label) => {
  assert.equal(r.status, 200, label + ": expected 200, got " + r.status + " " + r.text);
  assert.equal(r.body.urls, process.env.TURN_URL);
  assert.match(String(r.body.username), /^\d{10}$/, label + ": username is the expiry stamp");
  assert.match(String(r.body.credential), /^[A-Za-z0-9+/=]{20,}$/, label + ": HMAC credential");
  assert.equal(r.body.ttl, 3600);
};

// --- 1. the finding: no credential, no relay credentials -------------------
test("unauthenticated: 401 and no TURN credentials in the body", async () => {
  assertNoCredentials(await turn(), "anonymous");
});

// --- 2. the owner's dashboard session --------------------------------------
test("a live dashboard session (an operator's browser behind Serve) → 200", async () => {
  assertCredentials(await turn({ serve: true, headers: { cookie: "crow_session=" + SESSION } }), "dashboard session");
});

// --- 3./4. a verified bot actor --------------------------------------------
test("a verified bot actor → 200; naming a bot without its signature → 401", async () => {
  initGatewayActorKey();
  const actor = { kind: "bot", botId: "hank", threadId: "gmail-42", gatewayType: "gmail" };
  const signed = await turn({
    headers: {
      "x-crow-actor-kind": "bot",
      "x-crow-actor-id": actor.botId,
      "x-crow-actor-thread": actor.threadId,
      "x-crow-actor-gateway": actor.gatewayType,
      "x-crow-actor-sig": signActor(actor),
    },
  });
  assertCredentials(signed, "signed bot actor");

  // The headers a child could always write, without the MAC: still refused.
  assertNoCredentials(await turn({ headers: { "x-crow-actor-kind": "bot", "x-crow-actor-id": actor.botId } }), "unsigned actor headers");
});

test("another kind's signature never authenticates the bot kind (MAC domain)", async () => {
  initGatewayActorKey();
  // A board signature for the same bot id, presented with NO kind header (so
  // the header guard is not what refuses it — the MAC is).
  const r = await turn({ headers: { "x-crow-actor-id": "hank", "x-crow-actor-sig": signBoardActor({ botId: "hank", jobId: "j-1" }) } });
  assertNoCredentials(r, "board-kind signature");
});

// --- 5. a room credential: the companion page ------------------------------
test("a companion room credential (?room=&token=, the invitation URL) → 200; a wrong token → 401", async () => {
  assertCredentials(
    await turn({ query: "?room=" + encodeURIComponent(companionRoom.room) + "&token=" + encodeURIComponent(companionRoom.token) }),
    "companion room",
  );
  assertNoCredentials(
    await turn({ query: "?room=" + encodeURIComponent(companionRoom.room) + "&token=wrong" }),
    "companion room, wrong token",
  );
});

// --- 6. a room credential: the calls page ----------------------------------
test("a calls room created by POST /api/rooms (?room=&token=) → 200", async () => {
  assertCredentials(
    await turn({ query: "?room=" + encodeURIComponent(callsRoom.roomCode) + "&token=" + encodeURIComponent(callsRoom.token) }),
    "calls room",
  );
});

// --- 7. Funnel ------------------------------------------------------------
test("a funneled request is refused before the route, even with a valid session", async () => {
  const r = await turn({
    serve: true,
    headers: { cookie: "crow_session=" + SESSION, "tailscale-funnel-request": "1" },
  });
  assert.equal(r.status, 403, "funnel traffic is refused: " + r.text);
  assert.equal(/credential|username|turn:/i.test(r.text), false, "no credential material leaks through the funnel refusal");
});

test("the path is NOT in the Funnel allowlist", () => {
  assert.ok(!PUBLIC_FUNNEL_PREFIXES.includes(PATH), PATH + " must never be a public Funnel entry");
  assert.equal(isFunnelPublicPath(PATH), false, PATH + " is not a funnel-public path");
  for (const p of effectiveFunnelPrefixes()) {
    const open = p.endsWith("/") ? PATH.startsWith(p) : PATH === p;
    assert.equal(open, false, `allowlist entry "${p}" would make ${PATH} funnel-reachable`);
  }
});