#!/usr/bin/env node
/**
 * Design kit — VENDOR TIME ONLY. Turns lib/themes.json into one CSS file and one
 * `theme:<id>` manifest entry per theme, copies theme-factory's Apache LICENSE
 * into lib/licenses, and hash-lists themes.json. Re-run after editing themes.json.
 *   node scripts/design-kit/build-themes.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../bundles/design-kit/server/lib-check.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = join(ROOT, "bundles", "design-kit", "lib");
const UPSTREAM = join(homedir(), ".cache", "crow-design-kit", "anthropic-skills", "skills", "theme-factory", "LICENSE.txt");
const man = JSON.parse(readFileSync(join(LIB, "manifest.json"), "utf8"));
const doc = JSON.parse(readFileSync(join(LIB, "themes.json"), "utf8"));
const byName = new Map(man.entries.filter((e) => e.kind !== "theme").map((e) => [e.name, e]));
for (const old of man.entries.filter((e) => e.kind === "theme")) for (const f of old.files) rmSync(join(LIB, f.path), { force: true });

if (!existsSync(UPSTREAM)) throw new Error(`clone anthropics/skills first (Task 2 Step 1): ${UPSTREAM}`);
const licRel = "licenses/anthropic-skills-theme-factory.txt";
writeFileSync(join(LIB, licRel), readFileSync(UPSTREAM));
const fam = (name) => { const f = byName.get(name); if (!f || f.kind !== "font") throw new Error(`unknown font ${name}`); return `"${f.family}",${f.fallback}`; };

mkdirSync(join(LIB, "themes"), { recursive: true });
const themeEntries = [];
for (const [id, t] of Object.entries(doc.themes)) {
  const c = t.colors;
  const css = `:root{--hs-bg:${c.bg};--hs-fg:${c.fg};--hs-accent:${c.accent};--hs-accent-2:${c.accent2};--hs-font-heading:${fam(t.fonts.heading)};--hs-font-body:${fam(t.fonts.body)}}\n`
    + "body{background:var(--hs-bg);color:var(--hs-fg);font-family:var(--hs-font-body)}\n"
    + "h1,h2,h3,h4,h5,h6{font-family:var(--hs-font-heading)}\na{color:var(--hs-fg);text-decoration:underline;text-decoration-color:var(--hs-accent)}\n";
  const rel = `themes/${id}.css`;
  writeFileSync(join(LIB, rel), css);
  themeEntries.push({
    name: `theme:${id}`, kind: "theme", version: man.kit_version, license: "Apache-2.0", license_file: licRel, license_sha256: sha256Hex(readFileSync(join(LIB, licRel))),
    source: doc.source, allowed: ["page", "document", "diagram"],
    files: [{ path: rel, sha256: sha256Hex(Buffer.from(css)), type: "text/css" }], main: rel,
    requires: [...new Set([t.fonts.heading, t.fonts.body])],
  });
}
man.entries = [...byName.values(), ...themeEntries].sort((a, b) => (a.name < b.name ? -1 : 1));
const meta = { path: "themes.json", sha256: sha256Hex(readFileSync(join(LIB, "themes.json"))), type: "application/json" };
man.meta_files = [...(man.meta_files || []).filter((m) => m.path !== meta.path), meta];
writeFileSync(join(LIB, "manifest.json"), JSON.stringify(man, null, 2) + "\n");
console.log(`built ${themeEntries.length} themes`);
