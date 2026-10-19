/**
 * "By voice on displays: …" (follow-up to #499/#502): what a bot can DO by voice, from its real tools,
 * decided by the voice turn's own classifier (tool-families.js classifyTools) run against a fixed
 * request per ability. The rule: the line may UNDERSTATE, never overstate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolFamilies, classifyTools } from "../servers/gateway/voice/tool-families.js";
import { ABILITIES, SECONDARY, voiceAbilities, backsAbility } from "../servers/gateway/voice/voice-abilities.js";
import { wantsAction, ACTION_OBJECTS } from "../bundles/kiosk/server/action-intent.js";
import { TOOL_MANIFESTS } from "../servers/gateway/tool-manifests.js";

const FAM = ({ calList = true, todoList = false } = {}) => createToolFamilies({
  manifests: TOOL_MANIFESTS,
  connected: () => new Map([
    ["calapp", { status: "connected", tools: [{ name: "ws_cal_create_event" }, { name: "gcal_list_events" }] }],
    ["todo", { status: "connected", tools: [{ name: "todo_list_items" }, { name: "todo_add_item" }] }],
    ["mailer", { status: "connected", tools: [{ name: "send_email" }] }],
    ["notes", { status: "connected", tools: [{ name: "nt_publish_page" }] }],
  ]),
  listExtensions: () => [
    { id: "calapp", name: "Calendar App", capabilities: calList ? { voice_intent: { en: ["calendar"], es: ["calendario"] } } : {} },
    { id: "todo", name: "Todo <b>Lists</b>", capabilities: todoList ? { voice_intent: { en: ["list", "shopping list"], es: ["lista"] } } : {} },
    { id: "notes", name: "Notebook", capabilities: { voice_intent: { en: ["notebook"], es: ["cuaderno"] } } },
  ],
});
const T = (...names) => names.map((name) => ({ name }));

/** The runner's wiring, on fixtures: the real classifier with a cold display (no previous turn). */
function run(tools, { hidden = [], escalates = true, memoryOn = false, fam = FAM(), displayBacks = () => false, allowed } = {}) {
  const classify = (transcript) => classifyTools({ baseTools: tools, fam, transcript, isMemoryTool: (n) => n === "crow_memory" });
  return voiceAbilities({ tools, hidden, classify, escalates, displayBacks, families: fam, memoryOn, allowed });
}
const ids = (r) => r.items.map((x) => `${x.id}${x.quick ? "" : "(slower)"}`);

test("ABILITIES: every probe is an action request in its language, en and es (the #499 decision would act on it)", () => {
  for (const a of ABILITIES) {
    assert.equal(wantsAction(a.probe.en), true, `${a.id} en: ${a.probe.en}`);
    assert.equal(wantsAction(a.probe.es), true, `${a.id} es: ${a.probe.es}`);
  }
});

test("drift: every action object #499 recognises (ACTION_OBJECTS) has an ability, and every ability names one", () => {
  const objects = ACTION_OBJECTS.map((o) => o.id);
  assert.deepEqual(objects, ["calendar", "reminders", "messages", "lists"]);
  for (const id of objects) assert.ok(ABILITIES.some((a) => a.object === id), `${id} has no ability: map it in voice-abilities.js`);
  for (const a of ABILITIES) assert.ok(objects.includes(a.object), `${a.id} names an object #499 does not know`);
  assert.ok(Object.isFrozen(ACTION_OBJECTS));
});

test("backsAbility: a WRITE tool whose object word follows the verb, or is its namespace; reads and other words never", () => {
  assert.equal(backsAbility("ws_cal_create_event")?.id, "calendar");
  assert.equal(backsAbility("gcal_list_events"), null, "a read proves nothing was added");
  assert.equal(backsAbility("todo_add_item")?.id, "lists");
  assert.equal(backsAbility("send_email")?.id, "messages");
  assert.equal(backsAbility("set_reminder")?.id, "reminders");
  assert.equal(backsAbility("create_text_snippet"), null, "text is not a message");
  assert.equal(backsAbility("crow_delegate"), null);
  assert.equal(backsAbility("list_calendars"), null);
  assert.equal(backsAbility("create_project_from_calendar"), null, "the object word must follow the verb directly or be the namespace");
});

test("a calendar add-on with a calendar phrase list: quick; without one: slower, only when the turn really escalates", () => {
  assert.deepEqual(ids(run(T("ws_cal_create_event", "gcal_list_events"))), ["calendar"]);
  const noList = FAM({ calList: false });
  assert.deepEqual(ids(run(T("ws_cal_create_event"), { fam: noList })), ["calendar(slower)"]);
  assert.deepEqual(run(T("ws_cal_create_event"), { fam: noList, escalates: false }), { items: [], none: true }, "no escalation (switched off, or the larger model does not resolve): left out");
});

