/**
 * The credential canary (credential card spec §10.3 item 1): a random 32-character value goes
 * through every path a secret can take, then the console, the engine frames, what the model
 * would see, the crow.db bytes, the audit/notification/session-file tables and every file under
 * the scratch home are grepped for it. Zero hits is the pass. The one by-design copy, the
 * masking values file `secrets/pi-bot-secret-values`, is allowlisted by the harness.
 *
 * Cases that need a later task are `todo` (they still run, so their state is visible) and are
 * flipped to live by that task:
 *   (a) the keychain card submit                               → Task 3
 *   (b) a composer /message and /steer with the canary pasted   → Task 4
 *   (c) a malformed-JSON body: /message, /steer and other global-parser routes (LIVE now),
 *       the submit route → Task 3
 *   (d) the services connect submit with the canary as a value  (LIVE now: the route exists;
 *       Task 4 adds the Connect card's own case)
 *
 * Harness: tests/fixtures/credential-canary.mjs (its header lists the sinks and the API).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCanaryHarness, makeCanary } from "./fixtures/credential-canary.mjs";

let h;
before(async () => { h = await createCanaryHarness(); });
after(async () => { if (h) await h.close(); });

const show = (hits) => JSON.stringify(hits, null, 1);

// ---------------------------------------------------------------------------
// The harness can see a leak (so a zero-hit pass is not vacuous)
// ---------------------------------------------------------------------------

test("harness: a canary planted in each sink is found there, and the allowlist is exact", async () => {
  const c = makeCanary();
  assert.equal(c.length, 32);
  assert.match(c, /[A-Z]/); assert.match(c, /[a-z]/); assert.match(c, /[0-9]/);
  assert.deepEqual(await h.grepEverywhere(c), [], "clean before anything is planted");

  console.error("oops " + c);
  const s = await h.spawnSession("plant-bot");
  // Straight into the engine, past the route (a later task's strip must not hide the plant).
  await h.engine.message(s.sessionId, "plant " + c);
  await h.endTurn("echo " + c);
  await h.db.execute({ sql: "INSERT INTO notifications (title, body) VALUES (?, ?)", args: ["t", c] });
  mkdirSync(join(h.crowHome, "secrets"), { recursive: true });
  writeFileSync(join(h.crowHome, "secrets", "pi-bot-secret-values"), c + "\n");
  writeFileSync(join(h.crowHome, "secrets", "pi-bot-secret-values.bak"), c + "\n");

  const hits = await h.grepEverywhere(c);
  const sinks = new Set(hits.map((x) => x.sink));
  for (const sink of ["console", "frames", "model", "tables", "db-bytes", "files"]) {
    assert.ok(sinks.has(sink), `the ${sink} sink must see a planted canary: ${show(hits)}`);
  }
  assert.ok(hits.some((x) => x.path === "secrets/pi-bot-secret-values.bak"), "only the exact masking file is allowlisted");
  assert.ok(!hits.some((x) => x.path === "secrets/pi-bot-secret-values"), "the masking file itself is allowlisted");
  assert.ok((await h.grepEverywhere(c, { allow: [() => true] })).length === 0, "allow predicates filter hits");

  // A 10-character piece of a secret is a leak too (what a JSON.parse message quotes).
  const c2 = makeCanary();
  assert.deepEqual(await h.grepEverywhere(c2), []);
  console.warn('Unexpected token, ..."' + c2.slice(7, 17) + '"... is not valid JSON');
  assert.deepEqual((await h.grepEverywhere(c2)).map((x) => x.sink), ["console"]);
});

// ---------------------------------------------------------------------------
// (c) malformed JSON — the /message case is live now
// ---------------------------------------------------------------------------

test("(c) a malformed-JSON /message body holding the canary: fixed answer, fixed log line, zero hits", async () => {
  const c = makeCanary();
  const s = await h.spawnSession("malformed-bot");
  const before = h.console.lines.length;
  const r = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, `{"message": ${c}}`);
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "bad_body" });
  const logged = h.console.lines.slice(before);
  assert.ok(logged.includes("[perch-interactive-api] bad body"), "one fixed line: " + JSON.stringify(logged));
  assert.equal(h.pi().turns.length, 0, "the engine never saw it");
  assert.deepEqual(await h.grepEverywhere(c), [], "zero hits");
});

test("(c) an oversized /message body answers a fixed too_large and logs no body text", async () => {
  const c = makeCanary();
  const s = await h.spawnSession("big-bot");
  const r = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, JSON.stringify({ message: c + "x".repeat(10 * 1024 * 1024) }));
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: "too_large" });
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("(c) a malformed-JSON body to the secret submit route", { todo: "Task 3: the submit route" }, async () => {
  const c = makeCanary();
  const { default: secretSubmitRouter } = await import("../servers/gateway/routes/secret-submit.js");
  h.mountDashboard(secretSubmitRouter(h.sessionGate));
  const r = await h.post("/dashboard/perch-api/secret/" + "0".repeat(32), `{"value": ${c}}`);
  assert.equal(r.status, 400);
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("(c) a malformed-JSON /steer body holding the canary (the global parser): fixed answer, fixed line, zero hits", async () => {
  const c = makeCanary();
  const s = await h.spawnSession("steer-malformed-bot");
  const before = h.console.lines.length;
  const r = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/steer`, `{"message": ${c}}`);
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "bad_body" });
  assert.deepEqual(h.console.lines.slice(before), ["[gateway] bad body"]);
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("(c) other routes on the global parser: an ask /answer and an unrouted path answer bad_body with zero hits", async () => {
  const c = makeCanary();
  const s = await h.spawnSession("answer-malformed-bot");
  for (const path of [`/dashboard/perch-api/interactive/${s.sessionId}/answer`, "/api/no-such-route"]) {
    const r = await h.post(path, `{"value": ${c}}`);
    assert.equal(r.status, 400, path);
    assert.deepEqual(r.json, { error: "bad_body" }, path);
  }
  const big = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/answer`, JSON.stringify({ value: c + "x".repeat(1024 * 1024) }));
  assert.equal(big.status, 413);
  assert.deepEqual(big.json, { error: "bad_body" });
  assert.equal(h.pi().sent.length, 0, "nothing reached pi");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

// ---------------------------------------------------------------------------
// (a) the keychain card submit
// ---------------------------------------------------------------------------

test("(a) the keychain card submit: the bot gets the name, the sealed row decrypts to the canary, zero hits", { todo: "Task 3: card, submit route and engine hook" }, async () => {
  const c = makeCanary();
  const store = await import("../servers/gateway/secrets/request-store.js");
  const { default: secretSubmitRouter } = await import("../servers/gateway/routes/secret-submit.js");
  h.mountDashboard(secretSubmitRouter(h.sessionGate));
  const s = await h.spawnSession("keychain-bot");
  const { id } = store.createSecretRequest({ sessionId: s.sessionId, threadId: s.threadId, botId: "keychain-bot", kind: "password", target: "keychain", label: "Canary site" });
  const r = await h.post("/dashboard/perch-api/secret/" + id, { value: c });
  assert.equal(r.status, 200);
  const rows = await h.keychainRows();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0]).includes(c), "the row holds no plaintext");
  assert.equal(await h.openKeychain(rows[0].id), c, "the sealed row decrypts to the canary");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

// ---------------------------------------------------------------------------
// (b) the composer, a pasted canary with no override
// ---------------------------------------------------------------------------

test("(b) a composer /message with the canary pasted reaches the model as [secret removed]", { todo: "Task 4: the server-side strip" }, async () => {
  const c = makeCanary();
  const s = await h.spawnSession("paste-bot");
  const r = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: `my password: ${c} thanks` });
  assert.equal(r.status, 202);
  assert.match(h.pi().lastTurn().message, /\[secret removed\]/);
  await h.endTurn("noted");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

test("(b) a composer /steer with the canary pasted reaches the model as [secret removed]", { todo: "Task 4: the server-side strip on /steer" }, async () => {
  const c = makeCanary();
  const s = await h.spawnSession("steer-bot");
  assert.equal((await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "start" })).status, 202);
  const r = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/steer`, { message: `use ${c} instead` });
  assert.equal(r.status, 200);
  await h.endTurn("ok");
  assert.deepEqual(await h.grepEverywhere(c), []);
});

// ---------------------------------------------------------------------------
// (d) the services connect submit
// ---------------------------------------------------------------------------

// Live already: the Services connect route (PR 2) keeps its own parser and fixed error handler.
// Task 4's Connect card opens this same sheet and route, so its case adds to this one.
test("(d) the services connect submit with the canary as a value", async () => {
  const c = makeCanary();
  const r = await h.post("/dashboard/services/api/project/home/connect", { serviceId: "github", accountLabel: "Canary", values: { GITHUB_PERSONAL_ACCESS_TOKEN: c } });
  assert.equal(r.status, 201, r.text);
  const rows = await h.keychainRows();
  const row = rows.find((x) => x.kind === "service");
  assert.ok(row, "a sealed service row");
  assert.equal(await h.openKeychain(row.id), c);
  assert.deepEqual(await h.grepEverywhere(c), []);
  // A malformed connect body holding the canary is refused with the fixed class.
  const c2 = makeCanary();
  const bad = await h.post("/dashboard/services/api/project/home/connect", `{"values": ${c2}}`);
  assert.equal(bad.status, 400);
  assert.deepEqual(await h.grepEverywhere(c2), []);
});

// ---------------------------------------------------------------------------
// The Perch router's handler for errors that are not body errors
// ---------------------------------------------------------------------------

test("perch router: a non-body error keeps its own status (500 otherwise) and logs name, method and route, never the message", async () => {
  const { default: express } = await import("express");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const c = makeCanary();
  let nextErr = null;
  const gate = (req, res, next) => next(nextErr);
  const app = express();
  app.use(perchInteractiveApiRouter(gate, { engine: () => h.engine, annotate: async (m) => m, providerModels: () => [], piProviders: () => null }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/dashboard/perch-api`;
  try {
    for (const [err, status, code] of [
      [Object.assign(new TypeError("leaked " + c), { status: 503 }), 503, "internal"],
      [Object.assign(new RangeError("leaked " + c), { statusCode: 418 }), 418, "request_failed"],
      [new Error("leaked " + c), 500, "internal"],
      [Object.assign(new Error("leaked " + c), { status: 302 }), 500, "internal"],
    ]) {
      nextErr = err;
      const before = h.console.lines.length;
      const r = await fetch(base + "/browse?path=" + c);
      assert.equal(r.status, status, err.name);
      assert.deepEqual(await r.json(), { error: code });
      assert.deepEqual(h.console.lines.slice(before), [`[perch-interactive-api] request failed: ${err.name} GET /dashboard/perch-api/browse`]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(await h.grepEverywhere(c), []);
});
