#!/usr/bin/env node
/**
 * Crow Bot Builder — Slice C (opt-in self-authoring) live verification harness.
 *
 * Drives the REAL bridge (handleInbound, capturing sendReply, namespaced
 * slicec-e2e-* artifacts, production-snapshot guard, full teardown) to prove
 * the parts that pure-unit tests can't reach:
 *
 *  HARD (model-independent — the bridge mkdir's the staging dir BEFORE the pi
 *  turn, so these hold even if the model does nothing or the endpoint is down):
 *   - ON, no project: staging dir is created at <def.session_dir>/proposed-skills.
 *   - ON, WITH a project_spaces.workspace_dir: staging dir is STILL created at
 *     <def.session_dir>/proposed-skills (NOT <workspace>/bots/<id>/...) — proves
 *     the review CRITICAL-1 fix (write-here == scan-there, project-independent).
 *   - OFF: the bridge creates NO staging dir.
 *
 *  SOFT (LLM-dependent, best-effort): the ON bot actually drafts a *.md into the
 *  staging dir; the draft is INERT (skill_resolver does not resolve it) and is
 *  NOT in def.skills. A miss here is reported, not failed (local-model variance);
 *  the inert/approval guarantees are proven deterministically by the unit tests
 *  and the post-restart live UI check.
 *
 * No Gmail. crow.db untouched outside the namespaced rows. Local model only.
 */
import Database from "better-sqlite3";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { handleInbound } from "./bridge.mjs";
import { resolveSkill } from "./skill_resolver.mjs";
import { proposalsDir } from "./skill_proposals.mjs";

const HOME = "/home/kh0pp";
const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const BASE = HOME + "/.crow-mpa/pi-bots";
function db(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }
const fails = [], softMiss = [];
const check = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (d ? "  — " + String(d).slice(0, 200) : "")); if (!c) fails.push(n); };
const soft = (n, c, d) => { console.log((c ? "PASS " : "SOFT-MISS ") + n + (d ? "  — " + String(d).slice(0, 200) : "")); if (!c) softMiss.push(n); };

const prodSnap = (() => { const c = db(CROW_DB); const r = c.prepare("SELECT (SELECT COUNT(*) FROM pi_bot_defs) pd,(SELECT COUNT(*) FROM bot_sessions) bs,(SELECT COUNT(*) FROM project_spaces) ps").get(); const jm = c.prepare("PRAGMA journal_mode").get().journal_mode; c.close(); return { ...r, jm }; })();

// Clone research-scout (pi_builtin write, crow-local) into namespaced defs.
const c0 = db(CROW_DB);
const scout = c0.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id='research-scout'").get();
if (!scout) { console.error("research-scout missing — cannot clone"); process.exit(2); }
const base = JSON.parse(scout.definition);

function makeDef(sdir, selfAuthoring) {
  const d = JSON.parse(JSON.stringify(base));
  d.models = { default: "crow-local/qwen3.6-35b-a3b" };
  d.session_dir = sdir;
  d.project_id = undefined; delete d.project_id;
  d.skills = [];
  d.tools = d.tools || {}; d.tools.pi_builtin = ["read", "edit", "write"]; d.tools.crow_mcp = []; d.tools.skills = [];
  d.permission_policy = { bash: "deny", bash_allow: [], write_paths: [sdir], external_send: "draft_only", confirm: [], self_authoring: !!selfAuthoring };
  d.spawn_env = Object.assign({}, d.spawn_env, { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local" });
  d.gateways = [{ type: "gmail", address: "x@maestro.press", allowlist: ["kevin.hopper1@gmail.com"] }];
  return d;
}

const SD_ON = BASE + "/slicec-e2e-on";
const SD_OFF = BASE + "/slicec-e2e-off";
const SD_PROJ = BASE + "/slicec-e2e-proj";
for (const sd of [SD_ON, SD_OFF, SD_PROJ]) { try { rmSync(proposalsDir(sd), { recursive: true, force: true }); } catch {} mkdirSync(sd + "/sessions", { recursive: true }); }

// project bot: a project_spaces row WITH a workspace_dir → resolved sessionDir
// becomes <workspace>/bots/<id>, distinct from def.session_dir.
const wsDir = HOME + "/.crow-mpa/data/projects/slicec-e2e-proj/workspace";
const projIns = c0.prepare("INSERT INTO project_spaces (name, slug, description, workspace_dir) VALUES (?,?,?,?)").run("Slice C E2E (temp)", "slicec-e2e-" + prodSnap.ps, "safe to delete", wsDir);
const projectId = Number(projIns.lastInsertRowid);

c0.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled,created_at,updated_at) VALUES ('slicec-e2e-on','SC ON',?,1,datetime('now'),datetime('now'))").run(JSON.stringify(makeDef(SD_ON, true)));
c0.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled,created_at,updated_at) VALUES ('slicec-e2e-off','SC OFF',?,1,datetime('now'),datetime('now'))").run(JSON.stringify(makeDef(SD_OFF, false)));
const projDef = makeDef(SD_PROJ, true); projDef.project_id = projectId;
c0.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,definition,project_id,enabled,created_at,updated_at) VALUES ('slicec-e2e-proj','SC PROJ',?,?,1,datetime('now'),datetime('now'))").run(JSON.stringify(projDef), projectId);
c0.close();

