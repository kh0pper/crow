/**
 * The gateway's Gmail draft client (spec §12.3): read the draft, rewrite it, send it — as the account
 * the draft was made in, using the credential reference stored on the staged row.
 *
 * This is the ONLY place a staged draft is sent, and it is gateway code: no MCP server gets a
 * draft-send tool (pi-lab's external-send gate treats any name containing "draft" as safe, so adding
 * one would hand every bot a send). The route above it claims the row first; this module just calls
 * the provider and reports.
 *
 * Credential handling follows the pm-workspace digest adapter: the token file is read, the access
 * token is minted from the refresh grant IN MEMORY, and the file is never written back (the Python
 * MCP server owns it, and two writers would race). The token file itself is resolved from operator
 * config through `cred-ref.js` — never from anything a bot can write.
 *
 * Errors are `GmailError` with a code (`gone`, `auth`, `rate`, `other`) and a fixed message. The
 * provider's response body is NEVER read on a failure and never ends up in the error: a Gmail error
 * echoes the request, so an untouched body is the only way a draft's text stays out of the logs.
 *
 * Transport: Gmail's REST API over `fetch` (injectable `fetchImpl`; tests pass
 * `tests/fixtures/fake-gmail.mjs`). The access token is minted from the refresh grant in memory and
 * the token file is never written back.
 */
import { readFileSync } from "node:fs";
import { canonicalSnapshot } from "./canonical.js";
import { resolveTokenFile } from "./cred-ref.js";

const GMAIL_BASE = "https://gmail.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const HTTP_TIMEOUT_MS = 20_000;

const MESSAGES = Object.freeze({
  gone: "This draft is gone from Gmail",
  auth: "Gmail did not accept the credential",
  rate: "Gmail is rate limiting requests",
  other: "Gmail request failed",
});

/** A provider failure, by code. The message is fixed: a provider body never reaches it. */
export class GmailError extends Error {
  constructor(code) {
    const known = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : "other";
    super(MESSAGES[known]);
    this.name = "GmailError";
    this.code = known;
  }
}

function codeForStatus(status) {
  if (status === 404) return "gone";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  return "other";
}

/* ------------------------------------------------------------------ MIME */

/** Head/body split and unfolded, lower-cased header names: enough for the gws draft shape. */
function parseMime(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const cut = text.indexOf("\n\n");
  const head = cut < 0 ? text : text.slice(0, cut);
  const body = cut < 0 ? "" : text.slice(cut + 2);
  const headers = {};
  let last = null;
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last) { headers[last] += " " + line.trim(); continue; }
    const i = line.indexOf(":");
    if (i <= 0) continue;
    last = line.slice(0, i).trim().toLowerCase();
    headers[last] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

