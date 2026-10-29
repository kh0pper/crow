// Loopback mount helper (spec §2.1, §4.2): resolveRunningJob and
// resolveSignedScope in servers/shared/signed-session.js, over a fresh
// init-db database. bot_jobs.principal does not exist on main (a later
// migration adds it): one database runs without it, one with it added here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { resolveRunningJob, resolveSignedScope, SCOPE_REF_RE } from "../servers/shared/signed-session.js";
import { SCOPE_RE } from "../scripts/pi-bots/actor-sig.mjs";

let dir, plainPath, withPath, plain, withP;
const SESS = {};

before(() => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  dir = mkdtempSync(join(tmpdir(), "signed-scope-"));
  plainPath = join(dir, "plain.db");
  withPath = join(dir, "with.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: plainPath }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  const seed = (p, withPrincipal) => {
    const d = new Database(p);
    const has = d.prepare("PRAGMA table_info(bot_jobs)").all().some((c) => c.name === "principal");
    if (withPrincipal && !has) d.exec("ALTER TABLE bot_jobs ADD COLUMN principal TEXT");
    if (!withPrincipal && has) d.exec("ALTER TABLE bot_jobs DROP COLUMN principal"); // genuinely lacks it
    const bot = d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?, ?, ?, 1, ?)");
    bot.run("hank", "Hank", "{}", 42);
    bot.run("otto", "Otto", "{}", null);
    const ins = d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, archived_at, project_id) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [name, b, gw, thread, status, archived, proj] of [
      ["live", "hank", "gmail", "t-100", "active", null, 7], ["stopped", "hank", "gmail", "t-101", "stopped", null, null],
      ["done", "hank", "gmail", "t-103", "done", null, null], ["archived", "hank", "gmail", "t-102", "active", "2026-10-01 00:00:00", null],
      ["otto", "otto", "discord", "t-200", "active", null, null], ["ghost", "ghost", "gmail", "t-300", "active", null, null],
    ]) SESS[name] = String(ins.run(b, gw, thread, status, archived, proj).lastInsertRowid);
    const cols = withPrincipal ? "(job_id, bot_id, goal, status, worker_pid, card_id, principal)" : "(job_id, bot_id, goal, status, worker_pid, card_id)";
    const job = d.prepare(`INSERT INTO bot_jobs ${cols} VALUES (?, ?, 'g', ?, ?, ?${withPrincipal ? ", ?" : ""})`);
    for (const [id, b, status, pid, card, principal] of [
      ["job-own-1", "hank", "running", 4242, null, "owner"], ["job-cron-1", "hank", "running", 4242, null, null],
      ["job-card-1", "hank", "running", 4242, 5, "owner"], ["job-fin-1", "hank", "completed", 4242, null, "owner"],
      ["job-otto-1", "otto", "running", 4242, null, "owner"],
    ]) job.run(...[id, b, status, pid, card, ...(withPrincipal ? [principal] : [])]);
    d.close();
  };
  copyFileSync(plainPath, withPath);
  seed(plainPath, false);
  seed(withPath, true);
  plain = createDbClient(plainPath);
  withP = createDbClient(withPath);
});

