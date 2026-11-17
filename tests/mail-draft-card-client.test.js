/**
 * The mail draft card in chat (Crow Mail, plan 3, Task 10a): perch-hub/mail-draft-card.js, spliced
 * into the hub client, plus the owner-only read that lists a chat's drafts.
 *
 * Harness, two halves in one file:
 *  - the vm harness (tests/fixtures/perch-hub-vm.mjs): the WHOLE emitted Perch client runs against a
 *    fake DOM and a fake fetch, with the draft route answered per test. No browser, no server.
 *  - a scratch crow.db (CROW_DATA_DIR — init-db, nothing can touch ~/.crow) with an ephemeral express
 *    app holding the real perch-api router, for the sid list's two rails.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { mountHub, openChatSession, findByClass, stdFetch, makeResponse, FakeEventSource } from "./fixtures/perch-hub-vm.mjs";
import { perchMailDraftCardJs } from "../servers/gateway/dashboard/perch-hub/mail-draft-card.js";

const dir = mkdtempSync(join(tmpdir(), "mail-draft-card-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;

const SID = "perchlive-aaaaaaaa";
const SECOND = "perchlive-bbbbbbbb";
const ID = "md-0123456789abcdef";
const HASH = "a".repeat(64);
const MID = "<m1@mail.example.test>";
const READER_LINK =
  "/dashboard/mail?view=message&a=ma-0123456789abcdef&mid=%3Cm1%40mail.example.test%3E";

/** Two live sessions on one roost: a switch has somewhere to switch to. */
const TWO_SESSIONS = {
  birds: [{
    id: "r4",
    name: "R4 Assistant",
    perch_attached: true,
    state: "working",
    sessions: [
      { sessionId: SID, state: "awake", cardId: null, pendingUi: false, projectId: 7 },
      { sessionId: SECOND, state: "awake", cardId: null, pendingUi: false, projectId: 7 },
    ],
  }],
};

const CHANGED = "The draft just changed. Check it and press Send again.";

