// Design kit (spec §3.2): what the vendored library must contain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLib, svgUnsafe } from "../bundles/design-kit/server/lib-check.js";

const LIB = new URL("../bundles/design-kit/lib/", import.meta.url).pathname;
const PINS = new URL("../scripts/design-kit/pins.json", import.meta.url).pathname;
const man = () => JSON.parse(readFileSync(join(LIB, "manifest.json"), "utf8"));
const by = (kind) => man().entries.filter((e) => e.kind === kind);

test("the library passes the integrity check", () => { assert.deepEqual(checkLib(LIB).errors, []); });

test("pins.json records the upstream skills commit", () => {
  assert.match(JSON.parse(readFileSync(PINS, "utf8")).anthropic_skills_commit, /^[0-9a-f]{40}$/);
});

test("ten OFL font families, woff2 only, each with a font.css, allowed everywhere", () => {
  const fonts = by("font");
  assert.equal(fonts.length, 10);
  for (const f of fonts) {
    assert.equal(f.license, "OFL-1.1", f.name);
    assert.deepEqual(f.allowed, ["page", "document", "diagram"], f.name);
    assert.ok(f.files.every((x) => x.type === "font/woff2" || x.path.endsWith("/font.css")), `${f.name}: woff2 only`);
    assert.ok(f.files.some((x) => x.type === "font/woff2"), `${f.name}: has a woff2`);
    assert.match(readFileSync(join(LIB, f.main), "utf8"), new RegExp(`font-family:"${f.family}"`));
  }
});

test("Open Props and Pico (MIT), Lucide (ISC) and Tabler (MIT) icon sets", () => {
  const names = new Map(man().entries.map((e) => [e.name, e]));
  assert.equal(names.get("css:open-props").license, "MIT");
  assert.equal(names.get("css:pico").license, "MIT");
  assert.equal(names.get("icons:lucide").license, "ISC");
  assert.equal(names.get("icons:tabler").license, "MIT");
  for (const set of ["icons:lucide", "icons:tabler"]) {
    const e = names.get(set);
    const icons = JSON.parse(readFileSync(join(LIB, e.main), "utf8"));
    assert.ok(Object.keys(icons).length >= 1000, `${set} has ${Object.keys(icons).length} icons`);
    assert.equal(e.count, Object.keys(icons).length);
    assert.ok(Object.values(icons).every((s) => s.startsWith("<svg") && !s.includes("<script")), `${set}: plain SVGs`);
    // The JSON is not an image/svg+xml file, so checkLib does not see inside it:
    // every icon must pass the same SVG allowlist on its own.
    const bad = Object.entries(icons).filter(([, s]) => svgUnsafe(s)).map(([n]) => n);
    assert.deepEqual(bad, [], `${set}: icons failing the SVG allowlist`);
  }
  assert.ok(JSON.parse(readFileSync(join(LIB, names.get("icons:lucide").main), "utf8")).coffee, "lucide has coffee");
});

test("upstream CSS rewrites are recorded on the entry, and no inline SVG survives", () => {
  const names = new Map(man().entries.map((e) => [e.name, e]));
  for (const n of ["css:open-props", "css:pico"]) {
    const e = names.get(n);
    assert.ok(Array.isArray(e.notes) && e.notes.length, `${n}: notes list what the vendor step changed`);
    assert.ok(!readFileSync(join(LIB, e.main), "utf8").includes("data:image/svg"), `${n}: inline SVG left`);
  }
});

test("Pico's inline icons are extracted to hashed, allowlisted SVG files; only the animated loading icon stays none", () => {
  const e = man().entries.find((x) => x.name === "css:pico");
  const svgs = e.files.filter((f) => f.type === "image/svg+xml");
  assert.equal(svgs.length, 11);
  assert.ok(svgs.every((f) => f.path.startsWith("css/pico/icons/") && /^[0-9a-f]{64}$/.test(f.sha256)));
  const css = readFileSync(join(LIB, e.main), "utf8");
  for (const f of svgs) assert.ok(css.includes(`url(${f.path.slice("css/pico/".length)})`), `${f.path} is referenced relatively`);
  for (const p of ["checkbox", "minus", "chevron", "date", "time", "search", "close", "valid", "invalid"]) assert.match(css, new RegExp(`--pico-icon-${p}:url\\(icons/pico-icon-${p}(-\\d)?\\.svg\\)`));
  assert.match(css, /--pico-icon-loading:none/);
  assert.ok(e.notes.some((n) => n.includes("--pico-icon-loading") && n.includes("none")));
});
