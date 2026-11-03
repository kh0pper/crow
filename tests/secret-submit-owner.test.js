/**
 * Credential card fix wave A1: the submit route and the open-card GET are the OWNER's alone.
 *
 * The rule is the Services routes' (review I1): read the real isLocalPasswordSessionOn, so a
 * peer SSO session, a session minted by a login on this machine and a request from this machine
 * are each refused with 403 {error:"not_owner"} — before anything is read — and the open request
 * is left alone. An owner's password session from another machine reaches both handlers.
 *
 * Harness: a scratch init-db'd crow.db (CROW_DATA_DIR / CROW_HOME), a stub session gate that
 * names the session cookie (the real rule does the deciding) and markFromLaptop for the origin
 * half, exactly as tests/services-api.test.js drives the Private switch.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "crow-secret-owner-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(process.env.CROW_DATA_DIR, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const REPO = new URL("..", import.meta.url).pathname;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: process.env.CROW_DATA_DIR }, stdio: "pipe", cwd: REPO });

const { createDbClient } = await import("../servers/db.js");
const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
const { default: secretSubmitRouter } = await import("../servers/gateway/routes/secret-submit.js");
const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
const store = await import("../servers/gateway/secrets/request-store.js");
const { markFromLaptop } = await import("./helpers/off-box.js");

const DB_FILE = join(process.env.CROW_DATA_DIR, "crow.db");
const db = createDbClient(DB_FILE);
const SID = "perchlive-aaaaaaaa";

let server, base, id;

/**
 * The session gate: the cookie names the session (the real rule decides whether it is the
 * owner's), "none" is an authenticated request that carries no dashboard session at all, and
 * x-test-from: laptop makes it come from another machine.
 */
const gate = (req, res, next) => {
  const m = /crow_session=([\w-]+)/.exec(String(req.headers.cookie || ""));
  if (m && m[1] !== "none") req.dashboardSession = m[1];
  if (req.headers["x-test-from"] === "laptop") markFromLaptop(req);
  next();
};

before(async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  for (const [tok, scopes] of [["own-1", "dashboard"], ["sso-1", "dashboard sso src:peer-1"], ["onhost-1", "dashboard onhost"]]) {
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
      args: [hashToken(tok), scopes, future],
    });
  }
  const app = express();
  // The gateway's global parser skips the submit path (index.js _hasOwnParser): none here.
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(secretSubmitRouter(gate, { dbFactory: () => createDbClient(DB_FILE), crowHome: HOME }));
  dash.use(perchInteractiveApiRouter(gate, { engine: () => ({}) }));
  app.use(dash);
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/dashboard`;
});

after(async () => {
  try { db.close(); } catch { /* closed */ }
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

beforeEach(() => {
  store._resetSecretStoreForTest();
  ({ id } = store.createSecretRequest({ sessionId: SID, threadId: SID, botId: "bot-a", kind: "password", target: "keychain", label: "Example site" }));
});

const as = (tok, { laptop = true } = {}) => ({ cookie: `crow_session=${tok}; crow_csrf=tok9`, "x-crow-csrf": "tok9", ...(laptop ? { "x-test-from": "laptop" } : {}) });
const submitPath = () => `/secret/${id}?sid=${encodeURIComponent(SID)}`;
const openPath = `/perch-api/interactive/${SID}/secret`;

/** POST the submit body with JSON, returning {status, text, json}. */
function submit(headers, body = { value: "" }) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path: "/dashboard/perch-api" + submitPath(), method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function getOpen(headers) {
  const res = await fetch(base + openPath, { headers });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

test("the owner reaches both handlers", async () => {
  const open = await getOpen(as("own-1"));
  assert.equal(open.status, 200);
  assert.equal(open.json.id, id, "the owner's GET returns the open card");
  const r = await submit(as("own-1"));
  assert.equal(r.status, 400, "the handler ran");
  assert.deepEqual(r.json, { error: "bad_value" });
  assert.ok(store.getSecretRequest(id), "a bad value never burns the request");
});

test("an SSO session, an on-machine login and a sessionless request are refused with 403 not_owner on both routes, and the request stays open", async () => {
  for (const [label, headers] of [
    ["peer SSO", as("sso-1")],
    ["login on this machine", as("onhost-1")],
    ["owner session from this machine", as("own-1", { laptop: false })],
    ["no session", { "x-crow-csrf": "tok9", "x-test-from": "laptop" }],
  ]) {
    const open = await getOpen(headers);
    assert.equal(open.status, 403, `${label} GET: ${open.text}`);
    assert.deepEqual(open.json, { error: "not_owner" }, label);
    const r = await submit(headers);
    assert.equal(r.status, 403, `${label} POST: ${r.text}`);
    assert.deepEqual(r.json, { error: "not_owner" }, label);
    assert.ok(store.getSecretRequest(id), `${label}: the request is untouched`);
  }
});

test("a request with no session at all never reaches either handler once the gate refuses it", async () => {
  // The real dashboardAuth answers 401 before either route; this is that gate, in one line.
  const strict = express();
  strict.use("/dashboard", csrfMiddleware);
  strict.use(secretSubmitRouter((req, res, next) => (req.headers.cookie ? next() : res.status(401).json({ error: "unauthorized" })), {
    dbFactory: () => createDbClient(DB_FILE),
    crowHome: HOME,
  }));
  strict.use(perchInteractiveApiRouter((req, res, next) => (req.headers.cookie ? next() : res.status(401).json({ error: "unauthorized" })), { engine: () => ({}) }));
  const s = await new Promise((r) => { const x = strict.listen(0, "127.0.0.1", () => r(x)); });
  try {
    const p = `http://127.0.0.1:${s.address().port}`;
    for (const [method, path] of [["GET", openPath], ["POST", "/perch-api" + submitPath()]]) {
      const res = await fetch(p + "/dashboard" + path, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  assert.ok(store.getSecretRequest(id));
});