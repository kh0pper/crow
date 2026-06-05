#!/usr/bin/env node
// pir-fullflow.mjs — full-flow PIR regression harness: email -> close, sandboxed.
//
// Extends pir-pipeline-bench.mjs to drive the WHOLE lifecycle per PIR and assert
// a per-stage verdict (INGEST / BOT / VALIDATE / CLOSE) over N reps, isolated
// from production so nothing real is mutated or sent.
//
//   node pir-fullflow.mjs --pir <pir_number> --runs <n> [--tag t] [flags]
//   node pir-fullflow.mjs --all --runs <n>            # iterate the Tier-1 golden set
//
// Flags:
//   --ingest-only   run the deterministic INGEST assert only (no model, no sandbox)
//   --no-approve    run INGEST+BOT+VALIDATE, skip APPROVE->CLOSE
//   --keep-sandbox  leave the sandbox canvas-companion running after the run
//   --no-swap       do not call pir_model_swap.sh (use whatever is already served)
//
// ISOLATION MODEL (a maintenance window, like the model swap):
//  * Tracker/notes: production canvas-companion-web MUST be stopped first; this
//    harness launches a dedicated uvicorn on :8080 pointed at a COPY of canvas.db
//    (CANVAS_DB_PATH override). The bot's hardcoded :8080 lands in throwaway state.
//  * Loader commit: each rep exports TEA_DB=<fresh per-rep copy> so loader --commit
//    writes to a throwaway tea_data.db (loader reads os.environ TEA_DB).
//  * Filesystem: the bot's write_paths are fail-closed to the real _staging /
//    pir-incoming, so we write to the REAL _staging and snapshot/restore it
//    (the proven pir-pipeline-bench model); holding dirs are read-only inputs.
//  * crow.db research_sources: delete rows added during each run (watermark).
//  * Model serving: the harness owns pir_model_swap.sh (27B reply / 35B delivery)
//    with a fail-safe restore to the 35B daily driver on exit.
//
// PRECONDITION: PIR systemd timers stopped AND canvas-companion-web stopped.
// The harness refuses to run otherwise (it needs sole-writer + port :8080).

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { ingestReplay } from "/home/kh0pp/crow/scripts/bots/sync_pir_responses.mjs";
import * as A from "/home/kh0pp/crow/scripts/bench/pir-stage-assert.mjs";

// ── paths ────────────────────────────────────────────────────────────────────
const CROW = "/home/kh0pp/crow";
const BRIDGE = `${CROW}/scripts/pi-bots/bridge.mjs`;
const MODEL_SWAP = `${CROW}/scripts/bots/pir_model_swap.sh`;
const COMPUTE_FACTS = `${CROW}/scripts/bots/pir_compute_facts.py`;
const CANVAS_DB_PROD = "/home/kh0pp/spring-2026/canvas-companion/db/canvas.db";
const CANVAS_APP_DIR = "/home/kh0pp/spring-2026/canvas-companion";
const CANVAS_UVICORN = `${CANVAS_APP_DIR}/.venv/bin/uvicorn`;
const TEA_DB_PROD = "/home/kh0pp/spring-2026/texas-gov-data-mcp/data/tea_data.db";
const CROW_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
const SOURCES = "/home/kh0pp/spring-2026/insd-5941/sources";
const FIXTURES = `${CROW}/scripts/bench/fixtures`;
const GOLDEN = `${CROW}/scripts/bench/golden`;
const RESULTS = `${CROW}/scripts/bench/results/pir-fullflow`;
const SANDBOX = `${RESULTS}/_sandbox`;
const UV_BIN = process.env.UV_BIN || "/home/kh0pp/.local/bin/uv";