let db, server, ownerAllowed = true;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();

  const { default: express } = await import("express");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const app = express();
  const sessionGate = (req, res, next) => { req.dashboardSession = "test"; next(); };
  app.use(express.json());
  app.use(perchInteractiveApiRouter(sessionGate, {
    engine: () => ({ message: async () => ({ turnId: "t1" }) }),
    annotate: async (m) => m,
    providerModels: () => [],
    piProviders: () => null,
    ownerCheck: async () => ownerAllowed,
    stagedGmail: () => null,
  }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  try { db && db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(times = 4) { for (let i = 0; i < times; i += 1) await tick(); }

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** One revision, in the shape GET /drafts/:id answers with. */
const head = (over = {}) => ({
  draftId: ID, rev: 1, author: "bot",
  to: [{ name: null, address: "sam@example.com" }],
  cc: [], bcc: [],
  subject: "Re: Tuesday", body: "Hello Sam,\nTuesday works.",
  inReplyTo: "<m1@mail.example.test>", references: [], attachments: [],
  from: { name: "alex", address: "alex@example.com" },
  mode: "reply", contentHash: HASH, note: null, createdAt: 1,
  ...over,
});

/** One draft row, as the store returns it. */
const draft = (over = {}) => ({
  id: ID, accountId: "ma-0123456789abcdef", mode: "reply", replyToMid: "<m1@mail.example.test>",
  threadKey: "thread-1", projectId: null, botId: "draft-bot", chatThreadId: SID,
  audience: null, state: "draft", headRev: 1, headHash: HASH, dueAt: null, holdUntil: null,
  messageId: null, attempts: 0, sentAt: null, failReason: null, createdAt: 1, updatedAt: 1,
  ...over,
});

/** The whole answer of GET /drafts/:id. */
const payload = (over = {}) => ({
  draft: draft(over.draft),
  head: head(over.head),
  flags: over.flags === undefined
    ? { newRecipients: [], changedRecipients: [], replyToDiffers: null }
    : over.flags,
  comments: over.comments || [],
  history: over.history || [{ rev: 1, author: "bot", created_at: 1, note: null }],
  receipt: over.receipt || null,
  voice: over.voice === undefined ? null : over.voice,
});

/**
 * Mount the real client with a scripted draft surface. `state.drafts` maps a draft id to the answer
 * its GET returns (a function is called per read); `state.list` is the sid list's ids; `state.reply`
 * answers the next draft POST. Every call is recorded in `calls`.
 */
async function mount(state = {}) {
  const calls = [];
  const impl = (method, path, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path, body });
    /* A test that needs a second session scripts the roost itself. */
    if (path === "/roost" && state.roost) return makeResponse(200, state.roost);
    if (path.endsWith("/mail-drafts") && method === "GET") {
      /* The chat's own drafts. An explicit `list` wins; otherwise it is the drafts this test scripted,
         which is what a chat that made them would list. */
      const list = state.list !== undefined
        ? (typeof state.list === "function" ? state.list() : state.list)
        : Object.keys(state.drafts || {});
      return makeResponse(200, { drafts: list.map((id) => ({ id })) });
    }
    const m = /^\/dashboard\/mail\/api\/drafts\/(md-[0-9a-f]{16})(?:\/([a-z-]+))?$/.exec(path);
    if (m) {
      const id = m[1];
      if (method === "GET") {
        const answer = (state.drafts || {})[id] || payload();
        return makeResponse(200, typeof answer === "function" ? answer() : answer);
      }
      const reply = typeof state.reply === "function" ? state.reply(m[2], id) : state.reply;
      return makeResponse(reply ? reply.status : 200, reply ? reply.json : { ok: true });
    }
    return stdFetch()(method, path);
  };
  const hub = await mountHub({ fetchImpl: impl, lang: state.lang || "en" });
  return { hub, calls };
}

/** Open the chat, which is where the panel draws its cards. */
async function open(hub, sid = SID) {
  await openChatSession(hub, sid);
  await settle();
}

function all(hub, cls) {
  const out = [];
  const walk = (n) => {
    if (String(n.className || "").split(" ").includes(cls)) out.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(hub.els["perch-transcript"]);
  return out;
}
const text = (hub, cls) => (all(hub, cls)[0] || {}).textContent || "";
function transcriptText(hub) {
  const deep = (n) => (n.textContent || "") + (n.children || []).map(deep).join(" ");
  return hub.els["perch-transcript"].children.map(deep).join("\n");
}
const posts = (calls) => calls.filter((c) => c.method !== "GET");
const reads = (calls) => calls.filter((c) => c.method === "GET" && c.path.indexOf("/dashboard/mail/api/drafts/") === 0);

/** The card's own poll: the 3 s interval it keeps while a draft is still moving. */
const pollTimerIds = (hub) => [...hub.timerDelays].filter(([, delay]) => delay === 3000).map(([id]) => id);
function pollTick(hub) {
  for (const id of pollTimerIds(hub)) {
    const fn = hub.timers.get(id);
    if (fn) fn();
  }
}

/* -------------------------------------------------------------------- tests */

test("the card renders its recipients and its subject as text", async () => {
  const { hub } = await mount({
    drafts: {
      [ID]: payload({
        head: {
          subject: "Re: <b>Tuesday</b>",
          to: [{ name: "<i>Sam</i>", address: "sam@example.com" }],
          cc: [{ name: null, address: "cara@example.com" }],
          bcc: [{ name: null, address: "dan@example.com" }],
          body: "Hello Sam,\n<script>alert(1)</script>",
        },
      }),
    },
  });
  await open(hub);

  assert.ok(findByClass(hub.els["perch-transcript"], "mdraft-card"), "the card is in the transcript");
  assert.equal(text(hub, "mdraft-head"), "draft-bot · Reply to: Re: <b>Tuesday</b>");
  assert.equal(text(hub, "mdraft-subject"), "Re: <b>Tuesday</b>", "markup in a subject stays text");

  const labels = all(hub, "mdraft-label").map((n) => n.textContent);
  assert.deepEqual(labels.slice(0, 5), ["To", "Cc", "Bcc", "Subject", "Who it is for"],
    "every recipient kind is labelled, bcc included");
  const shown = transcriptText(hub);
  for (const addr of ["sam@example.com", "cara@example.com", "dan@example.com"]) {
    assert.ok(shown.includes(addr), `the card lists ${addr}`);
  }
  assert.ok(all(hub, "mdraft-name").some((n) => n.textContent === "<i>Sam</i>"),
    "a display name is text too");
  // The body is a line at a time, and a line of markup is text.
  assert.equal(all(hub, "mdraft-line").length, 2);
  assert.equal(text(hub, "mdraft-linetext"), "Hello Sam,");
  assert.ok(all(hub, "mdraft-linetext").some((n) => n.textContent === "<script>alert(1)</script>"));
  // The one sentence the plan gives for this block, and the voice line while plan 4 has no note.
  assert.equal(text(hub, "mdraft-from"),
    "From alex · Draft 1 · Not checked for your writing style");
});

test("Send posts the hash the card was drawn from", async () => {
  const state = { drafts: { [ID]: payload() }, reply: { status: 200, json: { ok: true, holdUntil: 12 } } };
  const { hub, calls } = await mount(state);
  await open(hub);
  assert.equal(text(hub, "mdraft-from").indexOf("From alex · Draft 1"), 0);

  findByClass(hub.els["perch-transcript"], "mdraft-send").onclick();
  await settle();
  assert.equal(posts(calls).length, 1);
  assert.equal(posts(calls)[0].path, "/dashboard/mail/api/drafts/" + ID + "/send");
  assert.deepEqual(posts(calls)[0].body, { hash: HASH }, "the hash the card was drawn from");
});

test("a 409 changed shows the plan's sentence and reads the draft again", async () => {
  const state = {
    drafts: { [ID]: payload() },
    reply: { status: 409, json: { error: "changed", message: "The draft just changed. Check it and press Send again." } },
  };
  const { hub, calls } = await mount(state);
  await open(hub);
  const before = reads(calls).length;

  findByClass(hub.els["perch-transcript"], "mdraft-send").onclick();
  await settle();
  assert.equal(text(hub, "mdraft-status"), "The draft just changed. Check it and press Send again.");
  assert.equal(reads(calls).length, before + 1, "the card refetches the draft it no longer matches");
});

test("holding shows Sending in 10 s and an Undo that posts /undo", async () => {
  const { hub, calls } = await mount({ drafts: { [ID]: payload({ draft: { state: "holding", holdUntil: 10 } }) } });
  await open(hub);
  assert.equal(text(hub, "mdraft-status"), "Sending in 10 s");
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-send"), null, "nothing to press twice");

  findByClass(hub.els["perch-transcript"], "mdraft-undo").onclick();
  await settle();
  assert.equal(posts(calls)[0].path, "/dashboard/mail/api/drafts/" + ID + "/undo");
  assert.deepEqual(posts(calls)[0].body, {});
});

test("scheduled shows Change time and Cancel send, and no Edit", async () => {
  const dueAt = Date.UTC(2026, 10, 12, 13, 30);
  const { hub, calls } = await mount({ drafts: { [ID]: payload({ draft: { state: "scheduled", dueAt } }) } });
  await open(hub);

  const status = text(hub, "mdraft-status");
  assert.match(status, /^Scheduled for .+ from alex$/, status);
  assert.ok(findByClass(hub.els["perch-transcript"], "mdraft-change-time"), "Change time is there");
  assert.ok(findByClass(hub.els["perch-transcript"], "mdraft-cancel-send"), "Cancel send is there");
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-edit"), null, "a scheduled draft has no Edit");
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-send"), null, "and no Send");
  assert.equal(text(hub, "mdraft-edit-note"), "Editing cancels the schedule.");

  findByClass(hub.els["perch-transcript"], "mdraft-cancel-send").onclick();
  await settle();
  assert.equal(posts(calls)[0].path, "/dashboard/mail/api/drafts/" + ID + "/cancel-schedule");
});

test("new and changed recipients are marked, and a differing Reply-To says so", async () => {
  const { hub } = await mount({
    drafts: {
      [ID]: payload({
        head: {
          to: [{ name: null, address: "sam@example.com" }],
          cc: [{ name: null, address: "new@example.com" }, { name: null, address: "moved@example.com" }],
        },
        flags: {
          newRecipients: ["new@example.com"],
          changedRecipients: ["moved@example.com"],
          replyToDiffers: "reply@example.com",
        },
      }),
    },
  });
  await open(hub);

  const fresh = all(hub, "mdraft-new");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].textContent, "New recipient");
  const changed = all(hub, "mdraft-changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0].textContent, "Changed in Draft 1");
  const newRow = all(hub, "mdraft-rcpt").find((r) => transcriptOf(r).includes("new@example.com"));
  assert.ok(newRow && newRow.children.some((c) => c.className === "mdraft-new"), "the mark sits on that address");
  assert.equal(text(hub, "mdraft-replyto"), "Reply goes to reply@example.com, not the sender");
});

function transcriptOf(node) {
  const deep = (n) => (n.textContent || "") + (n.children || []).map(deep).join(" ");
  return deep(node);
}

test("Not checked for your writing style shows while there is no voice row, and the rules line when there is", async () => {
  const without = await mount({ drafts: { [ID]: payload({ voice: null }) } });
  await open(without.hub);
  assert.equal(text(without.hub, "mdraft-from"),
    "From alex · Draft 1 · Not checked for your writing style");

  const withVoice = await mount({ drafts: { [ID]: payload({ voice: { transcript: "warmer" } }) } });
  await open(withVoice.hub);
  assert.equal(text(withVoice.hub, "mdraft-from"), "From alex · Draft 1 · follows your writing rules");
  assert.ok(transcriptText(withVoice.hub).includes("Not checked for your writing style") === false);
});

test("an unknown outcome shows the could-not-confirm sentence and never says it was not sent", async () => {
  const { hub } = await mount({
    drafts: { [ID]: payload({ draft: { state: "unknown", failReason: "network" } }) },
  });
  await open(hub);
  assert.equal(text(hub, "mdraft-status"),
    "We could not confirm this went out. Check your Sent folder, then press Send again only if it is not there.");
  const shown = transcriptText(hub).toLowerCase();
  assert.equal(shown.includes("not sent"), false, shown);
  // A resend is one more press, and it carries the confirm the server asks for.
  const send = findByClass(hub.els["perch-transcript"], "mdraft-send");
  assert.ok(send, "Send is offered");
  send.onclick();
  assert.ok(findByClass(hub.els["perch-transcript"], "mdraft-confirm"), "the confirm is its own press");
});

test("the module output carries no backtick and no dollar-brace", async () => {
  const vm = await import("node:vm");
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  for (const lang of ["en", "es"]) {
    const js = perchMailDraftCardJs(lang);
    assert.equal(js.includes("`"), false, `${lang}: no backtick`);
    assert.equal(js.includes("${"), false, `${lang}: no dollar-brace`);
    // The same rule the staged card lives under, applied to the WHOLE client the splice lands in: one
    // stray backtick in the card would break every script the hub serves.
    assert.doesNotThrow(() => new vm.Script(perchHubJs(lang)), `${lang}: the emitted client compiles`);
  }
});

test("?maildraft= renders the card at the top of the panel, and a malformed id asks for nothing", async () => {
  const { hub, calls } = await mount({ list: [] });
  hub.location.search = "?maildraft=" + ID;
  await open(hub);
  const card = findByClass(hub.els["perch-transcript"], "mdraft-card");
  assert.ok(card, "the card is on screen");
  assert.ok(reads(calls).some((c) => c.path === "/dashboard/mail/api/drafts/" + ID));
  assert.equal(hub.els["perch-transcript"].children[0], card, "mounted at the top of the chat panel");
  // Anything the chat draws afterwards lands BELOW it.
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es._serverFrame("text", { text: "After the card" });
  await settle();
  assert.ok(hub.els["perch-transcript"].children.length > 1, "the chat drew its own content");
  assert.equal(hub.els["perch-transcript"].children[0], card, "and the card is still on top");
  assert.equal(all(hub, "mdraft-card").length, 1, "one card, not two");

  for (const bad of ["md-ZZZZ", "../drafts", ID.toUpperCase(), "md-0123", ""]) {
    const malformed = await mount({ list: [] });
    malformed.hub.location.search = "?maildraft=" + bad;
    await open(malformed.hub);
    assert.equal(reads(malformed.calls).length, 0, `no read for ${JSON.stringify(bad)}`);
    assert.equal(findByClass(malformed.hub.els["perch-transcript"], "mdraft-card"), null);
  }
});

test("the sid list is owner-only and flag-gated, and answers ids only", async () => {
  const { createDraft } = await import("../servers/gateway/mail/drafts/store.js");
  const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
  const account = await createAccount(db, {
    label: "Alex",
    address: "alex@example.com",
    authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  const mine = await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: SID, botId: "draft-bot", author: "user",
    first: { to: [{ address: "sam@example.com" }], cc: [], bcc: [], subject: "Mine", body: "Hello", attachments: [] },
  }, { now: () => 1_700_000_000_000 });
  await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: "perchlive-other00", botId: "draft-bot", author: "user",
    first: { to: [], cc: [], bcc: [], subject: "Elsewhere", body: "Other", attachments: [] },
  }, { now: () => 1_700_000_000_001 });

  process.env.CROW_MAIL = "1";
  ownerAllowed = true;
  const ok = await request("GET", "/dashboard/perch-api/interactive/" + SID + "/mail-drafts");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.deepEqual(ok.json, { drafts: [{ id: mine.id }] }, "the ids only, and only this chat's");

  ownerAllowed = false;
  const refused = await request("GET", "/dashboard/perch-api/interactive/" + SID + "/mail-drafts");
  assert.equal(refused.status, 403, refused.text);
  assert.deepEqual(refused.json, { error: "owner_only" });
  assert.equal(refused.text.includes(mine.id), false, "no id for a non-owner");

  ownerAllowed = true;
  process.env.CROW_MAIL = "0";
  try {
    const off = await request("GET", "/dashboard/perch-api/interactive/" + SID + "/mail-drafts");
    assert.equal(off.status, 404, off.text);
    assert.deepEqual(off.json, { error: "not_found" });
  } finally {
    process.env.CROW_MAIL = "1";
  }
});

