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
  { id: "h01", lang: "en", say: "Got any old-time bluegrass? Fiddles would suit rolling out this pie crust.",
    expect: play(/bluegrass|old.?time|fiddle/i, { what: "old-time bluegrass", source: "music" }) }, // a genre request, so play it
  { id: "h02", lang: "es", say: "¿Qué tal un poco de flamenco mientras preparo la paella?",
    expect: play(/flamenco/i, { what: "flamenco", source: "music" }) }, // a genre request, so play it
  { id: "h03", lang: "en", say: "That new album by Copper Finch, the one everybody keeps talking about, let's hear it.",
    expect: play(/copper\s*finch/i, { what: "Copper Finch new album", source: "music" }) }, // artist or album; the artist name is enough
  { id: "h04", lang: "en", say: "The cooking call-in show on the local station, put that on for me, I like hearing people's questions.",
    expect: { tool: "crow_play", any: (a) => a.source === "radio" || /cook|call.?in/i.test(String(a.what || "")), sample: { what: "cooking call-in show", source: "radio" } } }, // a clear request to play it
  { id: "h05", lang: "en", say: "Just the business headlines, the short version, while the coffee brews.",
    expect: news(/business|headline/i) }, // news, business focus
  { id: "h06", lang: "en", say: "I want to check whether the overnight job finished, so bring up the lab dashboard, please.",
    expect: open("lab_dashboard") }, // the app is named outright
  { id: "h07", lang: "es", say: "Abre la lista de compras, que voy a ver qué me falta para el mercado.",
    expect: open("shopping_list") }, // the Shopping list app
  { id: "h08", lang: "en", say: "My sister sent pictures, and I think there's a photo app in the launcher. Bring that up?",
    expect: open("launcher") }, // the user names the launcher; a photo app isn't one of the four
  { id: "h09", lang: "es", say: "Cómo se hace un pan de elote, paso a paso en la pantalla, por favor.",
    expect: show("steps", { title: "Pan de elote", body: STEPS }, { title: /elote|corn\s*bread|ma[ií]z/i }) }, // recipe steps card
  { id: "h10", lang: "en", say: "A note that just says \"thaw the fish at four\" up there, so I see it when I walk by.",
    expect: show(["text", "list"], { title: "Note", body: "thaw the fish at four" }, { body: /thaw the fish at (four|4)/i }) }, // a note card with exactly that text
  { id: "h11", lang: "en", say: "Fifteen minutes for the cornbread, and make the countdown big enough to see from the table.",
    expect: show("timer", { title: "Cornbread", seconds: 900 }, { title: /corn\s*bread/i }) }, // a 15-minute timer card
  { id: "h12", lang: "en", say: "For Saturday's barbecue we need charcoal, buns, corn and lemonade. Can you jot that down on screen?",
    expect: show("list", { title: "Saturday barbecue", body: "charcoal\nbuns\ncorn\nlemonade" }, { body: /^(?=[\s\S]*charcoal)(?=[\s\S]*buns)(?=[\s\S]*corn)(?=[\s\S]*lemonade)/i }) }, // a list card holding all four items
  { id: "h13", lang: "en", say: "Swap the milk for oat milk on there.",
    state: { windows: [card("Shopping list")] }, // implied: the open shopping list card has "milk" on it
    expect: show("list", { title: "Shopping list", body: "oat milk\neggs\nbread" }, { sameTitle: "Shopping list", body: /oat milk/i }) }, // update the same card in place
  { id: "h14", lang: "en", say: "The ratios for a basic vinaigrette on a card would be handy, oil to vinegar and all that.",
    expect: show(["text", "list"], { title: "Basic vinaigrette", body: "3 parts oil to 1 part vinegar" }, { title: /vinaigrette/i, body: /\b3\b|three/i }) }, // a reference card; classic ratio 3:1
  { id: "h15", lang: "en", say: "The list can go now, I've got it on my phone.",
    state: { windows: [card("Saturday barbecue")] }, // implied: a list card is the open window
    expect: wm("close", {}, { name: /barbecue/i }) }, // close that list
  { id: "h16", lang: "en", say: "We're sitting down to eat now, so the radio can be switched off.",
    state: { playing: { title: "Talk Radio", source: "radio" } },
    expect: wm("stop") }, // "switched off" means stop
  { id: "h17", lang: "en", say: "Say that step one more time, I was rinsing the beans and missed it.",
    state: { windows: [recipe("Black bean soup")] },
    expect: wm("read_step") }, // repeat the current step
  { id: "h18", lang: "es", say: "Silencia el sonido un momento, que por fin se durmió el bebé.",
    state: { playing: PLAYING }, // implied: something is playing
    expect: wm("mute") }, // "silencia" is literally mute
  { id: "h19", lang: "en", say: "Can I use baking soda instead of baking powder in muffins?",
    expect: null }, // spoken answer only
  { id: "h20", lang: "es", say: "¿El aguacate se pone menos oscuro si le dejo el hueso?",
    expect: null }, // spoken answer only
]);
