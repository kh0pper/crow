/**
 * Containment PR 6, end to end. A contained pi spawn (a real bubblewrap
 * sandbox with no NIC) can only reach its gateway through the spawner's egress
 * relay. Two independent layers keep it out of /internal/actor-sign:
 *
 *   1. the relay: an exact door allowlist, judged per request with an HTTP
 *      parser (a contained bot gets 403 and nothing is opened upstream);
 *   2. the mark: the relay dials the gateway from 127.0.77.1, and the gateway
 *      refuses /internal on a relayed socket before routing, so even a relay
 *      that forwards everything cannot deliver the request (404, and the
 *      signing route's database is never touched).
 *
 * The test process plays the bot host itself: the unit that names it as
 * MainPID is injected, its socket/fds/cgroup are real. A stub "pi" is what runs
 * inside the sandbox; it fetches the door and the hole and reports statuses.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import express from "express";

import { probePiSandbox, _resetPiSandboxForTest } from "../scripts/pi-bots/pi_sandbox.mjs";
import { refuseRelayedInternal } from "../servers/gateway/middleware/internal-guard.js";
import { actorSignRouter } from "../servers/gateway/routes/actor-sign.js";
import { createBotHostCallerResolver } from "../servers/gateway/bot-host-caller.js";
import { initGatewayActorKey, _resetActorKeyForTest } from "../scripts/pi-bots/actor-sig.mjs";
import { startEgressRelay } from "../scripts/pi-bots/pi_egress.mjs";

// Its own scratch instance (as tests/pi-contain-net.test.js): the contain
// tier's agent dir is door-only, so the spawn needs a providers row with a door.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const INST = mkdtempSync(join(tmpdir(), "crow-pi-sign-inst-"));
process.env.CROW_HOME = join(INST, "home");
process.env.CROW_DATA_DIR = join(INST, "data");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const DOOR_ROW = "contain-sign-test-local";
const DB_PATH = join(process.env.CROW_DATA_DIR, "crow.db");

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const skip = SANDBOX.ok && SANDBOX.pidns !== false ? false : "bubblewrap with a PID namespace unavailable";

const scratch = mkdtempSync(join(tmpdir(), "crow-pi-sign-test-"));
const saved = Object.fromEntries(["CROW_PI_CONTAIN_BOTS", "PI_CODING_AGENT_DIR", "CROW_GATEWAY_PORT", "CROW_PI_SANDBOX"].map((k) => [k, process.env[k]]));

let gw, gwPort;
let dbQueries = 0;
const CGROUP = readFileSync(`/proc/${process.pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::")).slice(3);
const ME = {
  unit: "pibot-bridge@t.service", pid: process.pid, state: "active", transient: "no",
  fragment: "/etc/systemd/system/pibot-bridge@.service", cgroup: CGROUP, envFiles: ["/etc/crow/pibot-t.env"],
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const [{ default: Database }] = await Promise.all([import("better-sqlite3")]);
  const conn = new Database(DB_PATH);
  try {
    conn.prepare("INSERT OR REPLACE INTO providers (id, base_url, models, host, disabled, bundle_id) VALUES (?, ?, ?, 'local', 0, ?)")
      .run(DOOR_ROW, "http://127.0.0.1:18299/v1", JSON.stringify([{ id: "m" }]), "contain-sign-test-bundle");
  } finally { conn.close(); }

  _resetActorKeyForTest();
  initGatewayActorKey(); // the per-boot key the router signs with (stub work never reaches it)
  const app = express();
  app.use(express.json());
  app.use(refuseRelayedInternal);
  app.use(actorSignRouter({
    // Stub DB: no bot rows, so a request that gets THROUGH is answered by the
    // route itself (403 unknown bot) after exactly one query. A relayed request
    // must not even get that far.
    createDbClient: () => ({ execute: async () => { dbQueries++; return { rows: [] }; }, close() {} }),
    deps: {
      resolver: createBotHostCallerResolver({
        manager: "system", listUnits: async () => [ME], cacheMs: 0, refreshMinMs: 0,
        readEnvFile: () => ({ isFile: true, uid: 0, mode: 0o100644, text: `CROW_DB_PATH=${DB_PATH}\n` }),
      }),
      localDbPath: DB_PATH,
    },
  }));
  app.get("/board/mcp", (_req, res) => res.json({ ok: true }));
  gw = createServer(app);
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  gwPort = gw.address().port;
});

after(async () => {
  gw?.closeAllConnections?.();
  await new Promise((r) => gw.close(() => r()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(scratch, { recursive: true, force: true });
  rmSync(INST, { recursive: true, force: true });
});

/** A bot's side of the relay: the PORT line, then one raw request. */
function relayRequest(sockPath, port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const c = connect(sockPath);
    let buf = "";
    c.on("connect", () => {
      const head = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n`
        + (body === null ? "" : `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`)
        + "\r\n" + (body === null ? "" : body);
      c.write(`PORT ${port}\n` + head);
    });
    c.on("data", (d) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (!m) return;
      const end = buf.indexOf("\r\n\r\n");
      const cl = Number((/\r\ncontent-length:\s*(\d+)/i.exec(buf) || [])[1] || 0);
      if (end < 0 || buf.length < end + 4 + cl) return;
      try { c.destroy(); } catch {}
      resolve({ status: Number(m[1]), body: buf.slice(end + 4, end + 4 + cl) });
    });
    c.on("error", reject);
    setTimeout(() => { try { c.destroy(); } catch {} reject(new Error("no response: " + JSON.stringify(buf))); }, 5000).unref?.();
  });
}

const SIGN_BODY = JSON.stringify({ botId: "t", sessionId: "1", threadId: "t-1", gatewayType: "gmail", kinds: ["bot"] });

test("integration: inside a real sandbox the relay refuses /internal and a door still works", { skip, timeout: 60000 }, async () => {
  process.env.CROW_GATEWAY_PORT = String(gwPort);
  process.env.CROW_PI_CONTAIN_BOTS = "net-sign-test-bot";
  delete process.env.CROW_PI_SANDBOX;
  const agent = join(scratch, "agent"); mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "settings.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agent;
  const session = join(scratch, "session"); mkdirSync(join(session, "sessions"), { recursive: true });
  const stub = join(scratch, "stub-pi.mjs");
  writeFileSync(stub, `
const P = JSON.parse(process.env.CROW_TEST_DOORS);
const ask = async (url, init) => { try { const r = await fetch(url, init); const text = await r.text(); return { status: r.status, body: text }; } catch (e) { return { status: "ERR", body: String((e && e.message) || e) }; } };
const base = "http://127.0.0.1:" + P.gw;
const report = {
  internal: await ask(base + "/internal/actor-sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(P.body) }),
  board: await ask(base + "/board/mcp"),
};
process.stdout.write(JSON.stringify({ type: "report", ...report }) + "\\n");
process.stdin.resume();
`);
  const queriesBefore = dbQueries;
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const pi = new PiRpc({
    def: {
      bot_id: "net-sign-test-bot", permission_policy: { bash: "deny", write_paths: [] },
      spawn_env: { CROW_TEST_DOORS: JSON.stringify({ gw: gwPort, body: JSON.parse(SIGN_BODY) }) },
    },
    sessionDir: session, resolved: { provider: DOOR_ROW, model: "m", key: DOOR_ROW + "/m" },
    nodeBin: process.execPath, cliPath: stub,
  });
  try {
    assert.match(pi.sandboxTier, /^contain/);
    const r = await pi.waitFor((m) => m.type === "report", 30000, "report");
    assert.equal(r.internal.status, 403, "the relay refuses /internal/actor-sign, from inside a real sandbox");
    // The RELAY's own body, not the gateway's 404: this proves which layer
    // answered, without which a relay that forwarded the request and a gateway
    // that refused it look the same from in here.
    assert.deepEqual(JSON.parse(r.internal.body), { error: "forbidden" }, "the relay's own refusal body");
    assert.equal(dbQueries, queriesBefore, "the signing route's database was never queried");
    assert.equal(r.board.status, 200, "a door from the allowlist still works from inside the sandbox");
  } finally {
    await pi.close();
  }
});

test("the gateway guard refuses /internal on a relayed socket (doorFilter off), and the route is live otherwise", async () => {
  // The route is live: a plain loopback caller gets the route's own answer
  // (403 unknown bot from the stub DB), not a 404 from anywhere.
  const direct = await fetch(`http://127.0.0.1:${gwPort}/internal/actor-sign`, {
    method: "POST", headers: { "content-type": "application/json" }, body: SIGN_BODY,
  });
  assert.equal(direct.status, 403);
  assert.match(await direct.text(), /unknown bot/);
  const queriesBefore = dbQueries;
  assert.ok(queriesBefore >= 1, "the route queried the (stub) database");

  // The same request through a relay that does NOT filter doors: the socket
  // carries the mark, so the gateway refuses it before routing and the route's
  // database is never touched.
  const relay = await startEgressRelay({
    dir: mkdtempSync(join(tmpdir(), "crow-door-open-")), botId: "net-sign-relay",
    gatewayPort: gwPort, doorFilter: false, log: () => {},
  });
  try {
    const hole = await relayRequest(relay.socketPath, gwPort, "POST", "/internal/actor-sign", SIGN_BODY);
    assert.equal(hole.status, 404, "the gateway layer refuses a relayed socket on /internal");
    assert.deepEqual(JSON.parse(hole.body), { error: "not found" }, "the guard's own answer, not Express's 404 page");
    assert.equal(dbQueries, queriesBefore, "the signing route's database was never queried");
    const door = await relayRequest(relay.socketPath, gwPort, "GET", "/board/mcp");
    assert.equal(door.status, 200, "the same relayed socket still reaches a door");
  } finally {
    await relay.close();
  }
});