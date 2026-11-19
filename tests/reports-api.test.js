// Crow Recurring Reports' owner API: the owner rail on every route, the reply shapes, the id check,
// the body limit, and the fixed error answers.
//
// Harness: a real init-db'd scratch crow.db copied per test (CROW_DATA_DIR under a temp dir), an
// ephemeral express app wired the way servers/gateway/index.js + dashboard/index.js wire it (the global
// 1mb JSON parser skipped by index.js's own `_hasOwnParser` predicate, read from its source; then a
// session stub, the dashboard's real CSRF middleware, then the real reports API router), the real
// report store and approvals module with an injected preview-run reader, and the real owner rule with
// the request marked as coming from the owner's laptop (tests/helpers/off-box.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const root = mkdtempSync(join(tmpdir(), "reports-api-"));
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
const { reportsApiRouter, REPORTS_API_PREFIX, OWNER_LABEL } = await import("../servers/gateway/routes/reports-api.js");
const { SETTINGS_CHANGED_PAUSE_REASON } = await import("../servers/gateway/reports/approvals.js");
const { createReport, getReport, saveRecipe, updateReportColumns } = await import("../servers/gateway/reports/store.js");
const { createAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { createMailCredentials } = await import("../servers/gateway/mail/credentials.js");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const CSRF = "csrf-token-value";
const SEED = Buffer.alloc(32, 5);
const PROJECT = 7;
const SENDER = "ma-0011223344556677";
const REGISTRY = { mail_list: { sourceBearing: true }, columns: { sourceBearing: false } };
const RECIPE = {
  blocks: [
    { id: "b1", type: "mail_list", settings: { account: SENDER, sinceDays: 7 } },
    { id: "b2", type: "columns", settings: { columns: ["subject"] } },
  ],
};
const FREE_EDIT = {
  blocks: [
    { id: "b1", type: "mail_list", settings: { account: SENDER, sinceDays: 7 } },
    { id: "b2", type: "columns", settings: { columns: ["date"] } },
  ],
};

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

const open = [];
const servers = [];
let server = null;

after(() => {
  for (const s of servers) s.close();
  for (const c of open) { try { c.close(); } catch { /* closed */ } }
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
  const insert = raw.prepare(
    "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'))",
  );
  insert.run(hashToken(OWNER), "dashboard");
  insert.run(hashToken(SSO), "dashboard sso src:peer-1");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

/* -------------------------------------------------------------------------- HTTP */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** One request. `token: null` sends no session cookie; `csrf: null` sends no CSRF header; `laptop:
 *  false` leaves the request classified as coming from this machine. */
function call(method, path, { body, headers = {}, token = OWNER, csrf = CSRF, laptop = true } = {}) {
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) };
  if (token) h.cookie = "crow_session=" + token + "; crow_csrf=" + CSRF;
  if (token && csrf) h["x-crow-csrf"] = csrf;
  if (laptop) h["x-test-from"] = "laptop";
  Object.assign(h, headers);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: h }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(payload === undefined || payload === null ? undefined : payload);
  });
}

const get = (path, opts) => call("GET", path, opts);
const post = (path, body, opts) => call("POST", path, { body, ...opts });
const put = (path, body, opts) => call("PUT", path, { body, ...opts });

const reportPath = (id) => `${REPORTS_API_PREFIX}/${encodeURIComponent(id)}`;

/* ------------------------------------------------------------------------- setup */

let n = 0;

/** One test's world: a copied crow.db, a router over it, and the seams it was built with. A
 *  `senderReady` of null leaves the sender seam to the router's own default (the real Crow Mail
 *  reader); anything else is injected as given. */
async function setup({ ownerCheck = undefined, runs = null, resolveModelRef = null, senderReady = async () => true } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
  const db = createDbClient(crow);
  open.push(db);

  const opened = { n: 0, closed: 0 };
  const openDb = () => {
    opened.n++;
    const c = createDbClient(crow);
    const close = c.close.bind(c);
    c.close = () => { opened.closed++; return close(); };
    return c;
  };

  const runTable = runs ?? {};
  const approvalsDeps = {
    loadSeed: () => ({ seed: SEED }),
    now: () => 1_700_000_000_000,
    registry: REGISTRY,
    getRun: async (_db, runId) => runTable[runId] ?? null,
    ...(senderReady ? { senderReady } : {}),
    ...(resolveModelRef ? { resolveModelRef } : {}),
  };

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
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(reportsApiRouter(sessionGate, {
    openDb,
    approvalsDeps,
    ...(ownerCheck === undefined ? {} : { ownerCheck }),
  }));
  app.use(dash);

  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);

  return { db, crow, opened, runTable, approvalsDeps, hasOwnParser };
}

