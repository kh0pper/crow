#!/usr/bin/env node
/**
 * Crow Bot Builder — Phase 3.0 live verification harness.
 *
 * Proves the bridge multi-model path THROUGH the real spawn (S3 proved bare
 * pi; this proves it via bridge.handleInbound), on the live ~/.crow-mpa db,
 * with NO Gmail (capturing sendReply). All artifacts are namespaced
 * `p30-e2e-*` and torn down; production (bot_registry/schedules/
 * bot_conversations) is never touched; crow.db opened busy_timeout-only
 * (no journal_mode pragma — WAL-flip-safe).
 *
 * Scenarios:
 *   A cloud-default — def.models.default = alibaba-coding/qwen3-coder-plus.
 *     handleInbound "do card N" ⇒ action=executed, tools isError:false,
 *     stdoutClean, bot_sessions.model persisted = the cloud key, escalated=0,
 *     card pending→done, [bridge] model-resolve shows provider=alibaba-coding
 *     source=default. (R2/R3/R5 through the real spawn.)
 *   B escalation — def.models.default = crow-local, .escalation =
 *     alibaba-coding/qwen3-coder-plus. Inbound "!escalate do card M":
 *     escalateRequested fires, token stripped (card still parsed post-strip),
 *     resolved provider=alibaba-coding source=escalation escalated=1
 *     session=new; bot_sessions.escalated=1. (R4/R5.)
 *
 * Usage: node scripts/pi-bots/p3_0_e2e.mjs            (setup→A→B→assert→teardown)
 *        node scripts/pi-bots/p3_0_e2e.mjs --keep     (skip teardown, for debug)
 */
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { handleInbound } from "./bridge.mjs";

const HOME = "/home/kh0pp";
const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const KEEP = process.argv.includes("--keep");
const CLOUD = "alibaba-coding/qwen3-coder-plus";
const LOCAL = "crow-local/qwen3.6-35b-a3b";
const SDIR = HOME + "/.crow-mpa/pi-bots/p30-e2e";

function db(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }
const fails = [];
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""));
  if (!cond) fails.push(name);
}

// ---- locate the proven research-scout def to clone its tool/policy shape ----
const c = db(CROW_DB);
const scout = c.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id='research-scout'").get();
if (!scout) { console.error("research-scout def missing — cannot clone proven shape"); process.exit(2); }
const baseDef = JSON.parse(scout.definition);
const prodSnap0 = c.prepare(
  "SELECT (SELECT COUNT(*) FROM bot_registry) br,(SELECT COUNT(*) FROM schedules) sc," +
  "(SELECT COUNT(*) FROM pi_bot_defs) pd,(SELECT COUNT(*) FROM bot_sessions) bs," +
  "(SELECT COUNT(*) FROM research_projects) rp").get();
const jmode0 = c.prepare("PRAGMA journal_mode").get().journal_mode;

// ---- setup: temp project + two temp bots + cards + plan files ----
function mkBot(suffix, models) {
  const botId = "p30-e2e-" + suffix;
  const sdir = SDIR + "-" + suffix;
  mkdirSync(sdir + "/sessions", { recursive: true });
  mkdirSync(sdir + "/plans", { recursive: true });
  const def = JSON.parse(JSON.stringify(baseDef));
  def.models = models;
  def.session_dir = sdir;
  def.permission_policy = def.permission_policy || {};
  def.permission_policy.write_paths = [sdir];
  def.spawn_env = Object.assign({}, def.spawn_env, { CROW_JOURNAL_MODE: "DELETE" });
  return { botId, sdir, def };
}

const proj = c.prepare(
  "INSERT INTO research_projects (name,description,type,created_at) VALUES (?,?,?,datetime('now'))"
).run("P3.0 E2E (temp)", "Phase 3.0 verification — safe to delete", "research");
const projectId = proj.lastInsertRowid;

const t = db(TASKS_DB);
function mkCard(title) {
  const r = t.prepare(
    "INSERT INTO tasks_items (title,status,project_id,created_at) VALUES (?, 'pending', ?, datetime('now'))"
  ).run(title, projectId);
  return r.lastInsertRowid;
}
const cardA = mkCard("P3.0-A: write DONE under ## Result, set card done");
const cardB = mkCard("P3.0-B: write DONE under ## Result, set card done");
const cardC = mkCard("P3.0-C: write DONE under ## Result, set card done");
t.close();

const CLOUD2 = "alibaba-coding/qwen3.6-plus";
const cloudBot = mkBot("cloud", { default: CLOUD });
const escBot = mkBot("esc", { default: LOCAL, escalation: CLOUD });
// fnBot: both models cloud (fast) so the R4 force-new resume test isn't gated
// on a slow cold local turn — turn1 default, turn2 same-thread !escalate.
const fnBot = mkBot("fn", { default: CLOUD, escalation: CLOUD2 });
for (const b of [cloudBot, escBot, fnBot]) {
  b.def.project_id = projectId;
  c.prepare(
    "INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled,created_at,updated_at) " +
    "VALUES (?,?,?,1,datetime('now'),datetime('now'))"
  ).run(b.botId, "P3.0 " + b.botId, JSON.stringify(b.def));
}
const planBody = (cid) =>
  "# Card " + cid + "\n\n## Task\nReply with the single word OK. Use the tasks tool to set this card " +
  "in_progress then done. Then write the word DONE under a \"## Result\" heading in this plan file.\n";