/* ------------------------------------------------- a stale answer keeps its sentence */

test("a 409 changed leaves its sentence on the card that replaces the tapped one", async () => {
  const changed = "c".repeat(64);
  let answered = 0;
  const { hub, calls } = await mount({
    drafts: {
      [ID]: () => {
        answered += 1;
        if (answered === 1) return payload();
        /* The refetch lands on a revision the person has not seen: a different head, and its hash. */
        return payload({
          draft: { headHash: changed, headRev: 2 },
          head: { rev: 2, contentHash: changed, body: "Hello Sam,\nTuesday at ten works." },
          history: [
            { rev: 1, author: "bot", created_at: 1, note: null },
            { rev: 2, author: "bot", created_at: 2, note: null },
          ],
        });
      },
    },
    reply: { status: 409, json: { error: "changed", message: CHANGED } },
  });
  await open(hub);
  const before = reads(calls).length;

  findByClass(hub.els["perch-transcript"], "mdraft-send").onclick();
  await settle();

  assert.equal(reads(calls).length, before + 1, "the card reads the draft it no longer matches");
  assert.equal(all(hub, "mdraft-card").length, 1, "one card: the new one");
  assert.equal(text(hub, "mdraft-from"), "From alex · Draft 2 · Not checked for your writing style",
    "the card on screen is the revision the server holds");
  assert.equal(text(hub, "mdraft-status"), CHANGED,
    "the sentence rides to the card that replaces the tapped one");
  assert.equal(posts(calls).length, 1, "and nothing was posted twice");
});

