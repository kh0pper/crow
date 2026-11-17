// Crow Mail's draft routes (plan 3, Task 7): the owner's own HTTP surface for one draft card, under
// `/dashboard/mail/api/drafts`.
//
// Harness: plan 1's (tests/mail-api-actions.test.js) — a real init-db'd scratch crow.db copied per
// test (CROW_DATA_DIR, so nothing can touch the real ~/.crow), an ephemeral express app wired the way
// servers/gateway/index.js and dashboard/index.js wire it (the global 1mb JSON parser skipped by
// index.js's own `_hasOwnParser` predicate, read from its source; then a session stub, the dashboard's
// real CSRF middleware, then the real mail API router), the real account and draft stores, a fake
// mail adapter behind a recording supervisor, and the real owner rule with the request marked as
// coming from the owner's laptop (tests/helpers/off-box.js).
//
// The services are the real ones. What the test injects is the seam around them
// (`setMailDraftsRuntime`): a fixed clock, a keychain seed so a tap can be sealed, a timer that does
// not fire (so a hold never reaches the adapter), and — for the turn route — a fake
// `startDraftingTurn`, because the module that owns it is written by its own task.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "mail-drafts-api-"));
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
const {
  MAIL_API_PREFIX,
  mailApiRouter,
  clearMailApiRuntime,
} = await import("../servers/gateway/routes/mail-api.js");
const {
  MAIL_DRAFT_ID_RE,
  clearMailDraftsRuntime,
  setMailDraftsRuntime,
} = await import("../servers/gateway/routes/mail-drafts-api.js");
const { CHANGED_SENTENCE } = await import("../servers/gateway/mail/send/send-service.js");
const {
  zoneOffsetMinutesAt,
  wallClockAt,
} = await import("../servers/gateway/mail/send/schedule-service.js");
const { instanceZone } = await import("../servers/shared/schedule-store.js");
const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { createDraft, getDraft, listRevisions } = await import("../servers/gateway/mail/drafts/store.js");
const { makeDraftReaders } = await import("../servers/gateway/mail/drafts/readers.js");
const { upsertFolders, upsertMessage, getMessage } = await import("../servers/gateway/mail/store/messages.js");
const { createFakeMailAdapter } = await import("./fixtures/fake-mail-adapter.mjs");
const { makeRaw } = await import("./fixtures/fake-mail-server.mjs");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";

const DRAFTS = `${MAIL_API_PREFIX}/drafts`;
const ADDRESS = "alex@example.com";
const SAM = "sam@example.com";
const SEED = Buffer.from("a fixed keychain seed for the draft routes");
const NOW = 1_767_225_600_000;
const SEEDED_ID = "md-0123456789abcdef";

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

const open = [];
const servers = [];