function decodeQuotedPrintable(text) {
  const bytes = [];
  const s = String(text).replace(/=\n/g, "");
  for (let i = 0; i < s.length; i++) {
    const pair = s.slice(i + 1, i + 3);
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(pair)) { bytes.push(parseInt(pair, 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(String(body).replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return String(body);
}

/** The message's text: the text/plain part of a multipart/alternative draft, else the body itself. */
function extractText(headers, body) {
  const ctype = headers["content-type"] || "";
  const m = /boundary="?([^";]+)"?/i.exec(ctype);
  if (!/^multipart\//i.test(ctype) || !m) return decodeTransfer(body, headers["content-transfer-encoding"]);
  const boundary = "--" + m[1];
  let first = null;
  for (const chunk of body.split(boundary)) {
    const part = chunk.replace(/^\n/, "");
    if (!part || part.startsWith("--")) continue; // preamble, or the closing "--"
    const { headers: ph, body: pbody } = parseMime(part);
    const ptype = (ph["content-type"] || "text/plain").toLowerCase();
    if (ptype.startsWith("text/plain")) return decodeTransfer(pbody, ph["content-transfer-encoding"]);
    if (!first) first = { body: pbody, encoding: ph["content-transfer-encoding"] };
  }
  return first ? decodeTransfer(first.body, first.encoding) : "";
}

/** A raw RFC 822 message as the canonical snapshot (to/cc/bcc/subject/body). */
export function snapshotFromRaw(raw) {
  const { headers, body } = parseMime(raw);
  return canonicalSnapshot({
    to: headers.to,
    cc: headers.cc,
    bcc: headers.bcc,
    subject: headers.subject,
    body: extractText(headers, body),
  });
}

/** RFC 2047 for a non-ASCII subject; control characters can never break the header block. */
function encodeHeader(value) {
  const s = String(value ?? "").replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function wrapBase64(b64) {
  return b64.replace(/(.{76})/g, "$1\n");
}

/**
 * The new raw message for an edited draft. To/Cc/Bcc/Subject/body come from the snapshot; the
 * threading headers (Message-ID, In-Reply-To, References) are kept from the message being replaced,
 * so the edit stays the same message in the same conversation.
 */
function buildRaw(snapshot, keep) {
  const lines = [];
  const add = (name, value) => {
    if (value == null || String(value) === "") return;
    lines.push(`${name}: ${String(value).replace(/[\r\n]+/g, " ")}`);
  };
  add("To", snapshot.to.join(", "));
  add("Cc", snapshot.cc.join(", "));
  add("Bcc", snapshot.bcc.join(", "));
  add("Subject", encodeHeader(snapshot.subject));
  add("Message-ID", keep["message-id"]);
  add("In-Reply-To", keep["in-reply-to"]);
  add("References", keep["references"]);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  const encoded = wrapBase64(Buffer.from(snapshot.body, "utf8").toString("base64"));
  return lines.join("\n") + "\n\n" + encoded + "\n";
}

const toBase64Url = (text) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text) => Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/* ------------------------------------------------------------- transports */

/** The token file's JSON, or null. Nothing here writes the file back. */
function readTokenJson(tokenFile) {
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch {
    return null;
  }
}

function fetchTransport({ credRef, fetchImpl, configPaths, baseUrl, tokenUrl }) {
  let accessToken = null;

  async function mint() {
    const tokenFile = resolveTokenFile(credRef, configPaths);
    if (!tokenFile) throw new GmailError("auth");
    const creds = readTokenJson(tokenFile);
    if (!creds) throw new GmailError("auth");
    if (creds.refresh_token && creds.client_id && creds.client_secret) {
      let res;
      try {
        res = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            refresh_token: creds.refresh_token,
            grant_type: "refresh_token",
          }).toString(),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch {
        throw new GmailError("other");
      }
      if (!res.ok) throw new GmailError("auth");
      const json = await res.json().catch(() => null);
      if (!json || !json.access_token) throw new GmailError("auth");
      return json.access_token;
    }
    // A still-valid access token, as the digest adapter falls back to.
    if (creds.token) return creds.token;
    throw new GmailError("auth");
  }

  async function call(path, init = {}) {
    accessToken = accessToken || (await mint());
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...(init.body != null ? { "Content-Type": "application/json" } : {}) },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new GmailError("other");
    }
    // Read nothing from a failed response: its body echoes the draft.
    if (!res.ok) throw new GmailError(codeForStatus(res.status));
    return res.json().catch(() => ({}));
  }

  return {
    async get(id) {
      const data = await call(`/gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=raw`);
      const message = (data && data.message) || {};
      if (!message.raw) throw new GmailError("other");
      return { raw: fromBase64Url(message.raw), threadId: message.threadId ?? null };
    },
    async update(id, threadId, raw) {
      await call(`/gmail/v1/users/me/drafts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ id, message: { threadId, raw } }),
      });
    },
    async send(id) {
      return call("/gmail/v1/users/me/drafts/send", { method: "POST", body: JSON.stringify({ id }) });
    },
  };
}

/* ----------------------------------------------------------------- client */

/**
 * `{ getDraft, updateDraft, sendDraft }` for one credential reference.
 *   getDraft(id)            -> { snapshot, threadId, raw }   (raw: the decoded RFC 822 message)
 *   updateDraft(id, snap)   -> void                          (keeps threadId + reply headers)
 *   sendDraft(id)           -> { messageId, threadId }
 * Throws GmailError only. `configPaths` is the token-config seam ({ canonical, addons }).
 */
export function createGmailClient({ credRef, fetchImpl, configPaths, baseUrl = GMAIL_BASE, tokenUrl = TOKEN_URL } = {}) {
  const transport = fetchTransport({ credRef, fetchImpl: fetchImpl || globalThis.fetch, configPaths, baseUrl, tokenUrl });

  return {
    async getDraft(id) {
      const { raw, threadId } = await transport.get(String(id));
      return { snapshot: snapshotFromRaw(raw), threadId, raw };
    },

    async updateDraft(id, snapshot) {
      const current = await transport.get(String(id));
      const { headers } = parseMime(current.raw);
      const raw = buildRaw(canonicalSnapshot(snapshot), headers);
      await transport.update(String(id), current.threadId, toBase64Url(raw));
    },

    async sendDraft(id) {
      const data = await transport.send(String(id));
      return { messageId: data.id ?? null, threadId: data.threadId ?? null };
    },
  };
}