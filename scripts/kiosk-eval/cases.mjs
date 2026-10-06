/**
 * The kiosk tool-surface evaluation set: 40 utterances a no-model path would miss, the session
 * they are said in, and what a correct END RESULT looks like. Each one is run through the product
 * itself (product.mjs: the real voice turn, display tools, executor and fast paths), once with the
 * four display tools and once with a single-tool control.
 *
 * The tool descriptions and the word lists in patterns.js were written with these 40 in view. The
 * check on that is held-out.mjs: 20 more utterances written afterwards by someone who had not been
 * shown the descriptions' examples, and never used to adjust anything.
 */
export const AT = Date.UTC(2026, 9, 4, 20, 42, 10);
export const TZ = "America/Chicago";
/** What the evaluation display has. A household that speaks Spanish gives its items Spanish aliases; c16 depends on that. */
export const FIXTURE = Object.freeze({
  windows: ["timer", "recipe", "content"],
  sources: ["music", "radio", "news"],
  items: [
    { id: "lab_dashboard", title: "Lab dashboard", aliases: ["panel del laboratorio"] },
    { id: "coding_guide", title: "Coding assistant guide" },
    { id: "shopping_list", title: "Shopping list" },
    { id: "now_playing", title: "Now playing" },
  ],
  caps: { windows: ["timer", "recipe", "content"], max_windows: 4, screen: { w: 800, h: 480, touch: true }, audio: { out: true }, video: "none" },
});

const play = (what, sample, extra = {}) => ({ tool: "crow_play", what, sample: { source: "auto", ...sample }, ...extra });
const news = (re) => ({ tool: "crow_play", any: (a) => a.source === "news" || re.test(String(a.what || "")), sample: { what: "the news", source: "news" } });
const open = (app) => ({ tool: "crow_open", app, sample: { app } });
const show = (kind, sample, extra = {}) => ({ tool: "crow_show", kind: [].concat(kind), sample: { kind: [].concat(kind)[0], ...sample }, ...extra });
const wm = (verb, sample = {}, extra = {}) => ({ tool: "crow_wm", do: verb, sample: { do: verb, ...sample }, ...extra });
const card = (title, list = true) => ({ kind: "content", title, blocks: [{ type: "heading", text: title }, list ? { type: "list", items: ["one", "two"] } : { type: "text", text: "note" }] });
const recipe = (title) => ({ kind: "recipe", title, ingredients: ["a"], steps: ["one", "two"], step: 0 });
const timer = (name) => ({ kind: "timer", name, title: name, seconds: 600 });
const PLAYING = { title: "Morning Mix", source: "radio" };
/** The constructors, for held-out.mjs. */
export const make = Object.freeze({ play, news, open, show, wm, card, recipe, timer });
const STEPS = "flour\neggs\n---\nMix the batter\nCook two minutes a side";

