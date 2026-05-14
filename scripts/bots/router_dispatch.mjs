#!/usr/bin/env node
// router_dispatch.mjs — Phase 1 email-router for the bot system.
//
// Reads mail on label "bot/router-inbox" of the BOT account
// (kevin.hopper@maestro.press), classifies intent (regex on subject + body),
// dispatches to the matching action (systemd start / schedule.next_run bump /
// node script exec), and replies threaded to the sender.
//
// Phase 1 intents (deterministic, no LLM):
//   - "run pir sync"            → systemctl start mpa-pir-response-sync.service
//   - "show pir digest"         → bump pipeline:bot:pir-tracker:tick next_run
//   - "start job search"        → bump pipeline:bot:job-search:tick next_run
//   - "rematch pir"             → exec ~/crow/scripts/bots/rematch_unmatched.mjs
//   - "help" / fallback         → reply with usage
//
// Reply mechanism: gmail_send_threaded_to_self semantics — fetch original
// message's subject + Message-ID, send reply with In-Reply-To set.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { google } from "/home/kh0pp/crow/node_modules/googleapis/build/src/index.js";

const MPA_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
const TOKEN_PATH =
  process.env.ROUTER_GMAIL_TOKEN_PATH
  || "/home/kh0pp/.config/google-workspace-mcp-mpa/gws-token.json";
const CREDS_PATH =
  process.env.ROUTER_GMAIL_CREDS_PATH
  || "/home/kh0pp/.config/google-workspace-mcp-mpa/credentials.json";
const SUDO_PASSWORD = process.env.SUDO_PASSWORD || "";

const SOURCE_LABEL = "bot/router-inbox";
const MARKER_PROCESSED = "bot/router-inbox/processed";
const MARKER_FAILED = "bot/router-inbox/failed";
const MAX_MESSAGES_PER_RUN = 10;

// --- Auth ---
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

// --- Intent classification ---
const INTENTS = [
  {
    name: "run-pir-sync",
    patterns: [/\brun\s*pir\s*sync\b/i, /\bingest\s*pir\b/i, /\bpir\s*ingest\b/i, /\bsync\s*pir(\s*responses)?\b/i],
    summary: "Run PIR ingest sync now",
    action: { kind: "systemctl-start", unit: "mpa-pir-response-sync.service" },
  },
  {
    name: "show-pir-digest",
    patterns: [/\bshow\s*pir\s*digest\b/i, /\bpir\s*digest\s*(now|please)?\b/i, /\brun\s*pir\s*tracker\b/i, /\bpir\s*tracker\s*tick\b/i],
    summary: "Send the PIR daily digest now (pipeline:bot:pir-tracker:tick)",
    action: { kind: "mpa-schedule-bump", task: "pipeline:bot:pir-tracker:tick" },
  },
  {
    name: "start-job-search",
    patterns: [/\bstart\s*job\s*search\b/i, /\brun\s*job\s*search(\s*now)?\b/i, /\bsearch\s*for\s*jobs(\s*now)?\b/i, /\bjob\s*search\s*tick\b/i],
    summary: "Start the weekly job-search chain now (pipeline:bot:job-search:tick)",
    action: { kind: "mpa-schedule-bump", task: "pipeline:bot:job-search:tick" },
  },
  {
    name: "rematch-pir",
    patterns: [/\brematch\s*pir\b/i, /\brematch\s*unmatched\b/i, /\bre-?match\b/i],
    summary: "Re-run PIR matcher against the _unmatched/ backlog",
    action: { kind: "exec-node", script: "/home/kh0pp/crow/scripts/bots/rematch_unmatched.mjs" },
  },
  {
    name: "help",
    patterns: [/^\s*help\b/i, /\bwhat\s*can\s*you\s*do\b/i, /\bcommands\??\s*$/i, /\bhow\s*do\s*i\s*use\b/i],
    summary: "Send the help text",
    action: { kind: "help" },
  },
];

const HELP_TEXT = `Bot router — quick reference

You can send this address (kevin.hopper+bot@maestro.press) a short request and I'll route it to the right bot pipeline. Recognized commands (subject OR body match, case-insensitive):

  run pir sync          — ingest any newly-labeled PIR responses now
  show pir digest       — send the daily PIR digest immediately
  start job search      — run the weekly job-search chain (search → shortlist → draft → notify)
  rematch pir           — re-run the PIR matcher against the _unmatched/ backlog
  help                  — show this list

Phase 2 will let you reply to my confirmations to refine the action ("actually do dallas only"). Phase 3 will let you send freeform requests ("find me director-level federal-programs jobs in Houston this week") and I'll improvise.

— router`;

function classify(subject, body) {
  const text = `${subject || ""}\n\n${body || ""}`;
  for (const intent of INTENTS) {
    for (const pat of intent.patterns) {
      if (pat.test(text)) return intent;
    }
  }
  return null; // fallback
}