/** A saved report, set up the way go-live needs it: a schedule row and a sender. */
async function prepareReport(db, { schedule = true, recipe = RECIPE } = {}) {
  let scheduleId = null;
  if (schedule) {
    await db.execute({
      sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', '0 7 * * 1', 'Europe/Berlin')",
      args: [],
    });
    const { rows } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
    scheduleId = Number(rows[0].id);
  }
  const { id } = await createReport(db, { projectId: PROJECT, owner: OWNER_LABEL, botId: "bot-1", title: "Weekly listings" });
  const saved = await saveRecipe(db, { reportId: id, recipe, authorKind: "owner", registry: REGISTRY });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: SENDER,
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: 0,
  });
  return { id, rev: saved.rev };
}

/** Add an approved preview run of one report's current revision to a world's run table. */
function addPreviewRun(world, report, runId = "prv-1", over = {}) {
  world.runTable[runId] = {
    id: runId, reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev, ...over,
  };
  return runId;
}

/* ------------------------------------------------------------------ the owner rail */

test("a non-owner session is 403 owner_only on every route, with no data", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  addPreviewRun(world, report);
  const id = report.id;

  const routes = [
    ["GET", `${REPORTS_API_PREFIX}?project=${PROJECT}`, undefined],
    ["POST", REPORTS_API_PREFIX, { projectId: PROJECT, title: "Another" }],
    ["GET", reportPath(id), undefined],
    ["PUT", `${reportPath(id)}/recipe`, { recipe: FREE_EDIT }],
    ["PUT", `${reportPath(id)}/settings`, { settings: { title: "Mine" } }],
    ["POST", `${reportPath(id)}/go-live`, { previewRunId: "prv-1" }],
    ["POST", `${reportPath(id)}/pause`, { reason: "stop" }],
    ["POST", `${reportPath(id)}/resume`, {}],
    ["POST", `${reportPath(id)}/preview`, {}],
    ["POST", `${reportPath(id)}/run-now`, {}],
    ["GET", `${reportPath(id)}/runs`, undefined],
  ];
  for (const [label, opts] of [
    ["a peer's single-sign-on session", { token: SSO }],
    ["a request from this machine", { token: OWNER, laptop: false }],
  ]) {
    for (const [method, path, body] of routes) {
      const r = await call(method, path, { body, ...opts });
      assert.equal(r.status, 403, `${label} ${method} ${path}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: "owner_only", message: "Only the owner can see this." }, `${label} ${method} ${path}`);
      assert.equal(r.text.includes("Weekly listings"), false, `${label} ${method} ${path}: no title`);
      assert.equal(r.text.includes(SENDER), false, `${label} ${method} ${path}: no sender`);
      assert.equal(r.text.includes(id), false, `${label} ${method} ${path}: no id`);
    }
  }
  // Nothing was created, saved or moved.
  const rows = await getReport(world.db, id);
  assert.equal(rows.status, "draft");
  assert.equal(rows.title, "Weekly listings");
  assert.equal(Number(rows.recipe_rev), report.rev);
  const { rows: all } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM reports", args: [] });
  assert.equal(Number(all[0].n), 1, "no second report");
  const { rows: requests } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM report_run_requests", args: [] });
  assert.equal(Number(requests[0].n), 0, "and no run was asked for");
});

test("an owner check that throws is a 403 with no data, never a 500", async () => {
  const world = await setup({
    ownerCheck: async () => { throw new Error("database is locked (crow.db)"); },
  });
  const r = await get(`${REPORTS_API_PREFIX}?project=${PROJECT}`);
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, { error: "owner_only", message: "Only the owner can see this." });
  assert.equal(r.text.includes("database is locked"), false);
  assert.equal(world.opened.n, world.opened.closed, "the owner-check client was closed");
});

/* ------------------------------------------------------------------- the happy path */

test("the owner creates, lists and reads a report", async () => {
  const world = await setup();
  const created = await post(REPORTS_API_PREFIX, { projectId: PROJECT, botId: "bot-1", title: "Weekly listings" });
  assert.equal(created.status, 201, created.text);
  const view = created.json.report;
  assert.match(view.id, /^rpt-[0-9a-f]{16}$/);
  assert.equal(view.project_id, PROJECT);
  assert.equal(view.owner, OWNER_LABEL);
  assert.equal(view.owner, "owner", "the report is the instance owner's");
  assert.equal(view.bot_id, "bot-1");
  assert.equal(view.title, "Weekly listings");
  assert.equal(view.status, "draft");
  assert.equal(view.live, false);
  assert.equal(created.headers["cache-control"], "no-store");

  const listed = await get(`${REPORTS_API_PREFIX}?project=${PROJECT}`);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.reports.length, 1);
  assert.equal(listed.json.reports[0].id, view.id);
  assert.equal(listed.json.reports[0].live, false);

  const read = await get(reportPath(view.id));
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.report.id, view.id);
  assert.equal(read.json.report.recipe_rev, 0);
  assert.equal(world.opened.n, world.opened.closed, "one client per request, closed");
});

test("the owner saves a recipe, changes settings, goes live, pauses and resumes", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);

  const saved = await put(`${reportPath(report.id)}/recipe`, { recipe: FREE_EDIT });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(Object.keys(saved.json).sort(), ["hash", "needsGoLive", "restamped", "rev", "sourcesHash"]);
  assert.equal(saved.json.rev, report.rev + 1);
  assert.equal(saved.json.restamped, false, "a draft is never re-stamped");
  assert.equal(saved.json.needsGoLive, false);

  const runId = addPreviewRun(world, { id: report.id, rev: saved.json.rev });

  const settings = await put(`${reportPath(report.id)}/settings`, {
    settings: { delivery_mode: "both", title: "Weekly listings, renamed", ai_commentary: 0 },
  });
  assert.equal(settings.status, 200, settings.text);
  assert.equal(settings.json.report.delivery_mode, "both");
  assert.equal(settings.json.report.title, "Weekly listings, renamed");
  assert.equal(settings.json.report.status, "draft", "a draft does not pause");

  const live = await post(`${reportPath(report.id)}/go-live`, { previewRunId: runId });
  assert.equal(live.status, 200, live.text);
  assert.deepEqual(live.json, { ok: true, liveRev: saved.json.rev });

  const read = await get(reportPath(report.id));
  assert.equal(read.json.report.status, "live");
  assert.equal(read.json.report.live, true);
  assert.equal(read.json.report.approved_preview_run, runId);

  // A live-set change on a live report pauses it with the fixed sentence.
  const pausedBySettings = await put(`${reportPath(report.id)}/settings`, { settings: { comment_tier_default: "a" } });
  assert.equal(pausedBySettings.status, 200, pausedBySettings.text);
  assert.equal(pausedBySettings.json.report.status, "paused");
  assert.equal(pausedBySettings.json.report.pause_reason, SETTINGS_CHANGED_PAUSE_REASON);
  assert.equal(pausedBySettings.json.report.live, false, "a live-set change breaks the seal");

  // Back on a live-set value the seal covers again is still a settings change: the report stays paused
  // until the owner resumes it.
  const resumed = await post(`${reportPath(report.id)}/resume`, {});
  assert.equal(resumed.status, 409, resumed.text);
  assert.equal(resumed.json.error, "go_live_needed");

  const paused = await post(`${reportPath(report.id)}/pause`, { reason: "Starting over" });
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.json.report.status, "paused");
  assert.equal(paused.json.report.pause_reason, "Starting over");
});

test("the router wires the real sender reader, so go live reads this instance's Crow Mail state", async () => {
  const world = await setup({ senderReady: null });
  const endpoint = { host: "mail.example.test", port: 993, security: "ssl" };
  const account = await createAccount(world.db, {
    label: "Personal", address: "alex@example.com", username: "alex", authKind: "password",
    imap: endpoint, smtp: { ...endpoint, port: 465 },
  });
  const credentials = createMailCredentials({ db: world.db, crowHome: process.env.CROW_HOME });
  await credentials.saveSecret(account.id, "MAIL_PASSWORD", "app-password-value");

  const report = await prepareReport(world.db);
  await updateReportColumns(world.db, report.id, { sender_account_id: account.id });
  const runId = addPreviewRun(world, report);
  const live = await post(`${reportPath(report.id)}/go-live`, { previewRunId: runId });
  assert.equal(live.status, 200, live.text);
  assert.equal(live.json.ok, true);
  assert.equal(live.json.liveRev, report.rev);

  // An account id this instance has no ready account for is refused by the same reader.
  const other = await prepareReport(world.db);
  await updateReportColumns(world.db, other.id, { sender_account_id: "ma-8899aabbccddeeff" });
  const otherRun = addPreviewRun(world, other, "prv-2");
  const refused = await post(`${reportPath(other.id)}/go-live`, { previewRunId: otherRun });
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.json, {
    error: "sender_not_ready", message: "Choose a mail account that is ready to send.",
  });
  assert.equal((await getReport(world.db, other.id)).status, "draft");
});

test("pause then resume on an unchanged report goes back to live", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const runId = addPreviewRun(world, report);
  assert.equal((await post(`${reportPath(report.id)}/go-live`, { previewRunId: runId })).status, 200);

  const paused = await post(`${reportPath(report.id)}/pause`, {});
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.json.report.status, "paused");
  assert.equal(paused.json.report.live, false);

  const resumed = await post(`${reportPath(report.id)}/resume`, {});
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.report.status, "live");
  assert.equal(resumed.json.report.live, true);
  assert.equal(resumed.json.report.pause_reason, null);
});

/* ---------------------------------------------------------------------- the runs */

test("preview asks for a preview run, run-now needs a live report, and the list carries no gateway id", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);

  const preview = await post(`${reportPath(report.id)}/preview`, {});
  assert.equal(preview.status, 202, preview.text);
  assert.deepEqual(preview.json, { requested: true });
  assert.equal(preview.headers["cache-control"], "no-store");
  let requests = (await world.db.execute({ sql: "SELECT * FROM report_run_requests ORDER BY id", args: [] })).rows;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "preview");
  assert.equal(requests[0].requested_by, "owner");
  assert.equal(requests[0].report_id, report.id);

  // A draft may not run now: the answer says to go live again, and writes no request.
  const refused = await post(`${reportPath(report.id)}/run-now`, {});
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.json, { error: "go_live_needed", message: "Preview and go live again." });
  requests = (await world.db.execute({ sql: "SELECT * FROM report_run_requests", args: [] })).rows;
  assert.equal(requests.length, 1, "the refused run now wrote nothing");

  // Live: run now is accepted.
  const previewRunId = addPreviewRun(world, report);
  assert.equal((await post(`${reportPath(report.id)}/go-live`, { previewRunId })).status, 200);
  const runNow = await post(`${reportPath(report.id)}/run-now`, {});
  assert.equal(runNow.status, 202, runNow.text);
  assert.deepEqual(runNow.json, { requested: true });
  requests = (await world.db.execute({ sql: "SELECT * FROM report_run_requests ORDER BY id", args: [] })).rows;
  assert.deepEqual(requests.map((r) => r.kind), ["preview", "run_now"]);
  assert.equal(requests[1].requested_by, "owner");

  // A paused report may not run now either.
  assert.equal((await post(`${reportPath(report.id)}/pause`, {})).status, 200);
  const afterPause = await post(`${reportPath(report.id)}/run-now`, {});
  assert.equal(afterPause.status, 409);
  assert.equal(afterPause.json.error, "go_live_needed");

  // The runs list, newest first, without the gateway's own run id.
  await world.db.execute({
    sql: `INSERT INTO report_runs (id, report_id, "trigger", requested_by, status, gateway_run_id, created_at)
          VALUES ('rrn-0000000000000001', ?, 'manual', 'owner', 'ok', 'gateway-process-id', ?)`,
    args: [report.id, 1_700_000_000_000],
  });
  const listed = await get(`${reportPath(report.id)}/runs`);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.runs.length, 1);
  assert.equal(listed.json.runs[0].id, "rrn-0000000000000001");
  assert.equal(listed.json.runs[0].status, "ok");
  assert.equal(Object.hasOwn(listed.json.runs[0], "gatewayRunId"), false, "no process id in a list row");
  assert.equal(listed.text.includes("gateway-process-id"), false);
  assert.equal(listed.headers["cache-control"], "no-store");
});

test("the run routes 404 for a well-formed id that names no report", async () => {
  const world = await setup();
  const missing = `${REPORTS_API_PREFIX}/rpt-ffffffffffffffff`;
  for (const [method, suffix, body] of [
    ["POST", "/preview", {}],
    ["POST", "/run-now", {}],
    ["GET", "/runs", undefined],
  ]) {
    const r = await call(method, `${missing}${suffix}`, { body });
    assert.equal(r.status, 404, `${method} ${suffix}: ${r.status} ${r.text}`);
    assert.deepEqual(r.json, { error: "not_found", message: "Not found." });
  }
  const { rows } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM report_run_requests", args: [] });
  assert.equal(Number(rows[0].n), 0);
});

/* ------------------------------------------------------------------------ refusals */

test("a malformed id is a 404 on every route that takes one", async () => {
  const world = await setup();
  for (const id of ["not-a-report", "rpt-xyz", "rpt-0123456789abcde", "rpt-0123456789abcdef0"]) {
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      ["PUT", "/recipe", { recipe: RECIPE }],
      ["PUT", "/settings", { settings: { title: "Mine" } }],
      ["POST", "/go-live", { previewRunId: "prv-1" }],
      ["POST", "/pause", {}],
      ["POST", "/resume", {}],
      ["POST", "/preview", {}],
      ["POST", "/run-now", {}],
      ["GET", "/runs", undefined],
    ]) {
      const r = await call(method, `${REPORTS_API_PREFIX}/${id}${suffix}`, { body });
      assert.equal(r.status, 404, `${method} ${suffix} ${JSON.stringify(id)}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: "not_found", message: "Not found." });
    }
  }
  // A well-formed id that names no report is the same 404.
  const missing = await get(reportPath("rpt-ffffffffffffffff"));
  assert.equal(missing.status, 404);
});

