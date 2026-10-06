/**
 * The held-out half of the evaluation: 20 utterances, the same shape as CASES in cases.mjs (ids h01–h20).
 *
 * RULES. Written by the main session AFTER the tool definitions (tools.js) and the word lists
 * (patterns.js, wm.js) are committed, by someone who has not read the descriptions' examples.
 * Nothing in the product is changed because of how these score. They are run once.
 * Until they are written this list is empty, and report.mjs refuses to give a verdict.
 */
import { make } from "./cases.mjs";

const { play, news, open, show, wm, card, recipe, timer } = make;
// The same "something is playing" state the 40 use (cases.mjs: PLAYING), for lines that need one.
const PLAYING = Object.freeze({ title: "Morning Mix", source: "radio" });
// The same sample recipe body the 40 use (cases.mjs: STEPS), for lines that need one.
const STEPS = "flour\neggs\n---\nMix the batter\nCook two minutes a side";

export const HELD_OUT = Object.freeze([
  { id: "h01", lang: "en", say: "Is there any chance of hearing the Copper Wren live album while I clean up?", expect: play(/copper\s*wren/i, { what: "Copper Wren live album", source: "music" }, { source: ["music", "auto"] }) },
  { id: "h02", lang: "es", say: "¿Me pones Radio Cardamomo un ratito?", expect: play(/cardamomo/i, { what: "Radio Cardamomo", source: "radio" }, { source: ["radio", "auto"] }) },
  { id: "h03", lang: "en", say: "Could we get the morning news on?", expect: news(/news|noticias/i) },
  { id: "h04", lang: "en", say: "Honestly I'd love some of Marisol Tejada's old boleros right now.", expect: play(/tejada/i, { what: "Marisol Tejada boleros", source: "music" }, { source: ["music", "auto"] }) },
  { id: "h05", lang: "en", say: "The kids keep asking for the Lantern Foxes record again.", expect: play(/lantern\s*foxes/i, { what: "Lantern Foxes", source: "music" }, { source: ["music", "auto"] }) },
  { id: "h06", lang: "en", say: "Where's my shopping list? I need to check it.", expect: open("shopping_list") },
  { id: "h07", lang: "es", say: "Ábreme el panel del laboratorio, quiero ver cómo va todo.", expect: open("lab_dashboard") },
  { id: "h08", lang: "en", say: "That coding assistant guide, can you pull it up?", expect: open("coding_guide") },
  { id: "h09", lang: "en", say: "Three minutes on the clock for the soft-boiled eggs, please.", expect: show("timer", { title: "Soft-boiled eggs", body: "3 minutes" }, { seconds: 180 }) },
  { id: "h10", lang: "en", say: "The steps for banana bread, I want to see them up there.", expect: show("steps", { title: "Banana bread", body: "3 ripe bananas\n1/3 cup melted butter\n3/4 cup sugar\n1 egg\n1 tsp baking soda\n1 1/2 cups flour\n---\nPreheat oven to 350°F\nMash the bananas and mix in the butter\nStir in sugar, egg and baking soda\nFold in the flour\nBake in a loaf pan about 60 minutes" }, { title: /banana/i }) },
  { id: "h11", lang: "en", state: { windows: [card("Shopping list")] }, say: "Eggs and butter need to go on that list too.", expect: show("list", { title: "Shopping list", body: "one\ntwo\neggs\nbutter" }, { sameTitle: "Shopping list", body: /^(?=[\s\S]*\bone\b)(?=[\s\S]*\btwo\b)(?=[\s\S]*\beggs?\b)(?=[\s\S]*\bbutter\b)/i }) },
  { id: "h12", lang: "es", say: "Muéstrame los pasos de la sopa de lentejas.", expect: show("steps", { title: "Sopa de lentejas", body: "1 taza de lentejas\n1 cebolla\n2 zanahorias\n1 litro de caldo\n---\nSofríe la cebolla y la zanahoria\nAñade las lentejas y el caldo\nCocina a fuego lento 30 minutos\nSazona y sirve" }, { title: /lentej/i }) },
  { id: "h13", lang: "en", state: { windows: [card("Shopping list")] }, say: "Oh, and tortillas and a bag of limes should go on there too.", expect: show("list", { title: "Shopping list", body: "one\ntwo\ntortillas\nlimes" }, { sameTitle: "Shopping list", body: /^(?=[\s\S]*\bone\b)(?=[\s\S]*\btwo\b)(?=[\s\S]*tortilla)(?=[\s\S]*\blimes?\b)/i }) },
  { id: "h14", lang: "en", say: "Just a note on screen saying dentist Thursday at four.", expect: show("text", { title: "Dentist", body: "Dentist Thursday at 4:00" }, { body: /thurs|four|\b4\b/i }) },
  { id: "h15", lang: "en", state: { windows: [recipe("Pancakes")] }, say: "Okay, we're done with the recipe, you can close it.", expect: wm("close", { name: "Pancakes" }, { name: /pancake|recipe/i }) },
  { id: "h16", lang: "en", state: { playing: { title: "Radio Cardamomo", source: "radio" } }, say: "Way too loud, bring it down a bit.", expect: wm("volume_down") },
  { id: "h17", lang: "es", state: { windows: [recipe("Pancakes")] }, say: "Siguiente paso, que tengo las manos llenas de harina.", expect: wm("next_step") },
  { id: "h18", lang: "en", state: { playing: { title: "Lantern Foxes", source: "music" } }, say: "Can we go back to the start of this song, I missed the first part.", expect: wm("previous") },
  { id: "h19", lang: "en", say: "How long do hard-boiled eggs stay good in the fridge?", expect: null },
  { id: "h20", lang: "es", say: "¿A qué temperatura se hornea el pollo entero?", expect: null },
]);