export const CASES = Object.freeze([
  { id: "c01", lang: "en", say: "Put on something relaxing for dinner.", expect: play(/relax/i, { what: "relaxing dinner music" }) },
  { id: "c02", lang: "en", say: "I'd like to hear some jazz.", expect: play(/jazz/i, { what: "jazz" }) },
  { id: "c03", lang: "en", say: "Can we get the news going?", expect: news(/news/i) },
  { id: "c04", lang: "en", say: "Let's have the radio on, Morning Mix please.", expect: play(/morning mix/i, { what: "Morning Mix", source: "radio" }, { source: ["radio", "auto"] }) },
  { id: "c05", lang: "en", say: "Some music for cooking, please.", expect: play(null, { what: "cooking music", source: "music" }, { source: ["music", "auto"] }) },
  { id: "c06", lang: "en", say: "I want to listen to the Night Owls.", expect: play(/night owls/i, { what: "the Night Owls" }) },
  { id: "c07", lang: "en", say: "How about some classical music?", expect: play(/classical/i, { what: "classical" }) },
  { id: "c08", lang: "en", say: "Could you find the album Blue Lanterns and start it?", expect: play(/blue lanterns/i, { what: "Blue Lanterns", source: "music" }) },
  { id: "c09", lang: "es", say: "Quiero escuchar algo de salsa.", expect: play(/salsa/i, { what: "salsa" }) },
  { id: "c10", lang: "es", say: "¿Me pones las noticias?", expect: news(/noticias|news/i) },
  { id: "c11", lang: "en", say: "I need the lab dashboard up.", expect: open("lab_dashboard") },
  { id: "c12", lang: "en", say: "Take me to the coding assistant guide.", expect: open("coding_guide") },
  { id: "c13", lang: "en", say: "Bring back the shopping list app.", expect: open("shopping_list") },
  { id: "c14", lang: "en", say: "What apps do you have?", expect: open("launcher") },
  { id: "c15", lang: "en", say: "Can you start the movie library?", expect: open("launcher") },
  { id: "c16", lang: "es", say: "Necesito ver el panel del laboratorio.", expect: open("lab_dashboard") },
  { id: "c17", lang: "en", say: "Show me a recipe for lasagna.", expect: show("steps", { title: "Lasagna", body: STEPS }, { title: /lasagna/i }) },
  { id: "c18", lang: "en", say: "Put a packing list for a beach day on the screen.", expect: show("list", { title: "Beach day packing list", body: "sunscreen\ntowel\nhat" }) },
  { id: "c19", lang: "en", say: "Show me a list of three fruits.", expect: show("list", { title: "Three fruits", body: "apple\nbanana\ncherry" }) },
  { id: "c20", lang: "en", say: "Put the guest wifi password on the screen: maple forty two.", expect: show("text", { title: "Guest wifi", body: "maple forty two" }, { body: /maple/i }) },
  { id: "c21", lang: "en", say: "Give me a ten minute timer for the pasta.", expect: show("timer", { title: "Pasta", body: "10 minutes" }, { title: /pasta/i, seconds: 600 }) },
  { id: "c22", lang: "en", say: "I need a countdown, forty five seconds.", expect: show("timer", { title: "Countdown", body: "45 seconds" }, { seconds: 45 }) },
  { id: "c23", lang: "es", say: "¿Me muestras los pasos para hacer panqueques?", expect: show("steps", { title: "Panqueques", body: STEPS }) },
  { id: "c24", lang: "en", say: "Display the days of the week.", expect: show(["list", "text"], { title: "Days of the week", body: "Monday\nTuesday" }) },
  { id: "c25", lang: "es", say: "Muéstrame una lista de tres frutas.", expect: show("list", { title: "Tres frutas", body: "manzana\nplátano\ncereza" }) },
  { id: "c26", lang: "es", say: "Pon en la pantalla una receta de guacamole.", expect: show("steps", { title: "Guacamole", body: STEPS }, { title: /guacamole/i }) },
  { id: "c27", lang: "en", state: { windows: [card("Fruits")] }, say: "Now show me a list of three vegetables.", expect: show("list", { title: "Vegetables", body: "carrot\npea\nleek" }, { notTitle: "Fruits" }) },
  { id: "c28", lang: "en", state: { windows: [card("Wifi", false)] }, say: "Show me a packing list for camping.", expect: show("list", { title: "Camping packing list", body: "tent\nstove" }, { notTitle: "Wifi" }) },
  { id: "c29", lang: "en", state: { windows: [card("Fruits")] }, say: "Add grapes to the fruits list.", expect: show("list", { title: "Fruits", body: "one\ntwo\ngrapes" }, { sameTitle: "Fruits", body: /grape/i }) },
  { id: "c30", lang: "en", state: { windows: [recipe("Lasagna")] }, say: "Show me a recipe for garlic bread too.", expect: show("steps", { title: "Garlic bread", body: STEPS }, { notTitle: "Lasagna" }) },
  { id: "c31", lang: "en", state: { windows: [timer("Rice")], playing: { ...PLAYING, paused: true } }, say: "Get rid of the timer and put the music back on.", expect: [wm("close", { name: "timer" }, { name: /timer|rice/i }), wm("resume")] },
  { id: "c32", lang: "en", state: { windows: [card("Fruits")] }, say: "I'm done with that list.", expect: wm("close") },
  { id: "c33", lang: "en", state: { playing: PLAYING }, say: "It's a bit much, the volume.", expect: wm("volume_down") },
  { id: "c34", lang: "en", state: { playing: PLAYING }, say: "I don't like this song.", expect: wm("next") },
  { id: "c35", lang: "en", state: { windows: [card("Fruits"), timer("Rice")] }, say: "Tidy up the screen for me.", expect: wm("close_all") },
  { id: "c36", lang: "es", state: { playing: PLAYING }, say: "Está un poco fuerte la música.", expect: wm("volume_down") },
  { id: "c37", lang: "en", state: { windows: [card("Fruits")] }, say: "What is the capital of Portugal?", expect: null },
  { id: "c38", lang: "en", state: { windows: [timer("Rice")] }, say: "Tell me a short joke.", expect: null },
  { id: "c39", lang: "en", state: { playing: PLAYING }, say: "Who wrote Pride and Prejudice?", expect: null },
  { id: "c40", lang: "es", state: { windows: [card("Frutas")] }, say: "¿Cuántos días tiene un año bisiesto?", expect: null },
]);

