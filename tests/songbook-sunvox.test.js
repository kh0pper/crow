/**
 * Songbook SunVox backing-track player — renderer, meta parsing, and the
 * engine-asset route's whitelist/resolver.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { parseSongMeta } from "../servers/blog/chordpro.js";
import { renderSongPage, renderSunvoxPlayer } from "../servers/blog/songbook-renderer.js";
import { SUNVOX_LIB_FILES, resolveSunvoxLibFile } from "../servers/gateway/routes/songbook.js";

const CHORDPRO = `{title: Ramona}
{key: C}

{soc}
[C]Ramona, [G]come closer
{eoc}
`;

function post(content, extra = {}) {
  return {
    id: 1, slug: "ramona", title: "Ramona", content,
    author: "Dylan", tags: "songbook", cover_image_key: null,
    published_at: "2026-10-17", ...extra,
  };
}

test("parseSongMeta extracts the SunVox key and stays null without it", () => {
  const withSv = parseSongMeta(`**Key:** C\n**SunVox:** storage:songs/ramona-backing.sunvox\n${CHORDPRO}`);
  assert.equal(withSv.sunvox, "storage:songs/ramona-backing.sunvox");
  assert.equal(parseSongMeta(CHORDPRO).sunvox, null);
  // case-insensitive bold key, trailing whitespace trimmed
  const lc = parseSongMeta(`**sunvox:**  songs/x.xm  \n${CHORDPRO}`);
  assert.equal(lc.sunvox, "songs/x.xm");
});

test("renderSongPage embeds the SunVox player for storage-backed keys only", () => {
  const html = renderSongPage(post(`**SunVox:** storage:songs/ramona.sunvox\n${CHORDPRO}`));
  assert.ok(html.includes('id="svPlayer"'), "player card present");
  assert.ok(html.includes('data-src="/blog/media/songs%2Framona.sunvox"'), "storage key routed through /blog/media");
  assert.ok(html.includes("/blog/songbook/lib/"), "engine base path is the lib route");
  assert.ok(html.includes("sunvox_lib_loader.js"), "loader script referenced");
  assert.ok(html.includes("sv_load_from_memory"), "widget uses the memory loader");
  assert.ok(html.includes("Download project"), "download fallback link present");

  // external http(s) URLs are NOT rendered as a player (connect-src 'self' would block them)
  const ext = renderSongPage(post(`**SunVox:** https://example.com/track.sunvox\n${CHORDPRO}`));
  assert.ok(!ext.includes('id="svPlayer"'), "cross-origin key must not render the player");

  // no meta → no player, page still renders
  const plain = renderSongPage(post(CHORDPRO));
  assert.ok(!plain.includes('id="svPlayer"'));
  assert.ok(plain.includes("Ramona"));
});

test("key override shows the 'track stays in original key' badge only with a backing track", () => {
  const html = renderSongPage(post(`**Key:** C\n**SunVox:** storage:songs/r.sunvox\n${CHORDPRO}`), { targetKey: "G" });
  assert.ok(html.includes("pill-warn"), "warning badge present");
  assert.ok(html.includes("Track stays in C"), "badge names the recorded key");

  // NOTE: .pill-warn also appears in the player's CSS block, so negative
  // cases assert on the badge TEXT, not the class.
  const noTrack = renderSongPage(post(`**Key:** C\n${CHORDPRO}`), { targetKey: "G" });
  assert.ok(!noTrack.includes("Track stays in"), "no badge without a backing track");

  const sameKey = renderSongPage(post(`**Key:** C\n**SunVox:** storage:songs/r.sunvox\n${CHORDPRO}`), { targetKey: "C" });
  assert.ok(!sameKey.includes("Track stays in"), "no badge when the key is unchanged");
});

test("renderSunvoxPlayer widget exposes practice controls", () => {
  const w = renderSunvoxPlayer("/blog/media/x.sunvox");
  for (const id of ["svPlay", "svStop", "svVol", "svPos", "svLoopA", "svLoopB", "svLoopClear"]) {
    assert.ok(w.includes(`id="${id}"`), `${id} control present`);
  }
  assert.ok(w.includes("sv_set_autostop(0, 0)"), "loops endlessly (autostop off)");
  assert.ok(w.includes("sv_rewind"), "A/B loop rewinds");
});

test("lib route whitelist: exact filenames only, resolver finds the vendored assets", () => {
  assert.deepEqual(Object.keys(SUNVOX_LIB_FILES).sort(), ["LICENSE.txt", "THIRD-PARTY-NOTICES.txt", "sunvox.js", "sunvox.wasm", "sunvox_lib_loader.js"]);
  assert.equal(SUNVOX_LIB_FILES["sunvox.wasm"], "application/wasm");

  // traversal and non-whitelisted names are refused
  assert.equal(resolveSunvoxLibFile("../../manifest.json"), null);
  assert.equal(resolveSunvoxLibFile("sunvox.wasm.evil"), null);
  assert.equal(resolveSunvoxLibFile(""), null);

  // the repo bundle carries the pinned assets (installed-first fallback to repo)
  for (const f of Object.keys(SUNVOX_LIB_FILES)) {
    const p = resolveSunvoxLibFile(f);
    assert.ok(p, `${f} resolves`);
    assert.ok(existsSync(p), `${f} exists at ${p}`);
  }
});

// --- Review fixes (2026-10-19) ---

test("lib route also serves the upstream licence texts beside the engine", () => {
  for (const f of ["LICENSE.txt", "THIRD-PARTY-NOTICES.txt"]) {
    assert.match(SUNVOX_LIB_FILES[f], /^text\/plain/);
    assert.ok(resolveSunvoxLibFile(f), `${f} resolves`);
  }
  const card = renderSunvoxPlayer("/blog/media/x.sunvox");
  assert.match(card, /Powered by <a [^>]*>SunVox<\/a> \(modular synth &amp; tracker\)/, "attribution (upstream REQUIREMENT 1)");
  assert.match(card, /href="\/blog\/songbook\/lib\/THIRD-PARTY-NOTICES\.txt"/);
});

test("vendored engine files match the sha256 pins recorded in the songbook manifest", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const notes = JSON.parse(readFileSync(new URL("../bundles/songbook/manifest.json", import.meta.url), "utf8")).notes;
  for (const f of ["sunvox.js", "sunvox_lib_loader.js", "sunvox.wasm"]) {
    const pin = new RegExp(f.replace(".", "\\.") + " ([0-9a-f]{64})").exec(notes)?.[1];
    assert.ok(pin, `${f} pinned in manifest notes`);
    const got = createHash("sha256").update(readFileSync(resolveSunvoxLibFile(f))).digest("hex");
    assert.equal(got, pin, `${f} sha256`);
  }
});

test("player: Play is clickable before the engine loads and the first click boots it", async () => {
  const vm = await import("node:vm");
  const html = renderSunvoxPlayer("/blog/media/song.sunvox");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const els = {};
  const el = (id) => (els[id] ||= {
    id, disabled: /svStop|svLoop/.test(id), textContent: "", innerHTML: "", attrs: {}, handlers: {},
    classList: { add() {}, remove() {} },
    getAttribute(k) { return k === "data-src" ? "/blog/media/song.sunvox" : this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { this.handlers[t] = fn; },
    value: "220",
  });
  for (const id of ["svPlayer", "svStatus", "svPlay", "svStop", "svVol", "svPos", "svMeta", "svLoopA", "svLoopB", "svLoopClear"]) el(id);
  const appended = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => els[id] || null, createElement: () => ({}), head: { appendChild: (s) => appended.push(s) } },
    setInterval, clearInterval, Promise, Number, Error,
  });
  vm.runInContext(script, ctx);
  assert.equal(els.svPlay.disabled, false, "Play must not start disabled: boot() only runs from its click");
  els.svPlay.handlers.click();
  assert.equal(appended[0]?.src, "/blog/songbook/lib/sunvox.js", "first click starts loading the engine");
  assert.equal(els.svPlay.disabled, true, "Play is disabled while the engine loads");
});