after(() => {
  clearMailApiRuntime();
  clearMailDraftsRuntime();
  for (const s of servers) s.close();
  for (const c of open) {
    try {
      c.close();
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
  const insert = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))");
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
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

/* ------------------------------------------------------------------ plumbing */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

let n = 0;

/** The scratch app: one per test, with the real router and a fake supervisor. */
async function setup({ turn = false } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const turns = [];
  setMailDraftsRuntime({
    loadKey: async () => SEED,
    // A hold's own timer is the delivery path this test does not drive: the sweep and the hold are
    // the send service's tests.
    schedule: () => null,
    now: () => NOW,
    startDraftingTurn: typeof turn === "function"
      ? async (db, deps, options) => {
        turns.push({ options, deps });
        return turn(db, deps, options);
      }
      : turn
        ? async (db, deps, options) => {
          turns.push({ options, deps });
          return { turnId: "turn-1" };
        }
        : null,
  });

  const db = createDbClient(crow);
  open.push(db);

  const fake = createFakeMailAdapter();
  const supervisor = {
    calls: [],
    async requestSync(accountId) {
      this.calls.push(["requestSync", accountId]);
    },
    async withAdapter(accountId, fn) {
      this.calls.push(["withAdapter", accountId]);
      return fn(fake);
    },
  };

  const app = express();
  // servers/gateway/index.js's split, using the REAL predicate read from its source.
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
  const router = mailApiRouter(sessionGate, {
    openDb: () => createDbClient(crow),
    supervisor,
  });
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(router);
  app.use(dash);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const port = server.address().port;

  /** One request. `csrf: null` sends no CSRF header; `token: null` sends no session cookie. */
  const call = (method, path, { body, headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) => {
    const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = {
      ...(payload === null
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
    };
    if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
    if (token && csrf) h["x-crow-csrf"] = csrf;
    if (laptop) h["x-test-from"] = "laptop";
    Object.assign(h, headers);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON (the CSRF refusal is plain text)
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
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

  return { db, crow, account, supervisor, fake, router, call, turns };
}

/** One stored draft with one revision, ready for a tap. */
async function newDraft(s, over = {}) {
  return createDraft(s.db, {
    accountId: s.account.id,
    mode: over.mode ?? "new",
    replyToMid: over.replyToMid ?? null,
    first: {
      to: over.to ?? [{ address: SAM }],
      cc: over.cc ?? [],
      bcc: over.bcc ?? [],
      subject: over.subject ?? "Weekend",
      body: over.body ?? "Are we still on for Saturday?",
      inReplyTo: over.inReplyTo,
      references: over.references,
      attachments: over.attachments ?? [],
    },
    author: "user",
  });
}

/** Every route this module registers, as `[method, path]` with its parameters filled in. */
function draftRoutes(router) {
  const out = [];
  for (const layer of router.stack) {
    const route = layer.route;
    if (!route || typeof route.path !== "string") continue;
    if (!route.path.startsWith(DRAFTS)) continue;
    for (const method of Object.keys(route.methods)) {
      out.push([
        method.toUpperCase(),
        route.path.replace(":id", SEEDED_ID).replace(":rev", "1"),
      ]);
    }
  }
  return out;
}

/** A zone-qualified ISO instant for `at` in the instance zone, as the schedule sheet posts one. */
async function zonedTime(db, at) {
  const zone = await instanceZone(db);
  const wall = wallClockAt(at, zone);
  const offset = zoneOffsetMinutesAt(at, zone);
  const pad = (value) => String(value).padStart(2, "0");
  const sign = offset < 0 ? "-" : "+";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:00${sign}${hours}:${minutes}`;
}

/* -------------------------------------------------------------------- tests */

test("flag unset gives 404 on every route, and the route list is the card's own surface", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const routes = draftRoutes(s.router);
  assert.ok(routes.length >= 10, `expected the card's routes, got ${routes.length}`);
  for (const verb of ["GET", "POST"]) {
    assert.ok(routes.some(([method]) => method === verb), `the card has a ${verb}`);
  }
  assert.ok(MAIL_DRAFT_ID_RE.test(draft.id), "the store's own id shape");

  process.env.CROW_MAIL = "0";
  for (const [method, path] of routes) {
    const res = await s.call(method, path, { body: {} });
    assert.equal(res.status, 404, `${method} ${path}: ${res.text}`);
    assert.equal(res.json?.error, "not_found", `${method} ${path}`);
  }
});

test("no owner session gives 403 owner_only, and every registered verb is behind that guard", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  assert.equal(draft.state, "draft");

  const send = await s.call("POST", `${DRAFTS}/${draft.id}/send`, {
    body: { hash: draft.headHash },
    token: SSO,
  });
  assert.equal(send.status, 403, send.text);
  assert.deepEqual(send.json, { error: "owner_only", message: "Only the owner can see this." });

  // The whole surface, not just the tap: a peer's single-sign-on session reaches no route at all.
  for (const [method, path] of draftRoutes(s.router)) {
    const res = await s.call(method, path, { body: {}, token: SSO });
    assert.equal(res.status, 403, `${method} ${path}: ${res.text}`);
    assert.equal(res.json?.error, "owner_only", `${method} ${path}`);
  }
});

test("missing CSRF header is refused before any route runs", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/send`, {
    body: { hash: draft.headHash },
    csrf: null,
  });
  assert.equal(res.status, 403, res.text);
  assert.match(res.text, /CSRF/);
  assert.equal((await getDraft(s.db, draft.id)).state, "draft", "nothing was tapped");
});

test("send with a stale hash gives 409 changed and nothing moves", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/send`, {
    body: { hash: "not-the-head" },
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json?.error, "changed");
  assert.equal(res.json?.message, CHANGED_SENTENCE);
  assert.equal((await getDraft(s.db, draft.id)).state, "draft");
  assert.equal(s.fake.calls.filter((entry) => entry.method === "send").length, 0);
});

test("send with the right hash gives holding and a holdUntil the row carries", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/send`, {
    body: { hash: draft.headHash },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json?.ok, true);
  assert.equal(res.json?.holdUntil, NOW + 10_000);

  const row = await getDraft(s.db, draft.id);
  assert.equal(row.state, "holding");
  assert.equal(row.holdUntil, NOW + 10_000);
  assert.equal(row.tapAction, "send");
  assert.ok(row.tapSeal, "the tap is sealed");
  assert.ok(row.tapId, "the tap carries its own id");
  assert.equal(s.fake.calls.filter((entry) => entry.method === "send").length, 0, "the hold is not a send");
});

test("a request body over 64 KB is refused by the mail router's own parser", async () => {
  const s = await setup();
  const res = await s.call("POST", DRAFTS, {
    body: { accountId: s.account.id, mode: "new", audience: "x".repeat(70 * 1024) },
  });
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json?.error, "too_large");
});

test("routes accept no raw From, no headers and no envelope key", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const base = {
    expectHash: draft.headHash,
    to: [{ address: SAM }],
    cc: [],
    subject: "Weekend",
    body: "Are we still on?",
    attachments: [],
  };
  for (const extra of [
    { from: { address: "sam@example.com" } },
    { headers: { "X-Anything": "1" } },
    { envelope: { from: ADDRESS, to: [SAM] } },
    { bcc: [{ address: SAM }] },
  ]) {
    const res = await s.call("POST", `${DRAFTS}/${draft.id}/revisions`, { body: { ...base, ...extra } });
    assert.equal(res.status, 400, `${Object.keys(extra)[0]}: ${res.text}`);
    assert.equal(res.json?.error, "bad_input");
  }
  assert.equal((await getDraft(s.db, draft.id)).headRev, 1, "no revision was written");
});

test("GET /:id is the card: the row, the head, the flags, the comments and the history", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("GET", `${DRAFTS}/${draft.id}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json?.draft?.id, draft.id);
  assert.equal(res.json?.head?.rev, 1);
  assert.deepEqual(res.json?.flags?.newRecipients, [SAM], "never mailed, so the card marks it");
  assert.deepEqual(res.json?.comments, []);
  assert.deepEqual(res.json?.history?.map((entry) => entry.rev), [1]);
  assert.equal(res.json?.history?.[0]?.author, "user");

  const missing = await s.call("GET", `${DRAFTS}/${SEEDED_ID}`);
  assert.equal(missing.status, 404, missing.text);
});

