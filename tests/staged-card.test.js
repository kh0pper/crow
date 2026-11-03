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
import Database from "better-sqlite3";
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
  createCard = (title, projectId, ask = null) => {
    const t = new Database(TASKS);
    try {
      return Number(t.prepare(
        "INSERT INTO tasks_items (title, project_id, status, action_needed) VALUES (?, ?, 'pending', ?)").run(title, projectId, ask).lastInsertRowid);
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