// ── args ──────────────────────────────────────────────────────────────────────
function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i !== -1 ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes(`--${name}`); }
const ALL = flag("all");
const PIR_ARG = arg("pir");
const RUNS = parseInt(arg("runs", "1"), 10);
const TAG = arg("tag", "ff");
const INGEST_ONLY = flag("ingest-only");
const NO_APPROVE = flag("no-approve");
const KEEP_SANDBOX = flag("keep-sandbox");
const NO_SWAP = flag("no-swap");
const TURN_TIMEOUT_MS = process.env.PIBOT_TURN_TIMEOUT_MS || String(25 * 60 * 1000);
const RUN_TIMEOUT_MS = Number(process.env.PIR_FULLFLOW_RUN_TIMEOUT_MS || 30 * 60 * 1000);
// Hard window cap: the maintenance window (canvas-web down, tea_data.db read-only)
// can NEVER stay open longer than this. An out-of-process deadman enforces it even
// if this harness's event loop is blocked in a hung subprocess. Default 2h; size it
// to your run but keep it bounded. Set generously above a legit run, never "off".
const WINDOW_CAP_MS = Number(process.env.PIR_FULLFLOW_WINDOW_CAP_MS || 2 * 60 * 60 * 1000);
const DEADMAN_SCRIPT = `${CROW}/scripts/bench/pir-fullflow-deadman.sh`;
// Optional: if set, the harness OWNS the canvas-web/timers lifecycle (stops them at
// start, restarts at teardown) so the window is fully self-contained and the deadman
// can restart them too. If unset, services must be pre-stopped by the operator and
// the deadman only restores the kh0pp-owned bits (tea unlock + :8080) on a runaway.
const SUDO_PASS = process.env.LAB_SUDO_PASS || "";

function log(m) { console.error(`[fullflow ${new Date().toISOString()}] ${m}`); }
function die(m) { console.error(`FATAL: ${m}`); process.exit(1); }

// ── service lifecycle (optional, when LAB_SUDO_PASS is provided) ───────────────
const PROD_SERVICES = ["canvas-companion-web.service", "mpa-pir-response-sync.timer", "mpa-pir-processor-dispatch.timer"];
function sudoSystemctl(action) {
  if (!SUDO_PASS) return false;
  try {
    execFileSync("bash", ["-c", `echo "$LAB_SUDO_PASS" | sudo -S systemctl ${action} ${PROD_SERVICES.join(" ")}`],
      { env: { ...process.env, LAB_SUDO_PASS: SUDO_PASS }, timeout: 60000, stdio: "pipe" });
    log(`systemctl ${action} ${PROD_SERVICES.length} prod service(s)`);
    return true;
  } catch (e) { log(`WARNING: systemctl ${action} failed: ${e.message}`); return false; }
}

// ── deadman watchdog (out-of-process hard window cap) ─────────────────────────
let deadmanProc = null;
const DEADMAN_SENTINEL = `${SANDBOX}/.deadman_disarmed`;
function armDeadman() {
  const cap = Math.floor(WINDOW_CAP_MS / 1000);
  try {
    fs.mkdirSync(SANDBOX, { recursive: true });
    try { fs.rmSync(DEADMAN_SENTINEL, { force: true }); } catch { /* */ }
    const logfd = fs.openSync(`${RESULTS}/deadman.log`, "a");
    // Pass the sentinel path so the deadman can no-op if we disarmed but the kill
    // didn't land (belt-and-suspenders against a missed process-group kill).
    deadmanProc = spawn("bash", [DEADMAN_SCRIPT, String(cap), String(process.pid), TEA_DB_PROD, DEADMAN_SENTINEL],
      { detached: true, stdio: ["ignore", logfd, logfd], env: { ...process.env, LAB_SUDO_PASS: SUDO_PASS } });
    deadmanProc.unref();
    log(`deadman armed: ${cap}s hard window cap (pid ${deadmanProc.pid}) -> ${RESULTS}/deadman.log`);
  } catch (e) { log(`WARNING: could not arm deadman: ${e.message}`); }
}
function disarmDeadman() {
  // 1) sentinel first (works even if the kill misses).
  try { fs.mkdirSync(SANDBOX, { recursive: true }); fs.writeFileSync(DEADMAN_SENTINEL, "disarmed"); } catch { /* */ }
  // 2) kill the watchdog: its own pid AND its process group.
  if (deadmanProc && deadmanProc.pid) {
    for (const target of [deadmanProc.pid, -deadmanProc.pid]) { try { process.kill(target, "SIGKILL"); } catch { /* */ } }
    deadmanProc = null;
  }
}