after(() => {
  try { plain?.close(); } catch {}
  try { withP?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("resolveRunningJob: a running job of that bot, with its card and principal", async () => {
  assert.deepEqual(await resolveRunningJob(withP, { botId: "hank", jobId: "job-own-1" }),
    { jobId: "job-own-1", botId: "hank", cardId: null, principal: "owner", workerPid: 4242 });
  assert.deepEqual(await resolveRunningJob(withP, { botId: "hank", jobId: "job-card-1", workerPid: 4242 }),
    { jobId: "job-card-1", botId: "hank", cardId: 5, principal: "owner", workerPid: 4242 });
  assert.equal((await resolveRunningJob(withP, { botId: "hank", jobId: "job-cron-1" })).principal, null, "NULL principal stays null");
});

test("resolveRunningJob: null for a finished job, another bot, another worker, bad input, a failed read", async () => {
  assert.equal(await resolveRunningJob(withP, { botId: "hank", jobId: "job-fin-1" }), null, "finished");
  assert.equal(await resolveRunningJob(withP, { botId: "hank", jobId: "job-otto-1" }), null, "another bot's");
  assert.equal(await resolveRunningJob(withP, { botId: "hank", jobId: "job-own-1", workerPid: 1 }), null, "another worker");
  assert.equal(await resolveRunningJob(withP, { botId: "hank", jobId: "job-nope" }), null);
  for (const bad of [{}, { botId: "hank" }, { jobId: "job-own-1" }, { botId: "", jobId: "job-own-1" }, { botId: "hank", jobId: "" }, { botId: "hank", jobId: 3 }]) {
    assert.equal(await resolveRunningJob(withP, bad), null, JSON.stringify(bad));
  }
  const broken = { execute: async () => { throw new Error("db gone"); } };
  assert.equal(await resolveRunningJob(broken, { botId: "hank", jobId: "job-own-1" }), null);
});

test("resolveRunningJob: a database without bot_jobs.principal reads principal null (never the owner)", async () => {
  const j = await resolveRunningJob(plain, { botId: "hank", jobId: "job-own-1" });
  assert.deepEqual(j, { jobId: "job-own-1", botId: "hank", cardId: null, principal: null, workerPid: 4242 });
  const s = await resolveSignedScope(plain, { botId: "hank", scopeRef: "j:job-own-1", threadId: "job-job-own-1", gatewayType: "job" });
  assert.equal(s.principal, null);
});

test("resolveSignedScope s: a live session of the bot, for exactly its tuple; project from the def and the session", async () => {
  const r = await resolveSignedScope(withP, { botId: "hank", scopeRef: "s:" + SESS.live, threadId: "t-100", gatewayType: "gmail" });
  assert.deepEqual(r, { scope: "session", id: Number(SESS.live), botId: "hank", threadId: "t-100", gatewayType: "gmail", defProjectId: 42, sessionProjectId: 7 });
  assert.equal("principal" in r, false, "no principal on a session scope");
  assert.ok(await resolveSignedScope(withP, { botId: "hank", scopeRef: " s:" + SESS.live + " ", threadId: " t-100", gatewayType: "gmail " }), "trimmed like the MAC");
  for (const [name, a] of Object.entries({
    stopped: { scopeRef: "s:" + SESS.stopped, threadId: "t-101" }, done: { scopeRef: "s:" + SESS.done, threadId: "t-103" },
    archived: { scopeRef: "s:" + SESS.archived, threadId: "t-102" }, "another bot's": { scopeRef: "s:" + SESS.otto, threadId: "t-200", gatewayType: "discord" },
    "another thread": { scopeRef: "s:" + SESS.live, threadId: "t-999" }, "another gateway": { scopeRef: "s:" + SESS.live, threadId: "t-100", gatewayType: "discord" },
    "no such session": { scopeRef: "s:999999", threadId: "t-100" },
  })) assert.equal(await resolveSignedScope(withP, { botId: "hank", threadId: "t-100", gatewayType: "gmail", ...a }), null, name);
});

test("resolveSignedScope j: a running job for its generic tuple or its own card's tuple only", async () => {
  const g = await resolveSignedScope(withP, { botId: "hank", scopeRef: "j:job-own-1", threadId: "job-job-own-1", gatewayType: "job" });
  assert.deepEqual(g, { scope: "job", id: "job-own-1", botId: "hank", threadId: "job-job-own-1", gatewayType: "job", defProjectId: 42, principal: "owner" });
  assert.equal("sessionProjectId" in g, false, "no session project on a job scope");
  const c = await resolveSignedScope(withP, { botId: "hank", scopeRef: "j:job-card-1", threadId: "board-card-5", gatewayType: "board" });
  assert.deepEqual(c, { scope: "job", id: "job-card-1", botId: "hank", threadId: "board-card-5", gatewayType: "board", defProjectId: 42, principal: "owner" });
  assert.equal((await resolveSignedScope(withP, { botId: "hank", scopeRef: "j:job-card-1", threadId: "job-job-card-1", gatewayType: "job" })).id, "job-card-1",
    "a card job's generic tuple is its own too");
  for (const [name, a] of Object.entries({
    "another card": { scopeRef: "j:job-card-1", threadId: "board-card-6", gatewayType: "board" },
    "a card tuple for a job with no card": { scopeRef: "j:job-own-1", threadId: "board-card-5", gatewayType: "board" },
    "board-card-null": { scopeRef: "j:job-own-1", threadId: "board-card-null", gatewayType: "board" },
    "card thread on the job gateway": { scopeRef: "j:job-card-1", threadId: "board-card-5", gatewayType: "job" },
    "another job's tuple": { scopeRef: "j:job-own-1", threadId: "job-job-cron-1", gatewayType: "job" },
    "a session tuple": { scopeRef: "j:job-own-1", threadId: "t-100", gatewayType: "gmail" },
    finished: { scopeRef: "j:job-fin-1", threadId: "job-job-fin-1", gatewayType: "job" },
    "another bot's": { scopeRef: "j:job-otto-1", threadId: "job-job-otto-1", gatewayType: "job" },
  })) assert.equal(await resolveSignedScope(withP, { botId: "hank", ...a }), null, name);
});

test("resolveSignedScope: defProjectId comes from the def, never the request; a null def project stays null", async () => {
  const r = await resolveSignedScope(withP, { botId: "hank", scopeRef: "j:job-own-1", threadId: "job-job-own-1", gatewayType: "job", defProjectId: 99, projectId: 99 });
  assert.equal(r.defProjectId, 42);
  const d = new Database(withPath);
  d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid, principal) VALUES ('job-o-2', 'otto', 'g', 'running', 1, 'owner')").run();
  d.close();
  const o = await resolveSignedScope(withP, { botId: "otto", scopeRef: "j:job-o-2", threadId: "job-job-o-2", gatewayType: "job", defProjectId: 99 });
  assert.equal(o.defProjectId, null);
  const os = await resolveSignedScope(withP, { botId: "otto", scopeRef: "s:" + SESS.otto, threadId: "t-200", gatewayType: "discord" });
  assert.equal(os.defProjectId, null);
  assert.equal(os.sessionProjectId, null);
});

test("resolveSignedScope: a bot with no def, malformed scope refs, a failed read: null, never throws", async () => {
  assert.equal(await resolveSignedScope(withP, { botId: "ghost", scopeRef: "s:" + SESS.ghost, threadId: "t-300", gatewayType: "gmail" }), null, "no def");
  for (const scopeRef of [undefined, null, "", "x:1", "s:0", "s:07", "s:abc", "j:", "j:a b", "j:" + "x".repeat(129), "S:1", 5, {}]) {
    assert.equal(await resolveSignedScope(withP, { botId: "hank", scopeRef, threadId: "t-100", gatewayType: "gmail" }), null, String(scopeRef));
  }
  for (const botId of [undefined, "", 5]) assert.equal(await resolveSignedScope(withP, { botId, scopeRef: "s:" + SESS.live, threadId: "t-100", gatewayType: "gmail" }), null);
  const broken = { execute: async () => { throw new Error("db gone"); } };
  assert.equal(await resolveSignedScope(broken, { botId: "hank", scopeRef: "j:job-own-1", threadId: "job-job-own-1", gatewayType: "job" }), null);
  assert.equal(await resolveSignedScope(null, { botId: "hank", scopeRef: "j:job-own-1", threadId: "job-job-own-1", gatewayType: "job" }), null);
  assert.equal(await resolveSignedScope(withP), null);
});

// The gateway's scope parser and the signer's scope check are two copies of one
// rule (servers/shared stays free of scripts/ imports); this pins them together.
test("SCOPE_REF_RE (signed-session.js) is actor-sig.mjs's SCOPE_RE: same source, same verdicts", () => {
  assert.equal(SCOPE_REF_RE.source, SCOPE_RE.source);
  assert.equal(SCOPE_REF_RE.flags, SCOPE_RE.flags);
  const accept = ["s:1", "s:7", "s:1234567890123456", "j:job-abc123-x9y8z7", "j:a", "j:A.b_c:d-e", `j:${"x".repeat(128)}`];
  const reject = ["", "s:", "s:0", "s:07", "s:12345678901234567", "s:x", "j:", "j:a b", "j:job/../x", `j:${"x".repeat(129)}`,
    "k:1", "S:1", " s:1", "s:1 ", "s:1\n", "j:a\nb", "sj:1"];
  for (const v of accept) { assert.equal(SCOPE_REF_RE.test(v), true, `ref accepts ${v}`); assert.equal(SCOPE_RE.test(v), true, `sig accepts ${v}`); }
  for (const v of reject) { assert.equal(SCOPE_REF_RE.test(v), false, `ref rejects ${JSON.stringify(v)}`); assert.equal(SCOPE_RE.test(v), false, `sig rejects ${JSON.stringify(v)}`); }
});
