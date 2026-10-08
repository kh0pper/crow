import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { SOURCE_CONTRACT, SourceUnavailable, sourceProblem, createSourceRegistry } from "../bundles/kiosk/server/sources/index.js";
import { stationKey, normalizeStations, parseStations, createStationsSource, probeStation, stationUpstream, stationNamesHint, soundSearch, STATIONS_SETTING, MAX_STATIONS } from "../bundles/kiosk/server/sources/stations.js";
import { soundKeys, wordSound, letterSound } from "../bundles/kiosk/server/sources/sound-key.js";
import { createRelay, addressClassifier, publicHop, readHostNetwork } from "../bundles/kiosk/server/relay.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/sync-allowlist.js";

// Three presets shaped like a station with HD sub-channels (a made-up call sign; example.invalid hosts).
const PRESETS = normalizeStations([
  { name: "WXYZ HD1", aliases: ["WXYZ", "WXYZ one", "ninety point one"], url: "https://stream.example.invalid/live_128" },
  { name: "WXYZ HD2", aliases: ["WXYZ two", "HD two"], url: "https://stream.example.invalid/hd2_128" },
  { name: "WXYZ HD3", aliases: ["WXYZ three", "HD three", "classic country"], url: "https://stream.example.invalid/classic_country" },
]);
const source = (list = PRESETS) => createStationsSource({ list: () => list });
const ids = (what, opts) => source().search(what, opts).map((c) => `${c.id}${c.confident ? "!" : "?"}`);

test("the contract: version 1, five functions; a registry leaves out anything else and offers only what is configured", () => {
  const s = source();
  assert.deepEqual([s.kind, s.contract, SOURCE_CONTRACT, sourceProblem(s)], ["radio", 1, 1, null]);
  for (const m of ["available", "search", "queue", "resolve", "choose"]) assert.equal(typeof s[m], "function", m);
  assert.match(sourceProblem({ ...s, contract: 2 }), /contract 2/);
  assert.match(sourceProblem({ ...s, choose: undefined }), /no choose\(\)/);
  assert.equal(sourceProblem(null), "not an object");
  const logs = [];
  const empty = source([]);
  const broken = { ...source(), kind: "music", available: () => { throw new Error("boom"); } };
  const reg = createSourceRegistry([s, { kind: "news", contract: 2 }, empty, broken, "nope"], { log: (l) => logs.push(l) });
  assert.deepEqual(reg.all().map((x) => x.kind), ["radio", "radio", "music"]);
  assert.deepEqual(reg.kinds(), ["radio"], "configured sources only; one that throws is not offered");
  assert.deepEqual(logs.length, 2);
  assert.match(logs[0], /^\[kiosk\] play source news left out: contract 2/);
  assert.deepEqual(createSourceRegistry([empty]).kinds(), []);
  const e = new SourceUnavailable("unauthorized");
  assert.deepEqual([e instanceof Error, e.name, e.code, new SourceUnavailable("weird").code, new SourceUnavailable().code], [true, "SourceUnavailable", "unauthorized", "unreachable", "unreachable"]);
});

test("stationKey: one canonical form for what was typed and what speech-to-text wrote", () => {
  const same = (variants, key) => { for (const v of variants) assert.equal(stationKey(v), key, v); };
  same(["WXYZ HD1", "wxyz hd 1", "WXYZ HD one", "W X Y Z HD1", "W.X.Y.Z. HD-1", "wxyz h d one", "WXYZ HD won"], "wxyz hd 1");
  same(["HD two", "HD2", "h d two", "H.D. 2", "hd too", "HD to"], "hd 2");
  same(["h d three", "HD3", "HD three", "H D 3"], "hd 3");
  same(["WXYZ two", "wxyz 2", "W X Y Z two", "WXYZ too", "WXYZ to", "w x y z too", "WXYZ 2."], "wxyz 2");
  same(["WXYZ one", "WXYZ won", "wxyz 1"], "wxyz 1");
  same(["ninety point one", "90.1", "90 point 1", "ninety point one FM"], "90 1");
  same(["classic country", "Classic Country radio", "the classic country station"], "classic country");
  assert.equal(stationKey("going to the store"), "going to store", "'to' in the middle of a name stays a word");
  assert.equal(stationKey("hd to three"), "hd 2 3", "straight after hd it is a digit wherever it stands");
  assert.equal(stationKey("to"), "to", "a homophone alone is not a digit");
  assert.equal(stationKey("too"), "too");
  assert.equal(stationKey("a b"), "ab", "two or more single letters are one spelled word");
  assert.equal(stationKey("play a station"), "play a", "one single letter stays a word");
  assert.equal(stationKey(""), "");
  assert.equal(stationKey(null), "");
  assert.equal(stationKey("x".repeat(5000)), "", "longer than any station name: no key");
});