// ── preflight ──────────────────────────────────────────────────────────────────
function timerActive(t) {
  try { return execFileSync("systemctl", ["is-active", t], { stdio: "pipe" }).toString().trim() === "active"; }
  catch { return false; }
}
function portListening() {
  try { execFileSync("bash", ["-c", "curl -sf -o /dev/null -m 3 http://localhost:8080/api/pir/1 || curl -sf -o /dev/null -m 3 http://localhost:8080/"], { stdio: "pipe" }); return true; }
  catch { return false; }
}

// ── model swap (harness-owned) ─────────────────────────────────────────────────
let swapped = false;
function swap(which) {
  if (NO_SWAP) { log(`--no-swap: leaving served model as-is (wanted ${which})`); return true; }
  try { execFileSync("bash", [MODEL_SWAP, which], { timeout: 6 * 60 * 1000, stdio: "pipe" }); swapped = (which === "27b"); log(`model -> ${which}`); return true; }
  catch (e) { log(`MODEL SWAP -> ${which} FAILED: ${e.message}`); return false; }
}
function restoreModel() { if (!NO_SWAP) { try { execFileSync("bash", [MODEL_SWAP, "35b"], { timeout: 6 * 60 * 1000, stdio: "pipe" }); log("restored 35b daily driver"); } catch (e) { log(`WARNING restore 35b failed: ${e.message}`); } } }

// ── sandbox canvas-companion ───────────────────────────────────────────────────
let sandboxProc = null;
const sandboxDb = `${SANDBOX}/canvas.sandbox.db`;
// Leak safety net — lock the prod tea_data.db DIRECTORY read-only for the window.
// The agentic bot sometimes IMPROVISES a write to the prod tea_data.db path it
// knows from its prompt (bypassing the staged loader AND the env redirect), so the
// only reliable defense is to make that path physically unwritable. A file-level
// `chmod 444` is INSUFFICIENT: tea_data.db is WAL-mode, so writes land in -wal/-shm
// created in the still-writable directory (and the file mode itself got changed) —
// this leaked 4742 rows to prod 3x before. Locking the DIRECTORY (555) blocks the
// db file, -wal, -shm, and any recreated file — verified to return SQLITE_READONLY.
// Legit redirected writes go to the SEPARATE sandbox dir (writable), so they still
// work; only writes to the prod tea dir are blocked.
import { dirname } from "node:path";
const TEA_DB_DIR = dirname(TEA_DB_PROD);
let teaDirLocked = false;
let teaDirOrigMode = null;
function lockProdTea() {
  try {
    teaDirOrigMode = fs.statSync(TEA_DB_DIR).mode & 0o777;
    fs.chmodSync(TEA_DB_DIR, 0o555);
    teaDirLocked = true;
    log(`prod tea dir locked READ-ONLY (${TEA_DB_DIR}, was ${teaDirOrigMode.toString(8)}) — leak safety net`);
  } catch (e) { log(`WARNING: could not lock prod tea dir read-only: ${e.message}`); }
}
function unlockProdTea() {
  if (!teaDirLocked) return;
  try { fs.chmodSync(TEA_DB_DIR, teaDirOrigMode || 0o755); teaDirLocked = false; log(`prod tea dir restored writable`); }
  catch (e) { log(`WARNING: could not restore prod tea dir writable: ${e.message}`); }
}

