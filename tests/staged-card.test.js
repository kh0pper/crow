/**
 * Staged sends, Task 4: the card (perch-hub/staged-card.js, spliced into the hub client), the
 * standalone page (/dashboard/staged/:id), the single-row read (GET /staged/:id) and the Board's
 * Needs-you lane.
 *
 * Harness, three halves in one file:
 *  - the vm harness (tests/fixtures/perch-hub-vm.mjs): the WHOLE emitted Perch client runs against a
 *    fake DOM and a fake fetch, with the staged list answered per test. No browser, no server.
 *  - a scratch crow.db (CROW_DATA_DIR — init-db, nothing can touch ~/.crow) with an ephemeral
 *    express app: the real perch-api router (for GET /staged/:id) and the real staged page router.
 *  - the real Needs-you module over that crow.db plus a scratch tasks.db.
 * The live half (390 px, round trip) is tests/staged-card-live.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import vm from "node:vm";
import Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { mountHub, openChatSession, findByClass, stdFetch, makeResponse, FakeEventSource } from "./fixtures/perch-hub-vm.mjs";

const dir = mkdtempSync(join(tmpdir(), "staged-card-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;

let db, store, server, ownerAllowed = true;
let needsYouCounts, needsYouCards, clearNeedsYouCache, createProjectSpace;
let createCard;
const SID = "perchlive-aaaaaaaa";
const TASKS = process.env.CROW_TASKS_DB_PATH;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  store = await import("../servers/gateway/staged/store.js");
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  ({ needsYouCounts, needsYouCards, clearNeedsYouCache } = await import("../servers/gateway/dashboard/panels/board/needs-you.js"));

  // tasks.db: the two tables the lane query reads, and one card that carries no ask at all —
  // nothing but a staged draft should put it in Needs you.
  const t = new Database(TASKS);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER, action_needed TEXT,
    data_json TEXT NOT NULL DEFAULT '{}', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE board_results (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'success', status TEXT NOT NULL DEFAULT 'recorded');
    CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, project_id INTEGER UNIQUE,
      display_name TEXT NOT NULL, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]')`);
  createCard = (title, projectId, ask = null, priority = 3) => {
    const t = new Database(TASKS);
    try {
      return Number(t.prepare(
        "INSERT INTO tasks_items (title, project_id, status, action_needed, priority) VALUES (?, ?, 'pending', ?, ?)").run(title, projectId, ask, priority).lastInsertRowid);
    } finally { t.close(); }
  };
  t.close();

  // The two routers, wired the way dashboard/index.js wires them: a session gate first, then the
  // real routers (each installing its own auth on its prefix in production — here the gate stands in
  // for dashboardAuth, and the owner rule is injected).
  const { default: express } = await import("express");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: stagedPageRouter } = await import("../servers/gateway/routes/staged-page.js");
  const app = express();
  const sessionGate = (req, res, next) => { req.dashboardSession = "test"; next(); };
  app.use(express.json());
  app.use(perchInteractiveApiRouter(sessionGate, {
    engine: () => ({ message: async () => ({ turnId: "t1" }) }),
    annotate: async (m) => m,
    providerModels: () => [],
    piProviders: () => null,
    ownerCheck: async () => ownerAllowed,
    // No Gmail client at all: the "new recipient" hint is skipped, so a test never touches a network.
    stagedGmail: () => null,
  }));
  app.use(stagedPageRouter(sessionGate, { ownerCheck: async () => ownerAllowed }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  try { db && db.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(times = 3) { for (let i = 0; i < times; i += 1) await tick(); }

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** One staged row, in the shape the list route returns (store ids look like ss-<16 hex>). */
const item = (over = {}) => ({
  id: "ss-aaaaaaaaaaaaaaaa",
  state: "staged",
  snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hello", body: "Hello there" },
  contentHash: "a".repeat(64),
  placeholders: [],
  newRecipients: [],
  sendable: true,
  failReason: null,
  tainted: false,
  providerDraftId: "d1",
  ...over,
});

/**
 * Mount the real client with a scripted staged list. `state.items` is read on every GET;
 * `state.reply` answers the next staged POST. Every POST is recorded in `state.posts`.
 */
