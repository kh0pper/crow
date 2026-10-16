// Artifacts × Design kit (spec §4.1, §4.3, D2): libs resolve from the INSTALLED
// kit into the version under __lib/, are checked per type, and old versions
// never change when the kit is upgraded.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import { renderVersion, KIT_MISSING, cleanAssetPath } from "../bundles/artifacts/server/render.js";
import { createDesign } from "../bundles/artifacts/server/design.js";

const REPO_KIT = new URL("../bundles/design-kit", import.meta.url).pathname;
const s = {};
before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "art-design-libs-"));
  mkdirSync(join(s.home, "bundles"), { recursive: true });
  cpSync(REPO_KIT, join(s.home, "bundles", "design-kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  // installed.json entries are objects in real homes ({id,type,version,installedAt}).
  writeFileSync(join(s.home, "installed.json"), JSON.stringify([{ id: "artifacts", type: "bundle" }, { id: "design-kit", type: "bundle", version: "1.0.0" }]));
  s.design = createDesign({ crowHome: s.home });
  s.font = JSON.parse(readFileSync(join(REPO_KIT, "lib", "manifest.json"), "utf8")).entries.filter((e) => e.kind === "font");
  s.db = createDbClient(join(s.home, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.home, "blobs"));
});
after(() => { try { s.db.close(); } catch {} rmSync(s.home, { recursive: true, force: true }); });

const deps = (extra = {}) => ({ markdownBlocks, design: s.design, ...extra });
const errOf = async (p) => { try { await p; return null; } catch (e) { return { code: e.code, message: e.message }; } };
const bot = { kind: "bot", id: "bobby" };

test("no libs, no kit: a document renders exactly as before", async () => {
  const a = await renderVersion("document", { markdown: "# Hi\n\nText." }, { markdownBlocks });
  const b = await renderVersion("document", { markdown: "# Hi\n\nText." }, deps());
  assert.equal(a.files[0].body.toString(), b.files[0].body.toString());
  assert.equal(b.design, null);
});

test("a page gets every resolved file under __lib/, byte-identical to the kit", async () => {
  const r = await renderVersion("page", { html: "<p>x</p>", libs: [s.font[0].name, "css:open-props", "vega-embed", "icons:lucide/coffee"] }, deps());
  const paths = r.files.map((f) => f.path);
  for (const p of [`__lib/${s.font[0].main}`, "__lib/css/open-props/open-props.min.css", "__lib/js/vega/vega.min.js", "__lib/js/vega-embed/vega-embed.min.js", "__lib/icons/lucide/coffee.svg"]) assert.ok(paths.includes(p), p);
  const css = r.files.find((f) => f.path === "__lib/css/open-props/open-props.min.css");
  assert.deepEqual(css.body, readFileSync(join(REPO_KIT, "lib", "css", "open-props", "open-props.min.css")));
  assert.deepEqual(r.design.libs, [`__lib/${s.font[0].main}`, "__lib/css/open-props/open-props.min.css", "__lib/js/vega-embed/vega-embed.min.js", "__lib/icons/lucide/coffee.svg"]);
  assert.equal(r.files[0].body.toString(), "<p>x</p>", "the page html is untouched");
});

test("lib-name slips are refused with an index-specific, fixable message (Review Focus 5)", async () => {
  assert.deepEqual(await errOf(renderVersion("document", { markdown: "x", libs: ["css:pico", "vega-embed"] }, deps())),
    { code: "lib_not_allowed", message: "libs[1] is not allowed in a document (allowed in: page)" });
  assert.deepEqual(await errOf(renderVersion("page", { html: "x", libs: ["font:Lora"] }, deps())),
    { code: "unknown_lib", message: "libs[0] is not in the Design kit (the design-frontend skill lists the names)" });
  assert.equal((await errOf(renderVersion("page", { html: "x", libs: ["css:pico", "icons:lucide/cofee"] }, deps()))).message, "libs[1] is not in the Design kit (the design-frontend skill lists the names)");
  assert.deepEqual(await errOf(renderVersion("page", { html: "x", libs: "font:lora" }, deps())), { code: "bad_source", message: "libs must be a list of library names" });
  assert.equal((await errOf(renderVersion("page", { html: "x", libs: Array(41).fill("css:pico") }, deps()))).code, "too_many_libs");
  const before = Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] })).rows[0].n);
  assert.equal((await errOf(store.createArtifact(s.db, s.blobs, { title: "x", type: "page", source: { html: "x", libs: ["font:Lora"] }, actor: bot }, deps()))).code, "unknown_lib");
  assert.equal(Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] })).rows[0].n), before, "nothing saved");
});

