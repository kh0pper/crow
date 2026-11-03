/**
 * A fake Gmail REST endpoint for the gateway's staged-send client
 * (servers/gateway/staged/gmail-client.js): drafts get/update/send plus the OAuth2 refresh grant,
 * served as a `fetchImpl` so no test ever touches the network.
 *
 * It is deliberately blunt about content: the message raw is base64url MIME, and an error response's
 * body repeats the request (a 404 says the draft id, a failure carries whatever `failNext` was given)
 * — that is exactly what the real API does, and the client must never put any of it in an error.
 *
 * Usage:
 *   const fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({...}), threadId: "t1" } } });
 *   createGmailClient({ credRef, fetchImpl: fake.fetchImpl, configPaths });
 *   fake.calls    { token, get, update, send }
 *   fake.updates  [{ id, threadId, raw }]   // decoded raw of every PUT
 *   fake.sent     [{ id }]                  // every drafts.send
 *   fake.failNext = { status: 500, body: "..." }  // one-shot failure for the next draft request
 */

export const encodeRaw = (text) => Buffer.from(String(text), "utf8").toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const decodeRaw = (text) => Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** A gws-shaped draft: multipart/alternative with one base64 text/plain part, CRLF line endings. */
export function makeDraftRaw({
  to = "alex@example.com",
  cc,
  bcc,
  subject = "Hello",
  body = "Hello there",
  messageId = "<draft-1@example.com>",
  inReplyTo,
  references,
} = {}) {
  const boundary = "fake-boundary-1";
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Message-ID: ${messageId}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push("");
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Buffer.from(String(body), "utf8").toString("base64"));
  lines.push(`--${boundary}--`);
  lines.push("");
  return lines.join("\r\n");
}

function reply(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => text,
  };
}

export function createFakeGmail({ drafts = {} } = {}) {
  const store = new Map();
  for (const [id, draft] of Object.entries(drafts)) {
    store.set(id, { threadId: draft.threadId ?? null, raw: draft.raw });
  }

  const state = {
    drafts: store,
    calls: { token: 0, get: 0, update: 0, send: 0 },
    updates: [],
    sent: [],
    failNext: null,
  };

  async function fetchImpl(url, init = {}) {
    const href = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    const base = "/gmail/v1/users/me/drafts";

    if (href.host === "oauth2.googleapis.com") {
      state.calls.token += 1;
      const form = new URLSearchParams(String(init.body ?? ""));
      if (form.get("grant_type") !== "refresh_token" || !form.get("refresh_token")) {
        return reply(400, { error: "invalid_grant" });
      }
      return reply(200, { access_token: "fake-access-token", expires_in: 3600 });
    }

    if (state.failNext) {
      const { status, body } = state.failNext;
      state.failNext = null;
      return reply(status, body ?? "");
    }

    if (href.pathname === `${base}/send` && method === "POST") {
      state.calls.send += 1;
      const payload = JSON.parse(String(init.body || "{}"));
      const draft = store.get(payload.id);
      if (!draft) return reply(404, `{"error":"draft ${payload.id} not found"}`);
      state.sent.push({ id: payload.id });
      return reply(200, { id: `msg-${state.sent.length}`, threadId: draft.threadId });
    }

    const one = new RegExp(`^${base}/([^/]+)$`).exec(href.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const draft = store.get(id);
      if (!draft) return reply(404, `{"error":"draft ${id} not found"}`);
      if (method === "GET") {
        state.calls.get += 1;
        return reply(200, { id, message: { id: `msg-${id}`, threadId: draft.threadId, raw: encodeRaw(draft.raw) } });
      }
      if (method === "PUT") {
        state.calls.update += 1;
        const payload = JSON.parse(String(init.body || "{}"));
        const message = payload.message || {};
        const raw = decodeRaw(message.raw || "");
        state.updates.push({ id: payload.id, threadId: message.threadId ?? null, raw });
        store.set(id, { threadId: message.threadId ?? draft.threadId, raw });
        return reply(200, { id, message: { id: `msg-${id}`, threadId: message.threadId ?? draft.threadId, raw: encodeRaw(raw) } });
      }
    }

    return reply(404, '{"error":"notFound"}');
  }

  // The caller mutates this object (fake.failNext = …), so hand back the live state, not a copy.
  state.fetchImpl = fetchImpl;
  return state;
}