/**
 * bot_jobs delivery — Plan B Part 1 Stage 2 (result delivery layer).
 *
 * Stage 1 proved the store (enqueue/claim/finalize). Stage 2 adds DELIVERY:
 * where a completed job's result text goes. This exercises the transport-free
 * paths inline (memory / poll) and the channel routing contract (gmail / gateway
 * socket) WITHOUT touching a real Discord/Telegram/Slack/Gmail account — channel
 * sends are stateless authenticated REST calls, so the runner just needs the
 * right routing target; the live receive-socket is irrelevant to delivery.
 *
 *  - parseThread(): the pure gateway_thread_id → routing-target parser, mirroring
 *    the exact id shapes each adapter emits ("discord:<ch>", "telegram:<chat>",
 *    "slack:<ch>:<ts>").
 *  - findGatewayDef(): pull the right gateways[] entry (carrying the token).
 *  - deliverResult(): memory → INSERT; poll/null → no-op; gmail|gateway → delegate
 *    to the injected deliverChannel (host transport); deferred when none injected.
 */
import { test, before, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "botjobs-deliver-"));
const dbPath = join(dir, "crow.db");
process.env.CROW_DB_PATH = dbPath;

let runner, deliver;
before(async () => {
  // Minimal memories table (no FTS shadow needed for the unit path).
  const init = new Database(dbPath);
  init.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      context TEXT, tags TEXT, source TEXT,
      importance INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
  init.close();
  runner = await import("../scripts/pi-bots/job_runner.mjs");
  deliver = await import("../scripts/pi-bots/gateways/deliver.mjs");
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("parseThread parses each gateway's thread-id shape", () => {
  assert.deepStrictEqual(deliver.parseThread("discord", "discord:123456"), { channelId: "123456" });
  assert.deepStrictEqual(deliver.parseThread("telegram", "telegram:987"), { chatId: "987" });
  assert.deepStrictEqual(deliver.parseThread("slack", "slack:C01:1700000000.0001"),
    { channel: "C01", threadTs: "1700000000.0001" });
  // Tolerates a bare id with no prefix (defensive).
  assert.deepStrictEqual(deliver.parseThread("discord", "999"), { channelId: "999" });
});

test("findGatewayDef returns the typed gateway entry (token carrier) or null", () => {
  const def = { gateways: [{ type: "gmail", address: "a+b@x" }, { type: "telegram", token: "T" }] };
  assert.strictEqual(deliver.findGatewayDef(def, "telegram").token, "T");
  assert.strictEqual(deliver.findGatewayDef(def, "slack"), null);
  assert.strictEqual(deliver.findGatewayDef(null, "telegram"), null);
});

test("postToChannel validates token + thread before any network call", async () => {
  await assert.rejects(
    () => deliver.postToChannel({ type: "telegram", gw: {}, threadId: "telegram:1", text: "hi" }),
    /missing token/);
  await assert.rejects(
    () => deliver.postToChannel({ type: "discord", gw: { token: "T" }, threadId: "", text: "hi" }),
    /channelId/);
  await assert.rejects(
    () => deliver.postToChannel({ type: "nope", gw: {}, threadId: "x", text: "hi" }),
    /unsupported/);
});

test("deliverResult: poll/null is a no-op", async () => {
  assert.deepStrictEqual(await runner.deliverResult({ job_id: "j1", deliver_to: null }, "x"), { delivered: "poll" });
  assert.deepStrictEqual(
    await runner.deliverResult({ job_id: "j2", deliver_to: JSON.stringify({ kind: "poll" }) }, "x"),
    { delivered: "poll" });
});

test("deliverResult: memory kind INSERTs a memory row", async () => {
  const r = await runner.deliverResult(
    { job_id: "j3", bot_id: "botA", deliver_to: JSON.stringify({ kind: "memory", memory_category: "notes" }) },
    "the result text");
  assert.strictEqual(r.delivered, "memory");
  const c = new Database(dbPath);
  const row = c.prepare("SELECT content, category, source FROM memories ORDER BY id DESC LIMIT 1").get();
  c.close();
  assert.strictEqual(row.content, "the result text");
  assert.strictEqual(row.category, "notes");
  assert.strictEqual(row.source, "bot-job:botA");
});

test("deliverResult: gateway/gmail delegate to the injected deliverChannel", async () => {
  const seen = [];
  const deliverChannel = async (job, spec, text) => { seen.push({ spec, text }); return { delivered: spec.kind }; };
  const gw = await runner.deliverResult(
    { job_id: "j4", bot_id: "botA", deliver_to: JSON.stringify({ kind: "gateway", gateway_type: "discord", gateway_thread_id: "discord:1" }) },
    "reply text", { deliverChannel });
  assert.strictEqual(gw.delivered, "gateway");
  const gm = await runner.deliverResult(
    { job_id: "j5", bot_id: "botA", deliver_to: JSON.stringify({ kind: "gmail", to: "u@x", thread: "t1" }) },
    "mail body", { deliverChannel });
  assert.strictEqual(gm.delivered, "gmail");
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].text, "reply text");
});

test("deliverResult: channel kind with NO deliverer defers (result stays for poll)", async () => {
  const r = await runner.deliverResult(
    { job_id: "j6", bot_id: "botA", deliver_to: JSON.stringify({ kind: "gateway", gateway_type: "slack", gateway_thread_id: "slack:C:1.0" }) },
    "x");
  assert.strictEqual(r.delivered, "deferred");
});

test("makeChannelDeliverer rejects an unknown deliver kind", async () => {
  const dc = deliver.makeChannelDeliverer({});
  await assert.rejects(() => dc({ bot_id: "b" }, { kind: "carrier-pigeon" }, "x"), /unsupported kind/);
});