async function mount(state, opts = {}) {
  const posts = [];
  const gets = [];
  const impl = (method, path, o) => {
    if (path.endsWith("/staged") && method === "GET") {
      gets.push(path);
      return makeResponse(200, { items: typeof state.items === "function" ? state.items() : state.items });
    }
    if (path.indexOf("/staged/") >= 0 && method === "POST") {
      posts.push({ path, body: o && o.body ? JSON.parse(o.body) : null });
      const reply = typeof state.reply === "function" ? state.reply(path) : state.reply;
      return makeResponse(reply ? reply.status : 200, reply ? reply.json : { ok: true });
    }
    return stdFetch()(method, path);
  };
  const hub = await mountHub({ fetchImpl: impl, lang: opts.lang || "en" });
  await openChatSession(hub, SID);
  await settle();
  return { hub, posts, gets };
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
const has = (hub, cls) => all(hub, cls).length > 0;
const text = (hub, cls) => (all(hub, cls)[0] || {}).textContent || "";
/** The fake DOM keeps textContent per node, not aggregated: walk the children. */
const deepText = (n) => (n && n.textContent ? n.textContent : "") + ((n && n.children) || []).map(deepText).join(" ");
function transcriptText(hub) {
  const deep = (n) => (n.textContent || "") + (n.children || []).map(deep).join(" ");
  return hub.els["perch-transcript"].children.map(deep).join("\n");
}
function runTimers(hub, delay) {
  for (const [id, fn] of [...hub.timers]) {
    if (hub.timerDelays.get(id) === delay) { hub.timers.delete(id); hub.timerDelays.delete(id); fn(); }
  }
}
const draftEnd = (hub, name = "mcp__google-workspace__gmail_create_draft") => {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es._serverFrame("tool", { phase: "end", name, toolCallId: "call-1", isError: false, resultText: "" });
};

/* -------------------------------------------------------------------- tests */

test("card lists every recipient with bcc labelled", async () => {
  const { hub } = await mount({
    items: [item({
      snapshot: {
        to: ["alex@example.com"], cc: ["bob@example.com"],
        bcc: ["cara@example.com", "dan@example.com"], subject: "Quarterly numbers", body: "Body text here",
      },
      newRecipients: ["dan@example.com"],
    })],
  });
  const shown = transcriptText(hub);
  assert.equal(text(hub, "staged-title"), "Draft email");
  for (const addr of ["alex@example.com", "bob@example.com", "cara@example.com", "dan@example.com"]) {
    assert.ok(shown.includes(addr), `the card lists ${addr}: ${shown}`);
  }
  const labels = all(hub, "staged-label").map((n) => n.textContent);
  assert.deepEqual(labels, ["To", "Cc", "Bcc", "Bcc", "Subject", "Message"], "every recipient kind is labelled, bcc included");
  assert.equal(all(hub, "staged-rcpt").length, 4);
  assert.equal(text(hub, "staged-subject"), "Quarterly numbers");
  assert.equal(text(hub, "staged-body"), "Body text here");
  assert.equal(text(hub, "staged-yes"), "Nothing goes out without your yes.");
  // One quiet "new" mark, on the address the server called new.
  const marks = all(hub, "staged-new");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].textContent, "new");
  const danRow = all(hub, "staged-rcpt").find((r) => deepText(r).includes("dan@example.com"));
  assert.ok(danRow && danRow.children.some((c) => c.className === "staged-new"), "the mark sits on dan's row");
});

test("placeholders disable Send", async () => {
  const { hub } = await mount({
    items: [item({
      snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hi [Client Name]", body: "Due [Date]" },
      placeholders: ["Client Name", "Date"],
    })],
  });
  const send = findByClass(hub.els["perch-transcript"], "staged-send");
  assert.ok(send, "the Send button is there");
  assert.equal(send.disabled, true, "and it is disabled");
  assert.equal(text(hub, "staged-status"), "Fill in [Client Name], [Date] first");
  // Edit stays reachable: it is how the brackets get filled.
  assert.ok(findByClass(hub.els["perch-transcript"], "staged-edit"));
});

test("tainted banner only when tainted", async () => {
  const { hub } = await mount({
    items: [
      item({ id: "ss-bbbbbbbbbbbbbbbb", snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "S1", body: "B1" }, tainted: false }),
      item({ id: "ss-cccccccccccccccc", snapshot: { to: ["bob@example.com"], cc: [], bcc: [], subject: "S2", body: "B2" }, tainted: true }),
    ],
  });
  const banners = all(hub, "staged-taint");
  assert.equal(banners.length, 1, "exactly the tainted row carries the banner");
  assert.equal(banners[0].textContent, "Written from outside content: read it before sending.");
  const taintedCard = banners[0].parentNode;
  assert.ok(deepText(taintedCard).includes("S2"), "it is on the tainted draft's card");
});

test("open in gmail when cred_ref null", async () => {
  const { hub } = await mount({ items: [item({ sendable: false, providerDraftId: "draft_9-abcDEF" })] });
  const link = findByClass(hub.els["perch-transcript"], "staged-gmail");
  assert.ok(link, "the link is there");
  assert.equal(link.textContent, "Open in Gmail to send");
  assert.equal(link.href, "https://mail.google.com/mail/#drafts?compose=draft_9-abcDEF");
  assert.equal(findByClass(hub.els["perch-transcript"], "staged-send"), null, "no Send without a credential");
  assert.equal(findByClass(hub.els["perch-transcript"], "staged-edit"), null, "and no Edit either");
  assert.equal(all(hub, "staged-rcpt").length, 1, "the card itself is still read");
});

test("a bad draft id builds no Gmail link", async () => {
  for (const bad of ["draft id/with space", "javascript:alert(1)", "", "x".repeat(201)]) {
    const { hub } = await mount({ items: [item({ sendable: false, providerDraftId: bad })] });
    assert.equal(findByClass(hub.els["perch-transcript"], "staged-gmail"), null, `no link for ${JSON.stringify(bad)}`);
    assert.ok(findByClass(hub.els["perch-transcript"], "staged-gmail-none"), "it says so instead");
  }
});