test("a hand edit writes the next revision and always cancels a schedule", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const scheduled = await s.call("POST", `${DRAFTS}/${draft.id}/schedule`, {
    body: { hash: draft.headHash, dueAt: await zonedTime(s.db, NOW + 2 * 60 * 60 * 1000) },
  });
  assert.equal(scheduled.status, 200, scheduled.text);
  assert.equal((await getDraft(s.db, draft.id)).state, "scheduled");

  const edit = await s.call("POST", `${DRAFTS}/${draft.id}/revisions`, {
    body: {
      expectHash: draft.headHash,
      to: [{ address: SAM }],
      cc: [],
      subject: "Weekend",
      body: "Are we still on for Sunday?",
      attachments: [],
    },
  });
  assert.equal(edit.status, 200, edit.text);
  assert.equal(edit.json?.rev, 2);

  const row = await getDraft(s.db, draft.id);
  assert.equal(row.state, "draft", "the edit returned the scheduled draft to a draft");
  assert.equal(row.headRev, 2);
  assert.equal(row.tapSeal, null, "the schedule's seal went with it");
  const revisions = await listRevisions(s.db, draft.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].body, "Are we still on for Sunday?");
});

test("a hand edit of a reply keeps the head's Bcc, In-Reply-To and References", async () => {
  const s = await setup();
  const draft = await newDraft(s, {
    mode: "reply",
    subject: "Re: Weekend",
    bcc: [{ address: "jo@example.com" }],
    inReplyTo: "<m-1@mail.example.test>",
    references: ["<m-0@mail.example.test>", "<m-1@mail.example.test>"],
  });
  const [first] = await listRevisions(s.db, draft.id);
  assert.deepEqual(first.bcc.map((entry) => entry.address), ["jo@example.com"], "precondition: the head has a Bcc");

  const edit = await s.call("POST", `${DRAFTS}/${draft.id}/revisions`, {
    body: {
      expectHash: draft.headHash,
      to: [{ address: SAM }],
      cc: [],
      subject: "Re: Weekend",
      body: "Sunday then, if that is easier.",
      attachments: [],
    },
  });
  assert.equal(edit.status, 200, edit.text);

  const head = (await listRevisions(s.db, draft.id)).find((entry) => entry.rev === edit.json.rev);
  assert.equal(head.body, "Sunday then, if that is easier.");
  assert.deepEqual(head.bcc.map((entry) => entry.address), ["jo@example.com"], "the person's Bcc is carried over");
  assert.equal(head.inReplyTo, "<m-1@mail.example.test>", "the reply stays threaded");
  assert.deepEqual(head.references, ["<m-0@mail.example.test>", "<m-1@mail.example.test>"]);
});

