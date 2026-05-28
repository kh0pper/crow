#!/usr/bin/env node
// sync_pir_responses.mjs — Phase 9.1 PIR attachment ingest
//
// Pulls PIR response emails labeled `bot/pir-management` from the bot's Gmail
// account, matches each to a pir_requests row in canvas-companion's canvas.db
// (deterministic match on reference_number / pir_number / sender), downloads
// any attachments to a holding-pen directory under
// ~/spring-2026/insd-5941/sources/pir-incoming/<pir_number>/, and appends an
// inventory line to the row's status_notes. Idempotent — once a thread is
// labeled `bot/pir-management/ingested` we skip it.
//
// Implementation notes:
//   - Attachment download uses gmail.users.messages.attachments.get() from
//     googleapis. The SKILL.md says "Gmail MCP doesn't support attachment
//     download" — that's a constraint of the gmail-mcp tool surface, not the
//     underlying Gmail API. Using the API directly is cleaner than the IMAP
//     fallback the skill prescribes for the manual workflow.
//   - This helper does NOT advance pir_requests.status, parse data, or move
//     files to canonical org-slug dirs. Those decisions stay with the user.
//     The helper's job is: get the bytes off Gmail, log what was received,
//     surface for review.
//   - On match failure (no PIR number in subject AND no unique sender match),
//     the thread is labeled `bot/pir-management/ingest-failed` so it won't
//     infinite-retry.
//
// Schedule: systemd timer mpa-pir-response-sync.timer, every 30 min,
// OnBootSec=8min (offset 1 min from Pathway B at OnBootSec=7min).
//
// Exit codes: 0 success, 1 setup/connectivity error, 2 batch failure.

import fs from "node:fs";
import path from "node:path";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { google } from "/home/kh0pp/crow/node_modules/googleapis/build/src/index.js";
import { findPirCandidates } from "./pir_match.mjs";

const MPA_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
const CANVAS_DB = "/home/kh0pp/spring-2026/canvas-companion/db/canvas.db";
// OAuth defaults to kevin.hopper1@gmail.com (the account canvas-companion sends
// PIRs from, so PIR responses arrive there). Override via env vars for testing
// against the @maestro.press account.
const TOKEN_PATH =
  process.env.PIR_GMAIL_TOKEN_PATH
  || "/home/kh0pp/.config/google-workspace-mcp/token.json";
const CREDS_PATH =
  process.env.PIR_GMAIL_CREDS_PATH
  || "/home/kh0pp/.config/google-workspace-mcp/credentials.json";

const SOURCES_ROOT = "/home/kh0pp/spring-2026/insd-5941/sources";
const INCOMING_DIR = path.join(SOURCES_ROOT, "pir-incoming");
const UNMATCHED_DIR = path.join(INCOMING_DIR, "_unmatched");

const SOURCE_LABEL = "bot/pir-management";
const MARKER_INGESTED = "bot/pir-management/ingested";
const MARKER_FAILED = "bot/pir-management/ingest-failed";

const MAX_MESSAGES_PER_RUN = 50;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50MB per file; Gmail caps at 25MB but allow headroom

// Subject-token regex set + findPirCandidates ladder live in ./pir_match.mjs
// so the standalone rematch helper can re-apply the same logic to the
// _unmatched/ backlog without going through Gmail.

function makeAuth() {
  const tk = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  const cr = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")).installed;
  const auth = new google.auth.OAuth2(cr.client_id, cr.client_secret);
  auth.setCredentials({
    access_token: tk.token,
    refresh_token: tk.refresh_token,
    expiry_date: new Date(tk.expiry).getTime(),
  });
  // Do NOT write the refreshed token back — let gws-mcp own the token file.
  return auth;
}

