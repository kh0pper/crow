/**
 * Gateway-run bot tool calls carry the bound bot's identity as `_meta["crow/actor"]`;
 * unbound executors (the operator's own chat) send none.
 *
 * The same bound-ness is what gates an ADD-ON tool: a bot may call an addon tool only when its def
 * selected it (`tools.crow_mcp`), on both routes (a direct tool call and the crow_tools proxy), and a
 * def field (`kind:"voice"`) is never a credential. A relay voice turn is gated like any other bot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolExecutor } from "../servers/gateway/ai/tool-executor.js";
import { connectedServers } from "../servers/gateway/proxy.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const STUB = "stub-actor-meta";

/** A connected addon server exposing `names`, recording every callTool it receives. */
function withStub(fn, names = ["stub_write"]) {
  return async () => {
    const calls = [];
    connectedServers.set(STUB, {
      status: "connected",
      tools: names.map((name) => ({ name })),
      client: { callTool: async (p) => { calls.push(p); return { content: [{ type: "text", text: "ok" }] }; } },
    });
    try { await fn(calls); } finally { connectedServers.delete(STUB); }
  };
}

/** The fixed refusal an addon tool the bot was never given gets: the tool name only. */
const notGranted = (name) => `Error: this assistant has not been given "${name}". Tell the user it isn't available to this assistant.`;

test("(a) voice turn: pi_bot_defs.display_name column wins over the JSON display_name", async () => {
  const h = harness({ bot: { bot_id: "glass", display_name: "House", __column_display_name: "Glasses", fast_voice_model: "crow-voice/qwen3.5-4b" } });
  let seen = null;
  h.deps.createToolExecutor = (o) => { seen = o.botDef; return { executeToolCalls: async () => [], close: async () => {} }; };
  await h.runner.runVoiceTurn({ db: {}, device: { ...h.device, bound_bot_id: "glass" }, transcript: "hi", sink: h.sink });
  assert.equal(seen.display_name, "Glasses");
  assert.equal(seen.bot_id, "glass");
});

// The bot these (b) tests bind selects the stub it calls: an addon tool is reachable only when the
// def selected it (the gate the (d) tests below pin), and the subject here is the actor it carries.
const selecting = (over = {}) => ({ bot_id: "glass", display_name: "Glasses", tools: { crow_mcp: [`${STUB}/stub_write`] }, ...over });

test("(b) bound executor: direct addon call carries the actor", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: selecting() });
  await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: { x: 1 } }]);
  assert.deepEqual(calls[0]._meta["crow/actor"], { kind: "bot", id: "glass", name: "Glasses" });
}));

test("(b) bound executor: crow_tools path carries the actor, name sanitized, falls back to id", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: selecting({ display_name: "‮Gl\u0007asses" }) });
  await ex.executeToolCalls([{ id: "1", name: "crow_tools", arguments: { action: "stub_write", params: {} } }]);
  assert.equal(calls[0]._meta["crow/actor"].name, "Glasses");
  const ex2 = createToolExecutor({ botDef: selecting({ display_name: undefined }) });
  await ex2.executeToolCalls([{ id: "2", name: "stub_write", arguments: {} }]);
  assert.deepEqual(calls[1]._meta["crow/actor"], { kind: "bot", id: "glass", name: "glass" });
}));

test("(b) the actor is never read from tool arguments", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: selecting() });
  await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: { _meta: { "crow/actor": { kind: "bot", id: "evil", name: "Evil" } } } }]);
  assert.equal(calls[0]._meta["crow/actor"].id, "glass");
}));

test("(b) unbound executor sends no _meta", withStub(async (calls) => {
  const ex = createToolExecutor({});
  await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: {} }]);
  assert.equal(calls.length, 1);
  assert.ok(!("_meta" in calls[0]));
}));

// --- (c) the add-on selection gate ----------------------------------------------------------

