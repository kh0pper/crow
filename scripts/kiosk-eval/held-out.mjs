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
  { id: "h01", lang: "en", say: "Something mellow while I chop onions would be nice.", expect: play(/mellow|chill|calm|relax|soft|acoustic|jazz|lo-?fi/i, { what: "mellow music", source: "music" }, { source: ["music", "radio", "auto"] }) },
  { id: "h02", lang: "es", say: "Ponme la radio, la de las noticias de la mañana.", expect: news(/noticias|news|mañana|morning/i) },
  { id: "h03", lang: "en", say: "Any chance we could get the news on?", expect: news(/news|noticias/i) },
  { id: "h04", lang: "en", say: "I'm in the mood for some old Motown.", expect: play(/motown/i, { what: "old Motown", source: "music" }, { source: ["music", "radio", "auto"] }) },
  { id: "h05", lang: "es", say: "Algo de salsa para cocinar, por favor.", expect: play(/salsa/i, { what: "salsa", source: "music" }, { source: ["music", "radio", "auto"] }) },
  { id: "h06", lang: "en", say: "Where's that shopping list of ours?", expect: open("shopping_list") },
  { id: "h07", lang: "en", say: "Can I see the panel del laboratorio for a sec?", expect: open("lab_dashboard") },
  { id: "h08", lang: "en", say: "The coding assistant guide, pull that up for me.", expect: open("coding_guide") },
  { id: "h09", lang: "en", say: "How do I make pancakes again, step by step?", expect: show("steps", { title: "Pancakes", body: "flour\nmilk\neggs\n---\nWhisk the dry ingredients\nAdd milk and eggs\nCook on a hot griddle" }, { title: /pancake/i }) },
  { id: "h10", lang: "en", say: "A ten-minute timer for the pasta, please.", expect: show("timer", { title: "Pasta", body: "10 minutes" }, { title: /pasta/i, seconds: 600 }) },
  { id: "h11", lang: "es", say: "¿Me pones los ingredientes de la tortilla de patatas en una lista?", expect: show(["list", "steps"], { title: "Tortilla de patatas", body: "patatas\nhuevos\ncebolla\naceite de oliva\nsal" }, { title: /tortilla/i, body: /huevo|patata/i }) },
  { id: "h12", lang: "en", say: "Actually make that fifteen minutes instead.", state: { windows: [timer("Pasta")] }, expect: show("timer", { title: "Pasta", body: "15 minutes" }, { sameTitle: "Pasta", seconds: 900 }) },
  { id: "h13", lang: "en", say: "Chicken bakes at 200 degrees, show those numbers big.", expect: show(["text", "list"], { title: "Chicken", body: "200°" }, { body: /200/ }) },
  { id: "h14", lang: "en", say: "Oh, and garlic goes on there too.", state: { windows: [card("Soup ingredients")] }, expect: show("list", { title: "Soup ingredients", body: "a\nb\ngarlic" }, { sameTitle: "Soup ingredients", body: /garlic/i }) },
  { id: "h15", lang: "en", say: "That's way too loud.", state: { playing: { title: "Jazz radio", source: "radio" } }, expect: wm("volume_down") },
  { id: "h16", lang: "en", say: "Okay, I'm ready for the next step.", state: { windows: [recipe("Pancakes")] }, expect: wm("next_step", { name: "Pancakes" }, { name: /pancake/i }) },
  { id: "h17", lang: "es", say: "Esa ventana del temporizador ya sobra, ciérrala.", state: { windows: [timer("Pasta")] }, expect: wm("close", { name: "Pasta" }, { name: /pasta|timer|temporizador/i }) },
  { id: "h18", lang: "en", say: "Not this one, I can't stand it.", state: { playing: { title: "Pop playlist", source: "music" } }, expect: wm("next") },
  { id: "h19", lang: "en", say: "Is it safe to freeze cooked rice and eat it later?", expect: null },
  { id: "h20", lang: "es", say: "Oye, ¿el aguacate es fruta o verdura?", expect: null },
]);
