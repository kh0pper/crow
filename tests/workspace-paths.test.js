import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPath, filesUrl, hrefToSegs, joinPath, pimHref, pimHrefToSegs, pimObjectUrl, pimCollectionUrl, principalUrl } from "../bundles/workspace/server/nc/paths.js";
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

test("hrefToSegs validates every decoded segment (encoded .., %2F, malformed %)", () => {
  for (const h of ["/remote.php/dav/files/crow-bot/%2e%2e/admin/secret.docx", "/remote.php/dav/files/crow-bot/a%2Fb", "/remote.php/dav/files/crow-bot/a%zz", "/remote.php/dav/files/crow-bot/a%5Cb"]) {
    assert.throws(() => hrefToSegs(cfg, h), (e) => e.code === "bad_path", h);
  }
});

test("filesUrl refuses a parent hop or slash segment; the root URL has no trailing slash", () => {
  assert.throws(() => filesUrl(cfg, ["a", "..", "b"]), (e) => e.code === "bad_path");
  assert.throws(() => filesUrl(cfg, ["a/b"]), (e) => e.code === "bad_path");
  assert.equal(filesUrl(cfg, []), "http://127.0.0.1:1/remote.php/dav/files/crow-bot");
});

test("CalDAV/CardDAV hrefs: built and re-validated only through paths.js (Task 10)", () => {
  const cfg = { ncUrl: "http://nc", user: "crow-bot" };
  assert.equal(pimHref(cfg, "cal", ["menu_shared_by_admin"]), "/remote.php/dav/calendars/crow-bot/menu_shared_by_admin/");
  assert.equal(pimHref(cfg, "card", ["casa", "a b.vcf"]), "/remote.php/dav/addressbooks/users/crow-bot/casa/a%20b.vcf");
  assert.deepEqual(pimHrefToSegs(cfg, "cal", "http://other/remote.php/dav/calendars/crow-bot/menu/x%40y.ics"), ["menu", "x@y.ics"]);
  assert.deepEqual(pimHrefToSegs(cfg, "cal", "/remote.php/dav/calendars/crow-bot/"), []);
  assert.equal(pimObjectUrl(cfg, "/remote.php/dav/calendars/crow-bot/menu/x%40y.ics"), "http://nc/remote.php/dav/calendars/crow-bot/menu/x%40y.ics");
  for (const bad of ["/remote.php/dav/calendars/crow-bot/menu/%2e%2e", "/remote.php/dav/calendars/crow-bot/%2E%2E/x.ics", "/remote.php/dav/calendars/crow-bot/menu/a%2fb.ics",
    "/remote.php/dav/calendars/admin/menu/x.ics", "/remote.php/dav/files/crow-bot/x.ics", "/remote.php/dav/calendars/crow-bot/menu/x/y.ics", "/remote.php/dav/calendars/crow-bot/menu/%E0%A4%A.ics"]) {
    assert.throws(() => pimHrefToSegs(cfg, "cal", bad), { code: "bad_path" }, bad);
  }
  assert.throws(() => pimObjectUrl(cfg, "/remote.php/dav/calendars/crow-bot/menu/"), { code: "bad_path" });
  assert.throws(() => pimCollectionUrl(cfg, "cal", "/remote.php/dav/calendars/crow-bot/menu/x.ics"), { code: "bad_path" });
  assert.throws(() => pimHref(cfg, "cal", [".."]), { code: "bad_path" });
  assert.throws(() => principalUrl(cfg, "../admin"), { code: "bad_path" });
});
