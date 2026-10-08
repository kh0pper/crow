/**
 * The music library source (bundles/kiosk/server/sources/funkwhale.js) against a FAKE Funkwhale:
 * a fetchImpl that answers by pathname from fixture lists, paginates like the real server (50 a
 * page, a `next` link written with the server's PUBLIC name) and records every request. No
 * network, no real server, no real names: every artist, album and track here is made up.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createMusicSource, readMusicConfig, originOf, libraryHop, listenUpstream, listenUuid, parseListenUrl, needsTranscode, checkStorage,
  LISTEN_PATH, DIRECT_EXTENSIONS, QUEUE_DEFAULT, REFRESH_MS } from "../bundles/kiosk/server/sources/funkwhale.js";
import { SourceUnavailable } from "../bundles/kiosk/server/sources/index.js";

const BASE = "http://127.0.0.1:8600";                       // what the adapter calls
const PUBLIC = "https://music.example.invalid:8446";        // what the server calls itself (its `next` links)
const STORAGE = "http://203.0.113.9:9000";                  // where a listen address redirects to
const TOKEN = "tok-Zq7-not-a-real-token";
const CONFIG = { base: BASE, token: TOKEN, storageOrigin: STORAGE, publicOrigin: PUBLIC };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ARTISTS = [
  { id: 1, name: "The Velvet Marmots" }, { id: 2, name: "Quartz Heron Trio" }, { id: 3, name: "Zélie Marchevô" }, { id: 5, name: "Okapi Sunday" },
  { id: 6, name: "Tanglewire" }, { id: 11, name: "Various Marmots" }, { id: 12, name: "Lone Kestrel" },   // 12 has no album of their own
];
const artist = (id) => ({ id, name: ARTISTS.find((a) => a.id === id).name });

/** A library like the real one in shape: shared titles, a two-disc album, an album over one page, mixed file types. */
function library() {
  const albums = [], tracks = [];
  let tid = 1000;
  const album = (id, title, artistId, rows) => {
    albums.push({ id, title, artist: artist(artistId), release_date: "2004-05-06", tracks_count: rows.length, is_playable: true });
    for (const r of rows) {
      tid += 1;
      tracks.push({ id: tid, title: r.title || `${title} — part ${r.pos}`, artist: artist(r.artist || artistId), album: { id, title }, disc_number: r.disc || 1, position: r.pos, is_playable: true,
        listen_url: `/api/v1/listen/${uuid(tid)}/`, tags: r.tags || [],
        // The MIME type is corrupted, as on a library imported from files: only the extension can be trusted.
        uploads: r.uploads || [{ extension: r.ext ?? "mp3", mimetype: "audio/mpegapplication/octet-stream", duration: 180 + r.pos }] });
    }
  };
  const run = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ pos: i + 1, ...extra }));
  album(100, "The Cobalt Pantry", 1, run(9, { tags: ["Jazz"] }));
  album(103, "Café Zénith", 3, run(4));
  // FRAGMENTS: one compilation, split by artist; positions say where each part belongs.
  album(120, "Harbor Lights, Vol. 1", 1, [{ pos: 3 }]);
  album(121, "Harbor Lights, Vol. 1", 2, [{ pos: 1 }]);
  album(122, "Harbor Lights, Vol. 1", 5, [{ pos: 2 }, { pos: 5 }]);
  album(123, "Harbor Lights, Vol. 1", 6, [{ pos: 4 }]);
  // DOMINANT.
  album(130, "Tin Roof Sessions", 2, run(12));
  album(131, "Tin Roof Sessions", 5, run(2));
  album(132, "Tin Roof Sessions", 6, run(1));
  // ASK.
  album(140, "Greatest Misses", 1, run(10));
  album(141, "Greatest Misses", 3, run(9));
  // Two discs, stored interleaved: the list's own order (and ordering=position) would play disc 2 between disc 1.
  album(170, "Double Lantern", 2, [{ disc: 1, pos: 1 }, { disc: 2, pos: 1 }, { disc: 1, pos: 2 }, { disc: 2, pos: 2 }, { disc: 2, pos: 3 }, { disc: 1, pos: 3 }]);
  album(180, "The Long Drive", 5, run(120, { tags: ["Rock"] }));
  album(190, "Formats", 6, [{ pos: 1, ext: "mp3" }, { pos: 2, ext: "flac" }, { pos: 3, ext: "m4a" }, { pos: 4, ext: "aiff" }, { pos: 5, ext: "ogg" }, { pos: 6, ext: "opus" },
    { pos: 7, ext: "" }, { pos: 8, ext: "MP3" }, { pos: 9, uploads: [] }, { pos: 10, ext: "wav" },
    { pos: 11, uploads: [{ extension: "mp3" }, { extension: "m4a" }] }, { pos: 12, uploads: [{ extension: "mp3", duration: 61 }, { extension: "mp3" }] }]);
  // An album artist who is never a track's artist: its tracks are credited to others.
  album(162, "Soundtrack", 11, [{ pos: 1, artist: 6 }, { pos: 2, artist: 5 }]);
  tracks.push({ id: 5000, title: "Kestrel Hours", artist: artist(12), album: { id: 100, title: "The Cobalt Pantry" }, disc_number: 1, position: 99, is_playable: true, listen_url: `/api/v1/listen/${uuid(5000)}/`, tags: ["HipHop"], uploads: [{ extension: "mp3" }] });
  // 60 tags with "rock" in them come before the exact one: it is on the SECOND page of a tag search.
  const tags = [...Array.from({ length: 60 }, (_, i) => ({ name: `Rockabilly${i + 1}` })), { name: "Rock" }, { name: "HipHop" }, { name: "Jazz" }];
  return { albums, tracks, artists: ARTISTS.map((a) => ({ ...a })), tags, playlists: [{ id: 7, name: "Dinner" }], playlistTracks: { 7: [1001, 1003, 1002] } };
}

