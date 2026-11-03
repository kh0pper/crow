/**
 * The gateway's Gmail draft client (spec §12.3): read the draft, rewrite it, send it — as the account
 * the draft was made in, using the credential reference stored on the staged row.
 *
 * This is the ONLY place a staged draft is sent, and it is gateway code: no MCP server gets a
 * draft-send tool (pi-lab's external-send gate treats any name containing "draft" as safe, so adding
 * one would hand every bot a send). The route above it claims the row first; this module just calls
 * the provider and reports.
 *
 * Crow sends exactly what the operator approved. The approval hash is taken over OUR parse of the
 * draft, so `sendDraft` never asks Gmail to send its stored draft as-is: it rebuilds the RFC 822
 * message from the approved snapshot (`buildRaw`) and sends that, keeping only the threading headers
 * and the thread id from the stored draft. An HTML part, an attachment, a second To, or a Bcc the
 * bot added after approval therefore cannot ride along unseen. `getDraft` also reports whether the
 * draft is `faithful` (a shape we can rebuild exactly), and the route shows "Open in Gmail to send"
 * for the ones that are not.
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
 * `tests/fixtures/fake-gmail.mjs`).
 */
import { readFileSync } from "node:fs";
import { canonicalSnapshot, decodeEncodedWords, parseAddressListDetailed } from "./canonical.js";
import { resolveTokenFile } from "./cred-ref.js";

const GMAIL_BASE = "https://gmail.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_CHARSET = "utf-8";
const SNIFFABLE_CHARS = /[\x80-\xFF]/;

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

/**
 * Our raw messages are byte-preserving strings (one character per byte, latin1), so a part's own
 * charset can be applied when its text is decoded: a Latin-1 part is not mojibake.
 */
const bytesOf = (text) => Buffer.from(String(text ?? ""), "latin1");

/** Bytes in a named charset, falling back to UTF-8 when the label is unknown or unusable. */
function decodeCharset(bytes, charset) {
  const label = String(charset || DEFAULT_CHARSET).trim().replace(/^["']|["']$/g, "").toLowerCase() || DEFAULT_CHARSET;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder(DEFAULT_CHARSET).decode(bytes);
  }
}

/** `?name=value` of a Content-Type/Content-Disposition header (boundary, charset, filename…). */
function paramValue(header, name) {
  const m = new RegExp(`${name}\\s*=\\s*"?([^";\\s]+)"?`, "i").exec(String(header ?? ""));
  return m ? m[1] : null;
}

/** Just the media type: `text/plain; charset=UTF-8` -> `text/plain`. */
function mediaType(header) {
  return String(header ?? "").split(";")[0].trim().toLowerCase() || "text/plain";
}

/**
 * Head/body split with headers unfolded: `headers` is the last occurrence per name (the value the
 * parse uses), `list` keeps every occurrence so a duplicate To/Subject can be detected.
 */
function parseMime(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const cut = text.indexOf("\n\n");
  const head = cut < 0 ? text : text.slice(0, cut);
  const body = cut < 0 ? "" : text.slice(cut + 2);
  const list = [];
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && list.length) { list[list.length - 1].value += " " + line.trim(); continue; }
    const i = line.indexOf(":");
    if (i <= 0) continue;
    list.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  const headers = {};
  for (const h of list) headers[h.name] = h.value;
  return { headers, list, body };
}

