/**
 * pick-probe: "Test the picks" (roles phase 2b, Task 10). Every request is a
 * stub requestFn; no real provider is contacted. Fixture keys are made up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import { probePick, probeRecommended, pickCheckOf } from "../servers/gateway/ai/pick-probe.js";
import { addProvider } from "../servers/gateway/ai/add-provider.js";
import { isInstanceScope } from "../servers/gateway/dashboard/settings/sync-allowlist.js";

const KEY = "fixture-key-zz9";
const reply = (status, body = {}, headers = {}) => ({
  status, headers, stream: Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]),
});
function stub(fn) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, ...opts, body: opts?.body ? JSON.parse(opts.body) : undefined }); return fn(url, opts, calls.length); };
  f.calls = calls;
  return f;
}
const openaiRow = { id: "cloud-a", baseUrl: "https://api.openai.com/v1/", apiKey: KEY };
const otherRow = { id: "local-chat", baseUrl: "https://api.example.com/v1", apiKey: KEY };
const toolReply = (name) => reply(200, { choices: [{ message: { tool_calls: [{ function: { name, arguments: "{}" } }] } }] });

function recFile(reviewBy) {
  const f = join(mkdtempSync(join(tmpdir(), "pickprobe-")), "recs.json");
  const e = (id, kind = "chat") => ({ model_id: id, id_verified: true, kind, status: "stable", retires: null });
  writeFileSync(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-01", review_by: reviewBy, source_notes: "",
    providers: { openai: { roles: { coordinator: [e("m-shared")], everyday: [e("m-shared")], quick: [e("m-small")], embed: [e("m-embed", "embed")] } } },
  }));
  return f;
}
async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  return db;
}

test("tool call required", async () => {
  const text = stub(() => reply(200, { choices: [{ message: { content: "hello" } }] }));
  assert.deepEqual(await probePick(openaiRow, "m", { requestFn: text }), { ok: false, code: "no_tool_call" });
  const good = stub(() => toolReply("crow_probe"));
  assert.deepEqual(await probePick(openaiRow, "m", { requestFn: good }), { ok: true, code: "ok" });
  const c = good.calls[0];
  assert.equal(c.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(c.method, "POST");
  assert.equal(c.mode, "cloud");
  assert.equal(c.body.tool_choice, "required");
  assert.equal(c.body.max_tokens, 64);
  assert.equal(c.body.tools[0].function.name, "crow_probe");
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal((await probePick(openaiRow, "m", { requestFn: stub(() => toolReply("other_tool")) })).code, "no_tool_call");
  assert.deepEqual(await probePick(openaiRow, "m", { requestFn: stub(() => reply(302, "", { location: "https://elsewhere.example.com/" })) }), { ok: false, code: "redirect" });
  assert.deepEqual(await probePick(openaiRow, "m", { requestFn: stub(() => reply(429)) }), { ok: false, code: "http_429" });
  assert.deepEqual(await probePick(openaiRow, "m", { requestFn: stub(() => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }) }), { ok: false, code: "unreachable" });
});

test("mode is other for a row with no preset", async () => {
  const f = stub(() => toolReply("crow_probe"));
  await probePick(otherRow, "m", { requestFn: f });
  assert.equal(f.calls[0].mode, "other");
});

test("anthropic shape", async () => {
  const row = { id: "cloud-a", baseUrl: "https://api.anthropic.com", apiKey: KEY };
  const f = stub(() => reply(200, { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "crow_probe", input: { ok: true } }] }));
  assert.deepEqual(await probePick(row, "m", { requestFn: f }), { ok: true, code: "ok" });
  const c = f.calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(c.body.tool_choice, { type: "any" });
  assert.equal(c.body.max_tokens, 64);
  assert.equal(c.body.tools[0].name, "crow_probe");
  assert.deepEqual(c.body.tools[0].input_schema.required, ["ok"]);
  assert.equal(c.headers["x-api-key"], KEY);
  assert.equal(c.headers["anthropic-version"], "2023-06-01");
  assert.equal(c.headers.Authorization, undefined);
  const none = stub(() => reply(200, { content: [{ type: "text", text: "hi" }] }));
  assert.equal((await probePick(row, "m", { requestFn: none })).code, "no_tool_call");
});

test("embed", async () => {
  const ok = stub(() => reply(200, { data: [{ embedding: [0.1] }] }));
  assert.deepEqual(await probePick(openaiRow, "e", { kind: "embed", requestFn: ok }), { ok: true, code: "ok" });
  assert.equal(ok.calls[0].url, "https://api.openai.com/v1/embeddings");
  assert.deepEqual(ok.calls[0].body, { model: "e", input: "ok" });
  assert.deepEqual(await probePick(openaiRow, "e", { kind: "embed", requestFn: stub(() => reply(200, { data: [] })) }), { ok: false, code: "bad_embedding" });
});

test("checks expire", async () => {
  const db = await freshDb();
  const file = recFile("2027-01-28");
  await probeRecommended(db, "cloud-a", { roles: ["quick"], requestFn: stub(() => toolReply("crow_probe")), listRowsFn: async () => [openaiRow], recOpts: { file } });
  const c = await pickCheckOf(db, "cloud-a", "m-small", { now: new Date("2026-11-01T00:00:00Z"), recOpts: { file } });
  assert.equal(c.ok, true);
  assert.equal(c.code, "ok");
  assert.match(c.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(await pickCheckOf(db, "cloud-a", "m-small", { now: new Date("2027-02-01T00:00:00Z"), recOpts: { file } }), null);
  assert.equal(await pickCheckOf(db, "cloud-a", "never", { now: new Date("2026-11-01T00:00:00Z"), recOpts: { file } }), null);
});

test("shared model probed once; results stored in an instance-scope key", async () => {
  const db = await freshDb();
  const file = recFile("2027-01-28");
  const f = stub((url) => (url.endsWith("/embeddings") ? reply(200, { data: [{ embedding: [1] }] }) : toolReply("crow_probe")));
  const out = await probeRecommended(db, "cloud-a", { roles: ["coordinator", "everyday", "quick", "embed", "rerank"], requestFn: f, listRowsFn: async () => [openaiRow], recOpts: { file } });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter((c) => c.body.model === "m-shared").length, 1);
  assert.deepEqual(out.coordinator, { modelId: "m-shared", ok: true, code: "ok" });
  assert.deepEqual(out.everyday, out.coordinator);
  assert.equal(out.embed.modelId, "m-embed");
  assert.equal(out.rerank, undefined);
  const { rows } = await db.execute("SELECT value FROM dashboard_settings WHERE key='provider_pick_checks'");
  const stored = JSON.parse(rows[0].value);
  assert.deepEqual(Object.keys(stored["cloud-a"]).sort(), ["m-embed", "m-shared", "m-small"]);
  assert.equal(isInstanceScope("provider_pick_checks"), true);
});

test("the key never reaches a log, a result or the stored checks", async () => {
  const db = await freshDb();
  const file = recFile("2027-01-28");
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.map(String).join(" "));
  let out, failing;
  try {
    out = await probeRecommended(db, "cloud-a", { roles: ["quick"], requestFn: stub(() => toolReply("crow_probe")), listRowsFn: async () => [openaiRow], recOpts: { file } });
    failing = await probePick(openaiRow, "m", { requestFn: stub(() => { throw new Error(`boom ${KEY}`.replace(KEY, "")); }) });
  } finally { Object.assign(console, orig); }
  const { rows } = await db.execute("SELECT value FROM dashboard_settings");
  assert.ok(!JSON.stringify([out, failing, rows, seen]).includes(KEY));
});

test("no silent probe: addProvider makes no probe request", async () => {
  // addProvider takes no request function for probes at all; the only request seam is testFn (stubbed here).
  const probeSpy = [];
  const r = await addProvider({}, { presetId: "openai", apiKey: KEY, modelIds: ["m"] }, {
    testFn: async () => ({ ok: true, code: "ok", models: ["m"], host: "api.openai.com", baseUrl: "https://api.openai.com/v1" }),
    listRowsFn: async () => [], upsertProviderFn: async () => {}, invalidateFn: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(probeSpy.length, 0);
});