test("sent/replaced/failed states", async () => {
  // Sent: the round trip, drawn from the answer plus the row the operator was looking at.
  {
    const { hub, posts } = await mount({
      items: [item()],
      reply: { status: 200, json: { ok: true, state: "sent", messageId: "m-1" } },
    });
    findByClass(hub.els["perch-transcript"], "staged-send").onclick();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { content_hash: "a".repeat(64) }, "Send posts the hash it showed");
    const status = text(hub, "staged-status");
    assert.match(status, /^Sent .+ to alex@example\.com$/, status);
    assert.equal(findByClass(hub.els["perch-transcript"], "staged-send"), null, "no Send once it is gone");
    // A later refetch that no longer lists the row must not erase the receipt.
    draftEnd(hub);
    await settle();
    assert.match(text(hub, "staged-status"), /^Sent /);
  }
  // Replaced: the row left the list and a newer one arrived in its place.
  {
    const state = { items: [item()] };
    const { hub } = await mount(state);
    assert.ok(has(hub, "staged-card"));
    state.items = [item({ id: "ss-dddddddddddddddd", contentHash: "b".repeat(64), snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Newer", body: "Newer words" } })];
    draftEnd(hub);
    await settle();
    assert.ok(transcriptText(hub).includes("Replaced by a newer draft"), transcriptText(hub));
    assert.ok(transcriptText(hub).includes("Newer words"), "and the newer draft is on screen");
  }
  // Failed: the stored reason is the sentence, and Retry posts the same hash again.
  {
    const { hub, posts } = await mount({
      items: [item({ state: "failed", failReason: "This draft is gone from Gmail" })],
      reply: { status: 200, json: { ok: true, state: "sent", messageId: "m-2" } },
    });
    assert.equal(text(hub, "staged-status"), "This draft is gone from Gmail");
    const retry = findByClass(hub.els["perch-transcript"], "staged-send");
    assert.equal(retry.textContent, "Retry");
    retry.onclick();
    await settle();
    assert.deepEqual(posts[0].body, { content_hash: "a".repeat(64) });
    assert.match(text(hub, "staged-status"), /^Sent /);
  }
  // Not the owner: one fixed line, and nothing left to press.
  {
    const { hub } = await mount({ items: [item()], reply: { status: 403, json: { error: "not_owner" } } });
    findByClass(hub.els["perch-transcript"], "staged-send").onclick();
    await settle();
    assert.equal(text(hub, "staged-status"), "Only the owner can send this.");
    assert.equal(findByClass(hub.els["perch-transcript"], "staged-send"), null);
  }
});

test("changed re-renders the replacement row", async () => {
  const state = {
    items: [item()],
    reply: { status: 409, json: { error: "changed", id: "ss-eeeeeeeeeeeeeeee", contentHash: "c".repeat(64) } },
  };
  const { hub } = await mount(state);
  assert.equal(text(hub, "staged-body"), "Hello there");
  // The server has replaced our row with the text Gmail actually holds.
  state.items = [item({ id: "ss-eeeeeeeeeeeeeeee", contentHash: "c".repeat(64), snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Changed", body: "The newer words" } })];
  findByClass(hub.els["perch-transcript"], "staged-send").onclick();
  await settle();
  assert.equal(text(hub, "staged-body"), "The newer words", "the card shows the row the server replaced it with");
  assert.deepEqual(all(hub, "staged-note").map((n) => n.textContent).sort(),
    ["Replaced by a newer draft", "The draft changed, review it again."].sort(),
    "the old card says what happened to it, and the new one says why it looks new");
  assert.ok(findByClass(hub.els["perch-transcript"], "staged-send"), "the new row is sendable again, after review");
});

test("the delayed refetch finds a row recorded after the end frame", async () => {
  const state = { items: [] };
  const { hub, gets } = await mount(state);
  assert.equal(has(hub, "staged-card"), false, "nothing staged yet");
  const before = gets.length;

  // The draft tool's end frame: the recorder has not written its row yet.
  draftEnd(hub);
  await settle();
  assert.equal(gets.length, before + 1, "one refetch immediately");
  assert.equal(has(hub, "staged-card"), false, "still nothing");

  // Six seconds later, exactly one more read — and the row is there now.
  state.items = [item()];
  runTimers(hub, 6000);
  await settle();
  assert.equal(gets.length, before + 2, "one delayed read, no loop");
  assert.ok(has(hub, "staged-card"), "the card the recorder wrote late is on screen");
  assert.equal([...hub.timerDelays.values()].filter((d) => d === 6000).length, 0, "and no second delayed read is scheduled");
});

test("standalone page", async () => {
  const id = await store.createStaged(db, {
    sessionId: null,
    threadId: null,
    botId: "channel-bot",
    channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" },
    providerDraftId: "draft-page-1",
    snapshot: {
      to: ["alex@example.com"], cc: [], bcc: ["cara@example.com"],
      subject: "Quarterly numbers", body: "Line one\nLine two",
    },
    tainted: true,
  });
  ownerAllowed = true;
  const page = await request("GET", "/dashboard/staged/" + id);
  assert.equal(page.status, 200, page.text);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "DENY");
  for (const s of ["alex@example.com", "cara@example.com", "Quarterly numbers", "Line one\nLine two",
    "Nothing goes out without your yes.", "Written from outside content: read it before sending.", "Bcc"]) {
    assert.ok(page.text.includes(s), `the page shows ${JSON.stringify(s)}`);
  }
  assert.ok(!page.text.includes("credRef"), "no credential reference on the page");
  assert.match(page.text, /data-act="send"/);

  // The page's own read: the same row shape the chat's list returns.
  const one = await request("GET", "/dashboard/perch-api/staged/" + id);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.headers["cache-control"], "no-store");
  assert.equal(one.json.item.id, id);
  assert.equal(one.json.item.providerDraftId, "draft-page-1", "the Gmail link's id is on the row");
  assert.equal(one.json.item.sendable, true);
  assert.deepEqual(one.json.item.snapshot.bcc, ["cara@example.com"]);
  assert.equal("credRef" in one.json.item, false, "never the credential reference");
  assert.ok(!one.text.includes("credRef"));

  // An unknown id is a 404 page, and an unknown row id is a 404 read.
  assert.equal((await request("GET", "/dashboard/staged/ss-" + "0".repeat(16))).status, 404);
  assert.equal((await request("GET", "/dashboard/perch-api/staged/ss-" + "0".repeat(16))).status, 404);
});

test("a non-owner sees no draft", async () => {
  const id = await store.createStaged(db, {
    sessionId: null, botId: "channel-bot", channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" }, providerDraftId: "draft-page-2",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Secret project", body: "Nobody else reads this" },
  });
  ownerAllowed = false;
  try {
    const page = await request("GET", "/dashboard/staged/" + id);
    assert.equal(page.status, 403);
    assert.ok(page.text.includes("Only the owner can see this draft."));
    for (const s of ["alex@example.com", "Secret project", "Nobody else reads this"]) {
      assert.ok(!page.text.includes(s), `the non-owner's page carries no draft (${s})`);
    }
    const one = await request("GET", "/dashboard/perch-api/staged/" + id);
    assert.equal(one.status, 403);
    assert.deepEqual(one.json, { error: "not_owner" });
  } finally { ownerAllowed = true; }
});

test("needs you lists card-tied drafts", async () => {
  clearNeedsYouCache();
  const project = (await createProjectSpace(db, { name: "Card drafts" })).id;
  const t = new Database(TASKS);
  const cardId = createCard("Send the invoice", project);
  const quiet = createCard("Nothing to do", project);
  t.close();
  const projectIds = [{ id: project }];
  const before = await needsYouCounts(db, projectIds, { cacheMs: 0 });
  assert.equal(before.get(project), 0, "a card with no ask is not Needs you on its own");

  await store.createStaged(db, {
    sessionId: null, cardId, botId: "channel-bot", channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" }, providerDraftId: "draft-needs-you",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Invoice", body: "Attached" },
  });
  const after = await needsYouCounts(db, projectIds, { cacheMs: 0 });
  assert.equal(after.get(project), 1, "the card holding a staged draft needs the operator");
  const cards = await needsYouCards(db, { id: project });
  assert.deepEqual(cards.map((c) => c.id), [cardId]);
  assert.equal(cards.some((c) => c.id === quiet), false, "the other card stays where it was");

  // A sent draft stops needing anyone; a draft with no card never lands on the Board.
  const rows = await store.listStaged(db, { cardId });
  assert.equal(rows.length, 1);
  assert.equal(await store.claimSend(db, rows[0].id, rows[0].contentHash), true);
  await store.settle(db, rows[0].id, { state: "sent" });
  assert.equal((await needsYouCounts(db, projectIds, { cacheMs: 0 })).get(project), 0, "sent is not waiting");
  await store.createStaged(db, {
    sessionId: null, cardId: null, botId: "channel-bot", channel: "gmail",
    credRef: null, providerDraftId: "draft-no-card",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "No card", body: "x" },
  });
  assert.equal((await needsYouCounts(db, projectIds, { cacheMs: 0 })).get(project), 0, "an unfiled draft lists nowhere");
  clearNeedsYouCache();
});

