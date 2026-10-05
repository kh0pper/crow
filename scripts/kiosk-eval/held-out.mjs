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

export const HELD_OUT = Object.freeze([
  { id: "h01", lang: "en", say: "Something mellow while I chop onions, maybe some old jazz.",
    expect: play(/jazz/i, { what: "mellow old jazz" }) }, // clear request for jazz; "mellow" or "old" may or may not appear in the query

  { id: "h02", lang: "es", say: "¿Hay alguna emisora con música mexicana para cocinar?",
    expect: play(/mexic|ranchera|mariachi|norte[ñn]|banda|grupera|regional/i, { what: "música mexicana", source: "radio" }) }, // phrased as a question, but in the kitchen it means "put one on"; any Mexican-music query is fine

  { id: "h03", lang: "en", say: "Mind putting the morning news on?",
    expect: news(/news|noticias/i) }, // polite request to play the news

  { id: "h04", lang: "en", say: "Those 90s hits from yesterday, could we have them again?",
    expect: play(/90|nineties/i, { what: "90s hits" }) }, // replay 90s hits; no memory of exactly what played yesterday, so a 90s query is right

  { id: "h05", lang: "en", say: "A little bossa nova for dinner would be nice.",
    expect: play(/bossa/i, { what: "bossa nova" }) }, // indirect request to play bossa nova

  { id: "h06", lang: "en", say: "Where's my shopping list? I need to add eggs.",
    expect: open("shopping_list") }, // they want their real shopping list app; opening it is the visible result

  { id: "h07", lang: "es", say: "¿Me abres el panel del laboratorio un momento?",
    expect: open("lab_dashboard") }, // Spanish alias for the Lab dashboard

  { id: "h08", lang: "en", say: "That coding assistant guide, can I see it on the big screen?",
    expect: open("coding_guide") }, // names the app exactly

  { id: "h09", lang: "en", say: "How do you make pancakes from scratch? I'd like the steps up there.",
    expect: show("steps", { title: "Pancakes", body: "flour\nmilk\neggs\n---\nWhisk the batter\nCook two minutes a side" }, { title: /pancake/i }) }, // asks for steps on screen, so a recipe/steps card

  { id: "h10", lang: "en", say: "I need a twelve-minute timer for the pasta.",
    expect: show("timer", { title: "Pasta", seconds: 720 }, { title: /pasta|timer|12/i }) }, // timer card; loose title, 720 s in the sample

  { id: "h11", lang: "es", say: "Una lista con lo que falta para la lasaña, por favor.",
    expect: show("list", { title: "Lasaña", body: "láminas de lasaña\ncarne molida\nqueso ricotta\nsalsa de tomate" }, { title: /lasa[ñn]a/i }) }, // a list card for lasagna ingredients

  { id: "h12", lang: "en", say: "What temperature for a roast chicken? Put it on the screen so I don't forget.",
    expect: show(["text", "list"], { title: "Roast chicken", body: "425°F (220°C), about 20 minutes per pound" }, { title: /chicken|roast/i, body: /\d{3}\s*°?\s*[FC]?/i }) }, // answer spoken AND a card holding the temperature; text or list both fine

  { id: "h13", lang: "en", say: "Oh, and garlic bread on there too.",
    state: { windows: [card("Shopping list")] },
    expect: show("list", { title: "Shopping list", body: "one\ntwo\ngarlic bread" }, { sameTitle: "Shopping list", body: /garlic bread/i }) }, // update the open shopping-list card in place, keeping its title and adding the item

  { id: "h14", lang: "en", say: "Actually, make it twenty minutes instead.",
    state: { windows: [timer("Pasta")] },
    expect: show("timer", { title: "Pasta", seconds: 1200 }, { sameTitle: "Pasta" }) }, // change the open pasta timer to 20 min; keep it the same timer, not a second one

  { id: "h15", lang: "en", say: "Okay, next step please, my hands are covered in flour.",
    state: { windows: [recipe("Pancakes")] }, // added: "next step" implies a recipe is open
    expect: wm("next_step") }, // only one right action

  { id: "h16", lang: "en", say: "That's way too loud, bring it down a bit.",
    state: { playing: { title: "Morning News", source: "news" } },
    expect: wm("volume_down") }, // lower the volume; not mute, not stop

  { id: "h17", lang: "es", say: "Ya terminé con la receta, quítala de la pantalla.",
    state: { windows: [recipe("Pancakes")] }, // added: "quítala" refers to an open recipe
    expect: wm("close", {}, { name: /pancake|receta|recipe/i }) }, // close the recipe window

  { id: "h18", lang: "en", say: "Skip ahead to the next song, please, I can't stand this tune.",
    state: { playing: { title: "Rock Playlist", source: "music" } },
    expect: wm("next") }, // asks outright for the next song; skip within the playlist, not stop or pause

  { id: "h19", lang: "en", say: "How many tablespoons are in a quarter cup?",
    expect: null }, // spoken answer only (4 tablespoons); nothing on screen asked for

  { id: "h20", lang: "es", say: "¿Cuántos gramos tiene una taza de harina?",
    expect: null }, // spoken answer only (about 120–125 g of all-purpose flour)
]);

