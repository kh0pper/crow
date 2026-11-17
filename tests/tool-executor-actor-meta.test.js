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

// --- (d) the same tool name on two add-ons: the grant is (server, tool), never the name ----------

const DUP_A = "stub-dup-a";
const DUP_B = "stub-dup-b";
const SHARED = "shared_stub_tool";

/**
 * Two connected add-ons that BOTH expose `SHARED` (plus one tool only each owns). The grant is keyed
 * by (server, tool) for exactly this case: a grant keyed by the tool name alone would hand over —
 * and dispatch to — whichever add-on came first in localFirst order.
 */
function withDuplicateStubs(fn) {
  return async () => {
    const calls = { [DUP_A]: [], [DUP_B]: [] };
    for (const id of [DUP_A, DUP_B]) {
      connectedServers.set(id, {
        status: "connected",
        tools: [{ name: SHARED }, { name: id.replace(/-/g, "_") + "_own" }],
        client: { callTool: async (p) => { calls[id].push(p); return { content: [{ type: "text", text: id }] }; } },
      });
    }
    try { await fn(calls); } finally { connectedServers.delete(DUP_A); connectedServers.delete(DUP_B); }
  };
}

const dupBot = (selection) => ({ bot_id: "glass", display_name: "Glasses", tools: { crow_mcp: selection } });

/** The same tool call by its two routes: the direct name and the crow_tools proxy. */
const bothRoutes = (name, args = {}) => [
  { id: "direct", name, arguments: args },
  { id: "proxied", name: "crow_tools", arguments: { action: name, params: args } },
];

test("(d) two add-ons exposing one tool name: only the one the bot was given is called", withDuplicateStubs(async (calls) => {
  const ex = createToolExecutor({ botDef: dupBot([`${DUP_A}/${SHARED}`]) });
  for (const [i, tc] of bothRoutes(SHARED).entries()) {
    const [r] = await ex.executeToolCalls([{ ...tc, id: String(i) }]);
    assert.equal(r.isError, false, `${tc.id}: ${r.result}`);
    assert.equal(r.result, DUP_A, `${tc.id}: the add-on the bot was given answered`);
  }
  assert.equal(calls[DUP_A].length, 2, "both routes reached the granted add-on");
  assert.deepEqual(calls[DUP_B], [], "the add-on the bot was not given saw no call at all");
}));

test("(d) the grant picks the add-on, not the order localFirst walks them in", withDuplicateStubs(async (calls) => {
  // stubA is set (and so walked) first: a first-name-match dispatch would call it.
  assert.equal([...connectedServers.keys()].filter((k) => k.startsWith("stub-dup-"))[0], DUP_A);
  const ex = createToolExecutor({ botDef: dupBot([`${DUP_B}/${SHARED}`]) });
  for (const [i, tc] of bothRoutes(SHARED).entries()) {
    const [r] = await ex.executeToolCalls([{ ...tc, id: String(i) }]);
    assert.equal(r.isError, false, `${tc.id}: ${r.result}`);
    assert.equal(r.result, DUP_B, `${tc.id}: the add-on the bot was given, not the first name match`);
  }
  assert.deepEqual(calls[DUP_A], [], "the add-on that came first never ran");
  assert.equal(calls[DUP_B].length, 2);
}));

test("(d) neither add-on granted: the call is refused, and neither add-on is called", withDuplicateStubs(async (calls) => {
  const ex = createToolExecutor({ botDef: dupBot([`${DUP_A}/some_other_tool`]) });
  for (const [i, tc] of bothRoutes(SHARED).entries()) {
    const [r] = await ex.executeToolCalls([{ ...tc, id: String(i) }]);
    assert.equal(r.isError, true, `${tc.id}: ${r.result}`);
    assert.equal(r.result, notGranted(SHARED), `${tc.id}: the fixed refusal, naming the tool`);
  }
  assert.deepEqual(calls[DUP_A], []);
  assert.deepEqual(calls[DUP_B], []);
}));

test("(d) a bare-server grant covers that server's tools, and only that server's", withDuplicateStubs(async (calls) => {
  // effectiveCrowMcp (as pi and the advertising code read it): a bare "<server>" entry grants the
  // whole server, exactly as it grants every mcp__<server>__<tool> for pi.
  const ex = createToolExecutor({ botDef: dupBot([DUP_A]) });
  const [shared] = await ex.executeToolCalls([{ id: "1", name: SHARED, arguments: {} }]);
  assert.equal(shared.isError, false, shared.result);
  assert.equal(shared.result, DUP_A, "the bare grant covers the granted server's copy");
  const [own] = await ex.executeToolCalls([{ id: "2", name: "stub_dup_a_own", arguments: {} }]);
  assert.equal(own.isError, false, own.result);
  assert.equal(calls[DUP_A].length, 2, "both of its tools ran");

  // The OTHER add-on's own tool is not covered: the bare grant names one server.
  const [other] = await ex.executeToolCalls([{ id: "3", name: "stub_dup_b_own", arguments: {} }]);
  assert.equal(other.isError, true, other.result);
  assert.equal(other.result, notGranted("stub_dup_b_own"));
  assert.deepEqual(calls[DUP_B], [], "nothing of the other add-on ran");
}));

test("(d) the crow_tools not-found listing names only the add-ons a bound bot was given", withDuplicateStubs(async () => {
  const bound = createToolExecutor({ botDef: dupBot([`${DUP_A}/${SHARED}`]) });
  const [r] = await bound.executeToolCalls([{ id: "1", name: "crow_tools", arguments: { action: "no_such_stub_tool", params: {} } }]);
  assert.equal(r.isError, true, r.result);
  assert.match(r.result, /not found in any connected extension/);
  assert.ok(r.result.includes(`${DUP_A}(1)`), `the granted add-on, and how many of its tools it holds: ${r.result}`);
  assert.ok(!r.result.includes(DUP_B), `an add-on the bot was not given is never named: ${r.result}`);

  // Unbound (the operator's own chat) is unchanged: every connected add-on is listed.
  const unbound = createToolExecutor({});
  const [u] = await unbound.executeToolCalls([{ id: "2", name: "crow_tools", arguments: { action: "no_such_stub_tool", params: {} } }]);
  assert.ok(u.result.includes(`${DUP_A}(2)`) && u.result.includes(`${DUP_B}(2)`), u.result);
}));

// --- (e) the voice bot: own turn runs an unselected addon, a relay turn does not -----------

test("(e) relay crow.voice is gated on an unselected addon tool; the same def without relay runs it",
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