test("inline edit saves arrays and re-renders, Ask for a change fills the composer, Not now collapses", async () => {
  const state = {
    items: [item()],
    reply: (path) => (path.endsWith("/edit")
      ? { status: 200, json: { ok: true, code: "edited", id: "ss-ffffffffffffffff", contentHash: "d".repeat(64), state: "staged" } }
      : { status: 200, json: { ok: true, code: "discarded", state: "discarded" } }),
  };
  const { hub, posts } = await mount(state);
  const nodes = (tag) => {
    const out = [];
    const walk = (n) => { if (n.tagName === tag) out.push(n); for (const c of n.children || []) walk(c); };
    walk(hub.els["perch-transcript"]);
    return out;
  };

  // Edit: the fields arrive prefilled from the row the operator is looking at.
  findByClass(hub.els["perch-transcript"], "staged-edit").onclick();
  let fields = nodes("INPUT");
  assert.deepEqual(fields.map((f) => f.value), ["alex@example.com", "", "", "Hello"], "to/cc/bcc/subject prefilled");
  assert.deepEqual(nodes("TEXTAREA").map((f) => f.value), ["Hello there"], "the body prefilled");
  fields[0].value = "alex@example.com, bob@example.com";
  fields[3].value = "New subject";
  // The server's edit replaces the row; its next list answers the NEW one.
  state.items = [item({
    id: "ss-ffffffffffffffff", contentHash: "d".repeat(64),
    snapshot: { to: ["alex@example.com", "bob@example.com"], cc: [], bcc: [], subject: "New subject", body: "Hello there" },
  })];
  findByClass(hub.els["perch-transcript"], "staged-save").onclick();
  await settle();
  assert.equal(posts.length, 1);
  assert.match(posts[0].path, /\/staged\/ss-aaaaaaaaaaaaaaaa\/edit$/);
  // Comma-split into arrays, each element trimmed: the route takes single clean addresses.
  assert.deepEqual(posts[0].body, {
    to: ["alex@example.com", "bob@example.com"], cc: [], bcc: [], subject: "New subject", body: "Hello there",
  });

  // The card re-renders from the NEW row the server returned.
  await settle();
  assert.equal(text(hub, "staged-subject"), "New subject");
  assert.equal(all(hub, "staged-rcpt").length, 2, "the edited recipients are the card's now");

  // Ask for a change: the note goes into the composer behind a fixed line, and nothing is sent.
  findByClass(hub.els["perch-transcript"], "staged-ask").onclick();
  nodes("TEXTAREA").at(-1).value = "Make it shorter";
  findByClass(hub.els["perch-transcript"], "staged-asksend").onclick();
  assert.equal(hub.els["perch-input"].value, "About the draft you made:\nMake it shorter");
  assert.equal(posts.length, 1, "Ask for a change posts nothing: the composer's ordinary send does");
  assert.equal(text(hub, "staged-status"), "Added to your message box — send it to ask the bot for a change.");

  // Not now: the card collapses to one line, and the draft's text is off the page.
  findByClass(hub.els["perch-transcript"], "staged-notnow").onclick();
  await settle();
  assert.equal(all(hub, "staged-body").length, 0, "the body is gone");
  assert.equal(all(hub, "staged-rcpt").length, 0);
  assert.ok(has(hub, "staged-gone"));
  assert.ok(transcriptText(hub).includes("Discarded here. It stays a draft in Gmail."));
});

