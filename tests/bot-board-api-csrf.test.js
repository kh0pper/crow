/**
 * The Bot Board API mounts at the app root, before the dashboard router's
 * csrfMiddleware, so it runs the double-submit check itself: a session
 * request that changes state must echo the crow_csrf cookie as X-Crow-Csrf.
 * Every probe below fails validation BEFORE any DB access when the CSRF
 * check passes (400), so a 403 can only come from the CSRF rail.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "bot-board-api-csrf-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

let server, base;
before(async () => {
  const { default: express } = await import("express");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter((req, res, next) => next())); // auth stub
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/bot-board-api";
});
after(() => server && server.close());

const SESSION = "crow_session=s1; crow_csrf=tok123";
function post(path, body, headers = {}) {
  return fetch(base + path, { method: "POST",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const PROBES = [
  ["/card", { title: "" }],                       // create: title required
  ["/card/1", { priority: 9 }],                   // edit: priority 1-5
  ["/card/1/decision", { index: "x" }],           // answer: index must be an integer
  ["/card/1/move", { status: "" }],               // move: status required
];

test("a session POST without the CSRF header is refused 403 on every probed route", async () => {
  for (const [path, body] of PROBES) {
    const r = await post(path, body, { cookie: SESSION });
    assert.equal(r.status, 403, path);
    assert.match(await r.text(), /CSRF/);
  }
});

test("a session POST with a wrong token is refused 403", async () => {
  const r = await post("/card/1/decision", { index: "x" }, { cookie: SESSION, "x-crow-csrf": "nope" });
  assert.equal(r.status, 403);
});

test("a session POST carrying the matching X-Crow-Csrf reaches the route", async () => {
  for (const [path, body] of PROBES) {
    const r = await post(path, body, { cookie: SESSION, "x-crow-csrf": "tok123" });
    assert.equal(r.status, 400, path + " got past the CSRF rail to its own validation");
  }
});

test("reads need no token, and requests without a session cookie are left to auth (no CSRF refusal)", async () => {
  const g = await fetch(base + "/card/abc", { headers: { cookie: SESSION } });
  assert.equal(g.status, 400, "GET reaches the route (bad id)");
  const n = await post("/card", { title: "" });
  assert.equal(n.status, 400, "no session cookie: CSRF does not apply");
});
