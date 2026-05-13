#!/usr/bin/env node
// One-shot scheduled check-up for Austin ISD R000873-030926.
// Triggers at 9 AM CDT on 2026-05-13 (the production deadline Austin
// committed to in their May 7 maroon response on items #4(a)(b)).
//
// What it does:
//   1. Scans kevin.hopper1@gmail.com for R000873 messages received SINCE
//      2026-05-09 00:00 UTC (the day after Austin's last inbound on 5/8).
//      This catches anything Austin sent on May 9-15.
//   2. Lists what Austin produced (sender, date, subject, body snippet,
//      attachment names if any).
//   3. Walks the local pir-incoming/AISD-R873/ directory for any saved files.
//   4. Composes a markdown summary email and SENDS it to kevin.hopper1
//      via the @maestro.press OAuth (gmail_send_to_self path).
//   5. Updates canvas.db status_notes with what was found, and bumps
//      next_followup_date to 2026-05-16 if Austin produced (else leaves it
//      at 2026-05-16 so the next daily tick surfaces the failure-to-produce).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { google } from "/home/kh0pp/crow/node_modules/googleapis/build/src/index.js";

// ---------- config ----------
const PIR_NUMBER = "AISD-R873";
const REFERENCE = "R000873-030926";
const SINCE_DATE = "2026/05/09"; // Gmail query format
const INCOMING_DIR = "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/AISD-R873";
const CANVAS_DB = "/home/kh0pp/spring-2026/canvas-companion/db/canvas.db";

const PERSONAL_TOKEN = "/home/kh0pp/.config/google-workspace-mcp/token.json";
const PERSONAL_CREDS = "/home/kh0pp/.config/google-workspace-mcp/credentials.json";
const MPA_TOKEN = "/home/kh0pp/.config/google-workspace-mcp-mpa/gws-token.json";
const MPA_CREDS = "/home/kh0pp/.config/google-workspace-mcp-mpa/credentials.json";

function loadAuth(tokenPath, credsPath) {
  const tk = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  const cr = JSON.parse(fs.readFileSync(credsPath, "utf8")).installed;
  const auth = new google.auth.OAuth2(cr.client_id, cr.client_secret);
  auth.setCredentials({
    access_token: tk.token,
    refresh_token: tk.refresh_token,
    expiry_date: new Date(tk.expiry).getTime(),
  });
  return auth;
}

function findPart(p, mime) {
  if (!p) return "";
  if (p.mimeType === mime && p.body?.data) {
    return Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }
  if (p.parts) for (const c of p.parts) {
    const r = findPart(c, mime);
    if (r) return r;
  }
  return "";
}

