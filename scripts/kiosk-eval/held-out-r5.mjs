/**
 * The SPENT held-out set of run 5, kept verbatim so run 5 stays reproducible and so a new set can be checked for
 * overlap. Run 5 passed every gate; the smoke after it led to a fix round that changed the word lists, so it never judges a later build.
 * Original header:
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

export const HELD_OUT_R5 = Object.freeze([
  { id: "h01", lang: "en", say: "Something mellow while I chop onions, maybe that Velvet Harbor record?", expect: play(/velvet\s*harbou?r|mellow|chill|calm/i, { what: "Velvet Harbor", source: "music" }, { source: ["music", "auto"] }) },
  { id: "h02", lang: "es", say: "¿Me pones la radio Onda Pimienta, por favor?", expect: play(/onda\s*pimienta/i, { what: "Onda Pimienta", source: "radio" }, { source: ["radio", "auto"] }) },
  { id: "h03", lang: "en", say: "Could we get the morning news on while the coffee brews?", expect: news(/news|noticias/i) },
  { id: "h04", lang: "en", say: "I'm in the mood for the Copper Lanterns album from last summer.", expect: play(/copper\s*lanterns?/i, { what: "Copper Lanterns", source: "music" }, { source: ["music", "auto"] }) },
  { id: "h05", lang: "es", say: "Algo de música tranquila para la cena, ¿sí?", expect: play(null, { what: "música tranquila para la cena", source: "music" }, { source: ["music", "auto"] }) },
  { id: "h06", lang: "en", say: "Where's the shopping list? I need to add eggs.", expect: open("shopping_list") },
  { id: "h07", lang: "es", say: "¿Dónde está la lista de la compra? Quiero ver qué nos falta.", expect: open("shopping_list") },
  { id: "h08", lang: "en", say: "Hey, the coding assistant guide, can I see that real quick?", expect: open("coding_guide") },
  { id: "h09", lang: "en", say: "A timer for twelve minutes on the pasta, please.", expect: show("timer", { title: "Pasta", body: "12 minutes" }, { seconds: 720 }) },
  { id: "h10", lang: "en", say: "How do I make pancakes? Walk me through the steps.", expect: show("steps", { title: "Pancakes", body: "flour\nmilk\neggs\n---\nWhisk the batter\nCook on a hot pan" }, { title: /pancake|hotcake/i }) },
  { id: "h11", lang: "en", say: "We need buns, corn and charcoal for Sunday's barbecue, can you put that up as a list?", expect: show("list", { title: "Barbecue", body: "Buns\nCorn\nCharcoal" }, { body: /(?=[\s\S]*\bbuns?\b)(?=[\s\S]*\bcorn\b)(?=[\s\S]*charcoal)/i }) },
  { id: "h12", lang: "en", state: { windows: [timer("Pasta")] }, say: "Actually, make that eighteen minutes instead.", expect: show("timer", { title: "Pasta", body: "18 minutes" }, { seconds: 1080, sameTitle: "Pasta" }) },
  { id: "h13", lang: "es", say: "¿Me muestras los pasos para hacer arroz con leche?", expect: show("steps", { title: "Arroz con leche", body: "arroz\nleche\ncanela\nazúcar\n---\nCocer el arroz\nAñadir la leche y el azúcar" }, { title: /arroz\s*con\s*leche|rice\s*pudding/i }) },
  { id: "h14", lang: "en", state: { windows: [card("Groceries")] }, say: "Oh, and lemons too, stick them on there.", expect: show("list", { title: "Groceries", body: "one\ntwo\nlemons" }, { body: /lemon/i, sameTitle: "Groceries" }) },
  { id: "h15", lang: "en", state: { windows: [recipe("Pancakes")] }, say: "Next step, my hands are covered in flour.", expect: wm("next_step") },
  { id: "h16", lang: "en", state: { playing: { title: "Onda Pimienta", source: "radio" } }, say: "That's a bit loud, can you bring it down?", expect: wm("volume_down") },
  { id: "h17", lang: "es", state: { windows: [recipe("Pancakes")] }, say: "Ya puedes cerrar la receta, terminamos.", expect: wm("close", { name: "Pancakes" }, { name: /pancake|recipe|receta/i }) },
  { id: "h18", lang: "en", state: { playing: { title: "Velvet Harbor", source: "music" } }, say: "Nah, skip this one, I'm not feeling it.", expect: wm("next") },
  { id: "h19", lang: "en", say: "Is it supposed to rain later, or can I hang the laundry outside?", expect: null },
  { id: "h20", lang: "es", say: "¿Qué día es hoy?", expect: null },
]);
