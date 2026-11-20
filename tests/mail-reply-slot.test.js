/**
 * Crow Mail's entry points from the reader (plan 3, Task 11).
 *
 * Two halves, one file:
 *
 *   The panel half renders the message view the panel serves, runs the real reader client script over
 *   it in linkedom + node:vm (as tests/mail-reader-client.test.js does) and drives the reply slot the
 *   script builds: Reply, Reply all, Forward and New email make a draft by hand and open its card;
 *   "Draft a reply with..." opens the picker, the picker always offers "No project", and choosing a
 *   bot makes one draft and starts one turn before opening that bot's card. Bot text — a name, a
 *   reason — is written with textContent, and mail wire text reaches the slot through the server's
 *   escaping.
 *
 *   The route half (init-db'd scratch crow.db, a real express app wired like the gateway, the real
 *   draft routes) holds GET /drafts/bot-options to the owner's rules — a disabled bot is never
 *   listed, a bot whose model may not draft is never listed, every bot refused for cloud drafting
 *   answers `refused` — and holds create's forward derivation to every thread attachment.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import vm from "node:vm";
import Database from "better-sqlite3";
import { parseHTML } from "linkedom";

import { markFromLaptop } from "./helpers/off-box.js";
import { mailClientJs } from "../servers/gateway/dashboard/panels/mail/client.js";
import { mailCss } from "../servers/gateway/dashboard/panels/mail/css.js";
import { renderMailPage } from "../servers/gateway/dashboard/panels/mail/html.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

/* ------------------------------------------------------------------ the scratch db */

const root = mkdtempSync(join(tmpdir(), "mail-reply-slot-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express, json: expressJson } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { MAIL_API_PREFIX, mailApiRouter, clearMailApiRuntime } = await import("../servers/gateway/routes/mail-api.js");
const { clearMailDraftsRuntime, setMailDraftsRuntime } = await import("../servers/gateway/routes/mail-drafts-api.js");
const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { listRevisions } = await import("../servers/gateway/mail/drafts/store.js");
const { upsertFolders, upsertMessage } = await import("../servers/gateway/mail/store/messages.js");

const DRAFTS = `${MAIL_API_PREFIX}/drafts`;
const OWNER = "owner-local-password-session";
// The CSRF token is SERVER-BOUND (queue item #51 PR-1): HMAC(secret, session id).
const { csrfTokenForSession } = await import("../servers/gateway/dashboard/shared/csrf.js");
const CSRF = csrfTokenForSession(OWNER);
const ADDRESS = "alex@example.com";
const SAM = "sam@example.com";
const NOW = 1_767_225_600_000;
const MID = "<reply-slot@mail.example.test>";
const ACC = { id: "ma-aaaaaaaaaaaaaaaa", label: "Personal", address: ADDRESS, status: "active", localModelsOnly: false };

const hashToken = (value) => createHash("sha256").update(value).digest("hex");
const open = [];
const servers = [];

after(() => {
  clearMailApiRuntime();
  clearMailDraftsRuntime();
  for (const server of servers) server.close();
  for (const db of open) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
  const raw = new Database(MASTER);
  raw
    .prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))")
    .run(hashToken(OWNER), "dashboard");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

beforeEach(() => {
  clearMailApiRuntime();
  clearMailDraftsRuntime();
  process.env.CROW_MAIL = "1";
});

afterEach(() => {
  clearMailDraftsRuntime();
});

/* -------------------------------------------------------------- the panel half */

const T0 = Date.UTC(2026, 4, 14, 9, 0, 0);

function messageRow(over = {}) {
  return {
    id: 11,
    accountId: ACC.id,
    folderId: 3,
    threadId: 5,
    messageId: MID,
    subject: "Hello there",
    fromName: "Sam",
    fromAddr: SAM,
    to: [{ name: "Alex", address: ADDRESS }],
    cc: [],
    date: T0,
    isRead: true,
    bodyText: "Hello from Sam",
    bodyHtml: "<p>Hello from Sam</p>",
    parseError: null,
    attachments: [],
    ...over,
  };
}

const FOLDERS = [
  { id: 3, accountId: ACC.id, name: "Inbox", path: "INBOX", specialUse: "\\Inbox" },
];

/** The message view as the panel serves it: one section, opened. */
function messagePage(over = {}) {
  const opened = messageRow(over);
  return renderMailPage({
    view: "message",
    accounts: [ACC],
    lang: "en",
    folders: FOLDERS,
    message: opened,
    thread: [opened],
    account: ACC,
    back: "/dashboard/mail?acct=all",
  });
}

const jsonResponse = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });
const DRAFT_ID = "md-0123456789abcdef";

