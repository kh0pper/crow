#!/usr/bin/env node
// dispatch_pir_processor.mjs — Dispatcher for the pir-processor bot.
//
// Scans canvas.db for PIRs with processing_lease_status='queued' (or accepts
// --pir-id N for manual dispatch). Claims an atomic lease, creates a Gmail
// review thread, then invokes bridge.mjs --inject with the real thread ID
// so bridge_tick can later match user replies.
//
// Modes:
//   node dispatch_pir_processor.mjs                          # scan queue
//   node dispatch_pir_processor.mjs --pir-id 44              # manual dispatch
//   node dispatch_pir_processor.mjs --pir-id 44 --trigger load-committed
//   node dispatch_pir_processor.mjs --pir-id 44 --trigger portal-check
//
// Stale-lease recovery: leases with status='in-progress' older than 35 min
// are auto-cleared on each scan. 'awaiting-review' leases are NOT cleared
// (user may take hours to reply).

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { google } from "/home/kh0pp/crow/node_modules/googleapis/build/src/index.js";
import { marked } from "/home/kh0pp/crow/node_modules/marked/lib/marked.esm.js";

const CANVAS_DB = "/home/kh0pp/spring-2026/canvas-companion/db/canvas.db";
const BRIDGE_PATH = "/home/kh0pp/crow/scripts/pi-bots/bridge.mjs";
const SOURCES_ROOT = "/home/kh0pp/spring-2026/insd-5941/sources";
const STALE_MINUTES = 35;
const API_BASE = "http://localhost:8080";

const TOKEN_PATH = process.env.PIR_GMAIL_TOKEN_PATH
  || "/home/kh0pp/.config/google-workspace-mcp/token.json";
const CREDS_PATH = process.env.PIR_GMAIL_CREDS_PATH
  || "/home/kh0pp/.config/google-workspace-mcp/credentials.json";

const REVIEW_REPLY_TO = "kevin.hopper+pir-processor@maestro.press";
const USER_EMAIL = "kevin.hopper1@gmail.com";

// ── On-demand model swap ──────────────────────────────────────────────────────
// The PIR bot runs on the dense 27B (better reliability on PIR reasoning), which
// cannot co-reside with the 35B daily driver (crow-chat) on the Strix Halo. So
// when this tick will run the bot, we borrow :8003 for the 27B and hand it back
// to the 35B afterward. Fail-safe: an exit/signal hook restores the 35B even on
// crash/SIGTERM so the daily driver is never left down.
const MODEL_SWAP = "/home/kh0pp/crow/scripts/bots/pir_model_swap.sh";
const MODEL_SWAP_TIMEOUT = Number(process.env.PIR_MODEL_SWAP_TIMEOUT_MS || 6 * 60 * 1000);
let swappedToPir = false;
function ensurePirModel() {
  try { execFileSync("bash", [MODEL_SWAP, "27b"], { timeout: MODEL_SWAP_TIMEOUT, stdio: "pipe" }); swappedToPir = true; return true; }
  catch (e) { log(`MODEL SWAP -> 27b FAILED: ${e.message}`); swappedToPir = false; return false; }
}
function restoreDailyModel() {
  if (!swappedToPir) return;
  try { execFileSync("bash", [MODEL_SWAP, "35b"], { timeout: MODEL_SWAP_TIMEOUT, stdio: "pipe" }); log("Restored 35b daily driver on :8003."); }
  catch (e) { log(`WARNING: restore 35b FAILED: ${e.message}`); }
  swappedToPir = false;
}
process.on("exit", () => { if (swappedToPir) { try { execFileSync("bash", [MODEL_SWAP, "35b"], { timeout: MODEL_SWAP_TIMEOUT, stdio: "ignore" }); } catch { /* best effort */ } } });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restoreDailyModel(); process.exit(1); });

// HYBRID model policy: the 27B helps on reply REASONING (correspondence /
// cost-estimate / no-responsive — where the miscount/redundant-reply bug lived);
// the 35B does data DELIVERIES faster (~5 min) and with exact CSV counts. So we
// borrow :8003 for the 27B only on reply cases and keep deliveries on the 35B.
// To make the bot use the 27B for EVERYTHING instead, change this to `return true`.
function prepareModelFor(pir) {
  if (isReplyCase(pir)) return ensurePirModel();   // swap in the 27B (may fail)
  restoreDailyModel();                             // delivery: ensure 35B (no-op if resident)
  return true;
}