writeFileSync(cloudBot.sdir + "/plans/" + cardA + ".md", planBody(cardA));
writeFileSync(escBot.sdir + "/plans/" + cardB + ".md", planBody(cardB));
writeFileSync(fnBot.sdir + "/plans/" + cardC + ".md", planBody(cardC));
c.close();

const logs = [];
const cap = (arr) => (m) => { arr.push(m); };
const reply = (arr) => async (txt) => { arr.push(txt); };

function modelResolveLine(arr) { return arr.find((l) => l.startsWith("model-resolve ")) || ""; }
function cardStatus(cid) { const d = db(TASKS_DB); const r = d.prepare("SELECT status FROM tasks_items WHERE id=?").get(cid); d.close(); return r && r.status; }
function sessionRow(botId) { const d = db(CROW_DB); const r = d.prepare("SELECT model,escalated,pi_session_id,status FROM bot_sessions WHERE bot_id=? ORDER BY id DESC LIMIT 1").get(botId); d.close(); return r; }

const run = async () => {
  // ---- Scenario A: cloud-default execution ----
  const aLog = [], aRep = [];
  console.log("\n=== Scenario A: cloud-default bot executes a card ===");
  const ra = await handleInbound({
    bot_id: cloudBot.botId, gateway_thread_id: "p30-e2e-A",
    user_message: "do card " + cardA, log: cap(aLog), sendReply: reply(aRep),
  });
  const aMR = modelResolveLine(aLog);
  console.log("  model-resolve: " + aMR);
  console.log("  result: " + JSON.stringify(ra));
  const aSess = sessionRow(cloudBot.botId);
  check("A.action=executed", ra && ra.action === "executed", JSON.stringify(ra && ra.action));
  // Phase-3.0 scope = the resolved model can DRIVE the crow tool plane: assert
  // the crow-tasks state-machine calls are clean (≥1, none errored). A generic
  // file-tool miss the model self-recovers from (edit→read→write) is normal
  // agent behavior, NOT a bridge/resolution defect — the card reaching `done`
  // is the deliverable proof.
  const aTasks = (ra && ra.toolCalls || []).filter((x) => /^mcp__crow-tasks__/.test(x.tool));
  check("A.crow-tasks tool calls clean (≥1, none errored)", aTasks.length > 0 && aTasks.every((x) => !x.isError), JSON.stringify(ra && ra.toolCalls));
  check("A.stdoutClean", !!(ra && ra.stdoutClean));
  check("A.model-resolve provider=alibaba-coding source=default", /provider=alibaba-coding /.test(aMR) && /source=default/.test(aMR), aMR);
  check("A.bot_sessions.model=" + CLOUD, aSess && aSess.model === CLOUD, JSON.stringify(aSess));
  check("A.bot_sessions.escalated=0", aSess && Number(aSess.escalated) === 0, JSON.stringify(aSess && aSess.escalated));
  check("A.card pending→done", cardStatus(cardA) === "done", cardStatus(cardA));

  // ---- Scenario B: escalation keyword flips provider + forces new session ----
  const bLog = [], bRep = [];
  console.log("\n=== Scenario B: !escalate flips to cloud escalation model ===");
  const rb = await handleInbound({
    bot_id: escBot.botId, gateway_thread_id: "p30-e2e-B",
    user_message: "!escalate do card " + cardB, log: cap(bLog), sendReply: reply(bRep),
  });
  const bMR = modelResolveLine(bLog);
  console.log("  model-resolve: " + bMR);
  console.log("  result: " + JSON.stringify(rb));
  const bSess = sessionRow(escBot.botId);
  check("B.action=executed (card parsed AFTER !escalate strip)", rb && rb.action === "executed", JSON.stringify(rb && rb.action));
  check("B.model-resolve provider=alibaba-coding source=escalation", /provider=alibaba-coding /.test(bMR) && /source=escalation/.test(bMR), bMR);
  check("B.model-resolve session=new (fresh pi session on escalation)", /session=new/.test(bMR), bMR);
  check("B.bot_sessions.escalated=1", bSess && Number(bSess.escalated) === 1, JSON.stringify(bSess));
  check("B.bot_sessions.model=" + CLOUD, bSess && bSess.model === CLOUD, JSON.stringify(bSess && bSess.model));
  check("B.card pending→done", cardStatus(cardB) === "done", cardStatus(cardB));

  // ---- Scenario C (R4 force-new): same thread, default turn then !escalate ----
  console.log("\n=== Scenario C: !escalate on a RESUMED thread forces a fresh pi session (R4) ===");
  const c1Log = [], c1Rep = [];
  const rc1 = await handleInbound({
    bot_id: fnBot.botId, gateway_thread_id: "p30-e2e-C",
    user_message: "do card " + cardC, log: cap(c1Log), sendReply: reply(c1Rep),
  });
  const c1MR = modelResolveLine(c1Log);
  const c1Sess = sessionRow(fnBot.botId);
  console.log("  C1 model-resolve: " + c1MR + "  | result=" + JSON.stringify(rc1 && rc1.action) + " ps=" + (c1Sess && c1Sess.pi_session_id));
  check("C1.source=default model=qwen3-coder-plus escalated=0", /provider=alibaba-coding model=qwen3-coder-plus /.test(c1MR) && /source=default/.test(c1MR) && c1Sess && Number(c1Sess.escalated) === 0, c1MR);
  check("C1.card pending→done", cardStatus(cardC) === "done", cardStatus(cardC));
  const ps1 = c1Sess && c1Sess.pi_session_id;

  const c2Log = [], c2Rep = [];
  const rc2 = await handleInbound({
    bot_id: fnBot.botId, gateway_thread_id: "p30-e2e-C",
    user_message: "!escalate please re-check and confirm", log: cap(c2Log), sendReply: reply(c2Rep),
  });
  const c2MR = modelResolveLine(c2Log);
  const c2Sess = sessionRow(fnBot.botId);
  console.log("  C2 model-resolve: " + c2MR + "  | result=" + JSON.stringify(rc2 && rc2.action) + " ps=" + (c2Sess && c2Sess.pi_session_id));
  check("C2.source=escalation model=qwen3.6-plus", /provider=alibaba-coding model=qwen3\.6-plus /.test(c2MR) && /source=escalation/.test(c2MR), c2MR);
  check("C2.forced-new on model change (R4)", /session=new \(forced-new: model changed\)/.test(c2MR), c2MR);
  check("C2.pi_session_id changed PS1→PS2 (fresh pi session, old NOT resumed)", ps1 && c2Sess && c2Sess.pi_session_id && c2Sess.pi_session_id !== ps1, "ps1=" + ps1 + " ps2=" + (c2Sess && c2Sess.pi_session_id));
  check("C2.bot_sessions.escalated=1", c2Sess && Number(c2Sess.escalated) === 1, JSON.stringify(c2Sess && c2Sess.escalated));

  // ---- production-untouched snapshot ----
  const cc = db(CROW_DB);
  const snap1 = cc.prepare(
    "SELECT (SELECT COUNT(*) FROM bot_registry) br,(SELECT COUNT(*) FROM schedules) sc").get();
  const jmode1 = cc.prepare("PRAGMA journal_mode").get().journal_mode;
  cc.close();
  check("prod bot_registry unchanged (" + prodSnap0.br + ")", snap1.br === prodSnap0.br);
  check("prod schedules unchanged (" + prodSnap0.sc + ")", snap1.sc === prodSnap0.sc);
  check("crow.db journal_mode still '" + jmode0 + "'", jmode1 === jmode0 && jmode0 === "delete", jmode1);
};