test("every other stale answer refetches too, and its sentence rides to the new card", async () => {
  const cases = [
    { reply: { error: "frozen", state: "sending" }, notice: "This draft is on its way, so it cannot be changed now." },
    { reply: { error: "too_late", state: "sent", message: "It already went out." }, notice: "It already went out." },
    { reply: { error: "not_scheduled", state: "draft" }, notice: "This message is no longer scheduled." },
    { reply: { error: "not_discardable", state: "sent" }, notice: "This message cannot be discarded now. Cancel the send first, or it may already be sent." },
  ];
  const sent = payload({
    draft: { state: "sent", sentAt: 7 },
    receipt: { sentAt: 7, messageId: MID, accountLabel: "alex", readerLink: null },
  });

  for (const c of cases) {
    let answered = 0;
    const { hub, calls } = await mount({
      drafts: {
        [ID]: () => {
          answered += 1;
          return answered === 1 ? payload({ draft: { state: "holding", holdUntil: 10 } }) : sent;
        },
      },
      reply: { status: 409, json: c.reply },
    });
    await open(hub);
    const before = reads(calls).length;

    findByClass(hub.els["perch-transcript"], "mdraft-undo").onclick();
    await settle();

    assert.equal(reads(calls).length, before + 1, `${c.reply.error}: the card reads the draft again`);
    assert.equal(text(hub, "mdraft-status"), c.notice, `${c.reply.error}: its sentence is on the new card`);
  }

  /* A refusal with no sentence of its own (the undo lost to a hold that had already ended) still
     re-reads the draft; the state the card lands on is what explains it. */
  let answered = 0;
  const { hub, calls } = await mount({
    drafts: {
      [ID]: () => {
        answered += 1;
        return answered === 1 ? payload({ draft: { state: "holding", holdUntil: 10 } }) : sent;
      },
    },
    reply: { status: 409, json: { error: "not_holding", state: "sent" } },
  });
  await open(hub);
  const before = reads(calls).length;
  findByClass(hub.els["perch-transcript"], "mdraft-undo").onclick();
  await settle();
  assert.equal(reads(calls).length, before + 1, "not_holding also re-reads the draft");
  assert.match(text(hub, "mdraft-status"), /^Sent from alex at /, "the receipt is the answer here");
});

/* ------------------------------------------------------------------- the sending state */

test("a sending draft has its own line and none of the controls", async () => {
  const { hub, calls } = await mount({ drafts: { [ID]: payload({ draft: { state: "sending" } }) } });
  await open(hub);

  const status = text(hub, "mdraft-status");
  assert.equal(status, "Sending...", "the neutral placeholder the card owns");
  assert.notEqual(status, "Sending in 10 s", "never the hold's line");
  for (const cls of ["mdraft-send", "mdraft-schedule", "mdraft-more", "mdraft-edit", "mdraft-undo",
    "mdraft-confirm", "mdraft-audience"]) {
    assert.equal(findByClass(hub.els["perch-transcript"], cls), null, `a sending draft has no ${cls}`);
  }
  assert.equal(posts(calls).length, 0, "and nothing to post");
});