test("the three presets, by every way of saying them (table)", () => {
  const TABLE = [
    ["WXYZ", "st_wxyz_hd1!"], ["W X Y Z", "st_wxyz_hd1!"], ["wxyz one", "st_wxyz_hd1!"], ["WXYZ won", "st_wxyz_hd1!"], ["WXYZ HD1", "st_wxyz_hd1!"], ["WXYZ HD one", "st_wxyz_hd1!"], ["wxyz h d one", "st_wxyz_hd1!"], ["ninety point one", "st_wxyz_hd1!"], ["90.1", "st_wxyz_hd1!"],
    ["WXYZ two", "st_wxyz_hd2!"], ["WXYZ too", "st_wxyz_hd2!"], ["WXYZ to", "st_wxyz_hd2!"], ["w x y z too", "st_wxyz_hd2!"], ["wxyz 2", "st_wxyz_hd2!"], ["WXYZ HD2", "st_wxyz_hd2!"], ["WXYZ HD two", "st_wxyz_hd2!"], ["WXYZ HD too", "st_wxyz_hd2!"], ["HD two", "st_wxyz_hd2!"], ["h d two", "st_wxyz_hd2!"], ["hd too", "st_wxyz_hd2!"],
    ["WXYZ three", "st_wxyz_hd3!"], ["WXYZ HD3", "st_wxyz_hd3!"], ["h d three", "st_wxyz_hd3!"], ["HD 3", "st_wxyz_hd3!"], ["classic country", "st_wxyz_hd3!"], ["the classic country station", "st_wxyz_hd3!"],
  ];
  for (const [said, want] of TABLE) assert.deepEqual(ids(said), [want], said);
  assert.deepEqual(ids("WXYZ HD"), ["st_wxyz_hd1?", "st_wxyz_hd2?", "st_wxyz_hd3?"], "three sub-channels: offered, not guessed");
  assert.deepEqual(ids("HD"), ["st_wxyz_hd2?", "st_wxyz_hd3?"]);
  for (const miss of ["WXYZ four", "HD nine", "country", "jazz", "wx", "going to the store", "to"]) assert.deepEqual(ids(miss), [], miss);
});

test("a unique prefix is a guess unless the request named the radio: loose in an auto search, confident on an explicit one", () => {
  assert.deepEqual(ids("classic"), ["st_wxyz_hd3?"], "another source may have the real thing under that name");
  assert.deepEqual(ids("classic", { explicit: true }), ["st_wxyz_hd3!"]);
  assert.deepEqual(ids("WXYZ", { explicit: true }), ["st_wxyz_hd1!"], "an exact alias wins over being a prefix of all three");
});

test("an explicit radio request with no station name: the only station plays; several are offered", () => {
  assert.deepEqual(ids("the radio"), []);
  assert.deepEqual(ids("the radio", { explicit: true }), ["st_wxyz_hd1?", "st_wxyz_hd2?", "st_wxyz_hd3?"]);
  const one = source(PRESETS.slice(0, 1));
  assert.deepEqual(one.search("radio", { explicit: true }).map((c) => c.confident), [true]);
  assert.equal(one.available(), true);
  assert.equal(source([]).available(), false);
  assert.equal(createStationsSource({ list: () => { throw new Error("no list"); } }).available(), false, "never throws");
});