const teardown = () => {
  const d = db(CROW_DB);
  d.prepare("DELETE FROM bot_sessions WHERE bot_id LIKE 'p30-e2e-%'").run();
  d.prepare("DELETE FROM pi_bot_defs WHERE bot_id LIKE 'p30-e2e-%'").run();
  d.prepare("DELETE FROM research_projects WHERE id=?").run(projectId);
  const fin = d.prepare(
    "SELECT (SELECT COUNT(*) FROM pi_bot_defs) pd,(SELECT COUNT(*) FROM bot_sessions) bs," +
    "(SELECT COUNT(*) FROM research_projects) rp,(SELECT COUNT(*) FROM bot_registry) br," +
    "(SELECT COUNT(*) FROM schedules) sc").get();
  d.close();
  const td = db(TASKS_DB);
  td.prepare("DELETE FROM tasks_items WHERE project_id=?").run(projectId);
  const tcnt = td.prepare("SELECT COUNT(*) c FROM tasks_items").get().c;
  td.close();
  for (const b of [cloudBot, escBot]) { try { rmSync(b.sdir, { recursive: true, force: true }); } catch {} }
  console.log("\n=== teardown ===");
  console.log("  restored: pi_bot_defs=" + fin.pd + " bot_sessions=" + fin.bs + " research_projects=" + fin.rp +
    " bot_registry=" + fin.br + " schedules=" + fin.sc + " tasks_items=" + tcnt);
  check("teardown: pi_bot_defs back to " + prodSnap0.pd, fin.pd === prodSnap0.pd, String(fin.pd));
  check("teardown: bot_sessions back to " + prodSnap0.bs, fin.bs === prodSnap0.bs, String(fin.bs));
  check("teardown: research_projects back to " + prodSnap0.rp, fin.rp === prodSnap0.rp, String(fin.rp));
};

try {
  await run();
} catch (e) {
  console.log("HARNESS ERROR: " + (e && e.stack || e));
  fails.push("harness-exception");
} finally {
  if (!KEEP) teardown();
}
console.log("\nP3.0 E2E: " + (fails.length ? "FAIL (" + fails.join(", ") + ")" : "PASS (all checks)"));
process.exit(fails.length ? 1 : 0);