/* ------------------------------------------------------------------------ the poll */

test("a holding draft polls its own read into the receipt, and stops once it is settled", async () => {
  let answered = 0;
  const { hub, calls } = await mount({
    drafts: {
      [ID]: () => {
        answered += 1;
        if (answered <= 2) return payload({ draft: { state: "holding", holdUntil: 10 } });
        return payload({
          draft: { state: "sent", sentAt: 7 },
          receipt: { sentAt: 7, messageId: MID, accountLabel: "alex", readerLink: null },
        });
      },
    },
  });
  await open(hub);
  assert.equal(text(hub, "mdraft-status"), "Sending in 10 s");
  const card = findByClass(hub.els["perch-transcript"], "mdraft-card");
  assert.equal(pollTimerIds(hub).length, 1, "a holding card keeps one poll");

  const before = reads(calls).length;
  pollTick(hub);
  await settle();
  assert.equal(reads(calls).length, before + 1, "the poll reads the draft again with no tap");
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-card"), card,
    "an answer that changes nothing redraws nothing");
  assert.equal(text(hub, "mdraft-status"), "Sending in 10 s");

  pollTick(hub);
  await settle();
  assert.match(text(hub, "mdraft-status"), /^Sent from alex at /, "the receipt replaced the hold's line");
  assert.ok(transcriptText(hub).includes("Sent, syncing..."), "and says the Sent copy is on its way");
  assert.deepEqual(pollTimerIds(hub), [], "a settled draft is not polled");
  assert.equal(posts(calls).length, 0, "no tap was ever made");
});

test("a session switch takes the poll with the card it belonged to", async () => {
  let listNow = [ID];
  const { hub, calls } = await mount({
    roost: TWO_SESSIONS,
    list: () => listNow,
    drafts: { [ID]: payload({ draft: { state: "holding", holdUntil: 10 } }) },
  });
  await open(hub, SID);
  assert.equal(pollTimerIds(hub).length, 1, "the switch starts one poll");

  listNow = [];
  await openChatSession(hub, SECOND);
  await settle();
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-card"), null, "the card is gone");
  assert.deepEqual(pollTimerIds(hub), [], "and no timer outlives it");
  const before = reads(calls).length;
  await settle();
  assert.equal(reads(calls).length, before, "nothing keeps reading a draft no card shows");
});

/* ------------------------------------------------------------- the receipt's own fields */

test("a syncing receipt becomes the reader link when the draft read carries one", async () => {
  let listNow = [];
  let answered = 0;
  const syncing = payload({
    draft: { state: "sent", sentAt: 7 },
    receipt: { sentAt: 7, messageId: MID, accountLabel: "alex", readerLink: null },
  });
  const linked = payload({
    draft: { state: "sent", sentAt: 7 },
    receipt: { sentAt: 7, messageId: MID, accountLabel: "alex", readerLink: READER_LINK },
  });
  const { hub } = await mount({
    roost: TWO_SESSIONS,
    list: () => listNow,
    drafts: { [ID]: () => { answered += 1; return answered === 1 ? syncing : linked; } },
  });
  hub.location.search = "?maildraft=" + ID;
  await open(hub, SID);
  assert.ok(transcriptText(hub).includes("Sent, syncing..."), "no Sent copy yet, so it says so");
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-sent"), null, "and links nothing");

  /* The chat's own list reads the same draft again — with the Sent copy now in the store. */
  listNow = [ID];
  await openChatSession(hub, SECOND);
  await settle();

  assert.equal(all(hub, "mdraft-card").length, 1, "one card, redrawn in place");
  const link = findByClass(hub.els["perch-transcript"], "mdraft-sent");
  assert.ok(link, "the receipt is a link now");
  assert.equal(link.href, READER_LINK);
  assert.equal(transcriptText(hub).includes("Sent, syncing..."), false, "the syncing line is gone");
});

/* -------------------------------------------------------------------- edit by hand */

/** The one input or textarea a form field wraps. */
const fieldInput = (wrap) => wrap.children.find((c) => c.tagName === "INPUT" || c.tagName === "TEXTAREA");

function openEditForm(hub) {
  findByClass(hub.els["perch-transcript"], "mdraft-more").onclick();
  findByClass(hub.els["perch-transcript"], "mdraft-edit").onclick();
  return findByClass(hub.els["perch-transcript"], "mdraft-form");
}

const formFields = (form) => form.children.filter((c) => String(c.className).includes("mdraft-field"));

test("Edit by hand has a Bcc field, prefilled even when it is empty, and posts it", async () => {
  const { hub, calls } = await mount({
    drafts: {
      [ID]: payload({
        head: {
          to: [{ name: "Sam Lee", address: "sam@example.com" }],
          cc: [{ name: "Cara", address: "cara@example.com" }],
          bcc: [{ name: "Dan", address: "dan@example.com" }],
        },
      }),
    },
    reply: { status: 200, json: { rev: 2, hash: HASH } },
  });
  await open(hub);
  const form = openEditForm(hub);
  assert.ok(form, "the form is open");
  const fields = formFields(form);
  assert.equal(fields.length, 5, "to, cc, bcc, subject and the body");
  const labels = fields.map((f) => (f.children[0] && f.children[0].className === "mdraft-label" ? f.children[0].textContent : ""));
  assert.deepEqual(labels.slice(0, 3), ["To", "Cc", "Bcc"], "the Bcc sits next to Cc");
  assert.deepEqual(fields.slice(0, 3).map((f) => fieldInput(f).value),
    ["sam@example.com", "cara@example.com", "dan@example.com"]);

  findByClass(form, "mdraft-save").onclick();
  await settle();
  const posted = posts(calls)[0];
  assert.equal(posted.path, "/dashboard/mail/api/drafts/" + ID + "/revisions");
  assert.deepEqual(posted.body.bcc, [{ name: "Dan", address: "dan@example.com" }],
    "the Bcc the card showed is posted, name and all");
});