test("choose: after 'Which one?', the words name exactly one of the OFFERED stations — or nothing is chosen", () => {
  const s = source();
  const offered = s.search("WXYZ HD");
  assert.equal(offered.length, 3);
  const pick = (said, from = offered) => s.choose(from, said)?.id ?? null;
  for (const [said, want] of [["WXYZ HD two", "st_wxyz_hd2"], ["HD two", "st_wxyz_hd2"], ["h d too", "st_wxyz_hd2"], ["WXYZ too", "st_wxyz_hd2"], ["the classic country station", "st_wxyz_hd3"], ["classic", "st_wxyz_hd3"], ["HD1", "st_wxyz_hd1"], ["ninety point one", "st_wxyz_hd1"], ["WXYZ", "st_wxyz_hd1"]]) assert.equal(pick(said), want, said);
  for (const said of ["HD", "WXYZ HD", "the second one", "never mind", "what time is it", "", "x".repeat(600)]) assert.equal(pick(said), null, said);
  assert.equal(pick("HD three", offered.slice(0, 2)), null, "a station that was not offered is not chosen");
  assert.equal(pick("HD two", []), null);
  assert.equal(s.choose(null, "HD two"), null);
  assert.equal(s.choose(offered, "HD two"), offered[1], "the candidate itself comes back");
});

test("resolve and queue: a playable with the stream address on the server side only, and a public policy on every hop", () => {
  const src = source();
  const [c] = src.search("classic country");
  assert.deepEqual(c, { id: "st_wxyz_hd3", kind: "station", title: "WXYZ HD3", confident: true });
  assert.ok(!JSON.stringify(src.search("WXYZ HD")).includes("example.invalid"), "a candidate carries no address");
  const p = src.resolve(c);
  assert.deepEqual(p, { kind: "station", id: "st_wxyz_hd3", title: "WXYZ HD3", subtitle: "", form: "audio", codec: "", source: "radio", upstream: { url: "https://stream.example.invalid/classic_country", hop: publicHop("https://stream.example.invalid/classic_country") } });
  assert.deepEqual(p.upstream.hop, { origin: "https://stream.example.invalid", redirects: 3, redirectTo: "public", private: "none" });
  assert.deepEqual(src.queue(c, { limit: 50 }), [p]);
  assert.throws(() => src.resolve({ id: "st_gone" }), /station gone/);
  assert.deepEqual(stationUpstream({ url: "http://stream.example.invalid:8000/x" }).hop.private, "none");
});

