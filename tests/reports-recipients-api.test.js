// The owner API's recipient and send-log routes: `/dashboard/api/reports/:id/recipients`,
// `.../:rid/approve|refuse|revoke`, `.../sends` and `.../runs/:runId/send-rest`.
//
// Harness: a real init-db'd scratch crow.db copied per test (CROW_DATA_DIR under a temp dir), an
// ephemeral express app wired the way servers/gateway/index.js + dashboard/index.js wire it (the real
// fetch-metadata gate, a session stub, the dashboard's real CSRF middleware, then the real reports API
// router), the real report store and approvals module with an injected seed and clock, real run rows
// through `startRun`, and the owner rule taken from the request's own classification
// (tests/helpers/off-box.js).
//
// Every request is shaped like the owner's own browser, because that is what the routes see in
// production: the SERVER-BOUND CSRF token for its own session (tests/helpers/csrf-token.mjs — the
// retired `crow_csrf` cookie is gone, and a made-up value is a 403) and same-origin fetch metadata
// (`Sec-Fetch-Site`, a matching `Origin`). Both gates pass, so the reports owner guard is what answers
// each request and the owner_only / no-data assertions below test it rather than a gate in front.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";
import { csrfTokenFor } from "./helpers/csrf-token.mjs";

const root = mkdtempSync(join(tmpdir(), "reports-recipients-api-"));
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
const { fetchMetadataGate } = await import("../servers/gateway/dashboard/fetch-metadata.js");
const { reportsApiRouter, REPORTS_API_PREFIX, OWNER_LABEL } = await import(
  "../servers/gateway/routes/reports-api.js"
);
const { createReport, saveRecipe, updateReportColumns } = await import(
  "../servers/gateway/reports/store.js"
);
const { listRecipients } = await import("../servers/gateway/reports/approvals.js");
const { startRun } = await import("../servers/gateway/reports/run.js");
const { SEND_LIST_LIMIT } = await import("../servers/gateway/reports/send-log.js");

const OWNER = "owner-local-password-session";
const SSO = "peer-sso-session";
const SEED = Buffer.alloc(32, 19);
const T0 = 1_700_000_000_000;
const PROJECT = 7;
const SENDER = "ma-0011223344556677";
const REGISTRY = { columns: { sourceBearing: false } };
const RECIPE = { blocks: [{ id: "b1", type: "columns", settings: { columns: ["subject"] } }] };
const RUN_ID = "rrn-00000000000000a1";

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

/** One request, shaped like a page of this origin making it. The cookie carries the session and
 *  nothing else (the CSRF token is server-bound: HMAC(secret, session), delivered to the page, never a
 *  cookie); `X-Crow-Csrf` echoes that token for THIS session — `csrf: true` (the default) computes it
 *  through the real module, a string sends that value instead, `null` sends none; and the fetch
 *  metadata names this origin (`Sec-Fetch-Site: same-origin`, `Origin` = the URL asked on), which is
 *  what a browser on the dashboard sends and what the fetch-metadata gate admits. `token: null` sends
 *  no session cookie; `laptop: false` leaves the request classified as coming from this machine. */
function call(method, path, { body, headers = {}, token = OWNER, csrf = true, laptop = true } = {}) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const h = {
    ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
    origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  if (token) h.cookie = "crow_session=" + token;
  if (token && csrf) h["x-crow-csrf"] = csrf === true ? csrfTokenFor(token) : String(csrf);
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

const reportPath = (id) => `${REPORTS_API_PREFIX}/${encodeURIComponent(id)}`;

/* ------------------------------------------------------------------------- setup */

let n = 0;

async function setup({ ownerCheck = undefined } = {}) {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
  const db = createDbClient(crow);
  open.push(db);

  const openDb = () => createDbClient(crow);
  const approvalsDeps = {
    loadSeed: () => ({ seed: SEED }),
    now: () => T0,
    registry: REGISTRY,
    getRun: async () => null,
    senderReady: async () => true,
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const sessionGate = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).crow_session;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = token;
    if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
    next();
  };
  const dash = express.Router();
  // index.js mounts the fetch-metadata gate app-wide, before the routers: a request a browser wrote on
  // another site is refused there and never reaches csrfMiddleware or the reports owner guard.
  dash.use(fetchMetadataGate({ log: () => {} }));
  dash.use("/dashboard", csrfMiddleware);
  dash.use(reportsApiRouter(sessionGate, {
    openDb,
    approvalsDeps,
    ...(ownerCheck === undefined ? {} : { ownerCheck }),
  }));
  app.use(dash);

  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(server);
  return { db, crow };
}