test("en and es", async () => {
  const es = await mount({
    items: [item({
      snapshot: { to: ["alex@example.com"], cc: [], bcc: ["cara@example.com"], subject: "Hola", body: "Cuerpo" },
      placeholders: ["Nombre"],
      tainted: true,
    })],
  }, { lang: "es" });
  assert.equal(text(es.hub, "staged-title"), "Borrador de correo");
  assert.equal(text(es.hub, "staged-yes"), "Nada sale sin tu sí.");
  assert.equal(text(es.hub, "staged-taint"), "Escrito a partir de contenido externo: léelo antes de enviarlo.");
  assert.equal(text(es.hub, "staged-label"), "Para");
  assert.ok(all(es.hub, "staged-label").some((n) => n.textContent === "Cco"), "bcc is labelled in Spanish too");
  assert.equal(text(es.hub, "staged-status"), "Rellena [Nombre] primero");
  assert.equal(findByClass(es.hub.els["perch-transcript"], "staged-send").textContent, "Enviar");
  assert.equal(findByClass(es.hub.els["perch-transcript"], "staged-notnow").textContent, "Ahora no");

  const en = await mount({ items: [item()] });
  assert.equal(text(en.hub, "staged-label"), "To", "and English stays English");

  // The standalone page speaks the dashboard's language too.
  const id = await store.createStaged(db, {
    sessionId: null, botId: "channel-bot", channel: "gmail", credRef: null,
    providerDraftId: "draft-es", snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hola", body: "Cuerpo" },
  });
  await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('language', 'es')" });
  try {
    const page = await request("GET", "/dashboard/staged/" + id);
    assert.equal(page.status, 200, page.text);
    assert.ok(page.text.includes("Nada sale sin tu sí."), "the page is in Spanish");
    assert.ok(page.text.includes("Abrir en Gmail para enviar"));
  } finally {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = 'language'" });
  }
});

/* ------------------------------------------------------------------ M1 + L7 */

/** A row for `cardId`, in the shape the recorder writes. */
const stagedRow = (cardId, over = {}) => store.createStaged(db, {
  sessionId: null, cardId, botId: "draft-bot", channel: "gmail",
  credRef: { server: "google-workspace", role: "primary" },
  providerDraftId: "draft-" + Math.random().toString(36).slice(2, 10),
  snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hello", body: "Body text" },
  newRecipients: [],
  ...over,
});

/** The Board tab's rendered page for one scope (the panel's own handler, no server). */
async function boardPage(scope) {
  const { default: boardPanel } = await import("../servers/gateway/dashboard/panels/board.js");
  const page = await boardPanel.handler(
    { crowScope: scope, crowMode: { mode: "shell" } },
    {},
    { db, layout: (o) => o, lang: "en", engine: null },
  );
  return String(page.content);
}

/** The lane section's own markup (id="sb-lane-<lane>"), so a card is never read off another lane. */
const laneSection = (html, lane) => {
  const parts = html.split(`id="sb-lane-${lane}"`);
  return parts.length > 1 ? parts[1].split("</section>")[0] : "";
};

