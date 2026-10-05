/**
 * The one rule for fetching a library stream with the music server's credential.
 * Real HTTP servers on loopback play the music server, its object storage and an attacker;
 * every request each one receives is recorded, so "was never requested" is observed, not assumed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPinnedUpstream, firstHopRefusal, redirectRefusal, musicUpstreamConfig, originOf, UpstreamRefused } from "../servers/gateway/media/pinned-upstream.js";

const ID = "11111111-2222-3333-4444-555555555555";
let music, storage, evil;
const seen = { music: [], storage: [], evil: [] };
let musicMode = "storage";

function listen(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
}
const urlOf = (s, path = "") => `http://127.0.0.1:${s.address().port}${path}`;

before(async () => {
  storage = await listen((req, res) => { seen.storage.push({ url: req.url, auth: req.headers.authorization || null, range: req.headers.range || null }); res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("MP3BYTES"); });
  evil = await listen((req, res) => { seen.evil.push({ url: req.url, auth: req.headers.authorization || null }); res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("EVIL"); });
  music = await listen((req, res) => {
    seen.music.push({ url: req.url, auth: req.headers.authorization || null });
    if (musicMode === "direct") { res.writeHead(200, { "content-type": "audio/mpeg" }); return res.end("DIRECT"); }
    if (musicMode === "hang") return;   // never answers
    if (musicMode === "404") { res.writeHead(404); return res.end("no"); }
    const to = musicMode === "evil" ? urlOf(evil, "/steal") : musicMode === "chain" ? urlOf(storage, "/again") : musicMode === "nolocation" ? null : urlOf(storage, "/obj?sig=abc");
    res.writeHead(302, to ? { location: to } : {}); res.end();
  });
  // The "chain" case: storage answers one more redirect.
  storage.on("request", () => {});
});
after(() => { for (const s of [music, storage, evil]) s.closeAllConnections?.(), s.close(); });

const cfg = (over = {}) => ({ origin: originOf(urlOf(music)), token: "tok-secret", storageOrigin: originOf(urlOf(storage)), ...over });
const listenUrl = (extra = "") => urlOf(music, `/api/v1/listen/${ID}/${extra}`);
const reset = (mode) => { musicMode = mode; seen.music.length = 0; seen.storage.length = 0; seen.evil.length = 0; };
async function refusedWith(p) { try { await p; } catch (e) { assert.ok(e instanceof UpstreamRefused, `UpstreamRefused expected, got ${e}`); return e.code; } assert.fail("expected a refusal"); }

test("the allowed path: the credential goes to the music server only; the storage hop carries none; Range passes on both hops", async () => {
  reset("storage");
  const r = await openPinnedUpstream(listenUrl("?to=mp3"), cfg(), { range: "bytes=0-3" });
  assert.equal(await r.text(), "MP3BYTES");
  assert.deepEqual(seen.music, [{ url: `/api/v1/listen/${ID}/?to=mp3`, auth: "Bearer tok-secret" }]);
  assert.deepEqual(seen.storage, [{ url: "/obj?sig=abc", auth: null, range: "bytes=0-3" }]);
});

test("a direct 200 from the music server is returned as is", async () => {
  reset("direct");
  const r = await openPinnedUpstream(listenUrl(), cfg());
  assert.equal(await r.text(), "DIRECT");
});

test("first hop: another host, another port, another path, a stray query or userinfo is never requested", async () => {
  reset("storage");
  const c = cfg();
  const cases = {
    wrong_origin: [urlOf(evil, `/api/v1/listen/${ID}/`), `https://127.0.0.1:${music.address().port}/api/v1/listen/${ID}/`, `http://localhost:${music.address().port}/api/v1/listen/${ID}/`],
    wrong_path: [urlOf(music, "/api/v1/users/me/"), urlOf(music, `/api/v1/listen/${ID}/../../users/me/`), urlOf(music, `/api/v1/listen/${ID}`)],
    wrong_query: [listenUrl("?to=mp3&next=http://203.0.113.9/"), listenUrl("?to=exe"), listenUrl("?download=1")],
    bad_url: ["not a url", `http://user:pw@127.0.0.1:${music.address().port}/api/v1/listen/${ID}/`],
  };
  for (const [code, urls] of Object.entries(cases)) {
    for (const u of urls) {
      assert.equal(firstHopRefusal(u, c), code, u);
      assert.equal(await refusedWith(openPinnedUpstream(u, c)), code, u);
    }
  }
  assert.equal(await refusedWith(openPinnedUpstream(listenUrl(), null)), "not_configured");
  assert.deepEqual(seen, { music: [], storage: [], evil: [] }, "nothing was requested anywhere");
});

test("a redirect to any origin but the storage origin is refused, and the target is never requested", async () => {
  reset("evil");
  assert.equal(await refusedWith(openPinnedUpstream(listenUrl(), cfg())), "redirect_not_storage");
  assert.equal(seen.music.length, 1);
  assert.deepEqual(seen.evil, [], "the attacker's server saw nothing: no request, no credential");
});

test("with no storage origin set, a redirect is followed only to an address the music server's own host resolves to", async () => {
  const lookup = async (h) => (h === "music.example.invalid" ? [{ address: "203.0.113.10", family: 4 }] : h === "storage.example.invalid" ? [{ address: "203.0.113.10", family: 4 }] : h === "split.example.invalid" ? [{ address: "203.0.113.10", family: 4 }, { address: "169.254.169.254", family: 4 }] : h === "meta.example.invalid" ? [{ address: "169.254.169.254", family: 4 }] : (() => { throw new Error("ENOTFOUND"); })());
  const c = { origin: "https://music.example.invalid", token: "t", storageOrigin: null };
  assert.equal(await redirectRefusal("http://storage.example.invalid:9000/obj", c, { lookup }), null);
  assert.equal(await redirectRefusal("http://meta.example.invalid/latest/meta-data/", c, { lookup }), "redirect_not_storage");
  assert.equal(await redirectRefusal("http://split.example.invalid/x", c, { lookup }), "redirect_not_storage", "every address must match, not one of them");
  assert.equal(await redirectRefusal("http://nowhere.example.invalid/x", c, { lookup }), "redirect_unresolved");
  assert.equal(await redirectRefusal("file:///etc/passwd", c, { lookup }), "bad_redirect");
  assert.equal(await redirectRefusal("http://storage.example.invalid/x", { ...c, storageOrigin: "http://203.0.113.10:9000" }, { lookup }), "redirect_not_storage", "an explicit storage origin is exact: scheme, host and port");
});

test("a second redirect, a redirect with no Location and an upstream error are refusals", async () => {
  reset("nolocation");
  assert.equal(await refusedWith(openPinnedUpstream(listenUrl(), cfg())), "redirect_no_location");
  reset("404");
  assert.equal(await refusedWith(openPinnedUpstream(listenUrl(), cfg())), "http_404");
  reset("storage");
  const hop2 = await listen((req, res) => { res.writeHead(302, { location: urlOf(evil, "/second") }); res.end(); });
  try {
    assert.equal(await refusedWith(openPinnedUpstream(listenUrl(), cfg({ storageOrigin: null }), { fetchImpl: async (u, init) => (String(u).includes("/obj") ? fetch(urlOf(hop2, "/x"), init) : fetch(u, init)), lookup: async () => [{ address: "127.0.0.1", family: 4 }] })), "too_many_redirects");
    assert.deepEqual(seen.evil, []);
  } finally { hop2.close(); }
});

test("the caller's abort ends a hop that never answers; the credential is never sent in the clear to another scheme", async () => {
  reset("hang");
  const ac = new AbortController();
  const p = openPinnedUpstream(listenUrl(), cfg(), { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.name === "AbortError" || e.name === "TimeoutError" || /abort/i.test(String(e.message)));
  // https configured, http requested (a downgrade on the same host) is a different origin: never requested.
  assert.equal(firstHopRefusal(`http://music.example.invalid/api/v1/listen/${ID}/`, { origin: "https://music.example.invalid", token: "t" }), "wrong_origin");
});

test("musicUpstreamConfig: the add-on's own entry wins over the environment; an incomplete entry is no configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "pinned-cfg-"));
  assert.equal(musicUpstreamConfig({ crowHome: home, env: {} }), null);
  assert.deepEqual(musicUpstreamConfig({ crowHome: home, env: { FUNKWHALE_URL: "http://127.0.0.1:8600/", FUNKWHALE_ACCESS_TOKEN: "envtok" } }), { origin: "http://127.0.0.1:8600", token: "envtok", storageOrigin: null });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({ funkwhale: { env: { FUNKWHALE_URL: "https://music.example.invalid", FUNKWHALE_ACCESS_TOKEN: "addontok", FUNKWHALE_STORAGE_ORIGIN: "http://203.0.113.10:9000/bucket" } } }));
  assert.deepEqual(musicUpstreamConfig({ crowHome: home, env: { FUNKWHALE_ACCESS_TOKEN: "envtok" } }), { origin: "https://music.example.invalid", token: "addontok", storageOrigin: "http://203.0.113.10:9000" });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({ funkwhale: { env: { FUNKWHALE_URL: "https://music.example.invalid" } } }));
  assert.equal(musicUpstreamConfig({ crowHome: home, env: {} }), null);
});