test("(c) a bound bot is refused an addon tool its def never selected, on both routes", withStub(async (calls) => {
  // The def binds the bot with NO selection at all: the advertised set is empty, but a model can
  // still force-call the tool, so the gate is on the way in as well.
  const ex = createToolExecutor({ botDef: { bot_id: "glass", display_name: "Glasses", tools: { crow_mcp: [] } } });

  const direct = await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: { x: 1 } }]);
  assert.equal(direct[0].isError, true, direct[0].result);
  assert.equal(direct[0].result, notGranted("stub_write"), "the fixed refusal, naming the tool");

  const proxied = await ex.executeToolCalls([{ id: "2", name: "crow_tools", arguments: { action: "stub_write", params: { x: 1 } } }]);
  assert.equal(proxied[0].isError, true, proxied[0].result);
  assert.equal(proxied[0].result, notGranted("stub_write"));

  assert.deepEqual(calls, [], "the addon server saw no call at all");
}));

test("(c) a selected addon tool runs with the actor; another bot's selection grants nothing", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: { bot_id: "glass", display_name: "Glasses", tools: { crow_mcp: [`${STUB}/stub_write`] } } });
  const r = await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: {} }]);
  assert.equal(r[0].isError, false, r[0].result);
  assert.deepEqual(calls[0]._meta["crow/actor"], { kind: "bot", id: "glass", name: "Glasses" });

  // The selection is matched by the tool name the def names, nothing wider: a second tool of the
  // same addon server was not selected and is refused.
  connectedServers.get(STUB).tools.push({ name: "stub_other" });
  const other = await ex.executeToolCalls([{ id: "2", name: "stub_other", arguments: {} }]);
  assert.equal(other[0].isError, true, other[0].result);
  assert.equal(other[0].result, notGranted("stub_other"));
  assert.equal(calls.length, 1, "only the selected tool reached the addon");
}));

test("(c) a def that says kind:'voice' on another bot's id is still gated", withStub(async (calls) => {
  const ex = createToolExecutor({ botDef: { bot_id: "other.bot", kind: "voice", display_name: "Not Crow", tools: { crow_mcp: [] } } });
  const r = await ex.executeToolCalls([{ id: "1", name: "stub_write", arguments: {} }]);
  assert.equal(r[0].isError, true, r[0].result);
  assert.equal(r[0].result, notGranted("stub_write"));
  assert.deepEqual(calls, []);
}));

// --- (d) the voice bot: own turn runs an unselected addon, a relay turn does not -----------

test("(d) relay crow.voice is gated on an unselected addon tool; the same def without relay runs it",
  withStub(async (calls) => {
    const relay = createToolExecutor({ botDef: { bot_id: "crow.voice", display_name: "Crow" }, relay: true });
    const refused = await relay.executeToolCalls([{ id: "1", name: "gcal_create_event", arguments: { title: "x" } }]);
    assert.equal(refused[0].isError, true, refused[0].result);
    assert.equal(refused[0].result, notGranted("gcal_create_event"));
    assert.deepEqual(calls, [], "a relayed turn never reaches the addon");

    // The operator's own spoken turn keeps the whole surface: the same def, no relay.
    const own = createToolExecutor({ botDef: { bot_id: "crow.voice", display_name: "Crow" } });
    const ran = await own.executeToolCalls([{ id: "2", name: "gcal_create_event", arguments: { title: "x" } }]);
    assert.equal(ran[0].isError, false, ran[0].result);
    assert.equal(calls.length, 1, "the addon was called");
    assert.deepEqual(calls[0]._meta["crow/actor"], { kind: "bot", id: "crow.voice", name: "Crow" });

    // And an unbound executor (the dashboard chat, a one-shot) reaches it too, with no actor meta.
    const unbound = createToolExecutor({});
    const plain = await unbound.executeToolCalls([{ id: "3", name: "gcal_create_event", arguments: { title: "x" } }]);
    assert.equal(plain[0].isError, false, plain[0].result);
    assert.equal(calls.length, 2, "the addon was called");
    assert.ok(!("_meta" in calls[1]), "an unbound executor sends no _meta");
  }, ["gcal_create_event"]));