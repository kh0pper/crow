import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenWords, stripPolite, matchT0, T0_PHRASES, T0_SLOTS, T0_KIND_SLOTS } from "../bundles/kiosk/server/phrases.js";
import { parseOpen, parsePlay, mentionsOpen, mentionsPlay, asksOpen, asksPlay, compound, compoundParts, lookupItem, matchT1 } from "../bundles/kiosk/server/patterns.js";
import { executeIntent, INVALID, SAY_MAX } from "../bundles/kiosk/server/executor.js";
import { matchSpoken } from "../bundles/kiosk/server/tiers.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";

const CAPS = { windows: ["timer", "recipe", "content"], max_windows: 4 };
function ctx(over = {}) {
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  return { store, deviceId: "d", caps: CAPS, lang: "en", sources: [], items: [], emit: () => {}, ...over };
}
const RECIPE = { kind: "recipe", title: "Pancakes", ingredients: ["flour"], steps: ["Mix the batter", "Cook two minutes a side"], step: 0 };
const ITEMS = [{ id: "lab_dashboard", title: "Lab dashboard", aliases: ["lab", "the lab page", "panel del laboratorio"] }, { id: "lab_notes", title: "Lab notes" }, { id: "guide", title: "Coding assistant guide" }];

test("spokenWords: a short phrase as plain words; too long to be a control phrase is null", () => {
  assert.deepEqual(spokenWords("¡Ciérralo, por favor!"), ["cierralo", "por", "favor"]);
  assert.deepEqual(spokenWords("What is the step?"), ["whats", "the", "step"]);
  assert.equal(spokenWords("x ".repeat(300)), null);
  assert.equal(spokenWords(""), null);
  assert.deepEqual(stripPolite(["hey", "crow", "close", "that", "please"]), ["close", "that"]);
  assert.deepEqual(stripPolite(["please"]), ["please"], "one word always remains");
});

test("T0 table: every listed phrase maps to its verb, bare and with a lead-in and a tail (en + es)", () => {
  for (const [verb, lists] of Object.entries(T0_PHRASES)) for (const p of [...lists.en, ...lists.es]) {
    assert.deepEqual(matchT0(p), { verb }, p);
    assert.deepEqual(matchT0(`Hey Crow, ${p}, please.`), { verb }, `polite: ${p}`);
  }
  assert.deepEqual(matchT0("Close the rice timer."), { verb: "close", name: "rice timer" });
  assert.deepEqual(matchT0("Cierra la lista"), { verb: "close", name: "lista" });
  assert.ok(T0_SLOTS.close.en.length && T0_SLOTS.close.es.length);
});

test("T0 table: sentences that only contain those words are not control phrases", () => {
  for (const q of ["Is the garage closed?", "What comes next in the alphabet?", "Close the door behind you when you leave the house tonight", "Who closed the deal?", "next week is busy", "¿Qué sigue después del lunes?", "Tell me a joke", "last step"]) assert.equal(matchT0(q), null, q);
});

test("T0: Spanish 'para el / para la' is a command only with a kind noun right after it", () => {
  assert.deepEqual(T0_KIND_SLOTS.close.es, ["para el", "para la"]);
  assert.ok(!T0_SLOTS.close.es.includes("para la") && !T0_SLOTS.close.es.includes("para el"));
  assert.deepEqual(matchT0("Para el temporizador"), { verb: "close", name: "temporizador" });
  assert.deepEqual(matchT0("Para la alarma de arroz"), { verb: "close", name: "alarma de arroz" });
  assert.equal(matchT0("Para la pasta"), null, "'for the pasta' is not a command");
  assert.equal(matchT0("Para el lunes"), null);
});

test("T0 fires only when its target exists: close and steps with nothing open go on to the model", async () => {
  const c = ctx();
  for (const q of ["close that", "close everything", "next step", "cierra eso", "read the step", "close the rice timer"]) assert.equal(await matchSpoken(q, c), null, q);
  c.store.open("d", RECIPE);
  const r = await matchSpoken("Next step, please.", c);
  assert.deepEqual({ say: r.say, tier: r.tier }, { say: "Step 2. Cook two minutes a side", tier: "t0" });
  assert.deepEqual(r.events.map((e) => `${e.type}:${e.action}`), ["wm:update"]);
  assert.equal((await matchSpoken("siguiente", c)).say, "Step 2. Cook two minutes a side", "bare next means the recipe while one is open (clamped at the last step)");
  assert.equal((await matchSpoken("Lee el paso otra vez", { ...c, lang: "es" })).say, "Paso 2. Cook two minutes a side");
  assert.equal((await matchSpoken("cierra eso", { ...c, lang: "es" })).say, "Cerrado.");
  assert.deepEqual(c.store.list("d"), []);
});