/**
 * The emitted script, run in a vm over a linkedom page with a stub fetch that answers by route. Every
 * call is recorded (method, url, body); a Turbo visit is recorded as a URL.
 */
function boot(html, { answers = {} } = {}) {
  const { window: dom, document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "crow_session=abc" });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });

  const calls = [];
  const visits = [];
  const window = {
    Turbo: { visit: (url) => visits.push(String(url)) },
    btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
    scrollY: 0,
    __mlTimer: null,
    __mlBound: false,
    addEventListener: () => {},
    crypto: { getRandomValues: (array) => array },
  };
  for (const field of document.querySelectorAll("input, select, textarea")) {
    let current = field.getAttribute("value") || "";
    Object.defineProperty(field, "value", {
      configurable: true,
      get: () => current,
      set: (next) => {
        current = String(next);
      },
    });
  }
  const location = { href: "http://127.0.0.1/dashboard/mail?view=message", assign: (url) => visits.push(String(url)) };
  const ctx = vm.createContext({
    window,
    document,
    location,
    fetch: (url, init) => {
      const options = init || {};
      const call = {
        url: String(url),
        method: String(options.method || "GET"),
        body: options.body == null ? null : JSON.parse(String(options.body)),
      };
      calls.push(call);
      const key = `${call.method} ${call.url.split("?")[0]}`;
      const answer = answers[key];
      if (typeof answer === "function") return Promise.resolve(answer(call, calls));
      if (answer) return Promise.resolve(jsonResponse(200, answer));
      return Promise.resolve(jsonResponse(200, { ok: true }));
    },
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  const emitted = mailClientJs("en");
  const script = emitted.slice(emitted.indexOf("<script>") + 8, emitted.lastIndexOf("</script>"));
  vm.runInContext(script, ctx);

  const settle = async () => {
    for (let index = 0; index < 16; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const click = (node) => node.dispatchEvent(new dom.Event("click", { bubbles: true, cancelable: true }));

  return { window, document, calls, visits, settle, $, $$, click };
}

const botOptions = (body) => ({ [`GET ${DRAFTS}/bot-options`]: body });

test("the slot renders five actions and the picker", async () => {
  const rig = boot(messagePage(), { answers: botOptions({ bots: [], projects: [] }) });
  const slot = rig.$("[data-mail-reply-slot]");
  assert.ok(slot, "the message view carries the slot");

  const labels = rig.$$("[data-mail-reply-slot] .ml-reply-actions button").map((node) => node.textContent);
  assert.deepEqual(labels, [
    translations["mail.reply"].en,
    translations["mail.replyAll"].en,
    translations["mail.forward"].en,
    translations["mail.draftWith"].en,
    translations["mail.newEmail"].en,
  ]);

  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();
  const picker = rig.$("[data-ml-bot-picker]");
  assert.ok(picker, "the picker is in the slot");
  assert.equal(picker.hasAttribute("hidden"), false, "clicking Draft a reply with... shows it");
  assert.equal(rig.$$("[data-ml-bot-picker] .ml-note")[0].textContent, translations["mail.draftSeesOnly"].en);
});

test("\"No project\" is always offered", async () => {
  const rig = boot(messagePage(), { answers: botOptions({ bots: [], projects: [] }) });
  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();
  const group = rig.$('[data-ml-picker-group="no-project"]');
  assert.ok(group, "the group is there with no bots at all");
  assert.equal(group.querySelector(".ml-picker-group-name").textContent, translations["mail.draftNoProject"].en);
});

test("choosing a bot creates one draft and starts one turn", async () => {
  const rig = boot(messagePage(), {
    answers: {
      ...botOptions({
        bots: [{ id: "draftbot", name: "Draft bot", suggested: false, reason: null }],
        projects: [],
      }),
      [`POST ${DRAFTS}`]: { draft: { id: DRAFT_ID } },
      [`POST ${DRAFTS}/${DRAFT_ID}/turn`]: { turnId: "mt-1" },
    },
  });
  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();

  const pick = rig.$('[data-ml-bot-pick][data-bot="draftbot"]');
  assert.ok(pick, "the picker lists the bot");
  rig.click(pick);
  await rig.settle();

  const creates = rig.calls.filter((call) => call.method === "POST" && call.url === DRAFTS);
  assert.equal(creates.length, 1, "exactly one draft");
  assert.deepEqual(creates[0].body, {
    accountId: ACC.id,
    mode: "reply",
    replyToMid: MID,
    botId: "draftbot",
  });

  const turns = rig.calls.filter((call) => call.method === "POST" && call.url === `${DRAFTS}/${DRAFT_ID}/turn`);
  assert.equal(turns.length, 1, "exactly one turn");
  assert.equal(turns[0].body.botId, "draftbot");
  assert.equal(turns[0].body.instruction, translations["mail.draftAsk"].en);

  assert.deepEqual(rig.visits, [`/dashboard/perch?bot=draftbot&maildraft=${DRAFT_ID}`]);
});

test("a refused drafting turn still opens the draft's card, without a bot in the URL", async () => {
  // The turn was refused, so the draft holds no revision — but it exists, and the card is where the
  // person fills it by hand. The reader goes there with no bot in the URL, as the hand paths do, so
  // the draft is never orphaned; the refusal sentence is kept for a card that cannot be opened.
  const rig = boot(messagePage(), {
    answers: {
      ...botOptions({
        bots: [{ id: "draftbot", name: "Draft bot", suggested: false, reason: null }],
        projects: [],
      }),
      [`POST ${DRAFTS}`]: { draft: { id: DRAFT_ID } },
      [`POST ${DRAFTS}/${DRAFT_ID}/turn`]: () => jsonResponse(503, { error: "cloud_drafting_off" }),
    },
  });
  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();

  const pick = rig.$('[data-ml-bot-pick][data-bot="draftbot"]');
  assert.ok(pick, "the picker lists the bot");
  rig.click(pick);
  await rig.settle();

  assert.equal(rig.calls.filter((call) => call.method === "POST" && call.url === DRAFTS).length, 1);
  assert.deepEqual(rig.visits, [`/dashboard/perch?maildraft=${DRAFT_ID}`], "the card opens, with no bot");
  const refusal = rig.$("[data-ml-picker-refusal]");
  assert.equal(refusal.hasAttribute("hidden"), true, "the refusal sentence is not what the person sees");
  assert.equal(pick.hasAttribute("disabled"), false, "the button is usable again");
});

test("a created draft whose id is not a draft id opens nothing and starts no turn", async () => {
  const rig = boot(messagePage(), {
    answers: {
      ...botOptions({
        bots: [{ id: "draftbot", name: "Draft bot", suggested: false, reason: null }],
        projects: [],
      }),
      [`POST ${DRAFTS}`]: { draft: { id: "md-not-a-draft-id" } },
    },
  });
  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();
  rig.click(rig.$('[data-ml-bot-pick][data-bot="draftbot"]'));
  await rig.settle();

  assert.equal(rig.calls.filter((call) => call.method === "POST" && call.url.includes("/turn")).length, 0, "no turn is started");
  assert.deepEqual(rig.visits, [], "no URL is built from the id");
  const line = rig.$("[data-mail-reply-slot] [data-ml-status-line]");
  assert.ok(line, "the failure is said in the slot");
  assert.equal(line.hasAttribute("hidden"), false);
  assert.equal(line.textContent, translations["mail.error.network"].en);
});

test("the picker skips a bot whose id is not a bot id", async () => {
  const rig = boot(messagePage(), {
    answers: botOptions({
      bots: [
        { id: "draftbot", name: "Draft bot", suggested: false, reason: null },
        { id: "../escape", name: "Bad bot", suggested: false, reason: null },
        { id: "bad bot", name: "Spaced bot", suggested: false, reason: null },
        { id: "x".repeat(65), name: "Long bot", suggested: false, reason: null },
        { id: "", name: "Nameless bot", suggested: false, reason: null },
      ],
      projects: [],
    }),
  });
  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();

  const picks = rig.$$("[data-ml-bot-pick]").map((node) => node.getAttribute("data-bot"));
  assert.deepEqual(picks, ["draftbot"], "only an id of letters, digits, dot, underscore or hyphen is drawn");
});

test("the reply slot's strings element cannot override hidden", async () => {
  const html = messagePage();
  const strings = /<div class="ml-note" data-ml-reply-strings hidden/.test(html);
  assert.ok(strings, "the strings element carries the hidden attribute");
  // `.ml-note` is the class that element carries: a display declaration there would beat the user
  // agent's own `[hidden]` rule and print the data attributes on the page.
  const rule = /\.ml-note \{([^}]*)\}/.exec(mailCss({ message: true }));
  assert.ok(rule, "the base rules carry .ml-note");
  assert.doesNotMatch(rule[1], /display\s*:/, "no display declaration, so hidden still applies");
});

test("a bot that may not draft shows the fixed refusal and creates no draft", async () => {
  const rig = boot(messagePage(), {
    answers: botOptions({ bots: [], projects: [], refused: "cloud_drafting_off" }),
  });
  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();

  const refusal = rig.$("[data-ml-picker-refusal]");
  assert.equal(refusal.hasAttribute("hidden"), false, "the refusal is shown");
  assert.equal(refusal.textContent, translations["mail.draftCloudOff"].en);
  assert.equal(rig.$$("[data-ml-bot-pick]").length, 0, "no bot is offered");
  assert.equal(rig.calls.filter((call) => call.method === "POST").length, 0, "nothing was created");
  assert.deepEqual(rig.visits, []);
});

test("mail wire text in the slot is escaped", async () => {
  const wire = '<img src=x onerror="alert(1)">@mail.example.test';
  const html = messagePage({ messageId: wire });
  assert.match(html, /data-mid="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;@mail\.example\.test"/);
  assert.doesNotMatch(html, /<img src=x/, "the wire text never becomes markup");

  const rig = boot(html, {
    answers: {
      ...botOptions({
        bots: [{ id: "draftbot", name: "<b>Draft</b>", suggested: false, reason: null }],
        projects: [],
      }),
    },
  });
  assert.equal(rig.$("[data-mail-reply-slot]").getAttribute("data-mid"), wire);

  rig.click(rig.$("[data-ml-reply-bot]"));
  await rig.settle();
  const name = rig.$("[data-ml-bot-pick] .ml-pick-name");
  assert.equal(name.textContent, "<b>Draft</b>", "the bot's name is text");
  assert.equal(name.querySelector("b"), null, "and never an element");
});

test("Reply by hand opens an empty card, and New email makes a mode:new draft", async () => {
  const rig = boot(messagePage(), { answers: { [`POST ${DRAFTS}`]: { draft: { id: DRAFT_ID } } } });

  rig.click(rig.$('[data-ml-reply="reply"]'));
  await rig.settle();
  const reply = rig.calls.find((call) => call.method === "POST" && call.url === DRAFTS);
  assert.deepEqual(reply.body, { accountId: ACC.id, mode: "reply", replyToMid: MID });
  assert.deepEqual(rig.visits, [`/dashboard/perch?maildraft=${DRAFT_ID}`], "no bot in the URL");

  rig.click(rig.$("[data-ml-new-email]"));
  await rig.settle();
  const created = rig.calls.filter((call) => call.method === "POST" && call.url === DRAFTS);
  assert.equal(created.length, 2);
  assert.deepEqual(created[1].body, { accountId: ACC.id, mode: "new" });
});

/* -------------------------------------------------------------- the route half */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

let n = 0;

/** The scratch app: one per test, the real mail API router over a copy of the master db. */
async function setup() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  setMailDraftsRuntime({ now: () => NOW });
  const db = createDbClient(crow);
  open.push(db);

  const app = express();
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  assert.ok(predicate, "index.js's _hasOwnParser is where it was");
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  const globalJson = expressJson({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));

  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const router = mailApiRouter(sessionGate, { openDb: () => createDbClient(crow), supervisor: null });
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(router);
  app.use(dash);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const port = server.address().port;

  const call = (method, path, { body } = {}) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { cookie: "crow_session=" + OWNER, "x-crow-csrf": CSRF, "x-test-from": "laptop" };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on("error", reject);
      req.end(payload === null ? undefined : payload);
    });
  };

  const account = await createAccount(db, {
    label: "Personal",
    address: ADDRESS,
    authKind: "password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });

  /** Seed crow.db rows directly: the picker reads pi_bot_defs, the providers and project_spaces. */
  const seed = (fn) => {
    const raw = new Database(crow);
    try {
      fn(raw);
    } finally {
      raw.close();
    }
  };

  return { db, crow, account, call, seed };
}

/** One bot row: enabled unless the caller says otherwise, with a default model key. */
function seedBot(raw, { id, name = id, model = "stub/m1", enabled = 1, projectId = null }) {
  raw
    .prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(id, name, JSON.stringify({ models: { default: model } }), enabled, projectId);
}

/** Two providers: one on this box (proven local) and one on a public host (cloud). */
function seedProviders(raw) {
  const insert = raw.prepare("INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,0)");
  insert.run("stub", "http://127.0.0.1:8003/v1", "none", "local", JSON.stringify([{ id: "m1" }]));
  insert.run("cloudy", "https://api.example.test/v1", "none", "cloud", JSON.stringify([{ id: "m1" }]));
}

test("the picker never lists a bot the owner cannot use", async () => {
  const s = await setup();
  s.seed((raw) => {
    seedProviders(raw);
    seedBot(raw, { id: "draftbot", name: "Draft bot" });
    seedBot(raw, { id: "cloudbot", name: "Cloud bot", model: "cloudy/m1" });
    seedBot(raw, { id: "offbot", name: "Off bot", enabled: 0 });
  });

  const res = await s.call("GET", `${DRAFTS}/bot-options?accountId=${s.account.id}&mid=${encodeURIComponent(MID)}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.bots, [{ id: "draftbot", name: "Draft bot", suggested: false, reason: null }]);
  assert.deepEqual(res.json.projects, []);
  assert.equal(res.json.refused, undefined, "a bot that may draft is offered, so nothing is refused");

  const bodyless = await s.call("GET", `${DRAFTS}/bot-options`);
  assert.equal(bodyless.status, 400, bodyless.text);
});

test("every bot refused for cloud drafting answers the code and lists nothing", async () => {
  const s = await setup();
  s.seed((raw) => {
    seedProviders(raw);
    seedBot(raw, { id: "cloudbot", name: "Cloud bot", model: "cloudy/m1" });
  });

  const res = await s.call("GET", `${DRAFTS}/bot-options?accountId=${s.account.id}&mid=${encodeURIComponent(MID)}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.bots, []);
  assert.deepEqual(res.json.projects, []);
  assert.equal(res.json.refused, "cloud_drafting_off");
});

test("a thread with no filing suggests no bot, and a filed one suggests its project's bot", async () => {
  const s = await setup();

  // The shipped schema records no filing for a thread, so nothing is suggested and no reason is
  // invented for any bot.
  s.seed((raw) => {
    seedProviders(raw);
    seedBot(raw, { id: "draftbot", name: "Draft bot" });
  });
  const plain = await s.call("GET", `${DRAFTS}/bot-options?accountId=${s.account.id}&mid=${encodeURIComponent(MID)}`);
  assert.equal(plain.status, 200, plain.text);
  assert.deepEqual(plain.json.bots.map((bot) => [bot.id, bot.suggested, bot.reason]), [["draftbot", false, null]]);

  // A store that does record one: the bot of that project is suggested first, with the project's name.
  const folder = (await upsertFolders(s.db, s.account.id, [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  ])).folders[0];
  const stored = await upsertMessage(s.db, {
    accountId: s.account.id,
    folderId: folder.id,
    uid: 1,
    messageId: MID,
    subject: "Saturday",
    from: { name: "Sam", address: SAM },
    to: [{ name: "Alex", address: ADDRESS }],
    cc: [],
    text: "are we still on",
    html: null,
    snippet: "are we still on",
    attachments: [],
    date: NOW - 60_000,
    internalDate: NOW - 60_000,
    flags: [],
    parseError: null,
  });
  s.seed((raw) => {
    // `project_id` is not a column of `mail_threads` in the shipped schema: this ALTER adds it to
    // this scratch copy alone, so the suggestion path is exercised against a hypothetical store that
    // records a thread's filing (the shipped store records none, as the case above shows).
    raw.prepare("ALTER TABLE mail_threads ADD COLUMN project_id INTEGER").run();
    raw.prepare("INSERT INTO project_spaces (id, slug, name) VALUES (7, 'launch', 'Launch')").run();
    raw.prepare("UPDATE mail_threads SET project_id = 7 WHERE id = ?").run(stored.threadId);
    seedBot(raw, { id: "launchbot", name: "Launch bot", projectId: 7 });
  });

  const filed = await s.call("GET", `${DRAFTS}/bot-options?accountId=${s.account.id}&mid=${encodeURIComponent(MID)}`);
  assert.equal(filed.status, 200, filed.text);
  assert.equal(filed.json.bots[0].id, "launchbot", "the suggested bot comes first");
  assert.equal(filed.json.bots[0].suggested, true);
  assert.equal(filed.json.bots[0].reason, "Launch", "the reason is the project's own name");
  assert.deepEqual(filed.json.projects, [{ id: 7, name: "Launch", bots: ["launchbot"] }]);
});

test("Forward carries every thread attachment as a ref", async () => {
  const s = await setup();
  const folder = (await upsertFolders(s.db, s.account.id, [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  ])).folders[0];
  await upsertMessage(s.db, {
    accountId: s.account.id,
    folderId: folder.id,
    uid: 1,
    messageId: MID,
    subject: "With attachments",
    from: { name: "Sam", address: SAM },
    to: [{ name: "Alex", address: ADDRESS }],
    cc: [],
    text: "see attached",
    html: null,
    snippet: "see attached",
    attachments: [
      { filename: "report.pdf", contentType: "application/pdf", size: 2048 },
      { filename: "notes.txt", contentType: "text/plain", size: 12 },
    ],
    date: NOW - 60_000,
    internalDate: NOW - 60_000,
    flags: [],
    parseError: null,
  });

  const res = await s.call("POST", DRAFTS, {
    body: { accountId: s.account.id, mode: "forward", replyToMid: MID },
  });
  assert.equal(res.status, 200, res.text);
  const [first] = await listRevisions(s.db, res.json.draft.id);
  assert.equal(res.json.draft.mode, "forward");
  assert.deepEqual(first.attachments.map((ref) => [ref.source, ref.mid, ref.index, ref.filename, ref.size]), [
    ["thread", MID, 0, "report.pdf", 2048],
    ["thread", MID, 1, "notes.txt", 12],
  ]);
});