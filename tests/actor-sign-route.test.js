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
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { actorSignRouter } from "../servers/gateway/routes/actor-sign.js";
import { createBotHostCallerResolver } from "../servers/gateway/bot-host-caller.js";
import {
  initGatewayActorKey, _resetActorKeyForTest, verifyActorSig, verifyBoardActorSig, verifyArtifactsActorSig,
  verifyBoardThreadActorSig, verifyPeerRelayActorSig, presignActors, _resetPresignedForTest,
  signPeerRelayActor, signBoardActor, signActor, verifyScopeActorSig, setActorKey,
} from "../scripts/pi-bots/actor-sig.mjs";

let dir, dbPath, base, srv;
const SESS = {};
// This test process plays each host's main process: the unit records are the
// injected part; the socket, fds, cgroup and start time are this process's real ones.
const CGROUP = readFileSync(`/proc/${process.pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::")).slice(3);
const hostUnit = (template, instance) => ({
  unit: `pibot-${template}@${instance}.service`, pid: process.pid, state: "active", transient: "no",
  fragment: `/etc/systemd/system/pibot-${template}@.service`, cgroup: CGROUP, envFiles: [`/etc/crow/pibot-${instance}.env`],
});
const ME = hostUnit("bridge", "alpha");
let units = [ME];
let envFiles = {}; // path -> instance config text (filled in before())
const ALL = ["bot", "board", "artifacts", "board-thread", "peer-relay"];

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  dir = mkdtempSync(join(tmpdir(), "actor-sign-"));
  dbPath = join(dir, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: dbPath }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  const d = new Database(dbPath);
  envFiles = {
    "/etc/crow/pibot-alpha.env": `CROW_HOME=${dir}\nCROW_DB_PATH=${dbPath}\n`,
    "/etc/crow/pibot-bravo.env": `CROW_DB_PATH=${join(dir, "bravo", "crow.db")}\n`,
  };
  const bot = d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, ?, ?)");
  bot.run("hank", "Hank", JSON.stringify({ gateways: [{ type: "gmail", address: "bots+hank@example.com" }] }), 1);
  bot.run("otto", "Otto", JSON.stringify({ gateways: [{ type: "discord" }] }), 1);
  bot.run("dora", "Dora", JSON.stringify({ gateways: [{ type: "gmail", address: "bots+dora@example.com" }] }), 0);
  const ins = d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, archived_at) VALUES (?, ?, ?, ?, ?)");
  for (const [name, bot, gw, thread, status, archived] of [
    ["live", "hank", "gmail", "t-100", "active", null], ["stopped", "hank", "gmail", "t-101", "stopped", null],
    ["archived", "hank", "gmail", "t-102", "active", "2026-10-01 00:00:00"], ["otto", "otto", "discord", "t-200", "active", null], ["dora", "dora", "gmail", "t-400", "active", null],
    ["card", "hank", "board", "board-card-5", "active", null], ["ghost", "ghost", "gmail", "t-300", "active", null],
    ["card6", "hank", "board", "board-card-6", "active", null],
  ]) SESS[name] = String(ins.run(bot, gw, thread, status, archived).lastInsertRowid);
  const job = d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid) VALUES (?, ?, ?, ?, ?)");
  job.run("job-run-1", "hank", "g", "running", process.pid);
  job.run("job-done-1", "hank", "g", "completed", process.pid);
  job.run("job-otto-1", "otto", "g", "running", process.pid);
  job.run("job-elsewhere-1", "hank", "g", "running", 1); // claimed by another host
  // bot_jobs.principal arrives with a later migration; this scratch DB adds it.
  if (!d.prepare("PRAGMA table_info(bot_jobs)").all().some((c) => c.name === "principal")) d.exec("ALTER TABLE bot_jobs ADD COLUMN principal TEXT");
  const pjob = d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid, card_id, principal) VALUES (?, ?, 'g', ?, ?, ?, ?)");
  pjob.run("job-own-1", "hank", "running", process.pid, null, "owner");
  pjob.run("job-own-else", "hank", "running", 1, null, "owner"); // another host's owner job
  pjob.run("job-card-1", "hank", "running", process.pid, 5, "owner");
  pjob.run("job-other-1", "hank", "running", process.pid, null, "other");
  pjob.run("job-own-done", "hank", "completed", process.pid, null, "owner"); // the owner's, but finished
  pjob.run("job-null-1", "hank", "running", process.pid, null, null); // column present, value NULL (the insert default)
  pjob.run("job-empty-1", "hank", "running", process.pid, null, "");
  pjob.run("job-caps-1", "hank", "running", process.pid, null, "OWNER");
  d.close();

  _resetActorKeyForTest();
  initGatewayActorKey();
  const app = express();
  app.use(express.json());
  app.use(actorSignRouter({
    createDbClient: () => createDbClient(dbPath),
    // cacheMs 0: each leg's unit list is the one it sets (the cache itself is covered in bot-host-caller.test.js).
    deps: {
      resolver: createBotHostCallerResolver({
        manager: "system", listUnits: async () => units, cacheMs: 0, refreshMinMs: 0,
        readEnvFile: (p) => { if (!(p in envFiles)) throw new Error("ENOENT"); return { isFile: true, uid: 0, mode: 0o100644, text: envFiles[p] }; },
      }),
      localDbPath: dbPath,
    },
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
    "a job another host claimed": { ...LIVE(), jobId: "job-elsewhere-1" },
    "a disabled bot": { botId: "dora", sessionId: SESS.dora, threadId: "t-400", gatewayType: "gmail" },
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

// Fix round 1 (security MEDIUM): an authenticated host gets signatures only for
// the bots and gateway types it hosts, from the same source it picks them from.
test("a host is bound to its own instance, its own bots and its own gateway types", async () => {
  const saved = units;
  const OTTO = { botId: "otto", sessionId: SESS.otto, threadId: "t-200", gatewayType: "discord" };
  try {
    units = [ME];
    assert.equal((await ask({ ...LIVE(), kinds: ["peer-relay"] })).status, 200, "the bridge host for its own gmail bot");
    let r = await ask({ ...OTTO, kinds: ["peer-relay"] });
    assert.equal(r.status, 403, "the bridge host for a discord bot: " + r.text);
    assert.match(r.json.error, /does not host/);

    units = [hostUnit("discord", "alpha")];
    assert.equal((await ask({ ...OTTO, kinds: ["peer-relay"] })).status, 200, "the discord host for its own discord bot");
    r = await ask({ ...LIVE(), kinds: ["peer-relay"] });
    assert.equal(r.status, 403, "the discord host for a gmail bot: " + r.text);
    assert.match(r.json.error, /does not host/);

    units = [hostUnit("gateways", "alpha")];
    assert.equal((await ask({ ...LIVE(), kinds: ["peer-relay"] })).status, 403, "the telegram/slack host does not host gmail");
    assert.equal((await ask({ botId: "hank", threadId: "job-job-run-1", gatewayType: "job", jobId: "job-run-1", kinds: ["bot"] })).status, 200,
      "it does drain jobs: one it claimed itself");

    units = [hostUnit("bridge", "bravo")];
    r = await ask({ ...LIVE(), kinds: ["peer-relay"] });
    assert.equal(r.status, 403, "host B (another instance's database) asking for host A's bot: " + r.text);
    assert.match(r.json.error, /another instance/);
  } finally { units = saved; }
});

// Final fix wave: one trimming rule for the tuple ↔ session match, the actor-sig
// MAC's own (fields trimmed on both sides), in the signing relay and the peer relay.
test("the tuple matches its session with fields trimmed on both sides, as the MAC trims them", async () => {
  const { sessionMatchesTuple } = await import("../servers/shared/signed-session.js");
  const s = { threadId: "t-100", gatewayType: "gmail" };
  assert.equal(sessionMatchesTuple(s, { threadId: " t-100 ", gatewayType: "gmail\t" }), true);
  assert.equal(sessionMatchesTuple({ threadId: " t-100", gatewayType: "gmail " }, { threadId: "t-100", gatewayType: "gmail" }), true);
  assert.equal(sessionMatchesTuple(s, { threadId: "t-101", gatewayType: "gmail" }), false);
  assert.equal(sessionMatchesTuple(s, { threadId: "t-100", gatewayType: undefined }), false);
  assert.equal(sessionMatchesTuple({ threadId: null, gatewayType: null }, {}), true);
  const r = await ask({ ...LIVE(), threadId: " t-100 ", kinds: ["peer-relay"] });
  assert.equal(r.status, 200, "a padded thread is the same thread: " + r.text);
  assert.equal(verifyPeerRelayActorSig({ ...LIVE(), sig: r.json.sigs["peer-relay"] }), true, "and signs the trimmed tuple");
});

// Adversarial review I1, superseded by the loopback mount helper (spec §4.4):
// 'service' is now a known kind, but never for a session-only turn (a Gmail,
// Telegram, Slack or Discord session): 403 for the whole request.
test("the signing relay refuses kind 'service' for a session turn, never partially", async () => {
  const r = await ask({ ...LIVE(), kinds: ["service"] });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.sigs, undefined);
  const mixed = await ask({ ...LIVE(), kinds: ["peer-relay", "service"] });
  assert.equal(mixed.status, 403, "never a partial answer: " + mixed.text);
  assert.equal(mixed.json?.sigs, undefined);
  assert.equal((await ask({ ...LIVE(), kinds: ["peer-relay"] })).status, 200, "positive control");
});

// ---- the scope kind 'service' (loopback mount helper, spec §4.4) ----

const OWNJOB = { botId: "hank", threadId: "job-job-own-1", gatewayType: "job", jobId: "job-own-1" };

test("service: an owner job this host claimed gets a v3 sig for its generic tuple, under scope j:<id>", async () => {
  const r = await ask({ ...OWNJOB, kinds: ["service", "bot"] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json.sigs).sort(), ["bot", "service"]);
  assert.equal(verifyScopeActorSig({ kind: "service", botId: "hank", scope: `j:job-own-1@${process.pid}`, threadId: OWNJOB.threadId, gatewayType: "job", sig: r.json.sigs.service }), true);
  assert.equal(verifyScopeActorSig({ kind: "service", botId: "hank", scope: "s:1", threadId: OWNJOB.threadId, gatewayType: "job", sig: r.json.sigs.service }), false);
  assert.equal(verifyActorSig({ kind: "bot", botId: "hank", threadId: OWNJOB.threadId, gatewayType: "job", sig: r.json.sigs.bot }), true);
});

test("service: an owner card job with its own board-card tuple gets a sig; another card's tuple is 403", async () => {
  const CARD = { botId: "hank", sessionId: SESS.card, threadId: "board-card-5", gatewayType: "board", jobId: "job-card-1" };
  const r = await ask({ ...CARD, kinds: ["service", "peer-relay"] });
  assert.equal(r.status, 200, r.text);
  assert.equal(verifyScopeActorSig({ kind: "service", botId: "hank", scope: `j:job-card-1@${process.pid}`, threadId: "board-card-5", gatewayType: "board", sig: r.json.sigs.service }), true,
    "the job wins over the session");
  const other = await ask({ ...CARD, sessionId: SESS.card6, threadId: "board-card-6", kinds: ["service"] });
  assert.equal(other.status, 403, "another card id: " + other.text);
  assert.equal(other.json?.sigs, undefined);
  assert.equal((await ask({ ...CARD, sessionId: SESS.card6, threadId: "board-card-6", kinds: ["peer-relay"] })).status, 200,
    "control: the session itself is live and this host's job is running");
});

test("service: refused for a NULL-principal (cron) job, a non-owner job, a finished or another host's owner job, and a job-less turn", async () => {
  for (const [name, body] of Object.entries({
    "cron job (NULL principal)": { botId: "hank", threadId: "job-job-run-1", gatewayType: "job", jobId: "job-run-1" },
    "principal 'other'": { botId: "hank", threadId: "job-job-other-1", gatewayType: "job", jobId: "job-other-1" },
    "another host's owner job": { botId: "hank", threadId: "job-job-own-else", gatewayType: "job", jobId: "job-own-else" },
    "a running claimed job, principal column present but NULL": { botId: "hank", threadId: "job-job-null-1", gatewayType: "job", jobId: "job-null-1" },
    "a running claimed job, principal ''": { botId: "hank", threadId: "job-job-empty-1", gatewayType: "job", jobId: "job-empty-1" },
    "a running claimed job, principal 'OWNER'": { botId: "hank", threadId: "job-job-caps-1", gatewayType: "job", jobId: "job-caps-1" },
    "a finished owner job": { botId: "hank", threadId: "job-job-own-done", gatewayType: "job", jobId: "job-own-done" },
    "a Gmail session": LIVE(),
    "a Gmail session with an owner job": { ...LIVE(), jobId: "job-own-1" },
    "an owner job, another job's tuple": { ...OWNJOB, threadId: "job-job-run-1" },
  })) {
    const r = await ask({ ...body, kinds: ["service"] });
    assert.equal(r.status, 403, `${name}: ${r.status} ${r.text}`);
    assert.equal(r.json?.sigs, undefined, name);
  }
  // Mixed: the whole request is refused, the v1 kind included.
  const mixed = await ask({ ...LIVE(), kinds: ["board", "service"] });
  assert.equal(mixed.status, 403, mixed.text);
  assert.equal(mixed.json?.sigs, undefined, "no partial sigs");
  const mixedCron = await ask({ botId: "hank", threadId: "job-job-run-1", gatewayType: "job", jobId: "job-run-1", kinds: ["bot", "service"] });
  assert.equal(mixedCron.status, 403, mixedCron.text);
  assert.equal(mixedCron.json?.sigs, undefined);
  assert.equal((await ask({ botId: "hank", threadId: "job-job-run-1", gatewayType: "job", jobId: "job-run-1", kinds: ["bot"] })).status, 200,
    "control: the cron job still gets its v1 kinds");
});

test("service: the two job 403 messages stay distinct", async () => {
  let r = await ask({ botId: "hank", threadId: "job-job-done-1", gatewayType: "job", jobId: "job-done-1", kinds: ["service"] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /no running job/);
  r = await ask({ botId: "hank", threadId: "job-job-own-else", gatewayType: "job", jobId: "job-own-else", kinds: ["service"] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /another host/);
});

// Adversarial review M3: a job/board-gateway session is signed only with a job this host claimed.
test("a board-gateway session is signed only for a job this host claimed", async () => {
  const CARD = { botId: "hank", sessionId: SESS.card, threadId: "board-card-5", gatewayType: "board" };
  let r = await ask({ ...CARD, kinds: ["peer-relay"] });
  assert.equal(r.status, 403, "no job: " + r.text);
  r = await ask({ ...CARD, jobId: "job-elsewhere-1", kinds: ["peer-relay"] });
  assert.equal(r.status, 403, "another host's job: " + r.text);
  r = await ask({ ...CARD, jobId: "job-run-1", kinds: ["peer-relay", "board"] });
  assert.equal(r.status, 200, "its own claimed job: " + r.text);
  assert.equal(verifyPeerRelayActorSig({ ...CARD, sig: r.json.sigs["peer-relay"] }), true);
});

// Step 7 for a scope kind: a process that holds only the v1/v2 key (setActorKey,
// as a child does) and no scope key refuses the WHOLE request with 503, even
// for an owner job it claimed; never a partial answer with the v1 kinds.
test("service: no scope key -> 503 for the whole request, no sigs", async () => {
  _resetActorKeyForTest();
  try {
    assert.equal(setActorKey("ab".repeat(32)), true, "v1/v2 key installed");
    const r = await ask({ ...OWNJOB, kinds: ["bot", "service"] });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json?.sigs, undefined, "no partial sigs");
    assert.equal((await ask({ ...OWNJOB, kinds: ["bot"] })).status, 200, "control: the v1 kind alone still signs");
  } finally {
    _resetActorKeyForTest();
    initGatewayActorKey();
  }
});
