#!/usr/bin/env node
// sync_gmail_to_candidates.mjs — Phase 8.1 Pathway B
//
// Pulls job-posting alert emails from kevin.hopper@maestro.press (the bot's
// Gmail account) and upserts each listing as a row in job_candidates in MPA's
// crow.db. Idempotent. Scheduled via systemd timer every 30 min.
//
// Sources are identified by Gmail labels under the `job-alerts/` namespace.
// The script ensures these labels exist on each run (creates if missing).
//
// Extraction strategy is two-tier:
//   1. LinkedIn alerts use a deterministic linkedom-based parser (DOM is
//      stable across years of LinkedIn emails).
//   2. Everything else (Indeed, ZipRecruiter, freeform recruiter outreach)
//      routes through a single LLM extraction call against the local
//      llama-server at :8003 (qwen3.6-35b-a3b).
//
// Both paths funnel through validateListing() before insert.
//
// Once a message is successfully processed, it gets the `job-alerts/ingested`
// label so the next run's label-filtered query naturally skips it. Parse
// failures get `job-alerts/ingest-failed` so they surface for manual triage.
//
// LinkedIn URL canonicalization: HTTP HEAD with redirect-follow resolves
// linkedin.com/comm/jobs/view/<id>?tracker=... → linkedin.com/jobs/view/<id>,
// improving intra-LinkedIn dedupe across weekly digests. Cross-source dedup
// against ed-jobs (different ATS URLs) is a deferred problem.
//
// Runs on crow. Requires:
//   - googleapis npm in ~/crow/node_modules (added 2026-05-13)
//   - gws-mcp OAuth tokens at /home/kh0pp/.config/google-workspace-mcp-mpa/
//   - local llama-server reachable at http://localhost:8003/v1/chat/completions
//   - MPA's crow.db at /home/kh0pp/.crow-mpa/data/crow.db
//
// Exit codes: 0 success, 1 setup/connectivity error, 2 batch failure.

import crypto from "node:crypto";
import fs from "node:fs";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { google } from "/home/kh0pp/crow/node_modules/googleapis/build/src/index.js";
import { parseHTML } from "/home/kh0pp/crow/node_modules/linkedom/esm/index.js";

const MPA_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
const TOKEN_PATH = "/home/kh0pp/.config/google-workspace-mcp-mpa/gws-token.json";
const CREDS_PATH = "/home/kh0pp/.config/google-workspace-mcp-mpa/credentials.json";

// Note: llamacpp Docker container binds to the tailnet IP, not loopback.
// See `docker inspect llamacpp-vulkan-qwen36-35b-a3b` HostConfig.PortBindings.
const LLAMA_URL = "http://100.118.41.122:8003/v1/chat/completions";
const LLM_MODEL = "qwen3.6-35b-a3b";

const LABEL_TO_SOURCE = {
  "job-alerts/linkedin": "gmail:linkedin",
  "job-alerts/indeed": "gmail:indeed",
  "job-alerts/ziprecruiter": "gmail:ziprecruiter",
  "job-alerts/recruiter-direct": "gmail:recruiter-direct",
};
const SOURCE_LABELS = Object.keys(LABEL_TO_SOURCE);
const MARKER_INGESTED = "job-alerts/ingested";
const MARKER_FAILED = "job-alerts/ingest-failed";

const MAX_MESSAGES_PER_LABEL_PER_RUN = 50;
const HTTP_REDIRECT_TIMEOUT_MS = 5000;
const HTTP_REDIRECT_MAX_HOPS = 5;
// Local llama-server (qwen3.6-35b-a3b on Strix Halo) is ~50s cold per call,
// 5-6s warm. With 14KB email body + 20 LinkedIn listings this can comfortably
// stretch — give it a generous ceiling. See feedback_mpa_pipeline_timeout_raised_15min.
const LLM_TIMEOUT_MS = 180_000;

function normalize(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateId(employer, title, url) {
  return crypto
    .createHash("sha256")
    .update(`${normalize(employer)}|${normalize(title)}|${normalize(url)}`)
    .digest("hex");
}

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
  // googleapis will refresh in-memory on demand.
  return auth;
}

