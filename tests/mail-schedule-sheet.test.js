/**
 * The schedule sheet (Crow Mail, plan 3, Task 10b): the three shortcuts, the instant each one stands
 * for, and the presets route behind them.
 *
 * Harness, two halves in one file:
 *  - the vm harness (tests/fixtures/perch-hub-vm.mjs): the WHOLE emitted Perch client runs against a
 *    fake DOM and a fake fetch, with the draft, presets and schedule routes answered per test. No
 *    browser, no server. The client is opened through the real card (its Schedule button) and then
 *    through the sheet's own buttons.
 *  - a scratch crow.db (CROW_DATA_DIR — init-db, nothing can touch ~/.crow) with an ephemeral express
 *    app holding the real mail API router, for the presets route's rails, its shape and its use of
 *    the owner's working hours.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";
import { mountHub, openChatSession, findByClass, makeResponse, stdFetch } from "./fixtures/perch-hub-vm.mjs";
import { perchMailScheduleSheetJs } from "../servers/gateway/dashboard/panels/mail/schedule-sheet.js";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const root = mkdtempSync(join(tmpdir(), "mail-schedule-sheet-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { default: express } = await import("express");
const { createDbClient } = await import("../servers/db.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { MAIL_API_PREFIX, mailApiRouter, clearMailApiRuntime } = await import("../servers/gateway/routes/mail-api.js");
const { clearMailDraftsRuntime, setMailDraftsRuntime } = await import("../servers/gateway/routes/mail-drafts-api.js");
const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");

const SID = "perchlive-aaaaaaaa";
const ID = "md-0123456789abcdef";
const HASH = "a".repeat(64);
const DRAFTS = `${MAIL_API_PREFIX}/drafts`;
const PRESETS_PATH = DRAFTS + "/schedule-presets";

/* 2026-11-10T18:00Z is 12:00 on Tuesday 10 November 2026 in America/Chicago (CST, -06:00). */
const NOW = Date.UTC(2026, 10, 10, 18, 0);
const ZONE = "America/Chicago";
const MIN_LEAD_MS = 60 * 1000;
const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

/** What the presets route answers, as the sheet reads it. */
const PRESETS = {
  zone: ZONE,
  tomorrowMorning: { iso: "2026-11-11T07:30:00-06:00", label: "7:30 AM" },
  nextWorkDay: { iso: "2026-11-11T08:00:00-06:00", label: "8:00 AM" },
  minLeadMs: MIN_LEAD_MS,
  maxAheadMs: MAX_AHEAD_MS,
};

/* The plan's own sentence, verbatim, and the sheet's three option names. */
const BOX_ON_SENTENCE = "It goes out at that time only because you scheduled it. You can change or "
  + "cancel it until then. Crow sends it itself, so this computer must be on.";
const TOO_FAR_SENTENCE = "You can schedule up to 90 days ahead.";
const PAST_SENTENCE = "Pick a time at least a minute from now.";

/* Every i18n key the sheet emits. The three unmatched labels (the empty-pick line and the two
   field labels) have no approved copy yet, so they keep their English on both sides and each is
   listed in the parity test's IDENTICAL_OK. */
const SHEET_KEYS = [
  "mail.scheduleTomorrowMorning",
  "mail.scheduleNextWorkDay",
  "mail.schedulePick",
  "mail.schedulePickMissing",
  "mail.scheduleDateLabel",
  "mail.scheduleTimeLabel",
  "mail.scheduleBoxOn",
  "mail.scheduleTooFar",
  "mail.sched.past",
];
const PENDING_COPY = new Set([
  "mail.schedulePickMissing",
  "mail.scheduleDateLabel",
  "mail.scheduleTimeLabel",
]);

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";

const openDbs = [];
const servers = [];

after(() => {
  clearMailApiRuntime();
  clearMailDraftsRuntime();
  for (const s of servers) s.close();
  for (const c of openDbs) {
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
  // The two sessions the router is asked to tell apart: the owner's own password session and a
  // peer's single-sign-on one.
  const hashToken = (t) => createHash("sha256").update(t).digest("hex");
  const raw = new Database(MASTER);
  const insert = raw.prepare(
    "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))",
  );
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
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

let routeSeq = 0;

/** The scratch app: one per test, with the real mail API router. */
async function setupRoute() {
  const dir = join(root, "r" + (++routeSeq));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

  const db = createDbClient(crow);
  openDbs.push(db);
  // The flag is what opens every mail route at all; the one test below turns it off on purpose.
  process.env.CROW_MAIL = "1";
  // The instance zone is this box's own setting, not the host's: the presets are read in it.
  await writeSetting(db, "instance_timezone", ZONE);
  setMailDraftsRuntime({ now: () => NOW });

  const app = express();
  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const router = mailApiRouter(sessionGate, { openDb: () => createDbClient(crow) });
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(router);
  app.use(dash);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const port = server.address().port;

  const call = (method, path, { body, token = OWNER, csrf = CSRF, laptop = true } = {}) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = {
      ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
    };
    if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
    if (token && csrf) h["x-crow-csrf"] = csrf;
    if (laptop) h["x-test-from"] = "laptop";
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
            // not JSON
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on("error", reject);
      req.end(payload === null ? undefined : payload);
    });
  };

  return { db, router, call };
}

