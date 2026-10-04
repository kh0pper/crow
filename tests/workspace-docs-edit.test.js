import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { assertOnlyPartsChanged, partText, bodyBlocks, assertBlocksUnchangedOutside, sofficeOpens } from "./helpers/ooxml-assert.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const bytesOf = (p) => fake.node(p).bytes;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
const putBytes = (name, bytes) => fake.addFile(`S/${name}`, bytes, { owner: "admin" });
const puts = () => fake.calls.filter((c) => c.method === "PUT").length;
/** A fixture with word/document.xml rewritten by `edit` (every other part kept as is). */
function variant(src, edit) {
  const files = unzipSync(new Uint8Array(readFileSync(join(FIX, src))));
  files["word/document.xml"] = strToU8(edit(strFromU8(files["word/document.xml"])));
  return Buffer.from(zipSync(files));
}
/** The serialized <w:p> whose text contains `needle` (by the same serializer as bodyBlocks). */
const blockWith = async (bytes, needle) => (await bodyBlocks(bytes)).find((b) => b.includes(needle));

before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

for (const src of ["rich.docx", "oo-rich.docx"]) {
  test(`${src}: find_replace across runs keeps bookmarks and comment anchors (Review Focus 3)`, async () => {
    put(`fr-${src}`, src);
    const before = bytesOf(`S/fr-${src}`);
    const r = await call("ws_docs_find_replace", { path: `S/fr-${src}`, find: "al pastor", replace: "de canasta" });
    assert.equal(r.data.results[0].occurrences, 1);
    assertOnlyPartsChanged(before, bytesOf(`S/fr-${src}`), ["word/document.xml"]);
    const xml = partText(bytesOf(`S/fr-${src}`), "word/document.xml");
    assert.match(xml, /w:bookmarkStart[^>]*w:name="tacos"/); assert.match(xml, /w:bookmarkEnd/);
    assert.match(xml, /<w:commentRangeStart w:id="0"\/>/); assert.match(xml, /<w:commentRangeEnd w:id="0"\/>/); assert.match(xml, /<w:commentReference w:id="0"\/>/);
    const md = (await call("ws_docs_read", { path: `S/fr-${src}` })).data.markdown;
    assert.match(md, /\*\*Tacos de canasta\*\*/, "replacement takes the formatting of the run where the match starts");
    assert.doesNotMatch(md, /pastor/);
  });

  test(`${src}: find_replace never matches across w:tab; NFC/NFD-equivalent accents match (Review Focus 1)`, async () => {
    put(`tab-${src}`, src);
    assert.equal((await call("ws_docs_find_replace", { path: `S/tab-${src}`, find: "Tabseparated", replace: "x" })).data.total_changes, 0);
    assert.equal((await call("ws_docs_find_replace", { path: `S/tab-${src}`, find: "Tab\tseparated", replace: "x" })).data.total_changes, 0);
    assert.equal((await call("ws_docs_find_replace", { path: `S/tab-${src}`, find: "linebreak", replace: "x" })).data.total_changes, 0, "never across w:br");
    assert.equal((await call("ws_docs_find_replace", { path: `S/tab-${src}`, find: "jalapen\u0303o", replace: "chipotle" })).data.total_changes, 1);
  });

  test(`${src}: find_replace matches NFC/NFD-equivalent accents — text STORED decomposed (Review Focus 1)`, async () => {
    // the stored paragraph is NFD (as typed on a Mac/iPhone); the find is NFC, then NFD
    const bytes = variant(src, (x) => x.replace("jalapeño", "jalapen\u0303o").replace("Última línea", "U\u0301ltima li\u0301nea"));
    putBytes(`nfd-${src}`, bytes);
    const untouched = await blockWith(bytes, "ltima li");
    assert.ok(untouched.includes("U\u0301ltima li\u0301nea"), "fixture really stores NFD");
    const r = await call("ws_docs_find_replace", { path: `S/nfd-${src}`, pairs: [{ find: "jalapeño", replace: "chipotle" }, { find: "Cebolla", replace: "Cebollín" }] });
    assert.deepEqual(r.data.results.map((x) => x.occurrences), [1, 1]);
    const after = bytesOf(`S/nfd-${src}`);
    assert.match((await call("ws_docs_read", { path: `S/nfd-${src}` })).data.markdown, /con piña y chipotle\./);
    // findHits must not mutate a paragraph it does not hit: the untouched NFD paragraph is byte-identical
    assert.equal(await blockWith(after, "ltima li"), untouched);
    const r2 = await call("ws_docs_find_replace", { path: `S/nfd-${src}`, find: "U\u0301ltima", replace: "Penúltima" });
    assert.equal(r2.data.total_changes, 1, "NFD find matches too");
  });

  test(`${src}: a paragraph that is not hit stays byte-identical even when its NFC form would contain the text across runs`, async () => {
    // "e" ends one run, the combining acute starts the next: per-run text never contains "é", so the
    // paragraph is not a hit. Its second run is also stored NFD ("li\u0301nea"), so normalizing the paragraph
    // would change its bytes: it must stay exactly as it was while another pair dirties the part.
    const bytes = variant(src, (x) => x.replace(/(<w:t[^>]*>)Última línea antes del final\.<\/w:t><\/w:r>/, '$1Le</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>\u0301ltima li\u0301nea antes del final.</w:t></w:r>'));
    putBytes(`split-${src}`, bytes);
    const untouched = await blockWith(bytes, "antes del final");
    assert.ok(untouched.includes("\u0301ltima li\u0301nea"), "fixture really stores the split + NFD text");
    for (const match_case of [true, false]) {
      const r = await call("ws_docs_find_replace", { path: `S/split-${src}`, match_case, pairs: [{ find: match_case ? "Lé" : "LÉ", replace: "x" }, { find: match_case ? "Asar" : "Hornear", replace: match_case ? "Hornear" : "Asar" }] });
      assert.deepEqual(r.data.results.map((x) => x.occurrences), [0, 1]);
      assert.equal(await blockWith(bytesOf(`S/split-${src}`), "antes del final"), untouched);
    }
  });

  test(`${src}: batch pairs are atomic — one PUT, one version`, async () => {
    put(`b-${src}`, src);
    const putsBefore = puts();
    const versionsBefore = fake.versionsOf(`S/b-${src}`).length;
    const r = await call("ws_docs_find_replace", { path: `S/b-${src}`, pairs: [{ find: "Tortillas", replace: "Totopos" }, { find: "Totopos", replace: "Tostadas" }, { find: "Nada", replace: "x" }] });
    assert.deepEqual(r.data.results.map((x) => x.occurrences), [1, 1, 0]);
    assert.equal(puts() - putsBefore, 1);
    assert.equal(fake.versionsOf(`S/b-${src}`).length - versionsBefore, 1);
  });

  test(`${src}: zero-match find_replace makes no version`, async () => {
    put(`z-${src}`, src);
    const putsBefore = puts();
    const r = await call("ws_docs_find_replace", { path: `S/z-${src}`, find: "Nada de nada", replace: "x" });
    assert.equal(r.data.changed, 0); assert.equal(r.data.version_id, null);
    assert.equal(puts() - putsBefore, 0);
  });

  test(`${src}: insert_at_heading never inherits the heading style (heading-style reset)`, async () => {
    put(`h-${src}`, src);
    const blocksBefore = await bodyBlocks(bytesOf(`S/h-${src}`));
    const r = await call("ws_docs_insert_at_heading", { path: `S/h-${src}`, heading: "Pasos", markdown: "Primero, lavar.\n\nLuego **picar**." });
    assert.equal(r.data.heading_inheritance_fix_applied, true);
    const blocksAfter = await bodyBlocks(bytesOf(`S/h-${src}`));
    const idx = blocksBefore.findIndex((b) => b.includes(">Pasos<"));
    assertBlocksUnchangedOutside(blocksBefore, blocksAfter, idx + 1, 0, 2);
    for (const b of blocksAfter.slice(idx + 1, idx + 3)) { assert.doesNotMatch(b, /w:pStyle/); assert.doesNotMatch(b, /w:numPr/); }
  });

  test(`${src}: replace_section is heading-to-heading and atomic`, async () => {
    put(`rs-${src}`, src);
    const putsBefore = puts();
    await call("ws_docs_replace_section", { path: `S/rs-${src}`, heading: "Ingredientes", markdown: "- Maíz\n- Sal" });
    assert.equal(puts() - putsBefore, 1);
    const md = (await call("ws_docs_read", { path: `S/rs-${src}` })).data.markdown;
    assert.match(md, /## Ingredientes\n\n- Maíz\n- Sal\n\n## Pasos/);
    assert.doesNotMatch(md, /Cilantro/);
  });

  test(`${src}: replace_section on an empty section with empty markdown makes no version`, async () => {
    put(`rse-${src}`, src);
    const first = await call("ws_docs_replace_section", { path: `S/rse-${src}`, heading: "Pasos", markdown: "" });
    assert.equal(first.success, true); assert.ok(first.data.changed > 0); assert.ok(first.data.version_id);
    const putsBefore = puts();
    const again = await call("ws_docs_replace_section", { path: `S/rse-${src}`, heading: "Pasos", markdown: "" });
    assert.equal(again.success, true);
    assert.ok(!again.data.changed); assert.equal(again.data.version_id, null);
    assert.equal(puts() - putsBefore, 0);
    const fill = await call("ws_docs_replace_section", { path: `S/rse-${src}`, heading: "Pasos", markdown: "Hornear." });
    assert.equal(fill.data.inserted_blocks, 1);
    assert.match((await call("ws_docs_read", { path: `S/rse-${src}` })).data.markdown, /## Pasos\n\nHornear\.\n\n# Notas/);
  });

  test(`${src}: rewrite_passages keeps paragraph style and first-run formatting; reports misses`, async () => {
    put(`rw-${src}`, src);
    const r = await call("ws_docs_rewrite_passages", { path: `S/rw-${src}`, passages: [{ match_prefix: "Tacos al", new_text: "Tacos dorados.\nSegunda línea." }, { match_prefix: "No existe", new_text: "x" }, { match_prefix: "  ", new_text: "y" }] });
    assert.deepEqual(r.data.results.map((x) => x.matched), [true, false, false]);
    const md = (await call("ws_docs_read", { path: `S/rw-${src}` })).data.markdown;
    assert.match(md, /\*\*Tacos dorados\.\*\*\n\n\*\*Segunda línea\.\*\*/);
    const xml = partText(bytesOf(`S/rw-${src}`), "word/document.xml");
    assert.match(xml, /w:bookmarkStart[^>]*w:name="tacos"/); assert.match(xml, /<w:commentReference w:id="0"\/>/);
  });

  test(`${src}: format_text adds a link and bold without touching other runs`, async () => {
    put(`ft-${src}`, src);
    const blocksBefore = await bodyBlocks(bytesOf(`S/ft-${src}`));
    const r = await call("ws_docs_format_text", { path: `S/ft-${src}`, find: "piña", link_url: "https://example.org/piña", bold: true });
    assert.equal(r.data.formatted, 1);
    const md = (await call("ws_docs_read", { path: `S/ft-${src}` })).data.markdown;
    assert.match(md, /\[\*\*piña\*\*\]\(https:\/\/example\.org\/piña\)/);
    const blocksAfter = await bodyBlocks(bytesOf(`S/ft-${src}`));
    const idx = blocksBefore.findIndex((b) => b.includes("piña"));
    assertBlocksUnchangedOutside(blocksBefore, blocksAfter, idx, 1, 1);
    assert.equal((await call("ws_docs_format_text", { path: `S/ft-${src}`, find: "piña", link_url: "javascript:alert(1)" })).code, "bad_url");
    assert.equal((await call("ws_docs_format_text", { path: `S/ft-${src}`, find: "piña" })).code, "no_style");
  });

  test(`${src}: append keeps sectPr last and the result still opens in LibreOffice`, async () => {
    put(`ap-${src}`, src);
    await call("ws_docs_append", { path: `S/ap-${src}`, markdown: "## Postres\n\n| Día | Postre |\n|---|---|\n| Viernes | Flan & café |\n\n1. uno\n2. dos" });
    const blocks = await bodyBlocks(bytesOf(`S/ap-${src}`));
    assert.match(blocks.at(-1), /^<w:sectPr/);
    const md = (await call("ws_docs_read", { path: `S/ap-${src}` })).data.markdown;
    assert.match(md, /## Postres/); assert.match(md, /\| Viernes \| Flan & café \|/); assert.match(md, /1\. uno\n1\. dos/);
    const opened = sofficeOpens(bytesOf(`S/ap-${src}`), "docx");
    if (opened === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
  });
}

test("find_replace with match_case:false works when lower-casing changes a character's length (İ)", async () => {
  putBytes("dotted.docx", variant("rich.docx", (x) => x.replace("Última línea antes del final.", "İstanbul y JALAPEÑO.")));
  const r = await call("ws_docs_find_replace", { path: "S/dotted.docx", find: "jalapeño", replace: "chile", match_case: false });
  assert.equal(r.data.total_changes, 2, "both the original jalapeño and the upper-case one");
  assert.match((await call("ws_docs_read", { path: "S/dotted.docx" })).data.markdown, /İstanbul y chile\./);
});

test("insert_image embeds a drive image sized from its header", async () => {
  put("img.docx", "rich.docx");
  fake.addFile("S/dot.png", Buffer.from("89504e470d0a1a0a0000000d49484452000000c8000000640806000000", "hex").subarray(0, 24));
  const before = bytesOf("S/img.docx");
  const r = await call("ws_docs_insert_image", { path: "S/img.docx", image_path: "S/dot.png", index: 0, max_width_pt: 75 });
  assert.equal(r.success, true);
  const xml = partText(bytesOf("S/img.docx"), "word/document.xml");
  assert.match(xml, /<wp:extent cx="952500" cy="476250"\/>/); // 200x100 px scaled to 75 pt = 952500 EMU wide
  // spec §4.3: the part is word/media/imageN.* (rich.docx already has image1.png)
  const changed = assertOnlyPartsChanged(before, bytesOf("S/img.docx"), ["word/document.xml", "word/_rels/document.xml.rels", "word/media/image2.png"]);
  assert.ok(changed.includes("word/media/image2.png"));
  assert.match(partText(bytesOf("S/img.docx"), "word/_rels/document.xml.rels"), /Target="media\/image2\.png"/);
  assert.equal((await call("ws_docs_insert_image", { path: "S/img.docx", image_path: "S/fr-rich.docx" })).code, "bad_image");
});

test("insert_image replaces anchor_text inside one run and keeps the rest of the run's text", async () => {
  put("img2.docx", "oo-rich.docx");
  fake.addFile("S/dot2.gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 5, 0]), Buffer.alloc(8)]));
  const r = await call("ws_docs_insert_image", { path: "S/img2.docx", image_path: "S/dot2.gif", anchor_text: "piña" });
  assert.equal(r.data.placed, "anchor");
  const xml = partText(bytesOf("S/img2.docx"), "word/document.xml");
  assert.match(xml, /<wp:extent cx="95250" cy="47625"\/>/);
  assert.match((await call("ws_docs_read", { path: "S/img2.docx" })).data.markdown, /con  y jalapeño\./);
  assert.match(partText(bytesOf("S/img2.docx"), "[Content_Types].xml"), /Extension="gif" ContentType="image\/gif"/);
  assert.equal((await call("ws_docs_insert_image", { path: "S/img2.docx", image_path: "S/dot2.gif", anchor_text: "no existe" })).code, "not_found");
});

test("create dedupes by title and starts from the blank template", async () => {
  const a = await call("ws_docs_create", { folder: "S", title: "Menú", content: "# Semana 1\n\nTacos" });
  assert.equal(a.data.created, true); assert.equal(a.data.path, "S/Menú.docx");
  const b = await call("ws_docs_create", { folder: "S", title: "Menú.docx" });
  assert.equal(b.data.created, false);
  assert.match((await call("ws_docs_read", { path: "S/Menú.docx" })).data.markdown, /^# Semana 1/m);
  const c = await call("ws_docs_create", { folder: "S", title: "Menú", find_existing: false });
  assert.equal(c.data.created, true); assert.equal(c.data.path, "S/Menú (2).docx");
  assert.equal((await call("ws_docs_create", { folder: "S", title: "a/b" })).code, "bad_path");
});

test("no full-document replace tool exists (D7 guardrail)", async () => {
  const conn = await connectWorkspace(fake);
  try {
    const tools = (await conn.client.listTools()).tools;
    const docs = tools.filter((t) => t.name.startsWith("ws_docs_")).map((t) => t.name).sort();
    // exactly the §4.3 Docs tools so far (comment tools arrive in a later task) — nothing else can replace a whole document
    assert.deepEqual(docs, ["ws_docs_append", "ws_docs_create", "ws_docs_find_replace", "ws_docs_format_text", "ws_docs_get_structure", "ws_docs_insert_at_heading", "ws_docs_insert_image", "ws_docs_read", "ws_docs_read_section", "ws_docs_replace_section", "ws_docs_rewrite_passages"]);
    for (const t of tools) {
      assert.doesNotMatch(t.name, /^ws_docs_(replace|write|overwrite|set|update)(_all|_document|_content)?$/, t.name);
      assert.doesNotMatch(t.description, /(replace|overwrite)s? (the )?(whole|entire|full) (document|file|contents?)/i, `${t.name} describes a whole-document replace`);
    }
    // the only docs tool taking a whole-document body is create, which never touches an existing file
    const bodyParams = tools.filter((t) => t.name.startsWith("ws_docs_") && Object.keys(t.inputSchema.properties || {}).some((k) => ["content", "text", "base64", "bytes"].includes(k))).map((t) => t.name);
    assert.deepEqual(bodyParams, ["ws_docs_create"]);
    // and office files cannot be replaced through the generic drive upload either
    const up = tools.find((t) => t.name === "ws_drive_upload_new_version");
    if (up) assert.match(up.description, /docx|office/i);
  } finally { await conn.close(); }
});
