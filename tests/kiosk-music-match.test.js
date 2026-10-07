/**
 * The music matcher (bundles/kiosk/server/sources/music-match.js): a pure module. Every name in
 * these fixtures is made up. Each hard case a real library holds has a fixture of its own:
 * titles with "the" and "by" in them, accents asked for without accents, apostrophes, a genre
 * written as one word, a shared album title in each of its three shapes, and names that are the
 * same across kinds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, compact, wordsOf, cleanName, buildIndex, readRequest, trackQueries, decide, choose, describeChoices, libraryCandidate, matchReport, sayAloud, spokenChanges,
  TEXT_MAX, WORDS_MAX, CHOICES_MAX } from "../bundles/kiosk/server/sources/music-match.js";

const ARTISTS = [
  { id: 1, name: "The Velvet Marmots" }, { id: 2, name: "Quartz Heron Trio" }, { id: 3, name: "Zélie Marchevô" }, { id: 4, name: "Señor Limón y los Faroles" },
  { id: 5, name: "Okapi Sunday" }, { id: 6, name: "Tanglewire" }, { id: 7, name: "Saffron" }, { id: 8, name: "Lola de Arena" }, { id: 9, name: "Ladder" },
  { id: 10, name: "Björk Ødegård & the Fjørds" }, { id: 11, name: "Wren Okonjo" }, { id: 12, name: "wren okonjo" },
];
const A = (id) => ARTISTS.find((a) => a.id === id).name;
const album = (id, title, artistId, tracks, year = 2001) => ({ id, title, artistId, artist: A(artistId), tracks, year });
const ALBUMS = [
  album(100, "The Cobalt Pantry", 1, 9),                 // a title with "the" in front
  album(101, "Ladder by Ladder", 2, 8),                  // a title with "by" in it — and "Ladder" is an artist
  album(102, "Don't Feed the Marmots", 1, 11),           // an apostrophe
  album(103, "Café Zénith", 3, 10),                      // accents
  album(104, "Saffron", 5, 7),                           // an album title equal to an artist's name
  album(105, "Paper Moths", 6, 10),                      // a track title equal to an album title
  album(106, "Rock", 6, 6),                              // an album title equal to a genre
  album(107, "Kind of Teal (Legacy Edition)", 2, 12),    // found by part of its title
  album(108, "Night Bus North", 5, 9), album(109, "Night Bus South", 6, 9),
  // One compilation the importer split by artist: every "album" has one or two tracks (FRAGMENTS).
  album(120, "Harbor Lights, Vol. 1", 1, 1), album(121, "Harbor Lights, Vol. 1", 2, 1), album(122, "Harbor Lights, Vol. 1", 5, 2), album(123, "Harbor Lights, Vol. 1", 6, 1),
  // A real album and two stray tracks that carry its title (DOMINANT).
  album(130, "Tin Roof Sessions", 2, 12), album(131, "Tin Roof Sessions", 5, 2), album(132, "Tin Roof Sessions", 6, 1),
  // Five different records with one title (ASK).
  album(140, "Greatest Misses", 1, 10), album(141, "Greatest Misses", 3, 9), album(142, "Greatest Misses", 4, 12), album(143, "Greatest Misses", 5, 8), album(144, "Greatest Misses", 6, 7),
  // The same title AND artist twice (a re-import), and another artist's.
  album(150, "Attic Tapes", 2, 10), album(151, "Attic Tapes", 2, 9),
  album(160, "Some Girls Whistle", 5, 8),                // starts with a genre cue word
  album(161, "Lista de Espera", 4, 9),                   // starts with a kind cue word, has "de" in it
  album(162, "Soundtrack", 11, 14),                      // a "Various"-style album: its track artists are not its album artist
];
const GENRES = [{ name: "Jazz" }, { name: "Rock" }, { name: "HipHop" }, { name: "Bossa_Nova" }, { name: "Folk" }];
const PLAYLISTS = [{ id: 1, name: "Dinner" }, { id: 2, name: "Okapi Sunday" }];
const TRACKS = [
  { id: 900, title: "Paper Moths", artist: A(6) }, { id: 901, title: "Step by Stair", artist: A(5) }, { id: 902, title: "Quiet Engines", artist: A(1) },
  { id: 903, title: "Quiet Engines", artist: A(3) }, { id: 904, title: "Jazz", artist: A(6) }, { id: 905, title: "Song for a Heron", artist: A(2) },
  { id: 906, title: "L'Été Indigo", artist: A(3) }, { id: 907, title: "Quiet Engines", artist: A(1) },
];
const ix = buildIndex({ albums: ALBUMS, artists: ARTISTS, genres: GENRES, playlists: PLAYLISTS });

/** What the adapter does: run decide(), supplying live data when it is asked for. */
function match(what, { tracks = TRACKS, artistAlbums = new Set(), index = ix, opts } = {}) {
  const req = readRequest(what);
  const live = {};
  const needs = [];
  for (let i = 0; i < 4; i += 1) {
    const d = decide(req, index, live, opts);
    if (d.need === "tracks") { needs.push("tracks"); live.tracks = tracks; continue; }
    if (d.need === "artistAlbums") { needs.push(`artistAlbums:${d.artists.join(",")}`); live.artistAlbums = artistAlbums; continue; }
    return { c: d.candidates, needs };
  }
  throw new Error("decide() kept asking");
}
const one = (what, o) => { const { c } = match(what, o); assert.equal(c.length, 1, `${what}: one candidate, got ${JSON.stringify(c)}`); assert.equal(c[0].confident, true, `${what}: confident`); return c[0]; };
const ids = (what, o) => match(what, o).c.map((x) => x.id);