test("a hand edit against a stale hash is refused changed", async () => {
  const s = await setup();
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/revisions`, {
    body: {
      expectHash: "not-the-head",
      to: [{ address: SAM }],
      cc: [],
      subject: "Weekend",
      body: "changed",
      attachments: [],
    },
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json?.error, "changed");
  assert.equal(res.json?.message, CHANGED_SENTENCE);
  assert.equal((await getDraft(s.db, draft.id)).headRev, 1);
});

test("POST /turn on a holding draft is refused, and on a draft it starts one turn", async () => {
  const s = await setup({ turn: true });
  const tapped = await newDraft(s);
  const send = await s.call("POST", `${DRAFTS}/${tapped.id}/send`, { body: { hash: tapped.headHash } });
  assert.equal(send.status, 200, send.text);

  const refused = await s.call("POST", `${DRAFTS}/${tapped.id}/turn`, {
    body: { botId: "bot-1", instruction: "tighten the second line" },
  });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json?.error, "frozen");
  assert.equal(refused.json?.state, "holding");
  assert.deepEqual(s.turns, [], "no turn was started for a frozen draft");

  const draft = await newDraft(s);
  const started = await s.call("POST", `${DRAFTS}/${draft.id}/turn`, {
    body: { botId: "bot-1", instruction: "tighten the second line" },
  });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json?.turnId, "turn-1");
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].options.draftId, draft.id);
  assert.equal(s.turns[0].options.botId, "bot-1", "the bot the person named reaches the turn");
  assert.equal(s.turns[0].options.instruction, "tighten the second line");
  // Only what a turn reads: no adapter, no sync, nothing a send needs.
  assert.deepEqual(Object.keys(s.turns[0].deps), ["now"]);
});

test("a drafting turn's refusals answer by their own code", async () => {
  const refuseWith = (code) => async () => {
    const err = new Error(code);
    err.name = "MailError";
    err.code = code;
    throw err;
  };

  // A draft that took a turn while it was still editable, then froze under it.
  const frozen = await setup({ turn: refuseWith("frozen") });
  const drafted = await newDraft(frozen);
  const onFrozen = await frozen.call("POST", `${DRAFTS}/${drafted.id}/turn`, {
    body: { botId: "bot-1", instruction: "tighten the second line" },
  });
  assert.equal(onFrozen.status, 409, onFrozen.text);
  assert.equal(onFrozen.json?.error, "frozen");
  assert.notEqual(onFrozen.json?.needsCancel, true, "nothing to cancel on an unscheduled draft");

  // The store's own pre-check: a scheduled draft cannot take a turn, and its card offers Cancel send.
  const scheduledSetup = await setup({ turn: true });
  const scheduled = await newDraft(scheduledSetup);
  const tap = await scheduledSetup.call("POST", `${DRAFTS}/${scheduled.id}/schedule`, {
    body: { hash: scheduled.headHash, dueAt: await zonedTime(scheduledSetup.db, NOW + 2 * 60 * 60 * 1000) },
  });
  assert.equal(tap.status, 200, tap.text);
  const onScheduled = await scheduledSetup.call("POST", `${DRAFTS}/${scheduled.id}/turn`, {
    body: { botId: "bot-1", instruction: "tighten the second line" },
  });
  assert.equal(onScheduled.status, 409, onScheduled.text);
  assert.equal(onScheduled.json?.error, "frozen");
  assert.equal(onScheduled.json?.needsCancel, true, "a scheduled draft needs its schedule cancelled first");
  assert.deepEqual(scheduledSetup.turns, [], "no turn was started");

  for (const code of ["cloud_drafting_off", "local_models_only"]) {
    const gated = await setup({ turn: refuseWith(code) });
    const draft = await newDraft(gated);
    const res = await gated.call("POST", `${DRAFTS}/${draft.id}/turn`, {
      body: { botId: "bot-1", instruction: "tighten the second line" },
    });
    assert.equal(res.status, 403, `${code}: ${res.text}`);
    assert.deepEqual(res.json, { error: code }, "the code alone: the card owns that copy");
  }
});

test("a turn refused for a file-mode MCP config answers 503 with the code alone", async () => {
  // A drafting turn is fd-only: on a host that delivers bot MCP configs as files, the bridge refuses
  // the turn before it spawns anything. The route says so by code; the card owns the sentence.
  const s = await setup({
    turn: async () => {
      const err = new Error("delivery_unsupported");
      err.name = "MailError";
      err.code = "delivery_unsupported";
      throw err;
    },
  });
  const draft = await newDraft(s);
  const res = await s.call("POST", `${DRAFTS}/${draft.id}/turn`, {
    body: { botId: "bot-1", instruction: "tighten the second line" },
  });
  assert.equal(res.status, 503, res.text);
  assert.deepEqual(res.json, { error: "delivery_unsupported" }, "no message text rides along");
});

test("schedule takes zone-qualified text only, and a number is bad input", async () => {
  const s = await setup();
  const draft = await newDraft(s);

  const numeric = await s.call("POST", `${DRAFTS}/${draft.id}/schedule`, {
    body: { hash: draft.headHash, dueAt: NOW + 2 * 60 * 60 * 1000 },
  });
  assert.equal(numeric.status, 400, numeric.text);
  assert.equal(numeric.json?.error, "bad_input");
  assert.equal((await getDraft(s.db, draft.id)).state, "draft");

  const bare = await s.call("POST", `${DRAFTS}/${draft.id}/schedule`, {
    body: { hash: draft.headHash, dueAt: "2026-01-01T07:30:00" },
  });
  assert.equal(bare.status, 400, bare.text);
  assert.equal(bare.json?.error, "bad_input");

  const dueAt = await zonedTime(s.db, NOW + 2 * 60 * 60 * 1000);
  const scheduled = await s.call("POST", `${DRAFTS}/${draft.id}/schedule`, {
    body: { hash: draft.headHash, dueAt },
  });
  assert.equal(scheduled.status, 200, scheduled.text);
  const row = await getDraft(s.db, draft.id);
  assert.equal(row.state, "scheduled");
  assert.equal(row.tapAction, "schedule");
  assert.ok(row.dueAt > NOW + 60_000);
});

test("cancel-schedule and discard answer their own state's refusal", async () => {
  const s = await setup();
  const draft = await newDraft(s);

  const notScheduled = await s.call("POST", `${DRAFTS}/${draft.id}/cancel-schedule`, { body: {} });
  assert.equal(notScheduled.status, 409, notScheduled.text);
  assert.equal(notScheduled.json?.error, "not_scheduled");
  assert.equal(notScheduled.json?.state, "draft");

  const discarded = await s.call("POST", `${DRAFTS}/${draft.id}/discard`, { body: {} });
  assert.equal(discarded.status, 200, discarded.text);
  const row = await getDraft(s.db, draft.id);
  assert.equal(row.state, "discarded");

  const again = await s.call("POST", `${DRAFTS}/${draft.id}/discard`, { body: {} });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json?.error, "not_discardable");
});

test("create derives a reply from the message it answers", async () => {
  const s = await setup();
  const folder = (await upsertFolders(s.db, s.account.id, [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  ])).folders[0];
  const messageId = "<m-1@mail.example.test>";
  await upsertMessage(s.db, {
    accountId: s.account.id,
    folderId: folder.id,
    uid: 1,
    messageId,
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

  const res = await s.call("POST", DRAFTS, {
    body: { accountId: s.account.id, mode: "reply", replyToMid: messageId },
  });
  assert.equal(res.status, 200, res.text);
  const draft = res.json.draft;
  assert.equal(draft.mode, "reply");
  assert.equal(draft.replyToMid, messageId);
  const [first] = await listRevisions(s.db, draft.id);
  assert.equal(first.subject, "Re: Saturday");
  assert.deepEqual(first.to.map((entry) => entry.address), [SAM]);

  const unknown = await s.call("POST", DRAFTS, {
    body: { accountId: s.account.id, mode: "reply", replyToMid: "<missing@mail.example.test>" },
  });
  assert.equal(unknown.status, 404, unknown.text);
});

/* ------------------------------------------------------------------ readers */

test("readMessageRaw reads the opened row's own UID from its own folder and nothing else", async () => {
  const s = await setup();
  const folder = (await upsertFolders(s.db, s.account.id, [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
  ])).folders[0];
  const raw = makeRaw({ subject: "Saturday", messageId: "<m-7@mail.example.test>" });
  const uid = s.fake.deliver("INBOX", raw);
  const stored = await upsertMessage(s.db, {
    accountId: s.account.id,
    folderId: folder.id,
    uid,
    messageId: "<m-7@mail.example.test>",
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
  const row = await getMessage(s.db, stored.id);

  const readers = makeDraftReaders({ db: s.db, supervisor: s.supervisor });
  const bytes = await readers.readMessageRaw({
    accountId: s.account.id,
    mid: "<m-7@mail.example.test>",
    row,
  });
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, Buffer.from(raw).length);

  const otherAccount = await readers.readMessageRaw({
    accountId: "ma-ffffffffffffffff",
    mid: "<m-7@mail.example.test>",
    row,
  });
  assert.equal(otherAccount, null, "a folder that is not this account's is not read");

  s.fake.expunge("INBOX", uid);
  const gone = await readers.readMessageRaw({
    accountId: s.account.id,
    mid: "<m-7@mail.example.test>",
    row,
  });
  assert.equal(gone, null, "a UID the server no longer holds reads as nothing");
});

test("readStorageFile answers null: Crow storage has no owner-checked read by file id", async () => {
  const s = await setup();
  const readers = makeDraftReaders({ db: s.db, supervisor: s.supervisor });
  assert.equal(await readers.readStorageFile("file-1"), null);
  assert.equal(await makeDraftReaders({ db: s.db }).readStorageFile("file-1"), null);
});