async function ensureLabels(gmail) {
  const existing = (await gmail.users.labels.list({ userId: "me" })).data.labels || [];
  const byName = new Map(existing.map((l) => [l.name, l.id]));
  const want = [SOURCE_LABEL, MARKER_INGESTED, MARKER_FAILED];
  const created = [];
  for (const name of want) {
    if (byName.has(name)) continue;
    const res = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    byName.set(name, res.data.id);
    created.push(name);
  }
  if (created.length) {
    console.error(`[pir-ingest] created ${created.length} missing label(s): ${created.join(", ")}`);
  }
  return byName;
}

function getHeader(msg, name) {
  const headers = msg.payload?.headers || [];
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function extractSenderEmail(fromHeader) {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function walkPartsForAttachments(payload, out, partPath = []) {
  if (!payload) return;
  const here = [...partPath];
  if (
    payload.filename &&
    payload.filename.length > 0 &&
    payload.body?.attachmentId
  ) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType || "application/octet-stream",
      size: payload.body.size || 0,
      attachmentId: payload.body.attachmentId,
    });
  }
  if (payload.parts) {
    for (let i = 0; i < payload.parts.length; i++) {
      walkPartsForAttachments(payload.parts[i], out, [...here, i]);
    }
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeFilename(name) {
  // Strip any path separators or null bytes from the Gmail-supplied filename.
  return name.replace(/[\x00/\\]/g, "_").slice(0, 240);
}

function formatBytes(n) {
  if (n == null) return "unknown size";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Correspondence body extraction (Phase 1: no-attachment PIR mail) ──────────
// GovQA/mycusthelp portal mail is HTML-only; extract a plain-text body so the
// dispatcher can pass it to the bot as a file (avoids feeding raw HTML to the
// local model). Prefer text/plain; fall back to stripped text/html.
function decodeB64Url(d) {
  return Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function collectBodyParts(payload, out) {
  if (!payload) return;
  if (payload.body?.data && /^text\//.test(payload.mimeType || "")) {
    out.push({ mt: payload.mimeType, data: decodeB64Url(payload.body.data) });
  }
  if (payload.parts) for (const p of payload.parts) collectBodyParts(p, out);
}
function stripHtml(h) {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function extractPlainBody(payload) {
  const parts = [];
  collectBodyParts(payload, parts);
  const txt = parts.find((p) => p.mt === "text/plain");
  if (txt && txt.data.trim()) return txt.data.trim();
  const html = parts.find((p) => p.mt === "text/html");
  if (html) return stripHtml(html.data);
  return "";
}

// Subject-driven case classification, mirroring the bot prompt's FIRST-STEP
// TRIAGE interim signals. correspondence is the catch-all (decision-forcing
// messages with a generic portal subject, e.g. R000873).
function classifyCaseType(subject) {
  const s = (subject || "").toLowerCase();
  if (/no documents found|no responsive|no records/.test(s)) return "no-responsive";
  if (/cost estimate|clarification/.test(s)) return "cost-estimate";
  return "correspondence";
}

async function downloadAttachments({ gmail, messageId, attachments, destDir }) {
  ensureDir(destDir);
  const saved = [];
  for (const att of attachments) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      console.error(
        `[pir-ingest]   skip ${att.filename}: size ${att.size} exceeds cap ${MAX_ATTACHMENT_BYTES}`,
      );
      continue;
    }
    const resp = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: att.attachmentId,
    });
    const raw = resp.data?.data;
    if (!raw) {
      console.error(`[pir-ingest]   ${att.filename}: empty body`);
      continue;
    }
    const buf = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const filename = safeFilename(att.filename);
    let destPath = path.join(destDir, filename);
    // Don't clobber: if a file with this name already exists, append a counter.
    if (fs.existsSync(destPath)) {
      const ext = path.extname(filename);
      const base = filename.slice(0, filename.length - ext.length);
      for (let i = 1; i < 100; i++) {
        const candidate = path.join(destDir, `${base}-${i}${ext}`);
        if (!fs.existsSync(candidate)) {
          destPath = candidate;
          break;
        }
      }
    }
    fs.writeFileSync(destPath, buf);
    saved.push({ filename: path.basename(destPath), size: buf.length, path: destPath });
    console.error(
      `[pir-ingest]   saved ${path.basename(destPath)} (${formatBytes(buf.length)}) → ${destDir}`,
    );
  }
  return saved;
}

