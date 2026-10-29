/**
 * Item 46 PR-B (B6): the loopback signing relay a key-less bot host
 * (pibot-bridge@, pibot-gateways@, pibot-discord@) asks for its turn's actor
 * signatures. The real router on a bare express app, a fresh init-db
 * database, the real per-boot key. The caller check is the REAL resolver
 * (real /proc): this test process plays the bot host's main process, named as
 * a unit's MainPID through the injected unit list only.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { actorSignRouter } from "../servers/gateway/routes/actor-sign.js";
import { createBotHostCallerResolver } from "../servers/gateway/bot-host-caller.js";
import {
  initGatewayActorKey, _resetActorKeyForTest, verifyActorSig, verifyBoardActorSig, verifyArtifactsActorSig,
  verifyBoardThreadActorSig, verifyPeerRelayActorSig, verifyServiceActorSig, presignActors, _resetPresignedForTest,
  signPeerRelayActor, signBoardActor, signActor,
} from "../scripts/pi-bots/actor-sig.mjs";

let dir, dbPath, base, srv;
const SESS = {};
const ME = { unit: "pibot-bridge@alpha.service", pid: process.pid, state: "activating" };
let units = [ME];
const ALL = ["bot", "board", "artifacts", "board-thread", "peer-relay", "service"];

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  dir = mkdtempSync(join(tmpdir(), "actor-sign-"));
  dbPath = join(dir, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: dbPath }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  const d = new Database(dbPath);
  d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?, ?, ?)").run("hank", "Hank", "{}");
  d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?, ?, ?)").run("otto", "Otto", "{}");
  const ins = d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, archived_at) VALUES (?, ?, ?, ?, ?)");
  for (const [name, bot, gw, thread, status, archived] of [
    ["live", "hank", "gmail", "t-100", "active", null], ["stopped", "hank", "gmail", "t-101", "stopped", null],
    ["archived", "hank", "gmail", "t-102", "active", "2026-10-01 00:00:00"], ["otto", "otto", "gmail", "t-200", "active", null],
    ["card", "hank", "board", "board-card-5", "active", null], ["ghost", "ghost", "gmail", "t-300", "active", null],
  ]) SESS[name] = String(ins.run(bot, gw, thread, status, archived).lastInsertRowid);
  const job = d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status) VALUES (?, ?, ?, ?)");
  job.run("job-run-1", "hank", "g", "running");
  job.run("job-done-1", "hank", "g", "completed");
  job.run("job-otto-1", "otto", "g", "running");
  d.close();

  _resetActorKeyForTest();
  initGatewayActorKey();
  const app = express();
  app.use(express.json());
  app.use(actorSignRouter({
    createDbClient: () => createDbClient(dbPath),
    // cacheMs 0: each leg's unit list is the one it sets (the cache itself is covered in bot-host-caller.test.js).
    deps: { resolver: createBotHostCallerResolver({ listUnits: async () => units, cacheMs: 0, refreshMinMs: 0 }) },
  }));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  srv?.closeAllConnections?.();
  await new Promise((r) => srv.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const LIVE = () => ({ botId: "hank", sessionId: SESS.live, threadId: "t-100", gatewayType: "gmail" });

async function ask(body, headers = {}) {
  const r = await fetch(base + "/internal/actor-sign", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

function captureLogs() {
  const lines = [];
  const orig = { e: console.error, w: console.warn, l: console.log };
  console.error = console.warn = console.log = (...a) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.error = orig.e; console.warn = orig.w; console.log = orig.l; } };
}

test("a bot host's main process gets every kind for a live session; only sigs come back, and each verifies", async () => {
  const cap = captureLogs();
  let r;
  try { r = await ask({ ...LIVE(), jobId: "job-run-1", kinds: ALL }); } finally { cap.restore(); }
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ["sigs"], "the response is only sigs");
  assert.deepEqual(Object.keys(r.json.sigs).sort(), [...ALL].sort());
  const t = LIVE();
  const s = r.json.sigs;
  assert.equal(verifyActorSig({ kind: "bot", botId: "hank", threadId: t.threadId, gatewayType: t.gatewayType, sig: s.bot }), true);
  assert.equal(verifyBoardActorSig({ botId: "hank", jobId: "job-run-1", sig: s.board }), true);
  assert.equal(verifyArtifactsActorSig({ ...t, sig: s.artifacts }), true);
  assert.equal(verifyBoardThreadActorSig({ ...t, sig: s["board-thread"] }), true);
  assert.equal(verifyPeerRelayActorSig({ ...t, sig: s["peer-relay"] }), true);
  assert.equal(verifyServiceActorSig({ ...t, sig: s.service }), true);
  for (const l of cap.lines) for (const sig of Object.values(s)) assert.ok(!l.includes(sig), "no signature in a log line");
});

test("end to end: presignActors from this host fills the cache with exactly the gateway's signatures", async () => {
  // One process plays both sides: the gateway signs with its key; then the key
  // goes away and the same process, as the key-less host, signs from its cache.
  const want = signPeerRelayActor(LIVE());
  const wantBoard = signBoardActor({ botId: "hank" });
  _resetPresignedForTest();
  assert.equal(await presignActors({ gatewayUrl: base, ...LIVE(), kinds: ["peer-relay", "board"] }), true);
  _resetActorKeyForTest();
  try {
    assert.equal(signPeerRelayActor(LIVE()), want);
    assert.equal(signBoardActor({ botId: "hank" }), wantBoard);
    assert.equal(signPeerRelayActor({ ...LIVE(), sessionId: SESS.card }), null, "exact tuple only");
  } finally {
    _resetPresignedForTest();
    // The gateway again (a fresh key: earlier sigs no longer verify, which no later leg relies on).
    initGatewayActorKey();
  }
  // The relay's own response for the same tuple verifies under the gateway key it signs with.
  const r = await ask({ ...LIVE(), kinds: ["peer-relay"] });
  assert.equal(verifyPeerRelayActorSig({ ...LIVE(), sig: r.json.sigs["peer-relay"] }), true);
});

test("refused: a caller that is not a bot host unit's main process", async () => {
  const saved = units;
  try {
    units = [{ ...ME, pid: process.ppid }];
    const cap = captureLogs();
    let r1, r2;
    try { r1 = await ask({ ...LIVE(), kinds: ["peer-relay"] }); r2 = await ask({ ...LIVE(), kinds: ["peer-relay"] }); } finally { cap.restore(); }
    assert.equal(r1.status, 403, r1.text);
    assert.equal(r1.json.sigs, undefined);
    assert.equal(r2.status, 403);
    assert.equal(cap.lines.filter((l) => l.includes("[actor-sign] refused a caller")).length, 1, "logged once per hour: " + cap.lines.join("\n"));
    units = [{ ...ME, unit: "crow-gateway.service" }];
    assert.equal((await ask({ ...LIVE(), kinds: ["peer-relay"] })).status, 403, "the gateway's own unit is not a bot host");
  } finally { units = saved; }
  assert.equal((await ask({ ...LIVE(), kinds: ["peer-relay"] })).status, 200, "positive control");
});

test("refused (404): a request that is not a plain loopback one", async () => {
  const r = await ask({ ...LIVE(), kinds: ["peer-relay"] }, { "X-Forwarded-For": "100.64.20.7" });
  assert.equal(r.status, 404, r.text);
  assert.equal(r.json?.sigs, undefined);
});

test("refused: an unknown bot, another bot's session, a dead session, a thread the session is not", async () => {
  const cases = {
    "unknown bot": { botId: "ghost", sessionId: SESS.ghost, threadId: "t-300", gatewayType: "gmail" },
    "bad bot id": { ...LIVE(), botId: "../etc" },
    "another bot's session": { ...LIVE(), sessionId: SESS.otto, threadId: "t-200" },
    "stopped session": { ...LIVE(), sessionId: SESS.stopped, threadId: "t-101" },
    "archived session": { ...LIVE(), sessionId: SESS.archived, threadId: "t-102" },
    "no such session": { ...LIVE(), sessionId: "999999" },
    "another thread": { ...LIVE(), threadId: "t-999" },
    "another gateway": { ...LIVE(), gatewayType: "discord" },
    "a job that is not running": { ...LIVE(), jobId: "job-done-1" },
    "another bot's job": { ...LIVE(), jobId: "job-otto-1" },
  };
  for (const [name, body] of Object.entries(cases)) {
    const r = await ask({ ...body, kinds: ["peer-relay", "bot"] });
    assert.ok(r.status === 403 || r.status === 400, `${name}: ${r.status} ${r.text}`);
    assert.equal(r.json?.sigs, undefined, name);
  }
  assert.equal((await ask({ ...LIVE(), kinds: ["peer-relay", "bot"] })).status, 200, "positive control");
});

test("a generic job (no session) gets v1 kinds for its job tuple only; session kinds need a session", async () => {
  const job = { botId: "hank", threadId: "job-job-run-1", gatewayType: "job", jobId: "job-run-1" };
  const r = await ask({ ...job, kinds: ["bot", "board"] });
  assert.equal(r.status, 200, r.text);
  assert.equal(verifyActorSig({ kind: "bot", botId: "hank", threadId: job.threadId, gatewayType: "job", sig: r.json.sigs.bot }), true);
  assert.equal(verifyBoardActorSig({ botId: "hank", jobId: "job-run-1", sig: r.json.sigs.board }), true);
  assert.equal((await ask({ ...job, kinds: ["peer-relay"] })).status, 400);
  assert.equal((await ask({ ...job, threadId: "job-other", kinds: ["bot"] })).status, 403, "the job tuple is fixed");
  assert.equal((await ask({ botId: "hank", kinds: ["bot"] })).status, 403, "neither a session nor a job");
});

test("malformed requests are 400 and sign nothing", async () => {
  for (const body of [{ ...LIVE(), kinds: [] }, { ...LIVE(), kinds: ["bogus"] }, { ...LIVE() }, { ...LIVE(), kinds: "bot" }, { ...LIVE(), sessionId: "0", kinds: ["bot"] }]) {
    const r = await ask(body);
    assert.equal(r.status, 400, JSON.stringify(body) + " " + r.text);
  }
  const g = await fetch(base + "/internal/actor-sign");
  assert.equal(g.status, 404, "POST only");
});

test("without a key in the gateway the relay signs nothing (503)", async () => {
  _resetActorKeyForTest();
  try {
    const r = await ask({ ...LIVE(), kinds: ["peer-relay"] });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json?.sigs, undefined);
  } finally { initGatewayActorKey(); }
  assert.equal(signActor({ kind: "bot", botId: "x" }) !== null, true);
});