test("fold and compact: accents, apostrophes, punctuation and '&' — the same on both sides", () => {
  assert.equal(fold("Café Zénith"), "cafe zenith");
  assert.equal(fold("Don’t Feed the Marmots!"), "dont feed the marmots");
  assert.equal(fold("don't"), fold("dont"));
  assert.equal(fold("Salt & Vinegar"), "salt and vinegar");
  assert.equal(fold("  Harbor Lights, Vol. 1 "), "harbor lights vol 1");
  assert.equal(fold("Björk Ødegård & the Fjørds"), "bjork odegard and the fjords", "letters with no decomposition are mapped too");
  assert.equal(fold("Straße"), "strasse");
  assert.equal(compact("Hip-Hop"), "hiphop");
  assert.equal(compact("Bossa_Nova"), "bossanova");
  assert.equal(fold(null), "");
  assert.equal(fold({ toString() { throw new Error("no"); } }), "");
  assert.equal(fold(1999), "1999");
  assert.equal(fold("x".repeat(5000)).length, TEXT_MAX, "cut before anything reads it");
  assert.equal(wordsOf("a ".repeat(500)).length, WORDS_MAX);
  assert.equal(cleanName("  Night\u0000Bus\n North  "), "Night Bus North");
  assert.equal(cleanName("z".repeat(500)).length, 80);
});

test("readRequest: kind cues, genre cues, and the artist clause after the LAST by / de / por", () => {
  assert.deepEqual(readRequest("the album cobalt pantry"), { raw: "the album cobalt pantry", words: ["the", "album", "cobalt", "pantry"], core: ["cobalt", "pantry"], kind: "album", genreCue: false, split: null });
  assert.equal(readRequest("dinner playlist").kind, "playlist");
  assert.deepEqual(readRequest("my dinner playlist").core, ["dinner"]);
  assert.equal(readRequest("la canción quiet engines").kind, "track");
  assert.equal(readRequest("el disco café zénith").kind, "album");
  assert.equal(readRequest("the band tanglewire").kind, "artist");
  for (const [what, core] of [["some jazz", ["jazz"]], ["any jazz", ["jazz"]], ["jazz music", ["jazz"]], ["some hip hop music", ["hip", "hop"]], ["algo de jazz", ["jazz"]], ["música de jazz", ["jazz"]], ["música jazz", ["jazz"]], ["some music", []], ["music", []], ["música", []], ["algo", []], ["algo de música", []]]) {
    const r = readRequest(what);
    assert.equal(r.genreCue, true, what);
    assert.deepEqual(r.core, core, what);
  }
  assert.equal(readRequest("jazz").genreCue, false);
  const r = readRequest("Greatest Misses by Zélie Marchevô");
  assert.deepEqual(r.split, { head: ["greatest", "misses"], kind: null, artist: ["zelie", "marchevo"] });
  assert.deepEqual(readRequest("step by step by okapi sunday").split.head, ["step", "by", "step"], "the last 'by'");
  assert.deepEqual(readRequest("the album attic tapes by quartz heron trio").split, { head: ["attic", "tapes"], kind: "album", artist: ["quartz", "heron", "trio"] });
  assert.deepEqual(readRequest("music by tanglewire").split.head, [], "a head made of cue words names nothing");
  assert.deepEqual(readRequest("música de lola de arena").split, { head: ["lola"], kind: null, artist: ["arena"] }, "only the LAST clause word splits; whether it is used is decide()'s rule");
  assert.deepEqual(readRequest("something by tanglewire").split.head, []);
  assert.equal(readRequest("by").split, null, "nothing after it: no clause");
  assert.deepEqual(readRequest(null), { raw: "", words: [], core: [], kind: null, genreCue: false, split: null });
  assert.deepEqual(trackQueries(readRequest("L'Été Indigo")), ["L'Été Indigo", "lete indigo"], "as spoken and, when different, as folded");
  assert.deepEqual(trackQueries(readRequest("quiet engines")), ["quiet engines"]);
  assert.deepEqual(trackQueries(readRequest("the song quiet engines by zélie marchevô")).length, 4, "never more than four");
});

