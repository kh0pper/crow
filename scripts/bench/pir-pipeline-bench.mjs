#!/usr/bin/env node
// pir-pipeline-bench.mjs — replay one PIR through the (unmodified) pir-processor
// bot N times under whatever model is currently configured/served, capturing
// staging artifacts + token/latency telemetry. Snapshot-bracketed: restores the
// tracker row from the pre-benchmark snapshot before EACH run so runs are
// independent. Model selection + serving are handled OUTSIDE this script (flip
// def.models.default + serve the matching GGUF on :8003); this script only
// replays and measures.
//
// Usage:
//   node pir-pipeline-bench.mjs --pir <pir_number> --tag <modelTag> --runs <n> [--case-type <t>]
//
// Isolation: the PIR systemd timers MUST be stopped (sole-writer guarantee).
// Production rows are restored from _snapshots/pir_rows.snapshot.sql each run.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const BRIDGE = "/home/kh0pp/crow/scripts/pi-bots/bridge.mjs";
const CANVAS_DB = "/home/kh0pp/spring-2026/canvas-companion/db/canvas.db";
const CROW_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
const SOURCES = "/home/kh0pp/spring-2026/insd-5941/sources";
const SNAP = "/home/kh0pp/crow/scripts/bench/results/pir-pipeline/_snapshots";
const RESULTS = "/home/kh0pp/crow/scripts/bench/results/pir-pipeline";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
}
const PIR = arg("pir");
const TAG = arg("tag");
const RUNS = parseInt(arg("runs", "1"), 10);
const CASE_TYPE_OVERRIDE = arg("case-type", null);
if (!PIR || !TAG) { console.error("need --pir and --tag"); process.exit(1); }

function restoreRowsSnapshot() {
  const sql = fs.readFileSync(path.join(SNAP, "pir_rows.snapshot.sql"), "utf8");
  const db = new Database(CANVAS_DB);
  db.pragma("busy_timeout=8000");
  db.exec(sql);
  db.close();
}

function rowFor(pir) {
  const db = new Database(CANVAS_DB, { readonly: true });
  const r = db.prepare("SELECT id, pir_number, case_type, requested_items FROM pir_requests WHERE pir_number=?").get(pir);
  db.close();
  return r;
}

function setLease(pirId, token) {
  const db = new Database(CANVAS_DB);
  db.pragma("busy_timeout=8000");
  db.prepare("UPDATE pir_requests SET processing_lease=?, processing_lease_status='in-progress', updated_at=datetime('now') WHERE id=?").run(token, pirId);
  db.close();
}