function appendInventoryToStatusNotes(canvasDb, { pirId, savedFiles }) {
  if (!savedFiles.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const fileList = savedFiles
    .map((f) => `${f.filename} (${formatBytes(f.size)})`)
    .join(", ");
  const line = `[${today}] received ${savedFiles.length} attachment${
    savedFiles.length === 1 ? "" : "s"
  }: ${fileList}`;
  const row = canvasDb
    .prepare("SELECT status_notes FROM pir_requests WHERE id = ?")
    .get(pirId);
  if (!row) return;
  const next =
    row.status_notes && row.status_notes.trim().length
      ? `${row.status_notes.replace(/\s+$/, "")}\n${line}`
      : line;
  canvasDb
    .prepare(
      "UPDATE pir_requests SET status_notes = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(next, pirId);
}

function upsertBotConversation(mpaDb, { pirRow, msg, savedFiles, holdingDir }) {
  const convId = `pir-tracker:${pirRow.pir_number}:${msg.threadId}`;
  const payload = {
    pir_number: pirRow.pir_number,
    pir_id: pirRow.id,
    gmail_message_id: msg.id,
    gmail_thread_id: msg.threadId,
    sender: getHeader(msg, "From"),
    subject: getHeader(msg, "Subject"),
    internal_date: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : null,
    attachments: savedFiles.map((f) => ({
      filename: f.filename,
      size: f.size,
      path: f.path,
    })),
    holding_dir: holdingDir,
    status_at_arrival: pirRow.status,
  };
  mpaDb
    .prepare(
      `
      INSERT INTO bot_conversations
        (id, bot_id, user_email, subject_anchor, gmail_thread_id, gmail_label,
         google_doc_id, status, current_step, payload, last_user_msg_at,
         next_action_at, created_at, updated_at)
      VALUES
        (?, 'pir-tracker', 'kevin.hopper@maestro.press', ?, ?, ?,
         NULL, 'awaiting-user', 'response-arrived', ?, ?,
         NULL, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        gmail_thread_id  = excluded.gmail_thread_id,
        gmail_label      = excluded.gmail_label,
        status           = excluded.status,
        current_step     = excluded.current_step,
        payload          = excluded.payload,
        last_user_msg_at = excluded.last_user_msg_at,
        updated_at       = datetime('now')
    `,
    )
    .run(
      convId,
      `[PIR-${pirRow.pir_number}]`,
      msg.threadId,
      SOURCE_LABEL,
      JSON.stringify(payload),
      payload.internal_date,
    );
  return convId;
}

async function processMessage({ gmail, canvasDb, mpaDb, msgMeta, labelIds, pirOverride = null, savedFilesOut = null }) {
  const msg = (
    await gmail.users.messages.get({
      userId: "me",
      id: msgMeta.id,
      format: "full",
    })
  ).data;

  const fromHeader = getHeader(msg, "From");
  const subject = getHeader(msg, "Subject");
  const senderEmail = extractSenderEmail(fromHeader);

  const attachments = [];
  walkPartsForAttachments(msg.payload, attachments);

  let pirRow;
  if (pirOverride) {
    pirRow = canvasDb.prepare(
      "SELECT * FROM pir_requests WHERE pir_number = ? OR reference_number = ?",
    ).get(pirOverride, pirOverride);
    if (!pirRow) {
      throw new Error(`pir_override='${pirOverride}' not found in pir_requests`);
    }
  } else {
    pirRow = findPirCandidates(canvasDb, { subject, senderEmail });
  }
  if (!pirRow) {
    console.error(
      `[pir-ingest]   ${msg.id}: no PIR match (subject="${subject.slice(0, 80)}" sender="${senderEmail}") — failed`,
    );
    const unmatchedDir = path.join(
      UNMATCHED_DIR,
      `${new Date().toISOString().slice(0, 10)}_${msg.id}`,
    );
    if (attachments.length) {
      try {
        await downloadAttachments({
          gmail,
          messageId: msg.id,
          attachments,
          destDir: unmatchedDir,
        });
        // Drop a sidecar with the original subject + sender for triage.
        fs.writeFileSync(
          path.join(unmatchedDir, "_meta.txt"),
          `subject: ${subject}\nfrom: ${fromHeader}\nthreadId: ${msg.threadId}\n`,
        );
      } catch (e) {
        console.error(`[pir-ingest]   download to _unmatched failed: ${e.message}`);
      }
    }
    return { matched: false, savedCount: 0 };
  }

  if (!attachments.length) {
    // Phase 1 (correspondence): a matched PIR with no data attachments is a
    // decision-forcing / interim message (e.g. R000873 "decide on the #9b cost
    // estimate or we close"). Persist the body + metadata into the holding dir
    // and queue it with a case_type so the dispatcher can route it to the bot's
    // reply-drafting path. The dispatcher reads email_body.txt + case_type.
    const caseType = classifyCaseType(subject);
    const holdingDir = path.join(INCOMING_DIR, pirRow.pir_number);
    ensureDir(holdingDir);
    const body = extractPlainBody(msg.payload);
    fs.writeFileSync(path.join(holdingDir, "email_body.txt"), body || "(empty body)");
    fs.writeFileSync(
      path.join(holdingDir, "inbound.json"),
      JSON.stringify({
        message_id: msg.id,
        thread_id: msg.threadId,
        subject,
        from: fromHeader,
        date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
        case_type: caseType,
      }, null, 2),
    );
    console.error(
      `[pir-ingest]   ${msg.id}: matched PIR ${pirRow.pir_number}, no attachments — ` +
        `case_type=${caseType}, body=${(body || "").length} chars → ${holdingDir}`,
    );
    upsertBotConversation(mpaDb, {
      pirRow,
      msg,
      savedFiles: [],
      holdingDir,
    });
    // Queue + record case_type. Tolerate NULL or '' lease/lease-status (some
    // legacy rows carry empty strings rather than NULL).
    canvasDb.prepare(`UPDATE pir_requests
      SET processing_lease_status = 'queued', case_type = ?, updated_at = datetime('now')
      WHERE id = ?
        AND (processing_lease IS NULL OR processing_lease = '')
        AND (processing_lease_status IS NULL OR processing_lease_status IN ('', 'done'))`)
      .run(caseType, pirRow.id);
    return { matched: true, savedCount: 0, pirNumber: pirRow.pir_number, caseType };
  }

  const holdingDir = path.join(INCOMING_DIR, pirRow.pir_number);
  const savedFiles = await downloadAttachments({
    gmail,
    messageId: msg.id,
    attachments,
    destDir: holdingDir,
  });
  if (savedFiles.length) {
    appendInventoryToStatusNotes(canvasDb, {
      pirId: pirRow.id,
      savedFiles,
    });
    upsertBotConversation(mpaDb, {
      pirRow,
      msg,
      savedFiles,
      holdingDir,
    });
    canvasDb.prepare(`UPDATE pir_requests SET processing_lease_status = 'queued', case_type = 'delivery'
      WHERE id = ? AND processing_lease IS NULL
      AND (processing_lease_status IS NULL OR processing_lease_status = 'done')`).run(pirRow.id);
  }
  // Phase 2B: expose the per-file inventory to the caller if requested.
  if (savedFilesOut) {
    for (const f of savedFiles) savedFilesOut.push(f);
  }
  return {
    matched: true,
    savedCount: savedFiles.length,
    pirNumber: pirRow.pir_number,
  };
}

async function backstopApplyLabel({ gmail, labelIds }) {
  // Safety-net: if the Gmail filter didn't fire for some reason, scan inbox for
  // PIR-shaped mail that lacks bot/pir-management* labels and apply
  // bot/pir-management ourselves. The downstream processLabel() handles them
  // on the next iteration.
  // Keeps the script self-sufficient even if the user's Gmail filter is broken
  // or removed.
  const sourceId = labelIds.get(SOURCE_LABEL);
  const q =
    'from:mycusthelp.net newer_than:7d ' +
    `-label:"${SOURCE_LABEL}" ` +
    `-label:"${MARKER_INGESTED}" ` +
    `-label:"${MARKER_FAILED}"`;
  const res = await gmail.users.messages.list({
    userId: "me", q, maxResults: 25,
  });
  const msgs = res.data.messages || [];
  if (!msgs.length) return 0;
  let applied = 0;
  for (const m of msgs) {
    try {
      await gmail.users.messages.modify({
        userId: "me",
        id: m.id,
        requestBody: { addLabelIds: [sourceId] },
      });
      applied++;
    } catch (err) {
      console.error(`[pir-ingest]   backstop: failed to label ${m.id}: ${err.message}`);
    }
  }
  console.error(`[pir-ingest] backstop: labeled ${applied}/${msgs.length} unlabeled PIR mail(s)`);
  return applied;
}

async function processLabel({ gmail, canvasDb, mpaDb, labelIds }) {
  const q = `label:${SOURCE_LABEL} -label:${MARKER_INGESTED} -label:${MARKER_FAILED}`;
  const listResp = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: MAX_MESSAGES_PER_RUN,
  });
  const msgs = listResp.data.messages || [];
  if (!msgs.length) {
    console.error(`[pir-ingest] 0 unprocessed messages on ${SOURCE_LABEL}`);
    return { matched: 0, unmatched: 0, errors: 0, savedFiles: 0, msgs: 0 };
  }
  console.error(`[pir-ingest] ${msgs.length} message(s) to process`);

  const ingestedLabelId = labelIds.get(MARKER_INGESTED);
  const failedLabelId = labelIds.get(MARKER_FAILED);

  let matched = 0, unmatched = 0, errors = 0, savedFiles = 0;
  for (const meta of msgs) {
    try {
      const r = await processMessage({ gmail, canvasDb, mpaDb, msgMeta: meta, labelIds });
      if (r.matched) {
        matched++;
        savedFiles += r.savedCount;
        await gmail.users.messages.modify({
          userId: "me",
          id: meta.id,
          requestBody: { addLabelIds: [ingestedLabelId] },
        });
        console.error(
          `[pir-ingest]   ${meta.id}: matched PIR ${r.pirNumber}, saved=${r.savedCount}`,
        );
      } else {
        unmatched++;
        await gmail.users.messages.modify({
          userId: "me",
          id: meta.id,
          requestBody: { addLabelIds: [failedLabelId] },
        });
      }
    } catch (err) {
      errors++;
      console.error(`[pir-ingest]   ${meta.id}: failed: ${err.stack || err.message}`);
      try {
        await gmail.users.messages.modify({
          userId: "me",
          id: meta.id,
          requestBody: { addLabelIds: [failedLabelId] },
        });
      } catch {
        // swallow
      }
    }
  }
  return { matched, unmatched, errors, savedFiles, msgs: msgs.length };
}