function startSandbox() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(sandboxDb + ext, { force: true }); } catch { /* */ } }
  // Copy prod canvas.db (small, no live holder during the window). Do NOT copy prod
  // tea_data.db: it is large (338MB, WAL) and held open by the texas-gov-data MCP
  // server, so `.backup` contends and hangs. The loader only CREATES research_pir*
  // tables and never reads existing tea data, so each rep gets a FRESH EMPTY tea db
  // instead (see freshTeaCopy) — faster and strictly more isolated.
  execFileSync("bash", ["-c", `sqlite3 ${CANVAS_DB_PROD} ".backup '${sandboxDb}'"`], { stdio: "pipe", timeout: 120000, killSignal: "SIGKILL" });
  lockProdTea();
  log(`sandbox canvas.db copied (prod tea now read-only; per-rep tea = fresh empty db)`);
  const env = { ...process.env, CANVAS_DB_PATH: sandboxDb, PYTHONPATH: CANVAS_APP_DIR };
  sandboxProc = spawn(CANVAS_UVICORN, ["src.web.app:app", "--host", "0.0.0.0", "--port", "8080"],
    { cwd: CANVAS_APP_DIR, env, stdio: ["ignore", fs.openSync(`${SANDBOX}/uvicorn.log`, "w"), fs.openSync(`${SANDBOX}/uvicorn.err.log`, "w")] });
  // wait for health
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (portListening()) { log(`sandbox uvicorn up on :8080 (pid ${sandboxProc.pid}) -> ${sandboxDb}`); return true; }
    execFileSync("sleep", ["1"]);
  }
  throw new Error("sandbox uvicorn did not become healthy on :8080 within 60s (see _sandbox/uvicorn.err.log)");
}
function stopSandbox() {
  if (sandboxProc && !sandboxProc.killed) { try { process.kill(sandboxProc.pid, "SIGTERM"); } catch { /* */ } log("sandbox uvicorn stopped"); }
  unlockProdTea();
}

// Deterministically point a generated loader.py at the per-rep TEA_DB copy,
// regardless of whether the bot honored the TEA_DB env override. Rewrites any
// hardcoded prod tea_data.db path (incl. the os.environ.get default) to the copy.
// Belt to the read-only safety net's suspenders: this makes reps actually PASS
// (write to the copy) instead of merely failing safely.
function redirectLoaderToCopy(stagingDir, teaCopy) {
  const lp = path.join(stagingDir, "loader.py");
  if (!fs.existsSync(lp)) return false;
  const src = fs.readFileSync(lp, "utf8");
  if (src.includes("__FF_TEA_REDIRECT__")) return true;  // idempotent
  // FORCE the TEA_DB env var to the per-rep copy before the loader's own
  // os.environ.get("TEA_DB", <prod default>) reads it at module load. Prepended
  // with its own os import so it runs first regardless of how the loader formats
  // its path definition (single- or multi-line). Covers every observed loader
  // (all use os.environ.get("TEA_DB")); the read-only prod safety net catches any
  // that hardcode the path instead.
  const inject = `import os as _ff_os  # __FF_TEA_REDIRECT__\n_ff_os.environ["TEA_DB"] = ${JSON.stringify(teaCopy)}\n`;
  let out;
  if (src.startsWith("#!")) { const nl = src.indexOf("\n"); out = src.slice(0, nl + 1) + inject + src.slice(nl + 1); }
  else out = inject + src;
  fs.writeFileSync(lp, out);
  return true;
}

// ── crow.db helpers ─────────────────────────────────────────────────────────────
function deleteBotSession(threadId) {
  const c = new Database(CROW_DB); c.pragma("busy_timeout=8000");
  c.prepare("DELETE FROM bot_sessions WHERE bot_id='pir-processor' AND gateway_thread_id=?").run(threadId); c.close();
}
function researchSourcesMax() {
  try { const c = new Database(CROW_DB, { readonly: true }); const r = c.prepare("SELECT COALESCE(MAX(id),0) AS m FROM research_sources").get(); c.close(); return r.m; }
  catch { return null; }
}
function researchSourcesCleanup(watermark) {
  if (watermark == null) return;
  try { const c = new Database(CROW_DB); c.pragma("busy_timeout=8000"); const n = c.prepare("DELETE FROM research_sources WHERE id > ?").run(watermark).changes; c.close(); if (n) log(`cleaned ${n} research_sources rows added during run`); }
  catch (e) { log(`research_sources cleanup skipped: ${e.message}`); }
}