function quotedPrintableBytes(text) {
  const s = String(text ?? "").replace(/=\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/** One part's text, in its own charset (L4) and transfer encoding. */
function decodePart(headers, body) {
  const enc = String(headers["content-transfer-encoding"] ?? "").trim().toLowerCase();
  const charset = paramValue(headers["content-type"], "charset");
  if (enc === "base64") return decodeCharset(Buffer.from(String(body).replace(/\s+/g, ""), "base64"), charset);
  if (enc === "quoted-printable") return decodeCharset(quotedPrintableBytes(body), charset);
  return decodeCharset(bytesOf(body), charset);
}

/** A MIME entity: its headers, its raw body, and its children when it is multipart. */
function parseEntity(text) {
  const { headers, list, body } = parseMime(text);
  const ctype = headers["content-type"] || "";
  const boundary = paramValue(ctype, "boundary");
  if (!/^multipart\//i.test(ctype) || !boundary) {
    return { headers, list, body, type: mediaType(ctype), parts: null };
  }
  const parts = [];
  const chunks = body.split("--" + boundary);
  for (let i = 1; i < chunks.length; i++) { // chunks[0] is the preamble
    const part = chunks[i].replace(/^\n/, "");
    if (!part || part.startsWith("--")) continue; // the closing "--boundary--", or an empty part
    parts.push(parseEntity(part));
  }
  return { headers, list, body, type: mediaType(ctype), parts };
}

/**
 * An 8-bit header value as its own bytes. A compliant header is ASCII (or an encoded word), but a
 * provider or a bot may write UTF-8 into it; decoding those bytes is what keeps a non-ASCII subject
 * stable across a round trip.
 */
function headerText(value) {
  const s = String(value ?? "");
  return SNIFFABLE_CHARS.test(s) ? decodeCharset(bytesOf(s), DEFAULT_CHARSET) : s;
}

/** A part the operator never approved as text: a named or explicitly attached file. */
function isAttachment(entity) {
  const disposition = String(entity.headers["content-disposition"] ?? "");
  if (disposition.trim().toLowerCase().startsWith("attachment")) return true;
  return Boolean(paramValue(disposition, "filename") || paramValue(entity.headers["content-type"], "name"));
}

function leavesOf(entity, out = []) {
  if (entity.parts) { for (const p of entity.parts) leavesOf(p, out); return out; }
  out.push(entity);
  return out;
}

function hasNestedMultipart(entity) {
  return Boolean(entity.parts && entity.parts.some((p) => p.parts));
}

function hasAttachment(entity) {
  if (entity.parts) return entity.parts.some((p) => (p.parts ? hasAttachment(p) : isAttachment(p)));
  return isAttachment(entity);
}

/**
 * The message's text: the text/plain leaf when there is one (that is the text the card shows and the
 * send rebuilds), else the first leaf. Whether the shape is sendable at all is `faithful`'s call.
 */
function extractText(entity) {
  if (!entity.parts) return decodePart(entity.headers, entity.body);
  const leaves = leavesOf(entity);
  const leaf = leaves.find((p) => p.type === "text/plain") || leaves[0];
  return leaf ? decodePart(leaf.headers, leaf.body) : "";
}

const unfaithful = (reason) => ({ ok: false, reason });

/**
 * Can this draft be sent as the snapshot and nothing else? `{ ok: true }` or `{ ok: false, reason }`
 * where the reason is one of:
 *   duplicate-header  more than one To, Cc, Bcc or Subject
 *   reply-to          a Reply-To (a reply would go somewhere else than the card says)
 *   bad-address       an address entry that is not a clean addr-spec (an address in a display name
 *                     or a comment, an address left over beside the brackets, junk)
 *   attachment        an attachment, a named file, or anything dispositioned as one
 *   nested-multipart  a multipart inside a multipart
 *   content-type      a single part that is not text/plain
 *   multipart         any other multipart shape (several text parts, calendar parts, …)
 *
 * The shapes we DO accept are `text/plain` on its own, and `multipart/alternative` of exactly
 * text/plain plus (or only) text/html: the html is dropped on send, which is fine — it is a second
 * rendering of the same text, the plain part is what the operator reads and approves, and Gmail
 * itself would have chosen between them.
 */
export function faithful(raw) {
  const root = parseEntity(String(raw ?? ""));
  const count = (name) => root.list.filter((h) => h.name === name).length;
  for (const name of ["to", "cc", "bcc", "subject"]) {
    if (count(name) > 1) return unfaithful("duplicate-header");
  }
  if (count("reply-to") > 0) return unfaithful("reply-to");
  for (const name of ["to", "cc", "bcc"]) {
    if (parseAddressListDetailed(headerText(root.headers[name])).invalid.length) return unfaithful("bad-address");
  }
  if (!root.parts) {
    if (isAttachment(root)) return unfaithful("attachment");
    return root.type === "text/plain" ? { ok: true } : unfaithful("content-type");
  }
  if (hasNestedMultipart(root)) return unfaithful("nested-multipart");
  if (hasAttachment(root)) return unfaithful("attachment");
  const types = leavesOf(root).map((p) => p.type);
  const plainOnly = types.length === 1 && types[0] === "text/plain";
  const plainAndHtml = types.length === 2 && types.includes("text/plain") && types.includes("text/html");
  if (root.type === "multipart/alternative" && (plainOnly || plainAndHtml)) return { ok: true };
  return unfaithful("multipart");
}

/** A raw RFC 822 message as the canonical snapshot (to/cc/bcc/subject/body). */
export function snapshotFromRaw(raw) {
  const { headers } = parseMime(raw);
  return canonicalSnapshot({
    // Encoded words stay in an address header on purpose: the parser treats them as opaque atoms, so
    // an encoded display name is dropped with its entry instead of being decoded into a delimiter.
    to: headerText(headers.to),
    cc: headerText(headers.cc),
    bcc: headerText(headers.bcc),
    subject: decodeEncodedWords(headerText(headers.subject)),
    body: extractText(parseEntity(raw)),
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
 * The new raw message for an approved snapshot. To/Cc/Bcc/Subject/body come from the snapshot — and
 * only from it; the threading headers (Message-ID, In-Reply-To, References) are kept from the message
 * being replaced, so the edit (or the send) stays the same message in the same conversation.
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

/** The wire form: base64url of the message's UTF-8 bytes (our raws are ASCII by construction). */
const toBase64Url = (text) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** The wire form back: a byte-preserving string, so a part's charset can still be applied. */
const fromBase64Url = (text) => Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");

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
      return {
        raw: fromBase64Url(message.raw),
        threadId: message.threadId ?? data.threadId ?? null,
      };
    },
    async update(id, threadId, raw) {
      await call(`/gmail/v1/users/me/drafts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ id, message: { threadId, raw } }),
      });
    },
    async send(id, raw, threadId) {
      return call("/gmail/v1/users/me/drafts/send", {
        method: "POST",
        body: JSON.stringify({ id, message: { raw, threadId } }),
      });
    },
  };
}

/* ----------------------------------------------------------------- client */

/**
 * `{ getDraft, updateDraft, sendDraft }` for one credential reference.
 *   getDraft(id)                  -> { snapshot, threadId, raw, faithful, reason }
 *   updateDraft(id, snap)         -> void        (keeps threadId + reply headers)
 *   sendDraft(id, {snapshot, threadId}) -> { messageId, threadId }
 * Throws GmailError only (plus a `no_snapshot` Error for a programming mistake). `configPaths` is
 * the token-config seam ({ canonical, addons }).
 */
export function createGmailClient({ credRef, fetchImpl, configPaths, baseUrl = GMAIL_BASE, tokenUrl = TOKEN_URL } = {}) {
  const transport = fetchTransport({ credRef, fetchImpl: fetchImpl || globalThis.fetch, configPaths, baseUrl, tokenUrl });

  return {
    async getDraft(id) {
      const { raw, threadId } = await transport.get(String(id));
      const verdict = faithful(raw);
      return {
        snapshot: snapshotFromRaw(raw),
        threadId,
        raw,
        faithful: verdict.ok,
        reason: verdict.ok ? null : verdict.reason,
      };
    },

    async updateDraft(id, snapshot) {
      const current = await transport.get(String(id));
      const { headers } = parseMime(current.raw);
      const raw = buildRaw(canonicalSnapshot(snapshot), headers);
      await transport.update(String(id), current.threadId, toBase64Url(raw));
    },

    /**
     * Send the approved snapshot — never the stored draft. The provider draft is read only for its
     * threading headers and its thread; the bytes that go out are rebuilt from `snapshot`, so they
     * are exactly the bytes that were hashed. The route has already claimed the row for that hash.
     */
    async sendDraft(id, { snapshot, threadId } = {}) {
      if (!snapshot) {
        throw Object.assign(new Error("staged_sends: sendDraft needs the approved snapshot"), { code: "no_snapshot" });
      }
      const approved = canonicalSnapshot(snapshot);
      const current = await transport.get(String(id));
      const { headers } = parseMime(current.raw);
      const raw = buildRaw(approved, headers);
      const data = await transport.send(String(id), toBase64Url(raw), threadId ?? current.threadId);
      return { messageId: data.id ?? null, threadId: data.threadId ?? null };
    },
  };
}