test("rule 3: one exact hit plays — titles with 'the', accents asked without accents, apostrophes", () => {
  assert.deepEqual(one("the cobalt pantry"), { id: "music:album:100", kind: "album", title: "The Cobalt Pantry", subtitle: "The Velvet Marmots", confident: true });
  assert.equal(one("cobalt pantry").id, "music:album:100", "the article dropped from the name's side (what 'play the …' leaves)");
  assert.equal(one("the tanglewire").id, "music:artist:6", "…and from the phrase's side");
  assert.equal(one("cafe zenith").id, "music:album:103");
  assert.equal(one("Café Zénith").id, "music:album:103");
  assert.equal(one("dont feed the marmots").id, "music:album:102");
  assert.equal(one("don't feed the marmots").id, "music:album:102");
  assert.equal(one("senor limon y los faroles").id, "music:artist:4");
  assert.equal(one("zelie marchevo").id, "music:artist:3");
  assert.equal(one("bjork odegard and the fjords").id, "music:artist:10");
  assert.equal(one("dinner").id, "music:playlist:1");
  assert.deepEqual(match("the cobalt pantry").needs, [], "an album in the index needs nothing from the server");
});

test("rule 2: the whole phrase before any 'by' split — a title with 'by' in it stays a title, as an album and as a track", () => {
  // "Ladder" is an artist and the words before "by" are too: a split-first reader would never find the album.
  assert.equal(one("ladder by ladder").id, "music:album:101");
  assert.deepEqual(match("ladder by ladder").needs, []);
  // A TRACK title with "by" in it, where the words after "by" happen to be part of an artist's name.
  const idx = buildIndex({ albums: ALBUMS, artists: [...ARTISTS, { id: 30, name: "Stair" }], genres: GENRES, playlists: PLAYLISTS });
  const hit = match("step by stair", { index: idx });
  assert.equal(hit.c[0].id, "music:track:901");
  assert.deepEqual(hit.needs, ["tracks"]);
  // "de" inside an artist's name is not a clause either.
  assert.equal(one("lola de arena").id, "music:artist:8");
  assert.equal(one("lista de espera").id, "music:album:161", "a title that starts with a kind cue word is still compared whole");
  assert.equal(one("some girls whistle").id, "music:album:160", "…and one that starts with a genre cue word");
});

test("rule 2 and 5: with an artist clause the shared title narrows to that artist — album artist first, then track artists", () => {
  assert.equal(one("greatest misses by zelie marchevo").id, "music:album:141");
  assert.equal(one("Greatest Misses by the Velvet Marmots").id, "music:album:140");
  assert.equal(one("greatest misses by marchevo").id, "music:album:141", "part of the artist's name");
  assert.equal(one("greatest misses de señor limón y los faroles").id, "music:album:142");
  assert.equal(one("the album greatest misses by okapi sunday").id, "music:album:143");
  assert.equal(one("kind of teal by quartz heron trio").id, "music:album:107", "a contained title, narrowed the same way");
  // The album's own artist is someone else; only the server knows whose tracks are on it.
  const viaTracks = match("soundtrack by tanglewire", { artistAlbums: new Set(["162"]) });
  assert.equal(viaTracks.c[0].id, "music:album:162");
  assert.deepEqual(viaTracks.needs, ["tracks", "artistAlbums:6"]);
  assert.deepEqual(match("soundtrack by tanglewire").c, [], "no track by that artist on it: not found, never the wrong record");
  // A track by its artist, when two artists have a track of that title.
  assert.equal(one("quiet engines by zélie marchevô").id, "music:track:903");
  assert.equal(one("the song quiet engines by the velvet marmots").id, "music:track:902");
  // Only an artist: "music by …", "something by …", "música de …".
  for (const what of ["music by tanglewire", "something by tanglewire", "some music by tanglewire", "música de tanglewire", "algo de tanglewire"]) assert.equal(one(what).id, "music:artist:6", what);
  // The words after "by" are not an artist: no split, and nothing else has that name.
  assert.deepEqual(match("greatest misses by nobody at all").c, []);
});

