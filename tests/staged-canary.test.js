/**
 * Staged sends, Task 3: the leak canary. A known random 32-character value is used as the
 * recipient, the subject and the body of a staged draft, then every staged route is driven with it
 * — send, edit, discard, the card's own list read, a malformed JSON body and a body that is not
 * JSON — and every sink a draft's text could leak into is grepped for it:
 *
 *   console     every console.* call while the harness is open (the gateway has no request logger,
 *               so this is the log sink)
 *   frames      every engine event an SSE client would see
 *   model       everything pi would receive: sent frames and turn prompts (where the bot notes land)
 *   seam        the engine's audit and meter calls
 *   responses   every HTTP response body the harness received
 *   tables      audit_log, project_audit_log, notifications, perch_session_files
 *   db-bytes    crow.db and its WAL/SHM, raw bytes
 *   files       every file under the scratch dir
 *
 * Two sinks DO hold the canary by design, and the allowlist is exactly those two:
 *   - the `staged_sends` row itself (the snapshot is what the operator is shown and what is sent),
 *     which is crow.db; and
 *   - the GET …/interactive/:sid/staged answer, which is the card and is read by the owner only.
 * Everything else — a log line, an audit row, a notification, a bot note, a send/edit/discard
 * answer, a parser message — must be clean, and each of those sinks is asserted live below so the
 * pass cannot be vacuous.
 *
 * Harness: tests/fixtures/credential-canary.mjs (real engine + fake pi + real perch-api router
 * behind the real CSRF middleware). Gmail is tests/fixtures/fake-gmail.mjs, reached by replacing
 * `globalThis.fetch` for the two Google hosts only, so the row's real client (and its real MIME
 * rebuild) runs without a network.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanaryHarness, makeCanary } from "./fixtures/credential-canary.mjs";
import { createFakeGmail, makeDraftRaw } from "./fixtures/fake-gmail.mjs";

let h;
let fake;
let createStaged;
let claimSend;
let getStaged;
let snapshotFromRaw;
let realFetch;

const SERVER = "staged-canary-gws";
const CRED = { server: SERVER, role: "primary" };

before(async () => {
  h = await createCanaryHarness();

  // An operator-owned config naming a token file inside the scratch dir. Only mcp-addons.json is
  // written: a server id that exists nowhere else makes the credential reference unambiguous
  // (cred-ref.js refuses an ambiguous one, which is exactly right).
  const tokenFile = join(h.dir, "canary-gws-token.json");
  writeFileSync(tokenFile, JSON.stringify({ token: "fake-access-token", refresh_token: "fake-refresh", client_id: "fake-id", client_secret: "fake-secret" }));
  writeFileSync(join(h.crowHome, "mcp-addons.json"), JSON.stringify({
    [SERVER]: { command: "gws", args: [], env: { GOOGLE_TOKEN_FILE: tokenFile } },
  }));

  // Gmail (and only Gmail) is the fake: the real client still parses, hashes and rebuilds the MIME.
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const href = String(url);
    if (href.startsWith("https://gmail.googleapis.com") || href.startsWith("https://oauth2.googleapis.com")) {
      return fake.fetchImpl(url, init);
    }
    return realFetch(url, init);
  };

  ({ createStaged, claimSend, getStaged } = await import("../servers/gateway/staged/store.js"));
  ({ snapshotFromRaw } = await import("../servers/gateway/staged/gmail-client.js"));
});

after(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (h) await h.close();
});

/** A staged row for a draft the fake serves, whose canonical snapshot is that draft's own. */
async function stageDraft({ sessionId, canary, draftId }) {
  const raw = makeDraftRaw({ to: canary + "@example.com", subject: canary + " subject", body: canary + " body" });
  fake.drafts.set(draftId, { threadId: "thread-" + draftId, raw });
  const id = await createStaged(h.db, {
    sessionId,
    threadId: sessionId,
    botId: "canary-bot",
    channel: "gmail",
    credRef: CRED,
    providerDraftId: draftId,
    providerThreadId: "thread-" + draftId,
    snapshot: snapshotFromRaw(raw),
    tainted: true,
  });
  return { id, raw };
}

/**
 * Hits that are not by design. The staged row lives in crow.db (and its WAL/SHM); the card's own
 * read is the GET …/staged answer. Nothing else may carry the canary.
 */