const EVERY_CALL = [];
/** fetchImpl for a library. mode: { status, throws, hang, notJson } break every request; hold(url) → a promise the answer waits for. */
function fakeFunkwhale(lib = library(), { mode = {}, hold = null } = {}) {
  const calls = [];
  const has = (hay, q) => String(hay).toLowerCase().includes(String(q).toLowerCase());      // like the server: no accent folding
  const page = (u, rows) => {
    const size = Math.min(Number(u.searchParams.get("page_size")) || 50, 50);
    const n = Number(u.searchParams.get("page")) || 1;
    const next = n * size < rows.length ? `${PUBLIC}${u.pathname}?page=${n + 1}&page_size=${size}` : null;
    return { count: rows.length, next, previous: null, results: rows.slice((n - 1) * size, n * size) };
  };
  const answer = (u) => {
    const p = u.pathname, q = u.searchParams;
    let m;
    if (p === "/api/v1/albums/") return page(u, lib.albums.filter((a) => !q.get("q") || has(a.title, q.get("q"))));
    if (p === "/api/v1/artists/") return page(u, lib.artists.filter((a) => !q.get("q") || has(a.name, q.get("q"))));
    if (p === "/api/v1/tags/") return page(u, lib.tags.filter((t) => !q.get("q") || has(t.name, q.get("q"))));
    if ((m = /^\/api\/v1\/tags\/([A-Za-z0-9_]+)\/$/.exec(p))) return lib.tags.find((t) => t.name.toLowerCase() === m[1].toLowerCase()) || 404;
    if (p === "/api/v1/playlists/") return page(u, lib.playlists);
    if ((m = /^\/api\/v1\/playlists\/(\d+)\/tracks\/$/.exec(p))) return page(u, (lib.playlistTracks[m[1]] || []).map((id, index) => ({ index, track: lib.tracks.find((t) => t.id === id) })));
    if ((m = /^\/api\/v1\/tracks\/(\d+)\/$/.exec(p))) return lib.tracks.find((t) => String(t.id) === m[1]) || 404;
    if (p === "/api/v1/tracks/") {
      let rows = lib.tracks.filter((t) => (!q.get("album") || String(t.album.id) === q.get("album"))
        && (!q.get("artist") || String(t.artist.id) === q.get("artist") || String(lib.albums.find((a) => a.id === t.album.id)?.artist.id) === q.get("artist"))
        && (!q.get("tag") || t.tags.some((x) => x.toLowerCase() === q.get("tag").toLowerCase()))
        && (!q.get("q") || has(t.title, q.get("q")) || has(t.artist.name, q.get("q"))));
      const ordering = q.get("ordering");
      if (ordering === "disc_number,position") rows = [...rows].sort((a, b) => (a.disc_number - b.disc_number) || (a.position - b.position));
      else if (ordering === "position") rows = [...rows].sort((a, b) => a.position - b.position);
      else if (ordering === "random") rows = [...rows].reverse();
      return page(u, rows);
    }
    return 404;
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = { url: String(url), origin: u.origin, path: u.pathname, params: Object.fromEntries(u.searchParams), auth: init.headers?.Authorization ?? null, method: init.method || "GET", redirect: init.redirect };
    calls.push(call);
    EVERY_CALL.push(call);
    if (mode.throws) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (mode.hang) await new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), { once: true }));
    if (hold) await hold(u);
    if (init.signal?.aborted) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    if (mode.status) return { status: mode.status, ok: false, json: async () => ({ detail: "no" }) };
    if (mode.notJson) return { status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    const body = answer(u);
    return body === 404 ? { status: 404, ok: false, json: async () => ({ detail: "Not found." }) } : { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl, calls, lib, paths: () => calls.map((c) => c.path), reset: () => { calls.length = 0; } };
}
/** Timers that never fire by themselves. */
function fakeTimers() {
  const pending = new Set();
  return { pending, setTimeout: (fn, ms) => { const t = { fn, ms }; pending.add(t); return t; }, clearTimeout: (t) => { pending.delete(t); },
    fire: (ms) => { for (const t of [...pending]) if (t.ms === ms) { pending.delete(t); t.fn(); } } };
}
function source(fw = fakeFunkwhale(), extra = {}) {
  const timers = fakeTimers();
  let now = 1_000_000;
  const src = createMusicSource({ config: () => CONFIG, fetchImpl: fw.fetchImpl, clock: () => now, timers, autoStart: false, ...extra });
  return { src, fw, timers, advance: (ms) => { now += ms; } };
}
async function warm(fw = fakeFunkwhale(), extra) {
  const s = source(fw, extra);
  assert.equal(await s.src.refresh(), true);
  fw.reset();
  return s;
}
const sure = (list) => { assert.equal(list.length, 1, JSON.stringify(list)); assert.equal(list[0].confident, true); return list[0]; };
const trackNo = (p) => Number(p.id.split(":")[2]);

after(() => {
  // Across every test in this file: only GETs, only to the configured origin, the token only in the header.
  assert.ok(EVERY_CALL.length > 100);
  for (const c of EVERY_CALL) {
    assert.equal(c.origin, BASE, `a request left the configured origin: ${c.origin}${c.path}`);
    assert.equal(c.method, "GET", `nothing is written to the library: ${c.method} ${c.path}`);
    assert.ok(!c.url.includes(TOKEN), "the token is never part of an address");
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.equal(c.redirect, "manual", "a redirect is never followed with the credential");
    assert.ok(!c.path.includes("/history/"), "no listen is recorded");
    assert.ok(c.path.startsWith("/api/v1/"));
  }
});

