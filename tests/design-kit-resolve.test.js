// Design kit (spec §4.1, D2): names → pinned files, checked against the target.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKit, kitError, KIT_LIMITS, DEFAULT_RENDER_URL } from "../bundles/design-kit/server/kit.js";

const KIT = new URL("../bundles/design-kit", import.meta.url).pathname;
const kit = openKit(KIT);
const firstFont = [...kit.entries.values()].find((e) => e.kind === "font");
const code = (fn) => { try { fn(); return null; } catch (e) { return { code: e.code, index: e.index, allowed: e.allowed }; } };
const tamperedCopy = (mutate) => {
  const dir = mkdtempSync(join(tmpdir(), "dk-tamper-"));
  cpSync(KIT, dir, { recursive: true, filter: (p) => !p.includes("node_modules") });
  mutate(dir);
  return dir;
};

test("constants and error shape", () => {
  assert.deepEqual({ ...KIT_LIMITS }, { libNames: 40, specBytes: 65536, svgBytes: 2097152, renderTimeoutMs: 20000 });
  assert.equal(DEFAULT_RENDER_URL, "http://127.0.0.1:8018");
  const e = kitError("unknown_lib", { index: 3 });
  assert.equal(e.code, "unknown_lib");
  assert.equal(e.index, 3);
  assert.ok(e instanceof Error);
  assert.equal(kit.version, "1.0.0");
  assert.equal(kit.dir, KIT);
});

test("a page gets fonts, CSS, scripts with their dependencies, and single icons", () => {
  const r = kit.resolve([firstFont.name, "css:open-props", "vega-embed", "icons:lucide/coffee"], { target: "page" });
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes(`__lib/${firstFont.main}`));
  // No vega-interpreter entry: vega-embed bundles its own (ruling F1).
  for (const dep of ["vega", "vega-lite", "vega-embed"]) assert.ok(paths.includes(`__lib/${kit.entries.get(dep).main}`), dep);
  assert.ok(paths.includes("__lib/icons/lucide/coffee.svg"));
  assert.deepEqual(r.refs, [`__lib/${firstFont.main}`, "__lib/css/open-props/open-props.min.css", `__lib/${kit.entries.get("vega-embed").main}`, "__lib/icons/lucide/coffee.svg"]);
  const order = r.entries.map((e) => e.name);
  assert.ok(order.indexOf("vega") < order.indexOf("vega-lite") && order.indexOf("vega-lite") < order.indexOf("vega-embed"), "dependencies first");
  assert.equal(new Set(paths).size, paths.length, "no duplicate files");
  const css = r.files.find((f) => f.path === "__lib/css/open-props/open-props.min.css");
  assert.deepEqual(css.body, readFileSync(join(KIT, "lib", "css", "open-props", "open-props.min.css")));
  assert.equal(css.contentType, "text/css");
  const fontEntry = r.entries.find((e) => e.name === firstFont.name);
  assert.equal(fontEntry.family, firstFont.family);
  assert.equal(fontEntry.fallback, firstFont.fallback);
  const icon = r.files.find((f) => f.path === "__lib/icons/lucide/coffee.svg");
  assert.equal(icon.contentType, "image/svg+xml");
  assert.match(icon.body.toString("utf8"), /^<svg/);
  // Licence texts travel with the copy (review M9).
  for (const e of [firstFont, kit.entries.get("css:open-props"), kit.entries.get("vega"), kit.entries.get("vega-lite"), kit.entries.get("vega-embed"), kit.entries.get("icons:lucide")]) {
    const lic = r.files.find((f) => f.path === `__lib/${e.license_file}`);
    assert.ok(lic, `${e.name}: licence copied`);
    assert.equal(lic.contentType, "text/plain; charset=utf-8");
    assert.deepEqual(lic.body, readFileSync(join(KIT, "lib", e.license_file)));
    for (const n of e.notices || []) assert.ok(paths.includes(`__lib/${n.path}`), `${e.name}: third-party notices copied`);
  }
  assert.ok(!r.entries.some((e) => e.name === "icons:lucide"), "an icon set is not an entry; only its licence travels");
});

test("each entry keeps its internal layout under __lib/ (relative url()s still resolve)", () => {
  const r = kit.resolve(["css:pico", firstFont.name], { target: "document" });
  const paths = new Set(r.files.map((f) => f.path));
  for (const f of kit.entries.get("css:pico").files) assert.ok(paths.has(`__lib/${f.path}`), f.path);
  for (const f of firstFont.files) assert.ok(paths.has(`__lib/${f.path}`), f.path);
  const fontCss = r.files.find((f) => f.path === `__lib/${firstFont.main}`).body.toString("utf8");
  for (const [, rel] of fontCss.matchAll(/url\(\.\/([^)]+)\)/g)) {
    assert.ok(paths.has(`__lib/${firstFont.main.replace(/[^/]+$/, "")}${rel}`), rel);
  }
});

test("a licence shared by several entries is copied once", () => {
  const ids = [...kit.themes.keys()].slice(0, 3).map((id) => `theme:${id}`);
  const r = kit.resolve(ids, { target: "page" });
  const paths = r.files.map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((p) => p === `__lib/${kit.entries.get(ids[0]).license_file}`).length, 1);
});