/** A saved report with a schedule row and a sender, the way the report page leaves one. */
async function prepareReport(db, { title = "Weekly listings" } = {}) {
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', '0 7 * * 1', 'Europe/Berlin')",
    args: [],
  });
  const { rows } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  const scheduleId = Number(rows[0].id);
  const { id } = await createReport(db, { projectId: PROJECT, owner: OWNER_LABEL, botId: "bot-1", title });
  const saved = await saveRecipe(db, { reportId: id, recipe: RECIPE, authorKind: "owner", registry: REGISTRY });
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

/** A real run row of one report, finished unless a test asks for another state, so "Send to the rest"
 *  has a run to send to. */
async function runFor(db, reportId, { trigger = "manual", status = "ok" } = {}) {
  const { runId } = await startRun(db, { now: () => T0 }, {
    reportId, trigger, requestedBy: trigger === "manual" ? "owner" : "schedule",
    ...(trigger === "schedule" ? { scheduledFor: T0 } : {}),
  });
  await db.execute({
    sql: "UPDATE report_runs SET status = ?, ended_at = ? WHERE id = ?",
    args: [status, T0, runId],
  });
  return runId;
}

const addRecipient = (id, body = { address: "alex@example.com" }) => post(`${reportPath(id)}/recipients`, body);

/** Every response of a test's world must be free of the seal and its nonce. */
function assertNoSeal(r, label) {
  assert.equal(r.text.includes("approval_seal"), false, `${label}: no seal field`);
  assert.equal(r.text.includes("approval_nonce"), false, `${label}: no nonce field`);
  assert.equal(r.text.includes("approvalSeal"), false, `${label}: no seal field`);
  assert.equal(r.text.includes("approvalNonce"), false, `${label}: no nonce field`);
  const visit = (value) => {
    if (value == null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      assert.notEqual(key, "approval_seal", `${label}: no seal key`);
      assert.notEqual(key, "approval_nonce", `${label}: no nonce key`);
      assert.notEqual(key, "seal", `${label}: no seal key`);
      assert.notEqual(key, "nonce", `${label}: no nonce key`);
      visit(inner);
    }
  };
  visit(r.json);
}

/* ------------------------------------------------------------------ the owner rail */