test("normalizeStations: names, aliases and URLs are validated; ids are slugs; at most 50; nothing with credentials; a private address only with the home-network tick and only in its ranges", () => {
  const out = normalizeStations([
    { name: "Morning Mix", aliases: ["the mix", "mm"], url: "https://stream.example.invalid/live.mp3", local: true },
    { name: "Bad creds", url: "https://user:pw@stream.example.invalid/x" }, { name: "Script", url: "javascript:alert(1)" }, { name: "Ftp", url: "ftp://stream.example.invalid/x" }, { name: "", url: "https://stream.example.invalid/y" },
    { name: "Loopback", url: "http://127.0.0.1:8000/stream", local: true }, { name: "Lan no tick", url: "http://192.168.1.20:8000/stream" }, { name: "Decimal", url: "http://2130706433/stream", local: true }, { name: "Metadata", url: "http://169.254.169.254/latest/", local: true },
    { name: "Link six", url: "http://[fe80::1]:8000/stream", local: true }, { name: "Local is not a string", url: "http://192.168.1.21:8000/stream", local: "yes" },
    { name: "Six", url: "http://[::1]:8000/stream" }, { name: "Mapped", url: "http://[::ffff:10.0.0.1]/stream" }, { name: "Dot", url: "https://stream.example.invalid./x" }, { name: "No URL" }, null, "x",
    { name: "N".repeat(200), aliases: Array.from({ length: 9 }, (_, i) => `alias ${i}`), url: "https://stream.example.invalid/long" },
    { name: "Morning Mix", url: "https://stream.example.invalid/second" },
    ...Array.from({ length: 60 }, (_, i) => ({ name: `Station ${i}`, url: `https://stream.example.invalid/${i}` })),
  ]);
  assert.equal(out.length, MAX_STATIONS);
  assert.deepEqual(out[0], { id: "st_morning_mix", name: "Morning Mix", aliases: ["the mix", "mm"], url: "https://stream.example.invalid/live.mp3", local: true, addrs: [] });
  assert.deepEqual([out[1].name.length, out[1].aliases.length, "local" in out[1]], [60, 5, false]);
  assert.equal(out[2].id, "st_morning_mix_2");
  assert.ok(out.every((s) => /^st_[a-z0-9_]+$/.test(s.id)) && new Set(out.map((s) => s.id)).size === out.length);
  assert.ok(out.every((s) => s.url.startsWith("https://stream.example.invalid/")), "every refused row is gone");
  // With the tick, the home-network and tailnet ranges are stations; nothing else private is.
  const lan = normalizeStations([{ name: "Shed", url: "http://192.168.1.20:8000/stream", local: true }, { name: "Den", url: "http://10.0.0.50/s", local: true }, { name: "Peer", url: "http://100.64.20.7:8000/s", local: true },
    { name: "Six", url: "http://[fd00::5]:8000/s", local: true }, { name: "Named", url: "http://radio.lan.example.invalid:8000/s", local: true }]);
  assert.deepEqual(lan.map((x) => [x.name, x.local]), [["Shed", true], ["Den", true], ["Peer", true], ["Six", true], ["Named", true]]);
  assert.equal(stationUpstream(lan[0]).hop.private, "local");
  assert.equal(stationUpstream({ url: "https://stream.example.invalid/x" }).hop.private, "none", "no tick: the public policy");
  assert.equal(stationUpstream({ ...lan[0], headers: { Authorization: "x" } }).headers, undefined, "a station upstream never carries a credential");
  assert.deepEqual(normalizeStations("nope"), []);
  assert.deepEqual(parseStations(JSON.stringify([{ name: "A", url: "https://stream.example.invalid/a" }])).map((s) => s.id), ["st_a"]);
  for (const bad of [null, "", "{", "{}", "42", undefined]) assert.deepEqual(parseStations(bad), [], String(bad));
});