/** The widget's summary (the one server read both the widget and the phone draw). */
async function widgetSummary(project) {
  const { createDbClient } = await import("../servers/db.js");
  const { loadNeedsMe } = await import("../servers/gateway/widgets/needs-me.js");
  const tdb = createDbClient(TASKS);
  try {
    return await loadNeedsMe(db, tdb, {
      now: Date.now(), tasksDbPath: TASKS,
      projects: [{ id: project, slug: "draft-home", name: "Draft home" }],
    });
  } finally { tdb.close(); }
}

/** The morning card's needs section. */
async function morningNeeds(project) {
  const M = await import("../servers/gateway/for-you/morning.js");
  M._resetNeedsCacheForTest();
  const out = await M.loadMorning(db, {
    projects: [{ id: project, slug: "draft-home", name: "Draft home" }],
    now: Date.now(), tasksDbPath: TASKS,
  });
  return out.needs;
}

test("a card with an open draft is Needs you on the Board, in the widget and in the morning brief", async () => {
  clearNeedsYouCache();
  const project = (await createProjectSpace(db, { name: "Draft surfaces" })).id;
  // Priority 0: the widget's and the morning's lanes are the WHOLE store, and both cap the list.
  const cardId = createCard("Waiting on a draft", project, null, 0);
  const rowId = await stagedRow(cardId);

  // The Board tab: the card is in the Needs-you lane and the chip counts it there.
  const html = await boardPage({ projectId: project });
  const needs = laneSection(html, "needs_you");
  assert.ok(needs.includes(`data-card="${cardId}"`), "the Board draws it in Needs you");
  assert.match(needs, /sb-lane-count">1</, "and its chip counts one");
  assert.equal(laneSection(html, "up_next").includes(`data-card="${cardId}"`), false, "not in Up next");

  // The widget: an item, of the draft kind, leading to the draft.
  const summary = await widgetSummary(project);
  const item = summary.items.find((it) => it.key === `card:${cardId}:draft:${rowId}`);
  assert.ok(item, `the widget lists the draft: ${JSON.stringify(summary.items)}`);
  assert.equal(item.kind, "draft");
  assert.equal(item.href, `/dashboard/staged/${rowId}`);
  assert.deepEqual(item.actions, [], "a draft is opened, not answered inline");

  // The morning brief: the same item, with the same link.
  const needs2 = await morningNeeds(project);
  const line = needs2.items.find((it) => it.title === "Waiting on a draft");
  assert.ok(line, `the morning brief lists it: ${JSON.stringify(needs2.items)}`);
  assert.equal(line.kind, "draft");
  assert.equal(line.href, `/dashboard/staged/${rowId}`);
  clearNeedsYouCache();
});

test("a draft item links to its draft", async () => {
  clearNeedsYouCache();
  const project = (await createProjectSpace(db, { name: "Draft link" })).id;
  const cardId = createCard("Two drafts, one card", project, null, 0);
  // The recorder replaced the first draft with a second one for the same card.
  const older = await stagedRow(cardId, { providerDraftId: "draft-older" });
  const newer = await stagedRow(cardId, { providerDraftId: "draft-newer" });
  const map = await (await import("../servers/gateway/staged/card-index.js")).stagedCardIds(db, { tasksDbPath: TASKS });
  assert.equal(map.get(cardId), newer, "the newest open row is the card's draft");
  assert.notEqual(map.get(cardId), older);

  const { needsYouCards } = await import("../servers/gateway/dashboard/panels/board/needs-you.js");
  const cards = await needsYouCards(db, { id: project });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "draft");
  assert.equal(cards[0].stagedId, newer, "the item carries the draft it leads to");

  const needs = await morningNeeds(project);
  const line = needs.items.find((it) => it.title === "Two drafts, one card");
  assert.ok(line, `the brief lists the card: ${JSON.stringify(needs.items)}`);
  assert.equal(line.href, `/dashboard/staged/${newer}`, "the brief links to the newest draft");
  clearNeedsYouCache();
});

test("a draft on another project's card with the same number is not this card's", async () => {
  clearNeedsYouCache();
  const { ensureItem } = await import("../servers/shared/shell-items.js");
  const shared = (await createProjectSpace(db, { name: "Shared store cards" })).id;
  const own = (await createProjectSpace(db, { name: "Own store cards" })).id;
  await db.execute({ sql: "UPDATE project_spaces SET tasks_db_uri = ? WHERE id = ?", args: ["file:" + join(dir, "own-store.db"), own] });
  const cardId = createCard("Same number here", shared);

  // A draft recorded while working in the OTHER project, whose store has its own card with this
  // number: the chat the draft came from is filed under that project.
  await ensureItem(db, "perch_thread", "thread-own-store", { projectId: own, setBy: "operator" });
  await stagedRow(cardId, { sessionId: "thread-own-store", threadId: "thread-own-store", providerDraftId: "draft-own-store" });
  const before = await (await import("../servers/gateway/dashboard/panels/board/needs-you.js")).needsYouCounts(db, [{ id: shared }], { cacheMs: 0 });
  assert.equal(before.get(shared), 0, "another store's card with that number is not this card");

  // The same card with a draft from its OWN store (no provenance: a channel draft) does count.
  await stagedRow(cardId, { providerDraftId: "draft-shared-store" });
  const after = await (await import("../servers/gateway/dashboard/panels/board/needs-you.js")).needsYouCounts(db, [{ id: shared }], { cacheMs: 0 });
  assert.equal(after.get(shared), 1, "and a draft in this store does");
  clearNeedsYouCache();
});