test("rule 4: playlist, then artist, then album, then track, then genre", () => {
  assert.equal(one("okapi sunday").kind, "playlist", "a playlist and an artist of one name: the playlist");
  assert.equal(one("saffron").id, "music:artist:7", "an album titled like an artist: the artist (whose tracks include the album)");
  assert.equal(one("the album saffron").id, "music:album:104", "…unless the request says album");
  const moths = match("paper moths");
  assert.equal(moths.c[0].id, "music:album:105", "a track titled like its album: the album (which includes the track)");
  assert.deepEqual(moths.needs, [], "and the server is not asked");
  assert.equal(one("the song paper moths").id, "music:track:900");
  assert.equal(one("rock").id, "music:album:106", "an album titled like a genre: the album");
  assert.equal(one("some rock").id, "music:genre:rock", "…unless the words ask for a kind of music");
  assert.equal(one("rock music").id, "music:genre:rock");
  const jazz = match("jazz");
  assert.equal(jazz.c[0].id, "music:track:904", "a track titled like a genre comes before the genre");
  assert.deepEqual(jazz.needs, ["tracks"]);
  assert.equal(one("some jazz").id, "music:genre:jazz");
  assert.deepEqual(match("some jazz").needs, [], "a genre cue with an exact genre asks the server nothing");
  assert.equal(one("jazz", { tracks: [] }).id, "music:genre:jazz", "no such track: the genre");
  assert.equal(one("the playlist okapi sunday").kind, "playlist");
  assert.equal(one("the band okapi sunday").id, "music:artist:5", "a kind cue limits the lookup to that kind");
});

test("rule 1: genres — a run-together tag from its spoken form, an underscore tag, and 'play some music'", () => {
  assert.deepEqual(one("some hip hop"), { id: "music:genre:hiphop", kind: "genre", title: "HipHop", subtitle: "", confident: true });
  for (const what of ["hip hop", "hip-hop", "hiphop", "HipHop", "hip hop music", "any hip hop", "algo de hip hop", "música hip hop"]) assert.equal(one(what, { tracks: [] }).id, "music:genre:hiphop", what);
  assert.equal(one("some bossa nova").title, "Bossa_Nova", "the exact tag name travels in the title");
  assert.equal(one("the folk", { tracks: [] }).id, "music:genre:folk");
  for (const what of ["some music", "music", "any music", "música", "algo de música", "algo"]) assert.deepEqual(one(what), libraryCandidate("en"), what);
  assert.deepEqual(one("música", { opts: { lang: "es" } }), { id: "music:library:all", kind: "library", title: "música", subtitle: "", confident: true });
  assert.deepEqual(match("some polka").c, [], "a genre cue with no such genre and nothing else of that name: not found");
  assert.equal(one("some kind of teal music").id, "music:album:107", "cue words around a title: the title is still found");
  assert.deepEqual(match("").c, []);
  assert.deepEqual(one("", { opts: { explicit: true } }), libraryCandidate("en"), "the music source named with nothing else: the library");
});

test("rule 5, FRAGMENTS: every album of the title has one or two tracks — one merged candidate", () => {
  const c = one("harbor lights vol 1");
  assert.deepEqual(c, { id: "music:album:120", kind: "album", title: "Harbor Lights, Vol. 1", subtitle: "", confident: true, group: ["120", "121", "122", "123"] });
  assert.deepEqual(one("the album harbor lights vol 1").group, ["120", "121", "122", "123"]);
  assert.deepEqual(one("harbor lights vol 1 by okapi sunday"), { id: "music:album:122", kind: "album", title: "Harbor Lights, Vol. 1", subtitle: "Okapi Sunday", confident: true }, "with an artist clause: that artist's part only");
  // One of them with three tracks: no longer fragments.
  const idx = buildIndex({ albums: [album(1, "Harbor Lights", 1, 1), album(2, "Harbor Lights", 2, 3), album(3, "Harbor Lights", 5, 2)] });
  assert.equal(match("harbor lights", { index: idx }).c.length, 3);
});

test("rule 5, DOMINANT: one album has at least three times the tracks of the next", () => {
  assert.deepEqual(one("tin roof sessions"), { id: "music:album:130", kind: "album", title: "Tin Roof Sessions", subtitle: "Quartz Heron Trio", confident: true });
  // 12 against 5 is not three times: ask.
  const idx = buildIndex({ albums: [album(1, "Tin Roof Sessions", 2, 12), album(2, "Tin Roof Sessions", 5, 5)] });
  assert.deepEqual(ids("tin roof sessions", { index: idx }), ["music:album:1", "music:album:2"]);
  // 12 against 4 is.
  assert.equal(one("tin roof sessions", { index: buildIndex({ albums: [album(1, "Tin Roof Sessions", 2, 12), album(2, "Tin Roof Sessions", 5, 4)] }) }).id, "music:album:1");
  // Unknown track counts decide nothing.
  assert.equal(match("tin roof sessions", { index: buildIndex({ albums: [album(1, "Tin Roof Sessions", 2, undefined), album(2, "Tin Roof Sessions", 5, undefined)] }) }).c.length, 2);
});