test("an edit sends the head's own address entries back for every field it was not asked to change", async () => {
  const head = {
    to: [{ name: "Sam Lee", address: "sam@example.com" }],
    cc: [{ name: "Cara", address: "cara@example.com" }],
    bcc: [{ name: "Dan", address: "dan@example.com" }],
  };
  const { hub, calls } = await mount({
    drafts: { [ID]: payload({ head }) },
    reply: { status: 200, json: { rev: 2, hash: HASH } },
  });
  await open(hub);
  const form = openEditForm(hub);
  const fields = formFields(form);
  fieldInput(fields[0]).value = "new@example.com";
  findByClass(form, "mdraft-save").onclick();
  await settle();

  const body = posts(calls)[0].body;
  assert.deepEqual(body.to, [{ address: "new@example.com" }], "a typed field is parsed as typed text");
  assert.deepEqual(body.cc, head.cc, "an untouched Cc keeps its display name");
  assert.deepEqual(body.bcc, head.bcc, "so does an untouched Bcc");
  assert.equal(body.subject, "Re: Tuesday", "and the untouched words are what was shown");
});

test("a draft with no Bcc shows no Bcc row on the card, and its form still offers the field", async () => {
  const { hub } = await mount({ drafts: { [ID]: payload() } });
  await open(hub);
  const labels = all(hub, "mdraft-label").map((n) => n.textContent);
  assert.equal(labels.includes("Bcc"), false, "nothing to hide, so no row");
  const form = openEditForm(hub);
  const fields = formFields(form);
  assert.equal(fieldInput(fields[2]).value, "", "the field is there, empty");
});

/* ------------------------------------------------------------- the audience chips */

test("tapping the audience chip that is already on clears the audience", async () => {
  const { hub, calls } = await mount({
    drafts: { [ID]: payload({ draft: { audience: "client" } }) },
    reply: { status: 200, json: { ok: true, audience: null } },
  });
  await open(hub);
  const chips = all(hub, "mdraft-chip");
  assert.deepEqual(chips.map((c) => c.textContent), ["Colleague", "Client", "Personal"]);
  assert.ok(String(chips[1].className).includes("mdraft-chip-on"), "the current audience is marked");

  chips[1].onclick();
  await settle();
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/dashboard/mail/api/drafts/" + ID + "/audience");
  assert.deepEqual(patch.body, { audience: null }, "a second tap on the same chip is the clear");
});

/* --------------------------------------------------------------------- the header */

test("a new draft's header leaves the reply line out, and a named bot is named", async () => {
  const reply = await mount({ drafts: { [ID]: payload({ draft: { botName: "R4 Assistant" } }) } });
  await open(reply.hub);
  assert.equal(text(reply.hub, "mdraft-head"), "R4 Assistant · Reply to: Re: Tuesday");

  const blank = await mount({
    drafts: { [ID]: payload({ draft: { mode: "new", botName: "R4 Assistant" }, head: { mode: "new" } }) },
  });
  await open(blank.hub);
  assert.equal(text(blank.hub, "mdraft-head"), "R4 Assistant · Re: Tuesday",
    "a draft written from nothing has no reply to name");
  assert.equal(text(blank.hub, "mdraft-head").includes("Reply to:"), false);

  /* Without a display name the read's bot id still names it — no lookup is invented for one. */
  const byId = await mount({ drafts: { [ID]: payload() } });
  await open(byId.hub);
  assert.equal(text(byId.hub, "mdraft-head"), "draft-bot · Reply to: Re: Tuesday");
});

/* -------------------------------------------------------- the ?maildraft= card */

test("the ?maildraft= card mounts once and stays at the top through a session switch", async () => {
  const { hub, calls } = await mount({ roost: TWO_SESSIONS, list: [], drafts: { [ID]: payload() } });
  hub.location.search = "?maildraft=" + ID;
  await open(hub, SID);
  const card = findByClass(hub.els["perch-transcript"], "mdraft-card");
  assert.ok(card, "the query card is on screen");
  assert.equal(hub.els["perch-transcript"].children[0], card, "mounted at the top of the chat panel");
  const mountedReads = reads(calls).length;

  await openChatSession(hub, SECOND);
  await settle();
  assert.equal(all(hub, "mdraft-card").length, 1, "still one card");
  assert.equal(findByClass(hub.els["perch-transcript"], "mdraft-card"), card,
    "the same card, back at the top");
  assert.equal(hub.els["perch-transcript"].children[0], card, "and still the first thing in the panel");
  assert.equal(reads(calls).length, mountedReads, "a switch mounts no second card");
});

/* -------------------------------------------------------- the approved refusal copy */