/* ------------------------------------------------- the sheet's client half */

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await tick();
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
 * Mount the real client with a scripted draft, presets and schedule surface. `state.presets` is the
 * presets answer, `state.at` the answer to a picked wall time, `state.reply` the answer to the
 * schedule tap. Every call is recorded in `calls`.
 */
async function mount(state = {}) {
  const calls = [];
  const impl = (method, path, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path, body });
    if (path.endsWith("/mail-drafts") && method === "GET") {
      const list = state.list !== undefined ? state.list : Object.keys(state.drafts || {});
      return makeResponse(200, { drafts: list.map((id) => ({ id })) });
    }
    if (method === "GET" && path.indexOf(PRESETS_PATH) === 0) {
      const query = path.slice(PRESETS_PATH.length);
      if (query !== "") {
        const answer = state.at || { status: 200, json: { iso: PRESETS.tomorrowMorning.iso } };
        return makeResponse(answer.status, answer.json);
      }
      return makeResponse(200, state.presets || PRESETS);
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
const one = (hub, cls) => all(hub, cls)[0] || null;
const posts = (calls) => calls.filter((c) => c.method !== "GET");
const reads = (calls) => calls.filter((c) => c.method === "GET");

/** Open the sheet from the card's own Schedule button. */
async function openSheet(hub) {
  const button = findById(hub, "mdraft-schedule");
  assert.ok(button, "the card offers Schedule");
  button.onclick();
  await settle();
}

function findById(hub, cls) {
  return findByClass(hub.els["perch-transcript"], cls);
}

/* -------------------------------------------------------------------- tests */

test("the sheet's shortcuts come from GET /schedule-presets", async () => {
  const { hub, calls } = await mount({ drafts: { [ID]: payload() } });
  await open(hub);
  await openSheet(hub);

  assert.ok(
    reads(calls).some((c) => c.path.indexOf(PRESETS_PATH) === 0),
    "the sheet asks the server for its shortcuts",
  );
  assert.equal(text(hub, "msched-tomorrow"), "Tomorrow morning · 7:30 AM",
    "the caption is the sheet's own word plus the time the server sent");
  assert.equal(text(hub, "msched-workday"), "Next work day · 8:00 AM");
});

test("the sheet computes no time of its own: no Date arithmetic anywhere in it", async () => {
  for (const lang of ["en", "es"]) {
    const js = perchMailScheduleSheetJs(lang);
    assert.equal(js.includes("`"), false, `${lang}: no backtick`);
    assert.equal(js.includes("${"), false, `${lang}: no dollar-brace`);
    for (const banned of ["new Date", "Date.UTC", "getTime", "setDate", "setHours", "getHours", "toISOString"]) {
      assert.equal(js.includes(banned), false, `${lang}: the sheet must not call ${banned}`);
    }
    // The three server calls it does make: the shortcuts, a picked wall time, and the tap.
    assert.ok(js.includes("/drafts/schedule-presets"), `${lang}: the shortcuts are read from the route`);
    assert.ok(js.includes("/drafts/schedule-presets?at="), `${lang}: a pick is resolved by the server`);
    assert.ok(js.includes("'/schedule'"), `${lang}: the tap posts the sheet's own route`);
    assert.doesNotThrow(() => new vm.Script(perchHubJs(lang)), `${lang}: the emitted client compiles`);
  }
});

test("the sheet posts the server's zone-qualified instant with the hash the card was drawn from", async () => {
  const { hub, calls } = await mount({
    drafts: { [ID]: payload() },
    reply: { status: 200, json: { ok: true, dueAt: Date.UTC(2026, 10, 11, 13, 30) } },
  });
  await open(hub);
  await openSheet(hub);

  findByClass(hub.els["perch-transcript"], "msched-tomorrow").onclick();
  await settle();

  const post = posts(calls).find((c) => c.path.endsWith("/schedule"));
  assert.ok(post, "the shortcut posts the schedule tap");
  assert.equal(post.path, "/dashboard/mail/api/drafts/" + ID + "/schedule");
  assert.equal(post.body.hash, HASH, "the hash the card was drawn from");
  assert.match(post.body.dueAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/,
    "a zone-qualified ISO instant, offset included");
  assert.equal(post.body.dueAt, "2026-11-11T07:30:00-06:00", "the server's own instant, posted as it came");
});

test("the sheet shows the line that the computer must be on", async () => {
  const { hub } = await mount({ drafts: { [ID]: payload() } });
  await open(hub);
  await openSheet(hub);
  assert.equal(text(hub, "msched-box"), BOX_ON_SENTENCE);
});

test("a picked date and time is resolved by the server and posted as its instant", async () => {
  const { hub, calls } = await mount({
    drafts: { [ID]: payload() },
    at: { status: 200, json: { iso: "2026-11-12T07:30:00-06:00" } },
    reply: { status: 200, json: { ok: true } },
  });
  await open(hub);
  await openSheet(hub);

  findByClass(hub.els["perch-transcript"], "msched-date").value = "2026-11-12";
  findByClass(hub.els["perch-transcript"], "msched-time").value = "07:30";
  findByClass(hub.els["perch-transcript"], "msched-pick-go").onclick();
  await settle();

  const resolved = reads(calls).find((c) => c.path.indexOf(PRESETS_PATH + "?at=") === 0);
  assert.ok(resolved, "the wall time goes to the server");
  assert.equal(resolved.path, PRESETS_PATH + "?at=2026-11-12T07%3A30", "a bare wall time, no offset");
  const post = posts(calls).find((c) => c.path.endsWith("/schedule"));
  assert.equal(post.body.dueAt, "2026-11-12T07:30:00-06:00", "the instant the server answered with");
  assert.equal(post.body.hash, HASH);
});

test("a picked time past ninety days shows the fixed sentence and schedules nothing", async () => {
  const { hub, calls } = await mount({
    drafts: { [ID]: payload() },
    at: { status: 200, json: { iso: "2027-06-01T09:00:00-05:00" } },
    reply: { status: 400, json: { error: "bad_input", message: "That request is not valid.", reason: "too_far" } },
  });
  await open(hub);
  await openSheet(hub);

  findByClass(hub.els["perch-transcript"], "msched-date").value = "2027-06-01";
  findByClass(hub.els["perch-transcript"], "msched-time").value = "09:00";
  findByClass(hub.els["perch-transcript"], "msched-pick-go").onclick();
  await settle();

  assert.equal(text(hub, "msched-status"), TOO_FAR_SENTENCE);
  assert.ok(one(hub, "msched-sheet"), "the sheet stays open so another time can be chosen");
});

test("a time already gone shows the sheet's own past sentence and schedules nothing", async () => {
  const { hub, calls } = await mount({
    drafts: { [ID]: payload() },
    reply: { status: 400, json: { error: "bad_input", message: "That request is not valid.", reason: "past" } },
  });
  await open(hub);
  await openSheet(hub);

  findByClass(hub.els["perch-transcript"], "msched-tomorrow").onclick();
  await settle();

  assert.equal(text(hub, "msched-status"), PAST_SENTENCE);
  assert.equal(posts(calls).filter((c) => c.path.endsWith("/schedule")).length, 1, "one tap, refused");
  assert.ok(one(hub, "msched-sheet"), "the sheet stays open so another time can be chosen");
});

test("a pick with no date or no time says which and asks the server nothing", async () => {
  const { hub, calls } = await mount({ drafts: { [ID]: payload() } });
  await open(hub);
  await openSheet(hub);
  const before = reads(calls).length;

  findByClass(hub.els["perch-transcript"], "msched-pick-go").onclick();
  await settle();

  assert.equal(text(hub, "msched-status"), "Choose a date and a time.");
  assert.equal(reads(calls).length, before, "an incomplete pick is not sent");
  assert.equal(posts(calls).length, 0);
});

test("Cancel closes the sheet and schedules nothing", async () => {
  const { hub, calls } = await mount({ drafts: { [ID]: payload() } });
  await open(hub);
  await openSheet(hub);
  assert.ok(one(hub, "msched-sheet"));

  findByClass(hub.els["perch-transcript"], "msched-cancel").onclick();
  await settle();
  assert.equal(one(hub, "msched-sheet"), null);
  assert.equal(posts(calls).length, 0);
});

test("Change time opens the same sheet on a scheduled draft", async () => {
  const dueAt = Date.UTC(2026, 10, 12, 13, 30);
  const { hub } = await mount({ drafts: { [ID]: payload({ draft: { state: "scheduled", dueAt } }) } });
  await open(hub);
  findByClass(hub.els["perch-transcript"], "mdraft-change-time").onclick();
  await settle();
  assert.ok(one(hub, "msched-sheet"), "a scheduled draft re-opens the sheet");
  assert.equal(text(hub, "msched-box"), BOX_ON_SENTENCE);
});

test("the sheet's i18n keys exist in en and es, and differ unless the copy is pending", () => {
  for (const key of SHEET_KEYS) {
    const entry = translations[key];
    assert.ok(entry, `${key} exists`);
    for (const lang of ["en", "es"]) {
      assert.equal(typeof entry[lang], "string", `${key} has ${lang}`);
      assert.ok(entry[lang].length > 0, `${key} has a non-empty ${lang}`);
    }
    assert.equal(
      entry.es === entry.en,
      PENDING_COPY.has(key),
      `${key}: ${PENDING_COPY.has(key) ? "the Spanish copy is not supplied yet" : "the Spanish must differ"}`,
    );
  }
  assert.equal(translations["mail.scheduleBoxOn"].en, BOX_ON_SENTENCE, "the plan's sentence, verbatim");
  assert.equal(translations["mail.scheduleTomorrowMorning"].en, "Tomorrow morning");
  assert.equal(translations["mail.scheduleNextWorkDay"].en, "Next work day");
  assert.equal(translations["mail.schedulePick"].en, "Pick date and time");
  assert.equal(translations["mail.scheduleTooFar"].en, TOO_FAR_SENTENCE);
  assert.equal(translations["mail.sched.past"].en, PAST_SENTENCE);
});

/* ------------------------------------------------- the presets route, server */

test("the presets route is registered before /:id and answers the sheet's shape", async () => {
  const s = await setupRoute();
  const order = [];
  for (const layer of s.router.stack) {
    const route = layer.route;
    if (!route || typeof route.path !== "string") continue;
    if (!route.path.startsWith(DRAFTS)) continue;
    order.push([Object.keys(route.methods).join(",").toUpperCase(), route.path]);
  }
  const presetsAt = order.findIndex(([method, path]) => method === "GET" && path === PRESETS_PATH);
  const idAt = order.findIndex(([method, path]) => method === "GET" && path === `${DRAFTS}/:id`);
  assert.ok(presetsAt >= 0, "the route is registered");
  assert.ok(idAt >= 0, "the card's own read is registered");
  assert.ok(presetsAt < idAt, "the presets path must never be read as a draft id");

  const res = await s.call("GET", PRESETS_PATH);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.json?.zone, ZONE);
  assert.deepEqual(res.json?.tomorrowMorning, { iso: "2026-11-11T07:30:00-06:00", label: "7:30 AM" });
  assert.deepEqual(res.json?.nextWorkDay, { iso: "2026-11-11T08:00:00-06:00", label: "8:00 AM" });
  assert.equal(res.json?.minLeadMs, MIN_LEAD_MS);
  assert.equal(res.json?.maxAheadMs, MAX_AHEAD_MS);
});

