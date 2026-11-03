/**
 * F28a: "play a random album" — the kiosk understands a play request that names nothing to search
 * for, the music source picks an album out of its index, and it plays through the ordinary path:
 * at T1 with no model, and through crow_play for the model. Every album, artist and stream host
 * here is made up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlay, matchT1 } from "../bundles/kiosk/server/patterns.js";
import { createPlayResolver, createMediaVerbs } from "../bundles/kiosk/server/play.js";
import { createMediaStore } from "../bundles/kiosk/server/media.js";
import { createTicketStore } from "../bundles/kiosk/server/tickets.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { createSourceRegistry, SourceUnavailable } from "../bundles/kiosk/server/sources/index.js";
import { createMusicSource } from "../bundles/kiosk/server/sources/funkwhale.js";
import { publicHop } from "../bundles/kiosk/server/relay.js";
import { matchSpoken } from "../bundles/kiosk/server/tiers.js";
import { createDisplayTools } from "../bundles/kiosk/server/display-tools.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

// ── the words ────────────────────────────────────────────────────────────────────────────────────
test("every random form parses to a random play intent, keeping the words it was said in; a name, a genre or an ordinary sentence does not", () => {
  for (const [q, kind] of [
    ["play a random album", "album"], ["play any album", "album"], ["play an album", "album"], ["Play a random album, please.", "album"],
    ["play some music", "music"], ["play something", "music"], ["shuffle my music", "music"], ["shuffle up my music", "music"], ["play random music", "music"],
    ["pon un álbum al azar", "album"], ["pon cualquier álbum", "album"], ["pon música", "music"], ["pon algo de música", "music"],
    // Finding 3: Spanish "algo" asks for anything on its own, with or without "pon".
    ["pon algo", "music"], ["ponme algo", "music"], ["toca algo", "music"], ["reproduce algo", "music"],
    ["Put on a random album.", "album"], ["Play some songs.", "music"], ["Play music.", "music"],
  ]) {
    const p = parsePlay(q);
    assert.equal(p?.random, kind, q);
    assert.ok(typeof p.what === "string" && p.what.length > 0, `${q}: the words are kept, for a display with no music source`);
  }
  // A name or a genre is searched as before: "some jazz" is a genre request, never a random one.
  for (const q of ["play some jazz", "play Kind of Blue", "play the Night Owls", "play classic", "play WXYZ HD", "play something relaxing for dinner",
    "shuffle the cards", "shuffle up the cards", "shuffle that deck", "pon música de salsa", "Quiero escuchar la radio", "Pon un temporizador de cinco minutos",
    "pon algo de jazz", "toca algo de jazz", "play algo de jazz"]) {
    assert.equal(parsePlay(q)?.random, undefined, q);
  }
  assert.deepEqual(parsePlay("Play some jazz."), { what: "some jazz" }, "unchanged: still the words, searched");
  assert.deepEqual(parsePlay("pon algo de jazz"), null, "a kind of music after 'algo' names something to search for, not a random request");
  assert.deepEqual(parsePlay("play algo de jazz"), { what: "algo de jazz" }, "…and where a play verb carries the words, they are searched");
  // T1 marks the intent random, and only where a music source can pick.
  const ctx = { sources: ["music"], items: [], deviceId: "d" };
  assert.deepEqual(matchT1("play a random album", ctx), { verb: "play", random: "album", source: "music" });
  assert.deepEqual(matchT1("Pon algo de música", ctx), { verb: "play", random: "music", source: "music" });
  assert.deepEqual(matchT1("toca algo", ctx), { verb: "play", random: "music", source: "music" });
  assert.equal(matchT1("play some jazz", ctx)?.random, undefined, "a genre keeps today's behaviour");
});

test("finding 1: a radio-only display keeps today's play path — every random form is searched, never a random pick", () => {
  const radio = { sources: ["radio"], items: [], deviceId: "d" };
  assert.deepEqual(matchT1("play some music", radio), { verb: "play", what: "some music", source: "auto" });
  assert.deepEqual(matchT1("play a random album", radio), { verb: "play", what: "a random album", source: "auto" });
  assert.deepEqual(matchT1("shuffle my music", radio), { verb: "play", what: "music", source: "auto" });
  assert.deepEqual(matchT1("pon algo de música", radio), { verb: "play", what: "musica", source: "auto" });
  assert.deepEqual(matchT1("toca algo", radio), { verb: "play", what: "algo", source: "auto" });
  assert.equal(matchT1("play some music", { ...radio, sources: [] }), null, "no source at all: nothing is handled at T1, as before");
});

test("finding 4: 'shuffle up my music' is the longer shuffle form, tried first; 'shuffle up the cards' is still no play request", () => {
  assert.deepEqual(parsePlay("shuffle up my music"), { random: "music", what: "music" });
  assert.equal(parsePlay("shuffle up the cards"), null);
  assert.deepEqual(matchT1("Shuffle up my music.", { sources: ["music"], items: [], deviceId: "d" }), { verb: "play", random: "music", source: "music" });
});

// ── the pick ─────────────────────────────────────────────────────────────────────────────────────
const CFG = { base: "http://127.0.0.1:8600", token: "tok-Zq7-not-a-real-token", storageOrigin: "http://203.0.113.9:9000" };
const ALBUMS = [
  { id: 1, title: "Harbour Static", artist: "Quartz Heron Trio", tracks: ["Undertow", "Second Light"] },
  { id: 2, title: "Paper Lanterns", artist: "Okapi Sunday", tracks: ["Kite", "Third Rail"] },
  { id: 3, title: "Slow Traffic", artist: "Tanglewire", tracks: ["Ramp"] },
];
/** A Funkwhale-shaped fake: the album, tag, artist, playlist and track-per-album lists, nothing else. */
function fakeLibrary(albums = ALBUMS) {
  const rows = albums.map((a) => ({ id: a.id, title: a.title, artist: { id: a.id * 10, name: a.artist }, tracks_count: a.tracks.length, release_date: "2003-04-05" }));
  const list = (results) => ({ status: 200, ok: true, json: async () => ({ count: results.length, next: null, previous: null, results }) });
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/albums/") return list(rows);
    if (u.pathname === "/api/v1/tags/") return list([]);
    if (u.pathname === "/api/v1/artists/") return list(rows.map((r) => r.artist));
    if (u.pathname === "/api/v1/playlists/") return list([]);
    if (u.pathname === "/api/v1/tracks/") {
      const album = albums.find((a) => String(a.id) === u.searchParams.get("album"));
      const tracks = album ? album.tracks.map((t, i) => ({ id: album.id * 100 + i, title: t, artist: { id: album.id * 10, name: album.artist }, album: { id: album.id, title: album.title },
        disc_number: 1, position: i + 1, is_playable: true, listen_url: `/api/v1/listen/00000000-0000-4000-8000-${String(album.id * 100 + i).padStart(12, "0")}/`, uploads: [{ extension: "mp3", duration: 200 }] })) : [];
      return list(tracks);
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
}
const musicSource = ({ albums = ALBUMS } = {}) => createMusicSource({ config: () => CFG, fetchImpl: fakeLibrary(albums), autoStart: false,
  timers: { setTimeout: () => ({}), clearTimeout: () => {} }, clock: () => 0 });

test("randomAlbum: one album out of the index, in the shape a normal album match gives; the pick queues through the existing path", async () => {
  const src = musicSource();
  assert.equal(await src.refresh(), true);
  assert.deepEqual(src.randomAlbum(() => 0), { id: "music:album:1", kind: "album", title: "Harbour Static", subtitle: "Quartz Heron Trio", confident: true });
  assert.equal(src.randomAlbum(() => 0.4).title, "Paper Lanterns");
  assert.equal(src.randomAlbum(() => 0.999).title, "Slow Traffic");
  assert.equal(src.randomAlbum(() => 1).title, "Slow Traffic", "a random function that returns 1 stays inside the index");
  const q = await src.queue(src.randomAlbum(() => 0.4));
  assert.deepEqual(q.map((p) => p.title), ["Kite", "Third Rail"], "an album is its tracks, in order");
  assert.equal(src.randomAlbum(() => 0.4).id, "music:album:2", "each call picks again");
  assert.equal(musicSource({ albums: [] }).randomAlbum(() => 0.5), null, "an index with no album yet");
  assert.equal(createMusicSource({ config: () => null }).randomAlbum(), null, "not configured: nothing to pick from");
});

// ── T1 and the model, on a display ───────────────────────────────────────────────────────────────
/** A library-shaped source whose randomAlbum() picks its one album: albums = [{ id, title, artist, tracks }]. */
function fakeMusic(albums = [ALBUMS[0]], over = {}) {
  const up = (t) => { const url = `https://music.example.invalid/listen/${encodeURIComponent(t)}`; return { url, hop: publicHop(url) }; };
  const cand = (a) => ({ id: a.id, kind: "album", title: a.title, subtitle: a.artist, confident: true });
  const tracks = (a) => a.tracks.map((t, i) => ({ kind: "track", id: `${a.id}:${i}`, title: t, subtitle: a.title, form: "audio", codec: "mp3", source: "music", upstream: up(t) }));
  return { kind: "music", contract: 1, available: () => true,
    search: async () => [],
    queue: async (c) => { const a = albums.find((x) => x.id === c.id); return a ? tracks(a) : []; },
    resolve: async (c) => tracks(albums.find((x) => x.id === c.id))[0],
    choose: () => null,
    randomAlbum: () => (albums.length ? cand(albums[0]) : null),
    ...over };
}
/** A radio-only source that finds nothing: the display has no music source, as before this branch. */
const fakeRadio = (over = {}) => ({ kind: "radio", contract: 1, available: () => true, search: async () => [], queue: async () => [], resolve: async () => null, choose: () => null, ...over });
function setup({ sources = [fakeMusic()], lang = "en" } = {}) {
  const sent = [];
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  const tickets = createTicketStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  const media = createMediaStore({ now: () => 0, tickets, send: (id, m) => { sent.push(m); return true; }, setTimer: () => ({}), clearTimer: () => {} });
  const registry = createSourceRegistry(sources);
  const resolver = createPlayResolver({ registry, now: () => 0 });
  const verbs = createMediaVerbs({ media, resolver });
  const ctx = { store, deviceId: "d", caps: { windows: ["timer", "recipe", "content"], max_windows: 4, kinds: ["card", "timer", "nowplaying"] }, lang,
    sources: registry.kinds(), items: [], emit: () => {}, media, ...verbs };
  const say = async (t, c = ctx) => { const r = await matchSpoken(t, c); return r ? { say: r.say, tier: r.tier } : null; };
  const tool = (name, c = ctx) => { const t = createDisplayTools(c).find((x) => x.definition.name === name); return async (args, transcript = "") => JSON.parse(await t.execute(args, { transcript })); };
  return { ctx, sent, media, store, resolver, say, tool, es: { ...ctx, lang: "es" } };
}
const loads = (s) => s.sent.filter((m) => m.action === "load");

test("T1: 'play a random album' plays without a model and the spoken line names the album and its artist (en + es)", async () => {
  const s = setup();
  assert.deepEqual(await s.say("Play a random album."), { say: "Playing Harbour Static by Quartz Heron Trio.", tier: "t1" });
  assert.deepEqual([loads(s).at(-1).title, loads(s).at(-1).source], ["Undertow", "music"]);
  for (const q of ["Play any album.", "Play some music.", "Shuffle my music.", "Hey Crow, play something."]) assert.equal((await s.say(q))?.tier, "t1", q);
  const es = setup({ lang: "es" });
  assert.equal((await es.say("Pon un álbum al azar.", es.es)).say, "Reproduciendo Harbour Static de Quartz Heron Trio.");
  assert.equal((await es.say("Pon algo de música.", es.es)).tier, "t1");
  // A source with no artist on the pick still says what plays.
  const bare = setup({ sources: [fakeMusic([{ ...ALBUMS[1], artist: "" }])] });
  assert.deepEqual(await bare.say("Play a random album."), { say: "Playing Paper Lanterns.", tier: "t1" });
});

test("T1: with no music source the request is not handled there (today's behaviour: the model gets the turn); an empty index is a miss", async () => {
  const none = setup({ sources: [] });
  assert.equal(matchT1("Play a random album.", none.ctx), null);
  assert.equal(await none.say("Play a random album."), null);
  assert.equal(none.sent.length, 0, "nothing was sent to the page");
  // A radio-only display: the random form is searched like any other play request, and finds no station here.
  const radio = setup({ sources: [fakeRadio()] });
  assert.deepEqual(matchT1("Play a random album.", radio.ctx), { verb: "play", what: "a random album", source: "auto" });
  assert.equal(await radio.say("Play a random album."), null, "nothing found: the model gets the turn");
  assert.equal(radio.sent.length, 0);
  // A music source that has no album to pick from: T1 says nothing and the turn goes on, as any miss does.
  const empty = setup({ sources: [fakeMusic([], { randomAlbum: () => null })] });
  assert.equal(await empty.say("Play a random album."), null);
  // The resolver's own answer when this display has no music source at all.
  assert.deepEqual(await none.resolver.random("d"), { outcome: "unavailable", code: "none" });
});

test("crow_play: random true plays a random album for the model, and the tool says so in one clause", async () => {
  const s = setup();
  const def = createDisplayTools(s.ctx).find((t) => t.definition.name === "crow_play").definition;
  assert.equal(def.inputSchema.properties.random.type, "boolean");
  assert.match(def.description, /random true/);
  assert.ok(def.description.length <= 240 && !def.description.includes("\n"), "one line, as the other tools");
  assert.deepEqual(await s.tool("crow_play")({ random: true }, "Play a random album."), { ok: true, outcome: "playing", say: "Playing Harbour Static by Quartz Heron Trio.", final: true, title: "Harbour Static" });
  assert.equal(loads(s).at(-1).title, "Undertow");
  // The model may also copy the words into `what`: random still picks (here, the album already on says so).
  assert.equal((await s.tool("crow_play")({ what: "a random album", random: true })).title, "Harbour Static");
  const es = setup({ lang: "es" });
  assert.equal((await es.tool("crow_play")({ random: true }, "Pon música.")).say, "Reproduciendo Harbour Static de Quartz Heron Trio.");
});

test("finding 2: crow_play honours random only when what is empty or is itself a random form; otherwise what wins", async () => {
  const s = setup();
  const play = s.tool("crow_play");
  const jazz = await play({ what: "jazz", random: true });
  assert.deepEqual([jazz.ok, jazz.outcome, jazz.say], [false, "not_found", "I couldn't find jazz to play."], "what wins: jazz is searched, not picked at random");
  assert.equal(loads(s).length, 0, "nothing played");
  assert.equal((await play({ what: "a random album", random: true })).title, "Harbour Static", "what is itself a random form: random is honoured");
  assert.equal((await play({ what: "some music", random: true })).title, "Harbour Static");
  assert.equal((await play({ random: true })).title, "Harbour Static", "an empty what: random is honoured");
});

test("finding 5: an index still being read says so, instead of 'I couldn't find an album'", async () => {
  const cold = () => fakeMusic([], { randomAlbum: () => null, indexState: () => ({ warm: false, artists_complete: false, building: true }) });
  const s = setup({ sources: [cold()] });
  assert.deepEqual(await s.tool("crow_play")({ random: true }), { ok: false, outcome: "unavailable", reason: "loading", say: STRINGS.en.say_music_loading, final: true });
  assert.equal((await s.say("Play a random album."))?.say, STRINGS.en.say_music_loading, "the same with no model");
  const es = setup({ sources: [cold()], lang: "es" });
  assert.equal((await es.tool("crow_play")({ random: true })).say, "La biblioteca de música todavía se está cargando. Inténtalo en un minuto.");
  assert.equal((await es.say("Pon algo de música.", es.es))?.say, STRINGS.es.say_music_loading);
  // A warm library that really holds no album is still the nothing-found answer.
  const warmEmpty = setup({ sources: [fakeMusic([], { randomAlbum: () => null, indexState: () => ({ warm: true }) })] });
  assert.equal((await warmEmpty.tool("crow_play")({ random: true })).say, STRINGS.en.say_play_random_none);
  // The real music source reports a cold index before its first build lands.
  assert.equal(musicSource().indexState().warm, false);
});

test("crow_play: an empty index is the nothing-found answer, and a music source that cannot look says why", async () => {
  const empty = setup({ sources: [fakeMusic([], { randomAlbum: () => null })] });
  assert.deepEqual(await empty.tool("crow_play")({ random: true }), { ok: false, outcome: "not_found", say: "I couldn't find an album to play.", final: true });
  const es = setup({ sources: [fakeMusic([], { randomAlbum: () => null })], lang: "es" });
  assert.equal((await es.tool("crow_play")({ random: true })).say, "No encontré ningún álbum para reproducir.");
  // A source that is down is never read as "not found".
  const down = setup({ sources: [fakeMusic(ALBUMS, { randomAlbum: () => { throw new SourceUnavailable("unreachable"); } })] });
  const r = await down.tool("crow_play")({ random: true });
  assert.deepEqual([r.ok, r.outcome, r.reason], [false, "unavailable", "unreachable"]);
  assert.equal(r.say, STRINGS.en.say_play_unreachable.replace("{source}", STRINGS.en.source_music));
});