test("a non-owner session is 403 owner_only on every recipient and send route, with no data", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const runId = await runFor(world.db, report.id);
  const rid = "rrc-00000000000000aa";
  const routes = [
    ["GET", `${reportPath(report.id)}/recipients`, undefined],
    ["POST", `${reportPath(report.id)}/recipients`, { address: "alex@example.com" }],
    ["POST", `${reportPath(report.id)}/recipients/${rid}/approve`, {}],
    ["POST", `${reportPath(report.id)}/recipients/${rid}/refuse`, {}],
    ["POST", `${reportPath(report.id)}/recipients/${rid}/revoke`, {}],
    ["GET", `${reportPath(report.id)}/sends?run=${runId}`, undefined],
    ["POST", `${reportPath(report.id)}/runs/${runId}/send-rest`, {}],
  ];
  for (const [label, opts] of [
    ["a peer's single-sign-on session", { token: SSO }],
    ["a request from this machine", { token: OWNER, laptop: false }],
  ]) {
    for (const [method, path, body] of routes) {
      const r = await call(method, path, { body, ...opts });
      assert.equal(r.status, 403, `${label} ${method} ${path}: ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: "owner_only", message: "Only the owner can see this." });
      assert.equal(r.text.includes("alex@example.com"), false, `${label} ${method} ${path}: no address`);
      assert.equal(r.text.includes(report.id), false, `${label} ${method} ${path}: no id`);
    }
  }
  const { rows: recipients } = await world.db.execute({
    sql: "SELECT COUNT(*) AS n FROM report_recipients", args: [],
  });
  assert.equal(Number(recipients[0].n), 0, "nothing was added");
  const { rows: sends } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM report_sends", args: [] });
  assert.equal(Number(sends[0].n), 0, "and no send row was written");
});

test("an owner check that throws is a 403 on the new routes too", async () => {
  const world = await setup({ ownerCheck: async () => { throw new Error("database is locked (crow.db)"); } });
  const report = await prepareReport(world.db);
  const r = await get(`${reportPath(report.id)}/recipients`);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.text.includes("database is locked"), false);
});

/* ------------------------------------------------------------------------- the add */

test("an owner add is a propose and an approve in one tap", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);

  const added = await addRecipient(report.id, {
    address: "Alex@Example.com", displayName: "Alex", commentTier: "a",
  });
  assert.equal(added.status, 201, added.text);
  const recipient = added.json.recipient;
  assert.match(recipient.id, /^rrc-[0-9a-f]{16}$/);
  assert.equal(recipient.reportId, report.id);
  assert.equal(recipient.address, "alex@example.com", "lower-cased, the unique key");
  assert.equal(recipient.displayName, "Alex");
  assert.equal(recipient.commentTier, "a");
  assert.equal(recipient.state, "approved", "the owner's one tap approves it");
  assert.equal(recipient.proposedBy, "owner");
  assert.equal(Number.isFinite(recipient.approvedAt), true);
  assertNoSeal(added, "the add");

  const raw = (await world.db.execute({
    sql: "SELECT * FROM report_recipients WHERE id = ?", args: [recipient.id],
  })).rows[0];
  assert.ok(raw.approval_seal, "the row really carries a seal");
  assert.ok(raw.approval_nonce, "and its nonce");

  const listed = await get(`${reportPath(report.id)}/recipients`);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.recipients.length, 1);
  assert.equal(listed.json.recipients[0].id, recipient.id);
  assert.equal(listed.json.recipients[0].verified, true, "the approval still verifies");
  assertNoSeal(listed, "the list");

  // The same address again answers the same row instead of a second one.
  const again = await addRecipient(report.id, { address: "alex@example.com" });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.json.recipient.id, recipient.id);
  assert.equal((await listRecipients(world.db, report.id)).length, 1);
});

test("a malformed address is 400 bad_input and writes nothing", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  for (const address of ["", "not-an-address", "two@example.com, three@example.com", "a b@example.com"]) {
    const r = await addRecipient(report.id, { address });
    assert.equal(r.status, 400, `${JSON.stringify(address)}: ${r.status} ${r.text}`);
    assert.equal(r.json.error, "bad_input");
  }
  assert.equal((await listRecipients(world.db, report.id)).length, 0);
});

test("a report that does not exist is 404 on the recipient and send routes", async () => {
  const world = await setup();
  const missing = "rpt-ffffffffffffffff";
  assert.equal((await addRecipient(missing, { address: "alex@example.com" })).status, 404);
  assert.equal((await get(`${reportPath(missing)}/recipients`)).status, 404);
  assert.equal((await get(`${reportPath(missing)}/sends`)).status, 404);
  assert.equal((await post(`${reportPath(missing)}/runs/${RUN_ID}/send-rest`, {})).status, 404);
});

/* -------------------------------------------------------------- approve, refuse, revoke */

test("approve, refuse and revoke move the state, and the list shows it", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const added = await addRecipient(report.id);
  const rid = added.json.recipient.id;
  const decide = (action) => post(`${reportPath(report.id)}/recipients/${rid}/${action}`, {});

  const refused = await decide("refuse");
  assert.equal(refused.status, 200, refused.text);
  assert.equal(refused.json.recipient.state, "refused");
  assert.equal(refused.json.recipient.approvedAt, null);
  assertNoSeal(refused, "refuse");
  let raw = (await world.db.execute({
    sql: "SELECT approval_seal, approval_nonce FROM report_recipients WHERE id = ?", args: [rid],
  })).rows[0];
  assert.equal(raw.approval_seal, null, "a refusal nulls the seal");
  assert.equal(raw.approval_nonce, null, "and its nonce");

  const approved = await decide("approve");
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.recipient.state, "approved");
  raw = (await world.db.execute({
    sql: "SELECT approval_seal FROM report_recipients WHERE id = ?", args: [rid],
  })).rows[0];
  assert.ok(raw.approval_seal, "a fresh approval seals the row again");

  const revoked = await decide("revoke");
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.recipient.state, "revoked");
  raw = (await world.db.execute({
    sql: "SELECT approval_seal, approval_nonce FROM report_recipients WHERE id = ?", args: [rid],
  })).rows[0];
  assert.equal(raw.approval_seal, null, "a revocation nulls the seal");
  assert.equal(raw.approval_nonce, null);

  const listed = await get(`${reportPath(report.id)}/recipients`);
  assert.deepEqual(listed.json.recipients.map((row) => row.state), ["revoked"]);
  assert.deepEqual(listed.json.recipients.map((row) => row.verified), [false],
    "a revoked row's state word never reads as an approval");
  assertNoSeal(listed, "the list after the decisions");
});

test("the list says verified false for an approved row whose seal no longer matches", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const added = await addRecipient(report.id, { address: "alex@example.com", commentTier: "a" });
  const before = await get(`${reportPath(report.id)}/recipients`);
  assert.equal(before.json.recipients[0].verified, true);

  // The tier moved under the seal: the row still says approved, and the list says it is not.
  await world.db.execute({
    sql: "UPDATE report_recipients SET comment_tier = 'b' WHERE id = ?", args: [added.json.recipient.id],
  });
  const after = await get(`${reportPath(report.id)}/recipients`);
  assert.equal(after.json.recipients[0].state, "approved");
  assert.equal(after.json.recipients[0].verified, false);
  assertNoSeal(after, "the list after a direct write");
});

test("a recipient id of another report, or a malformed one, is 404", async () => {
  const world = await setup();
  const mine = await prepareReport(world.db);
  const other = await prepareReport(world.db, { title: "Another report" });
  const otherRecipient = await addRecipient(other.id);
  const rid = otherRecipient.json.recipient.id;

  for (const action of ["approve", "refuse", "revoke"]) {
    const r = await post(`${reportPath(mine.id)}/recipients/${rid}/${action}`, {});
    assert.equal(r.status, 404, `${action} across reports: ${r.status} ${r.text}`);
    assert.deepEqual(r.json, { error: "not_found", message: "Not found." });
  }
  for (const bad of ["rrc-123", "rrc-zzzzzzzzzzzzzzzz", "not-a-recipient", "rrc-00000000000000"]) {
    for (const action of ["approve", "refuse", "revoke"]) {
      const r = await post(`${reportPath(mine.id)}/recipients/${bad}/${action}`, {});
      assert.equal(r.status, 404, `${bad} ${action}: ${r.status} ${r.text}`);
    }
  }
  // The other report's recipient was never moved by any of it.
  const listed = await get(`${reportPath(other.id)}/recipients`);
  assert.equal(listed.json.recipients[0].state, "approved");
});

/* ------------------------------------------------------------------- the send log */

test("the send log answers one report's rows and one run's, bounded to 200, without the claim bookkeeping", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const runId = await runFor(world.db, report.id);
  const otherRun = await runFor(world.db, report.id);

  const insert = (index, run) => world.db.execute({
    sql: `INSERT INTO report_sends
            (id, run_id, report_id, recipient_id, attempt, account_id, status, claim_token,
             gateway_run_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, 'sent', ?, 'gw-old', ?, ?)`,
    args: [
      `rsd-${index.toString(16).padStart(16, "0")}`, run, report.id,
      `rrc-${index.toString(16).padStart(16, "0")}`, SENDER, "d".repeat(32), T0 + index, T0 + index,
    ],
  });
  for (let i = 1; i <= SEND_LIST_LIMIT + 10; i += 1) await insert(i, runId);
  await insert(9999, otherRun);

  const one = await get(`${reportPath(report.id)}/sends?run=${runId}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.sends.length, SEND_LIST_LIMIT, "bounded to 200 rows");
  for (const row of one.json.sends) {
    assert.equal(row.runId, runId);
    assert.equal("claim_token" in row, false);
    assert.equal("claimToken" in row, false);
    assert.equal("gateway_run_id" in row, false);
    assert.equal("gatewayRunId" in row, false);
  }
  assert.equal(one.text.includes("d".repeat(32)), false, "no claim token left the route");

  const all = await get(`${reportPath(report.id)}/sends`);
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.sends.length, SEND_LIST_LIMIT, "every run's rows, still bounded");

  const bad = await get(`${reportPath(report.id)}/sends?run=not-a-run`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "bad_input");
});