test("the contract: kind, version, and the settings it needs — not configured means unavailable and nothing is fetched", async () => {
  const fw = fakeFunkwhale();
  const ok = createMusicSource({ config: () => CONFIG, fetchImpl: fw.fetchImpl, autoStart: false });
  assert.equal(ok.kind, "music");
  assert.equal(ok.contract, 1);
  assert.equal(ok.available(), true, "configured — whether the server answers is not asked");
  for (const k of ["search", "queue", "resolve", "choose"]) assert.equal(typeof ok[k], "function", k);
  const bad = [null, {}, { ...CONFIG, token: "" }, { ...CONFIG, token: "two words" }, { ...CONFIG, base: "" }, { ...CONFIG, base: "ftp://127.0.0.1" }, { ...CONFIG, base: `${BASE}/music` },
    { ...CONFIG, base: "http://user:pw@127.0.0.1:8600" }, { ...CONFIG, storageOrigin: undefined }, { ...CONFIG, storageOrigin: `${STORAGE}/bucket` }, { ...CONFIG, storageOrigin: "storage" }];
  for (const c of bad) {
    const src = createMusicSource({ config: () => c, fetchImpl: fw.fetchImpl });
    assert.equal(src.available(), false, JSON.stringify(c));
    assert.deepEqual(await src.search("the cobalt pantry"), []);
    assert.deepEqual(await src.queue({ id: "music:album:100" }), []);
    await assert.rejects(src.resolve({ id: "music:album:100" }));
    assert.equal(await src.refresh(), false);
  }
  assert.equal(createMusicSource({ config: () => { throw new Error("settings unreadable"); }, fetchImpl: fw.fetchImpl }).available(), false);
  assert.equal(createMusicSource({ fetchImpl: fw.fetchImpl }).available(), false);
  assert.equal(fw.calls.length, 0, "nothing was fetched");
  assert.deepEqual(readMusicConfig({ base: `${BASE}/`, token: ` ${TOKEN} `, storageOrigin: STORAGE }), { base: BASE, token: TOKEN, storageOrigin: STORAGE, publicOrigin: null });
  assert.equal(originOf("https://music.example.invalid:443/"), "https://music.example.invalid");
  assert.equal(originOf("https://music.example.invalid/?x=1"), null);
});

test("cold (no index yet): the server's own lists are asked, and the album is found", async () => {
  const { src, fw } = source();
  assert.deepEqual(sure(await src.search("the cobalt pantry")), { id: "music:album:100", kind: "album", title: "The Cobalt Pantry", subtitle: "The Velvet Marmots", confident: true });
  assert.equal(src.indexState().warm, false);
  const asked = fw.calls.map((c) => `${c.path}${c.params.q ? `?q=${c.params.q}` : ""}`);
  for (const p of ["/api/v1/albums/?q=the cobalt pantry", "/api/v1/artists/?q=the cobalt pantry", "/api/v1/tags/?q=the cobalt pantry", "/api/v1/tags/thecobaltpantry/", "/api/v1/playlists/"]) assert.ok(asked.includes(p), `${p} in ${asked.join(" ")}`);
  assert.ok(fw.calls.length <= 8, `a cold search is a handful of small calls (${fw.calls.length})`);
  // A candidate carries no address and no credential.
  const text = JSON.stringify(await src.search("greatest misses"));
  assert.ok(!text.includes(TOKEN) && !text.includes("127.0.0.1") && !text.includes("example.invalid") && !text.includes("203.0.113"));
});

test("cold: a genre whose exact tag is on the SECOND page of the tag search is found by its exact name; a run-together tag from its spoken form", async () => {
  const { src, fw } = source();
  const firstPage = (await (await fw.fetchImpl(`${BASE}/api/v1/tags/?q=rock&page_size=50`, { headers: { Authorization: `Bearer ${TOKEN}` }, redirect: "manual" })).json()).results;
  assert.ok(!firstPage.some((t) => t.name === "Rock"), "the fixture: the exact tag is not among the first fifty hits");
  fw.reset();
  assert.deepEqual(sure(await src.search("some rock")), { id: "music:genre:rock", kind: "genre", title: "Rock", subtitle: "", confident: true });
  assert.ok(fw.paths().includes("/api/v1/tags/rock/"), "the exact lookup");
  assert.equal(sure(await src.search("some hip hop")).title, "HipHop");
  assert.ok(fw.paths().includes("/api/v1/tags/hiphop/"));
  // The queue can be built from the candidate alone (there is still no index): the exact tag name is its title.
  fw.reset();
  const q = await src.queue({ id: "music:genre:hiphop", kind: "genre", title: "HipHop" });
  assert.deepEqual(fw.calls.map((c) => [c.path, c.params.tag, c.params.ordering]), [["/api/v1/tracks/", "HipHop", "random"]]);
  assert.equal(q.length, 1);
  assert.deepEqual(await src.queue({ id: "music:genre:hiphop", kind: "genre", title: "Something else" }), [], "a title that is not that genre names no tag");
});