// ── sandbox row reset (per rep) ──────────────────────────────────────────────────
function sandboxRow(pir) {
  const db = new Database(sandboxDb, { readonly: true });
  const r = db.prepare("SELECT id, pir_number, status, processing_lease_status, processing_lease, case_type, requested_items FROM pir_requests WHERE pir_number=?").get(pir);
  db.close(); return r;
}
function resetSandboxRow(pir, golden, token) {
  const db = new Database(sandboxDb); db.pragma("busy_timeout=8000");
  const ks = golden.kickoff_state || {};
  const row = db.prepare("SELECT id FROM pir_requests WHERE pir_number=?").get(pir);
  if (!row) { db.close(); die(`PIR ${pir} not in sandbox canvas.db`); }
  db.prepare(`UPDATE pir_requests SET status=COALESCE(?,status), processing_lease=?, processing_lease_status='in-progress', updated_at=datetime('now') WHERE id=?`)
    .run(ks.status || null, token, row.id);
  db.close(); return row.id;
}

// ── per-rep TEA_DB copy ──────────────────────────────────────────────────────────
function freshTeaCopy(pir, n) {
  const dst = `${SANDBOX}/tea_${pir}_${TAG}_${n}.db`;
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dst + ext, { force: true }); } catch { /* */ } }
  // Fresh EMPTY tea db (not a copy of prod). The loader CREATEs research_pir*
  // tables here and reads no existing tea data, so an empty db is sufficient and
  // strictly isolated — and there are no pre-existing tables to mask the commit.
  const db = new Database(dst); db.pragma("journal_mode = WAL"); db.close();
  return dst;
}
function teaCommittedRows(teaDb, pir) {
  try {
    const db = new Database(teaDb, { readonly: true });
    const tbls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?").all(`research_pir${pir}_%`);
    let total = 0;
    for (const t of tbls) total += db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c;
    db.close(); return tbls.length ? total : null;
  } catch { return null; }
}

// ── staging snapshot/restore (real _staging dir) ─────────────────────────────────
function snapshotStaging(pir) {
  const sdir = path.join(SOURCES, "_staging", pir);
  const snap = `${SANDBOX}/_staging_snap_${pir}`;
  try { fs.rmSync(snap, { recursive: true, force: true }); } catch { /* */ }
  if (fs.existsSync(sdir)) fs.cpSync(sdir, snap, { recursive: true });
  return { sdir, snap, existed: fs.existsSync(sdir) };
}
function restoreStaging(s) {
  try { fs.rmSync(s.sdir, { recursive: true, force: true }); } catch { /* */ }
  if (s.existed && fs.existsSync(s.snap)) fs.cpSync(s.snap, s.sdir, { recursive: true });
}

// ── fixtures / golden ─────────────────────────────────────────────────────────────
function loadGolden(pir) { const p = `${GOLDEN}/${pir}.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; }
function loadFixture(pir) { const p = `${FIXTURES}/${pir}.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; }

