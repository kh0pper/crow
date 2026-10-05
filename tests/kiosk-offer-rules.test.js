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