/** Every refusal code the card renders, its answer, and the approved sentence in both languages. */
const REFUSALS = [
  ["frozen", 409, { error: "frozen" },
    "This draft is on its way, so it cannot be changed now.",
    "Este borrador ya está en camino, así que no se puede cambiar ahora."],
  ["needsCancel", 409, { error: "frozen", needsCancel: true },
    "This message is scheduled. Cancel the send first to change it.",
    "Este mensaje está programado. Cancela el envío primero para poder cambiarlo."],
  ["needsCancel (its own code)", 409, { error: "needsCancel" },
    "This message is scheduled. Cancel the send first to change it.",
    "Este mensaje está programado. Cancela el envío primero para poder cambiarlo."],
  ["cloud_drafting_off", 403, { error: "cloud_drafting_off" },
    "This bot uses a cloud model, and cloud drafting is off. Turn it on in Mail settings, or pick a bot that runs on this computer.",
    "Este bot usa un modelo en la nube y el borrador con modelos en la nube está desactivado. Actívalo en los ajustes de Correo o elige un bot que se ejecute en este equipo."],
  ["local_models_only", 403, { error: "local_models_only" },
    "This account only allows bots that run on this computer. Pick a different bot.",
    "Esta cuenta solo permite bots que se ejecutan en este equipo. Elige otro bot."],
  ["delivery_unsupported", 503, { error: "delivery_unsupported" },
    "Drafting with a bot is not available on this Crow right now. You can still write the message by hand.",
    "Redactar con un bot no está disponible en este Crow por ahora. Aun así, puedes escribir el mensaje a mano."],
  ["unavailable", 503, { error: "unavailable" },
    "Crow could not start the bot just now. Try again.",
    "Crow no pudo iniciar el bot ahora. Inténtalo de nuevo."],
  ["not_scheduled", 409, { error: "not_scheduled" },
    "This message is no longer scheduled.",
    "Este mensaje ya no está programado."],
  ["not_discardable", 409, { error: "not_discardable" },
    "This message cannot be discarded now. Cancel the send first, or it may already be sent.",
    "Este mensaje no se puede descartar ahora. Cancela el envío primero; puede que ya se haya enviado."],
  ["past", 400, { error: "bad_input", reason: "past" },
    "Pick a time at least a minute from now.",
    "Elige una hora que falte al menos un minuto."],
  ["too_far", 400, { error: "bad_input", reason: "too_far" },
    "You can schedule up to 90 days ahead.",
    "Puedes programar hasta con 90 días de anticipación."],
  ["partialRejected", 409, { error: "partialRejected" },
    "Sent. The mail server refused some recipients.",
    "Enviado. El servidor de correo rechazó a algunos destinatarios."],
  ["notSendable", 409, { error: "not_sendable" },
    "This account cannot send mail yet.",
    "Esta cuenta todavía no puede enviar correo."],
  ["placeholders", 400, { error: "bad_input", preflight: "placeholders" },
    "Fill in the [bracketed] parts before sending.",
    "Completa las partes entre [corchetes] antes de enviar."],
  ["no_recipients", 400, { error: "bad_input", preflight: "no_recipients" },
    "Add at least one recipient.",
    "Añade al menos un destinatario."],
  ["bad_address", 400, { error: "bad_input", preflight: "bad_address" },
    "One of the addresses is not valid.",
    "Una de las direcciones no es válida."],
  ["too_large", 413, { error: "too_large", preflight: "too_large" },
    "The attachments are over about 18 MB. Remove some to send.",
    "Los adjuntos pasan de unos 18 MB. Quita alguno para poder enviar."],
];

/** The sentence a code puts on the card, in one language. */
async function refusalSentence(status, json, lang) {
  const { hub } = await mount({ lang, drafts: { [ID]: payload() }, reply: { status, json } });
  await open(hub);
  findByClass(hub.els["perch-transcript"], "mdraft-send").onclick();
  await settle();
  return text(hub, "mdraft-status");
}

test("every refusal code shows its approved sentence, in the active language", async () => {
  for (const [name, status, json, en, es] of REFUSALS) {
    assert.notEqual(en, es, `${name}: the Spanish is its own sentence`);
    assert.equal(await refusalSentence(status, json, "en"), en, `${name} (en)`);
    assert.equal(await refusalSentence(status, json, "es"), es, `${name} (es)`);
  }
});

test("Save as draft names the folder as text, and a missing Drafts folder has its own sentence", async () => {
  const saved = await mount({
    drafts: { [ID]: payload() },
    reply: { status: 200, json: { ok: true, folder: "<b>Drafts</b>" } },
  });
  await open(saved.hub);
  findByClass(saved.hub.els["perch-transcript"], "mdraft-more").onclick();
  findByClass(saved.hub.els["perch-transcript"], "mdraft-save").onclick();
  await settle();
  assert.equal(text(saved.hub, "mdraft-status"), "Saved to <b>Drafts</b>.", "the folder is text");
  assert.equal(all(saved.hub, "mdraft-status")[0].children.length, 0, "and never markup");

  const missing = await mount({
    drafts: { [ID]: payload() },
    reply: { status: 404, json: { error: "not_found" } },
  });
  await open(missing.hub);
  findByClass(missing.hub.els["perch-transcript"], "mdraft-more").onclick();
  findByClass(missing.hub.els["perch-transcript"], "mdraft-save").onclick();
  await settle();
  assert.equal(text(missing.hub, "mdraft-status"), "Crow could not find this account's Drafts folder.");

  const spanish = await mount({
    lang: "es",
    drafts: { [ID]: payload() },
    reply: { status: 200, json: { ok: true, folder: "Borradores" } },
  });
  await open(spanish.hub);
  findByClass(spanish.hub.els["perch-transcript"], "mdraft-more").onclick();
  findByClass(spanish.hub.els["perch-transcript"], "mdraft-save").onclick();
  await settle();
  assert.equal(text(spanish.hub, "mdraft-status"), "Guardado en Borradores.");
});

/* ------------------------------------------------------------ the approved controls */

test("Revise is Request changes in English and Pedir cambios in Spanish", async () => {
  const comments = [{ id: "c1", rev: 1, lineIndex: 0, quote: "Hello Sam,", text: "Softer.", state: "queued" }];
  const english = await mount({ drafts: { [ID]: payload({ comments }) } });
  await open(english.hub);
  assert.equal(text(english.hub, "mdraft-revise"), "Request changes");

  const spanish = await mount({ lang: "es", drafts: { [ID]: payload({ comments }) } });
  await open(spanish.hub);
  assert.equal(text(spanish.hub, "mdraft-revise"), "Pedir cambios");
});

