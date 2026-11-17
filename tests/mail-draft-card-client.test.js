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
const ID = "md-0123456789abcdef";
const HASH = "a".repeat(64);

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
  const hub = await mountHub({ fetchImpl: impl });
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
    "From alex · Draft 1 · Not checked for voice");
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
  assert.equal(text(hub, "mdraft-edit-note"), "Editing cancels the scheduled send.");

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

test("Not checked for voice shows while there is no voice row, and the rules line when there is", async () => {
  const without = await mount({ drafts: { [ID]: payload({ voice: null }) } });
  await open(without.hub);
  assert.equal(text(without.hub, "mdraft-from"), "From alex · Draft 1 · Not checked for voice");

  const withVoice = await mount({ drafts: { [ID]: payload({ voice: { transcript: "warmer" } }) } });
  await open(withVoice.hub);
  assert.equal(text(withVoice.hub, "mdraft-from"), "From alex · Draft 1 · follows your writing rules");
  assert.ok(transcriptText(withVoice.hub).includes("Not checked for voice") === false);
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