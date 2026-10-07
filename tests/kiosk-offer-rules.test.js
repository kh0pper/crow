/**
 * Revision 4 of the WM1a offer rules (what the model is OFFERED; must-run is unchanged):
 *   (a) with any window open, crow_show and crow_wm are always offered (a follow-up needs no keyword);
 *   (b) crow_play is offered when a kind of music is named, even with no verb (a bounded category list);
 *   (c) crow_show is offered on a placement phrase, or a card noun after a determiner, outside a question.
 * Plain questions with no window open stay free of display tools. Examples are invented for these
 * categories; none is taken from an evaluation utterance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { createDisplayTools } from "../bundles/kiosk/server/display-tools.js";
import { mentionsPlay, mentionsCard, asksPlay, mentionsOpen } from "../bundles/kiosk/server/patterns.js";

const CAPS = { windows: ["timer", "recipe", "content"], max_windows: 4 };
function tools({ windows = [], sources = ["music", "radio", "news"], items = [{ id: "notes", title: "Kitchen notes" }] } = {}) {
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  for (const w of windows) store.open("d", w);
  const list = createDisplayTools({ store, deviceId: "d", caps: CAPS, lang: "en", sources, items, emit: () => {} });
  const by = Object.fromEntries(list.map((t) => [t.definition.name, t]));
  return { offered: (t) => list.filter((x) => typeof x.when !== "function" || x.when(t) === true).map((x) => x.definition.name), by };
}
const card = { kind: "content", title: "Groceries", blocks: [{ type: "heading", text: "Groceries" }, { type: "list", items: ["milk"] }] };
const timer = { kind: "timer", name: "Bread", title: "Bread", seconds: 300 };

test("(a) with a window open, a follow-up with no display word is offered crow_show and crow_wm, and nothing is required", () => {
  for (const [w, say] of [[card, "Throw butter in as well."], [card, "Swap the milk for oat milk."], [timer, "Better make that eight."], [timer, "Give it a couple more."]]) {
    const t = tools({ windows: [w] });
    const off = t.offered(say);
    assert.ok(off.includes("crow_show") && off.includes("crow_wm"), `${say}: ${off}`);
    assert.equal(t.by.crow_show.must(say), false, `${say}: offered, not required`);
  }
});

test("(a) with NO window open, plain questions are offered no display tool", () => {
  const t = tools();
  for (const say of ["What is the capital of Portugal?", "How long do I boil an egg?", "Tell me a short joke.", "¿Cuántos días tiene un año?", "What's on my list?", "What country has the most people?"]) {
    assert.deepEqual(t.offered(say), [], say);
  }
});

test("(b) a kind of music named with no verb offers crow_play; a genre with a request cue is must-run; words common outside music do not count alone", () => {
  for (const say of ["Some reggae while we clean up.", "Un poco de bachata, ¿no?", "Some lo fi for studying would help.", "Some hip hop for the workout.", "Classical, something calm.", "The old disco hits again."]) {
    assert.equal(mentionsPlay(say), true, say);
    assert.ok(tools().offered(say).includes("crow_play"), say);
  }
  assert.equal(asksPlay("I'd like some blues tonight."), false, "revision 5 (N1): a bare kind of music only offers, even with a request cue");
  assert.equal(asksPlay("I'd like some blues music tonight."), true, "a play word with a cue must run (revision 3)");
  assert.equal(asksPlay("Reggae is from Jamaica, right?"), false, "a question about a genre is offered, never required");
  for (const say of ["What country has the most people?", "Can you add salsa to the shopping?", "Pop the corn in the microwave.", "Is the house warm?", "My soul is tired."]) {
    assert.equal(mentionsPlay(say), false, say);
  }
  assert.equal(mentionsOpen("Open the jazz station"), false, "a genre makes it a play request, not an open request");
});

test("(c) a placement phrase or a card noun after a determiner offers crow_show; a question about a list does not, unless it also places it", () => {
  for (const say of ["The packing list, up there please.", "Put the bus times on the screen.", "Necesito una receta para el arroz.", "A timer for the cookies.", "The steps for the bread, please.", "Ponlo en la pantalla.", "Una lista de lo que hay que comprar."]) {
    assert.equal(mentionsCard(say), true, say);
    assert.ok(tools().offered(say).includes("crow_show"), say);
  }
  for (const say of ["What's on my list?", "Is there a timer running?", "Do you have a recipe for bread?", "List the planets.", "I need to text my mom.", "Open my kitchen notes list."]) {
    assert.equal(mentionsCard(say, [{ id: "notes", title: "Kitchen notes list" }]), false, say);
  }
  assert.equal(mentionsCard("How do I make bread? Put the steps up there."), true, "a placement phrase counts inside a question");
});

test("offer rules never make a plain question must-run, and the forced first round is unchanged", () => {
  const t = tools({ windows: [card] });
  assert.equal(t.by.crow_show.must("What is the capital of Portugal?"), false);
  assert.equal(t.by.crow_show.must("Show me a list of chores."), true, "must-run stays the new-content and change rules");
});

// ── Revision 5 ───────────────────────────────────────────────────────────────────────────────────
import { createDisplayTools as makeTools } from "../bundles/kiosk/server/display-tools.js";
import { showIntent, followUp } from "../bundles/kiosk/server/patterns.js";

function live({ windows = [] } = {}) {
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  for (const w of windows) store.open("d", w);
  const list = makeTools({ store, deviceId: "d", caps: CAPS, lang: "en", sources: ["music", "radio", "news"], items: [{ id: "notes", title: "Kitchen notes" }], emit: () => {} });
  const by = Object.fromEntries(list.map((t) => [t.definition.name, t]));
  const run = async (name, args, transcript) => JSON.parse(await by[name].execute(args, { transcript }));
  return { store, by, run, offered: (t) => list.filter((x) => x.when(t) === true).map((x) => x.definition.name) };
}
const snapshot = (store) => JSON.stringify(store.list("d").map((w) => ({ kind: w.kind, title: w.title, blocks: w.blocks, seconds: w.seconds, steps: w.steps })));

test("H1: offer ⇒ executable — whenever crow_show is offered for a NEW card on a turn with no window open, the executor accepts a sane card", async () => {
  const asks = ["Put the bus times on the screen.", "The packing list, up there please.", "A list of what to buy for the picnic.", "Una lista de regalos para la fiesta: globos, pastel.",
    "My list for the hardware store: nails, glue, tape.", "Lista de tareas para el sábado.", "The steps for the bread, please.", "Throw the train times up on the screen.", "Necesito una receta para el arroz."];
  for (const say of asks) {
    const d = live();
    assert.ok(d.offered(say).includes("crow_show"), `${say}: offered`);
    assert.equal(showIntent(say, [{ id: "notes", title: "Kitchen notes" }]), true, say);
    const r = await d.run("crow_show", { kind: "list", title: "Things", body: "one\ntwo\nthree" }, say);
    assert.equal(r.outcome, "shown", `${say}: offered, so the card can go up (got ${r.reason || r.outcome})`);
  }
});

test("H2: with a window open, a plain question never changes the screen — a copied title, a recipe and a timer are all refused, and the screen is unchanged", async () => {
  const groceries = { kind: "content", title: "Groceries", blocks: [{ type: "heading", text: "Groceries" }, { type: "list", items: ["milk"] }] };
  const bread = { kind: "timer", name: "Bread", title: "Bread", seconds: 300 };
  const soup = { kind: "recipe", title: "Soup", ingredients: ["water"], steps: ["boil", "serve"], step: 0 };
  const cases = [
    [groceries, "What's the capital of Portugal?", { kind: "list", title: "Groceries", body: "Lisbon" }],
    [groceries, "How tall is Mount Everest?", { kind: "steps", title: "Everest", body: "climb\n---\nup" }],
    [bread, "Who wrote Pride and Prejudice?", { kind: "timer", title: "Austen", body: "5 minutes" }],
    [bread, "How far is the moon?", { kind: "timer", title: "Bread", body: "10 minutes" }],
    [soup, "¿Cuántos días tiene un año bisiesto?", { kind: "steps", title: "Soup", body: "x\n---\ny" }],
    [soup, "What year did the war end?", { kind: "text", title: "Soup", body: "1945" }],
  ];
  for (const [w, say, args] of cases) {
    const d = live({ windows: [w] });
    const before = snapshot(d.store);
    assert.ok(d.offered(say).includes("crow_show"), `${say}: offered (rule a)`);
    assert.equal(d.by.crow_show.must(say), false);
    const r = await d.run("crow_show", args, say);
    assert.equal(r.ok, false, `${say}: refused (${r.reason})`);
    assert.ok(["no_intent", "update_title"].includes(r.reason), r.reason);
    assert.equal(snapshot(d.store), before, `${say}: the screen is unchanged`);
  }
});

test("H2: a follow-up to the open window changes it — the card under its own title, the running timer (one timer, not two)", async () => {
  const groceries = { kind: "content", title: "Groceries", blocks: [{ type: "heading", text: "Groceries" }, { type: "list", items: ["milk"] }] };
  const d = live({ windows: [groceries] });
  const up = await d.run("crow_show", { kind: "list", title: "Groceries", body: "milk\nbutter" }, "Throw butter in as well.");
  assert.equal(up.outcome, "updated");
  const other = await d.run("crow_show", { kind: "list", title: "Grocery list", body: "milk\nbutter\neggs" }, "Eggs too.");
  assert.deepEqual([other.reason, /Groceries/.test(other.say)], ["update_title", true], "a near-miss title is sent back with the right one");
  const t = live({ windows: [{ kind: "timer", name: "Bread", title: "Bread", seconds: 300 }] });
  const r = await t.run("crow_show", { kind: "timer", title: "Bread", body: "8 minutes" }, "Better make that eight minutes instead.");
  assert.equal(r.outcome, "updated");
  const timers = t.store.list("d").filter((w) => w.kind === "timer");
  assert.equal(timers.length, 1, "the running timer was changed, not doubled");
  assert.equal(followUp("Is the bread done?"), false, "a question is never a follow-up");
});

test("H3: no false offers on ordinary conversation — a kind of music in a question or an information request, a place phrase in a question, a statement about a list", () => {
  const t = live();
  for (const say of ["Tell me about the history of reggae.", "Where does tango come from?", "Is flamenco hard to learn?", "Háblame del bolero.", "Explain what bebop means.",
    "Is it cold up there in the mountains?", "What's on the TV tonight?", "The list my sister made is long.", "The eighties were wild.", "My piano teacher is sick."]) {
    assert.deepEqual(t.offered(say), [], say);
  }
});

test("H3: a wider offer never holds the spoken answer — text is held only on the narrower tests (a request cue, a display word)", () => {
  const d = live();
  assert.equal(d.by.crow_play.when("Some reggae while we clean up."), true, "offered");
  assert.equal(d.by.crow_play.holdText("Some reggae while we clean up."), false, "but the answer still streams");
  assert.equal(d.by.crow_play.holdText("I'd like some reggae."), false, "revision 5 (N1): a bare kind of music never holds, cue or not");
  assert.equal(d.by.crow_play.holdText("I'd like some reggae music."), true, "a play word with a cue holds, as in revision 3");
  assert.equal(d.by.crow_show.when("The packing list up there."), true);
  assert.equal(d.by.crow_show.holdText("The packing list up there."), false);
  const w = live({ windows: [{ kind: "timer", name: "Bread", title: "Bread", seconds: 300 }] });
  assert.equal(w.by.crow_show.holdText("What is the capital of Portugal?"), false, "a window being open never holds a plain answer");
});

test("M1: moods, decades, instruments and the ambiguous genres offer crow_play only inside a request frame", () => {
  const t = live();
  for (const say of ["Something upbeat, please.", "Some piano while I read.", "Some 80s for the drive.", "Algo romántico para la cena.", "A little chill electronic would be nice.", "Some country while we cook.", "Un poco de salsa, ¿va?", "White noise for the baby, please."]) {
    assert.ok(t.offered(say).includes("crow_play"), say);
  }
  for (const say of ["The salsa needs more lime.", "Which country is the biggest?", "My soul is tired.", "The 80s had great cars.", "Upbeat people are nice."]) {
    assert.ok(!t.offered(say).includes("crow_play"), say);
  }
});

// ── Revision 5, after its re-review ──────────────────────────────────────────────────────────────
test("N1: a bare kind of music only OFFERS crow_play — a request for something calm/classic/romantic that is not music is never must-run, forced or held", () => {
  const t = live();
  for (const say of ["Could you suggest some classics for my book club?", "I want a romantic spot for our anniversary dinner.", "Necesito algo tranquilo para la siesta.",
    "Please make the email sound a bit more upbeat.", "Can you give me some guitar shopping advice?", "I'd like something cheerful to read on the train.", "Let's find some calm activities for the kids."]) {
    assert.equal(t.by.crow_play.must(say), false, `${say}: not must-run`);
    assert.equal(asksPlay(say), false, say);
    assert.equal(t.by.crow_play.holdText(say), false, `${say}: the answer is never held`);
  }
  assert.equal(t.by.crow_play.must("Play some calm piano."), true, "a play verb is still must-run");
  assert.equal(t.by.crow_play.must("I'd like some jazz music, please."), true, "a play word with a cue is still must-run (revision 3)");
});

test("N2: with a window open, an information request or a statement never counts as a follow-up — a copied title is refused and the screen is unchanged", async () => {
  const groceries = { kind: "content", title: "Groceries", blocks: [{ type: "heading", text: "Groceries" }, { type: "list", items: ["milk"] }] };
  const bread = { kind: "timer", name: "Bread", title: "Bread", seconds: 300 };
  const soup = { kind: "recipe", title: "Soup", ingredients: ["water"], steps: ["boil", "serve"], step: 0 };
  const cases = [
    [groceries, "Tell me more about volcanoes.", { kind: "list", title: "Groceries", body: "lava" }],
    [groceries, "Dime la población de Chile.", { kind: "list", title: "Groceries", body: "19 millones" }],
    [groceries, "Tell me a riddle about that.", { kind: "text", title: "Groceries", body: "a riddle" }],
    [bread, "Explain how that oven setting works.", { kind: "timer", title: "Bread", body: "9 minutes" }],
    [groceries, "Give me another example of a mammal.", { kind: "list", title: "Groceries", body: "whale" }],
    [soup, "Tell me something interesting about it.", { kind: "steps", title: "Soup", body: "a\n---\nb" }],
    [groceries, "Explícame las reglas del ajedrez.", { kind: "list", title: "Groceries", body: "peón" }],
    [groceries, "I wonder if the store is open later.", { kind: "list", title: "Groceries", body: "maybe" }],
    [groceries, "My neighbour said that too.", { kind: "list", title: "Groceries", body: "ok" }],
    [groceries, "La tienda cierra temprano los domingos.", { kind: "list", title: "Groceries", body: "domingo" }],
  ];
  for (const [w, say, args] of cases) {
    const d = live({ windows: [w] });
    const before = snapshot(d.store);
    assert.equal(followUp(say), false, `${say}: not a follow-up`);
    const r = await d.run("crow_show", args, say);
    assert.equal(r.ok, false, `${say}: refused (${r.reason || r.outcome})`);
    assert.equal(snapshot(d.store), before, `${say}: the screen is unchanged`);
  }
});

test("N2: real edits to the open card or timer are follow-ups and go through", async () => {
  const groceries = () => ({ kind: "content", title: "Groceries", blocks: [{ type: "heading", text: "Groceries" }, { type: "list", items: ["milk", "eggs"] }] });
  for (const say of ["Scratch the eggs.", "Lose the milk, we have some.", "Cross off the eggs.", "Take the milk off.", "Drop the eggs from it.", "Quita la leche.", "Tacha los huevos.", "Borra la leche, ya hay.", "Cámbialo a leche de avena.", "Oat milk too.", "Put bread on it as well."]) {
    assert.equal(followUp(say), true, say);
    const d = live({ windows: [groceries()] });
    const r = await d.run("crow_show", { kind: "list", title: "Groceries", body: "bread" }, say);
    assert.equal(r.outcome, "updated", `${say}: ${r.reason || r.outcome}`);
  }
  const t = live({ windows: [{ kind: "timer", name: "Bread", title: "Bread", seconds: 300 }] });
  assert.equal((await t.run("crow_show", { kind: "timer", title: "Bread", body: "12 minutes" }, "Make it twelve.")).outcome, "updated");
  assert.equal(t.store.list("d").filter((x) => x.kind === "timer").length, 1);
});

// ── Revision 6 ───────────────────────────────────────────────────────────────────────────────────
import { windowIntent } from "../bundles/kiosk/server/patterns.js";

function liveWm({ windows = [], playing = false } = {}) {
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  for (const w of windows) store.open("d", w);
  const media = { active: () => playing };
  const list = makeTools({ store, deviceId: "d", caps: CAPS, lang: "en", sources: ["music", "radio", "news"], items: [], emit: () => {}, media,
    mediaVerb: () => (playing ? { ok: true, outcome: "done", say: "Okay.", final: true, events: [] } : { ok: true, outcome: "nothing_playing", say: "Nothing is playing.", final: true, effect: false, events: [] }) });
  const wm = list.find((t) => t.definition.name === "crow_wm");
  return { store, run: async (args, transcript) => JSON.parse(await wm.execute(args, { transcript })) };
}
const W_CARD = { kind: "content", title: "Frutas", blocks: [{ type: "heading", text: "Frutas" }, { type: "list", items: ["manzana"] }] };
const W_TIMER = { kind: "timer", name: "Eggs", title: "Eggs", seconds: 300 };
const W_RECIPE = { kind: "recipe", title: "Pancakes", ingredients: ["flour"], steps: ["mix", "cook", "serve"], step: 0 };

test("rev 6 (screen guard parity): a plain question with a window open never closes or steps anything, whatever crow_wm call the model makes", async () => {
  const cases = [[W_CARD, "¿Cuál es el río más largo del mundo?"], [W_CARD, "Dime un dato curioso sobre los pulpos."], [W_TIMER, "What's the tallest building in Asia?"],
    [W_TIMER, "Tell me a fun fact about owls."], [W_RECIPE, "How many ounces are in a pound?"], [W_RECIPE, "Recommend a good movie for tonight."], [W_CARD, "Mi hermana llega mañana a las seis."]];
  for (const [w, say] of cases) for (const args of [{ do: "close" }, { do: "close_all" }, { do: "next_step" }, { do: "previous_step" }, { do: "next" }, { command: "close all" }]) {
    const d = liveWm({ windows: [w] });
    const before = snapshot(d.store);
    const r = await d.run(args, say);
    assert.equal(r.ok === true && r.effect !== false && r.outcome !== "nothing_open", false, `${say} ${JSON.stringify(args)}: ${r.outcome}/${r.reason}`);
    assert.equal(snapshot(d.store), before, `${say} ${JSON.stringify(args)}: unchanged`);
  }
});

test("rev 6: real window requests still work — close, clear them all, quítala, next step, done with it; 'next' while music plays is playback", async () => {
  for (const [w, say, args, outcome] of [[W_CARD, "Quítala, ya no la necesito.", { do: "close" }, "done"], [W_TIMER, "Close that.", { do: "close" }, "done"], [W_CARD, "Clear them all.", { do: "close_all" }, "done"],
    [W_RECIPE, "Next step.", { do: "next_step" }, "done"], [W_CARD, "I'm done with it now.", { do: "close" }, "done"], [W_RECIPE, "Go back one.", { do: "previous_step" }, "done"], [W_CARD, "Ciérrala.", { do: "close" }, "done"]]) {
    assert.equal(windowIntent(say), true, say);
    const d = liveWm({ windows: [w] });
    const r = await d.run(args, say);
    assert.equal(r.outcome, outcome, `${say}: ${r.outcome}/${r.reason}`);
  }
  const p = liveWm({ windows: [W_CARD], playing: true });
  assert.equal((await p.run({ do: "next" }, "Ugh, not this one.")).outcome, "done", "'next' with something playing goes to the media session");
});

test("rev 6 (pre-filter categories): a name-on frame offers play, the launcher offers open, a countdown with a duration offers show, a card form or a hedge offers show", () => {
  const t = live();
  for (const say of ["Let's have Juniper Lane on while we eat.", "Put the Silver Owls on before the guests arrive.", "Something by Rio Calloway, please.", "Get Mara Quist on for a bit."]) assert.ok(t.offered(say).includes("crow_play"), say);
  for (const say of ["Is there a timer app in the launcher?", "Is there a unit converter somewhere in the launcher? I need it for this recipe.", "Open the launcher."]) assert.ok(t.offered(say).includes("crow_open"), say);
  for (const say of ["The pasta needs twelve minutes, count that down for me.", "Avísame en cinco minutos.", "Remind me in twenty minutes to flip the steak.", "Count it down from three minutes."]) assert.ok(t.offered(say).includes("crow_show"), say);
  for (const say of ["Todo lo de la compra, en una lista si se puede.", "The chores for Saturday as a list.", "Ingredients for a tortilla, in a list please.", "Lo que falta para el pastel, en forma de lista."]) assert.ok(t.offered(say).includes("crow_show"), say);
});

test("rev 6: the new categories stay out of plain conversation with no window open", () => {
  const t = live();
  for (const say of ["Who is on the team this year?", "My brother has his boots on already.", "What does a launcher do in a rocket?", "How long should I count when I breathe in?", "Remind me who won the game last night.",
    "Is it on the list of holidays?", "Can you tell me a story about owls?", "¿Qué tiempo hace en Lima?"]) {
    assert.deepEqual(t.offered(say), [], say);
  }
});

test("rev 6: a countdown request the offer accepts is also accepted by the executor (offer ⇒ executable)", async () => {
  const d = live();
  for (const say of ["The pasta needs twelve minutes, count that down for me.", "Avísame en cinco minutos."]) {
    const r = await d.run("crow_show", { kind: "timer", title: "Pasta", body: "12 minutes" }, say);
    assert.equal(r.outcome, "shown", `${say}: ${r.reason || r.outcome}`);
  }
});

// ── Revision 6, after its re-review ──────────────────────────────────────────────────────────────
import { spokenWords } from "../bundles/kiosk/server/phrases.js";

test("R6-1: contractions are statements — 'we're / you're / they're' never read as the question opener 'were'", async () => {
  assert.deepEqual(spokenWords("We're out of eggs").slice(0, 3), ["we", "are", "out"]);
  assert.deepEqual(spokenWords("They’re here")?.slice(0, 2), ["they", "are"]);
  assert.equal(spokenWords("Were you there?")[0], "were", "a real 'were' question is unchanged");
  assert.equal(followUp("We're out of butter, add it."), true);
  const d = live({ windows: [{ kind: "content", title: "Groceries", blocks: [{ type: "heading", text: "Groceries" }, { type: "list", items: ["milk"] }] }] });
  assert.equal((await d.run("crow_show", { kind: "list", title: "Groceries", body: "milk\nbutter" }, "We're out of butter, add it.")).outcome, "updated");
});

test("R6-1: closing and stepping phrases by category are window requests (16 shapes)", async () => {
  const card = { kind: "content", title: "Frutas", blocks: [{ type: "heading", text: "Frutas" }, { type: "list", items: ["pera"] }] };
  const recipe = { kind: "recipe", title: "Waffles", ingredients: ["flour"], steps: ["mix", "pour", "flip", "serve"], step: 1 };
  const reqs = [[card, "We're finished with that list.", "close"], [card, "I'm done with the card now.", "close"], [card, "Take it down, please.", "close"], [card, "Take that off the screen.", "close"],
    [card, "Get that off the screen.", "close"], [card, "I don't need that anymore.", "close"], [card, "We don't need this list anymore.", "close"], [card, "Ya no la necesito, quítala.", "close"],
    [card, "Clear everything off.", "close_all"], [card, "Close all of them.", "close_all"], [recipe, "What's after this?", "next_step"], [recipe, "Keep going.", "next_step"],
    [recipe, "Next step, please.", "next_step"], [recipe, "Go back one step.", "previous_step"], [recipe, "¿Qué sigue?", "next_step"], [card, "Ciérrala ya.", "close"]];
  for (const [w, say, verb] of reqs) {
    assert.equal(windowIntent(say), true, say);
    const d = liveWm({ windows: [w] });
    const r = await d.run({ do: verb }, say);
    assert.equal(r.outcome, "done", `${say}: ${r.outcome}/${r.reason}`);
  }
});

test("R6-2: a window word inside an ordinary statement or question does not let a close or a step through", async () => {
  const card = { kind: "content", title: "Frutas", blocks: [{ type: "heading", text: "Frutas" }, { type: "list", items: ["pera"] }] };
  const recipe = { kind: "recipe", title: "Waffles", ingredients: ["flour"], steps: ["mix", "pour", "flip"], step: 0 };
  const plain = ["The next bus comes at seven.", "Paso por la tienda después del trabajo.", "Siguiente tema: el clima de mañana.", "I need to clear my mind tonight.", "Is the timer almost done?",
    "Remove the stain with vinegar, my grandma says.", "Cancel culture is everywhere these days.", "The previous owner painted it blue.", "Tell me how to close a bank account.",
    "We're going back to Peru in May.", "Did you see the step count today?", "Limpiaron toda la calle ayer.", "The recipe was my aunt's.", "She cleared the table already.", "My next class is at noon.", "Hide and seek is fun."];
  let refused = 0;
  for (const say of plain) {
    for (const [w, args] of [[card, { do: "close" }], [recipe, { do: "next_step" }]]) {
      const d = liveWm({ windows: [w] });
      const before = snapshot(d.store);
      await d.run(args, say);
      if (snapshot(d.store) === before) refused += 1;
    }
  }
  assert.equal(refused, plain.length * 2, `refused ${refused} of ${plain.length * 2}`);
});

test("R6-3: countdown and card-form rules need a request frame — statements never create a window, and the executor refuses them", async () => {
  const t = live();
  for (const say of ["La cuenta del restaurante fue de treinta minutos de espera.", "Me di cuenta a los cinco minutos.", "Time it right and the dough rises in two hours.",
    "I'm in a list of finalists for the prize.", "Our names are in a list at the door.", "Mi nombre está en la lista desde hace dos horas."]) {
    assert.ok(!t.offered(say).includes("crow_show"), `${say}: not offered`);
    const r = await t.run("crow_show", { kind: "timer", title: "X", body: "5 minutes" }, say);
    assert.equal(r.ok, false, `${say}: refused`);
  }
  for (const say of ["Cuenta diez minutos para el arroz.", "Count down fifteen minutes, please.", "The guest list as a list.", "Lo de la compra en una lista, si se puede."]) assert.ok(t.offered(say).includes("crow_show"), say);
});

test("R6-4/5: household 'put … on' is not a name to play; 'what's new in the apps' is not about opening", () => {
  const t = live();
  for (const say of ["Put the kettle on, I'm cold.", "Have your coat on before you go.", "Put the heating on for a bit."]) assert.ok(!t.offered(say).includes("crow_play"), say);
  assert.equal(t.by.crow_open.holdText("What's new in the apps this week?"), false, "offered (an app word), never held");
});

// ── Revision 6b probe re-check ───────────────────────────────────────────────────────────────────
test("6b-1: the K1 command form that closes or steps needs the window test alone — a card-ish question does not let it through", async () => {
  const d = liveWm({ windows: [W_TIMER] });
  const before = snapshot(d.store);
  for (const command of ["close", "close all", "next step", "close timer"]) {
    const r = await d.run({ command }, "How long is a timer for soft eggs usually?");
    assert.equal(r.ok === true, false, command);
    assert.equal(snapshot(d.store), before, `${command}: unchanged`);
  }
  assert.equal((await liveWm({ windows: [W_TIMER] }).run({ command: "close timer" }, "Close the timer.")).ok, true, "a real close through the K1 form still works");
});

test("6b-2: 'done / finished / through with' close only when a window word or pronoun follows", async () => {
  for (const say of ["I'm done with work for today.", "We're finished with dinner, finally.", "She's through with school next year.", "Ya terminé con la tarea de mi hijo."]) {
    assert.equal(windowIntent(say), false, say);
    const d = liveWm({ windows: [W_CARD] });
    const before = snapshot(d.store);
    await d.run({ do: "close" }, say);
    assert.equal(snapshot(d.store), before, say);
  }
  for (const say of ["I'm done with it.", "Finished with that list, thanks.", "Ya terminé con la lista."]) assert.equal(windowIntent(say), true, say);
});

test("6b-3: stepping phrases — back one step, back a step, what's the next one, next one", async () => {
  for (const [say, verb] of [["Back one step, I missed it.", "previous_step"], ["Go back a step.", "previous_step"], ["What's the next step?", "next_step"], ["Next one, my hands are sticky.", "next_step"], ["Previous one please.", "previous_step"]]) {
    assert.equal(windowIntent(say), true, say);
    const d = liveWm({ windows: [{ ...W_RECIPE, step: 1 }] });
    assert.equal((await d.run({ do: verb }, say)).outcome, "done", say);
  }
  assert.equal(windowIntent("Cancel one of my meetings tomorrow."), false, "'one' is an object only for next/previous");
});

// ── Revision 7 ───────────────────────────────────────────────────────────────────────────────────
import { teachTo } from "../bundles/kiosk/server/patterns.js";

function liveEs(items) {
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  const list = makeTools({ store, deviceId: "d", caps: CAPS, lang: "es", sources: ["music", "radio", "news"], items, emit: () => {} });
  const by = Object.fromEntries(list.map((t) => [t.definition.name, t]));
  return { by, offered: (t) => list.filter((x) => x.when(t) === true).map((x) => x.definition.name), must: (t) => list.find((x) => typeof x.must === "function" && x.must(t) === true)?.definition.name || null };
}
const ES_ITEMS = [{ id: "recetario", title: "Recetario familiar", aliases: ["recetario"] }, { id: "garden", title: "Garden planner", aliases: ["plan del jardín"] }];

test("rev 7: Spanish 'show me' verbs open one of the display's items — open is offered and must-run, never shadowed by a card", () => {
  const t = liveEs(ES_ITEMS);
  for (const say of ["Enséñame el recetario familiar.", "¿Me enseñas el plan del jardín?", "Muéstrame el recetario, porfa.", "¿Me muestras el plan del jardín un momento?"]) {
    assert.ok(t.offered(say).includes("crow_open"), `${say}: offered`);
    assert.equal(t.must(say), "crow_open", `${say}: open is the must-run tool`);
  }
  assert.equal(t.must("Muéstrame una lista de tres frutas."), "crow_show", "no item named: a card, as before");
});

test("rev 7: 'me enseñas a …' is 'teach me to' — no display tool, nothing required; questions about teaching too", () => {
  const t = liveEs(ES_ITEMS);
  for (const say of ["¿Me enseñas a hacer tortillas?", "Enséñame a contar en francés.", "¿Quién te enseñó a cocinar?", "Mi abuela me enseñó a coser."]) {
    assert.deepEqual(t.offered(say), [], say);
    assert.equal(t.must(say), null, say);
  }
  assert.equal(teachTo("¿Me enseñas a bailar salsa?"), true);
  assert.equal(teachTo("¿Me enseñas la receta?"), false);
});

test("rev 7 INVARIANT in code: for every tool and every sentence, must(t) implies when(t)", () => {
  const t = liveEs(ES_ITEMS);
  for (const say of ["Enséñame el recetario familiar.", "Play some jazz.", "Show me a list of chores.", "¿Me enseñas a hacer tortillas?", "What time is it?", "Put on the radio.", "Abre el recetario."]) {
    for (const x of Object.values(t.by)) if (typeof x.must === "function" && x.must(say)) assert.equal(x.when(say), true, `${x.definition.name}: ${say}`);
  }
});

test("R7-1: with a window open, 'teach me to …' never closes or steps it, and the window tool does not hold the answer", async () => {
  const cases = [[W_RECIPE, "Enséñame a doblar la masa, porfa."], [W_TIMER, "¿Me enseñas a usar el temporizador?"], [W_CARD, "Me enseñas a decir gracias en francés."],
    [W_RECIPE, "¿Me enseñas a picar la cebolla sin llorar?"], [W_CARD, "Enséñame a escribir esta lista en inglés."], [W_TIMER, "Enséñanos a jugar al ajedrez."]];
  for (const [w, say] of cases) {
    assert.equal(windowIntent(say), false, say);
    for (const args of [{ do: "close" }, { do: "close_all" }, { do: "next_step" }, { do: "previous_step" }]) {
      const d = liveWm({ windows: [w] });
      const before = snapshot(d.store);
      await d.run(args, say);
      assert.equal(snapshot(d.store), before, `${say} ${args.do}: unchanged`);
    }
  }
  const t = liveEs(ES_ITEMS);
  assert.equal(t.by.crow_wm.holdText("¿Me enseñas a usar el temporizador?"), false);
});

test("r7 G3: with radio presets, a sentence that asks to play a station is offered crow_play even when STT mangled it ('Playing, KDEB.', 'KTPF please', 'Like, APFT.'); questions and other displays are not", () => {
  const t = tools();
  for (const say of ["Playing, KDEB.", "KTPF please.", "Like, APFT.", "Lake APFD HD1.", "Plays KDBV.", "Played KTPF."]) assert.ok(t.offered(say).includes("crow_play"), say);
  for (const say of ["What's playing?", "Who played the lead in that film?", "Is the TV on?", "What is the capital of Portugal?", "Tell me a short joke."]) assert.ok(!t.offered(say).includes("crow_play"), say);
  const noRadio = tools({ sources: ["music"] });
  for (const say of ["KTPF please.", "Like, APFT."]) assert.ok(!noRadio.offered(say).includes("crow_play"), `no radio presets: ${say}`);
  // Offered only: nothing becomes must-run by it.
  assert.equal(t.by.crow_play.must("Playing, KDEB."), false);
});
