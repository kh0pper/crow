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
  assert.deepEqual(Object.keys(SUNVOX_LIB_FILES).sort(), ["sunvox.js", "sunvox.wasm", "sunvox_lib_loader.js"]);
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
