/**
 * The SPENT held-out set of run 3, kept verbatim so run 3 stays reproducible and so a new set can be checked for
 * overlap. It found the revision-7 defect; it never judges a fix.
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

export const HELD_OUT_R3 = Object.freeze([
  { id: "h01", lang: "en", say: "Could we get some salsa going? Something with lots of horns.", expect: play(/salsa/i, { what: "salsa with lots of horns", source: "music" }) }, // salsa music; horns are a bonus, not checked
  { id: "h02", lang: "es", say: "¿Tienes algo de cumbia de la vieja escuela? Para animar la cocina.", expect: play(/cumbia/i, { what: "cumbia clásica", source: "music" }) }, // old-school cumbia
  { id: "h03", lang: "en", say: "The kids keep asking for The Paper Lanterns, the band with the whistling song.", expect: play(/paper\s*lanterns/i, { what: "The Paper Lanterns", source: "music" }) }, // play that band; "the whistling song" can't be identified
  { id: "h04", lang: "en", say: "Before I head out, could I hear a bit of that folk station from the hills?", expect: play(/folk|hill/i, { what: "the folk station from the hills", source: "radio" }) }, // a radio station they already know; "folk" or "hill" in what gets played
  { id: "h05", lang: "en", say: "Some quiet piano would be lovely while the soup simmers.", expect: play(/piano/i, { what: "quiet piano", source: "music" }) }, // calm piano music
  { id: "h06", lang: "en", say: "The shopping list app, when you get a sec. I'm planning meals for the week.", expect: open("shopping_list") }, // names the app outright
  { id: "h07", lang: "es", say: "¿Me enseñas la guía del asistente de programación? Quiero repasar una cosa.", expect: open("coding_guide") }, // the coding assistant guide
  { id: "h08", lang: "en", say: "I'm pretty sure there's a notes app in the launcher, could you bring it up for me?", expect: open("launcher") }, // notes isn't one of the four apps, so the launcher is the way in
  { id: "h09", lang: "en", say: "Mushroom risotto, I've never made one. Could the steps go up on the screen?", expect: show("steps", { title: "Mushroom risotto", body: "arborio rice\nmushrooms\nstock\n---\nSauté the mushrooms\nToast the rice\nAdd stock a ladle at a time" }, { title: /risotto/i }) }, // a step-by-step recipe card
  { id: "h10", lang: "en", say: "The cookies need eight minutes, can I see a countdown somewhere?", expect: show("timer", { title: "Cookies", seconds: 480 }, { title: /cookie/i }) }, // 8-minute timer
  { id: "h11", lang: "es", say: "Una lista para el desayuno del domingo: pan, fruta, café y yogur.", expect: show("list", { title: "Desayuno del domingo", body: "pan\nfruta\ncafé\nyogur" }, { body: /^(?=[\s\S]*pan)(?=[\s\S]*fruta)(?=[\s\S]*caf)(?=[\s\S]*yog)/i }) }, // a list holding all four items
  { id: "h12", lang: "en", say: "A card with the oven temperature for the banana muffins would help, 180 degrees.", expect: show(["text", "list"], { title: "Banana muffins", body: "Oven: 180 °C" }, { body: /180/ }) }, // a note card that shows 180
  { id: "h13", lang: "en", say: "Butter's missing from that list, put it near the top.", state: { windows: [card("Weekly grocery list")] }, expect: show("list", { title: "Weekly grocery list", body: "butter\none\ntwo" }, { sameTitle: "Weekly grocery list", body: /butter/i }) }, // update the same list; "near the top" not checked
  { id: "h14", lang: "en", say: "These potatoes are huge, give that another five minutes.", state: { windows: [timer("Potato boiling")] }, expect: show("timer", { title: "Potato boiling", seconds: 900 }, { sameTitle: "Potato boiling" }) }, // add 5 min to the same timer
  { id: "h15", lang: "en", say: "Okay, that's enough of the news for today, you can stop it now.", state: { playing: { title: "Evening news", source: "radio" } }, expect: wm("stop") }, // "stop" and "enough for today": stop, not pause
  { id: "h16", lang: "en", say: "It's gone quiet, the music, could you start it again from where it left off?", state: { playing: { title: "Copper Moon by Lila Brightwater", source: "music", paused: true } }, expect: wm("resume") }, // resume the paused track
  { id: "h17", lang: "es", say: "Ya está lista la sopa, quita el temporizador.", state: { windows: [timer("Sopa")] }, expect: wm("close", {}, { name: /sopa|soup|temporizador|timer/i }) }, // close the soup timer
  { id: "h18", lang: "en", say: "Back to the very first step, I want to read the whole thing over again.", state: { windows: [{ ...recipe("Pancakes"), steps: ["Mix the batter", "Cook two minutes a side"], step: 1 }] }, expect: wm("previous_step", {}, { name: /pancake/i }) }, // recipe on step 2 of 2, so one step back is the first step
  { id: "h19", lang: "en", say: "Can you freeze leftover soup in glass jars?", expect: null }, // spoken answer only
  { id: "h20", lang: "es", say: "¿Cuánto tiempo hay que dejar reposar la carne después de sacarla del horno?", expect: null }, // spoken answer only
]);