/* -------------------------------------------------------------------- L4 */

test("a draft deleted in Gmail settles on the next list after an hour", async () => {
  const S = await import("../servers/gateway/staged/send-service.js");
  S._resetDraftChecksForTest();
  const sid = "perchlive-l4-gone";
  const id = await stagedRow(null, { sessionId: sid, providerDraftId: "draft-deleted-in-gmail" });
  let reads = 0;
  // The provider's 404, as gmail-client.js raises it (code "gone", fixed message).
  const gone = () => { reads += 1; throw Object.assign(new Error("Gmail request failed"), { name: "GmailError", code: "gone" }); };
  const gmail = () => ({ getDraft: async () => gone(), hasSentTo: async () => false });
  const t0 = Date.now();

  // A fresh row is not re-read at all (one Gmail call per row per hour, at most).
  let items = await S.listStagedForSession(db, sid, { gmail, now: t0 });
  assert.equal(reads, 0, "a draft staged a moment ago is not re-read");
  assert.equal(items[0].state, "staged");

  // An hour later the list re-reads it, gets the 404 and settles it `failed`.
  items = await S.listStagedForSession(db, sid, { gmail, now: t0 + 60 * 60 * 1000 + 1 });
  assert.equal(reads, 1, "one re-read");
  assert.equal(items[0].state, "failed");
  assert.equal(items[0].failReason, "Sent or deleted in Gmail");
  assert.equal((await store.getStaged(db, id)).state, "failed", "and the row itself moved");

  // Once per hour per row: a second list a moment later reads nothing.
  await S.listStagedForSession(db, sid, { gmail, now: t0 + 60 * 60 * 1000 + 5000 });
  assert.equal(reads, 1, "no second read inside the hour");

  // The single-row read (the standalone page) settles it the same way.
  S._resetDraftChecksForTest();
  const singleId = await stagedRow(null, { sessionId: "perchlive-l4-single", providerDraftId: "draft-deleted-single" });
  const item = await S.getStagedItem(db, singleId, { gmail, now: t0 + 3 * 60 * 60 * 1000 });
  assert.equal(item.state, "failed");
  assert.equal(item.failReason, "Sent or deleted in Gmail");
});

