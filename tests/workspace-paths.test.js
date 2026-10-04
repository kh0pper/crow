import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPath, filesUrl, hrefToSegs, joinPath } from "../bundles/workspace/server/nc/paths.js";
const cfg = { ncUrl: "http://127.0.0.1:1", user: "crow-bot" };

test("traversal, URLs, control chars and backslashes are refused before any request", () => {
  for (const bad of ["../x", "a/../b", "a/./b", "a//b", "http://evil/x", "file:/etc/passwd", "a\\b", "a\u0000b", "a\nb", "", "/"]) {
    assert.throws(() => splitPath(bad), (e) => e.code === "bad_path", JSON.stringify(bad));
  }
});

test("a colon in a name is fine; only URL schemes are refused", () => {
  assert.deepEqual(splitPath("Notas: casa/lista.docx"), ["Notas: casa", "lista.docx"]);
});

test("leading slash means drive root; trailing slash ignored", () => {
  assert.deepEqual(splitPath("/Shared with Crow/Casa Nueva/"), ["Shared with Crow", "Casa Nueva"]);
});

test("paths: accented + emoji segments round-trip (Review Focus 1)", () => {
  const p = "Shared with Crow/Menu\u0301 semanal/Recetas – 2026 🌮.xlsx"; // decomposed é (U+0301): must come back NFC
  const segs = splitPath(p);
  assert.equal(segs[1], "Menú semanal"); // NFC
  const url = filesUrl(cfg, segs);
  assert.equal(url, "http://127.0.0.1:1/remote.php/dav/files/crow-bot/Shared%20with%20Crow/Men%C3%BA%20semanal/Recetas%20%E2%80%93%202026%20%F0%9F%8C%AE.xlsx");
  assert.deepEqual(hrefToSegs(cfg, new URL(url).pathname), segs);
  assert.equal(joinPath(segs), "Shared with Crow/Menú semanal/Recetas – 2026 🌮.xlsx");
});

test("a literal %2e%2e segment is a name, re-encoded, never a parent hop", () => {
  const url = filesUrl(cfg, splitPath("a/%2e%2e/b"));
  assert.match(url, /\/a\/%252e%252e\/b$/);
  assert.doesNotMatch(url, /\/\.\.\//);
});

test("hrefToSegs refuses hrefs outside crow-bot's root", () => {
  assert.throws(() => hrefToSegs(cfg, "/remote.php/dav/files/admin/secret.docx"), (e) => e.code === "bad_path");
});