test("repeat names are idempotent: one ref per distinct name, files once", () => {
  const r = kit.resolve(["css:pico", "css:pico", "icons:tabler/home", "icons:tabler/home"], { target: "page" });
  assert.equal(r.refs.length, 2);
  assert.equal(r.entries.filter((e) => e.name === "css:pico").length, 1);
  const paths = r.files.map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length);
});

test("page-only libraries are refused for documents and diagrams, with the index and the allowed list", () => {
  assert.deepEqual(code(() => kit.resolve(["css:pico", "vega-lite"], { target: "document" })), { code: "lib_not_allowed", index: 1, allowed: ["page"] });
  assert.deepEqual(code(() => kit.resolve(["mermaid"], { target: "diagram" })), { code: "lib_not_allowed", index: 0, allowed: ["page"] });
});

test("unknown, malformed and too many names", () => {
  assert.equal(code(() => kit.resolve(["font:Lora"], { target: "page" })).code, "unknown_lib");
  assert.deepEqual(code(() => kit.resolve(["css:pico", "icons:lucide/cofee"], { target: "page" })), { code: "unknown_lib", index: 1, allowed: undefined });
  assert.equal(code(() => kit.resolve(["icons:lucide"], { target: "page" })).code, "unknown_lib", "a set is not an icon");
  assert.equal(code(() => kit.resolve(["icons:lucide/constructor"], { target: "page" })).code, "unknown_lib", "no prototype keys");
  assert.equal(code(() => kit.resolve(["icons:lucide/../coffee"], { target: "page" })).code, "unknown_lib");
  assert.equal(code(() => kit.resolve(["icons:nope/coffee"], { target: "page" })).code, "unknown_lib");
  assert.equal(code(() => kit.resolve(["__proto__"], { target: "page" })).code, "unknown_lib");
  assert.equal(code(() => kit.resolve(["toString"], { target: "page" })).code, "unknown_lib");
  assert.deepEqual(code(() => kit.resolve(["css:pico", 42], { target: "page" })), { code: "bad_lib_name", index: 1, allowed: undefined });
  assert.equal(code(() => kit.resolve("font:lora", { target: "page" })).code, "bad_lib_name");
  assert.equal(code(() => kit.resolve(Array(41).fill("css:pico"), { target: "page" })).code, "too_many_libs");
  assert.equal(kit.resolve(Array(40).fill("css:pico"), { target: "page" }).refs.length, 1, "repeated names give one ref");
  assert.equal(code(() => kit.resolve([], { target: "slides" })).code, "bad_target");
  assert.equal(code(() => kit.resolve([])).code, "bad_target");
  assert.equal(code(() => kit.resolve([], { target: "constructor" })).code, "bad_target");
  assert.deepEqual(kit.resolve([], { target: "document" }), { files: [], refs: [], entries: [] });
});

test("a tampered file is refused at copy time", () => {
  const dir = tamperedCopy((d) => writeFileSync(join(d, "lib", "css", "pico", "pico.min.css"), "body{}"));
  try {
    const k = openKit(dir);
    assert.equal(code(() => k.resolve(["css:pico"], { target: "page" })).code, "lib_integrity");
    assert.equal(k.resolve(["css:open-props"], { target: "page" }).refs.length, 1, "untouched entries still resolve");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a tampered licence or icon map is refused", () => {
  const lic = kit.entries.get("css:open-props").license_file;
  const dir = tamperedCopy((d) => {
    writeFileSync(join(d, "lib", lic), "no licence");
    writeFileSync(join(d, "lib", "icons", "lucide.json"), JSON.stringify({ coffee: "<svg/>" }));
  });
  try {
    const k = openKit(dir);
    assert.equal(code(() => k.resolve(["css:open-props"], { target: "page" })).code, "lib_integrity");
    assert.equal(code(() => k.resolve(["icons:lucide/coffee"], { target: "page" })).code, "lib_integrity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a tampered themes.json is refused at open", () => {
  const dir = tamperedCopy((d) => writeFileSync(join(d, "lib", "themes.json"), JSON.stringify({ themes: {} })));
  try { assert.equal(code(() => openKit(dir)).code, "lib_integrity"); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("themes are exposed", () => {
  assert.equal(kit.themes.size, 10);
  const [id] = kit.themes.keys();
  assert.equal(typeof kit.themes.get(id).name, "string");
  const r = kit.resolve([`theme:${id}`], { target: "document" });
  assert.deepEqual(r.entries.at(-1).name, `theme:${id}`, "fonts before the theme");
  for (const f of Object.values(kit.themes.get(id).fonts)) assert.ok(r.entries.some((e) => e.name === f), f);
});

test("repeated names give each ref once, in first-seen order (files were already deduped)", () => {
  const r = kit.resolve(["icons:lucide/coffee", "css:pico", "icons:lucide/coffee", "css:pico", "css:open-props"], { target: "page" });
  assert.deepEqual(r.refs, ["__lib/icons/lucide/coffee.svg", `__lib/${kit.entries.get("css:pico").main}`, "__lib/css/open-props/open-props.min.css"]);
  assert.equal(new Set(r.files.map((f) => f.path)).size, r.files.length);
});