function sessionTelemetry(threadId) {
  const db = new Database(CROW_DB, { readonly: true });
  const s = db.prepare("SELECT pi_session_id, pi_session_dir, model FROM bot_sessions WHERE bot_id='pir-processor' AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  db.close();
  if (!s) return { found: false };
  // locate the session JSONL. NOTE: pi_session_dir ALREADY ends in /sessions.
  let jsonl = null;
  const sdir = s.pi_session_dir || "";
  try {
    const cands = fs.readdirSync(sdir).filter((f) => f.endsWith(".jsonl"));
    jsonl = cands.find((f) => s.pi_session_id && f.includes(s.pi_session_id.replace(/-/g, "")))
         || cands.find((f) => s.pi_session_id && f.includes(s.pi_session_id))
         || cands.map((f) => ({ f, m: fs.statSync(path.join(sdir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f;
  } catch { /* no dir */ }
  let inTok = 0, outTok = 0, tFirst = null, tLast = null, msgs = 0;
  if (jsonl) {
    for (const line of fs.readFileSync(path.join(sdir, jsonl), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const u = e?.message?.usage || e?.usage;
      if (u) { inTok += u.input || 0; outTok += u.output || 0; msgs++; }
      const tsRaw = e?.message?.timestamp || e?.timestamp;
      const ts = typeof tsRaw === "number" ? tsRaw : (tsRaw ? Date.parse(tsRaw) : NaN);
      if (!isNaN(ts)) { tFirst = tFirst == null ? ts : Math.min(tFirst, ts); tLast = tLast == null ? ts : Math.max(tLast, ts); }
    }
  }
  const spanMs = (tFirst != null && tLast != null) ? (tLast - tFirst) : null;
  return { found: true, pi_session_id: s.pi_session_id, model: s.model, jsonl,
    tokens_in: inTok, tokens_out: outTok, msgs,
    span_ms: spanMs, gen_tok_s: (spanMs && outTok) ? +(outTok / (spanMs / 1000)).toFixed(2) : null };
}

const row = rowFor(PIR);
if (!row) { console.error(`PIR ${PIR} not found`); process.exit(1); }
const caseType = CASE_TYPE_OVERRIDE || row.case_type || "delivery";
let requestedItems = null;
try { requestedItems = row.requested_items ? JSON.parse(row.requested_items) : null; } catch { requestedItems = null; }
const holdingDir = path.join(SOURCES, "pir-incoming", PIR);
const bodyFile = fs.existsSync(path.join(holdingDir, "email_body.txt")) ? path.join(holdingDir, "email_body.txt") : null;
const stagingDir = path.join(SOURCES, "_staging", PIR);

for (let n = 1; n <= RUNS; n++) {
  const threadId = `bench-${PIR}-${TAG}-${n}`;
  const token = `bench-${crypto.randomUUID()}`;
  const outDir = path.join(RESULTS, TAG, PIR, `run${n}`);
  fs.mkdirSync(outDir, { recursive: true });

  restoreRowsSnapshot();                 // clean starting context
  setLease(row.id, token);               // satisfy the bot's lease check
  fs.rmSync(stagingDir, { recursive: true, force: true });  // clean staging

  // Mirror the dispatcher: precompute deterministic facts + inject (count guardrail).
  let computedFacts = null;
  try {
    execFileSync("python3", ["/home/kh0pp/crow/scripts/bots/pir_compute_facts.py", holdingDir], { timeout: 120000, stdio: "pipe" });
    const cfp = path.join(holdingDir, "computed_facts.json");
    if (fs.existsSync(cfp)) computedFacts = JSON.parse(fs.readFileSync(cfp, "utf8"));
  } catch { /* advisory */ }
  const kickoff = JSON.stringify({
    pir_id: row.id, pir_number: PIR, holding_dir: holdingDir, trigger: "queued",
    case_type: caseType, body_file: bodyFile, requested_items: requestedItems,
    computed_facts: computedFacts, lease_token: token,
  });
  const payload = JSON.stringify({ bot_id: "pir-processor", gateway_thread_id: threadId, user_message: kickoff });

  console.error(`[bench] ${threadId} (case_type=${caseType}) ...`);
  const t0 = Date.now();
  let stdout = "", exit = 0;
  try {
    stdout = execFileSync(process.execPath, [BRIDGE, "--inject", payload],
      { timeout: Number(process.env.PIR_BENCH_RUN_TIMEOUT_MS || 30 * 60 * 1000),
        maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).toString();
  } catch (e) { exit = e.status ?? 1; stdout = (e.stdout ? e.stdout.toString() : "") + "\n[STDERR]\n" + (e.stderr ? e.stderr.toString() : ""); }
  const wall = Date.now() - t0;

  fs.writeFileSync(path.join(outDir, "bridge.log"), stdout);
  // capture staging output
  if (fs.existsSync(stagingDir)) {
    fs.cpSync(stagingDir, path.join(outDir, "staging"), { recursive: true });
  }
  // parse reply + RESULT
  const replyM = stdout.match(/REPLY>>>\n([\s\S]*?)\n<<<REPLY/);
  const resultM = stdout.match(/RESULT (\{[\s\S]*\})\s*$/m);
  let result = null; try { result = resultM ? JSON.parse(resultM[1]) : null; } catch { /* */ }
  const tel = sessionTelemetry(threadId);

  const meta = {
    pir: PIR, tag: TAG, run: n, case_type: caseType, exit, wall_ms: wall,
    reply_text: replyM ? replyM[1] : null,
    result_action: result?.action ?? null,
    tool_calls: result?.toolCalls?.length ?? null,
    tool_errors: result?.toolCalls?.filter((c) => c.isError)?.length ?? null,
    pi_session_id: result?.piSessionId ?? tel.pi_session_id ?? null,
    model: tel.model ?? null,
    tokens_in: tel.tokens_in ?? null, tokens_out: tel.tokens_out ?? null,
    gen_tok_s: tel.gen_tok_s ?? null, span_ms: tel.span_ms ?? null,
    staging_files: fs.existsSync(path.join(outDir, "staging")) ? fs.readdirSync(path.join(outDir, "staging")) : [],
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  console.error(`[bench]   exit=${exit} wall=${(wall / 1000).toFixed(1)}s tok_out=${meta.tokens_out} gen_tok/s=${meta.gen_tok_s} files=[${meta.staging_files.join(",")}]`);
}

// leave the row restored to snapshot at the end of this PIR's runs
restoreRowsSnapshot();
console.error(`[bench] done: ${RUNS} run(s) of PIR ${PIR} under ${TAG}`);