function computeFacts(holdingDir) {
  try {
    execFileSync(UV_BIN, ["run", "--with", "openpyxl", "python3", COMPUTE_FACTS, holdingDir], { timeout: 120000, stdio: "pipe" });
    const p = `${holdingDir}/computed_facts.json`;
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch (e) { log(`computeFacts failed: ${e.message}`); return null; }
}

// drive bridge --inject; returns {stdout, exit, reply, result}
function bridgeInject(threadId, userMessage, env) {
  const payload = JSON.stringify({ bot_id: "pir-processor", gateway_thread_id: threadId, user_message: userMessage });
  let stdout = "", exit = 0;
  try {
    stdout = execFileSync(process.execPath, [BRIDGE, "--inject", payload],
      { timeout: RUN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PIBOT_TURN_TIMEOUT_MS: TURN_TIMEOUT_MS, ...env } }).toString();
  } catch (e) { exit = e.status ?? 1; stdout = (e.stdout ? e.stdout.toString() : "") + "\n[STDERR]\n" + (e.stderr ? e.stderr.toString() : ""); }
  const replyM = stdout.match(/REPLY>>>\n([\s\S]*?)\n<<<REPLY/);
  const resultM = stdout.match(/RESULT (\{[\s\S]*\})\s*$/m);
  let result = null; try { result = resultM ? JSON.parse(resultM[1]) : null; } catch { /* */ }
  return { stdout, exit, reply: replyM ? replyM[1] : null, result };
}

// ── one rep ────────────────────────────────────────────────────────────────────────
function runRep(pir, golden, fixture, caseType, n) {
  const threadId = `ff-${pir}-${TAG}-${n}-${crypto.randomUUID().slice(0, 8)}`;
  const token = `ff-${crypto.randomUUID()}`;
  const outDir = `${RESULTS}/${TAG}/${pir}/run${n}`;
  fs.mkdirSync(outDir, { recursive: true });
  const holdingDir = path.join(SOURCES, "pir-incoming", pir);
  const stagingDir = path.join(SOURCES, "_staging", pir);
  const stages = [];

  // INGEST (deterministic, no model)
  const replay = fixture ? ingestReplay(fixture) : null;
  stages.push(A.assertIngest({ golden, replay }));

  if (INGEST_ONLY) {
    const verdict = A.rollup(stages);
    fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ pir, tag: TAG, run: n, case_type: caseType, stages, verdict, ingest_only: true }, null, 2));
    return { pir, run: n, stages, verdict };
  }

  // sandbox + fs reset
  const sSnap = snapshotStaging(pir);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const pirId = resetSandboxRow(pir, golden, token);
  deleteBotSession(threadId);
  const teaDb = caseType === "delivery" ? freshTeaCopy(pir, n) : null;
  const rsWatermark = researchSourcesMax();
  const facts = computeFacts(holdingDir);

  // DISPATCH + BOT (kickoff)
  let requestedItems = null;
  try { const r = sandboxRow(pir); requestedItems = r && r.requested_items ? JSON.parse(r.requested_items) : null; } catch { /* */ }
  const bodyFile = fs.existsSync(`${holdingDir}/email_body.txt`) ? `${holdingDir}/email_body.txt` : null;
  const kickoff = JSON.stringify({
    pir_id: pirId, pir_number: pir, holding_dir: holdingDir, trigger: "queued",
    case_type: caseType, body_file: bodyFile, requested_items: requestedItems,
    computed_facts: facts, lease_token: token,
  });
  const t0 = Date.now();
  const kEnv = teaDb ? { TEA_DB: teaDb } : {};
  const k = bridgeInject(threadId, kickoff, kEnv);
  const kickoffWall = Date.now() - t0;
  fs.writeFileSync(path.join(outDir, "kickoff.log"), k.stdout);
  if (fs.existsSync(stagingDir)) fs.cpSync(stagingDir, path.join(outDir, "staging"), { recursive: true });
  stages.push(A.assertBot({ golden, stagingDir, botResult: k.result }));

  // VALIDATE (count gate, mirrors production validateClaims + golden cross-check)
  stages.push(A.assertValidate({ golden, stagingDir, computedFacts: facts }));

  // APPROVE -> CLOSE
  let approveWall = null, committed = null, rowAfter = null;
  if (!NO_APPROVE) {
    // Force the staged loader to write to the per-rep TEA_DB copy regardless of
    // whether the bot honored the TEA_DB env override (the env did not reliably
    // reach the bot's subprocess at N=5, causing a real prod leak before this).
    if (teaDb) { const r = redirectLoaderToCopy(stagingDir, teaDb); if (r) log(`  redirected loader.py -> TEA_DB copy`); }
    const ta = Date.now();
    const a = bridgeInject(threadId, "APPROVE", kEnv);
    approveWall = Date.now() - ta;
    fs.writeFileSync(path.join(outDir, "approve.log"), a.stdout);
    if (fs.existsSync(stagingDir)) fs.cpSync(stagingDir, path.join(outDir, "staging_after_approve"), { recursive: true });
    if (teaDb) committed = teaCommittedRows(teaDb, pir);
    rowAfter = sandboxRow(pir);
    stages.push(A.assertClose({ golden, stagingDir, dbRowAfter: rowAfter, teaCommittedRows: committed }));
  }

  const verdict = A.rollup(stages);
  const meta = {
    pir, tag: TAG, run: n, case_type: caseType, thread_id: threadId, verdict,
    kickoff_exit: k.exit, kickoff_wall_ms: kickoffWall, approve_wall_ms: approveWall,
    committed_rows: committed, row_after: rowAfter, stages,
    staging_files: fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [],
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

  // per-rep cleanup
  researchSourcesCleanup(rsWatermark);
  deleteBotSession(threadId);
  restoreStaging(sSnap);
  if (teaDb) for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(teaDb + ext, { force: true }); } catch { /* */ } }
  log(`  rep ${n} verdict=${verdict} [${stages.map((s) => `${s.stage}:${s.verdict}`).join(" ")}] kwall=${(kickoffWall / 1000).toFixed(0)}s`);
  return { pir, run: n, stages, verdict };
}

