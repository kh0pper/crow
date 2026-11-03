/**
 * A fake Gmail REST endpoint for the gateway's staged-send client
 * (servers/gateway/staged/gmail-client.js): drafts get/update/send plus the OAuth2 refresh grant,
 * served as a `fetchImpl` so no test ever touches the network.
 *
 * `drafts.send` honours a `message.raw` in the request — the client sends the APPROVED snapshot that
 * way, not the stored draft — and records the raw it was asked to send in `fake.sent`, so a test can
 * prove that an edit made after approval did not ride along.
 *
 * It is deliberately blunt about content: an error response's body repeats the request (a 404 says
 * the draft id, a failure carries whatever `failNext` was given) and every read of a failed
 * response's body is counted in `fake.errorBodyReads` — that is exactly what the real API does, and
 * the client must never read it, let alone put it in an error.
 *
 * Usage:
 *   const fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({...}), threadId: "t1" } } });
 *   createGmailClient({ credRef, fetchImpl: fake.fetchImpl, configPaths });
 *   fake.calls            { token, get, update, send }
 *   fake.updates          [{ id, threadId, raw }]   // decoded raw of every PUT
 *   fake.sent             [{ id, threadId, raw }]   // every drafts.send, with the raw actually sent
 *   fake.errorBodyReads   number                    // text()/json() calls on FAILED responses
 *   fake.failNext         { status, body, on? }     // one-shot failure: `on` is "get"/"update"/"send"
 *                                                 //   (absent: the next draft request, whatever it is)
 *   fake.drafts           Map<id, { threadId, raw }> // mutate a draft to simulate a post-approval edit
 *
 * Like the real API a sent draft is gone from the drafts list — except here it is KEPT by default, so
 * a test can re-read it. A test that wants the real deletion (a 404 after the send) sets
 * `fake.sentDeletesDraft = true`.
 */

export const encodeRaw = (text) => Buffer.from(String(text), "utf8").toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const decodeRaw = (text) => Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** A gws-shaped draft: multipart/alternative with a base64 text/plain part, CRLF line endings. */
export function makeDraftRaw({
  to = "alex@example.com",
  cc,
  bcc,
  subject = "Hello",
  body = "Hello there",
  html,
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
  if (html != null) {
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(Buffer.from(String(html), "utf8").toString("base64"));
  }
  lines.push(`--${boundary}--`);
  lines.push("");
  return lines.join("\r\n");
}

/** Whether a pending `failNext` applies to this request: `on` narrows it to one kind of call. */
function matchesFail(failure, method, pathname, base) {
  if (!failure.on) return true;
  if (failure.on === "send") return pathname === `${base}/send`;
  if (failure.on === "update") return method === "PUT";
  if (failure.on === "get") return method === "GET";
  return true;
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
    errorBodyReads: 0,
    failNext: null,
    sentDeletesDraft: false,
  };

  /** A response. A FAILED one counts every read of its body: the client must never read it. */
  function reply(status, body) {
    const ok = status >= 200 && status < 300;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const read = () => { if (!ok) state.errorBodyReads += 1; };
    return {
      ok,
      status,
      json: async () => { read(); return typeof body === "string" ? JSON.parse(body) : body; },
      text: async () => { read(); return text; },
    };
  }

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

    const isSend = href.pathname === `${base}/send` && method === "POST";
    const one = new RegExp(`^${base}/([^/]+)$`).exec(href.pathname);
    // Count the ATTEMPT before a fake failure can refuse it: `calls` says what was tried.
    if (isSend) state.calls.send += 1;
    else if (one && method === "GET") state.calls.get += 1;
    else if (one && method === "PUT") state.calls.update += 1;

    if (state.failNext && matchesFail(state.failNext, method, href.pathname, base)) {
      const { status, body } = state.failNext;
      state.failNext = null;
      return reply(status, body ?? "");
    }

    if (isSend) {
      const payload = JSON.parse(String(init.body || "{}"));
      const draft = store.get(payload.id);
      if (!draft) return reply(404, `{"error":"draft ${payload.id} not found"}`);
      const message = payload.message || {};
      // The client rebuilds the message from the approved snapshot: send THAT, not the stored draft.
      const raw = message.raw == null ? draft.raw : decodeRaw(message.raw);
      const threadId = message.threadId ?? draft.threadId ?? null;
      state.sent.push({ id: payload.id, threadId, raw });
      if (state.sentDeletesDraft) store.delete(payload.id);
      return reply(200, { id: `msg-${state.sent.length}`, threadId });
    }

    if (one) {
      const id = decodeURIComponent(one[1]);
      const draft = store.get(id);
      if (!draft) return reply(404, `{"error":"draft ${id} not found"}`);
      if (method === "GET") {
        return reply(200, { id, message: { id: `msg-${id}`, threadId: draft.threadId, raw: encodeRaw(draft.raw) } });
      }
      if (method === "PUT") {
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