test("the list needs a numeric project, and a bad body is a 400 with a fixed sentence", async () => {
  const world = await setup();
  for (const query of ["", "?project=", "?project=abc", "?project=-1", "?project=1.5", "?project=7&project=8"]) {
    const r = await get(`${REPORTS_API_PREFIX}${query}`);
    assert.equal(r.status, 400, `${query}: ${r.status} ${r.text}`);
    assert.deepEqual(r.json, { error: "bad_input", message: "That request is not valid." });
  }

  const bad = [
    {},
    { projectId: PROJECT },
    { projectId: "seven", title: "x" },
    { projectId: PROJECT, title: "" },
    { projectId: PROJECT, title: "x", botId: 7 },
  ];
  for (const body of bad) {
    const r = await post(REPORTS_API_PREFIX, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.status} ${r.text}`);
    assert.equal(r.json.error, "bad_input");
  }
  const { rows } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM reports", args: [] });
  assert.equal(Number(rows[0].n), 0, "nothing was created");
});

test("a failed go-live answers its own code and gets 409", async () => {
  const world = await setup();
  const report = await prepareReport(world.db, { schedule: false });
  addPreviewRun(world, report);
  const r = await post(`${reportPath(report.id)}/go-live`, { previewRunId: "prv-1" });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, {
    error: "no_schedule", message: "Choose when this report runs before going live.",
  });

  const stale = await prepareReport(world.db);
  addPreviewRun(world, stale, "prv-2", { recipeRev: stale.rev - 1 });
  const refused = await post(`${reportPath(stale.id)}/go-live`, { previewRunId: "prv-2" });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, "preview_stale");

  const none = await post(`${reportPath(stale.id)}/go-live`, {});
  assert.equal(none.status, 409);
  assert.equal(none.json.error, "preview_missing");
});

test("a bad recipe is a 400 from the save", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  for (const recipe of [{ blocks: "nope" }, { blocks: [{ nope: true }] }, "a string"]) {
    const r = await put(`${reportPath(report.id)}/recipe`, { recipe });
    assert.equal(r.status, 400, `${JSON.stringify(recipe)}: ${r.status} ${r.text}`);
    assert.deepEqual(r.json, { error: "bad_recipe", message: "That report recipe is not valid." });
  }
  const missingBody = await put(`${reportPath(report.id)}/recipe`, {});
  assert.equal(missingBody.status, 400);
  assert.equal(missingBody.json.error, "bad_input");
});

test("a settings write refuses an unknown key with 400", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  for (const settings of [{ live_seal: "x" }, { delivery_mode: "pigeon" }, { ai_commentary: "yes" }]) {
    const r = await put(`${reportPath(report.id)}/settings`, { settings });
    assert.equal(r.status, 400, `${JSON.stringify(settings)}: ${r.status} ${r.text}`);
    assert.equal(r.json.error, "bad_input");
  }
});

/* ------------------------------------------------------------------ the rails */

test("a write without the dashboard's CSRF token never reaches a reports route", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  addPreviewRun(world, report);
  const refused = [
    await post(REPORTS_API_PREFIX, { projectId: PROJECT, title: "Another" }, { csrf: null }),
    await put(`${reportPath(report.id)}/recipe`, { recipe: FREE_EDIT }, { csrf: null }),
    await post(`${reportPath(report.id)}/go-live`, { previewRunId: "prv-1" }, { csrf: null }),
    await post(`${reportPath(report.id)}/pause`, {}, { csrf: null }),
  ];
  for (const r of refused) {
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /CSRF/i, "the dashboard rail answers, not this router");
  }
  const rows = await getReport(world.db, report.id);
  assert.equal(rows.status, "draft");
  assert.equal(Number(rows.recipe_rev), report.rev);
});

test("no answer carries the live seal or the live nonce", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const runId = addPreviewRun(world, report);
  assert.equal((await post(`${reportPath(report.id)}/go-live`, { previewRunId: runId })).status, 200);
  const stored = await getReport(world.db, report.id);
  assert.match(stored.live_seal, /^[0-9a-f]{64}$/);
  assert.match(stored.live_nonce, /^[0-9a-f]{32}$/);

  for (const r of [
    await get(`${REPORTS_API_PREFIX}?project=${PROJECT}`),
    await get(reportPath(report.id)),
    await put(`${reportPath(report.id)}/recipe`, { recipe: FREE_EDIT }),
    await put(`${reportPath(report.id)}/settings`, { settings: { title: "Renamed" } }),
    await post(`${reportPath(report.id)}/pause`, {}),
    await post(`${reportPath(report.id)}/resume`, {}),
  ]) {
    assert.equal(r.text.includes(stored.live_seal), false, "no seal in an answer");
    assert.equal(r.text.includes(stored.live_nonce), false, "no nonce in an answer");
    assert.equal(r.text.includes("live_seal"), false, "no seal column in an answer");
    assert.equal(r.text.includes("live_nonce"), false, "no nonce column in an answer");
  }
});

test("an internal failure answers 500 with no message from the failure", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  // A database that refuses this table's writes: the route must not repeat the driver's text.
  await world.db.execute({ sql: "DROP TABLE report_approvals_audit", args: [] });
  const runId = addPreviewRun(world, report);
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  let r;
  try {
    r = await post(`${reportPath(report.id)}/go-live`, { previewRunId: runId });
  } finally {
    console.warn = original;
  }
  assert.equal(r.status, 500, r.text);
  assert.deepEqual(r.json, { error: "internal", message: "Something went wrong." });
  for (const text of [r.text, warnings.join("\n")]) {
    assert.equal(text.includes("report_approvals_audit"), false, "no table name");
    assert.equal(text.includes("no such table"), false, "no driver text");
  }
  assert.match(warnings.join("\n"), /go-live: /, "the log names the route and an error code");
});

test("a body over 256kb is refused as too large", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  assert.equal(world.opened.n, world.opened.closed, "the guard needed no client of its own");

  const big = JSON.stringify({ settings: { title: "Big" }, padding: "a".repeat(300 * 1024) });
  const r = await put(`${reportPath(report.id)}/settings`, big);
  assert.equal(r.status, 413, r.text);
  assert.deepEqual(r.json, { error: "too_large", message: "That request is too large." });

  // Malformed JSON under the limit is refused with a 400. The body is read by the gateway's global
  // parser here (that path is not in its `_hasOwnParser` list), so only the status is this router's to
  // promise; the router's own parser refuses it the same way when it is the one that reads it.
  const malformed = await put(`${reportPath(report.id)}/settings`, `{"settings": {`);
  assert.equal(malformed.status, 400, malformed.text);

  // The router's own byte guard is what refuses the over-size body: the gateway's global parser skips
  // no reports path, so a body it would have accepted can still be too large for this router.
  assert.equal(world.hasOwnParser(REPORTS_API_PREFIX), false,
    "index.js's own-parser list does not name reports yet; the byte guard covers that case");
});