// ── per PIR ──────────────────────────────────────────────────────────────────────
function runPir(pir) {
  const golden = loadGolden(pir);
  if (!golden) { log(`SKIP ${pir}: no golden ref at ${GOLDEN}/${pir}.json`); return []; }
  const fixture = loadFixture(pir);
  if (!fixture) log(`WARN ${pir}: no fixture at ${FIXTURES}/${pir}.json — INGEST will FAIL`);
  const caseType = golden.case_type || (golden.close && golden.close.type === "delivery" ? "delivery" : "correspondence");
  if (!INGEST_ONLY) {
    const want = caseType === "delivery" ? "35b" : "27b";
    if (!swap(want)) { log(`SKIP ${pir}: model swap to ${want} failed`); return []; }
  }
  log(`PIR ${pir} (case_type=${caseType}) x${RUNS} rep(s)`);
  const reps = [];
  for (let n = 1; n <= RUNS; n++) reps.push(runRep(pir, golden, fixture, caseType, n));
  return reps;
}

// ── verdict matrix report ────────────────────────────────────────────────────────
function writeReport(allReps) {
  fs.mkdirSync(RESULTS, { recursive: true });
  const byPir = {};
  for (const r of allReps) { (byPir[r.pir] ||= []).push(r); }
  const lines = [];
  lines.push(`# PIR full-flow verdict matrix — tag=${TAG}`);
  lines.push("");
  lines.push(`Generated for ${Object.keys(byPir).length} PIR(s), ${RUNS} rep(s) each. Bar: zero FAIL; deterministic stages all PASS; model stages PASS-or-ESCALATE; identical verdict across reps.`);
  lines.push("");
  lines.push("| PIR | reps | INGEST | BOT | VALIDATE | CLOSE | run-verdict | stable? |");
  lines.push("|---|---|---|---|---|---|---|---|");
  const STAGES = ["ingest", "bot", "validate", "close"];
  let anyFail = false, anyUnstable = false;
  for (const [pir, reps] of Object.entries(byPir)) {
    const cell = (stg) => {
      const vs = reps.map((r) => (r.stages.find((s) => s.stage === stg) || {}).verdict || "-");
      const uniq = [...new Set(vs)];
      return uniq.length === 1 ? uniq[0] : `FLAP(${vs.join("/")})`;
    };
    const rv = [...new Set(reps.map((r) => r.verdict))];
    const stable = rv.length === 1 && !STAGES.some((s) => cell(s).startsWith("FLAP"));
    if (reps.some((r) => r.verdict === A.FAIL)) anyFail = true;
    if (!stable) anyUnstable = true;
    lines.push(`| ${pir} | ${reps.length} | ${cell("ingest")} | ${cell("bot")} | ${cell("validate")} | ${cell("close")} | ${rv.join("/")} | ${stable ? "yes" : "NO"} |`);
  }
  lines.push("");
  lines.push(`**Result:** ${anyFail ? "❌ FAIL present" : "✅ zero FAIL"}; ${anyUnstable ? "⚠️ unstable verdicts present" : "✅ all verdicts stable across reps"}.`);
  const out = `${RESULTS}/REPORT.md`;
  fs.writeFileSync(out, lines.join("\n") + "\n");
  log(`report -> ${out}`);
  console.log("\n" + lines.join("\n"));
}

