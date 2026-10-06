/**
 * The funkwhale bundle's search and playback tools, against a fake Funkwhale API (no network).
 * Names are made up.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://music.example.invalid";
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const track = (id, ext, over = {}) => ({ id, title: `Song ${id}`, artist: { name: "The Paper Lanterns" }, album: { id: 7, title: "Harbor Lights" }, listen_url: `/api/v1/listen/${U(id)}/`, is_playable: true, uploads: [{ extension: ext, mimetype: "application/octet-stream" }], ...over });

let calls = [];
let routes = () => null;
const realFetch = globalThis.fetch;
let tools, mod, dataDir;

before(async () => {
  // The rate-limited tools write their buckets to the Crow database: give them a fresh one.
  dataDir = mkdtempSync(join(tmpdir(), "fw-tools-"));
  process.env.CROW_DATA_DIR = dataDir;
  process.env.CROW_DB_PATH = join(dataDir, "t.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  process.env.FUNKWHALE_URL = BASE;
  process.env.FUNKWHALE_ACCESS_TOKEN = "test-token-not-real";
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: opts.method || "GET" });
    const body = routes(u, opts);
    if (body === null) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  mod = await import("../bundles/funkwhale/server/server.js");
  const server = await mod.createFunkwhaleServer({});
  tools = server._registeredTools;
});
after(() => { globalThis.fetch = realFetch; rmSync(dataDir, { recursive: true, force: true }); });

const run = async (name, args) => {
  calls = [];
  const r = await tools[name].handler(args, {});
  const text = r.content[0].text;
  return text.startsWith("Error:") ? { error: text } : JSON.parse(text);
};
const reads = () => calls.filter((c) => c.method === "GET");

test("fw_search: a track's id is its integer id, and it carries its listen id", async () => {
  routes = (u) => (u.pathname === "/api/v1/tracks/" ? { count: 1, results: [track(4321, "mp3")] } : null);
  const out = await run("fw_search", { q: "song" });
  assert.equal(out.results[0].id, 4321);
  assert.equal(out.results[0].listen_uuid, U(4321));
  routes = (u) => (u.pathname === "/api/v1/albums/" ? { count: 1, results: [{ id: 7, title: "Harbor Lights", artist: { name: "The Paper Lanterns" } }] } : null);
  const albums = await run("fw_search", { q: "harbor", type: "albums" });
  assert.equal(albums.results[0].id, 7);
  assert.equal("listen_uuid" in albums.results[0], false);
});

test("fw_play by integer id: one tracks/<id>/ read for a track anywhere in the library (no list scan); an mp3 is sent as stored", async () => {
  routes = (u) => (u.pathname === "/api/v1/tracks/18000/" ? track(18000, "mp3") : u.pathname === "/api/v1/history/listenings/" ? {} : null);
  const out = await run("fw_play", { track_id: 18000 });
  assert.deepEqual(reads().map((c) => c.path), ["/api/v1/tracks/18000/"]);
  assert.deepEqual(out._audio_stream, { url: `${BASE}/api/v1/listen/${U(18000)}/`, codec: "mp3", auth: "funkwhale" });
  assert.equal(out.prose, "Playing Song 18000 by The Paper Lanterns.");
  // A numeric string in the old argument is an id too.
  const old = await run("fw_play", { track_uuid: "18000" });
  assert.equal(old._audio_stream.url, `${BASE}/api/v1/listen/${U(18000)}/`);
});

test("fw_play: the copy is decided by the file extension, never by the MIME type", async () => {
  const cases = [["flac", null, "flac"], ["ogg", null, "ogg"], ["opus", null, "opus"], ["m4a", "mp3", "mp3"], ["aiff", "mp3", "mp3"], ["", "mp3", "mp3"]];
  for (const [ext, to, codec] of cases) {
    routes = (u) => (u.pathname === "/api/v1/tracks/5/" ? track(5, ext, { uploads: ext ? [{ extension: ext, mimetype: "audio/mpeg" }] : [] }) : {});
    const out = await run("fw_play", { track_id: 5 });
    assert.equal(out._audio_stream.url, `${BASE}/api/v1/listen/${U(5)}/${to ? `?to=${to}` : ""}`, ext);
    assert.equal(out._audio_stream.codec, codec, ext);
  }
  routes = (u) => (u.pathname === "/api/v1/tracks/5/" ? track(5, "mp3") : {});
  assert.equal((await run("fw_play", { track_id: 5, format: "opus" }))._audio_stream.url, `${BASE}/api/v1/listen/${U(5)}/?to=opus`, "an explicit format is honoured");
});

test("fw_play: an unknown id is an error naming the fix; a listen id alone plays untitled as an mp3 copy with no lookup", async () => {
  routes = () => null;
  const miss = await run("fw_play", { track_id: 99 });
  assert.match(miss.error, /Could not find track 99/);
  const byUuid = await run("fw_play", { track_uuid: U(3) });
  assert.equal(calls.length, 0, "no scan, no lookup, no listen record");
  assert.deepEqual(byUuid._audio_stream, { url: `${BASE}/api/v1/listen/${U(3)}/?to=mp3`, codec: "mp3", auth: "funkwhale" });
  assert.match((await run("fw_play", { track_uuid: "not-an-id" })).error, /track_id/);
});

test("fw_play_album: disc then track order, pages followed by number up to the end, each file's own copy rule", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => track(100 + i, "mp3"));
  const page2 = [track(200, "m4a"), track(201, "flac", { is_playable: false }), track(202, "flac")];
  routes = (u) => {
    if (u.pathname === "/api/v1/albums/7/") return { id: 7, title: "Harbor Lights", artist: { name: "The Paper Lanterns" } };
    if (u.pathname === "/api/v1/tracks/") return u.searchParams.get("page") === "2" ? { count: 53, next: null, results: page2 } : { count: 53, next: `${BASE}/elsewhere?page=2`, results: page1 };
    return {};
  };
  const out = await run("fw_play_album", { album_id: 7 });
  const lists = reads().filter((c) => c.path === "/api/v1/tracks/");
  assert.deepEqual(lists.map((c) => [c.query.page, c.query.ordering, c.query.album]), [["1", "disc_number,position", "7"], ["2", "disc_number,position", "7"]]);
  assert.ok(!calls.some((c) => c.path === "/elsewhere"), "the next address is never fetched");
  assert.equal(out.track_count, 52);
  assert.equal(out._audio_stream.url, `${BASE}/api/v1/listen/${U(100)}/`);
  assert.equal(out._audio_stream.auth, "funkwhale");
  const q = out._audio_stream.queue;
  assert.equal(q.length, 51);
  assert.deepEqual(q.slice(-2).map((x) => [x.url, x.codec, x.auth]), [[`${BASE}/api/v1/listen/${U(200)}/?to=mp3`, "mp3", "funkwhale"], [`${BASE}/api/v1/listen/${U(202)}/`, "flac", "funkwhale"]]);
  assert.equal(out.prose, "Playing Harbor Lights by The Paper Lanterns — 52 tracks.");
});

test("fw_play_album stops at the cap", async () => {
  let n = 0;
  routes = (u) => (u.pathname === "/api/v1/tracks/" ? { next: "x", results: Array.from({ length: 50 }, () => track(++n, "mp3")) } : {});
  const out = await run("fw_play_album", { album_id: 1 });
  assert.equal(out.track_count, mod.ALBUM_TRACK_CAP);
  assert.equal(reads().filter((c) => c.path === "/api/v1/tracks/").length, mod.ALBUM_TRACK_CAP / 50);
});

test("the manifest lists only tools the server registers (no fw_import_blocklist), and the skill lists the playback tools", () => {
  const manifest = JSON.parse(readFileSync(new URL("../bundles/funkwhale/manifest.json", import.meta.url), "utf8"));
  const listed = manifest.capabilities.tools.map((t) => t.name);
  assert.ok(!listed.includes("fw_import_blocklist"));
  for (const name of listed) assert.ok(tools[name], `${name} is registered`);
  const skill = readFileSync(new URL("../bundles/funkwhale/skills/funkwhale.md", import.meta.url), "utf8");
  for (const name of ["fw_play", "fw_play_album", "fw_pause", "fw_resume", "fw_next_track", "fw_stop_playback"]) assert.match(skill, new RegExp(`^  - ${name}$`, "m"));
});
