/**
 * STT quality, first fix: spelled call signs end to end. Through the real tiers, executor, display tools,
 * play resolver, media session and stations source. The station names are made up (KTPF), in the shape of a
 * real three-preset list: an HD1 with the bare call sign as its alias, an HD2 and an HD3 with their own.
 *
 *   - A bare spelled call sign with no verb ("K T P F.", "No, K T P F", "KTPF.") is a station request: T1 plays an
 *     exact name only (a sound-alike is asked about), and crow_play is OFFERED for it when T1 is not.
 *   - Partial or misheard spellings are ASKED about ("Did you mean …?"), never played on a guess: a spelled
 *     prefix ("Play K T P"), one letter dropped, swapped or added ("TPF", "ATPF", "KTP2"), a trailing word after
 *     an exact name ("KTPF downtown").
 *   - Matching runs only against the stations this instance has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlayResolver, createMediaVerbs } from "../bundles/kiosk/server/play.js";
import { createMediaStore } from "../bundles/kiosk/server/media.js";
import { createTicketStore } from "../bundles/kiosk/server/tickets.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { createSourceRegistry } from "../bundles/kiosk/server/sources/index.js";
import { createStationsSource, normalizeStations } from "../bundles/kiosk/server/sources/stations.js";
import { matchSpoken } from "../bundles/kiosk/server/tiers.js";
import { spelledCallSign } from "../bundles/kiosk/server/patterns.js";
import { createDisplayTools } from "../bundles/kiosk/server/display-tools.js";

const KTPF = normalizeStations([
  { name: "KTPF HD1", aliases: ["KTPF", "KTPF one", "ninety point one"], url: "https://stream.example.invalid/k1" },
  { name: "KTPF HD2", aliases: ["KTPF two", "HD two"], url: "https://stream.example.invalid/k2" },
  { name: "KTPF HD3", aliases: ["KTPF three", "HD three", "classic country"], url: "https://stream.example.invalid/k3" },
]);
const MIX = normalizeStations([{ name: "Morning Mix", aliases: ["the mix"], url: "https://stream.example.invalid/mix" }]);

function setup({ stations = KTPF, lang = "en" } = {}) {
  const sent = [], clock = { t: 0 };
  const store = createWmStore({ now: () => clock.t, setTimer: () => ({}), clearTimer: () => {} });
  const tickets = createTicketStore({ now: () => clock.t, setTimer: () => ({}), clearTimer: () => {} });
  const media = createMediaStore({ now: () => clock.t, tickets, send: (id, m) => { sent.push(m); return true; }, onFailed: () => {}, setTimer: () => ({}), clearTimer: () => {} });
  const registry = createSourceRegistry([createStationsSource({ list: () => stations })]);
  const resolver = createPlayResolver({ registry, now: () => clock.t });
  const verbs = createMediaVerbs({ media, resolver, maxVolume: () => 100 });
  const ctx = { store, deviceId: "d", caps: { windows: ["timer", "recipe", "content"], max_windows: 4, kinds: ["card", "timer"] }, lang, sources: registry.kinds(), items: [], emit: () => {}, media, ...verbs };
  const say = async (t) => { const r = await matchSpoken(t, ctx); return r ? { say: r.say, tier: r.tier } : null; };
  const loads = () => sent.filter((m) => m.action === "load").map((m) => m.title);
  const offered = (t) => createDisplayTools(ctx).filter((x) => typeof x.when !== "function" || x.when(t) === true).map((x) => x.definition.name);
  return { ctx, say, loads, offered, clock };
}
const PLAYING_HD1 = { say: "Playing KTPF HD1.", tier: "t1" };
const ASK_HD1 = { say: "Did you mean KTPF HD1? Say yes or its name.", tier: "t1" };

test("the detector: a bare spelled call sign (letters, letter names, one capitals word), after a short lead-in, with an optional HD/number tail", () => {
  for (const [said, what] of [
    ["K T P F.", "k t p f"], ["K. T. P. F.", "k t p f"], ["K-T-P-F", "k t p f"], ["No, K T P F.", "k t p f"], ["I said K T P F.", "k t p f"],
    ["Kay tee pee eff.", "k t p f"], ["KTPF.", "ktpf"], ["No, KTPF", "ktpf"], ["K T P F two.", "k t p f two"], ["K T P F H D 2", "k t p f h d 2"],
    ["Um, K T P F, please.", "k t p f"], ["It's K T P F.", "k t p f"], ["K T P.", "k t p"],
    ["Ka te pe efe.", "k t p f"], ["No, dije K T P F.", "k t p f"],
  ]) assert.equal(spelledCallSign(said), what, said);
  for (const said of ["", null, 42, "K.", "K, T.", "OK.", "Oh, I see you.", "I am here.", "What is K T P F?", "Is it K T P F?", "Play K T P F.", "The cat sat on the mat.",
    "Hmm.", "Brr.", "K T P F is my favourite station", "Okay", "Yes.", "No.", "Kitchen.", "USA"]) assert.equal(spelledCallSign(said), null, String(said));
});

test("a bare spelled call sign with no verb plays the station with no model; the forms that already worked still do", async () => {
  for (const said of ["K T P F.", "K. T. P. F.", "K-T-P-F", "No, K T P F.", "I said K T P F.", "KTPF.", "No, KTPF", "Kay tee pee eff.", "Play K.T.P.F.", "Play kay tee pee eff.", "Play KDBF.", "Play K T P F."]) {
    const s = setup();
    assert.deepEqual(await s.say(said), PLAYING_HD1, said);
    assert.deepEqual(s.loads(), ["KTPF HD1"], said);
  }
  const s = setup();
  assert.deepEqual(await s.say("K T P F two."), { say: "Playing KTPF HD2.", tier: "t1" });
  assert.deepEqual(await setup().say("K T P F H D 3"), { say: "Playing KTPF HD3.", tier: "t1" });
  assert.deepEqual(await setup().say("KTPF2."), { say: "Playing KTPF HD2.", tier: "t1" });
});

test("review C2: a bare spelling plays on an exact name only — a sound-alike or an extra letter is asked about, a yes plays it", async () => {
  for (const said of ["K D B F.", "K T P V.", "Kay dee bee eff.", "K T P F F.", "Ka de pe efe.", "Pon ka de pe efe."]) {
    const s = setup({ lang: /^(Ka|Pon)/.test(said) ? "es" : "en" });
    const r = await s.say(said);
    assert.match(r?.say || "", /KTPF HD1\?/, said);
    assert.deepEqual(s.loads(), [], `${said}: nothing plays`);
  }
  const s = setup();
  await s.say("K D B F.");
  assert.deepEqual(await s.say("Yes."), PLAYING_HD1);
});

test("review C1: a misheard Spanish letter-name spelling after a verb is still only asked about", async () => {
  for (const said of ["Play ka de pe efe.", "Pon ka de pe efe."]) {
    const s = setup({ lang: "es" });
    assert.match((await s.say(said))?.say || "", /^¿Quisiste decir KTPF HD1\?/, said);
    assert.deepEqual(s.loads(), [], said);
  }
});

test("'No, K T P F' answers a pending 'Did you mean …?' for another station: the spelled station plays", async () => {
  const s = setup();
  assert.match((await s.say("Play KTPF HD."))?.say || "", /Which one\?/);
  assert.deepEqual(await s.say("No, K T P F two."), { say: "Playing KTPF HD2.", tier: "t1" });
  const t = setup();
  assert.deepEqual(await t.say("Play TPF."), ASK_HD1, "asked about HD1");
  assert.deepEqual(await t.say("No, K T P F two."), { say: "Playing KTPF HD2.", tier: "t1" }, "the spelling wins over the question");
});

test("partial or misheard spellings are asked about, never played on a guess; a yes then plays", async () => {
  for (const said of ["Play K T P.", "Play KTP.", "K T P.", "Play TPF.", "Play ATPF.", "ATPF.", "Play KTPF downtown.", "Play K T P F downtown."]) {
    const s = setup();
    assert.deepEqual(await s.say(said), ASK_HD1, said);
    assert.deepEqual(s.loads(), [], `${said}: nothing plays`);
    assert.deepEqual(await s.say("Yes."), PLAYING_HD1, `${said}: a yes takes it`);
  }
  // One letter off with a digit in it: KTP2 could be KTPF (the F heard as "2") or KTPF two. Both are offered.
  const s = setup();
  assert.deepEqual(await s.say("Play KTP2."), { say: "I found KTPF HD1 and KTPF HD2. Which one? Say its name.", tier: "t1" });
  assert.deepEqual(s.loads(), []);
  // A trailing word after an exact HD name asks about that one.
  assert.deepEqual(await setup().say("Play KTPF HD2 downtown."), { say: "Did you mean KTPF HD2? Say yes or its name.", tier: "t1" });
});

test("never a new guess: a different digit, one letter alone, ordinary words, or a call sign this instance does not have", async () => {
  for (const said of ["Play K.", "K.", "Play K T.", "Play W X.", "Play KTPF HD4.", "Play WXYZ.", "W X Y Z.", "Play candy puff.", "Play some jazz.", "Play the news.", "A B C.", "Play kept."]) {
    const s = setup();
    assert.equal(await s.say(said), null, said);
    assert.deepEqual(s.loads(), [], said);
  }
  // A station with no call sign is never "one letter off": "Play six" is not Morning Mix.
  for (const said of ["Play six.", "Play mi.", "Play mid."]) assert.equal(await setup({ stations: MIX }).say(said), null, said);
  // No radio source: a bare spelling is not a request at all.
  assert.equal(await setup({ stations: [] }).say("K T P F."), null);
  // The wake word in capitals is not a spelling.
  assert.equal(spelledCallSign("CROW."), null);
});

test("review I1/I2: near spellings need a request written as a call sign and an operator call sign: ordinary words and other sources are left alone", async () => {
  const words = normalizeStations([{ name: "JAZZ FM", aliases: ["ROCK"], url: "https://stream.example.invalid/j" }, { name: "Classic Country", url: "https://stream.example.invalid/c" }]);
  for (const said of ["Play sock.", "Play rocky.", "Play jaz.", "Play crop.", "Play classic country music.", "Play rock and roll."]) assert.equal(await setup({ stations: words }).say(said), null, said);
  // Written in capitals, against a capitals word with too few different consonants ("JAZZ"): still nothing.
  assert.equal(await setup({ stations: words }).say("Play JAZ."), null);
  // Lower-case STT output with vowels is not a call sign either: "Play atpf" is left to the model; capitals or no vowel ask.
  assert.equal(await setup().say("Play atpf."), null);
  assert.deepEqual(await setup().say("Play tpf."), ASK_HD1);
  // An auto search with another source's loose hit: the radio adds no near-spelling candidate for plain words.
  const { createSourceRegistry: reg } = await import("../bundles/kiosk/server/sources/index.js");
  const lib = { kind: "music", contract: 1, available: () => true, search: async () => [{ id: "al1", kind: "album", title: "Classic Country Music Hits", confident: false }], queue: async () => [], resolve: async () => null, choose: () => null };
  const resolver = createPlayResolver({ registry: reg([createStationsSource({ list: () => words }), lib]), now: () => 0 });
  const r = await resolver.resolve("classic country music", "auto", { strict: false });
  assert.notEqual(r.outcome, "choices", "not a 'Which one?' between the album and a station");
});

test("review minor: 'Pon la BBC' / 'Pon CNN' never make crow_play must-run", () => {
  const s = setup({ lang: "es" });
  const play = createDisplayTools(s.ctx).find((x) => x.definition.name === "crow_play");
  for (const said of ["Pon la BBC.", "Pon CNN."]) assert.equal(play.must(said), false, said);
});

test("Spanish: 'Pon K T P F', 'Pon la K T P F', Spanish letter names, 'No, dije …'", async () => {
  for (const said of ["Pon K T P F.", "Pon la K T P F.", "Ponme K T P F.", "No, dije K T P F.", "Pon KTPF.", "Ka te pe efe.", "Pon ka te pe efe."]) {
    const s = setup({ lang: "es" });
    assert.deepEqual(await s.say(said), { say: "Reproduciendo KTPF HD1.", tier: "t1" }, said);
  }
  const s = setup({ lang: "es" });
  assert.deepEqual(await s.say("Pon K T P."), { say: "¿Quisiste decir KTPF HD1? Di sí o su nombre.", tier: "t1" });
  assert.deepEqual(await s.say("Sí."), { say: "Reproduciendo KTPF HD1.", tier: "t1" });
  // "pon" still needs a media noun or a call sign: timers and cards keep it.
  assert.equal(await setup({ lang: "es" }).say("Pon un temporizador de cinco minutos."), null);
});

test("offered: a bare spelled call sign offers crow_play (never must-run); questions and displays with no radio do not", () => {
  const s = setup();
  for (const said of ["K T P F.", "K. T. P. F.", "No, K T P F.", "I said K T P F.", "Kay tee pee eff.", "K T P.", "Ka te pe efe.", "Pon K T P F.", "Pon K D B F."]) {
    assert.ok(s.offered(said).includes("crow_play"), said);
    assert.equal(createDisplayTools(s.ctx).find((x) => x.definition.name === "crow_play").must(said), false, `${said}: offered only`);
  }
  for (const said of ["Is it K T P F?", "What is K T P F?", "Oh, I see you."]) assert.ok(!s.offered(said).includes("crow_play"), said);
  assert.ok(!setup({ stations: [] }).offered("K T P F.").includes("crow_play"), "no radio presets");
});