test("the presets route is owner-only and flag-gated", async () => {
  const s = await setupRoute();
  const peer = await s.call("GET", PRESETS_PATH, { token: SSO });
  assert.equal(peer.status, 403, peer.text);
  assert.deepEqual(peer.json, { error: "owner_only", message: "Only the owner can see this." });

  process.env.CROW_MAIL = "0";
  try {
    const off = await s.call("GET", PRESETS_PATH);
    assert.equal(off.status, 404, off.text);
    assert.deepEqual(off.json, { error: "not_found", message: "Not found." });
  } finally {
    process.env.CROW_MAIL = "1";
  }
});

test("the working hours in Mail settings move both shortcuts", async () => {
  const s = await setupRoute();
  const patched = await s.call("PATCH", `${MAIL_API_PREFIX}/settings`, {
    body: { workingHoursStart: "09:15", workingHoursEnd: "17:00" },
  });
  assert.equal(patched.status, 200, patched.text);

  const res = await s.call("GET", PRESETS_PATH);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json?.tomorrowMorning, { iso: "2026-11-11T09:15:00-06:00", label: "9:15 AM" });
  assert.deepEqual(res.json?.nextWorkDay, { iso: "2026-11-11T09:15:00-06:00", label: "9:15 AM" });
});

test("a picked wall time comes back as the zone's instant, or a 400", async () => {
  const s = await setupRoute();
  const ok = await s.call("GET", `${PRESETS_PATH}?at=2026-11-12T07:30`);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { iso: "2026-11-12T07:30:00-06:00" });

  /* A wall time the zone skips (the spring-forward gap), a date no calendar has, and a value that is
     not a wall time at all: each is this route's bad input, never a quietly moved instant. */
  for (const bad of ["2026-03-08T02:30", "2026-13-01T07:30", "2026-11-12T25:00", "nonsense", ""]) {
    const res = await s.call("GET", `${PRESETS_PATH}?at=${bad}`);
    if (bad === "") {
      assert.equal(res.status, 200, "an empty at reads the shortcuts instead");
      continue;
    }
    assert.equal(res.status, 400, `${bad}: ${res.text}`);
    assert.equal(res.json?.error, "bad_input", bad);
  }
});