async function ensureLabels(gmail) {
  const existing = (await gmail.users.labels.list({ userId: "me" })).data.labels || [];
  const byName = new Map(existing.map((l) => [l.name, l.id]));
  const want = [...SOURCE_LABELS, MARKER_INGESTED, MARKER_FAILED];
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
    console.error(`[sync-gmail] created ${created.length} missing label(s): ${created.join(", ")}`);
  }
  return byName;
}

function decodeBase64Url(s) {
  if (!s) return "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function walkParts(payload, out) {
  if (!payload) return;
  if (payload.body && payload.body.data) {
    out.push({ mimeType: payload.mimeType, data: decodeBase64Url(payload.body.data) });
  }
  if (payload.parts) for (const p of payload.parts) walkParts(p, out);
}

function extractBody(msg) {
  const parts = [];
  walkParts(msg.payload, parts);
  const html = parts.find((p) => p.mimeType === "text/html");
  const text = parts.find((p) => p.mimeType === "text/plain");
  return { html: html ? html.data : "", text: text ? text.data : "" };
}

function getHeader(msg, name) {
  const headers = msg.payload?.headers || [];
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// ---------------------------------------------------------------------------
// LinkedIn deterministic parser
// ---------------------------------------------------------------------------

function parseLinkedIn(html) {
  if (!html) return [];
  const { document } = parseHTML(html);
  const listings = [];
  const seen = new Set();

  // LinkedIn alert emails wrap each job in a card. The signature shape is an
  // anchor whose href matches /(comm/)?jobs/view/<digits>. Title text sits
  // inside the anchor. Employer + location live in sibling cells below.
  const anchors = Array.from(document.querySelectorAll('a[href*="linkedin.com"]'));
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    if (!/\/jobs\/view\/\d+/.test(href)) continue;
    const title = (a.textContent || "").trim().replace(/\s+/g, " ");
    if (!title || title.length < 3) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    // Walk up to the enclosing card (table row / div containing the anchor),
    // then collect the remaining text content. Employer is usually the first
    // non-title text line; location follows.
    let card = a;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      card = card.parentElement;
      const t = (card.textContent || "").trim();
      if (t.length > title.length + 10) break; // found a card-sized container
    }
    const cardText = (card.textContent || "").replace(/\s+/g, " ").trim();
    const tail = cardText.replace(title, "").trim();
    // First line of tail often "<Employer> · <Location>" or "<Employer>\n<Location>"
    const segs = tail.split(/[·•·|]|\s{2,}|\n/).map((s) => s.trim()).filter(Boolean);
    const employer = segs[0] || "";
    const location = segs[1] || "";
    listings.push({
      title,
      url: href,
      employer,
      location,
      description: tail.slice(0, 1200) || null,
    });
  }
  return listings;
}

// ---------------------------------------------------------------------------
// LLM extraction (Indeed, ZipRecruiter, recruiter-direct, and fallback)
// ---------------------------------------------------------------------------