test("rule 5, ASK: up to four choices, the largest first, named by artist — and the follow-up picks one", () => {
  const { c } = match("greatest misses");
  assert.deepEqual(c.map((x) => [x.id, x.subtitle, x.confident]), [
    ["music:album:142", "Señor Limón y los Faroles", false], ["music:album:140", "The Velvet Marmots", false],
    ["music:album:141", "Zélie Marchevô", false], ["music:album:143", "Okapi Sunday", false]]);
  assert.equal(c.length, CHOICES_MAX);
  assert.deepEqual(describeChoices(c), { say: "say_music_choices_by", vars: { title: "Greatest Misses", names: ["Señor Limón y los Faroles", "The Velvet Marmots", "Zélie Marchevô", "Okapi Sunday"] } });
  for (const [said, id] of [["the one by Zélie Marchevô", 141], ["the one by zelie marchevo", 141], ["by the velvet marmots", 140], ["velvet marmots", 140], ["Okapi Sunday", 143], ["the first one", 142], ["first", 142],
    ["the second one", 140], ["number three", 141], ["the last one", 143], ["la de señor limón y los faroles", 142], ["el de okapi sunday", 143], ["la segunda", 140], ["play the one by okapi sunday please", 143],
    ["greatest misses by okapi sunday", 143], ["marchevo", 141]]) {
    assert.deepEqual(choose(c, said), { ...c.find((x) => x.id === `music:album:${id}`), confident: true }, said);
  }
  for (const said of ["", "the one by nobody", "greatest misses", "the fifth one", "what time is it", "by", null]) assert.equal(choose(c, said), null, String(said));
  assert.equal(choose([], "first"), null);
  assert.equal(choose(null, "first"), null);
  // The same title AND artist twice cannot be told apart by voice: the larger one plays.
  assert.equal(one("attic tapes").id, "music:album:150");
});

test("rule 6: no exact hit — one contained hit plays, several ask by name; articles alone match nothing", () => {
  assert.equal(one("kind of teal").id, "music:album:107", "the name has at most three more words");
  assert.equal(one("the velvet").id, "music:artist:1");
  const { c } = match("night bus");
  assert.deepEqual(c.map((x) => [x.id, x.confident]), [["music:album:108", false], ["music:album:109", false]]);
  assert.deepEqual(describeChoices(c), { say: "say_choices", vars: { names: ["Night Bus North", "Night Bus South"] } });
  assert.equal(choose(c, "night bus south").id, "music:album:109");
  assert.equal(choose(c, "south").id, "music:album:109");
  assert.equal(choose(c, "the one by okapi sunday").id, "music:album:108");
  assert.equal(choose(c, "night bus"), null, "the same words again pick nothing");
  assert.deepEqual(match("the").c, []);
  assert.deepEqual(match("teal").c, [], "'Kind of Teal (Legacy Edition)' has four more words than 'teal'");
  assert.equal(one("feed").id, "music:album:102", "three more words is the limit");
  assert.equal(one("música de lola de arena").id, "music:artist:8", "a cue in front of a name with 'de' in it");
  assert.equal(one("harbor lights").group.length, 4, "contained hits that are one shared title follow rule 5");
  assert.equal(one("wren okonjo").group.length, 2, "two artists whose names fold alike are one to a listener");
});

test("rule 7 and 8: a track by its exact title; several by one title ask by artist; nothing is nothing", () => {
  const t = match("song for a heron");
  assert.deepEqual(t.c, [{ id: "music:track:905", kind: "track", title: "Song for a Heron", subtitle: "Quartz Heron Trio", confident: true }]);
  assert.deepEqual(t.needs, ["tracks"]);
  assert.equal(one("lete indigo").id, "music:track:906", "an apostrophe and accents in a track title");
  const many = match("quiet engines").c;
  assert.deepEqual(many.map((x) => [x.id, x.subtitle]), [["music:track:902", "The Velvet Marmots"], ["music:track:903", "Zélie Marchevô"]], "one per artist");
  assert.deepEqual(describeChoices(many).say, "say_music_choices_by");
  assert.equal(choose(many, "the one by zélie marchevô").id, "music:track:903");
  assert.deepEqual(match("quiet").c, [], "part of a track title is not a match");
  assert.deepEqual(match("a record nobody ever made").c, []);
  assert.deepEqual(match("quiet engines", { tracks: [] }).c, []);
});