test("a read-only calendar is never advertised — not as calendar, and not by its add-on's name either", () => {
  assert.deepEqual(run(T("gcal_list_events")), { items: [], none: true });
});

test("Crow messages means sending: creating a message group is not it", () => {
  assert.equal(backsAbility("crow_create_message_group", ABILITIES.filter((a) => a.core)), null);
  assert.equal(backsAbility("crow_send_message", ABILITIES.filter((a) => a.core))?.id, "crow_messages");
});

test("core sharing is 'Crow messages' (a write action in its manifest), quick on the message request in en and es", () => {
  const r = run(T("crow_sharing"));
  assert.deepEqual(ids(r), ["crow_messages"]);
  const cls = (t) => classifyTools({ baseTools: T("crow_sharing"), fam: FAM(), transcript: t });
  const probe = ABILITIES.find((a) => a.id === "crow_messages").probe;
  assert.equal(cls(probe.en).quickTools.length, 1);
  assert.equal(cls(probe.es).quickTools.length, 1);
  assert.deepEqual(run(T("crow_sharing"), { allowed: (n) => n !== "crow_send_message" && n !== "crow_voice_memo" }), { items: [], none: true }, "the bot's policy denies every send");
});

test("C1 trap: an email add-on beside core sharing — 'send an email' reaches sharing on the quick model and never escalates, so email is left out", () => {
  assert.deepEqual(ids(run(T("crow_sharing", "send_email"))), ["crow_messages"]);
  assert.deepEqual(ids(run(T("send_email"))), ["messages(slower)"], "alone it is withheld, and the turn escalates");
});

test("a hidden add-on tool behind crow_tools: lists, slower when its family is not offered to the quick model", () => {
  assert.deepEqual(ids(run(T("crow_tools"), { hidden: ["todo_add_item"] })), ["lists(slower)"]);
  // Quick only when a promoted tool of the same family is wanted (that is what puts crow_tools on offer).
  const fam = FAM({ todoList: true });
  assert.deepEqual(ids(run(T("todo_list_items", "crow_tools"), { hidden: ["todo_add_item"], fam })), ["lists"]);
  assert.deepEqual(run(T("todo_list_items"), { hidden: ["todo_add_item"], fam }).items, [], "no wrapper, nothing hidden is reachable");
});

test("lists: a display that may hold the list keeps the request on the quick model — a withheld list tool is then left out", () => {
  const r = run(T("crow_tools"), { hidden: ["todo_add_item"], displayBacks: (t) => /list|lista/.test(t) });
  assert.deepEqual(r.items, []);
});

test("secondary words follow the four, from listed families only; add-on names are data; a family already shown as one of the four is not named again", () => {
  const r = run(T("crow_projects", "crow_blog", "crow_media", "crow_storage", "nt_publish_page", "ws_cal_create_event"), { memoryOn: true });
  assert.deepEqual(r.items.map((x) => x.id), ["calendar", "projects", "blog", "news", "files", "addon:notes", "memory"]);
  assert.equal(r.items.find((x) => x.id === "addon:notes").label, "Notebook");
  assert.deepEqual(SECONDARY.map((s) => s.id), ["projects", "blog", "news", "files"]);
  assert.equal(r.none, false);
});

test("an add-on family with no phrase list is not named (it only works after an escalation the card cannot promise)", () => {
  const r = run(T("todo_list_items"));
  assert.deepEqual(r, { items: [], none: true });
});

test("memory adds only 'remembers things'; nothing else changes", () => {
  const off = run(T("ws_cal_create_event"));
  const on = run(T("ws_cal_create_event"), { memoryOn: true });
  assert.deepEqual(on.items.slice(0, -1), off.items);
  assert.deepEqual(on.items.at(-1), { id: "memory", quick: true });
});

test("no tools at all: answers questions only", () => {
  assert.deepEqual(run([]), { items: [], none: true });
  assert.deepEqual(run(T("crow_delegate")), { items: [], none: true });
});

test("a probe that is quick in English but not in Spanish is reported as the weaker of the two", () => {
  const fam = createToolFamilies({ manifests: {}, connected: () => new Map([["calapp", { status: "connected", tools: [{ name: "ws_cal_create_event" }] }]]),
    listExtensions: () => [{ id: "calapp", name: "Cal", capabilities: { voice_intent: { en: ["calendar"], es: [] } } }] });
  assert.deepEqual(ids(run(T("ws_cal_create_event"), { fam })), ["calendar(slower)"]);
  assert.deepEqual(run(T("ws_cal_create_event"), { fam, escalates: false }).items.filter((x) => x.id === "calendar"), []);
});
