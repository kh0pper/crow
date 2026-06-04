#!/usr/bin/env node
// capture-fixture.mjs — one-time capture of a PIR response email as a self-
// contained fixture for the full-flow harness INGEST stage.
//
//   node capture-fixture.mjs <pir_number> [--msg <gmail_message_id>]
//
// Fetches the Gmail message via `messages.get(format:full)` — the EXACT payload
// shape the live sync pure functions (ingestReplay) consume — and writes it to
// scripts/bench/fixtures/<pir_number>.json. If --msg is omitted, the message_id
// is read from the holding dir's inbound.json. Attachment BYTES are not in a
// `full` fetch (only metadata); the bot reads the already-downloaded bytes from
// the holding dir, so the fixture only needs payload + headers for INGEST.

import fs from "node:fs";
import path from "node:path";
import { google } from "/home/kh0pp/crow/node_modules/googleapis/build/src/index.js";

const PIR = process.argv[2];
if (!PIR) { console.error("usage: capture-fixture.mjs <pir_number> [--msg <id>]"); process.exit(1); }
const mi = process.argv.indexOf("--msg");
let msgId = mi !== -1 ? process.argv[mi + 1] : null;

const SOURCES = "/home/kh0pp/spring-2026/insd-5941/sources";
const FIXTURES = "/home/kh0pp/crow/scripts/bench/fixtures";
const TOKEN_PATH = process.env.PIR_GMAIL_TOKEN_PATH || "/home/kh0pp/.config/google-workspace-mcp/token.json";
const CREDS_PATH = process.env.PIR_GMAIL_CREDS_PATH || "/home/kh0pp/.config/google-workspace-mcp/credentials.json";

if (!msgId) {
  const inboundP = path.join(SOURCES, "pir-incoming", PIR, "inbound.json");
  if (!fs.existsSync(inboundP)) { console.error(`no inbound.json at ${inboundP}; pass --msg <id>`); process.exit(1); }
  msgId = JSON.parse(fs.readFileSync(inboundP, "utf8")).message_id;
}
if (!msgId) { console.error("could not resolve message_id"); process.exit(1); }

function makeAuth() {
  const tk = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  const cr = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")).installed;
  const auth = new google.auth.OAuth2(cr.client_id, cr.client_secret);
  auth.setCredentials({ access_token: tk.token, refresh_token: tk.refresh_token, expiry_date: new Date(tk.expiry).getTime() });
  return auth;
}

const gmail = google.gmail({ version: "v1", auth: makeAuth() });
const msg = (await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" })).data;
fs.mkdirSync(FIXTURES, { recursive: true });
const out = path.join(FIXTURES, `${PIR}.json`);
fs.writeFileSync(out, JSON.stringify(msg, null, 2));

// quick summary
const hdr = (n) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
console.log(`captured ${out}`);
console.log(`  subject: ${hdr("Subject").slice(0, 90)}`);
console.log(`  from:    ${hdr("From")}`);
console.log(`  size:    ${(JSON.stringify(msg).length / 1024).toFixed(1)} KB`);