// CLI args. Default mode (no args) runs the autoload batch (processLabel).
// Single-thread mode (--thread <id>) processes one specified Gmail thread.
// Optional --pir <pir_number> overrides matcher output (used by Phase 2B's
// router INGEST CONFIRMATION branch where the user has already named the PIR).
// --json prints a single-line JSON result to stdout instead of plain logging.
function parseArgs(argv) {
  const out = { thread: null, pir: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread") out.thread = argv[++i] || null;
    else if (a === "--pir") out.pir = argv[++i] || null;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: sync_pir_responses.mjs [--thread <id> [--pir <num>] [--json]]\n");
      process.exit(0);
    } else {
      process.stderr.write(`[pir-ingest] unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

// Phase 2B (2026-05-15). Single-thread variant of processLabel. Fetches one
// Gmail thread, runs each message through processMessage, applies the same
// MARKER_INGESTED / MARKER_FAILED labels as processLabel so the autoload
// timer skips the same thread on its next pass. If pirOverride is provided,
// the matcher is short-circuited per-message (the user has named the PIR
// explicitly via the router INGEST CONFIRMATION branch).
async function processSingleThread({ gmail, canvasDb, mpaDb, labelIds, threadId, pirOverride }) {
  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const msgs = thread.data.messages || [];
  let matched = 0, unmatched = 0, errors = 0, savedFiles = 0;
  const filesLanded = [];
  for (const m of msgs) {
    let r = null;
    try {
      r = await processMessage({
        gmail, canvasDb, mpaDb,
        msgMeta: { id: m.id, threadId },
        labelIds,
        pirOverride: pirOverride || null,
        savedFilesOut: filesLanded,
      });
      if (r.matched) matched++;
      else unmatched++;
      savedFiles += r.savedCount || 0;
    } catch (e) {
      errors++;
      process.stderr.write(`[pir-ingest:single] msg ${m.id} error: ${e.stack || e.message}\n`);
    }
    // Apply MARKER_INGESTED on success or MARKER_FAILED on failure - mirrors
    // processLabel lines ~404-428. Skipping this causes the next autoload tick
    // (mpa-pir-response-sync.timer every 30 min) to re-process the same thread
    // without the override, duplicating status_notes and possibly mis-routing.
    // ensureLabels() returns a Map<labelName, labelId> (NOT an object), so
    // access via .get(MARKER_INGESTED) / .get(MARKER_FAILED) matching the
    // pattern at processLabel:404-405.
    try {
      const addLabelId = (r && r.matched)
        ? labelIds.get(MARKER_INGESTED)
        : labelIds.get(MARKER_FAILED);
      if (addLabelId) {
        await gmail.users.messages.modify({
          userId: "me",
          id: m.id,
          requestBody: { addLabelIds: [addLabelId] },
        });
      }
    } catch (e) {
      process.stderr.write(`[pir-ingest:single] label-apply failed for msg ${m.id}: ${e.message}\n`);
    }
  }
  return { matched, unmatched, errors, savedFiles, msgs: msgs.length, filesLanded };
}

async function main() {
  const args = parseArgs(process.argv);
  console.error(`[pir-ingest] starting at ${new Date().toISOString()}${args.thread ? ` (single-thread mode: ${args.thread})` : ""}`);
  ensureDir(INCOMING_DIR);
  ensureDir(UNMATCHED_DIR);

  const auth = makeAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const labelIds = await ensureLabels(gmail);

  const canvasDb = new Database(CANVAS_DB);
  canvasDb.pragma("busy_timeout = 5000");

  const mpaDb = new Database(MPA_DB);
  mpaDb.pragma("journal_mode = DELETE");
  mpaDb.pragma("busy_timeout = 5000");

  let r;
  if (args.thread) {
    r = await processSingleThread({
      gmail, canvasDb, mpaDb, labelIds,
      threadId: args.thread, pirOverride: args.pir,
    });
  } else {
    await backstopApplyLabel({ gmail, labelIds });
    r = await processLabel({ gmail, canvasDb, mpaDb, labelIds });
  }

  canvasDb.close();
  mpaDb.close();

  if (args.json) {
    process.stdout.write(JSON.stringify({
      success: r.errors === 0,
      mode: args.thread ? "single-thread" : "label-batch",
      thread_id: args.thread || null,
      pir_override: args.pir || null,
      matched: r.matched,
      unmatched: r.unmatched,
      errors: r.errors,
      saved_files: r.savedFiles,
      msgs_seen: r.msgs,
      files_landed: r.filesLanded || [],
    }) + "\n");
  } else {
    console.error(
      `[pir-ingest] done: ${r.msgs} message(s), ${r.matched} matched, ` +
        `${r.unmatched} unmatched, ${r.savedFiles} attachment(s) saved, ${r.errors} error(s)`,
    );
  }
  if (r.errors > 0) process.exit(2);
}

main().catch((err) => {
  console.error(`[pir-ingest] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
