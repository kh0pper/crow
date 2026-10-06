/**
 * The SPENT held-out set of run 2 (branch commit 48b3b63e), kept verbatim so run 2 stays reproducible and so a new
 * set can be checked for overlap. It found the revision-6 defects; it never judges a fix.
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

export const HELD_OUT_R2 = Object.freeze([
  { id: "h01", lang: "en", say: "Is there a station playing classic soul right now? Something to cook to.",
    expect: play(/soul/i, { what: "classic soul", source: "radio" }) }, // "something to cook to" means play it, not just answer yes or no
  { id: "h02", lang: "es", say: "¿Me pones las noticias de la tarde mientras lavo los platos?",
    expect: news(/noticias|news/i) }, // asks for the news to be played
  { id: "h03", lang: "en", say: "Some reggae for doing the dishes, if you've got any.",
    expect: play(/reggae/i, { what: "reggae", source: "music" }) }, // genre request; music or radio both fine
  { id: "h04", lang: "en", say: "My mom loves Marisol Vega, so let's have her on before she gets here.",
    expect: play(/marisol\s*vega/i, { what: "Marisol Vega", source: "music" }) }, // play the artist ("her" is Marisol Vega, not the mom)
  { id: "h05", lang: "en", say: "Whatever the local sports radio has on, I want to hear the score.",
    expect: play(/sport/i, { what: "local sports radio", source: "radio" }) }, // tune to the sports station
  { id: "h06", lang: "en", say: "The Now playing screen, please, I want to see what song this is.",
    state: { playing: PLAYING }, // added: "what song this is" means something is already playing
    expect: open("now_playing") }, // only this app is right
  { id: "h07", lang: "en", say: "Quick look at the lab dashboard before dinner?",
    expect: open("lab_dashboard") }, // only this app is right
  { id: "h08", lang: "en", say: "Is there a calculator somewhere in the launcher? I have to halve this recipe.",
    expect: open("launcher") }, // they want to get to a calculator; opening the launcher is the reachable action
  { id: "h09", lang: "en", say: "Steps for a simple guacamole up on the screen would really help.",
    expect: show("steps", { title: "Simple guacamole", body: "avocados\nlime\nsalt\n---\nMash the avocados\nStir in lime and salt" }, { title: /guac/i }) }, // a steps card is explicitly asked for
  { id: "h10", lang: "en", say: "Rice needs ten minutes, can you count that down for me?",
    expect: show("timer", { title: "Rice", seconds: 600 }, { title: /rice|arroz/i }) }, // 10-minute timer card
  { id: "h11", lang: "es", say: "Lo que hace falta para unas enchiladas verdes, en una lista si se puede.",
    expect: show("list", { title: "Enchiladas verdes", body: "tortillas\ntomatillos\nchiles serranos\npollo\nqueso\ncrema" }, { title: /enchilada/i }) }, // a list is explicitly asked for
  { id: "h12", lang: "en", say: "Folding dumplings, I always forget how. Could you show me step by step?",
    expect: show("steps", { title: "Folding dumplings", body: "wrappers\nfilling\n---\nPut filling in the centre\nWet the edge\nFold and pleat to seal" }, { title: /dumpling/i }) }, // step-by-step means a steps card
  { id: "h13", lang: "es", say: "Cilantro y limones también, que no se me olviden.",
    state: { windows: [card("Enchiladas verdes")] }, // from [lista de las enchiladas]
    expect: show("list", { title: "Enchiladas verdes", body: "one\ntwo\ncilantro\nlimones" },
      { sameTitle: "Enchiladas verdes", body: /^(?=[\s\S]*cilantro)(?=[\s\S]*lim[oó]n)/i }) }, // add both to the SAME list, not a new one
  { id: "h14", lang: "en", say: "Cross off the tortillas, turns out we have a whole pack.",
    state: { windows: [card("Enchilada list")] }, // from [enchilada list card]; the fixture card's items are "one","two"
    expect: show("list", { title: "Enchilada list", body: "one\ntwo" }, { sameTitle: "Enchilada list" }) }, // update the same list; strike-through vs. removal not checked
  { id: "h15", lang: "en", say: "Hold on, pause that, the phone's ringing.",
    state: { playing: { title: "Marisol Vega playlist", source: "music" } }, // from [Marisol Vega playlist]
    expect: wm("pause") }, // pause, not stop or mute
  { id: "h16", lang: "en", say: "Wait, back one step, I missed how much salt goes in.",
    state: { windows: [recipe("Dumplings")] }, // from [dumpling recipe steps]
    expect: wm("previous_step", {}, { name: /dumpling/i }) }, // step back in the recipe, not the music "previous"
  { id: "h17", lang: "en", say: "Too many windows open now, just clear them all off.",
    state: { windows: [card("Enchiladas verdes"), recipe("Dumplings"), timer("Rice")] }, // added: the line implies several windows are open
    expect: wm("close_all") }, // close everything
  { id: "h18", lang: "es", say: "Uy, qué bajito está eso, súbele que no lo oigo con el extractor.",
    state: { playing: { title: "Merengue — Los Hermanos Brisa", source: "music" } }, // from [merengue de Los Hermanos Brisa]
    expect: wm("volume_up") }, // "súbele" plus "too quiet" means turn it up; only volume_up is right
  { id: "h19", lang: "en", say: "How long does cooked rice keep in the fridge?",
    expect: null }, // a spoken fact (about 3–4 days); nothing should change
  { id: "h20", lang: "es", say: "¿A qué hora se pone el sol hoy?",
    expect: null }, // a spoken answer; nothing should change
]);