test("the draft re-read is capped at five rows per list", async () => {
  const S = await import("../servers/gateway/staged/send-service.js");
  S._resetDraftChecksForTest();
  const sid = "perchlive-l4-cap";
  for (let i = 0; i < 7; i += 1) await stagedRow(null, { sessionId: sid, providerDraftId: `draft-cap-${i}` });
  let reads = 0;
  const gmail = () => ({ getDraft: async () => { reads += 1; return { snapshot: {}, threadId: null, faithful: true }; }, hasSentTo: async () => false });
  await S.listStagedForSession(db, sid, { gmail, now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal(reads, 5, "at most five provider reads per list request");
});

/* -------------------------------------------------------------------- L5 */

/**
 * The standalone page's own script, run the way a browser runs it: the page HTML parsed into a real
 * DOM (linkedom), the script's click listener captured off #staged-page, fetch answered by the test.
 * Nothing here re-implements the page.
 */
function runPage(html, { reply = () => ({ status: 200, json: { ok: true } }) } = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "the page carries its script");
  const { document } = parseHTML(html);
  const root = document.getElementById("staged-page");
  assert.ok(root, "the page carries the card");
  const listeners = {};
  root.addEventListener = (type, fn) => { listeners[type] = fn; };
  Object.defineProperty(document, "cookie", { value: "crow_csrf=test-csrf", configurable: true });
  const calls = [];
  const replaced = [];
  const fetchStub = (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET", body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = reply(url, opts) || { status: 200, json: { ok: true } };
    return Promise.resolve({
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: () => (r.json == null ? Promise.reject(new Error("no json")) : Promise.resolve(r.json)),
    });
  };
  const location = { replace: (u) => replaced.push(String(u)) };
  vm.runInContext(script[1], vm.createContext({ document, window: {}, fetch: fetchStub, location, console }));
  const click = (el) => { assert.ok(el, "there is something to click"); return listeners.click({ target: el }); };
  const status = () => document.getElementById("staged-status").textContent;
  return { document, root, calls, replaced, click, status };
}

test("the page's discard takes Send and Edit away instead of lighting them back up", async () => {
  const id = await store.createStaged(db, {
    sessionId: null, botId: "channel-bot", channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" },
    providerDraftId: "draft-page-discard",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Bye", body: "Body" },
  });
  const page = await request("GET", "/dashboard/staged/" + id);
  assert.equal(page.status, 200, page.text);
  const rig = runPage(page.text, { reply: () => ({ status: 200, json: { ok: true, code: "discarded", state: "discarded" } }) });
  assert.ok(rig.document.querySelector('[data-act="send"]'), "Send is there before");
  assert.ok(rig.document.querySelector('[data-act="edit"]'));
  rig.click(rig.document.querySelector('[data-act="discard"]'));
  await settle();
  assert.equal(rig.calls.length, 1);
  assert.match(rig.calls[0].url, /\/staged\/ss-[0-9a-f]{16}\/discard$/);
  assert.equal(rig.document.querySelector('[data-act="send"]'), null, "Send is gone, not re-enabled");
  assert.equal(rig.document.querySelector('[data-act="edit"]'), null, "and Edit with it");
  assert.equal(rig.status(), "Discarded here. It stays a draft in Gmail.");
});

test("the page's changed-with-no-new-row clears Sending and puts the buttons back", async () => {
  const id = await store.createStaged(db, {
    sessionId: null, botId: "channel-bot", channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" },
    providerDraftId: "draft-page-changed",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Moved", body: "Body" },
  });
  const page = await request("GET", "/dashboard/staged/" + id);
  assert.equal(page.status, 200, page.text);
  const rig = runPage(page.text, { reply: () => ({ status: 409, json: { error: "changed" } }) });
  const send = rig.document.querySelector('[data-act="send"]');
  rig.click(send);
  await settle();
  assert.equal(rig.replaced.length, 0, "no new row to go to");
  assert.equal(rig.status(), "The draft changed, review it again.");
  assert.equal(send.disabled, false, "the buttons come back for the review");
  assert.equal(rig.document.querySelector('[data-act="edit"]').disabled, false);
});

test("the page's placeholders message names the brackets", async () => {
  const id = await store.createStaged(db, {
    sessionId: null, botId: "channel-bot", channel: "gmail",
    credRef: { server: "google-workspace", role: "primary" },
    providerDraftId: "draft-page-placeholders",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hi [Client Name]", body: "Due [Date]" },
  });
  const page = await request("GET", "/dashboard/staged/" + id);
  assert.equal(page.status, 200, page.text);
  assert.ok(page.text.includes("Fill in [Client Name], [Date] first"), "the page says it up front");
  // The script's own answer to an in-flight refusal (a stale page whose Send was drawn enabled):
  // the sentence is the template FILLED, never the raw {list}.
  const rig = runPage(page.text, { reply: () => ({ status: 409, json: { error: "placeholders" } }) });
  rig.click(rig.document.querySelector('[data-act="send"]'));
  await settle();
  assert.equal(rig.status(), "Fill in [Client Name], [Date] first");
  assert.equal(rig.document.querySelector('[data-act="send"]').disabled, false);
});

/* -------------------------------------------------------------------- L6/L8 */

const allIn = (root, tag) => {
  const out = [];
  const walk = (n) => { if (n.tagName === tag) out.push(n); for (const c of n.children || []) walk(c); };
  walk(root);
  return out;
};

test("Ask for a change is its own label and keeps the operator's unsent words", async () => {
  const { hub } = await mount({ items: [item()] });
  hub.els["perch-input"].value = "My own unsent note";
  findByClass(hub.els["perch-transcript"], "staged-ask").onclick();
  const askSend = findByClass(hub.els["perch-transcript"], "staged-asksend");
  assert.equal(askSend.textContent, "Ask for a change", "its own label, never Send's");
  allIn(hub.els["perch-transcript"], "TEXTAREA").at(-1).value = "Make it shorter";
  askSend.onclick();
  assert.equal(hub.els["perch-input"].value,
    "My own unsent note\nAbout the draft you made:\nMake it shorter",
    "the note is appended on a new line, never over the operator's text");
  // The rest of the composer is untouched, and nothing was posted.
  assert.equal(text(hub, "staged-status"), "Added to your message box \u2014 send it to ask the bot for a change.");
});

test("a vanished row is only 'replaced' by a newer row for the SAME provider draft", async () => {
  const state = { items: [item({ providerDraftId: "draft-one" })] };
  const { hub } = await mount(state);
  assert.ok(has(hub, "staged-card"));
  // An unrelated draft arrives; the first row has gone (discarded elsewhere, not replaced).
  state.items = [item({
    id: "ss-dddddddddddddddd", providerDraftId: "draft-two", contentHash: "b".repeat(64),
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Unrelated", body: "Other words" },
  })];
  draftEnd(hub);
  await settle();
  assert.equal(transcriptText(hub).includes("Replaced by a newer draft"), false, "nothing claims a replacement");
  assert.ok(transcriptText(hub).includes("Other words"), "the new draft is on screen");
  assert.equal(all(hub, "staged-body").length, 1, "and the vanished one is simply gone");

  // The real replacement (the same provider draft, a newer row) still says so.
  const state2 = { items: [item({ providerDraftId: "draft-three" })] };
  const second = await mount(state2);
  state2.items = [item({ id: "ss-eeeeeeeeeeeeeeee", providerDraftId: "draft-three", contentHash: "c".repeat(64) })];
  draftEnd(second.hub);
  await settle();
  assert.ok(transcriptText(second.hub).includes("Replaced by a newer draft"), "same draft, newer row");
});