/* ---------------------------------------------------------------- send to the rest */

test("send to the rest creates pending rows for the approved recipients and sends nothing", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  const runId = await runFor(world.db, report.id);
  const first = await addRecipient(report.id, { address: "alex@example.com" });
  await addRecipient(report.id, { address: "second@example.com" });
  // One recipient already has a row for this run, so the rest is the other one.
  await world.db.execute({
    sql: `INSERT INTO report_sends (id, run_id, report_id, recipient_id, attempt, status, created_at, updated_at)
          VALUES ('rsd-0000000000000001', ?, ?, ?, 1, 'sent', ?, ?)`,
    args: [runId, report.id, first.json.recipient.id, T0, T0],
  });

  const r = await post(`${reportPath(report.id)}/runs/${runId}/send-rest`, {});
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.created.length, 1, "one recipient was left to send to");
  assert.deepEqual(r.json.skipped, [
    { recipientId: first.json.recipient.id, reason: "sent" },
  ]);

  const { rows } = await world.db.execute({
    sql: "SELECT * FROM report_sends WHERE run_id = ? ORDER BY status", args: [runId],
  });
  assert.equal(rows.length, 2);
  const added = rows.find((row) => row.id === r.json.created[0]);
  assert.equal(added.status, "pending", "only a row, waiting for delivery");
  assert.equal(added.claim_token, null);
  assert.equal(added.message_id, null);
  assert.equal(added.account_id, SENDER, "the report's own sender account");
  assert.equal(added.attempt, 1);
  assert.equal(rows.some((row) => row.status === "sending" || row.status === "unknown"), false,
    "nothing was attempted");

  // A second tap changes nothing: the rows it wrote are already pending.
  const again = await post(`${reportPath(report.id)}/runs/${runId}/send-rest`, {});
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.created, []);
  assert.equal(again.json.skipped.length, 2);
  const { rows: after } = await world.db.execute({
    sql: "SELECT COUNT(*) AS n FROM report_sends WHERE run_id = ?", args: [runId],
  });
  assert.equal(Number(after[0].n), 2, "no second set of rows");
});