function htmlToPlain(h) {
  return h
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/ +/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function listAttachments(payload) {
  const out = [];
  function walk(p) {
    if (!p) return;
    if (p.filename && p.filename.length > 0 && p.body?.attachmentId) {
      out.push({ filename: p.filename, size: p.body.size || 0 });
    }
    if (p.parts) for (const c of p.parts) walk(c);
  }
  walk(payload);
  return out;
}

// ---------- step 1: Gmail scan ----------
const personalGmail = google.gmail({ version: "v1", auth: loadAuth(PERSONAL_TOKEN, PERSONAL_CREDS) });

const query = `subject:${REFERENCE} after:${SINCE_DATE}`;
const r = await personalGmail.users.messages.list({ userId: "me", q: query, maxResults: 30 });
const msgs = r.data.messages || [];
console.error(`[checkup] Found ${msgs.length} ${REFERENCE} messages since ${SINCE_DATE}`);

const findings = [];
for (const m of msgs) {
  const full = await personalGmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
  const h = Object.fromEntries((full.data.payload.headers || []).map((x) => [x.name, x.value]));
  const plain = findPart(full.data.payload, "text/plain");
  const html = findPart(full.data.payload, "text/html");
  const body = (plain || (html ? htmlToPlain(html) : "")).slice(0, 600);
  const attachments = listAttachments(full.data.payload);
  findings.push({
    msgId: m.id,
    threadId: full.data.threadId,
    from: h.From || "?",
    to: h.To || "?",
    date: h.Date || "?",
    subject: h.Subject || "?",
    bodyHead: body,
    attachments,
  });
}

// ---------- step 2: local pir-incoming scan ----------
let localFiles = [];
try {
  const entries = fs.readdirSync(INCOMING_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) {
      const st = fs.statSync(path.join(INCOMING_DIR, e.name));
      localFiles.push({ name: e.name, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
} catch (e) {
  // dir doesn't exist; that's expected if the ingest helper hasn't matched yet
}

// ---------- step 3: compose email body ----------
const inboundFromAustin = findings.filter((f) =>
  f.from.toLowerCase().includes("austinisd@govqa.us") || f.from.toLowerCase().includes("austinisd.org")
);
const outboundFromUser = findings.filter((f) =>
  f.from.toLowerCase().includes("kevin.hopper1@gmail.com")
);

const lines = [
  "# Austin ISD R000873-030926 — May 15 production check-up",
  "",
  `Scan window: ${SINCE_DATE} to now. Reference: ${REFERENCE}.`,
  "",
  `Inbound from Austin since ${SINCE_DATE}: **${inboundFromAustin.length} message(s)**`,
  `Outbound from you since ${SINCE_DATE}: **${outboundFromUser.length} message(s)**`,
  `Files in pir-incoming/AISD-R873/: **${localFiles.length}**`,
  "",
  "## Verdict",
  "",
];

if (inboundFromAustin.length === 0) {
  lines.push(
    "**Austin did NOT produce on the May 15 deadline.** No new inbound from Austin since their May 8 SCE refusal message. This is a clean failure-to-produce on items #4(a) and #4(b), on top of the existing refusals on #1, #5, #6, and the ducked statutory-basis question on #4(c).",
    "",
    "## Recommended next action",
    "",
    "Draft and send the substantive pushback letter prepared in advance. Cite ESSA §1111(h)(1)(C)(x) federal compliance, 34 CFR §200.35, §552.227 proper read, §552.301 procedural violation, and signal escalation to AG complaint under §552.269 if no production within 5 business days.",
  );
} else {
  lines.push(
    `**Austin sent ${inboundFromAustin.length} new message(s) since May 9.** Review the substance below and decide whether they satisfied items #4(a) and #4(b), or whether the response is another deferral.`,
    "",
    "## Inbound messages",
    "",
  );
  for (let i = 0; i < inboundFromAustin.length; i++) {
    const f = inboundFromAustin[i];
    lines.push(`### ${i + 1}. ${f.date}`);
    lines.push(`- From: ${f.from}`);
    lines.push(`- Subject: ${f.subject}`);
    lines.push(`- Thread: https://mail.google.com/mail/u/0/#inbox/${f.threadId}`);
    if (f.attachments.length > 0) {
      lines.push(`- Attachments (${f.attachments.length}):`);
      for (const a of f.attachments) lines.push(`  - ${a.filename} (${a.size} bytes)`);
    } else {
      lines.push("- Attachments: none (portal-only delivery suspected — log into austinisd.govqa.us to retrieve)");
    }
    lines.push("- Body snippet:");
    lines.push("");
    lines.push("```");
    lines.push(f.bodyHead);
    lines.push("```");
    lines.push("");
  }
}

if (localFiles.length > 0) {
  lines.push("## Local attachments (pir-incoming/AISD-R873/)");
  lines.push("");
  for (const lf of localFiles) lines.push(`- ${lf.name} (${lf.size} bytes, mtime ${lf.mtime})`);
  lines.push("");
}

lines.push("---");
lines.push(`Auto-generated by pir_aisd_r000873_may15_checkup.mjs at ${new Date().toISOString()}.`);

const body = lines.join("\n");

// ---------- step 4: send via @maestro.press gmail_send_to_self path ----------
const mpaGmail = google.gmail({ version: "v1", auth: loadAuth(MPA_TOKEN, MPA_CREDS) });
const rawLines = [
  "From: kevin.hopper@maestro.press",
  "To: kevin.hopper1@gmail.com",
  "Subject: [pir-checkup] Austin ISD R000873 — May 15 production status",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  body,
];
const raw = rawLines.join("\r\n");
const b64 = Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const sent = await mpaGmail.users.messages.send({ userId: "me", requestBody: { raw: b64 } });
console.error(`[checkup] sent email: ${sent.data.id}`);

// ---------- step 5: append finding to canvas.db status_notes ----------
const findingsLine = `[${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC] May 15 active-scan check-up fired. Austin inbound since ${SINCE_DATE}: ${inboundFromAustin.length}. Files in pir-incoming/AISD-R873/: ${localFiles.length}. ${inboundFromAustin.length === 0 ? "FAILURE TO PRODUCE — pushback letter needed." : "Production received — review for substantive adequacy."}`;

const sql = `UPDATE pir_requests SET status_notes = COALESCE(status_notes,'') || char(10) || '${findingsLine.replace(/'/g, "''")}', updated_at = datetime('now') WHERE pir_number = '${PIR_NUMBER}';`;
const sqlite = spawnSync("sqlite3", [CANVAS_DB], { input: sql, encoding: "utf8" });
if (sqlite.status !== 0) {
  console.error("[checkup] sqlite update FAILED:", sqlite.stderr);
} else {
  console.error("[checkup] canvas.db status_notes updated");
}

console.error("[checkup] DONE");
