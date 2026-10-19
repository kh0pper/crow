/**
 * The runner's abilitiesOf (turn.js): loadBot → the turn's own tool filter → classifyTools → voiceAbilities.
 * Stub deps; nothing that could build a prompt, start, probe or reach a model may run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurnRunner } from "../servers/gateway/voice/turn.js";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";

const BOTS = {
  kitchen: { bot_id: "kitchen", display_name: "Kitchen", enabled: 1 },
  off: { bot_id: "off", display_name: "Off", enabled: 0 },
};

function harness({ chatTools = ["crow_memory", "crow_delegate", "ws_cal_create_event", "crow_tools"], connected = ["ws_cal_create_event", "todo_add_item", "send_email"],
  scope = null, bot = {}, resolve = async () => ({ baseUrl: "http://esc" }), escalationOn = true, calList = true } = {}) {
  const calls = { prompt: 0, acquire: 0, probe: 0, chat: 0, resolved: [] };
  const fam = createToolFamilies({
    manifests: {},
    connected: () => new Map([["calapp", { status: "connected", tools: [{ name: "ws_cal_create_event" }] }], ["todo", { status: "connected", tools: [{ name: "todo_add_item" }] }], ["mailer", { status: "connected", tools: [{ name: "send_email" }] }]]),
    listExtensions: () => [{ id: "calapp", name: "Calendar App", capabilities: calList ? { voice_intent: { en: ["calendar"], es: ["calendario"] } } : {} }],
  });
  const deps = {
    now: () => 1000,
    loadBotRow: async (db, id) => {
      const b = BOTS[id];
      return b ? { bot_id: b.bot_id, enabled: b.enabled, definition: JSON.stringify({ ...b, ...bot }) } : null;
    },
    getChatTools: () => chatTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    toolFamilies: fam,
    isMemoryTool: (n) => n === "crow_memory",
    botVoiceScope: () => scope,
    connectedAddonTools: () => connected,
    isExternalSendTool: (n) => n === "send_email",
    escalateKey: "crow-chat/big",
    toolEscalationEnabled: () => escalationOn,
    resolveKey: async (k) => { calls.resolved.push(k); return resolve(k); },
    generateSystemPrompt: async () => { calls.prompt++; return "P"; },
    acquire: async () => { calls.acquire++; },
    probeReady: async () => { calls.probe++; return true; },
    createChatAdapter: async () => { calls.chat++; return {}; },
    contextLenFor: async () => { throw new Error("contextLenFor must not run"); },
  };
  return { runner: createVoiceTurnRunner(deps), calls, deps };
}
const ids = (r) => r.items.map((x) => `${x.id}${x.quick ? "" : "(slower)"}`);

test("abilitiesOf: an unknown bot and a disabled bot → null", async () => {
  const h = harness();
  assert.equal(await h.runner.abilitiesOf({ db: {}, botId: "nobody" }), null);
  assert.equal(await h.runner.abilitiesOf({ db: {}, botId: "off" }), null);
  assert.equal(await h.runner.abilitiesOf({ db: {}, botId: "" }), null);
});

test("abilitiesOf: a bot with no add-on scope (unbound) reaches every connected add-on tool behind crow_tools; the larger model's key is resolved, never acquired", async () => {
  const h = harness();
  const r = await h.runner.abilitiesOf({ db: {}, botId: "kitchen" });
  assert.deepEqual(ids(r), ["calendar", "messages(slower)", "lists(slower)"]);
  assert.deepEqual(h.calls.resolved, ["crow-chat/big"]);
  assert.deepEqual([h.calls.prompt, h.calls.acquire, h.calls.probe, h.calls.chat], [0, 0, 0, 0], "no prompt build, no model start, probe or chat adapter");
});

test("abilitiesOf: a bound bot reaches only the add-on tools it selected", async () => {
  const h = harness({ scope: { selectedToolNames: new Set(["ws_cal_create_event", "todo_add_item"]) } });
  assert.deepEqual(ids(await h.runner.abilitiesOf({ db: {}, botId: "kitchen" })), ["calendar", "lists(slower)"]);
});

test("abilitiesOf: memory on adds 'remembers things', off leaves it out", async () => {
  const h = harness();
  const off = await h.runner.abilitiesOf({ db: {}, botId: "kitchen", memoryOn: false });
  const on = await h.runner.abilitiesOf({ db: {}, botId: "kitchen", memoryOn: true });
  assert.deepEqual(on.items, [...off.items, { id: "memory", quick: true }]);
});

test("abilitiesOf: memory on lists 'remembers things' only when the bot itself has crow_memory", async () => {
  const h = harness({ chatTools: ["crow_delegate", "ws_cal_create_event", "crow_tools"] });
  const r = await h.runner.abilitiesOf({ db: {}, botId: "kitchen", memoryOn: true });
  assert.ok(!r.items.some((x) => x.id === "memory"), "no crow_memory on the bot → never 'remembers things'");
  const denied = harness();
  const r2 = await denied.runner.abilitiesOf({ db: {}, botId: "kitchen", memoryOn: true, denyTools: ["crow_memory"] });
  assert.ok(!r2.items.some((x) => x.id === "memory"), "the display denies crow_memory → no memory");
});

test("abilitiesOf: memory on lists no memory when the bot's policy denies crow_store_memory", async () => {
  const h = harness({ bot: { permission_policy: { deny: ["crow_store_memory"] } } });
  const r = await h.runner.abilitiesOf({ db: {}, botId: "kitchen", memoryOn: true });
  assert.ok(!r.items.some((x) => x.id === "memory"));
});

test("abilitiesOf: the display's deny list and the bot's own policy are respected; crow_delegate is never an ability", async () => {
  const h = harness({ chatTools: ["crow_delegate", "ws_cal_create_event"] });
  assert.deepEqual(await h.runner.abilitiesOf({ db: {}, botId: "kitchen", denyTools: ["ws_cal_create_event", "crow_delegate"] }), { items: [], none: true });
  const p = harness({ bot: { permission_policy: { deny: ["todo_add_item"], external_send: "draft_only" } } });
  assert.deepEqual(ids(await p.runner.abilitiesOf({ db: {}, botId: "kitchen" })), ["calendar"], "draft-only: an external send is never shown");
});

test("abilitiesOf: no escalation (switched off, or the larger model's key does not resolve) → withheld abilities are left out", async () => {
  const off = harness({ escalationOn: false });
  assert.deepEqual(ids(await off.runner.abilitiesOf({ db: {}, botId: "kitchen" })), ["calendar"]);
  assert.deepEqual(off.calls.resolved, [], "nothing to resolve when escalation is off");
  const bad = harness({ resolve: async () => { throw new Error("no provider"); } });
  assert.deepEqual(ids(await bad.runner.abilitiesOf({ db: {}, botId: "kitchen" })), ["calendar"]);
  const empty = harness({ resolve: async () => ({ baseUrl: "" }) });
  assert.deepEqual(ids(await empty.runner.abilitiesOf({ db: {}, botId: "kitchen" })), ["calendar"]);
});

test("abilitiesOf: display tools are the display's own — a request a display may hold stays on the quick model (worst case: a card is open)", async () => {
  const h = harness();
  const wm = { definition: { name: "crow_wm" }, when: () => false };
  const r = await h.runner.abilitiesOf({ db: {}, botId: "kitchen", extraTools: [wm], displayObjectWhen: (t) => /list|lista/.test(t) });
  assert.deepEqual(ids(r), ["calendar", "messages(slower)"]);
  const asked = { definition: { name: "crow_show" }, when: (t) => /calendar|calendario/.test(t), holdText: (t) => /calendar|calendario/.test(t) };
  const r2 = await harness({ calList: false }).runner.abilitiesOf({ db: {}, botId: "kitchen", extraTools: [asked] });
  assert.ok(!r2.items.some((x) => x.id === "calendar"), "a display tool that takes the calendar request keeps it off the larger model");
});

test("abilitiesOf: without tool families (an older core wiring) → null, never a guess", async () => {
  const h = harness();
  delete h.deps.toolFamilies;
  const runner = createVoiceTurnRunner(h.deps);
  assert.equal(await runner.abilitiesOf({ db: {}, botId: "kitchen" }), null);
});