test("the index: built from paged lists (the `next` address itself is never fetched), usable before the slow artist listing ends, never blocking a search", async () => {
  // The two slow listings (no search words) wait at a gate each; searches pass.
  const gates = {};
  const gate = (name) => new Promise((res) => { gates[name] = res; });
  const waits = { "/api/v1/albums/": gate("albums"), "/api/v1/artists/": gate("artists") };
  const fw = fakeFunkwhale(library(), { hold: (u) => (u.searchParams.get("q") ? null : waits[u.pathname]) });
  const { src, timers } = source(fw);
  const built = src.refresh();
  assert.equal(src.refresh(), built, "one build at a time");
  // While the albums are still being listed, a search answers from the server's own lists.
  assert.equal(sure(await src.search("tin roof sessions")).id, "music:album:130");
  assert.equal(src.indexState().warm, false);
  assert.ok(fw.calls.some((c) => c.path === "/api/v1/albums/" && c.params.q === "tin roof sessions"));
  gates.albums();
  for (let i = 0; i < 200 && !src.indexState().warm; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual({ ...src.indexState(), built_at: 0 }, { warm: true, artists_complete: false, building: true, error: null, built_at: 0, albums: 15, artists: 6, genres: 63, playlists: 1 },
    "albums, genres and playlists are in; the artists so far are the album artists");
  fw.reset();
  // An artist with no album of their own is not in the index yet: asked for live.
  assert.equal(sure(await src.search("lone kestrel")).id, "music:artist:12");
  assert.ok(fw.calls.some((c) => c.path === "/api/v1/artists/" && c.params.q === "lone kestrel"));
  const release = gates.artists;
  release();
  assert.equal(await built, true);
  assert.equal(src.indexState().artists_complete, true);
  assert.equal(src.indexState().artists, 7);
  fw.reset();
  assert.equal(sure(await src.search("lone kestrel")).id, "music:artist:12");
  assert.deepEqual(fw.paths(), [], "now from the index: no request at all");
  // Paging: 63 tags are two pages; each page was asked for by NUMBER on the configured origin.
  const tagPages = EVERY_CALL.filter((c) => c.path === "/api/v1/tags/" && !c.params.q).slice(-2).map((c) => c.params.page || "1");
  assert.deepEqual(tagPages, ["1", "2"]);
  // The next build is six hours away, on the injected timer; stop() leaves no timer behind.
  src.start();
  await src.refresh();
  assert.deepEqual([...timers.pending].map((t) => t.ms), [REFRESH_MS]);
  src.stop();
  assert.equal(timers.pending.size, 0);
});

test("the index: a refresh is cancellable, a failed build is retried sooner, and a stopped source builds nothing by itself", async () => {
  // stop() during a build: the build ends false, aborts its request, and schedules nothing.
  let release;
  const fw = fakeFunkwhale(library(), { hold: (u) => (u.pathname === "/api/v1/albums/" ? new Promise((res) => { release = res; }) : null) });
  const a = source(fw);
  a.src.start();
  const building = a.src.refresh();
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((r) => setImmediate(r));
  a.src.stop();
  release();
  assert.equal(await building, false);
  assert.equal(a.timers.pending.size, 0, "no timer left running");
  assert.equal(a.src.indexState().warm, false);
  // A build that fails says why and tries again in five minutes, not six hours.
  const down = source(fakeFunkwhale(library(), { mode: { throws: true } }));
  down.src.start();
  assert.equal(await down.src.refresh(), false);
  assert.equal(down.src.indexState().error, "unreachable");
  assert.deepEqual([...down.timers.pending].map((t) => t.ms), [5 * 60 * 1000]);
  down.src.stop();
  // autoStart: the first search begins the build in the background and does not wait for it.
  const auto = source(fakeFunkwhale(), { autoStart: true });
  assert.equal(sure(await auto.src.search("the cobalt pantry")).id, "music:album:100");
  for (let i = 0; i < 200 && !auto.src.indexState().artists_complete; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(auto.src.indexState().artists_complete, true);
  auto.src.stop();
  assert.equal(auto.timers.pending.size, 0);
});

test("warm: genres by spoken form with no request; an accented artist asked without accents; titles with 'the'", async () => {
  const { src, fw } = await warm();
  assert.deepEqual(sure(await src.search("some hip hop")), { id: "music:genre:hiphop", kind: "genre", title: "HipHop", subtitle: "", confident: true });
  assert.equal(sure(await src.search("some rock")).title, "Rock");
  assert.equal(sure(await src.search("zelie marchevo")).id, "music:artist:3");
  assert.equal(sure(await src.search("cafe zenith")).id, "music:album:103");
  assert.equal(sure(await src.search("cobalt pantry")).id, "music:album:100");
  assert.equal(sure(await src.search("various marmots")).id, "music:artist:11", "an album artist who is never a track's artist");
  assert.deepEqual(fw.paths(), [], "all of it from the index");
  // A track title is searched live: as spoken and, when different, as folded.
  assert.equal(sure(await src.search("Kestrel Hours")).id, "music:track:5000");
  assert.deepEqual(fw.calls.map((c) => [c.path, c.params.q]), [["/api/v1/tracks/", "Kestrel Hours"]]);
  fw.reset();
  await src.search("L'été à Kestrel");
  assert.deepEqual(fw.calls.map((c) => c.params.q), ["L'été à Kestrel", "lete a kestrel"]);
  assert.deepEqual(await src.search("a record nobody ever made"), [], "the server answered and has no such thing: not found");
  assert.deepEqual(await src.search(""), []);
  assert.equal(sure(await src.search("some music")).id, "music:library:all");
  assert.equal(sure(await src.search("", { explicit: true, lang: "es" })).title, "música");
});

test("warm: playlists are listed again after five minutes, not on every search", async () => {
  const { src, fw, advance } = await warm();
  assert.equal(sure(await src.search("dinner")).id, "music:playlist:7");
  assert.deepEqual(fw.paths(), []);
  fw.lib.playlists.push({ id: 8, name: "Porch Evenings" });
  advance(5 * 60 * 1000 + 1);
  assert.equal(sure(await src.search("porch evenings")).id, "music:playlist:8");
  assert.deepEqual(fw.paths(), ["/api/v1/playlists/"]);
  fw.reset();
  const q = await src.queue({ id: "music:playlist:7" });
  assert.deepEqual(q.map(trackNo), [1001, 1003, 1002], "a playlist in its own order");
  assert.deepEqual(fw.paths(), ["/api/v1/playlists/7/tracks/"]);
});

test("a shared title, three ways: fragments end in ONE merged queue in disc and track order, a dominant album plays, the rest is a question", async () => {
  const { src, fw } = await warm();
  // FRAGMENTS.
  const merged = sure(await src.search("harbor lights vol 1"));
  assert.deepEqual(merged.group, ["120", "121", "122", "123"]);
  const q = await src.queue(merged);
  assert.deepEqual(q.map((p) => p.subtitle.split(" — ")[0]), ["Quartz Heron Trio", "Okapi Sunday", "The Velvet Marmots", "Tanglewire", "Okapi Sunday"], "positions 1 to 5 across the four parts");
  assert.deepEqual(fw.calls.map((c) => [c.params.album, c.params.ordering]), [["120", "disc_number,position"], ["121", "disc_number,position"], ["122", "disc_number,position"], ["123", "disc_number,position"]]);
  // DOMINANT.
  const dom = sure(await src.search("tin roof sessions"));
  assert.equal(dom.id, "music:album:130");
  assert.equal((await src.queue(dom)).length, 12);
  // ASK, then the follow-up.
  const choices = await src.search("greatest misses");
  assert.deepEqual(choices.map((c) => [c.id, c.subtitle, c.confident]), [["music:album:140", "The Velvet Marmots", false], ["music:album:141", "Zélie Marchevô", false]]);
  const picked = src.choose(choices, "the one by zelie marchevo");
  assert.equal(picked.id, "music:album:141");
  assert.equal((await src.queue(picked)).length, 9);
  assert.equal(src.choose(choices, "the weather"), null);
  // With the artist in the request there is no question.
  assert.equal(sure(await src.search("greatest misses by the velvet marmots")).id, "music:album:140");
  // An album whose own artist is someone else: the server is asked whose tracks are on it.
  fw.reset();
  assert.equal(sure(await src.search("soundtrack by tanglewire")).id, "music:album:162");
  assert.ok(fw.calls.some((c) => c.path === "/api/v1/tracks/" && c.params.artist === "6" && !("playable" in c.params)));
});

test("queue: a two-disc album plays disc 1 before disc 2; an album over one page is not cut at 50 unless the limit says so", async () => {
  const { src, fw } = await warm();
  const two = await src.queue({ id: "music:album:170" });
  const disc = (p) => fw.lib.tracks.find((t) => t.id === trackNo(p));
  assert.deepEqual(two.map((p) => `${disc(p).disc_number}.${disc(p).position}`), ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]);
  assert.deepEqual(fw.calls.map((c) => c.params), [{ album: "170", ordering: "disc_number,position", page_size: "50" }]);
  fw.reset();
  const def = await src.queue({ id: "music:album:180" });
  assert.equal(def.length, QUEUE_DEFAULT, "the default limit is 50");
  assert.equal(fw.calls.length, 1);
  fw.reset();
  const all = await src.queue({ id: "music:album:180" }, { limit: 200 });
  assert.equal(all.length, 120, "every track, over three pages");
  assert.deepEqual(fw.calls.map((c) => c.params.page || "1"), ["1", "2", "3"]);
  assert.deepEqual(all.map((p) => disc(p).position), Array.from({ length: 120 }, (_, i) => i + 1), "in order across the pages");
  assert.equal((await src.queue({ id: "music:album:180" }, { limit: 60 })).length, 60);
  assert.equal((await src.resolve({ id: "music:album:170" })).id, two[0].id, "resolve is the first of queue");
  assert.deepEqual(await src.queue({ id: "music:album:999" }), []);
  for (const bad of [null, {}, { id: "album:1" }, { id: "music:album:../../users/me" }, { id: "music:video:1" }, { id: `music:album:${"9".repeat(80)}` }]) assert.deepEqual(await src.queue(bad), [], JSON.stringify(bad));
});

test("queue: an artist without the playable filter, shuffled by the server; a genre by its exact tag name, fifty at a time; the library; a track", async () => {
  const { src, fw } = await warm();
  const byArtist = await src.queue({ id: "music:artist:11" });
  assert.equal(byArtist.length, 2, "an album artist's tracks, though no track is credited to them");
  assert.deepEqual(fw.calls.map((c) => c.params), [{ artist: "11", ordering: "random", page_size: "50" }]);
  assert.ok(!EVERY_CALL.some((c) => "playable" in c.params), "no request anywhere carries a playable filter");
  fw.reset();
  const rock = await src.queue({ id: "music:genre:rock", kind: "genre", title: "anything" });
  assert.equal(rock.length, 50);
  assert.deepEqual(fw.calls.map((c) => c.params), [{ tag: "Rock", ordering: "random", page_size: "50" }], "the exact tag name comes from the index, one page of fifty");
  fw.reset();
  assert.equal((await src.queue({ id: "music:library:all" })).length, 50);
  assert.deepEqual(fw.calls.map((c) => c.params), [{ ordering: "random", page_size: "50" }]);
  fw.reset();
  // A track found by search is queued from what the search already read; any other by its number.
  await src.search("kestrel hours");
  fw.reset();
  assert.deepEqual((await src.queue({ id: "music:track:5000" })).map((p) => p.title), ["Kestrel Hours"]);
  assert.deepEqual(fw.paths(), []);
  assert.equal((await src.queue({ id: "music:track:1001" })).length, 1);
  assert.deepEqual(fw.paths(), ["/api/v1/tracks/1001/"]);
  assert.deepEqual(await src.queue({ id: "music:track:424242" }), []);
});

test("a playable: the listen address on the configured origin with the bearer and the hop policy — a copy is asked for only when the FILE EXTENSION needs it", async () => {
  const { src } = await warm();
  const q = await src.queue({ id: "music:album:190" });
  const to = (p) => new URL(p.upstream.url).searchParams.get("to");
  const byPos = Object.fromEntries(q.map((p, i) => [i + 1, p]));
  assert.equal(q.length, 12);
  // mp3, flac, ogg, opus (any letter case): as stored — no `to` parameter at all, whatever the MIME type says.
  for (const [pos, codec] of [[1, "mp3"], [2, "flac"], [5, "ogg"], [6, "opus"], [8, "mp3"], [12, "mp3"]]) {
    assert.equal(to(byPos[pos]), null, `track ${pos}`);
    assert.equal(new URL(byPos[pos].upstream.url).search, "", `track ${pos}: no query string`);
    assert.equal(byPos[pos].codec, codec);
  }
  // m4a, aiff, wav, no extension, no upload row, or one of two files that needs it: an MP3 copy.
  for (const pos of [3, 4, 7, 9, 10, 11]) { assert.equal(to(byPos[pos]), "mp3", `track ${pos}`); assert.equal(byPos[pos].codec, "mp3"); }
  const first = byPos[1];
  const id = trackNo(first);
  assert.deepEqual(first, {
    kind: "track", id: `music:track:${id}`, title: "Formats — part 1", subtitle: "Tanglewire — Formats", duration_sec: 181, form: "audio", codec: "mp3", source: "music",
    upstream: { url: `${BASE}/api/v1/listen/${uuid(id)}/`, headers: { Authorization: `Bearer ${TOKEN}` }, hop: libraryHop(readMusicConfig(CONFIG)) },
  });
  { const h = libraryHop(readMusicConfig(CONFIG)); assert.deepEqual([h.origin, h.redirects, h.redirectTo, h.private], [BASE, 1, [STORAGE], "named"]); }
  for (const p of q) {
    const u = new URL(p.upstream.url);
    assert.equal(u.origin, BASE);
    assert.match(u.pathname, LISTEN_PATH);
    assert.ok(!p.upstream.url.includes(TOKEN), "the token is a header, never in the address");
  }
  assert.deepEqual(DIRECT_EXTENSIONS, ["mp3", "ogg", "opus", "flac"]);
  assert.equal(needsTranscode({ uploads: [{ extension: "FLAC" }] }), false);
  assert.equal(needsTranscode({ uploads: [{ extension: "m4a", mimetype: "audio/mpeg" }] }), true, "the MIME type is not read");
  assert.equal(needsTranscode({}), true);
});

test("a listen address that is not the listen path is never produced; unplayable rows are dropped", async () => {
  const lib = library();
  const rows = lib.tracks.filter((t) => t.album.id === 103);
  rows[0].listen_url = "https://evil.example.invalid/api/v1/listen/00000000-0000-4000-8000-000000000001/";
  rows[1].listen_url = "/api/v1/users/me/";
  rows[2].listen_url = "//evil.example.invalid/api/v1/listen/00000000-0000-4000-8000-000000000001/";
  rows[3].is_playable = false;
  lib.tracks.push({ id: 6000, title: "No address", artist: artist(3), album: { id: 103, title: "Café Zénith" }, disc_number: 1, position: 9, uploads: [{ extension: "mp3" }] },
    { id: 6001, title: "Fine", artist: artist(3), album: { id: 103, title: "Café Zénith" }, disc_number: 1, position: 10, listen_url: `/api/v1/listen/${uuid(6001).toUpperCase()}/`, uploads: [{ extension: "mp3" }] });
  const { src } = await warm(fakeFunkwhale(lib));
  const q = await src.queue({ id: "music:album:103" });
  assert.deepEqual(q.map((p) => p.title), ["Fine"]);
  assert.equal(q[0].upstream.url, `${BASE}/api/v1/listen/${uuid(6001)}/`);
  assert.equal(listenUuid("/api/v1/listen/abc/"), null);
  assert.equal(listenUuid(`/api/v1/listen/${uuid(1)}/?to=mp3`), null, "a path, nothing after it");
  assert.equal(listenUuid(`/api/v1/listen/${uuid(1)}/../../users/me/`), null);
  assert.deepEqual(listenUpstream(readMusicConfig(CONFIG), uuid(1), "mp3").url, `${BASE}/api/v1/listen/${uuid(1)}/?to=mp3`);
});

test("errors are typed and never read as 'not found': unauthorized, unreachable, timeout — from search and from queue, cold and warm", async () => {
  const is = (code) => (err) => err instanceof SourceUnavailable && err.code === code && !err.message.includes(TOKEN) && !err.message.includes("127.0.0.1");
  for (const [mode, code] of [[{ status: 401 }, "unauthorized"], [{ status: 403 }, "unauthorized"], [{ throws: true }, "unreachable"], [{ status: 500 }, "unreachable"], [{ status: 302 }, "unreachable"], [{ notJson: true }, "unreachable"]]) {
    const cold = source(fakeFunkwhale(library(), { mode }));
    await assert.rejects(cold.src.search("the cobalt pantry"), is(code), `cold search, ${JSON.stringify(mode)}`);
    await assert.rejects(cold.src.queue({ id: "music:album:100" }), is(code), `queue, ${JSON.stringify(mode)}`);
    await assert.rejects(cold.src.resolve({ id: "music:track:1001" }), is(code));
    await assert.rejects(cold.src.matchReport(), is(code), "a report from a server that did not answer would be a lie");
    assert.equal(cold.src.available(), true, "still configured");
  }
  // A timeout is its own code: the request is aborted by the adapter's own timer.
  const slow = source(fakeFunkwhale(library(), { mode: { hang: true } }), { timeoutMs: 1234 });
  const pending = assert.rejects(slow.src.search("the cobalt pantry"), is("timeout"));
  await new Promise((r) => setImmediate(r));
  slow.timers.fire(1234);
  await pending;
  assert.equal(slow.timers.pending.size, 0, "every request timer is cleared");
  // 404 for one thing is "no such thing", not an outage.
  const ok = source();
  assert.deepEqual(await ok.src.queue({ id: "music:track:777777" }), []);
  assert.deepEqual(await ok.src.search("some polka"), []);
});

test("warm index, server down: what the index knows is still found; the queue then says the library is unreachable", async () => {
  let down = false;
  const good = fakeFunkwhale(), bad = fakeFunkwhale(library(), { mode: { throws: true } });
  const src = createMusicSource({ config: () => CONFIG, fetchImpl: (...a) => (down ? bad : good).fetchImpl(...a), clock: () => 1_000_000, timers: fakeTimers(), autoStart: false });
  assert.equal(await src.refresh(), true);
  down = true;
  const c = sure(await src.search("some hip hop"));
  await assert.rejects(src.queue(c), (e) => e instanceof SourceUnavailable && e.code === "unreachable");
  await assert.rejects(src.search("a title only the server could know"), (e) => e.code === "unreachable");
  src.stop();
});

test("the tools' listen addresses: accepted only on the configured origin (the called one or the public one) and the exact listen path; rebuilt, never passed through", async () => {
  const cfg = readMusicConfig(CONFIG);
  const u = uuid(42);
  assert.deepEqual(parseListenUrl(`${PUBLIC}/api/v1/listen/${u}/?to=mp3`, cfg), { uuid: u, to: "mp3" });
  assert.deepEqual(parseListenUrl(`${BASE}/api/v1/listen/${u}/`, cfg), { uuid: u, to: null });
  const refused = [
    `http://music.example.invalid:8446/api/v1/listen/${u}/`,            // http instead of the configured scheme
    `https://music.example.invalid/api/v1/listen/${u}/`,                // another port
    `https://music.example.invalid:8447/api/v1/listen/${u}/`,
    `https://evil.example.invalid:8446/api/v1/listen/${u}/`,            // another host
    `https://music.example.invalid.evil.example.invalid:8446/api/v1/listen/${u}/`,
    `${STORAGE}/api/v1/listen/${u}/`,                                   // the storage is not the library
    `${PUBLIC}/api/v1/users/me/`,                                       // not the listen path
    `${PUBLIC}/api/v1/listen/${u}/../../users/me/`,
    `${PUBLIC}/api/v1/listen/${u}`,
    `${PUBLIC}/api/v1/listen/not-a-uuid/`,
    `${PUBLIC}/api/v1/listen/${u}/?to=wav`,
    `${PUBLIC}/api/v1/listen/${u}/?to=mp3&upload=1`,
    `${PUBLIC}/api/v1/listen/${u}/?next=https://evil.example.invalid/`,
    `https://user:pw@music.example.invalid:8446/api/v1/listen/${u}/`,
    `${PUBLIC}/api/v1/listen/${u}/#x`, "", "not a url", null, `${PUBLIC}/${"a".repeat(500)}`,
  ];
  for (const url of refused) assert.equal(parseListenUrl(url, cfg), null, String(url).slice(0, 90));
  assert.equal(parseListenUrl(`${PUBLIC}/api/v1/listen/${u}/`, { ...cfg, publicOrigin: null }), null, "no public origin configured: only the called origin counts");
  const { src } = source();
  assert.deepEqual(src.playableFromListenUrl(`${PUBLIC}/api/v1/listen/${u}/?to=mp3`, { title: "Quiet\u0007 Engines", artist: "Tanglewire" }), {
    kind: "track", id: `music:track:${u}`, title: "Quiet Engines", subtitle: "Tanglewire", form: "audio", codec: "mp3", source: "music",
    upstream: { url: `${BASE}/api/v1/listen/${u}/?to=mp3`, headers: { Authorization: `Bearer ${TOKEN}` }, hop: libraryHop(readMusicConfig(CONFIG)) },
  }, "the public address maps to the origin this module calls: the token goes nowhere else");
  assert.equal(src.playableFromListenUrl(`https://evil.example.invalid/api/v1/listen/${u}/`), null);
  assert.equal(createMusicSource({ config: () => null }).playableFromListenUrl(`${PUBLIC}/api/v1/listen/${u}/`), null);
});

test("the match report: counts only, built from the index (which it builds when needed)", async () => {
  const { src, fw } = source();
  const r = await src.matchReport();
  assert.deepEqual(r.albums.shared, { titles: 3, albums: 9, fragments: 1, dominant: 1, same_artist: 0, ask: 1, other: 0 });
  assert.equal(r.albums.unique_total, 6);
  assert.equal(r.albums.unique_resolved, 6);
  assert.deepEqual(r.artists, { total: 7, resolved: 7, to_playlist: 0, asked: 0, missed: 0, same_name: 0 });
  assert.deepEqual(r.genres, { total: 63, resolved: 63, resolved_without_cue: 63 });
  const out = JSON.stringify(r);
  assert.match(out, /^[{}":,a-z_0-9]+$/, "keys and numbers only");
  for (const name of [...ARTISTS.map((a) => a.name), ...fw.lib.albums.map((a) => a.title), "HipHop", TOKEN, "127.0.0.1"]) assert.ok(!out.includes(name), name);
  assert.ok(fw.calls.every((c) => !c.path.includes("/listen/") && !c.path.startsWith("/api/v1/tracks")), "the report reads the name lists and nothing else");
});

test("the report's command line: reads its settings from the environment, prints the counts as JSON and never the token", async () => {
  // A local stand-in server on loopback: the command runs as a separate process with the real fetch.
  const fw = fakeFunkwhale();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { "content-type": "application/json" }); return res.end("{}"); }
    const r = await fw.fetchImpl(`${BASE}${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization }, redirect: "manual" });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(await r.json()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const run = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("../scripts/kiosk-eval/music-match-report.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
  try {
    const good = await run({ CROW_MUSIC_BASE: `http://127.0.0.1:${server.address().port}`, CROW_MUSIC_TOKEN: TOKEN, CROW_MUSIC_STORAGE_ORIGIN: STORAGE });
    assert.equal(good.code, 0, good.err);
    const r = JSON.parse(good.out);
    assert.equal(r.albums.unique_resolved, 6);
    assert.equal(r.index.albums, 15);
    assert.ok(!good.out.includes(TOKEN) && !good.err.includes(TOKEN));
    assert.match(good.out, /^[{}":,a-z_0-9\s]+$/);
    const missing = await run({ CROW_MUSIC_BASE: `http://127.0.0.1:${server.address().port}` });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /CROW_MUSIC_TOKEN/);
    const wrong = await run({ CROW_MUSIC_BASE: `http://127.0.0.1:${server.address().port}`, CROW_MUSIC_TOKEN: "another-token", CROW_MUSIC_STORAGE_ORIGIN: STORAGE });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /unauthorized/);
    assert.ok(!wrong.err.includes("another-token"));
  } finally { server.close(); }
});

test("checkStorage: the storage origin is checked against what the server itself redirects to — never followed, never echoed", async () => {
  const SIGNED = `${STORAGE}/bucket/tracks/a.mp3?X-Signature=s3cr3t-signature`;
  const calls = [];
  /** listen: what the listen address answers. */
  const server = ({ listen = { status: 302, location: SIGNED }, tracks = library().tracks.slice(0, 1), listStatus = 200, throws = false } = {}) => async (url, init) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: u.pathname, search: u.search, auth: init.headers.Authorization, redirect: init.redirect, method: init.method });
    if (throws) throw new TypeError("fetch failed");
    if (u.pathname === "/api/v1/tracks/") return { status: listStatus, json: async () => ({ results: tracks }) };
    return { status: listen.status, headers: new Headers(listen.location ? { location: listen.location } : {}), body: { cancel: async () => { calls.push({ cancelled: true }); } } };
  };
  assert.deepEqual(await checkStorage(CONFIG, { fetchImpl: server() }), { ok: true });
  assert.deepEqual(calls.filter((c) => c.path).map((c) => [c.path, c.search, c.auth, c.redirect, c.method]), [
    ["/api/v1/tracks/", "?page_size=1", `Bearer ${TOKEN}`, "manual", "GET"],
    [`/api/v1/listen/${uuid(1001)}/`, "", `Bearer ${TOKEN}`, "manual", "GET"]], "one track, then its listen address as stored (no copy is asked for), redirect not followed");
  assert.ok(calls.every((c) => !c.url || new URL(c.url).origin === BASE), "the storage itself is never contacted");
  const cases = [
    [{ listen: { status: 302, location: "http://203.0.113.77:9000/bucket/a.mp3?X-Signature=s3cr3t-signature" } }, "other_origin"],
    [{ listen: { status: 302, location: `https://203.0.113.9:9000/a.mp3` } }, "other_origin"],          // the scheme is part of an origin
    [{ listen: { status: 302, location: "/media/tracks/a.mp3" } }, "other_origin"],                      // a redirect to the library itself
    [{ listen: { status: 200 } }, "no_redirect"],
    [{ listen: { status: 302 } }, "no_redirect"],
    [{ listen: { status: 401 } }, "unauthorized"],
    [{ listStatus: 401 }, "unauthorized"], [{ listStatus: 403 }, "unauthorized"],
    [{ listStatus: 500 }, "unreachable"], [{ listen: { status: 502 } }, "unreachable"],
    [{ throws: true }, "unreachable"],
    [{ tracks: [] }, "no_track"],
    [{ tracks: [{ id: 1, listen_url: "/api/v1/users/me/" }] }, "no_track"],
  ];
  for (const [opts, reason] of cases) {
    const r = await checkStorage(() => CONFIG, { fetchImpl: server(opts) });
    assert.deepEqual(r, { ok: false, reason }, JSON.stringify(opts));
    assert.ok(!JSON.stringify(r).includes("s3cr3t"), "the redirect's address is not in the answer");
  }
  assert.ok(calls.some((c) => c.cancelled), "a body the server sends itself is not downloaded");
  for (const bad of [null, {}, { ...CONFIG, storageOrigin: "" }, () => { throw new Error("x"); }]) assert.deepEqual(await checkStorage(bad, { fetchImpl: server() }), { ok: false, reason: "not_configured" });
  // A server that never answers: the check gives up by itself.
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
  assert.deepEqual(await checkStorage(CONFIG, { fetchImpl: hang, timeoutMs: 20 }), { ok: false, reason: "unreachable" });
});

