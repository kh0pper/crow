/**
 * Perch strands plan, strand 2 (rev 4): a model's tool cap, read from DATA.
 *
 * Precedence: the model entry's `maxTools` → an engine-kind default (a
 * provider whose gpu_policy names the gufo engine, which ships with a
 * 128-function limit) → no cap. Every lookup fails OPEN: a cap that cannot be
 * read must never stop a bot from running.
 *
 * Provider ids here are fakes (public-hygiene: no real catalogue keys).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const scratch = mkdtempSync(join(tmpdir(), "crow-tool-budget-"));
const DB = join(scratch, "crow.db");
process.env.CROW_DB_PATH = DB;

const { test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const B = await import("../scripts/pi-bots/tool-budget.mjs");

const csvOf = (n) => Array.from({ length: n }, (_, i) => "mcp__srv__t" + i).join(",");

function seed(withPolicyColumn = true) {
  const d = new Database(DB);
  d.exec("DROP TABLE IF EXISTS providers");
  d.exec("CREATE TABLE providers (id TEXT PRIMARY KEY, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0" +
    (withPolicyColumn ? ", gpu_policy TEXT" : "") + ")");
  const ins = withPolicyColumn
    ? d.prepare("INSERT INTO providers (id, models, gpu_policy) VALUES (?,?,?)")
    : d.prepare("INSERT INTO providers (id, models) VALUES (?,?)");
  const rows = [
    ["engine-a", JSON.stringify([{ id: "big" }, { id: "raised", maxTools: 512 }]), JSON.stringify({ engine: { managed: "external", label: "gufo" } })],
    ["cloud-b", JSON.stringify([{ id: "m1" }, { id: "m2", maxTools: 40 }]), null],
    ["weird-c", JSON.stringify([{ id: "z", maxTools: "lots" }, { id: "neg", maxTools: -3 }]), "{not json"],
  ];
  for (const r of rows) withPolicyColumn ? ins.run(...r) : ins.run(r[0], r[1]);
  d.close();
}

test("countCsvTools: entries in the pinned csv; empty csv is a real zero; null stays unknown", () => {
  assert.equal(B.countCsvTools(csvOf(3)), 3);
  assert.equal(B.countCsvTools(""), 0);
  assert.equal(B.countCsvTools("a,,b, ,c"), 3);
  assert.equal(B.countCsvTools(null), null);
});

test("capFor: model maxTools wins, then the gufo engine default, then no cap", () => {
  seed();
  assert.equal(B.capFor({ provider: "engine-a", model: "raised" }), 512, "a raised limit on the model row wins");
  assert.equal(B.capFor({ provider: "engine-a", model: "big" }), B.GUFO_DEFAULT_MAX_TOOLS, "gufo-served, no maxTools");
  assert.equal(B.GUFO_DEFAULT_MAX_TOOLS, 128);
  assert.equal(B.capFor({ provider: "cloud-b", model: "m2" }), 40);
  assert.equal(B.capFor({ provider: "cloud-b", model: "m1" }), null, "no engine, no field → no cap");
  assert.equal(B.capFor({ provider: "nobody", model: "x" }), null);
});

test("capFor fails OPEN: junk maxTools, junk gpu_policy, missing column, missing DB", () => {
  seed();
  assert.equal(B.capFor({ provider: "weird-c", model: "z" }), null);
  assert.equal(B.capFor({ provider: "weird-c", model: "neg" }), null);
  seed(false);                                       // a DB from before the gpu_policy migration
  assert.equal(B.capFor({ provider: "engine-a", model: "big" }), null);
  assert.equal(B.capFor({ provider: "engine-a", model: "raised" }), 512, "maxTools still read without the column");
  assert.equal(B.capFor(null), null);
  process.env.CROW_DB_PATH = join(scratch, "no-such-dir", "crow.db");
  try { assert.equal(B.capFor({ provider: "engine-a", model: "big" }), null); }
  finally { process.env.CROW_DB_PATH = DB; }
});

test("checkToolBudget: 128 of 128 is fine, 129 is over, no cap is always fine, near = within 10% under", () => {
  assert.deepEqual(B.checkToolBudget(csvOf(128), 128), { ok: true, count: 128, cap: 128, near: true });
  assert.deepEqual(B.checkToolBudget(csvOf(129), 128), { ok: false, count: 129, cap: 128, near: false });
  assert.deepEqual(B.checkToolBudget(csvOf(100), 128), { ok: true, count: 100, cap: 128, near: false });
  assert.deepEqual(B.checkToolBudget(csvOf(900), null), { ok: true, count: 900, cap: null, near: false });
  assert.equal(B.checkToolBudget("", 128).ok, true, "a locked, empty surface is never refused");
});

test("messages: the session message names the model and every way out; the channel message names no provider", () => {
  const m = B.sessionBudgetMessage({ count: 318, cap: 128, model: "some-model" });
  assert.match(m, /some-model/);
  assert.match(m, /128/);
  assert.match(m, /318/);
  assert.match(m, /this session/i);
  assert.match(m, /Bot Builder/);
  const c = B.channelBudgetMessage({ count: 318, cap: 128 });
  assert.match(c, /318/);
  assert.match(c, /128/);
  assert.doesNotMatch(c, /engine-a|some-model|\//, "no provider or model id to a correspondent");
});

test("channels (handleInbound): an over-cap surface is refused right after prepareSpawn — before the session goes active, the model warms, or pi spawns — with a reply and an audit row", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "pi-bots", "bridge.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function handleInbound("));
  const prep = fn.indexOf("spawnPrep = await prepareSpawn(");
  const check = fn.indexOf("checkToolBudget(");
  const active = fn.indexOf('status: "active"');
  const warm = fn.indexOf("await warmModel(resolved.provider");
  const spawn = fn.indexOf("new PiRpc(");
  assert.ok(prep > 0 && check > prep, "checked after the model is resolved");
  assert.ok(check < active && check < warm && check < spawn, "and before any side effect");
  const block = fn.slice(check, active);
  assert.match(block, /channelBudgetMessage\(/, "the correspondent gets the provider-free sentence");
  assert.match(block, /sendReply\(/);
  assert.match(block, /status: "error"/);
  assert.match(block, /code: "tool_budget"/, "the audit row carries the code (and the model key)");
  assert.match(block, /return \{ action: "error"/);
});