function htmlToText(html) {
  if (!html) return "";
  const { document } = parseHTML(html);
  // Drop noisy elements
  for (const el of Array.from(document.querySelectorAll("style,script,head,meta,link"))) {
    el.remove();
  }
  // Convert anchors to "TEXT <URL>" so URLs survive into plaintext
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") || "";
    const t = (a.textContent || "").trim();
    if (href && t) a.textContent = `${t} <${href}>`;
  }
  return (document.body?.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function llmExtract({ text, fromHeader, subject, sourceKey }) {
  const truncated = text.slice(0, 14_000);
  const system = `You extract job postings from emails. Output a JSON array. Each element MUST have exactly these keys: title (string), employer (string), url (string), location (string, may be empty), description (string, may be empty, max 800 chars). NO commentary, NO markdown, NO explanation. If the email contains no job postings, output []. If multiple postings appear, output all of them in order. URLs MUST be the actual posting/apply URL from the email — never invent URLs.`;
  const user = `Source: ${sourceKey}\nFrom: ${fromHeader}\nSubject: ${subject}\n\n--- email body ---\n${truncated}\n--- end body ---\n\nReturn JSON array of job postings now.`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(LLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.1,
        max_tokens: 2400,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`llm http ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const j = await resp.json();
  const content = j.choices?.[0]?.message?.content || "";
  if (!content.trim()) return [];

  // The model may emit either a bare JSON array or {"jobs":[...]} or wrap
  // in markdown fences. Be lenient.
  let parsed;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = (fenced ? fenced[1] : content).trim();
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to find the first [ ... ] block
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs;
  if (parsed && Array.isArray(parsed.postings)) return parsed.postings;
  if (parsed && Array.isArray(parsed.results)) return parsed.results;
  // Single-object fallback
  if (parsed && typeof parsed === "object" && parsed.title && parsed.url) return [parsed];
  return [];
}

// ---------------------------------------------------------------------------
// URL canonicalization (redirect follow + tracking-param strip)
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "trk", "trackingId", "lipi", "midToken", "midSig", "trkEmail",
  "ssn_id", "ssn_token", "_gl", "gclid", "fbclid", "mc_cid", "mc_eid",
  "ref", "ref_src", "src",
]);

function stripTrackingParams(u) {
  try {
    const url = new URL(u);
    const keep = [];
    for (const [k, v] of url.searchParams) {
      if (!TRACKING_PARAMS.has(k)) keep.push([k, v]);
    }
    url.search = "";
    for (const [k, v] of keep) url.searchParams.append(k, v);
    return url.toString();
  } catch {
    return u;
  }
}

const urlCache = new Map();

async function canonicalUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (urlCache.has(rawUrl)) return urlCache.get(rawUrl);
  let current = rawUrl;
  try {
    for (let hop = 0; hop < HTTP_REDIRECT_MAX_HOPS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_REDIRECT_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(current, {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; CrowJobIngest/0.1)" },
        });
      } finally {
        clearTimeout(timer);
      }
      const loc = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    }
  } catch {
    // network failure / timeout — fall back to the input URL stripped of trackers
  }
  const cleaned = stripTrackingParams(current);
  urlCache.set(rawUrl, cleaned);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /^(n\/?a|tbd|unknown|none|null|undefined|see (above|below|description))$/i;

function validateListing(l) {
  if (!l || typeof l !== "object") return { ok: false, reason: "not-object" };
  const title = (l.title || "").trim();
  const employer = (l.employer || "").trim();
  const url = (l.url || "").trim();
  if (!title || title.length < 5) return { ok: false, reason: "title-too-short" };
  if (PLACEHOLDER_RE.test(title)) return { ok: false, reason: "title-placeholder" };
  if (!employer) return { ok: false, reason: "no-employer" };
  if (PLACEHOLDER_RE.test(employer)) return { ok: false, reason: "employer-placeholder" };
  if (!url) return { ok: false, reason: "no-url" };
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "bad-protocol" };
  } catch {
    return { ok: false, reason: "url-not-parseable" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function processMessage({ gmail, db, upsert, msgMeta, source, labelIds }) {
  const msg = (
    await gmail.users.messages.get({
      userId: "me",
      id: msgMeta.id,
      format: "full",
    })
  ).data;

  const { html, text } = extractBody(msg);
  const fromHeader = getHeader(msg, "From");
  const subject = getHeader(msg, "Subject");
  const internalDate = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;

  let rawListings = [];
  if (source === "gmail:linkedin") {
    rawListings = parseLinkedIn(html);
  }
  // Fallback to LLM if deterministic parser came up empty OR for non-LinkedIn
  if (rawListings.length === 0) {
    const bodyText = text || htmlToText(html);
    if (bodyText.trim()) {
      rawListings = await llmExtract({
        text: bodyText,
        fromHeader,
        subject,
        sourceKey: source,
      });
    }
  }

  let added = 0, updated = 0, rejected = 0;
  let matchIndex = 0;
  for (const raw of rawListings) {
    matchIndex++;
    const validated = validateListing(raw);
    if (!validated.ok) {
      rejected++;
      console.error(`[sync-gmail]   reject (${validated.reason}): ${JSON.stringify(raw).slice(0,160)}`);
      continue;
    }
    const canon = await canonicalUrl(raw.url);
    const id = candidateId(raw.employer, raw.title, canon);
    const existed = !!db.prepare("SELECT 1 FROM job_candidates WHERE id = ?").get(id);
    const payload = {
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      internal_date: internalDate,
      from: fromHeader,
      subject,
      snippet: msg.snippet || "",
      match_index: matchIndex,
      raw_url: raw.url,
      canonical_url: canon,
    };
    upsert.run({
      id,
      source,
      source_ref: `${msg.id}:${matchIndex}`,
      employer: raw.employer,
      title: raw.title,
      url: canon,
      location: raw.location || null,
      remote: null,
      salary_min: null,
      salary_max: null,
      posted_at: internalDate,
      description: (raw.description || "").slice(0, 8000) || null,
      raw_payload: JSON.stringify(payload),
    });
    if (existed) updated++; else added++;
  }

  return { added, updated, rejected, listingsExtracted: rawListings.length };
}

async function processLabel({ gmail, db, upsert, labelName, labelIds }) {
  const source = LABEL_TO_SOURCE[labelName];
  const sourceLabelId = labelIds.get(labelName);
  const ingestedLabelId = labelIds.get(MARKER_INGESTED);
  const failedLabelId = labelIds.get(MARKER_FAILED);

  // List messages that have the source label but neither the ingested nor the
  // failed marker. Gmail's search syntax requires -label:<name> for negation.
  const q = `label:${labelName} -label:${MARKER_INGESTED} -label:${MARKER_FAILED}`;
  const listResp = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: MAX_MESSAGES_PER_LABEL_PER_RUN,
  });
  const msgs = listResp.data.messages || [];
  if (!msgs.length) {
    console.error(`[sync-gmail] ${labelName}: 0 unprocessed messages`);
    return { added: 0, updated: 0, rejected: 0, errors: 0, msgs: 0 };
  }
  console.error(`[sync-gmail] ${labelName}: ${msgs.length} message(s) to process`);

  let added = 0, updated = 0, rejected = 0, errors = 0;
  for (const meta of msgs) {
    try {
      const r = await processMessage({ gmail, db, upsert, msgMeta: meta, source, labelIds });
      added += r.added;
      updated += r.updated;
      rejected += r.rejected;
      // Mark processed only after upsert success
      await gmail.users.messages.modify({
        userId: "me",
        id: meta.id,
        requestBody: { addLabelIds: [ingestedLabelId] },
      });
      console.error(`[sync-gmail]   ${meta.id}: extracted=${r.listingsExtracted} added=${r.added} updated=${r.updated} rejected=${r.rejected}`);
    } catch (err) {
      errors++;
      console.error(`[sync-gmail]   ${meta.id}: parse/upsert failed: ${err.message}`);
      try {
        await gmail.users.messages.modify({
          userId: "me",
          id: meta.id,
          requestBody: { addLabelIds: [failedLabelId] },
        });
      } catch {
        // swallow — non-fatal
      }
    }
  }
  return { added, updated, rejected, errors, msgs: msgs.length };
}

async function main() {
  console.error(`[sync-gmail] starting at ${new Date().toISOString()}`);
  const auth = makeAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const labelIds = await ensureLabels(gmail);

  const db = new Database(MPA_DB);
  db.pragma("journal_mode = DELETE");
  db.pragma("busy_timeout = 5000");

  const upsert = db.prepare(`
    INSERT INTO job_candidates
      (id, source, source_ref, employer, title, url, location, remote,
       salary_min, salary_max, posted_at, description, raw_payload,
       status, created_at, updated_at)
    VALUES
      (@id, @source, @source_ref, @employer, @title, @url, @location, @remote,
       @salary_min, @salary_max, @posted_at, @description, @raw_payload,
       'new', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      source       = excluded.source,
      source_ref   = excluded.source_ref,
      employer     = excluded.employer,
      title        = excluded.title,
      url          = excluded.url,
      location     = excluded.location,
      posted_at    = COALESCE(excluded.posted_at, job_candidates.posted_at),
      description  = COALESCE(excluded.description, job_candidates.description),
      raw_payload  = excluded.raw_payload,
      updated_at   = datetime('now')
  `);
  // Scout/user state preserved on conflict: match_score, match_notes, status,
  // shown_in_digest_id, application_id, user_priority are NOT in the SET list.

  const totals = { added: 0, updated: 0, rejected: 0, errors: 0, msgs: 0 };
  for (const labelName of SOURCE_LABELS) {
    const r = await processLabel({ gmail, db, upsert, labelName, labelIds });
    for (const k of Object.keys(totals)) totals[k] += r[k];
  }

  db.close();
  console.error(
    `[sync-gmail] done: ${totals.msgs} message(s), ` +
      `${totals.added} new candidate(s), ${totals.updated} updated, ` +
      `${totals.rejected} rejected, ${totals.errors} message error(s)`,
  );
  if (totals.errors > 0) process.exit(2);
}

main().catch((err) => {
  console.error(`[sync-gmail] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