// ── Deterministic advisory facts (the count guardrail) ───────────────────────
// Compute verifiable counts (CSV rows, parseable PDF entity tallies) BEFORE the
// bot runs so it never eyeballs a number. Advisory only — validateClaims escalates
// on disagreement, never overrides the model with a possibly-wrong computed value.
const COMPUTE_FACTS = "/home/kh0pp/crow/scripts/bots/pir_compute_facts.py";
function computeFacts(holdingDir) {
  if (!fs.existsSync(holdingDir)) return null;
  try {
    execFileSync("python3", [COMPUTE_FACTS, holdingDir], { timeout: 120000, stdio: "pipe" });
    const p = `${holdingDir}/computed_facts.json`;
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch (e) { log(`computeFacts failed for ${holdingDir}: ${e.message}`); return null; }
}
// Flatten computed_facts into the set of numeric tallies a reply may legitimately
// state (CSV row counts + total, PDF labeled/bullet counts). Used by validateClaims.
function verifiedCounts(facts) {
  const s = new Set();
  if (!facts) return s;
  if (typeof facts.csv_row_total === "number") s.add(facts.csv_row_total);
  for (const f of facts.files || []) {
    if (typeof f.rows === "number") s.add(f.rows);
    const pl = f.pdf_list;
    if (pl && !pl.unparseable) {
      if (typeof pl.bullet_total === "number") s.add(pl.bullet_total);
      for (const v of Object.values(pl.labeled_counts || {})) s.add(v);
      for (const sec of pl.sections || []) if (typeof sec.count === "number") s.add(sec.count);
    }
  }
  return s;
}

// Phase 2 — GovQA portal driver invocation.
// uv is NOT on the systemd unit's PATH, so invoke it by absolute path.
const UV_BIN = process.env.UV_BIN || "/home/kh0pp/.local/bin/uv";
const GOVQA_DRIVER = "/home/kh0pp/crow/scripts/bots/govqa_drive.py";
// Per-tenant credential store: 0600 JSON keyed by portal_base (or its hostname)
// → {"user": "...", "pass": "..."}. Read by the dispatcher and passed to the
// driver inline as env (never written to a file or logged by the driver).
const GOVQA_SECRETS = process.env.GOVQA_SECRETS_PATH || "/home/kh0pp/.crow/secrets/govqa.json";
// Validated GovQA compose selectors (govqa-portal skill, 2026-05-22). Dallas /
// mycusthelp tenants render a different compose form — override per-tenant via
// env if a non-GovQA tenant is added.
const PORTAL_REPLY_SELECTOR = process.env.PORTAL_REPLY_SELECTOR || "#pnlEdit_RespondFormLayout_txtMessage_I";
const PORTAL_SUBMIT_SELECTOR = process.env.PORTAL_SUBMIT_SELECTOR || "#pnlEdit_RespondFormLayout_btnSend_I";

function loadPortalCreds(portalBase) {
  let all;
  try {
    all = JSON.parse(fs.readFileSync(GOVQA_SECRETS, "utf8"));
  } catch (e) {
    log(`PORTAL: cannot read creds store ${GOVQA_SECRETS}: ${e.message}`);
    return null;
  }
  if (all[portalBase] && all[portalBase].user) return all[portalBase];
  let host = null;
  try { host = new URL(portalBase).host; } catch { /* not a URL */ }
  for (const [k, v] of Object.entries(all)) {
    if (!v || !v.user) continue;
    if (k === host) return v;
    try { if (host && new URL(k).host === host) return v; } catch { /* skip */ }
  }
  return null;
}

// Run the GovQA driver under uv with creds passed inline as env. Returns
// {ok, code, out}. Never throws; the caller decides needs-human on failure.
function runGovqa(action, { base, rid, dest, replyFile, replySelector, submitSelector, shot }, creds) {
  const a = [UV_BIN, "run", "--with", "playwright", "python", GOVQA_DRIVER,
    "--action", action, "--base", base, "--rid", String(rid)];
  if (dest) a.push("--dest", dest);
  if (replyFile) a.push("--reply-file", replyFile);
  if (replySelector) a.push("--reply-selector", replySelector);
  if (submitSelector) a.push("--submit-selector", submitSelector);
  if (shot) a.push("--shot", shot);
  const env = { ...process.env, GOVQA_USER: creds.user, GOVQA_PASS: creds.pass };
  try {
    const out = execFileSync(a[0], a.slice(1), {
      env, timeout: 5 * 60 * 1000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024,
    }).toString();
    return { ok: true, code: 0, out };
  } catch (err) {
    const out = (err.stdout ? err.stdout.toString() : "") + (err.stderr ? err.stderr.toString() : "");
    return { ok: false, code: err.status ?? 1, out };
  }
}

function setNeedsHuman(db, pirId, token, reason) {
  db.prepare(`UPDATE pir_requests SET processing_lease_status = 'needs-human', updated_at = datetime('now')
              WHERE id = ? AND processing_lease = ?`).run(pirId, token);
  log(`Set needs-human on PIR id=${pirId}: ${reason}`);
}

// portal-check: download produced records into the holding dir, fail-loud to
// needs-human (never silent). Returns true if records landed (caller then
// dispatches as a normal delivery run).
function runPortalCheck(db, pir, token) {
  if (!pir.portal_base || !pir.portal_rid) {
    setNeedsHuman(db, pir.id, token, `portal-check: portal_base/portal_rid not set (base=${pir.portal_base || "∅"}, rid=${pir.portal_rid || "∅"})`);
    return false;
  }
  const creds = loadPortalCreds(pir.portal_base);
  if (!creds) {
    setNeedsHuman(db, pir.id, token, `portal-check: no credentials for ${pir.portal_base} in ${GOVQA_SECRETS}`);
    return false;
  }
  const holdingDir = `${SOURCES_ROOT}/pir-incoming/${pir.pir_number}`;
  fs.mkdirSync(holdingDir, { recursive: true });
  const shot = `${holdingDir}/_portal_recon.png`;
  log(`portal-check: downloading records for PIR #${pir.pir_number} from ${pir.portal_base} rid=${pir.portal_rid}`);
  const r = runGovqa("download", { base: pir.portal_base, rid: pir.portal_rid, dest: holdingDir, shot }, creds);
  log(`portal-check download (exit ${r.code}):\n${r.out.slice(0, 2000)}`);
  if (!r.ok) {
    setNeedsHuman(db, pir.id, token, `portal-check: download failed (exit ${r.code}); see ${shot}`);
    return false;
  }
  return true;
}

function mimeSubject(s) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

function buildMimeEmail({ from, to, replyTo, subject, textBody, threadId }) {
  const boundary = "----=_Part_" + crypto.randomUUID().replace(/-/g, "");
  const htmlBody = marked.parse(textBody);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${mimeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(textBody, "utf8").toString("base64"),
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(htmlBody, "utf8").toString("base64"),
    `--${boundary}--`,
  ];
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n")).toString("base64url");
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function die(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }

function makeAuth() {
  const tk = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  const cr = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")).installed;
  const auth = new google.auth.OAuth2(cr.client_id, cr.client_secret);
  auth.setCredentials({
    access_token: tk.token,
    refresh_token: tk.refresh_token,
    expiry_date: new Date(tk.expiry).getTime(),
  });
  return auth;
}

async function createReviewThread(gmail, pir) {
  const subject = `[PIR #${pir.pir_number}] Review - ${pir.label}`;
  const body = `PIR processor starting on #${pir.pir_number}. Review email with cross-reference analysis will follow.\n\nReply to this thread to **APPROVE**, **REVISE**, or **REJECT**.`;

  const encoded = buildMimeEmail({
    from: USER_EMAIL, to: USER_EMAIL, replyTo: REVIEW_REPLY_TO,
    subject, textBody: body,
  });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  return { threadId: res.data.threadId, messageId: res.data.id, subject };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const result = { pirId: null, trigger: "queued" };
  const pidx = a.indexOf("--pir-id");
  if (pidx !== -1) result.pirId = parseInt(a[pidx + 1], 10);
  const tidx = a.indexOf("--trigger");
  if (tidx !== -1) result.trigger = a[tidx + 1];
  if (!["queued", "load-committed", "portal-check"].includes(result.trigger)) {
    die(`Invalid trigger: ${result.trigger}`);
  }
  return result;
}

function checkApiUp() {
  try {
    execSync(`curl -s -o /dev/null -w '%{http_code}' ${API_BASE}/api/pir/1 | grep -qE '^(200|404)$'`, { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function clearStaleLeases(db) {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const stale = db.prepare(`
    SELECT id, pir_number FROM pir_requests
    WHERE processing_lease IS NOT NULL
    AND processing_lease_status = 'in-progress'
    AND updated_at < ?
  `).all(cutoff);
  for (const row of stale) {
    log(`Clearing stale lease on PIR #${row.pir_number} (id=${row.id})`);
    db.prepare(`UPDATE pir_requests SET processing_lease = NULL, processing_lease_status = 'queued', updated_at = datetime('now') WHERE id = ?`).run(row.id);
  }
  return stale.length;
}

function claimLease(db, pirId, trigger) {
  const token = crypto.randomUUID();
  const allowedStates = ["queued", "done"];
  if (trigger === "load-committed") allowedStates.push("awaiting-load", "awaiting-review");
  if (trigger === "portal-check") allowedStates.push("awaiting-load", "done");
  const placeholders = allowedStates.map(() => "?").join(",");
  const result = db.prepare(`
    UPDATE pir_requests
    SET processing_lease = ?, processing_lease_status = 'in-progress', updated_at = datetime('now')
    WHERE id = ?
    AND (processing_lease IS NULL OR processing_lease_status IN (${placeholders}))
  `).run(token, pirId, ...allowedStates);
  if (result.changes === 0) {
    return null;
  }
  return token;
}

function getQueuedPirs(db) {
  return db.prepare(`
    SELECT id, pir_number, label, recipient_email,
           case_type, requested_items, portal_base, portal_rid
    FROM pir_requests
    WHERE processing_lease_status = 'queued'
    AND (processing_lease IS NULL OR processing_lease = '')
    ORDER BY updated_at ASC
  `).all();
}

function getPir(db, pirId) {
  return db.prepare(`SELECT id, pir_number, label, status, review_thread_id, recipient_email,
    case_type, requested_items, portal_base, portal_rid
    FROM pir_requests WHERE id = ?`).get(pirId);
}

async function sendReviewEmail(_gmail, pir, threadId) {
  const gmail = google.gmail({ version: "v1", auth: makeAuth() });
  const candidates = ["review_email.md", "gateway_review.md"];
  let reviewPath = null;
  for (const name of candidates) {
    const p = `${SOURCES_ROOT}/_staging/${pir.pir_number}/${name}`;
    if (fs.existsSync(p)) { reviewPath = p; break; }
  }
  if (!reviewPath) {
    log(`No review email found in _staging/${pir.pir_number}/ — skipping send.`);
    return false;
  }
  const body = fs.readFileSync(reviewPath, "utf8");
  const subject = `Re: [PIR #${pir.pir_number}] Review - ${pir.label}`;
  const encoded = buildMimeEmail({
    from: USER_EMAIL, to: USER_EMAIL, replyTo: REVIEW_REPLY_TO,
    subject, textBody: body,
  });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId },
  });
  log(`Review email sent on thread ${threadId} (message ${res.data.id})`);
  return true;
}

// ── Voice normalizer (local-model output safety net) ─────────────────────────
// The bot runs on a local model that intermittently drops the "no em dashes"
// voice rule. Strip em/en dashes from outbound drafts before the review email
// goes out, rather than relying on the prompt alone (per the validate-don't-
// prompt-engineer pattern). en dash between digits = numeric range -> hyphen;
// any other em/en dash -> comma (collapsing surrounding whitespace).
function normalizeVoice(text) {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")     // 2021–22 -> 2021-22 (unicode range)
    .replace(/\s*[—–]\s*/g, ", ")                 // unicode em/en dash -> comma
    .replace(/(\S) +-{2,} +(\S)/g, "$1, $2")      // ASCII em-dash substitute "word -- word"
                                                  // (literal spaces required: leaves
                                                  // markdown --- rules and |---| tables alone)
    .replace(/ +,/g, ",")
    .replace(/,\s*,/g, ",");
}
function normalizeStagingFiles(stagingDir, names) {
  for (const name of names) {
    const p = `${stagingDir}/${name}`;
    if (!fs.existsSync(p)) continue;
    const before = fs.readFileSync(p, "utf8");
    const after = normalizeVoice(before);
    if (after !== before) {
      fs.writeFileSync(p, after);
      log(`VOICE: normalized em/en dashes in ${name}`);
    }
  }
}

function validateStaging(pir, db) {
  const stagingDir = `${SOURCES_ROOT}/_staging/${pir.pir_number}`;
  if (!fs.existsSync(stagingDir)) {
    log(`VALIDATE: staging dir missing at ${stagingDir}`);
    return false;
  }

  const required = ["review_email.md", "loader.py", "source_inventory.json", "draft_acknowledgment.txt", "README.md"];
  const altNames = { "review_email.md": ["gateway_review.md"] };
  const missing = [];
  for (const name of required) {
    const primary = `${stagingDir}/${name}`;
    if (fs.existsSync(primary)) continue;
    const alts = altNames[name] || [];
    const found = alts.some(a => fs.existsSync(`${stagingDir}/${a}`));
    if (!found) missing.push(name);
  }
  if (missing.length) {
    log(`VALIDATE: missing staging files: ${missing.join(", ")}`);
    return false;
  }

  const loaderPath = `${stagingDir}/loader.py`;
  let dryRunOutput;
  for (const args of [[loaderPath, "--dry-run"], [loaderPath]]) {
    try {
      dryRunOutput = execFileSync("python3", args, {
        timeout: 60000, stdio: ["pipe", "pipe", "pipe"], cwd: stagingDir,
      }).toString();
      break;
    } catch (err) {
      dryRunOutput = null;
    }
  }
  if (!dryRunOutput) {
    log(`VALIDATE: loader dry-run failed (tried with and without --dry-run flag)`);
    return false;
  }

  // Parse grand total — accept multiple output formats
  const grandPatterns = [
    /DRY-RUN:\s*Would write\s+(\d[\d,]*)\s*rows/i,
    /Total rows:\s*(\d[\d,]*)/i,
    /Grand total:\s*(\d[\d,]*)/i,
    /TOTAL[^|]*\|\s*\*?\*?(\d[\d,]*)\*?\*?/i,
  ];
  let groundTruthTotal = null;
  for (const pat of grandPatterns) {
    const m = dryRunOutput.match(pat);
    if (m) { groundTruthTotal = parseInt(m[1].replace(/,/g, ""), 10); break; }
  }
  if (!groundTruthTotal) {
    log(`VALIDATE: could not parse grand total from dry-run output`);
    log(`VALIDATE: output tail: ${dryRunOutput.slice(-500)}`);
    return false;
  }
  log(`VALIDATE: loader dry-run ground truth: ${groundTruthTotal} total rows`);

  // Parse per-table totals — accept multiple output formats
  const tableTotals = {};
  const tablePatterns = [
    /CSV pattern:\s*PRU_\d+_(\w+?)_\*\.csv[\s\S]*?Total:\s*(\d[\d,]*)\s*rows/g,
    /DRY-RUN\s+research_pir\d+_(\w+):\s*(\d[\d,]*)\s*rows/g,
    /research_pir\d+_(\w+)[^:]*:\s*(\d[\d,]*)\s*rows/g,
  ];
  for (const pat of tablePatterns) {
    let m;
    while ((m = pat.exec(dryRunOutput)) !== null) {
      const category = m[1].toLowerCase();
      const count = parseInt(m[2].replace(/,/g, ""), 10);
      if (!tableTotals[category]) tableTotals[category] = count;
    }
    if (Object.keys(tableTotals).length >= 2) break;
  }

  // Fix table naming in loader.py: replace pir<id> with pir<pir_number>
  const loaderContent = fs.readFileSync(loaderPath, "utf8");
  const wrongPattern = new RegExp(`research_pir${pir.id}_`, "g");
  if (wrongPattern.test(loaderContent)) {
    const fixed = loaderContent.replace(wrongPattern, `research_pir${pir.pir_number}_`);
    fs.writeFileSync(loaderPath, fixed);
    log(`VALIDATE: fixed table names pir${pir.id} -> pir${pir.pir_number} in loader.py`);
  }

  const groundTruth = { tables: tableTotals, total: groundTruthTotal };
  const rcPath = `${stagingDir}/row_counts.json`;
  fs.writeFileSync(rcPath, JSON.stringify(groundTruth, null, 2));
  log(`VALIDATE: rewrote row_counts.json from dry-run output (${JSON.stringify(tableTotals)}, total=${groundTruthTotal})`);

  // Fix table naming in all staging files
  const allFiles = ["review_email.md", "gateway_review.md", "README.md", "source_inventory.json"];
  const wrongNameRe = new RegExp(`research_pir${pir.id}_`, "g");
  for (const name of allFiles) {
    const fpath = `${stagingDir}/${name}`;
    if (!fs.existsSync(fpath)) continue;
    let c = fs.readFileSync(fpath, "utf8");
    if (wrongNameRe.test(c)) {
      c = c.replace(wrongNameRe, `research_pir${pir.pir_number}_`);
      fs.writeFileSync(fpath, c);
      log(`VALIDATE: fixed table names in ${name}`);
    }
  }

  const filesToPatch = ["review_email.md", "gateway_review.md", "README.md"];
  for (const name of filesToPatch) {
    const fpath = `${stagingDir}/${name}`;
    if (!fs.existsSync(fpath)) continue;
    let content = fs.readFileSync(fpath, "utf8");
    let patched = false;

    for (const [category, count] of Object.entries(tableTotals)) {
      const re = new RegExp(`(${category}[^\\d]*?)(\\d[\\d,]+)(\\s*rows|\\s*\\|)`, "gi");
      const before = content;
      content = content.replace(re, (match, prefix, num, suffix) => {
        const oldNum = parseInt(num.replace(/,/g, ""), 10);
        if (oldNum !== count && oldNum > 100) {
          return prefix + count.toLocaleString() + suffix;
        }
        return match;
      });
      if (content !== before) patched = true;
    }

    const totalRe = /(total[^\\d]*?)([\d,]+)(\s*rows|\s*\|)/gi;
    const before = content;
    content = content.replace(totalRe, (match, prefix, num, suffix) => {
      const oldNum = parseInt(num.replace(/,/g, ""), 10);
      if (oldNum > 1000 && oldNum !== groundTruthTotal && Math.abs(oldNum - groundTruthTotal) < groundTruthTotal * 0.1) {
        return prefix + groundTruthTotal.toLocaleString() + suffix;
      }
      return match;
    });
    if (content !== before) patched = true;

    if (patched) {
      fs.writeFileSync(fpath, content);
      log(`VALIDATE: patched numbers in ${name}`);
    }
  }

  // Ensure tracker is in awaiting-review state (bot may have crashed before setting it)
  const pirRow = db.prepare("SELECT processing_lease_status FROM pir_requests WHERE pir_number = ?").get(pir.pir_number);
  if (pirRow && pirRow.processing_lease_status !== "awaiting-review") {
    db.prepare("UPDATE pir_requests SET processing_lease_status = 'awaiting-review', updated_at = datetime('now') WHERE pir_number = ?").run(pir.pir_number);
    log(`VALIDATE: set processing_lease_status to awaiting-review`);
  }

  normalizeStagingFiles(stagingDir, ["draft_acknowledgment.txt", "review_email.md", "gateway_review.md"]);

  log(`VALIDATE: staging validated OK`);
  return true;
}

// Light validation for reply-only cases (correspondence / cost-estimate /
// no-responsive). There is no loader / data load, so validateStaging would
// (correctly) fail — instead confirm the bot produced a review email and a
// reply payload, and ensure the tracker is in awaiting-review.
function validateCorrespondence(pir, db) {
  const stagingDir = `${SOURCES_ROOT}/_staging/${pir.pir_number}`;
  if (!fs.existsSync(stagingDir)) {
    log(`VALIDATE(corr): staging dir missing at ${stagingDir}`);
    return false;
  }
  const reviewOk = ["review_email.md", "gateway_review.md"].some(n => fs.existsSync(`${stagingDir}/${n}`));
  const replyOk = ["correspondence_reply.txt", "portal_draft.txt"].some(n => fs.existsSync(`${stagingDir}/${n}`));
  if (!reviewOk) { log(`VALIDATE(corr): no review_email.md in ${stagingDir}`); return false; }
  if (!replyOk) { log(`VALIDATE(corr): no correspondence_reply.txt / portal_draft.txt in ${stagingDir}`); return false; }

  normalizeStagingFiles(stagingDir, ["correspondence_reply.txt", "review_email.md", "gateway_review.md"]);

  const row = db.prepare("SELECT processing_lease_status FROM pir_requests WHERE pir_number = ?").get(pir.pir_number);
  if (row && row.processing_lease_status !== "awaiting-review") {
    db.prepare("UPDATE pir_requests SET processing_lease_status = 'awaiting-review', updated_at = datetime('now') WHERE pir_number = ?").run(pir.pir_number);
    log(`VALIDATE(corr): set processing_lease_status to awaiting-review`);
  }
  log(`VALIDATE(corr): correspondence staging validated OK`);
  return true;
}

// Recursively collect numeric values from a JSON value (for claims.json).
function collectNumbers(v, out = []) {
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectNumbers(x, out));
  return out;
}
// Numbers in count CONTEXT (near entity/record language), excluding years / §cites /
// item-or-section numbers / dollars — a soft fabrication warning (NOT a hard gate; nearInt
// is too loose to gate on per review S3).
function proseCountNumbers(text) {
  const out = [];
  const re = /(\d{1,4})\s*(?:districts?|charters?|entit\w+|campuses|records?|rows|no[- ]?significant|major[- ]?impact|no[- ]?impact)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = +m[1];
    const pre = text.slice(Math.max(0, m.index - 2), m.index);
    if (/[§$#]/.test(pre)) continue;            // §12, $5, #3
    if (n >= 1900 && n <= 2100) continue;        // years
    if (n >= 1 && n <= 99999) out.push(n);
  }
  return out;
}
// CLAIMS GATE (the count guarantee): every tally the bot DECLARES in claims.json must
// equal a deterministically-verified count; otherwise escalate (never override the model).
// A prose count not in the verified set is logged as a warning to surface in iteration.
function validateClaims(pir) {
  const holdingDir = `${SOURCES_ROOT}/pir-incoming/${pir.pir_number}`;
  const stagingDir = `${SOURCES_ROOT}/_staging/${pir.pir_number}`;
  let facts = null;
  const fp = `${holdingDir}/computed_facts.json`;
  if (fs.existsSync(fp)) { try { facts = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { /* */ } }
  const verified = verifiedCounts(facts);
  const cp = `${stagingDir}/claims.json`;
  if (fs.existsSync(cp)) {
    let claims; try { claims = JSON.parse(fs.readFileSync(cp, "utf8")); }
    catch { return { ok: false, reason: "claims.json is unparseable" }; }
    for (const n of collectNumbers(claims)) {
      if (!verified.has(n)) return { ok: false, reason: `claims.json states ${n}, not a verified count (verified: ${[...verified].join(",") || "none"})` };
    }
  }
  const prose = ["review_email.md", "correspondence_reply.txt", "draft_acknowledgment.txt"]
    .map((n) => `${stagingDir}/${n}`).filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, "utf8")).join("\n");
  for (const n of proseCountNumbers(prose)) {
    if (!verified.has(n)) log(`VALIDATE(claims): WARNING — reply states count-like ${n} not in verified set for PIR #${pir.pir_number}`);
  }
  return { ok: true };
}

// Route to the right validator based on case_type, then apply the claims gate.
function validateForReview(pir, db) {
  const baseOk = isReplyCase(pir) ? validateCorrespondence(pir, db) : validateStaging(pir, db);
  if (!baseOk) return false;
  const claims = validateClaims(pir);
  if (!claims.ok) {
    db.prepare("UPDATE pir_requests SET processing_lease_status='needs-human', updated_at=datetime('now') WHERE pir_number=?").run(pir.pir_number);
    log(`VALIDATE(claims): ESCALATE PIR #${pir.pir_number} — ${claims.reason}`);
    return false;
  }
  return true;
}

// (original router retained below as _validateForReviewBase for reference)
function _validateForReviewBase(pir, db) {
  return isReplyCase(pir) ? validateCorrespondence(pir, db) : validateStaging(pir, db);
}

async function createDraftReply(pir) {
  const correspondence = `${SOURCES_ROOT}/_staging/${pir.pir_number}/correspondence_reply.txt`;
  const draftPath = `${SOURCES_ROOT}/_staging/${pir.pir_number}/approved_reply.txt`;
  const fallback = `${SOURCES_ROOT}/_staging/${pir.pir_number}/draft_acknowledgment.txt`;
  const filePath = fs.existsSync(correspondence) ? correspondence
    : (fs.existsSync(draftPath) ? draftPath : (fs.existsSync(fallback) ? fallback : null));
  if (!filePath) {
    log(`No approved reply found for PIR #${pir.pir_number} — skipping draft creation.`);
    return false;
  }
  const gmail = google.gmail({ version: "v1", auth: makeAuth() });
  const body = fs.readFileSync(filePath, "utf8");

  // Find the real PIR thread on gmail.com
  const search = await gmail.users.threads.list({
    userId: "me",
    q: `from:${pir.recipient_email || ""} subject:PIR ${pir.pir_number}`,
    maxResults: 1,
  });
  const threadId = search.data.threads?.[0]?.id || null;

  const subject = `Re: PIR # ${pir.pir_number}`;
  const raw = [
    `From: ${USER_EMAIL}`,
    `To: ${pir.recipient_email || ""}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].join("\r\n");
  const encoded = Buffer.from(raw).toString("base64url");

  const requestBody = { message: { raw: encoded } };
  if (threadId) requestBody.message.threadId = threadId;

  const res = await gmail.users.drafts.create({ userId: "me", requestBody });
  log(`Draft reply created for PIR #${pir.pir_number} (draft id: ${res.data.id}, thread: ${threadId || "new"})`);
  return true;
}

// case_types that produce a drafted reply (no data load) rather than a DB load.
const REPLY_CASE_TYPES = ["correspondence", "cost-estimate", "no-responsive"];
function isReplyCase(pir) {
  return REPLY_CASE_TYPES.includes(pir.case_type || "delivery");
}

function dispatch(pir, trigger, leaseToken, gatewayThreadId) {
  const holdingDir = `${SOURCES_ROOT}/pir-incoming/${pir.pir_number}`;
  const caseType = pir.case_type || "delivery";
  const replyCase = isReplyCase(pir);
  const bodyFile = `${holdingDir}/email_body.txt`;

  if (trigger === "queued") {
    if (replyCase) {
      // Correspondence has no data files — it carries email_body.txt instead.
      if (!fs.existsSync(bodyFile)) {
        log(`Skipping PIR #${pir.pir_number}: case_type=${caseType} but no email_body.txt at ${holdingDir}`);
        return false;
      }
    } else if (!fs.existsSync(holdingDir) || fs.readdirSync(holdingDir).length === 0) {
      log(`Skipping PIR #${pir.pir_number}: holding dir missing or empty at ${holdingDir}`);
      return false;
    }
  }

  let requestedItems = null;
  if (pir.requested_items) {
    try { requestedItems = JSON.parse(pir.requested_items); } catch { requestedItems = null; }
  }

  // Precompute deterministic counts and hand them to the bot (the count guardrail).
  const computedFacts = computeFacts(holdingDir);

  const kickoff = JSON.stringify({
    pir_id: pir.id,
    pir_number: pir.pir_number,
    holding_dir: holdingDir,
    trigger,
    case_type: caseType,
    // Pass the cover-letter body whenever sync captured it — delivery cases too.
    // The body frequently carries the substantive answer that is not in the
    // attachments (the 2026-06-03 #2503540 miss).
    body_file: fs.existsSync(bodyFile) ? bodyFile : null,
    requested_items: requestedItems,
    // Verified counts the bot MUST use (computed_facts.json is also in holding_dir).
    computed_facts: computedFacts,
    lease_token: leaseToken,
  });

  const payload = JSON.stringify({
    bot_id: "pir-processor",
    gateway_thread_id: gatewayThreadId,
    user_message: kickoff,
  });

  log(`Dispatching pir-processor for PIR #${pir.pir_number} (id=${pir.id}, trigger=${trigger}, thread=${gatewayThreadId})`);

  try {
    const result = execFileSync(
      // Use the running node's absolute path, not bare "node": the systemd
      // unit's PATH does not include nvm's node, so bare "node" → spawn ENOENT
      // and the timer-driven dispatch could never spawn the bridge.
      process.execPath,
      [BRIDGE_PATH, "--inject", payload],
      { timeout: 30 * 60 * 1000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 }
    );
    const stdout = result.toString();
    log(`Bridge completed. Output:\n${stdout.slice(0, 2000)}`);
    return true;
  } catch (err) {
    log(`Bridge error for PIR #${pir.pir_number}: ${err.message}`);
    if (err.stderr) log(`stderr: ${err.stderr.toString().slice(0, 1000)}`);
    return false;
  }
}

async function main() {
  const args = parseArgs();
  const db = new Database(CANVAS_DB);
  db.pragma("journal_mode = WAL");

  if (!checkApiUp()) {
    log("WARNING: canvas-companion API at localhost:8080 is unreachable.");
    if (!args.pirId) {
      die("Cannot scan queue without API. Use --pir-id for manual dispatch.");
    }
  }

  const staleCleared = clearStaleLeases(db);
  if (staleCleared) log(`Cleared ${staleCleared} stale lease(s).`);

  let gmail = null;
  try {
    gmail = google.gmail({ version: "v1", auth: makeAuth() });
  } catch (err) {
    log(`WARNING: Gmail auth failed (${err.message}). Review threads will use synthetic IDs.`);
  }

  if (args.pirId) {
    const pir = getPir(db, args.pirId);
    if (!pir) die(`PIR id=${args.pirId} not found.`);
    const token = claimLease(db, pir.id, args.trigger);
    if (!token) die(`Could not claim lease on PIR #${pir.pir_number} (id=${pir.id}) — already leased.`);
    log(`Claimed lease ${token} on PIR #${pir.pir_number}`);

    // PORTAL-CHECK: download produced records into the holding dir first, then
    // fall through and process them as a normal delivery run. runPortalCheck
    // sets needs-human and returns false on any failure (no creds, download
    // empty, driver error) — never silently proceeds.
    if (args.trigger === "portal-check") {
      const landed = runPortalCheck(db, pir, token);
      if (!landed) { db.close(); log("Done."); return; }
      args.trigger = "queued";
      pir.case_type = "delivery";
      log(`portal-check: records downloaded; processing as delivery for PIR #${pir.pir_number}`);
    }

    let threadId = pir.review_thread_id || `pir-${pir.pir_number}`;
    if (gmail && args.trigger === "queued" && !pir.review_thread_id) {
      try {
        const thread = await createReviewThread(gmail, pir);
        threadId = thread.threadId;
        db.prepare("UPDATE pir_requests SET review_thread_id = ?, updated_at = datetime('now') WHERE id = ?").run(threadId, pir.id);
        log(`Created review thread ${threadId} (subject: ${thread.subject})`);
      } catch (err) {
        log(`WARNING: Failed to create review thread (${err.message}). Using synthetic ID.`);
      }
    }

    if (!prepareModelFor(pir)) {
      db.prepare(`UPDATE pir_requests SET processing_lease_status='needs-human', updated_at=datetime('now') WHERE id = ? AND processing_lease = ?`).run(pir.id, token);
      log(`Model swap to 27b failed; set needs-human on PIR #${pir.pir_number}.`);
      return;
    }
    const ok = dispatch(pir, args.trigger, token, threadId);
    if (args.trigger === "queued") {
      const valid = validateForReview(pir, db);
      if (valid) {
        if (!ok) log(`Bridge exited non-zero but staging is valid — proceeding.`);
        if (gmail && threadId !== `pir-${pir.pir_number}`) {
          try {
            await sendReviewEmail(gmail, pir, threadId);
          } catch (err) {
            log(`WARNING: Failed to send review email (${err.message}).`);
          }
        }
      } else if (!ok) {
        db.prepare(`UPDATE pir_requests SET processing_lease_status = 'needs-human', updated_at = datetime('now') WHERE id = ? AND processing_lease = ?`).run(pir.id, token);
        log(`Dispatch failed and staging invalid. Set needs-human on PIR #${pir.pir_number}.`);
      } else {
        log(`Staging validation failed for PIR #${pir.pir_number}. Review email NOT sent.`);
      }
    } else if (!ok) {
      db.prepare(`UPDATE pir_requests SET processing_lease_status = 'needs-human', updated_at = datetime('now') WHERE id = ? AND processing_lease = ?`).run(pir.id, token);
      log(`Dispatch failed. Set needs-human on PIR #${pir.pir_number}.`);
    }
  } else {
    const queued = getQueuedPirs(db);
    if (!queued.length) {
      log("No queued PIRs found.");
    } else {
    log(`Found ${queued.length} queued PIR(s).`);
    for (const pir of queued) {
      const token = claimLease(db, pir.id, "queued");
      if (!token) {
        log(`Skipping PIR #${pir.pir_number} — lease claim failed.`);
        continue;
      }
      log(`Claimed lease ${token} on PIR #${pir.pir_number}`);
      if (!prepareModelFor(pir)) {
        db.prepare(`UPDATE pir_requests SET processing_lease_status='needs-human', updated_at=datetime('now') WHERE id = ? AND processing_lease = ?`).run(pir.id, token);
        log(`Model swap to 27b failed; needs-human on PIR #${pir.pir_number}.`);
        continue;
      }

      let threadId = `pir-${pir.pir_number}`;
      if (gmail) {
        try {
          const thread = await createReviewThread(gmail, pir);
          threadId = thread.threadId;
          db.prepare("UPDATE pir_requests SET review_thread_id = ?, updated_at = datetime('now') WHERE id = ?").run(threadId, pir.id);
          log(`Created review thread ${threadId}`);
        } catch (err) {
          log(`WARNING: Failed to create review thread for PIR #${pir.pir_number} (${err.message}).`);
        }
      }

      const ok = dispatch(pir, "queued", token, threadId);
      const valid = validateForReview(pir, db);
      if (valid) {
        if (!ok) log(`Bridge exited non-zero but staging valid for PIR #${pir.pir_number} — proceeding.`);
        if (gmail && threadId !== `pir-${pir.pir_number}`) {
          try {
            await sendReviewEmail(gmail, pir, threadId);
          } catch (err) {
            log(`WARNING: Failed to send review email for PIR #${pir.pir_number} (${err.message}).`);
          }
        }
      } else if (!ok) {
        db.prepare(`UPDATE pir_requests SET processing_lease_status = 'needs-human', updated_at = datetime('now') WHERE id = ? AND processing_lease = ?`).run(pir.id, token);
        log(`Dispatch failed and staging invalid for PIR #${pir.pir_number}. Set needs-human.`);
      } else {
        log(`Staging validation failed for PIR #${pir.pir_number}. Review email NOT sent.`);
      }
    }
    }
  }

  // Bot work for this tick is done — hand :8003 back to the 35b daily driver
  // before the (LLM-free) post-approval Gmail-draft steps.
  restoreDailyModel();

  // Post-approval draft creation: check for PIRs that are done with an approved reply file
  const doneWithDraft = db.prepare(`
    SELECT id, pir_number, label, recipient_email FROM pir_requests
    WHERE processing_lease_status = 'done'
    AND status = 'received'
  `).all();
  for (const pir of doneWithDraft) {
    const draftPath = `${SOURCES_ROOT}/_staging/${pir.pir_number}/approved_reply.txt`;
    const fallback = `${SOURCES_ROOT}/_staging/${pir.pir_number}/draft_acknowledgment.txt`;
    const sentMarker = `${SOURCES_ROOT}/_staging/${pir.pir_number}/.draft_created`;
    if (fs.existsSync(sentMarker)) continue;
    if (!fs.existsSync(draftPath) && !fs.existsSync(fallback)) continue;
    if (!gmail) { log(`Skipping draft for PIR #${pir.pir_number} — no Gmail auth.`); continue; }
    try {
      await createDraftReply(pir);
      fs.writeFileSync(sentMarker, new Date().toISOString());
    } catch (err) {
      log(`WARNING: Failed to create draft reply for PIR #${pir.pir_number} (${err.message}).`);
    }
  }

  // Post-approval for REPLY cases (correspondence / cost-estimate / no-responsive).
  // These never reach status='received' (no data load), so the block above skips
  // them. Keyed on lease='done' + presence of a reply file. Email PIRs → Gmail
  // draft; portal PIRs (portal_base set) → leave portal_draft.txt staged for the
  // Phase 2 --action submit step (do NOT auto-post here).
  const doneReplyCases = db.prepare(`
    SELECT id, pir_number, label, recipient_email, case_type, portal_base, portal_rid
    FROM pir_requests
    WHERE processing_lease_status = 'done'
    AND case_type IN ('correspondence','cost-estimate','no-responsive')
  `).all();
  for (const pir of doneReplyCases) {
    const stagingDir = `${SOURCES_ROOT}/_staging/${pir.pir_number}`;
    // The bot always writes the reply to correspondence_reply.txt regardless of
    // channel; the dispatcher routes by portal_base (which the bot cannot see —
    // _pir_to_dict does not serialize it).
    const replyFile = `${stagingDir}/correspondence_reply.txt`;
    const sentMarker = `${stagingDir}/.reply_handled`;
    if (fs.existsSync(sentMarker)) continue;
    if (!fs.existsSync(replyFile)) continue;
    const isPortal = !!(pir.portal_base && pir.portal_base.trim());
    if (isPortal) {
      // Portal PIR: the human APPROVED (lease is 'done'), so we are authorized
      // to POST the approved reply to the portal. Fail loud to needs-human.
      if (!pir.portal_rid) {
        db.prepare(`UPDATE pir_requests SET processing_lease_status='needs-human', updated_at=datetime('now') WHERE id=?`).run(pir.id);
        log(`PIR #${pir.pir_number}: portal post blocked — portal_rid not set. needs-human.`);
        continue;
      }
      const creds = loadPortalCreds(pir.portal_base);
      if (!creds) {
        db.prepare(`UPDATE pir_requests SET processing_lease_status='needs-human', updated_at=datetime('now') WHERE id=?`).run(pir.id);
        log(`PIR #${pir.pir_number}: portal post blocked — no creds for ${pir.portal_base}. needs-human.`);
        continue;
      }
      const shot = `${stagingDir}/_portal_submit.png`;
      const r = runGovqa("submit", {
        base: pir.portal_base, rid: pir.portal_rid, replyFile,
        replySelector: PORTAL_REPLY_SELECTOR, submitSelector: PORTAL_SUBMIT_SELECTOR, shot,
      }, creds);
      log(`PIR #${pir.pir_number}: portal submit (exit ${r.code}):\n${r.out.slice(0, 1500)}`);
      if (r.ok) {
        fs.writeFileSync(sentMarker, new Date().toISOString());
        log(`PIR #${pir.pir_number}: approved reply POSTED to portal ${pir.portal_base} (rid=${pir.portal_rid}).`);
      } else {
        db.prepare(`UPDATE pir_requests SET processing_lease_status='needs-human', updated_at=datetime('now') WHERE id=?`).run(pir.id);
        log(`PIR #${pir.pir_number}: portal submit FAILED (exit ${r.code}); see ${shot}. needs-human.`);
      }
      continue;
    }
    if (!gmail) { log(`Skipping reply draft for PIR #${pir.pir_number} — no Gmail auth.`); continue; }
    try {
      await createDraftReply(pir);
      fs.writeFileSync(sentMarker, new Date().toISOString());
    } catch (err) {
      log(`WARNING: Failed to create reply draft for PIR #${pir.pir_number} (${err.message}).`);
    }
  }

  db.close();
  log("Done.");
}

main();