function unexpected(hits) {
  return hits.filter((x) => {
    // A db-bytes hit carries the file path in `where`; a files hit carries both.
    const path = String(x.path || x.where || "");
    if ((x.sink === "db-bytes" || x.sink === "files") && /^data\/crow\.db(-wal|-shm|-journal)?$/.test(path)) return false;
    if (x.sink === "responses" && /^\/dashboard\/perch-api\/interactive\/[^/]+\/staged #/.test(String(x.where || ""))) return false;
    return true;
  });
}

test("no body or address in logs: the canary through every staged route", async () => {
  fake = createFakeGmail({ drafts: {} });
  const c = makeCanary();
  const s = await h.spawnSession("canary-bot");

  // Three drafts: one to send, one to edit, one to discard.
  const send = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-send" });
  const edit = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-edit" });
  const drop = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-drop" });

  const listBefore = await h.get(`/dashboard/perch-api/interactive/${s.sessionId}/staged`);
  assert.equal(listBefore.status, 200, listBefore.text);
  const approved = listBefore.json.items.find((i) => i.id === send.id);
  assert.ok(approved && approved.sendable, "the card sees a sendable draft");

  const sent = await h.post(`/dashboard/perch-api/staged/${send.id}/send`, { content_hash: approved.contentHash });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(sent.json.state, "sent");

  const edited = await h.post(`/dashboard/perch-api/staged/${edit.id}/edit`, {
    to: [c + "@example.com"],
    cc: [],
    bcc: [],
    subject: c + " edited subject",
    body: c + " edited body",
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.code, "edited");
  assert.ok(!edited.text.includes(c), "the edit answer carries no draft text");

  const discarded = await h.post(`/dashboard/perch-api/staged/${drop.id}/discard`, {});
  assert.equal(discarded.status, 200, discarded.text);
  assert.deepEqual(discarded.json, { ok: true, code: "discarded", state: "discarded" });

  const listAfter = await h.get(`/dashboard/perch-api/interactive/${s.sessionId}/staged`);
  assert.equal(listAfter.status, 200, listAfter.text);

  // The bot's next turn carries the three fixed notes (the "model" sink): a count and a message id,
  // never the address or the text.
  assert.equal((await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "done?" })).status, 202);
  const prompt = h.pi().lastTurn().message;
  assert.match(prompt, /^\[Crow\] The operator sent your draft to 1 recipients \(message msg-1\)\./);
  assert.match(prompt, /The operator edited your draft before sending\./);
  assert.match(prompt, /The operator discarded your draft\./);
  assert.ok(!prompt.includes(c), "no note carries the draft");
  await h.endTurn("ok");

  // The audit rows are ids and states only.
  const audits = await h.db.execute("SELECT event_type, details FROM audit_log WHERE event_type LIKE 'staged%'");
  assert.equal(audits.rows.length, 3, "one row per action");
  for (const row of audits.rows) {
    const details = JSON.parse(String(row.details));
    assert.deepEqual(Object.keys(details).sort(), ["channel", "staged_id", "state"]);
    assert.ok(!String(row.details).includes(c));
  }

  // The canned leaks are live: the row (and the card's read) really do hold the canary.
  const everyHit = await h.grepEverywhere(c);
  assert.ok(everyHit.some((x) => x.sink === "db-bytes"), "the fixture staged a draft holding the canary");
  assert.ok(everyHit.some((x) => x.sink === "responses"), "the card's own read shows it");
  for (const sink of ["console", "frames", "model", "tables", "seam"]) {
    assert.deepEqual(everyHit.filter((x) => x.sink === sink), [], `${sink} must be clean: ${JSON.stringify(everyHit.filter((x) => x.sink === sink))}`);
  }
  assert.deepEqual(unexpected(everyHit), [], JSON.stringify(unexpected(everyHit), null, 1));
});

