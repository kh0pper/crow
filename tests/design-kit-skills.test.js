// Design kit skills (spec §3.1, §3.4): Apache-2.0 ports from anthropics/skills,
// each with its LICENSE, a NOTICE of changes, no CDN or remote loads, a Crow
// section, and names that match the vendored library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KIT = new URL("../bundles/design-kit/", import.meta.url).pathname;
const read = (p) => readFileSync(join(KIT, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const lib = JSON.parse(read("lib/manifest.json"));
const pins = JSON.parse(readFileSync(new URL("../scripts/design-kit/pins.json", import.meta.url), "utf8"));
const SKILLS = { "design-frontend": "frontend-design", "design-themes": "theme-factory", "design-poster": "canvas-design" };

test("the manifest ships the three skills and is published", () => {
  assert.deepEqual(manifest.skills, ["skills/design-frontend.md", "skills/design-themes.md", "skills/design-poster.md"]);
  assert.equal(manifest.draft, undefined);
  assert.deepEqual(manifest.refreshFiles, ["lib", "third_party", "LICENSES.md", "NOTICE"]);
  assert.match(pins.anthropic_skills_commit, /^[0-9a-f]{40}$/);
  for (const k of ["ports", "port", "webUI"]) assert.equal(manifest[k], undefined, `${k}: loopback only, no ufw rule (review H3)`);
  assert.doesNotMatch(manifest.notes, /every Crow instance/);
});

test("design-frontend lists exactly the Mermaid types the kit accepts", async () => {
  const { MERMAID_TYPES } = await import("../bundles/design-kit/server/kit.js");
  const text = read("skills/design-frontend.md").toLowerCase();
  for (const t of MERMAID_TYPES) assert.ok(text.includes("`" + t + "`"), `${t} listed`);
  for (const t of ["quadrantchart", "sankey", "xychart", "block-beta"]) assert.ok(!text.includes("`" + t), `${t} is not advertised`);
});

test("each skill: Crow frontmatter, Apache licence beside the verbatim original, a Crow section, no remote loads", () => {
  for (const [name, upstream] of Object.entries(SKILLS)) {
    const text = read(`skills/${name}.md`);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, "m"));
    assert.match(fm[1], new RegExp(`^license: .*third_party/anthropic-skills/${upstream}/LICENSE\\.txt`, "m"));
    assert.match(read(`third_party/anthropic-skills/${upstream}/LICENSE.txt`), /Apache License/);
    assert.ok(existsSync(join(KIT, `third_party/anthropic-skills/${upstream}/SKILL.md`)), `${upstream}: verbatim SKILL.md kept`);
    assert.match(text, /^## Using the Design kit in Crow$/m, `${name}: Crow section`);
    assert.doesNotMatch(text, /cdnjs|jsdelivr|unpkg|googleapis|https?:\/\//i, `${name}: no CDN host or remote URL`);
  }
});

test("design-frontend lists exactly the vendored font, CSS and script names", () => {
  const text = read("skills/design-frontend.md");
  for (const e of lib.entries.filter((x) => ["font", "css", "icon-set"].includes(x.kind) || ["vega-embed", "mermaid"].includes(x.name))) {
    assert.ok(text.includes("`" + e.name), `${e.name} is named in design-frontend`);
  }
  assert.match(text, /at most twice/i, "the 2-self-correction rule");
  assert.match(text, /```text/, "how to show spec code as text");
});

test("design-themes names every theme and says it applies only with a house style", () => {
  const text = read("skills/design-themes.md");
  const themes = JSON.parse(read("lib/themes.json")).themes;
  for (const [id, t] of Object.entries(themes)) assert.ok(text.includes(`theme:${id}`) && text.includes(t.name), id);
  assert.match(text, /only when a house style is set/i);
  for (const v of ["--hs-bg", "--hs-fg", "--hs-accent", "--hs-accent-2", "--hs-font-heading", "--hs-font-body"]) assert.ok(text.includes(v), v);
});

test("NOTICE records the upstream commit and every change; LICENSES.md covers every component", () => {
  const notice = read("NOTICE");
  assert.ok(notice.includes(pins.anthropic_skills_commit));
  for (const u of Object.values(SKILLS)) assert.ok(notice.includes(u), u);
  const lic = read("LICENSES.md");
  for (const w of ["Apache-2.0", "OFL-1.1", "MPL-2.0", "D2", "Mermaid", "Vega", "Lucide", "Tabler", "Open Props", "Pico", "svgo", "Chromium", "puppeteer-core", "No non-commercial components"]) assert.ok(lic.includes(w), w);
});

// Review carry: the skill text must match the FINAL guard and renderer, and
// every path it names must be one the kit really copies.
test("design-frontend states the final guard rules and names only real __lib paths", async () => {
  const text = read("skills/design-frontend.md");
  const { openKit, guardSpec } = await import("../bundles/design-kit/server/kit.js");
  const kit = openKit(KIT);
  const all = kit.resolve(["font:lora", "icons:lucide/coffee", "css:open-props", "css:pico", "vega-embed", "mermaid"], { target: "page" });
  const real = new Set(all.files.map((f) => f.to || f.path));
  for (const p of text.match(/__lib\/[A-Za-z0-9_./-]+\.(?:css|js|svg)/g)) assert.ok(real.has(p), `${p} is copied by the kit`);
  assert.match(text, /no line that is just `---`/, "Mermaid takes no front matter");
  assert.match(text, /`%%\{`/, "no %%{ directives");
  assert.match(text, /no `icon` anywhere, not even inside a longer word/, "D2 refuses any icon substring");
  assert.match(text, /never paste it into a `<style>` block/, "Pico is linked as a file");
  assert.match(text, /ast: true/);
  // The examples the skill gives are accepted by the guard.
  guardSpec("mermaid", "flowchart LR\n  A --> B");
  guardSpec("mermaid", "classDiagram\n  class A\n  <<interface>> A");
  guardSpec("mermaid", "flowchart LR\n  A[one<br>two] --> B");
  assert.throws(() => guardSpec("d2", "a: silicon"), { reason: "icons" });
});

test("LICENSES.md carries the review notes: RFNs, notice files, Chromium drift, source offer, Mermaid 11.x", () => {
  const lic = read("LICENSES.md");
  assert.match(lic, /Reserved Font Name/);
  assert.match(lic, /Lora/);
  for (const f of ["mermaid-third-party.txt", "vega-third-party.txt", "vega-embed-third-party.txt"]) {
    assert.ok(lic.includes(`lib/licenses/${f}`), `${f} referenced`);
    assert.ok(existsSync(join(KIT, "lib/licenses", f)), `${f} exists`);
  }
  assert.match(lic, /\/chromium-version\.txt/);
  assert.match(lic, /F3/);
  assert.match(lic, /11\.x[\s\S]*elkjs[\s\S]*EPL-2\.0/);
});