test("the station list is a setting of this instance only: it is not on the sync allowlist", () => {
  assert.equal(STATIONS_SETTING, "kiosk_stations");
  assert.equal(isSyncable(STATIONS_SETTING), false);
});

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
test("probeStation: an audio stream is ok with its type; a playlist, a web page, a private address, a bad address and a dead one are not", async () => {
  const up = http.createServer((req, res) => { res.writeHead(200, { "content-type": req.url === "/list" ? "audio/x-mpegurl" : req.url === "/page" ? "text/html" : "audio/mpeg" }); res.end("x"); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  servers.push(up);
  const names = { "stream.example.invalid": "203.0.113.10", "inside.example.invalid": "10.0.0.5", "self.example.invalid": "10.0.0.6", "meta.example.invalid": "169.254.169.254" };
  const relay = createRelay({ isPrivate: addressClassifier({ documentation: false }), network: () => readHostNetwork({ interfaces: () => ({ eth0: [{ address: "10.0.0.6", cidr: "10.0.0.6/24" }] }), defaults: () => new Set(["eth0"]) }),
    lookup: async (host) => { if (!names[host]) throw new Error("ENOTFOUND"); return [{ address: names[host], family: 4 }]; }, connect: () => net.connect(up.address().port, "127.0.0.1") });
  assert.deepEqual(await probeStation({ url: "https://stream.example.invalid/live" }, relay), { ok: true, content_type: "audio/mpeg" });
  assert.deepEqual(await probeStation({ url: "https://stream.example.invalid/list" }, relay), { ok: false, error: "not_audio", content_type: "audio/x-mpegurl" });
  assert.deepEqual(await probeStation({ url: "https://stream.example.invalid/page" }, relay), { ok: false, error: "not_audio", content_type: "text/html" });
  assert.deepEqual(await probeStation({ url: "https://inside.example.invalid/live" }, relay), { ok: false, error: "private_address" });
  assert.deepEqual(await probeStation({ url: "https://inside.example.invalid/live", local: true }, relay), { ok: true, content_type: "audio/mpeg" }, "with the tick a home-network stream is checked and plays");
  assert.deepEqual(await probeStation({ url: "https://self.example.invalid/live", local: true }, relay), { ok: false, error: "own_address" }, "never the gateway itself");
  assert.deepEqual(await probeStation({ url: "https://meta.example.invalid/live", local: true }, relay), { ok: false, error: "private_address" }, "never link-local");
  assert.deepEqual(await probeStation({ url: "http://127.0.0.1:9/live", local: true }, relay), { ok: false, error: "private_address" }, "a loopback literal is refused before any request");
  assert.deepEqual(await probeStation({ url: `http://127.0.0.1:${up.address().port}/live` }, relay), { ok: false, error: "private_address" });
  assert.deepEqual(await probeStation({ url: "https://nowhere.example.invalid/live" }, relay), { ok: false, error: "unreachable" });
  for (const url of ["", "nope", "ftp://stream.example.invalid/x", "https://user:pw@stream.example.invalid/x", "javascript:alert(1)", null]) assert.deepEqual(await probeStation({ url }, relay), { ok: false, error: "bad_url" }, String(url));
});

// Smoke 2026-10-06 F1: STT writes a call sign by its sounds (other letters of the same class, a word that
// sounds like the first letters, letter names spelled out, letters with hyphens). The same shapes here on a
// made-up call sign, KTPF.
const CALL = normalizeStations([
  { name: "KTPF HD1", aliases: ["KTPF"], url: "https://stream.example.invalid/1" },
  { name: "KTPF HD2", aliases: [], url: "https://stream.example.invalid/2" },
  { name: "KTPF HD3", aliases: ["Classic Country"], url: "https://stream.example.invalid/3" },
]);
const callIds = (what, opts) => createStationsSource({ list: () => CALL }).search(what, opts).map((c) => `${c.id}${c.confident ? "!" : c.near ? "~" : "?"}`);

test("F1 by sound: the forms STT writes for a call sign find the one station that sounds the same — never confident, `near`", () => {
  assert.equal(wordSound("cadypef"), "KTPF");
  assert.equal(letterSound("kdbf"), "KTPF");
  assert.notEqual(letterSound("wx"), letterSound("wxyz"), "a spoken vowel letter is a syllable: 'w x' is not 'w x y z'");
  assert.ok(soundKeys("ktpf hd 2").includes("KTPFJT2"));
  for (const said of ["KDBF", "KDPV", "Cady PF", "Catie PF", "kay tee pee eff", "K-T-P-V"]) assert.deepEqual(callIds(said), ["st_ktpf_hd1~"], said);
  for (const said of ["K-T-P-V-H-D-2", "CADPV HD 2", "Cadyp V.H.D.2"]) assert.deepEqual(callIds(said), ["st_ktpf_hd2~"], said);
  // A written match still wins, and is confident as before.
  assert.deepEqual(callIds("KTPF"), ["st_ktpf_hd1!"]);
});

test("F1 by sound, never a guess between two: same-sound stations are all offered; one sound off only when the radio was named; short or unrelated words never", () => {
  const twins = normalizeStations([
    { name: "KTPF", url: "https://stream.example.invalid/a" },
    { name: "KDBV", url: "https://stream.example.invalid/b" },
    { name: "KTPK", url: "https://stream.example.invalid/c" },
  ]);
  const t = (what, opts) => createStationsSource({ list: () => twins }).search(what, opts).map((c) => `${c.id}${c.confident ? "!" : c.near ? "~" : "?"}`);
  assert.deepEqual(t("KDPF"), ["st_ktpf?", "st_kdbv?"], "two stations that sound the same: offered, neither `near`");
  // One sound away: not offered in an auto search ("Play Candy Puff" is not KTPF) …
  assert.deepEqual(callIds("candy puff"), [], "ordinary words one sound off: never");
  // r7: a call-sign shape one sound off is ASKED about in an auto search (the STT prompt is off; "Play BTPF" for KTPF).
  const asked = (what, opts) => createStationsSource({ list: () => CALL }).search(what, opts).map((c) => `${c.id}${c.ask ? "?ask" : c.near ? "~" : c.confident ? "!" : "?"}`);
  assert.deepEqual(asked("BTPF"), ["st_ktpf_hd1?ask"]);
  assert.deepEqual(asked("KTBJT2"), ["st_ktpf_hd2?ask"]);
  for (const said of ["cup of tea", "Pet TF", "DTPD"]) assert.deepEqual(callIds(said), [], said);
  // … offered when the request named the radio.
  assert.deepEqual(callIds("BTPF", { explicit: true }), ["st_ktpf_hd1?"]);
  assert.deepEqual(soundSearch(twins, stationKey("TPF"), { explicit: true }), [], "three consonant sounds is too little to be one sound off");
  for (const miss of ["jazz", "classic rock", "play some music", "the", "wx", "to"]) assert.deepEqual(callIds(miss), [], miss);
});

test("F1: the STT prompt bias is the station names and aliases as written, each once", () => {
  assert.equal(stationNamesHint(CALL), "KTPF HD1, KTPF, KTPF HD2, KTPF HD3, Classic Country");
  assert.equal(stationNamesHint([]), "");
  assert.equal(stationNamesHint(null), "");
});

test("review L2 / re-review L-a: a station name that is itself a command is refused at the SAVE (runtime test); one already saved keeps loading, and is left out of the STT prompt", async () => {
  const { isCommand, commandNames } = await import("../bundles/kiosk/server/sources/stations.js");
  for (const n of ["Stop", "Louder", "Pause", "Next Radio", "next song"]) assert.equal(isCommand(n), true, n);
  for (const n of ["Morning Mix", "the mix", "HD two", "KTPF HD1"]) assert.equal(isCommand(n), false, n);
  const loaded = parseStations(JSON.stringify([{ name: "Next Radio", aliases: ["Louder", "news radio"], url: "https://stream.example.invalid/n" }, { name: "Morning Mix", aliases: ["Pause", "the mix"], url: "https://stream.example.invalid/m" }]));
  assert.deepEqual(loaded.map((s) => s.name), ["Next Radio", "Morning Mix"], "already saved: still there after a deploy");
  assert.deepEqual(commandNames(loaded), ["Next Radio", "Louder", "Pause"]);
  assert.equal(stationNamesHint(loaded), "news radio, Morning Mix, the mix", "commands never reach the STT prompt");
});

test("r7b (review L2): the STT hotwords are the operator's own ALL-CAPS words of 3–6 letters in the names and aliases, each once, at most five — a vowel does not matter, an ordinary word never counts", async () => {
  const { callSignHotwords } = await import("../bundles/kiosk/server/sources/stations.js");
  assert.equal(callSignHotwords(CALL), "KTPF");
  const more = normalizeStations([
    { name: "KTPF HD1", aliases: ["ktpf", "ninety point one"], url: "https://stream.example.invalid/1" },
    { name: "WXYZ", aliases: ["Morning Mix"], url: "https://stream.example.invalid/2" },
    { name: "Classic Country", aliases: ["HD two", "KDBV-FM"], url: "https://stream.example.invalid/3" },
    { name: "KQEB", url: "https://stream.example.invalid/4" },
    { name: "Rhythm Radio", url: "https://stream.example.invalid/5" },
  ]);
  assert.equal(callSignHotwords(more), "KTPF WXYZ KDBV KQEB");
  assert.equal(callSignHotwords([]), "");
  assert.equal(callSignHotwords(null), "");
});