const run = async () => {
  // ---- ON (no project): draft + dir-created + inert ----
  console.log("\n=== ON (no project): self_authoring=true ===");
  const onLog = [];
  const ron = await handleInbound({
    bot_id: "slicec-e2e-on", gateway_thread_id: "slicec-e2e-on-1",
    user_message: "Propose a new skill named 'selftest-greeting' that greets the user warmly. " +
      "Use the write tool to save it as a single markdown file in your proposed-skills staging directory, then tell me you drafted it.",
    log: (m) => onLog.push(m), sendReply: async () => {},
  });
  console.log("  result: " + JSON.stringify(ron && { action: ron.action, tools: (ron.toolCalls || []).map((t) => t.tool) }));
  const onDir = proposalsDir(SD_ON);
  check("ON.bridge created the staging dir (model-independent)", existsSync(onDir), onDir);
  const onFiles = existsSync(onDir) ? readdirSync(onDir).filter((f) => f.endsWith(".md")) : [];
  soft("ON.model drafted a .md proposal", onFiles.length > 0, JSON.stringify(onFiles));
  if (onFiles.length) {
    const nm = onFiles[0].replace(/\.md$/, "");
    const r = resolveSkill(nm, { crowHome: "/home/kh0pp/.crow-mpa" });
    check("ON.drafted proposal is INERT (skill_resolver does not resolve it)", r === null, nm);
    const d = db(CROW_DB); const def = JSON.parse(d.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id='slicec-e2e-on'").get().definition); d.close();
    check("ON.drafted proposal is NOT in def.skills", !(def.skills || []).includes(nm), JSON.stringify(def.skills));
  }

  // ---- ON (project workspace): staging keyed on def.session_dir, NOT workspace ----
  console.log("\n=== ON (project bot): staging must be at def.session_dir, NOT workspace (CRITICAL-1) ===");
  const pLog = [];
  await handleInbound({
    bot_id: "slicec-e2e-proj", gateway_thread_id: "slicec-e2e-proj-1",
    user_message: "Say hello in one short sentence.",
    log: (m) => pLog.push(m), sendReply: async () => {},
  });
  const projStaging = proposalsDir(SD_PROJ);                         // def.session_dir based
  const wsStaging = proposalsDir(wsDir + "/bots/slicec-e2e-proj");   // resolved-sessionDir based (the WRONG place)
  check("PROJ.staging dir created at def.session_dir", existsSync(projStaging), projStaging);
  check("PROJ.no staging dir at the resolved workspace path (no write-here/scan-there split)", !existsSync(wsStaging), wsStaging);

  // ---- OFF: no staging dir created by the bridge ----
  console.log("\n=== OFF: self_authoring=false ===");
  const offLog = [];
  await handleInbound({
    bot_id: "slicec-e2e-off", gateway_thread_id: "slicec-e2e-off-1",
    user_message: "What can you help me with? One sentence.",
    log: (m) => offLog.push(m), sendReply: async () => {},
  });
  check("OFF.bridge created NO staging dir", !existsSync(proposalsDir(SD_OFF)), proposalsDir(SD_OFF));

  // ---- production untouched ----
  const cc = db(CROW_DB);
  const jm1 = cc.prepare("PRAGMA journal_mode").get().journal_mode; cc.close();
  check("crow.db journal_mode still delete", jm1 === "delete" && prodSnap.jm === "delete", jm1);
};

const teardown = () => {
  const d = db(CROW_DB);
  d.prepare("DELETE FROM bot_sessions WHERE bot_id LIKE 'slicec-e2e-%'").run();
  d.prepare("DELETE FROM pi_bot_defs WHERE bot_id LIKE 'slicec-e2e-%'").run();
  d.prepare("DELETE FROM project_spaces WHERE id=?").run(projectId);
  const fin = d.prepare("SELECT (SELECT COUNT(*) FROM pi_bot_defs) pd,(SELECT COUNT(*) FROM bot_sessions) bs,(SELECT COUNT(*) FROM project_spaces) ps").get();
  d.close();
  for (const sd of [SD_ON, SD_OFF, SD_PROJ]) { try { rmSync(sd, { recursive: true, force: true }); } catch {} }
  try { rmSync(HOME + "/.crow-mpa/data/projects/slicec-e2e-proj", { recursive: true, force: true }); } catch {}
  console.log("\n=== teardown ===  pi_bot_defs=" + fin.pd + " bot_sessions=" + fin.bs + " project_spaces=" + fin.ps);
  check("teardown restored pi_bot_defs=" + prodSnap.pd, fin.pd === prodSnap.pd, String(fin.pd));
  check("teardown restored project_spaces=" + prodSnap.ps, fin.ps === prodSnap.ps, String(fin.ps));
};

try { await run(); } catch (e) { console.log("HARNESS ERROR: " + (e && e.stack || e)); fails.push("harness-exception"); }
finally { if (!process.argv.includes("--keep")) teardown(); }
console.log("\nSlice C E2E: " + (fails.length ? "FAIL (" + fails.join(", ") + ")" : "PASS") + (softMiss.length ? "  [soft-miss: " + softMiss.join(", ") + "]" : ""));
process.exit(fails.length ? 1 : 0);
