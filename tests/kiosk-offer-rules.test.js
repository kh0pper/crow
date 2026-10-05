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
  for (const say of ["Some reggae while we clean up.", "Un poco de bachata, ¿no?", "Some lo fi for studying would help.", "Hip hop for the workout.", "Classical, something calm.", "The old disco hits again."]) {
    assert.equal(mentionsPlay(say), true, say);
    assert.ok(tools().offered(say).includes("crow_play"), say);
  }
  assert.equal(asksPlay("I'd like some blues tonight."), true, "a genre with a request cue must run");
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