test("no body or address in logs: a malformed edit body", async () => {
  fake = createFakeGmail({ drafts: {} });
  const c = makeCanary();
  const s = await h.spawnSession("canary-bot-malformed");
  const row = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-malformed" });

  const before = h.console.lines.length;
  const r = await h.post(`/dashboard/perch-api/staged/${row.id}/edit`, `{"to": ${c}}`);
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "bad_body" });
  assert.deepEqual(h.console.lines.slice(before), ["[perch-interactive-api] bad body"], "our own fixed handler, not Node's parser message");

  const oversized = await h.post(`/dashboard/perch-api/staged/${row.id}/edit`, JSON.stringify({ body: c + "x".repeat(300 * 1024) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.json, { error: "too_large" });

  // The row was never touched.
  assert.equal((await h.get(`/dashboard/perch-api/interactive/${s.sessionId}/staged`)).json.items[0].state, "staged");
  assert.deepEqual(unexpected(await h.grepEverywhere(c)), []);
});

test("no body or address in logs: a Gmail error body carrying the canary is never read", async () => {
  fake = createFakeGmail({ drafts: {} });
  const c = makeCanary();
  const s = await h.spawnSession("canary-bot-gmail-error");
  const forSend = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-error-send" });
  const forEdit = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-error-edit" });

  const list = await h.get(`/dashboard/perch-api/interactive/${s.sessionId}/staged`);
  assert.equal(list.status, 200, list.text);
  const approved = list.json.items.find((i) => i.id === forSend.id);
  assert.ok(approved && approved.sendable);

  // A failed Gmail request echoes the draft. The client must not read a byte of the body: that is
  // the only thing keeping the content out of its fixed error.
  fake.failNext = { status: 502, on: "send", body: JSON.stringify({ error: c, request: c }) };
  const sent = await h.post(`/dashboard/perch-api/staged/${forSend.id}/send`, { content_hash: approved.contentHash });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(sent.json, { ok: false, state: "failed", failReason: "Gmail could not send this draft" });
  assert.ok(!sent.text.includes(c), "the failure answer carries no text");

  fake.failNext = { status: 500, on: "update", body: JSON.stringify({ error: c, request: c }) };
  const edited = await h.post(`/dashboard/perch-api/staged/${forEdit.id}/edit`, {
    to: [c + "@example.com"],
    cc: [],
    bcc: [],
    subject: c + " edited subject",
    body: c + " edited body",
  });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual(edited.json, { ok: false, state: "failed", failReason: "Gmail could not send this draft" });
  assert.ok(!edited.text.includes(c), "the edit answer carries no text");

  assert.equal(fake.errorBodyReads, 0, "a failed response's body was never read");
  assert.deepEqual(unexpected(await h.grepEverywhere(c)), []);
});

test("no body or address in logs: the sweeper over an interrupted send", async () => {
  fake = createFakeGmail({ drafts: {} });
  const c = makeCanary();
  const s = await h.spawnSession("canary-bot-sweep");
  const readable = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-sweep-open" });
  const gone = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-sweep-gone" });

  // A crash left both claims in `sending`; the card's next read re-reads each draft and settles it.
  for (const row of [readable, gone]) {
    assert.equal(await claimSend(h.db, row.id, (await getStaged(h.db, row.id)).contentHash), true);
  }
  fake.drafts.delete("draft-sweep-gone");
  const stale = Date.now() - 15 * 60 * 1000;
  await h.db.execute({
    sql: "UPDATE staged_sends SET updated_at = ? WHERE id IN (?, ?)",
    args: [stale, readable.id, gone.id],
  });

  const list = await h.get(`/dashboard/perch-api/interactive/${s.sessionId}/staged`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.items.find((i) => i.id === readable.id).state, "staged", "readable: back for review");
  const sweptGone = list.json.items.find((i) => i.id === gone.id);
  assert.equal(sweptGone.state, "failed");
  assert.equal(sweptGone.failReason, "Sent or deleted in Gmail");

  assert.deepEqual(unexpected(await h.grepEverywhere(c)), []);
});

test("no body or address in logs: a body that is not JSON", async () => {
  fake = createFakeGmail({ drafts: {} });
  const c = makeCanary();
  const s = await h.spawnSession("canary-bot-form");
  const row = await stageDraft({ sessionId: s.sessionId, canary: c, draftId: "draft-form" });

  const r = await h.post(
    `/dashboard/perch-api/staged/${row.id}/edit`,
    "to=" + encodeURIComponent(c + "@example.com") + "&body=" + encodeURIComponent(c),
    { contentType: "application/x-www-form-urlencoded" },
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "bad_body" }, "refused unread, before any parser");
  assert.equal(fake.updates.length, 0);
  assert.deepEqual(unexpected(await h.grepEverywhere(c)), []);
});