test("send to the rest on a preview run or an unfinished run is 409, and writes no row", async () => {
  const world = await setup();
  const report = await prepareReport(world.db);
  await addRecipient(report.id);
  const previewRun = await runFor(world.db, report.id, { trigger: "preview" });
  const queuedRun = await runFor(world.db, report.id, { status: "queued" });

  for (const [label, runId] of [["preview", previewRun], ["queued", queuedRun]]) {
    const r = await post(`${reportPath(report.id)}/runs/${runId}/send-rest`, {});
    assert.equal(r.status, 409, `${label}: ${r.status} ${r.text}`);
    assert.equal(r.json.error, "conflict", label);
  }
  const { rows } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM report_sends", args: [] });
  assert.equal(Number(rows[0].n), 0, "no row was written by either");
});

test("send to the rest on a run of another report, or a malformed run id, is 404", async () => {
  const world = await setup();
  const mine = await prepareReport(world.db);
  const other = await prepareReport(world.db, { title: "Another report" });
  await addRecipient(mine.id);
  const otherRun = await runFor(world.db, other.id);

  const crossed = await post(`${reportPath(mine.id)}/runs/${otherRun}/send-rest`, {});
  assert.equal(crossed.status, 404, crossed.text);
  assert.deepEqual(crossed.json, { error: "not_found", message: "Not found." });

  for (const bad of ["rrn-123", "not-a-run", "rrn-zzzzzzzzzzzzzzzz"]) {
    const r = await post(`${reportPath(mine.id)}/runs/${bad}/send-rest`, {});
    assert.equal(r.status, 404, `${bad}: ${r.status} ${r.text}`);
  }
  const { rows } = await world.db.execute({ sql: "SELECT COUNT(*) AS n FROM report_sends", args: [] });
  assert.equal(Number(rows[0].n), 0, "no row was written by any of them");
});