test("a library stream through the REAL relay: the bearer goes to the listen path only, one redirect to the configured storage origin with no bearer; any other path, a second redirect or another origin is refused", async () => {
  const { createRelay } = await import("../bundles/kiosk/server/relay.js");
  const seen = [];
  const listen = (fn) => new Promise((r) => { const s = http.createServer(fn); s.listen(0, "127.0.0.1", () => r(s)); });
  let target = null;
  const storage = await listen((req, res) => { seen.push({ at: "storage", url: req.url, auth: req.headers.authorization || null }); res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("abc"); });
  const other = await listen((req, res) => { seen.push({ at: "other", url: req.url, auth: req.headers.authorization || null }); res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("x"); });
  const lib = await listen((req, res) => { seen.push({ at: "library", url: req.url, auth: req.headers.authorization || null }); res.writeHead(302, { location: target }); res.end(); });
  const o = (s) => `http://127.0.0.1:${s.address().port}`;
  try {
    const cfg = readMusicConfig({ base: o(lib), token: TOKEN, storageOrigin: o(storage) });
    const relay = createRelay();
    const id = uuid(7);
    target = `${o(storage)}/funkwhale/file.mp3?X-Amz-Signature=sig`;
    for (const to of [null, "mp3"]) {
      const up = await relay.open(listenUpstream(cfg, id, to));
      assert.equal(await new Promise((r) => { let b = ""; up.body.on("data", (c) => { b += c; }); up.body.on("end", () => r(b)); }), "abc");
    }
    assert.deepEqual(seen.map((x) => [x.at, x.auth]), [["library", `Bearer ${TOKEN}`], ["storage", null], ["library", `Bearer ${TOKEN}`], ["storage", null]]);
    assert.equal(seen[2].url, `/api/v1/listen/${id}/?to=mp3`);
    seen.length = 0;
    // Another path on the library origin (with the bearer) is never requested.
    for (const url of [`${o(lib)}/api/v1/users/me/`, `${o(lib)}/api/v1/listen/${id}/?to=mp3&x=1`, `${o(lib)}/api/v1/listen/${id}/?to=wav`]) {
      await assert.rejects(relay.open({ url, headers: { Authorization: `Bearer ${TOKEN}` }, hop: libraryHop(cfg) }), (e) => e.code === "path_refused", url);
    }
    // A redirect anywhere but the storage origin (loopback included) is refused, and nothing is fetched there.
    target = `${o(other)}/steal`;
    await assert.rejects(relay.open(listenUpstream(cfg, id)), (e) => e.code === "redirect_refused");
    target = "http://169.254.169.254/latest/meta-data/";
    await assert.rejects(relay.open(listenUpstream(cfg, id)), (e) => e.code === "redirect_refused");
    assert.ok(!seen.some((x) => x.at === "other"));
  } finally { for (const s of [lib, storage, other]) s.close(); }
});