const str = (v) => (typeof v === "string" ? v : "");
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const inList = (v, list) => !list || list.includes(v === undefined || v === "" ? "auto" : v);
const titleOk = (w, title) => !!title.trim() && (!w.title || w.title.test(title)) && (!w.notTitle || !same(title, w.notTitle)) && (!w.sameTitle || same(title, w.sameTitle));
/** Did this EXECUTED call do what `w` asks? call = { tool, args, result } as product.mjs records it (the same shape on both surfaces). */
export function matches(w, call) {
  if (call.tool !== w.tool || call.result?.ok !== true) return false;
  const a = call.args || {};
  if (w.tool === "crow_play") return call.result.outcome === "playing" && !!str(a.what).trim() && (!w.what || w.what.test(str(a.what))) && inList(a.source, w.source) && (!w.any || w.any(a));
  if (w.tool === "crow_open") return ["opened", "focused"].includes(call.result.outcome) && a.app === w.app;
  if (w.tool === "crow_show") return ["shown", "updated"].includes(call.result.outcome) && w.kind.includes(a.kind) && titleOk(w, str(a.title)) && (!w.body || w.body.test(str(a.body))) && (!w.seconds || call.seconds === w.seconds);
  return call.result.outcome === "done" && a.do === w.do && (!w.name || w.name.test(str(a.name)));
}
/**
 * The end result of one turn. calls = every display call that reached the executor; other = calls to
 * any other tool; failed = the turn's failure code (null = it ended normally); spoken = what was said.
 * Correct = every expected thing happened, nothing else happened, and the turn ended normally with
 * something said. A call that was refused and then put right does not count against the turn.
 */
export function judge(c, { calls = [], other = [], failed = null, spoken = "", windows = null } = {}) {
  const done = calls.filter((x) => x.result?.ok === true && x.result.effect !== false);
  if (failed !== null || !String(spoken).trim() || other.length) return false;
  if (c.expect === null) return done.length === 0;
  const want = [].concat(c.expect);
  // A change to an open timer (sameTitle) must leave ONE timer of that name, not a second one beside it.
  if (Array.isArray(windows)) for (const w of want) {
    if (w.tool === "crow_show" && w.sameTitle && [].concat(w.kind || []).includes("timer") && windows.filter((x) => x.kind === "timer" && same(x.title, w.sameTitle)).length > 1) return false;
  }
  return done.length === want.length && want.every((w) => done.some((call) => matches(w, call)));
}
/** The sample calls of a case, as the four tools take them (the tests' proof that every case can be completed). */
export const sampleCalls = (c) => [].concat(c.expect || []).map((w) => ({ name: w.tool, args: w.sample }));