test("the index: album artists count as artists; bad rows are skipped; ids are never taken from text", () => {
  const idx = buildIndex({ albums: [album(1, "Solo Record", 5, 3), { id: "../x", title: "Bad id", artist: "x" }, { id: 2, title: "!!!", artist: "x" }, null], artists: [], genres: [{ name: "" }, null, { name: "Jazz" }] });
  assert.equal(idx.albums.length, 1);
  assert.equal(idx.artists.length, 1);
  assert.equal(match("okapi sunday", { index: idx }).c[0].id, "music:artist:5", "an artist known only from an album");
  assert.equal(idx.genres.length, 1);
  assert.deepEqual(match("anything", { index: buildIndex() }).c, []);
  for (const c of [...match("greatest misses").c, ...match("harbor lights vol 1").c, ...match("some hip hop").c]) assert.match(c.id, /^music:(track|album|artist|genre|playlist|library):[A-Za-z0-9_.~-]{1,64}$/);
});

test("the match report: counts only — unique titles, the three shapes of a shared title, artists, genres", () => {
  const r = matchReport(ix);
  assert.deepEqual(r.albums.shared, { titles: 4, albums: 14, fragments: 1, dominant: 1, same_artist: 1, ask: 1, other: 0 });
  assert.equal(r.albums.total, ALBUMS.length);
  assert.equal(r.albums.unique_total, 13);
  assert.equal(r.albums.unique_to_artist, 1, "the album titled like an artist");
  assert.equal(r.albums.unique_resolved, 12);
  assert.equal(r.albums.unique_resolved_with_cue, 13, "said with 'album' in front, every unique title is itself");
  assert.equal(r.albums.unique_asked + r.albums.unique_missed + r.albums.unique_to_playlist + r.albums.no_track_count, 0);
  assert.deepEqual(r.artists, { total: 12, resolved: 11, to_playlist: 1, asked: 0, missed: 0, same_name: 2 }, "the artist whose name a playlist has");
  assert.deepEqual(r.genres, { total: 5, resolved: 5, resolved_without_cue: 4 }, "without a cue the album titled Rock comes first");
  const out = JSON.stringify(r);
  for (const n of [...ARTISTS.map((a) => a.name), ...ALBUMS.map((a) => a.title), ...GENRES.map((g) => g.name)]) assert.ok(!out.includes(n), `no name in the report: ${n}`);
  assert.match(out, /^[{}":,a-z_0-9]+$/, "keys and numbers only");
});

test("spoken forms: numbers, years, ordinals, saint, doctor, volume, initialisms and r and b meet the written names — both sides folded the same way", () => {
  const ix = buildIndex({
    albums: [
      { id: 501, title: "Volume 2", artist: "Quartz Heron Trio", artistId: 2, tracks: 9 },
      { id: 502, title: "1999 Lanterns", artist: "Okapi Sunday", artistId: 5, tracks: 8 },
      { id: 503, title: "St. Louis Nights", artist: "Tanglewire", artistId: 6, tracks: 10 },
      { id: 504, title: "21st Century Gulls", artist: "Okapi Sunday", artistId: 5, tracks: 11 },
      { id: 505, title: "Nineteen Oh Five", artist: "Tanglewire", artistId: 6, tracks: 7 },
      { id: 506, title: "Oh! Marmalade", artist: "Tanglewire", artistId: 6, tracks: 7 },
    ],
    artists: [{ id: 30, name: "Dr. Okra" }, { id: 31, name: "AC/DQ" }],
    genres: [{ name: "RnB" }, { name: "Rock_and_Roll" }],
  });
  const plays = (said) => { const c = decide(readRequest(said), ix, {}).candidates || []; return c.length === 1 && c[0].confident ? c[0].id : `(${c.map((x) => x.id).join(",")})`; };
  for (const [said, id] of [
    ["volume two", "music:album:501"], ["vol 2", "music:album:501"], ["Volume 2", "music:album:501"],
    ["nineteen ninety nine lanterns", "music:album:502"],
    ["saint louis nights", "music:album:503"], ["st louis nights", "music:album:503"],
    ["twenty first century gulls", "music:album:504"], ["the 21st century gulls", "music:album:504"],
    ["nineteen oh five", "music:album:505"], ["1905", "music:album:505"],
    ["oh marmalade", "music:album:506"],
    ["doctor okra", "music:artist:30"], ["dr okra", "music:artist:30"],
    ["a c d q", "music:artist:31"], ["ac dq", "music:artist:31"], ["acdq", "music:artist:31"],
    ["some r and b", "music:genre:rnb"], ["some r&b", "music:genre:rnb"], ["some r n b", "music:genre:rnb"],
    ["some rock n roll", "music:genre:rockandroll"],
  ]) assert.equal(plays(said), id, said);
  // The "Which one?" answers still read their numbers ("the first one" is 1 then 1, never 11).
  assert.deepEqual([fold("the first one"), fold("the second one"), fold("the one by tanglewire")], ["the 1 1", "the 2 1", "the 1 by tanglewire"]);
  const cands = [{ id: "music:album:1", kind: "album", title: "Greatest Misses", subtitle: "Okapi Sunday" }, { id: "music:album:2", kind: "album", title: "Greatest Misses", subtitle: "Tanglewire" }];
  assert.equal(choose(cands, "the second one")?.id, "music:album:2");
  assert.equal(choose(cands, "the first one")?.id, "music:album:1");
  assert.equal(choose(cands, "the one by tanglewire")?.id, "music:album:2");
  assert.equal(choose(cands, "number two")?.id, "music:album:2");
  // The report hears each name as it is said, and counts those separately.
  const r = matchReport(ix);
  assert.ok(r.spoken.albums.variants >= 4 && r.spoken.albums.resolved === r.spoken.albums.variants, JSON.stringify(r.spoken));
  assert.ok(r.spoken.artists.variants >= 2 && r.spoken.artists.resolved === r.spoken.artists.variants, JSON.stringify(r.spoken));
});

test("smoke F7: spoken forms the smoke's report missed — a short name spelled letter by letter, ordinals past tenth, thousands — land where the written name lands; the report compares like for like and says what kind of change missed", () => {
  const ix = buildIndex({
    albums: [
      { id: 601, title: "XQZ", artist: "Tanglewire", artistId: 6, tracks: 9 },
      { id: 602, title: "The 12th Hour", artist: "Okapi Sunday", artistId: 5, tracks: 8 },
      { id: 603, title: "Room 1000", artist: "Saffron", artistId: 7, tracks: 10 },
      { id: 604, title: "13th Floor Gulls", artist: "Saffron", artistId: 7, tracks: 10 },
      { id: 605, title: "Saffron", artist: "Saffron", artistId: 7, tracks: 12 },
    ],
    artists: [{ id: 40, name: "TLQ" }],
  });
  assert.equal(sayAloud("The 12th Hour"), "The twelfth Hour");
  assert.equal(sayAloud("Room 1000"), "Room one thousand");
  assert.equal(sayAloud("Room 1050"), "Room one thousand fifty");
  assert.equal(sayAloud("13th Floor Gulls"), "thirteenth Floor Gulls");
  const plays = (said) => { const c = decide(readRequest(said), ix, {}).candidates || []; return c.length === 1 && c[0].confident ? c[0].id : `(${c.map((x) => x.id).join(",")})`; };
  for (const [said, id] of [["x q z", "music:album:601"], ["XQZ", "music:album:601"], ["the twelfth hour", "music:album:602"], ["room one thousand", "music:album:603"],
    ["thirteenth floor gulls", "music:album:604"], ["t l q", "music:artist:40"]]) assert.equal(plays(said), id, said);
  // A single letter or a word is never a spelled name: "a" and "x" alone find nothing new.
  assert.notEqual(plays("x"), "music:album:601");
  const r = matchReport(ix);
  assert.deepEqual([r.spoken.albums.variants, r.spoken.albums.resolved], [4, 4], JSON.stringify(r.spoken));
  assert.deepEqual([r.spoken.artists.variants, r.spoken.artists.resolved], [1, 1]);
  assert.deepEqual(r.spoken.albums.missed_by, {});
  assert.deepEqual(spokenChanges("Vol. 2"), ["number", "short"]);
  assert.deepEqual(spokenChanges("Blue"), ["other"]);
  // A miss is counted by its kind: an index where the spoken form cannot land.
  const odd = buildIndex({ albums: [{ id: 701, title: "QQ 7", artist: "Ladder", artistId: 9, tracks: 3 }, { id: 702, title: "q q seven", artist: "Ladder", artistId: 9, tracks: 3 }] });
  const ro = matchReport(odd);
  assert.ok(ro.spoken.albums.variants >= 1);
  assert.equal(JSON.stringify(ro).includes("QQ"), false, "counts only: no name leaves the report");
});

test("r7 (re-smoke R6-12): spelled initialisms with an n or an r b inside, thousands with a comma and numbers with leading zeros meet the written names; 'r and b' still means the genre; written matches are unchanged", () => {
  // Made-up names shaped like the report's misses (letters: 23 albums / 9 artists; numbers: 63 albums).
  const titles = ["DNQ Sessions", "SRB Live", "QNRX Live", "BNR Live", "ANR Tapes", "RB Kites", "RNR Heron", "ENQ Heron", "10,000 Nights", "30,000 Feet", "1,000,000 Reasons", "007 Heron", "0042 Signal"];
  const albums = titles.map((t, i) => ({ id: 700 + i, title: t, artistId: 800 + (i % 3), artist: ["Quiet Heron", "Moth Engine", "Lantern Kite"][i % 3], tracks: 9, year: 2001 }));
  const artists = [{ id: 900, name: "DNQ Heron" }, { id: 901, name: "SRB" }, { id: 902, name: "QNRX" }, { id: 903, name: "ANR" }, { id: 904, name: "10,000 Moths" },
    { id: 800, name: "Quiet Heron" }, { id: 801, name: "Moth Engine" }, { id: 802, name: "Lantern Kite" }];
  const ix = buildIndex({ albums, artists, genres: [{ name: "R&B" }, { name: "Rock" }], playlists: [] });
  const r = matchReport(ix);
  assert.equal(r.spoken.albums.resolved, r.spoken.albums.variants, JSON.stringify(r.spoken));
  assert.equal(r.spoken.artists.resolved, r.spoken.artists.variants, JSON.stringify(r.spoken));
  assert.ok(r.spoken.albums.variants >= 12 && r.spoken.artists.variants >= 5, JSON.stringify(r.spoken));
  // The written names still resolve to themselves.
  assert.equal(r.albums.unique_resolved, titles.length, JSON.stringify(r.albums));
  assert.equal(r.artists.resolved, artists.length);
  // Readings and foldings.
  assert.equal(sayAloud("10,000 Nights"), "ten thousand Nights");
  assert.equal(sayAloud("007 Heron"), "zero zero seven Heron");
  assert.equal(fold("d n q sessions"), "d n q sessions", "a spelled run keeps its n");
  assert.equal(fold("10,000 nights"), "10000 nights");
  assert.equal(fold("ten thousand nights"), "10000 nights");
  for (const g of ["r and b", "r n b", "r b", "R&B", "RnB"]) assert.equal(compact(g), "rnb", g);
  const run = (s) => decide(readRequest(s), ix, { tracks: [], artistAlbums: new Set() }).candidates.map((c) => c.id);
  assert.deepEqual(run("some r and b"), ["music:genre:rnb"]);
  assert.deepEqual(run("a n r tapes"), ["music:album:704"]);
});

test("r7b L5: a request with an article before 'r n b' / 'r b' still asks for the genre ('play a r n b mix', 'some a r b'); a spelled name stays a name", () => {
  for (const g of ["a r n b", "a r b", "an r and b"]) assert.ok(compact(g).endsWith("rnb"), `${g} → ${compact(g)}`);
  assert.equal(fold("d n q sessions"), "d n q sessions");
  assert.equal(fold("a n r tapes"), "a n r tapes", "a spelled name that starts with A keeps its letters");
});

test("r8 P4: spoken album numbers — a long title is read whole (the report no longer reads the 80-character display name), a year or catalog range is read 'N to M', and 'to' between two numbers folds away on both sides; written matches unchanged", () => {
  const titles = ["Symphony No. 9 in D Minor, Op. 125 'Choral' (Live at the Royal Festival Hall, London, 1999)", "Cello Suites, BWV 1007-1012", "Greatest Moths 1970-2002 (Disc 1 of 2)", "Kites (1999–2003)", "Heron Songs 1-12", "2 to 1 Moths"];
  const albums = titles.map((t, i) => ({ id: 800 + i, title: t, artistId: 850 + (i % 2), artist: ["Quiet Heron", "Moth Engine"][i % 2], tracks: 9, year: 2001 }));
  const ix = buildIndex({ albums, artists: [{ id: 850, name: "Quiet Heron" }, { id: 851, name: "Moth Engine" }], genres: [], playlists: [] });
  const r = matchReport(ix);
  assert.equal(r.albums.unique_resolved, titles.length, "written unchanged");
  assert.equal(r.spoken.albums.resolved, r.spoken.albums.variants, JSON.stringify(r.spoken));
  assert.equal(sayAloud("Greatest Moths 1970-2002"), "Greatest Moths nineteen seventy to two thousand two");
  assert.equal(fold("greatest moths nineteen seventy to two thousand two"), "greatest moths 1970 2002");
  assert.equal(fold("1970 to 2002"), "1970 2002", "STT writing digits with 'to' meets the written range too");
  assert.equal(fold("from me to you"), "from me to you", "'to' between words stays");
  const run = (s) => decide(readRequest(s), ix, { tracks: [], artistAlbums: new Set() }).candidates.map((c) => c.id);
  assert.deepEqual(run("cello suites b w v one thousand seven to one thousand twelve"), ["music:album:801"]);
});