// ── main ─────────────────────────────────────────────────────────────────────────
function tier1Pirs() {
  if (!fs.existsSync(GOLDEN)) return [];
  return fs.readdirSync(GOLDEN).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

async function main() {
  if (!ALL && !PIR_ARG) die("need --pir <pir_number> or --all");
  const pirs = ALL ? tier1Pirs() : [PIR_ARG];
  if (!pirs.length) die("no PIRs to run (no golden refs?)");

  // Preflight that must refuse BEFORE opening the window (no prod mutation yet).
  if (!INGEST_ONLY && !SUDO_PASS) {
    for (const t of ["mpa-pir-response-sync.timer", "mpa-pir-processor-dispatch.timer"]) {
      if (timerActive(t)) die(`${t} is active — stop the PIR timers (or set LAB_SUDO_PASS to self-manage the window)`);
    }
    if (portListening()) die("something is already listening on :8080 — stop canvas-companion-web (or set LAB_SUDO_PASS)");
  }

  const allReps = [];
  try {
    // Open the window INSIDE the try so any setup failure still hits teardown()
    // (restart services, disarm deadman, unlock tea). Errors here throw, never die().
    if (!INGEST_ONLY) {
      if (SUDO_PASS) {
        sudoSystemctl("stop");
        for (let i = 0; i < 10 && portListening(); i++) execFileSync("sleep", ["1"]);
        if (portListening()) throw new Error(":8080 still occupied after stopping prod services");
      }
      armDeadman();   // hard window cap is now active (out-of-process)
      startSandbox();
    }
    for (const pir of pirs) allReps.push(...runPir(pir));
  } finally {
    if (!INGEST_ONLY) teardown();
  }
  writeReport(allReps);
  const anyFail = allReps.some((r) => r.verdict === A.FAIL);
  if (!KEEP_SANDBOX) { try { fs.rmSync(`${SANDBOX}/canvas.sandbox.db`, { force: true }); } catch { /* */ } }
  log(`done: ${allReps.length} rep(s); ${anyFail ? "FAIL present" : "zero FAIL"}`);
  process.exit(anyFail ? 1 : 0);
}

// Full restore: disarm the deadman, free :8080 + unlock tea (stopSandbox), restore
// the 35B, and restart prod services if the harness owns them.
function teardown() { disarmDeadman(); stopSandbox(); restoreModel(); if (SUDO_PASS) sudoSystemctl("start"); }
process.on("SIGINT", () => { teardown(); process.exit(1); });
process.on("SIGTERM", () => { teardown(); process.exit(1); });
// Last-resort: never leave prod tea_data.db read-only or the deadman armed.
process.on("exit", () => { try { disarmDeadman(); unlockProdTea(); } catch { /* */ } });
main().catch((e) => { log("FATAL: " + (e && e.message || e)); process.exit(1); });