// --- Dispatch actions ---
const execAsync = promisify((cmd, opts, cb) => {
  const child = spawn(cmd[0], cmd.slice(1), { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => stdout += d.toString());
  child.stderr.on("data", d => stderr += d.toString());
  if (opts?.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }
  child.on("close", (code) => cb(null, { code, stdout, stderr }));
  child.on("error", err => cb(err));
});

async function dispatch(action) {
  switch (action.kind) {
    case "systemctl-start": {
      if (!SUDO_PASSWORD) throw new Error("SUDO_PASSWORD env var missing");
      const r = await execAsync(["sudo", "-S", "systemctl", "start", action.unit], { stdin: SUDO_PASSWORD + "\n" });
      if (r.code !== 0) throw new Error(`systemctl start ${action.unit} exit=${r.code}: ${r.stderr.slice(-200)}`);
      return `systemctl started ${action.unit}`;
    }
    case "mpa-schedule-bump": {
      const db = new Database(MPA_DB);
      db.pragma("journal_mode = DELETE");
      db.pragma("busy_timeout = 5000");
      const info = db.prepare(
        "UPDATE schedules SET next_run = datetime('now', '-1 second') WHERE task = ?"
      ).run(action.task);
      db.close();
      if (info.changes === 0) throw new Error(`no schedule row for task=${action.task}`);
      return `bumped next_run on ${action.task}`;
    }
    case "exec-node": {
      const r = await execAsync(["/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node", action.script], {});
      if (r.code !== 0) throw new Error(`node ${action.script} exit=${r.code}: ${r.stderr.slice(-200)}`);
      return `ran ${action.script}: ${(r.stdout.trim().split("\n").pop() || "").slice(0, 200)}`;
    }
    case "help":
      return null; // body handled inline
  }
  throw new Error(`unknown action.kind: ${action.kind}`);
}

// --- Gmail helpers ---
function getHeader(msg, name) {
  const h = (msg.payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf8");
  }
  for (const p of payload.parts || []) {
    if (p.mimeType === "text/plain" && p.body?.data) {
      return Buffer.from(p.body.data, "base64").toString("utf8");
    }
  }
  for (const p of payload.parts || []) {
    const inner = extractBody(p);
    if (inner) return inner;
  }
  return "";
}

function buildRfc822({ to, from, subject, inReplyTo, references, body }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references || inReplyTo}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
  ].join("\r\n");
  return headers + body;
}

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendThreadedReply({ gmail, originalMsgId, threadId, bodyText }) {
  // Fetch original to get From, Subject, Message-ID
  const orig = await gmail.users.messages.get({
    userId: "me", id: originalMsgId, format: "metadata",
    metadataHeaders: ["From", "Subject", "Message-ID", "References"],
  });
  const origFrom = getHeader(orig.data, "From");
  const origSubject = getHeader(orig.data, "Subject");
  const origMsgId = getHeader(orig.data, "Message-ID") || getHeader(orig.data, "Message-Id");
  const origRefs = getHeader(orig.data, "References");

  // Reply-to address = original sender
  const toAddr = origFrom.match(/<([^>]+)>/)?.[1] || origFrom;
  const replySubj = origSubject.toLowerCase().startsWith("re:") ? origSubject : `Re: ${origSubject}`;
  const refs = origRefs ? `${origRefs} ${origMsgId}` : origMsgId;

  const raw = buildRfc822({
    to: toAddr,
    from: "kevin.hopper@maestro.press",
    subject: replySubj,
    inReplyTo: origMsgId,
    references: refs,
    body: bodyText,
  });

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: b64url(raw),
      threadId,
    },
  });
  return sent.data;
}

// --- Main ---
async function main() {
  console.error(`[router] starting at ${new Date().toISOString()}`);
  const auth = makeAuth();
  const gmail = google.gmail({ version: "v1", auth });

  // Resolve label ids
  const labels = (await gmail.users.labels.list({ userId: "me" })).data.labels || [];
  const labelByName = new Map(labels.map(l => [l.name, l.id]));
  const sourceLabelId = labelByName.get(SOURCE_LABEL);
  const processedLabelId = labelByName.get(MARKER_PROCESSED);
  const failedLabelId = labelByName.get(MARKER_FAILED);
  if (!sourceLabelId || !processedLabelId || !failedLabelId) {
    console.error(`[router] missing label(s) — run setup_router_label.mjs first`);
    process.exit(1);
  }

  // List unprocessed mail on label
  const q = `label:${SOURCE_LABEL} -label:${MARKER_PROCESSED} -label:${MARKER_FAILED}`;
  const lres = await gmail.users.messages.list({ userId: "me", q, maxResults: MAX_MESSAGES_PER_RUN });
  const msgs = lres.data.messages || [];
  if (!msgs.length) {
    console.error(`[router] 0 unprocessed messages on ${SOURCE_LABEL}`);
    return;
  }
  console.error(`[router] ${msgs.length} message(s) to process`);

  for (const meta of msgs) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: meta.id, format: "full" });
      const subject = getHeader(full.data, "Subject");
      const body = extractBody(full.data.payload);
      const intent = classify(subject, body);

      console.error(`[router]   ${meta.id} subject="${subject.slice(0, 60)}" intent=${intent?.name || "unknown"}`);

      let replyBody;
      if (!intent) {
        replyBody = `I didn't recognize that request.

Subject: ${subject}

Send "help" for a list of commands.`;
      } else if (intent.action.kind === "help") {
        replyBody = HELP_TEXT;
      } else {
        try {
          const result = await dispatch(intent.action);
          replyBody = `✓ ${intent.summary}\n\nResult: ${result}\n\nThe target pipeline/service has been triggered. You'll get downstream emails (digest, notifier, etc.) as the work completes.`;
        } catch (err) {
          replyBody = `✗ ${intent.summary} — failed.\n\nError: ${err.message}`;
        }
      }

      await sendThreadedReply({
        gmail,
        originalMsgId: meta.id,
        threadId: full.data.threadId,
        bodyText: replyBody + "\n\n— router\n",
      });

      await gmail.users.messages.modify({
        userId: "me",
        id: meta.id,
        requestBody: { addLabelIds: [processedLabelId] },
      });
      console.error(`[router]   ${meta.id} → replied + marked processed`);
    } catch (err) {
      console.error(`[router]   ${meta.id} failed: ${err.stack || err.message}`);
      try {
        await gmail.users.messages.modify({
          userId: "me",
          id: meta.id,
          requestBody: { addLabelIds: [failedLabelId] },
        });
      } catch {}
    }
  }
  console.error(`[router] done`);
}

main().catch(err => {
  console.error(`[router] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
