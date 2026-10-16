// Design kit (spec §3.1 theme-factory, §4.4 house style): ten named themes,
// each a palette plus a kit font pair, readable as CSS variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LIB = new URL("../bundles/design-kit/lib/", import.meta.url).pathname;
const themes = JSON.parse(readFileSync(join(LIB, "themes.json"), "utf8"));
const entries = new Map(JSON.parse(readFileSync(join(LIB, "manifest.json"), "utf8")).entries.map((e) => [e.name, e]));

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("ten themes, each with four hex roles and a readable text colour", () => {
  const ids = Object.keys(themes.themes);
  assert.equal(ids.length, 10);
  assert.match(themes.source, /^github:anthropics\/skills@[0-9a-f]{40}$/);
  for (const id of ids) {
    const t = themes.themes[id];
    assert.match(id, /^[a-z0-9][a-z0-9-]{0,39}$/);
    assert.ok(t.name && t.upstream, id);
    for (const role of ["bg", "fg", "accent", "accent2"]) assert.match(t.colors[role], /^#[0-9a-f]{6}$/, `${id}.${role}`);
    assert.ok(contrast(t.colors.fg, t.colors.bg) >= 4.5, `${id}: fg/bg contrast ${contrast(t.colors.fg, t.colors.bg).toFixed(2)} < 4.5`);
  }
});

test("each theme maps to kit fonts and has a theme entry that requires them", () => {
  for (const [id, t] of Object.entries(themes.themes)) {
    for (const k of ["heading", "body"]) assert.equal(entries.get(t.fonts[k])?.kind, "font", `${id}.${k} → ${t.fonts[k]}`);
    const e = entries.get(`theme:${id}`);
    assert.ok(e, `theme:${id} entry`);
    assert.deepEqual(e.requires, [t.fonts.heading, t.fonts.body].filter((v, i, a) => a.indexOf(v) === i));
    assert.deepEqual(e.allowed, ["page", "document", "diagram"]);
    const css = readFileSync(join(LIB, e.main), "utf8");
    for (const v of ["--hs-bg", "--hs-fg", "--hs-accent", "--hs-accent-2", "--hs-font-heading", "--hs-font-body"]) assert.ok(css.includes(v), `${id}: ${v}`);
    assert.ok(css.includes(t.colors.bg) && css.includes(`"${entries.get(t.fonts.body).family}"`), `${id}: values reach the CSS`);
  }
});

test("themes.json is hash-listed", () => {
  const man = JSON.parse(readFileSync(join(LIB, "manifest.json"), "utf8"));
  assert.ok(man.meta_files.some((m) => m.path === "themes.json"));
});

test("every foreground/background pair the generated CSS sets reaches 4.5:1", () => {
  for (const [id, t] of Object.entries(themes.themes)) {
    const css = readFileSync(join(LIB, entries.get(`theme:${id}`).main), "utf8");
    const vars = Object.fromEntries([...css.matchAll(/(--hs-[a-z0-9-]+):([^;}]+)/g)].map((m) => [m[1], m[2]]));
    const resolve = (v) => { const m = /^var\((--hs-[a-z0-9-]+)\)$/.exec(v.trim()); return m ? vars[m[1]] : v.trim(); };
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => !m[1].includes(":root")).map((m) => ({
      sel: m[1].trim(),
      decl: Object.fromEntries(m[2].split(";").filter(Boolean).map((d) => { const i = d.indexOf(":"); return [d.slice(0, i).trim(), resolve(d.slice(i + 1))]; })),
    }));
    const pageBg = rules.find((r) => r.decl["background"] || r.decl["background-color"]);
    assert.ok(pageBg, `${id}: page background`);
    const bgOf = (r) => r.decl["background-color"] || r.decl["background"] || pageBg.decl["background"] || pageBg.decl["background-color"];
    let pairs = 0;
    for (const r of rules) {
      if (!r.decl.color) continue;
      pairs++;
      assert.match(r.decl.color, /^#[0-9a-f]{6}$/, `${id} ${r.sel} colour resolves`);
      const c = contrast(r.decl.color, bgOf(r));
      assert.ok(c >= 4.5, `${id}: "${r.sel}" ${r.decl.color} on ${bgOf(r)} is ${c.toFixed(2)} < 4.5`);
    }
    assert.ok(pairs >= 2, `${id}: expected body and link colours`);
  }
});