test("the ... overflow button is named More in English and Más in Spanish", async () => {
  const english = await mount({ drafts: { [ID]: payload() } });
  await open(english.hub);
  const more = findByClass(english.hub.els["perch-transcript"], "mdraft-more");
  assert.equal(more.textContent, "...");
  assert.equal(more.getAttribute("aria-label"), "More");
  assert.equal(more.getAttribute("title"), "More");

  const spanish = await mount({ lang: "es", drafts: { [ID]: payload() } });
  await open(spanish.hub);
  const otro = findByClass(spanish.hub.els["perch-transcript"], "mdraft-more");
  assert.equal(otro.textContent, "...");
  assert.equal(otro.getAttribute("aria-label"), "Más");
  assert.equal(otro.getAttribute("title"), "Más");
});

/* ------------------------------------------------------------- the state sentences */

test("the missed card names the real due time, the way the bell words it", async () => {
  const dueAt = new Date(2026, 10, 12, 7, 30).getTime();
  const english = await mount({ drafts: { [ID]: payload({ draft: { state: "missed", dueAt } }) } });
  await open(english.hub);
  assert.equal(text(english.hub, "mdraft-status"),
    "This was due at 7:30 and did not go out. Send now, pick a new time, or cancel.");

  const spanish = await mount({ lang: "es", drafts: { [ID]: payload({ draft: { state: "missed", dueAt } }) } });
  await open(spanish.hub);
  assert.equal(text(spanish.hub, "mdraft-status"),
    "Esto debía salir a las 7:30 y no se envió. Envíalo ahora, elige otra hora o cancélalo.");
});

test("the scheduled line names the day, the clock and the account", async () => {
  const dueAt = new Date(2026, 10, 12, 13, 30).getTime();
  const english = await mount({ drafts: { [ID]: payload({ draft: { state: "scheduled", dueAt } }) } });
  await open(english.hub);
  assert.match(text(english.hub, "mdraft-status"), /^Scheduled for \S+ \d{1,2}:\d{2}.* from alex$/);

  const spanish = await mount({ lang: "es", drafts: { [ID]: payload({ draft: { state: "scheduled", dueAt } }) } });
  await open(spanish.hub);
  assert.match(text(spanish.hub, "mdraft-status"), /^Programado para el .+ a las .+ desde alex$/);
});

/* ----------------------------------------------------------------- the backoff */

/** The armed timers whose gap is one of the poll's (the card's own, plus the hub's own long timers). */
const armedGaps = (hub) => [...hub.timerDelays.entries()]
  .filter(([id, delay]) => hub.timers.has(id)
    && (delay === 3000 || delay === 15000 || delay === 60000));

/** Fire one timer by its id. */
function fireTimer(hub, id) {
  const fn = id === undefined ? null : hub.timers.get(id);
  if (fn) fn();
}

/** The timer ids armed since `seen` was taken, as [id, delay]. */
const freshGaps = (hub, seen) => armedGaps(hub).filter(([id]) => !seen.has(id));

/** Record every armed timer in `seen`, so the next step can tell what is new. */
function rememberGaps(hub, seen) {
  for (const [id] of armedGaps(hub)) seen.add(id);
}

test("the poll backs off from 3 s to 15 s to a minute, and pauses while the tab is hidden", async () => {
  const { hub, calls } = await mount({ drafts: { [ID]: payload({ draft: { state: "holding", holdUntil: 10 } }) } });
  await open(hub);
  let current = pollTimerIds(hub)[0];
  assert.ok(current !== undefined, "the card arms one poll at 3 s");
  const seen = new Set();
  rememberGaps(hub, seen);

  const step = async (want, label) => {
    fireTimer(hub, current);
    await settle();
    const fresh = freshGaps(hub, seen);
    rememberGaps(hub, seen);
    assert.equal(fresh.length, 1, `${label}: one new poll timer`);
    assert.equal(fresh[0][1], want, `${label}: its gap`);
    current = fresh[0][0];
  };

  for (let poll = 1; poll <= 4; poll += 1) await step(3000, `the gap after poll ${poll}`);
  await step(15000, "the gap after poll 5");
  await step(60000, "the gap after poll 6");

  hub.doc.hidden = true;
  const quiet = reads(calls).length;
  fireTimer(hub, current);
  await settle();
  assert.equal(reads(calls).length, quiet, "no request while the tab is hidden");
  const held = freshGaps(hub, seen);
  rememberGaps(hub, seen);
  assert.equal(held.length, 1, "the timer is armed again");
  assert.equal(held[0][1], 60000, "and the gap stays where it was");
  current = held[0][0];

  hub.doc.hidden = false;
  fireTimer(hub, current);
  await settle();
  assert.equal(reads(calls).length, quiet + 1, "visible again, it reads");
});

test("a change of state starts the poll at 3 s again", async () => {
  let state = "holding";
  const { hub } = await mount({ drafts: { [ID]: () => payload({ draft: { state } }) } });
  await open(hub);
  let current = pollTimerIds(hub)[0];
  const seen = new Set();
  rememberGaps(hub, seen);

  const step = async () => {
    fireTimer(hub, current);
    await settle();
    const fresh = freshGaps(hub, seen);
    rememberGaps(hub, seen);
    if (fresh.length) current = fresh[0][0];
    return fresh.map(([, delay]) => delay);
  };

  for (let poll = 0; poll < 6; poll += 1) await step();
  assert.deepEqual(await step(), [60000], "a long-run hold is on the minute");

  state = "unknown";
  assert.deepEqual(await step(), [3000], "a new state is a fresh matter");
});