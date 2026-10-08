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
  { id: "h01", lang: "en", say: "Got anything with a bit of a groove for while the soup simmers?", expect: play(/groov|funk|soul|disco|r.?n.?b|upbeat|dance|jazz/i, { what: "groovy music" }, { source: ["music", "radio", "auto"] }) },
  { id: "h02", lang: "es", say: "¿Hay alguna emisora con música brasileña?", expect: play(/brazil|brasil|bossa|samba|mpb/i, { what: "música brasileña", source: "radio" }, { source: ["radio", "auto"] }) },
  { id: "h03", lang: "en", say: "Could we get the morning news on for a bit?", expect: news(/news|morning/i) },
  { id: "h04", lang: "en", say: "That jazz playlist from Sunday, the one with the trumpet.", expect: play(/jazz|trumpet/i, { what: "jazz trumpet playlist" }, { source: ["music", "auto"] }) },
  { id: "h05", lang: "es", say: "Mi abuela quiere escuchar boleros, ¿los pones?", expect: play(/bolero/i, { what: "boleros" }, { source: ["music", "radio", "auto"] }) },
  { id: "h06", lang: "en", say: "Hang on, what did we already put down for the grocery run? Let me see it.", expect: open("shopping_list") },
  { id: "h07", lang: "es", say: "Oye, quiero revisar cómo van las cosas en el laboratorio, ¿me sacas ese panel?", expect: open("lab_dashboard") },
  { id: "h08", lang: "en", say: "I want to peek at the coding assistant guide before dinner.", expect: open("coding_guide") },
  { id: "h09", lang: "en", say: "How about a twelve-minute timer for the pasta.", expect: show("timer", { title: "Pasta", body: "12 minutes" }, { title: /pasta/i, seconds: 720 }) },
  { id: "h10", lang: "en", say: "The steps for banana bread, big enough to read from the stove.", expect: show("steps", { title: "Banana bread", body: STEPS }, { title: /banana/i }) },
  { id: "h11", lang: "en", say: "A list of what we need for tacos tonight, please.", expect: show("list", { title: "Tacos", body: "tortillas\nground beef\nonion\ncilantro\nsalsa" }, { title: /taco/i }) },
  { id: "h12", lang: "en", say: "Can you put the pancake recipe up on the screen?", expect: show("steps", { title: "Pancakes", body: STEPS }, { title: /pancake/i }) },
  { id: "h13", lang: "en", say: "Actually, make that eighteen minutes, not twelve.", state: { windows: [timer("Timer")] }, expect: show("timer", { title: "Timer", body: "18 minutes" }, { sameTitle: "Timer", seconds: 1080 }) },
  { id: "h14", lang: "es", say: "Una tarjeta con los teléfonos de emergencia, por favor.", expect: show(["list", "text"], { title: "Teléfonos de emergencia", body: "Emergencias: 911" }, { title: /emergenc|tel[eé]fono/i }) },
  { id: "h15", lang: "en", say: "Okay, next step, my hands are covered in flour.", state: { windows: [recipe("Pancakes")] }, expect: wm("next_step") },
  { id: "h16", lang: "en", say: "That's way too loud, bring it down a little.", state: { playing: { title: "Radio news", source: "news" } }, expect: wm("volume_down") },
  { id: "h17", lang: "es", say: "Lo de la receta ya sobra en la pantalla, quítalo.", state: { windows: [recipe("Pollo asado")] }, expect: wm("close", { name: "Pollo asado" }, { name: /pollo|receta|recipe/i }) },
  { id: "h18", lang: "en", say: "Skip this one, I can't stand that song.", state: { playing: { title: "Pop Hits", source: "music" } }, expect: wm("next") },
  { id: "h19", lang: "en", say: "Is it okay to swap baking soda for baking powder, or does that ruin it?", expect: null },
  { id: "h20", lang: "es", say: "¿A qué temperatura se hornea un pollo entero?", expect: null },
]);