test("documents link CSS and fonts in the head: first font = body, second = headings", async () => {
  const r = await renderVersion("document", { markdown: "# H\n\nBody", libs: [s.font[0].name, s.font[1].name, "css:pico"] }, deps());
  const html = r.files[0].body.toString();
  assert.ok(html.includes(`<link rel="stylesheet" href="__lib/${s.font[0].main}">`));
  assert.ok(html.includes('<link rel="stylesheet" href="__lib/css/pico/pico.min.css">'));
  assert.ok(html.includes(`body{font-family:"${s.font[0].family}",${s.font[0].fallback}}`));
  assert.ok(html.includes(`h1,h2,h3,h4,h5,h6{font-family:"${s.font[1].family}",${s.font[1].fallback}}`));
});

test("kit absent (not in installed.json, or missing) → kit_missing; no libs still works", async () => {
  const home = mkdtempSync(join(tmpdir(), "art-nokit-"));
  try {
    mkdirSync(join(home, "bundles"), { recursive: true });
    cpSync(REPO_KIT, join(home, "bundles", "design-kit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
    writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "artifacts", type: "bundle" }]));
    const d = createDesign({ crowHome: home });
    assert.deepEqual(await errOf(renderVersion("page", { html: "x", libs: ["css:pico"] }, { markdownBlocks, design: d })), { code: "kit_missing", message: KIT_MISSING });
    assert.match(KIT_MISSING, /^the Design kit extension isn't installed/);
    assert.equal((await renderVersion("page", { html: "x" }, { markdownBlocks, design: d })).design, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a kit upgrade never changes an old version (D2)", async () => {
  const made = await store.createArtifact(s.db, s.blobs, { title: "Styled", type: "page", source: { html: "<p>v1</p>", libs: ["css:pico"] }, actor: bot }, deps());
  assert.equal(made.design.libs[0], "__lib/css/pico/pico.min.css");
  const resolve = store.contentResolver(s.db, s.blobs);
  const v1 = (await resolve({ artifactId: made.id, versionN: 1, path: "__lib/css/pico/pico.min.css" })).body;
  // "Upgrade" the installed kit: new bytes + new hash in its manifest.
  const libDir = join(s.home, "bundles", "design-kit", "lib");
  const nb = Buffer.from("/* upgraded */body{margin:0}");
  writeFileSync(join(libDir, "css", "pico", "pico.min.css"), nb);
  const man = JSON.parse(readFileSync(join(libDir, "manifest.json"), "utf8"));
  man.entries.find((e) => e.name === "css:pico").files[0].sha256 = createHash("sha256").update(nb).digest("hex");
  writeFileSync(join(libDir, "manifest.json"), JSON.stringify(man));
  const later = new Date(Date.now() + 5000); utimesSync(join(libDir, "manifest.json"), later, later);
  const v2 = await store.addVersion(s.db, s.blobs, { artifactId: made.id, source: { html: "<p>v2</p>", libs: ["css:pico"] }, actor: bot }, deps());
  assert.deepEqual((await resolve({ artifactId: made.id, versionN: v2.n, path: "__lib/css/pico/pico.min.css" })).body, nb, "v2 has the upgrade");
  assert.deepEqual((await resolve({ artifactId: made.id, versionN: 1, path: "__lib/css/pico/pico.min.css" })).body, v1, "v1 is untouched");
});

test("a tampered installed file refuses the save", async () => {
  writeFileSync(join(s.home, "bundles", "design-kit", "lib", "css", "open-props", "open-props.min.css"), "tampered");
  assert.equal((await errOf(renderVersion("page", { html: "x", libs: ["css:open-props"] }, deps()))).code, "lib_integrity");
});

test("the __lib/ and __render/ prefixes are reserved: a bot's own asset can never use them (F3)", async () => {
  for (const p of ["__lib/css/pico/pico.min.css", "__render/d1.svg", "__lib", "__render"]) assert.equal(cleanAssetPath(p), null, p);
  assert.equal(cleanAssetPath("lib/x.css"), "lib/x.css");
  const asset = { path: "__lib/css/pico/pico.min.css", contentType: "text/css", base64: Buffer.from("x").toString("base64") };
  assert.equal((await errOf(renderVersion("page", { html: "x", assets: [asset] }, deps()))).code, "bad_asset_path");
});