test("T0 close by name or kind: the named window goes, never another one", async () => {
  const c = ctx();
  c.store.open("d", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  c.store.open("d", { kind: "content", title: "Fruits", blocks: [] });
  assert.equal(await matchSpoken("close the pasta timer", c), null, "no such window: nothing closes, the model gets the turn");
  assert.equal(c.store.list("d").length, 2);
  assert.equal((await matchSpoken("close the rice timer", c)).say, "Timer stopped.");
  assert.deepEqual(c.store.list("d").map((w) => w.title), ["Fruits"]);
  assert.equal((await matchSpoken("close the list", c)).say, "Closed.");
});

test("T0 close matches a whole title or whole words of it — never part of a word", async () => {
  const c = ctx();
  c.store.open("d", { kind: "content", title: "Indoor plants", blocks: [] });
  c.store.open("d", { kind: "recipe", title: "Carrot cake", ingredients: [], steps: ["a"], step: 0 });
  c.store.open("d", { kind: "timer", name: "Pasta", title: "Pasta", seconds: 600 });
  for (const q of ["close the door", "stop the car", "close the plan", "Para la pasta", "close the cak"]) assert.equal(await matchSpoken(q, c), null, q);
  assert.equal(c.store.list("d").length, 3, "nothing was closed");
  assert.equal((await matchSpoken("close the plants", c)).say, "Closed.", "a whole word of the title");
  assert.equal((await matchSpoken("close the carrot cake", c)).say, "Closed.", "the whole title");
  assert.equal((await matchSpoken("Para el temporizador", { ...c, lang: "es" })).say, "Temporizador detenido.");
  assert.deepEqual(c.store.list("d"), []);
});

test("the model's own close call may still name part of a title (as in 0.1.8); only the no-model path is strict", async () => {
  const c = ctx();
  c.store.open("d", { kind: "content", title: "Indoor plants", blocks: [] });
  assert.equal((await executeIntent({ verb: "close", name: "plant" }, c)).outcome, "done");
});

test("a FINAL line is at most 120 characters (a recipe step is read in full); a NON-final message to the model is never cut", async () => {
  const long = "Stir slowly and steadily ".repeat(12).trim();
  const c = ctx();
  c.store.open("d", { ...RECIPE, steps: ["One", long] });
  assert.equal((await matchSpoken("next step", c)).say, `Step 2. ${long}`);
  const turn = { transcript: "show me a list" };
  const shown = await executeIntent({ verb: "show", kind: "list", title: "T".repeat(80) + " list of many things to pack for the trip", body: "a\nb" }, { ...c, turn });
  assert.ok(shown.final && shown.say.length <= SAY_MAX, shown.say);
  const cases = [
    [{ verb: "show", kind: "list", title: "Title", body: "a" }, "placeholder"],
    [{ verb: "show", kind: "timer", title: "Tea", body: "soon" }, "bad_timer"],
    [{ verb: "show", kind: "steps", title: "Tea", body: "" }, "bad_steps"],
    [{ verb: "show", kind: "video", title: "Tea", body: "x" }, "unsupported_window"],
  ];
  for (const [intent, reason] of cases) {
    const r = await executeIntent(intent, { ...c, turn });
    assert.deepEqual({ ok: r.ok, final: r.final, reason: r.reason }, { ok: false, final: false, reason });
    assert.equal(r.say, INVALID[reason], `${reason}: the whole message reaches the model`);
  }
  const none = await executeIntent({ verb: "show", kind: "text", title: "Capital", body: "Lisbon" }, { ...c, turn: { transcript: "What is the capital of Portugal?" } });
  assert.equal(none.say, INVALID.no_intent);
  for (const m of Object.values(INVALID)) assert.ok(/[.!]$/.test(m) && m.length > SAY_MAX - 60, "each ends on a full sentence");
  assert.ok(Object.values(INVALID).filter((m) => m.length > SAY_MAX).length >= 4, "most are longer than a spoken line: cutting them was the defect");
});

test("timers are never replaced: two timers with the same name both run; a card or recipe with the same title is updated", async () => {
  const c = ctx();
  const turn = { transcript: "set a timer" };
  const a = await executeIntent({ verb: "show", kind: "timer", title: "Timer", body: "10 minutes" }, { ...c, turn });
  const b = await executeIntent({ verb: "show", kind: "timer", title: "Timer", body: "45 seconds" }, { ...c, turn });
  assert.deepEqual([a.outcome, b.outcome], ["shown", "shown"]);
  assert.equal(b.say, "Timer set: 45 seconds.");
  assert.equal(c.store.list("d").filter((w) => w.kind === "timer").length, 2, "the first timer is still running");
  assert.deepEqual(b.events.map((e) => e.action), ["open"], "nothing was closed");
  const show = { transcript: "show me a list" };
  const l1 = await executeIntent({ verb: "show", kind: "list", title: "Fruits", body: "apple\npear" }, { ...c, turn: show });
  const l2 = await executeIntent({ verb: "show", kind: "list", title: "fruits", body: "apple\npear\ngrapes" }, { ...c, turn: show });
  assert.deepEqual([l1.outcome, l2.outcome, l2.say], ["shown", "updated", "I updated fruits."]);
  assert.equal(c.store.list("d").filter((w) => w.kind === "content").length, 1);
});

test("updating an open card needs no display word: the same title is an update; any other title on such a turn is still an echo card", async () => {
  const c = ctx();
  c.store.open("d", { kind: "content", title: "Fruits", blocks: [{ type: "heading", text: "Fruits" }, { type: "list", items: ["apple", "pear"] }] });
  const turn = { transcript: "Add grapes to the fruits list." };
  const other = await executeIntent({ verb: "show", kind: "list", title: "Groceries", body: "grapes" }, { ...c, turn });
  assert.equal(other.reason, "update_title", "revision 5: a follow-up under another title is sent back with the open card's title");
  assert.match(other.say, /Fruits/);
  const r = await executeIntent({ verb: "show", kind: "list", title: "Fruits", body: "apple\npear\ngrapes" }, { ...c, turn });
  assert.deepEqual({ ok: r.ok, outcome: r.outcome, final: r.final }, { ok: true, outcome: "updated", final: true });
  assert.deepEqual(c.store.list("d")[0].blocks[1].items, ["apple", "pear", "grapes"]);
});

test("T1 open: the verb at the START, a name that resolves on this display; anything else goes on", async () => {
  assert.deepEqual(parseOpen("Open the lab dashboard, please."), { name: "lab dashboard" });
  assert.deepEqual(parseOpen("Abre el panel del laboratorio"), { name: "panel del laboratorio" });
  assert.deepEqual(parseOpen("pull up the guide"), { name: "guide" });
  assert.equal(parseOpen("Is the garage open?"), null);
  assert.equal(parseOpen("I left the window open"), null);
  assert.equal(parseOpen("open"), null);
  assert.equal(parseOpen("pull up a list of fruits", { pull: false }), null, "at the model, pull up stays a card verb (0.1.8)");
  assert.equal(lookupItem(ITEMS, "lab dashboard").match.id, "lab_dashboard");
  assert.equal(lookupItem(ITEMS, "LAB").match.id, "lab_dashboard", "an alias, exact");
  assert.equal(lookupItem(ITEMS, "coding").match.id, "guide", "a unique prefix");
  assert.deepEqual(lookupItem(ITEMS, "lab").match.id, "lab_dashboard", "exact beats prefix");
  assert.equal(lookupItem(ITEMS, "windows"), null);
  assert.deepEqual(matchT1("open the windows", ctx({ items: ITEMS })), null);
  assert.deepEqual(matchT1("open coding", ctx({ items: ITEMS })), { verb: "open", app: "guide" });
});

test("T1 play: only the words are parsed here (the lookup arrives with the media session)", () => {
  assert.deepEqual(parsePlay("Play some jazz."), { what: "some jazz" });
  assert.deepEqual(parsePlay("Could you put on the Night Owls, please?"), { what: "night owls" });
  assert.deepEqual(parsePlay("Listen to Blue Lanterns"), { what: "blue lanterns" });
  assert.deepEqual(parsePlay("Pon música de salsa"), { what: "musica de salsa" });
  assert.deepEqual(parsePlay("Quiero escuchar la radio"), { what: "radio" });
  for (const q of ["Who plays the lead in that show?", "play", "Pon un temporizador de cinco minutos", "Put on the screen a list of fruits", "Pon en la pantalla una receta", "I want to play outside", "Ponme una lista de frutas"]) assert.equal(parsePlay(q), null, q);
});

test("offered is wider than must-run: a mention offers the tool; a request (imperative, or mention + cue, never a question) makes it run", () => {
  const play = (q) => [mentionsPlay(q), asksPlay(q)];
  for (const q of ["Play some jazz.", "I'd love some music, please.", "Could you find that album and start it?", "Let's have the radio on.", "Me pones algo de música.", "Quiero escuchar algo de salsa.", "How about some music?"]) assert.deepEqual(play(q), [true, true], q);
  for (const q of ["Do you like music?", "What's in the news?", "Who sings this song?", "¿Qué canción es esta?", "That song was lovely."]) assert.deepEqual(play(q), [true, false], q);
  for (const q of ["What is the capital of Portugal?", "Put a list on the screen, please.", "Set a timer for the music lesson.", "Who plays the lead in that show?", "I want to play outside."]) assert.deepEqual(play(q), [false, false], q);
  const open = (q) => [mentionsOpen(q, ITEMS), asksOpen(q, ITEMS)];
  for (const q of ["Open the lab dashboard.", "I need the lab notes up.", "Take me to the coding assistant guide.", "Can you start the photo viewer?", "Necesito ver el panel del laboratorio.", "Abre la guía."]) assert.deepEqual(open(q), [true, true], q);
  for (const q of ["What apps do you have?", "Is the lab dashboard working?", "Which app shows the weather?", "Is the garage open?", "I left the window open."]) assert.deepEqual(open(q), [true, false], q);
  for (const q of ["Start a timer for ten minutes.", "Open the recipe for lasagna.", "Start the music.", "What is the capital of Portugal?", "Tell me a joke."]) assert.deepEqual(open(q), [false, false], q);
  assert.deepEqual([mentionsOpen("Open the windows"), asksOpen("Open the windows")], [true, true], "the tool then answers truthfully (launcher → unavailable)");
});

test("compound: two requests in one sentence; a list of things joined by 'and' is one request", () => {
  for (const q of ["Close the timer and then show me a list of three fruits.", "Get rid of the timer and put the music back on.", "Show me a recipe for lasagna and set a timer for ten minutes.", "Cierra la lista y luego pon música.", "Stop the music, then open the lab dashboard.", "Close that and also show the wifi password."]) assert.equal(compound(q), true, q);
  for (const q of ["Show me a list of fruits and vegetables.", "A recipe for macaroni and cheese, please.", "Play rock and roll.", "Pon sal y pimienta en la lista.", "Close that.", "And then?", ""]) assert.equal(compound(q), false, q);
  assert.equal(compound("x and show ".repeat(200)), false, "over the cap: never a control decision");
  assert.deepEqual(compoundParts("Close the timer and then show me a list of three fruits."), ["close the timer", "show me a list of three fruits"]);
  assert.deepEqual(compoundParts("Get rid of the timer and put the music back on."), ["get rid of the timer", "put the music back on"]);
  assert.deepEqual(compoundParts("Show me a list of fruits and vegetables."), ["show me a list of fruits and vegetables"]);
  assert.deepEqual(compoundParts(""), []);
});

test("no model path answers a compound request: the whole sentence goes to the model", async () => {
  const c = ctx({ items: ITEMS });
  c.store.open("d", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  assert.equal(await matchSpoken("Close the timer and show fruits", c), null);
  assert.equal(await matchSpoken("Open the lab and then play jazz", c), null);
  assert.equal(c.store.list("d").length, 1);
});

test("the executor, as the tools use it: a missing target is a spoken success that changed nothing (effect false), never an error", async () => {
  const c = ctx();
  const r = await executeIntent({ verb: "close" }, c);
  assert.deepEqual({ ok: r.ok, outcome: r.outcome, say: r.say, final: r.final, effect: r.effect }, { ok: true, outcome: "nothing_open", say: "Nothing is open.", final: true, effect: false });
  assert.equal((await executeIntent({ verb: "close", name: "pasta timer" }, c)).say, "Nothing like that is open.");
  assert.deepEqual((({ outcome, effect }) => ({ outcome, effect }))(await executeIntent({ verb: "next_step" }, c)), { outcome: "nothing_open", effect: false });
  assert.equal((await executeIntent({ verb: "close_all" }, c)).effect, false);
  assert.deepEqual((({ ok, outcome, say }) => ({ ok, outcome, say }))(await executeIntent({ verb: "open", app: "launcher" }, c)), { ok: false, outcome: "unavailable", say: "I can't open that on this display." });
  assert.equal((await executeIntent({ verb: "play", what: "jazz" }, c)).outcome, "unavailable");
  const ch = await executeIntent({ verb: "choices", names: ["A", "B", "C"] }, c);
  assert.deepEqual([ch.say, ch.effect], ["I found A, B and C. Which one? Say its name.", false]);
  assert.equal((await executeIntent({ verb: "choices", names: ["A", "B"] }, { ...c, lang: "es" })).say, "Encontré A y B. ¿Cuál? Di su nombre.");
  c.store.open("d", { kind: "content", title: "Fruits", blocks: [] });
  assert.equal("effect" in (await executeIntent({ verb: "close" }, c)), false, "a real close has an effect");
});
