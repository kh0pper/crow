#!/usr/bin/env node
/**
 * Crow Bot Builder — Phase 3.1 live verification harness.
 *
 * The pi-lab gate LOGIC is already proven deterministically by
 * pi-lab/bin/gate-harness.mjs (18/18: opt-in/capability/depth/NaN-fail-
 * closed/strict-no-op + the Phase-2.2 regression sweep). What THIS harness
 * adds is the live, on-crow proof of the parts gate-harness can't reach:
 *
 *  R10  ENV PROPAGATION (the review CRITICAL): a child pi spawned EXACTLY
 *       the way subagent/index.ts spawns it (inherited process.env +
 *       PIBOT_SUBAGENT_DEPTH bumped) genuinely carries the per-bot
 *       PI_BOT_PERMISSION_POLICY. Discriminator: the child is told to run a
 *       BENIGN bash (`echo …`). The generic headless gate ALLOWS benign
 *       bash; only the per-bot bash:"deny" policy blocks it — so a BLOCK
 *       with reason "bot bash policy=deny" proves the policy reached the
 *       child (not a generic-gate false positive). The same child is told
 *       to call `subagent`; a BLOCK citing PIBOT_SUBAGENT_DEPTH=1 proves the
 *       recursion depth-cap fires in the child.
 *  M    INTEGRATION: a capability-listed, multi_agent:true bot driven
 *       through the REAL bridge actually gets `subagent` offered + ungated
 *       (no gate block), card reaches done.
 *  L    LOCAL stays single-agent — proven by composition (documented), no
 *       slow local turn: isMultiAgentCapable("crow-local",…)===false (unit)
 *       + gate-harness case "model_capable absent/false → blocked".
 *
 * No Gmail; namespaced p31-e2e-* artifacts torn down; production untouched;
 * crow.db busy_timeout-only.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { handleInbound } from "./bridge.mjs";
import { isMultiAgentCapable } from "./pi_extensions_allowlist.mjs";

const HOME = "/home/kh0pp";
const NODE = HOME + "/.nvm/versions/node/v20.20.2/bin/node";
const PI_CLI = HOME + "/.nvm/versions/node/v20.20.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const CAPABLE = "alibaba-coding/qwen3.6-plus"; // on MULTI_AGENT_CAPABLE
const SDIR = HOME + "/.crow-mpa/pi-bots/p31-e2e";
function db(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }
const fails = [];
function check(n, c, d) { console.log((c ? "PASS " : "FAIL ") + n + (d ? "  — " + String(d).slice(0, 160) : "")); c ? null : fails.push(n); }

// --- minimal LF-framed pi --mode rpc reader (S2 pattern; child-shaped) ---
function piRpc({ args, env }) {
  const proc = spawn(NODE, [PI_CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const ev = [], resp = []; let buf = "", stderr = ""; const waiters = [];
  proc.stdout.on("data", (c) => {
    buf += c.toString("utf8"); let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let ln = buf.slice(0, nl); buf = buf.slice(nl + 1); if (ln.endsWith("\r")) ln = ln.slice(0, -1);
      if (!ln) continue; let m; try { m = JSON.parse(ln); } catch { continue; }
      (m.type === "response" ? resp : ev).push(m);
      for (const w of waiters.slice()) if (w.p(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
    }
  });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  const exited = new Promise((res) => proc.on("exit", (c) => res(c == null ? -1 : c)));
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = (p, ms, label) => new Promise((resolve, reject) => {
    const hit = ev.find(p) || resp.find(p); if (hit) return resolve(hit);
    const w = { p, r: resolve }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error("timeout:" + label)); } }, ms);
  });
  return { proc, ev, resp, send, waitFor, exited, stderrText: () => stderr,
    async close() { try { proc.stdin.end(); } catch {} proc.kill("SIGTERM"); const k = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000); await exited; clearTimeout(k); } };
}

const prodSnap = (() => { const c = db(CROW_DB); const r = c.prepare("SELECT (SELECT COUNT(*) FROM bot_registry) br,(SELECT COUNT(*) FROM schedules) sc,(SELECT COUNT(*) FROM pi_bot_defs) pd,(SELECT COUNT(*) FROM bot_sessions) bs,(SELECT COUNT(*) FROM research_projects) rp").get(); const jm = c.prepare("PRAGMA journal_mode").get().journal_mode; c.close(); return { ...r, jm }; })();

// clone the proven research-scout shape
const c0 = db(CROW_DB);
const scout = c0.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id='research-scout'").get();
if (!scout) { console.error("research-scout missing"); process.exit(2); }
const baseDef = JSON.parse(scout.definition);
const proj = c0.prepare("INSERT INTO research_projects (name,description,type,created_at) VALUES (?,?,?,datetime('now'))").run("P3.1 E2E (temp)", "phase 3.1 — safe to delete", "research");
const projectId = proj.lastInsertRowid;
c0.close();
const t0 = db(TASKS_DB);
const cardM = t0.prepare("INSERT INTO tasks_items (title,status,project_id,created_at) VALUES (?, 'pending', ?, datetime('now'))").run("P3.1-M delegate via subagent then done", projectId).lastInsertRowid;
t0.close();

const maSdir = SDIR + "-ma";
mkdirSync(maSdir + "/sessions", { recursive: true });
mkdirSync(maSdir + "/plans", { recursive: true });
const maDef = JSON.parse(JSON.stringify(baseDef));
maDef.models = { default: CAPABLE };
maDef.session_dir = maSdir;
maDef.project_id = projectId;
maDef.permission_policy = Object.assign({}, maDef.permission_policy, { bash: "deny", write_paths: [maSdir], multi_agent: true });
maDef.spawn_env = Object.assign({}, maDef.spawn_env, { CROW_JOURNAL_MODE: "DELETE" });
const c1 = db(CROW_DB);
c1.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled,created_at,updated_at) VALUES ('p31-e2e-ma','P3.1 MA',?,1,datetime('now'),datetime('now'))").run(JSON.stringify(maDef));
c1.close();
writeFileSync(maSdir + "/plans/" + cardM + ".md",
  "# Card " + cardM + "\n\n## Task\nUse the `subagent` tool ONCE (single mode, agent \"worker\", task: \"reply with exactly the token PONGOK\"). " +
  "Then set this card in_progress then done via the tasks tool, and write the worker's reply under a \"## Result\" heading here.\n");

const logs = [];
function modelResolve(arr) { return arr.find((l) => l.startsWith("model-resolve ")) || ""; }
function cardStatus(id) { const d = db(TASKS_DB); const r = d.prepare("SELECT status FROM tasks_items WHERE id=?").get(id); d.close(); return r && r.status; }

const run = async () => {
  // ---- L (composition, no live turn) ----
  console.log("\n=== L: local-qwen bot stays single-agent (by composition) ===");
  check("L.isMultiAgentCapable(crow-local/qwen3.6-35b-a3b)===false", isMultiAgentCapable("crow-local", "qwen3.6-35b-a3b") === false);
  check("L.isMultiAgentCapable(" + CAPABLE + ")===true", isMultiAgentCapable("alibaba-coding", "qwen3.6-plus") === true);
  console.log("  (gate-harness.mjs case 3 already proved model_capable:false ⇒ subagent BLOCKED; a local bot's bridge-injected model_capable is false ⇒ single-agent enforced.)");

  // ---- R10: faithful subagent-child-shaped pi, inherited env + depth=1 ----
  console.log("\n=== R10: child-shaped pi inherits per-bot policy + depth (env propagation) ===");
  const childPolicy = JSON.stringify({ bash: "deny", write_paths: [maSdir], multi_agent: true, model_capable: true });
  const childEnv = Object.assign({}, process.env, {
    PATH: HOME + "/.nvm/versions/node/v20.20.2/bin:" + (process.env.PATH || ""),
    PI_PROVIDER: "alibaba-coding",
    PIBOT_SUBAGENT_DEPTH: "1", // subagent/index.ts sets this on every child it spawns
    PI_BOT_PERMISSION_POLICY: childPolicy,
  });
  const child = piRpc({
    args: ["--mode", "rpc", "--provider", "alibaba-coding", "--model", "qwen3.6-plus",
      "--session-dir", maSdir + "/sessions-r10", "--tools", "bash,subagent"],
    env: childEnv,
  });
  let r10txt = "";
  try {
    await child.waitFor((m) => m.type === "response" || m.type === "agent_start" || m.type === "ready", 20000, "ready").catch(() => null);
    child.send({ type: "prompt", message:
      "Do BOTH, reporting the exact tool result for each: (1) call the bash tool with command: echo HELLO_BENIGN_R10 ; " +
      "(2) call the subagent tool (single mode, agent \"worker\", task \"say hi\"). Then stop." });
    await child.waitFor((m) => m.type === "agent_end", 180000, "agent_end").catch(() => null);
    r10txt = JSON.stringify(child.ev);
  } finally {
    await child.close();
  }
  const bashBlocked = /bot bash policy=deny/.test(r10txt);
  const subBlocked = /recursive subagent blocked \(PIBOT_SUBAGENT_DEPTH=1/.test(r10txt);
  check("R10.benign bash BLOCKED by per-bot policy (proves PI_BOT_PERMISSION_POLICY propagated to child — generic gate would ALLOW echo)", bashBlocked, bashBlocked ? "" : r10txt.slice(-400));
  check("R10.child subagent BLOCKED by depth cap (PIBOT_SUBAGENT_DEPTH=1 propagated + gate fires in child)", subBlocked, subBlocked ? "" : r10txt.slice(-400));

  // ---- M: real bridge, capable + multi_agent:true → subagent offered/ungated ----
  console.log("\n=== M: capable multi_agent bot via the real bridge ===");
  const mLog = [];
  const rm = await handleInbound({
    bot_id: "p31-e2e-ma", gateway_thread_id: "p31-e2e-M",
    user_message: "do card " + cardM, log: (m) => mLog.push(m), sendReply: async () => {},
  });
  const mMR = modelResolve(mLog);
  console.log("  model-resolve: " + mMR);
  console.log("  result: " + JSON.stringify(rm));
  const subCalls = (rm && rm.toolCalls || []).filter((x) => x.tool === "subagent");
  const tasksClean = (rm && rm.toolCalls || []).filter((x) => /^mcp__crow-tasks__/.test(x.tool)).every((x) => !x.isError);
  check("M.action=executed", rm && rm.action === "executed", JSON.stringify(rm && rm.action));
  check("M.model-resolve provider=alibaba-coding (capable)", /provider=alibaba-coding /.test(mMR), mMR);
  check("M.subagent invoked AND not gate-blocked (capable+opt-in path)", subCalls.length > 0 && subCalls.every((x) => !x.isError), JSON.stringify(rm && rm.toolCalls));
  check("M.crow-tasks calls clean", tasksClean, JSON.stringify(rm && rm.toolCalls));
  check("M.card pending→done", cardStatus(cardM) === "done", cardStatus(cardM));

  // ---- production untouched ----
  const cc = db(CROW_DB);
  const s1 = cc.prepare("SELECT (SELECT COUNT(*) FROM bot_registry) br,(SELECT COUNT(*) FROM schedules) sc").get();
  const jm1 = cc.prepare("PRAGMA journal_mode").get().journal_mode; cc.close();
  check("prod bot_registry unchanged (" + prodSnap.br + ")", s1.br === prodSnap.br);
  check("prod schedules unchanged (" + prodSnap.sc + ")", s1.sc === prodSnap.sc);
  check("crow.db journal_mode still delete", jm1 === "delete" && prodSnap.jm === "delete", jm1);
};

const teardown = () => {
  const d = db(CROW_DB);
  d.prepare("DELETE FROM bot_sessions WHERE bot_id LIKE 'p31-e2e-%'").run();
  d.prepare("DELETE FROM pi_bot_defs WHERE bot_id LIKE 'p31-e2e-%'").run();
  d.prepare("DELETE FROM research_projects WHERE id=?").run(projectId);
  const fin = d.prepare("SELECT (SELECT COUNT(*) FROM pi_bot_defs) pd,(SELECT COUNT(*) FROM bot_sessions) bs,(SELECT COUNT(*) FROM research_projects) rp").get();
  d.close();
  const td = db(TASKS_DB); td.prepare("DELETE FROM tasks_items WHERE project_id=?").run(projectId); const tc = td.prepare("SELECT COUNT(*) c FROM tasks_items").get().c; td.close();
  try { rmSync(maSdir, { recursive: true, force: true }); } catch {}
  console.log("\n=== teardown ===  pi_bot_defs=" + fin.pd + " bot_sessions=" + fin.bs + " research_projects=" + fin.rp + " tasks_items=" + tc);
  check("teardown restored pi_bot_defs=" + prodSnap.pd, fin.pd === prodSnap.pd, String(fin.pd));
  check("teardown restored bot_sessions=" + prodSnap.bs, fin.bs === prodSnap.bs, String(fin.bs));
  check("teardown restored research_projects=" + prodSnap.rp, fin.rp === prodSnap.rp, String(fin.rp));
};

try { await run(); } catch (e) { console.log("HARNESS ERROR: " + (e && e.stack || e)); fails.push("harness-exception"); }
finally { if (!process.argv.includes("--keep")) teardown(); }
console.log("\nP3.1 E2E: " + (fails.length ? "FAIL (" + fails.join(", ") + ")" : "PASS (all checks)"));
process.exit(fails.length ? 1 : 0);
