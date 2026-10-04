import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { assertOnlyPartsChanged, sofficeOpens, partText } from "./helpers/ooxml-assert.js";
import * as X from "../bundles/workspace/server/ooxml/pptx.js";
import { parseXml, serializeXml } from "../bundles/workspace/server/ooxml/xml.js";
import { addRel, REL } from "../bundles/workspace/server/ooxml/opc.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const bytesOf = (p) => fake.node(p).bytes;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
const puts = () => fake.calls.filter((x) => x.method === "PUT").length;
// 100×100 PNG header (enough for imageSize)
const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000006400000064", "hex");
before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

/**
 * OPC consistency (what makes PowerPoint/ONLYOFFICE offer "repair"): every internal rel target exists, every
 * Override names an existing part, every part has a content type, every part is reachable through some rel (no
 * orphans), every rels file belongs to an existing part, and every r:* attribute in a part names one of its rels.
 */
function assertPackageConsistent(bytes) {
  const files = unzipSync(new Uint8Array(bytes)); const names = Object.keys(files);
  const ct = strFromU8(files["[Content_Types].xml"]);
  const defaults = new Set([...ct.matchAll(/<Default\s+Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = [...ct.matchAll(/<Override\s+PartName="([^"]+)"/g)].map((m) => m[1].slice(1));
  for (const o of overrides) assert.ok(files[o], `content-type override for missing part ${o}`);
  const isRels = (n) => n.endsWith(".rels");
  const parts = names.filter((n) => !isRels(n) && n !== "[Content_Types].xml");
  for (const p of parts) assert.ok(overrides.includes(p) || defaults.has(p.split(".").pop().toLowerCase()), `no content type for ${p}`);
  const referenced = new Set();
  const relIds = new Map();
  for (const r of names.filter(isRels)) {
    const source = r === "_rels/.rels" ? "" : r.replace(/_rels\/([^/]+)\.rels$/, "$1");
    if (source) assert.ok(files[source], `rels file ${r} belongs to missing part ${source}`);
    const base = source.split("/").slice(0, -1);
    const ids = new Set();
    for (const m of strFromU8(files[r]).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const a = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]) || [])[1];
      ids.add(a("Id"));
      if (a("TargetMode") === "External") continue;
      const t = a("Target"); let target;
      if (t.startsWith("/")) target = t.slice(1);
      else { const segs = [...base]; for (const s of t.split("/")) { if (s === "..") segs.pop(); else if (s && s !== ".") segs.push(s); } target = segs.join("/"); }
      assert.ok(files[target], `${r} → ${t}: target part missing`);
      referenced.add(target);
    }
    relIds.set(source, ids);
  }
  for (const p of parts) assert.ok(referenced.has(p), `orphaned part ${p} (no relationship points to it)`);
  for (const p of parts.filter((n) => n.endsWith(".xml"))) {
    for (const m of strFromU8(files[p]).matchAll(/\br:(?:id|embed|link|pict)="([^"]+)"/g)) assert.ok(relIds.get(p)?.has(m[1]), `${p}: r:id ${m[1]} has no relationship`);
  }
}

for (const src of ["rich.pptx", "oo-rich.pptx"]) {
  test(`${src}: read titles, shapes and notes`, async () => {
    put(`r-${src}`, src);
    const r = await call("ws_slides_read", { path: `S/r-${src}` });
    assert.deepEqual(r.data.slides.map((s) => s.title), ["Menú de octubre", "Jueves"]);
    assert.equal(r.data.slides[1].notes, "Recordar comprar piña");
    assert.ok(r.data.slides[1].shapes.some((s) => s.text === "Tacos al pastor\nAgua de jamaica"));
    assert.match(r.data.slides[0].shapes[0].object_id, /^\d+:\d+$/);
    assertPackageConsistent(bytesOf(`S/r-${src}`)); // the fixture itself is a consistent package
  });

  test(`${src}: scope "slides" provably cannot touch notes`, async () => {
    put(`f-${src}`, src);
    const before = bytesOf(`S/f-${src}`);
    const r = await call("ws_slides_find_replace", { path: `S/f-${src}`, find: "piña", replace: "mango", scope: "slides" });
    assert.equal(r.data.total_changes, 0);
    assert.equal(Buffer.compare(before, bytesOf(`S/f-${src}`)), 0, "no version when nothing matched");
    const n = await call("ws_slides_find_replace", { path: `S/f-${src}`, find: "piña", replace: "mango", scope: "notes" });
    assert.equal(n.data.total_changes, 1);
    assertOnlyPartsChanged(before, bytesOf(`S/f-${src}`), [/^ppt\/notesSlides\/notesSlide\d+\.xml$/]);
  });

  test(`${src}: find_replace matches NFC/NFD-equivalent accents; slide_ids restricts; only the hit slide part changes`, async () => {
    put(`n-${src}`, src);
    const before = bytesOf(`S/n-${src}`);
    // "Menú" typed decomposed (u + U+0301)
    const miss = await call("ws_slides_find_replace", { path: `S/n-${src}`, find: "Menú", replace: "Carta", slide_ids: ["257"] });
    assert.equal(miss.data.total_changes, 0);
    const r = await call("ws_slides_find_replace", { path: `S/n-${src}`, pairs: [{ find: "Menú", replace: "Carta" }, { find: "jamaica", replace: "horchata" }], scope: "all" });
    assert.deepEqual(r.data.results.map((x) => x.occurrences), [1, 1]);
    const changed = assertOnlyPartsChanged(before, bytesOf(`S/n-${src}`), [/^ppt\/slides\/slide\d+\.xml$/]);
    assert.equal(changed.length, 2);
    const again = await call("ws_slides_read", { path: `S/n-${src}` });
    assert.equal(again.data.slides[0].title, "Carta de octubre");
    assert.ok(again.data.slides[1].shapes.some((s) => s.text === "Tacos al pastor\nAgua de horchata"));
  });

  test(`${src}: edit_text keeps the first run's formatting; only that slide part changes`, async () => {
    put(`e-${src}`, src);
    const r = await call("ws_slides_read", { path: `S/e-${src}` });
    const box = r.data.slides[1].shapes.find((s) => s.text === "Texto libre");
    await call("ws_slides_format_text", { path: `S/e-${src}`, object_id: box.object_id, bold: true, color_hex: "336699" });
    const before = bytesOf(`S/e-${src}`);
    await call("ws_slides_edit_text", { path: `S/e-${src}`, object_id: box.object_id, new_text: "Nuevo\nTexto" });
    const changed = assertOnlyPartsChanged(before, bytesOf(`S/e-${src}`), [/^ppt\/slides\/slide\d+\.xml$/]);
    assert.equal(changed.length, 1);
    const again = await call("ws_slides_read", { path: `S/e-${src}` });
    assert.ok(again.data.slides[1].shapes.some((s) => s.text === "Nuevo\nTexto"));
    assert.match(partText(bytesOf(`S/e-${src}`), changed[0]), /<a:rPr[^>]*b="1"[^>]*>(?:(?!<\/a:rPr>)[\s\S])*336699[\s\S]*Nuevo/);
    const al = await call("ws_slides_format_paragraph", { path: `S/e-${src}`, object_id: box.object_id, alignment: "CENTER" });
    assert.equal(al.success, true);
    assert.equal((partText(bytesOf(`S/e-${src}`), changed[0]).match(/algn="ctr"/g) || []).length, 2);
    const bad = await call("ws_slides_format_text", { path: `S/e-${src}`, object_id: box.object_id, color_hex: "blue" });
    assert.equal(bad.code, "bad_color");
    const none = await call("ws_slides_format_text", { path: `S/e-${src}`, object_id: box.object_id });
    assert.equal(none.code, "no_style");
    assert.equal((await call("ws_slides_edit_text", { path: `S/e-${src}`, object_id: "257:999999", new_text: "x" })).code, "shape_not_found");
  });

  test(`${src}: add (by layout name), duplicate, reorder, delete; notes created on demand; still opens`, async () => {
    put(`s-${src}`, src);
    const bad = await call("ws_slides_add_slide", { path: `S/s-${src}`, layout: "Nope" });
    assert.equal(bad.code, "bad_args"); assert.match(bad.error, /Title and Content/);
    const add = await call("ws_slides_add_slide", { path: `S/s-${src}`, layout: "title and content", index: 1 });
    const dup = await call("ws_slides_duplicate_slide", { path: `S/s-${src}`, slide_id: add.data.slide_id });
    let st = await call("ws_slides_get_structure", { path: `S/s-${src}` });
    assert.equal(st.data.slides.length, 4);
    const ids = st.data.slides.map((s) => s.slide_id);
    // F6: the duplicate lands right after its source: [256, add, dup, 257]
    assert.deepEqual(ids, ["256", add.data.slide_id, dup.data.slide_id, "257"]);
    await call("ws_slides_reorder_slides", { path: `S/s-${src}`, slide_ids: [ids[ids.indexOf(dup.data.slide_id)]], insertion_index: 0 });
    st = await call("ws_slides_get_structure", { path: `S/s-${src}` });
    assert.equal(st.data.slides[0].slide_id, dup.data.slide_id);
    await call("ws_slides_delete_slide", { path: `S/s-${src}`, slide_id: dup.data.slide_id });
    await call("ws_slides_edit_notes", { path: `S/s-${src}`, slide_id: ids[0], text: "Saludo" });
    assert.equal((await call("ws_slides_read_notes", { path: `S/s-${src}`, slide_id: ids[0] })).data.notes[0].text, "Saludo");
    await call("ws_slides_edit_notes", { path: `S/s-${src}`, slide_id: ids[0], text: "Despedida", mode: "append" });
    assert.equal((await call("ws_slides_read_notes", { path: `S/s-${src}`, slide_id: ids[0] })).data.notes[0].text, "Saludo\nDespedida");
    await call("ws_slides_add_text_box", { path: `S/s-${src}`, slide_id: ids[0], text: "Hola", x: 1, y: 1, width: 3, height: 1, font_size: 24 });
    fake.addFile("S/p.png", PNG);
    assert.equal((await call("ws_slides_add_image", { path: `S/s-${src}`, slide_id: ids[0], image_path: "S/p.png" })).success, true);
    const r = await call("ws_slides_read", { path: `S/s-${src}` });
    assert.ok(r.data.slides[0].shapes.some((s) => s.text === "Hola"));
    assert.ok(r.data.slides[0].shapes.some((s) => s.kind === "picture"));
    assertPackageConsistent(bytesOf(`S/s-${src}`));
    if (sofficeOpens(bytesOf(`S/s-${src}`), "pptx") === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
  });

  test(`${src}: duplicating a slide with notes copies the notes; deleting slides with notes/images leaves no orphaned parts, rels or overrides`, async () => {
    put(`d-${src}`, src);
    fake.addFile(`S/d-${src}.png`, PNG);
    const dup = await call("ws_slides_duplicate_slide", { path: `S/d-${src}`, slide_id: "257" });
    let r = await call("ws_slides_read", { path: `S/d-${src}` });
    assert.deepEqual(r.data.slides.map((s) => s.slide_id), ["256", "257", dup.data.slide_id]);
    assert.equal(r.data.slides[2].notes, "Recordar comprar piña");
    assertPackageConsistent(bytesOf(`S/d-${src}`));
    // the copy's notes are its own: editing them leaves the source's alone
    await call("ws_slides_edit_notes", { path: `S/d-${src}`, slide_id: dup.data.slide_id, text: "Copia" });
    r = await call("ws_slides_read", { path: `S/d-${src}` });
    assert.equal(r.data.slides[1].notes, "Recordar comprar piña"); assert.equal(r.data.slides[2].notes, "Copia");
    await call("ws_slides_add_image", { path: `S/d-${src}`, slide_id: "257", image_path: `S/d-${src}.png` });
    const before = new Set(Object.keys(unzipSync(new Uint8Array(bytesOf(`S/d-${src}`)))));
    const del = await call("ws_slides_delete_slide", { path: `S/d-${src}`, slide_id: "257" });
    assert.equal(del.success, true);
    const after = unzipSync(new Uint8Array(bytesOf(`S/d-${src}`)));
    const gone = [...before].filter((n) => !after[n]);
    assert.ok(gone.some((n) => /^ppt\/media\//.test(n)), "the deleted slide's only-used image goes too");
    assert.ok(gone.some((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)), "its notes go too");
    assertPackageConsistent(bytesOf(`S/d-${src}`));
    assert.doesNotMatch(strFromU8(after["[Content_Types].xml"]), new RegExp(gone.filter((n) => !n.endsWith(".rels")).map((n) => `"/${n.replace(/[.]/g, "\\.")}"`).join("|")));
    r = await call("ws_slides_read", { path: `S/d-${src}` });
    assert.deepEqual(r.data.slides.map((s) => s.slide_id), ["256", dup.data.slide_id]);
    assert.equal(r.data.slides[1].notes, "Copia");
    if (sofficeOpens(bytesOf(`S/d-${src}`), "pptx") === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
  });
}

test("create makes a one-slide deck titled with the deck name; batch is one version", async () => {
  const c = await call("ws_slides_create", { title: "Menú", folder: "S" });
  assert.equal(c.data.created, true);
  const r = await call("ws_slides_read", { path: c.data.path });
  assert.equal(r.data.slides.length, 1); assert.equal(r.data.slides[0].title, "Menú");
  const p0 = puts();
  await call("ws_slides_batch_update", { path: c.data.path, ops: [{ op: "add_slide", layout: "Blank" }, { op: "find_replace", find: "Menú", replace: "Menú semanal" }] });
  assert.equal(puts() - p0, 1);
  const again = await call("ws_slides_read", { path: c.data.path });
  assert.deepEqual(again.data.slides.map((s) => s.title), ["Menú semanal", ""]);
  assertPackageConsistent(bytesOf(c.data.path));
  // a second create with the same title picks a free name
  const c2 = await call("ws_slides_create", { title: "Menú", folder: "S" });
  assert.notEqual(c2.data.path, c.data.path);
  if (sofficeOpens(bytesOf(c.data.path), "pptx") === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
});

test("batch: a bad op aborts the whole batch (no version); ops are validated", async () => {
  put("b.pptx", "rich.pptx");
  const p0 = puts(); const before = bytesOf("S/b.pptx");
  const r = await call("ws_slides_batch_update", { path: "S/b.pptx", ops: [{ op: "find_replace", find: "Jueves", replace: "Viernes" }, { op: "delete_slide" }] });
  assert.equal(r.code, "bad_args"); assert.match(r.error, /slide_id/);
  const r2 = await call("ws_slides_batch_update", { path: "S/b.pptx", ops: [{ op: "edit_text", object_id: "256:2", new_text: "Hola" }, { op: "delete_slide", slide_id: "999" }] });
  assert.equal(r2.code, "slide_not_found");
  assert.equal(puts(), p0); assert.equal(Buffer.compare(before, bytesOf("S/b.pptx")), 0);
  const ok = await call("ws_slides_batch_update", { path: "S/b.pptx", ops: [{ op: "edit_text", object_id: "256:2", new_text: "Hola" }, { op: "edit_notes", slide_id: "256", text: "nota" }, { op: "format_text", object_id: "257:4", italic: true }, { op: "reorder_slides", slide_ids: ["257"], insertion_index: 0 }] });
  assert.equal(ok.success, true); assert.equal(puts() - p0, 1);
  const rd = await call("ws_slides_read", { path: "S/b.pptx" });
  assert.deepEqual(rd.data.slides.map((s) => [s.slide_id, s.title, s.notes]), [["257", "Jueves", "Recordar comprar piña"], ["256", "Hola", "nota"]]);
});

test("add_image refuses a non-image and an image over 65535 px before any write", async () => {
  put("i.pptx", "rich.pptx");
  fake.addFile("S/not.png", Buffer.from("hello"));
  const big = Buffer.from(PNG); big.writeUInt32BE(70000, 16); fake.addFile("S/big.png", big);
  const p0 = puts();
  assert.equal((await call("ws_slides_add_image", { path: "S/i.pptx", slide_id: "256", image_path: "S/not.png" })).code, "bad_image");
  const b = await call("ws_slides_add_image", { path: "S/i.pptx", slide_id: "256", image_path: "S/big.png" });
  assert.equal(b.code, "bad_image"); assert.match(b.error, /65535/);
  assert.equal(puts(), p0);
  const r = await call("ws_slides_read", { path: "S/i.pptx" });
  assert.ok(!r.data.slides[0].shapes.some((s) => s.kind === "picture"), "a refused image is not added");
});

test("wrong file type is refused", async () => {
  fake.addFile("S/x.docx", readFileSync(join(FIX, "rich.docx")));
  assert.equal((await call("ws_slides_read", { path: "S/x.docx" })).code, "wrong_type");
});

// ---- unit tests on pptx.js (in-memory, no Nextcloud) ---------------------------------------------------

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const deckOf = (src = "rich.pptx") => X.openPptx(readFileSync(join(FIX, src)));
function setPart(deck, part, edit) { const xml = edit(serializeXml(deck.pkg.xml(part))); deck.pkg.setXml(part, parseXml(xml, part)); }

test("unit: a match spans runs (first run's formatting kept) but never a line break or field; unhit paragraphs are not normalized", () => {
  const d = deckOf();
  const s2 = X.slideById(d, "257").part;
  setPart(d, s2, (x) => x
    .replace("<a:p><a:r><a:t>Texto libre</a:t></a:r></a:p>", '<a:p><a:r><a:rPr lang="es-MX" b="1"/><a:t>Tex</a:t></a:r><a:r><a:rPr lang="es-MX"/><a:t>to li</a:t></a:r><a:br/><a:r><a:t>bre</a:t></a:r><a:fld id="{1}" type="slidenum"><a:t>2</a:t></a:fld><a:r><a:t>piña</a:t></a:r></a:p>')
    .replace("<a:t>Agua de jamaica</a:t>", "<a:t>Agua de piña</a:t>"));
  const r = X.findReplaceDeck(d, [{ find: "Texto li", replace: "Libro" }, { find: "libre", replace: "X" }, { find: "o li", replace: "?" }], true, "slides", ["257"]);
  assert.deepEqual(r.results.map((x) => x.occurrences), [1, 0, 0]);
  const xml = serializeXml(d.pkg.xml(s2));
  assert.match(xml, /<a:r><a:rPr lang="es-MX" b="1"\/><a:t>Libro<\/a:t><\/a:r><a:br\/>/);
  assert.match(xml, /Agua de piña/, "an unhit paragraph keeps its NFD text");
  const two = X.findReplaceDeck(d, [{ find: "2piña", replace: "Z" }, { find: "PIÑA", replace: "mango" }], false, "slides");
  assert.deepEqual(two.results.map((x) => x.occurrences), [0, 2], "never across a field; case-insensitive NFC/NFD match");
  assert.throws(() => X.findReplaceDeck(d, [{ find: "a", replace: "b" }], true, "everything"), { code: "bad_args" });
});

test("unit: reorder uses Google's pre-move insertion_index; duplicate ids and unknown ids are refused", () => {
  const d = deckOf();
  X.addSlide(d, "Blank"); X.addSlide(d, "Blank"); // [256, 257, 258, 259]
  assert.deepEqual(X.reorderSlides(d, ["256"], 2).order, ["257", "256", "258", "259"]);
  assert.deepEqual(X.reorderSlides(d, ["259", "257"], 0).order, ["259", "257", "256", "258"]);
  assert.deepEqual(X.reorderSlides(d, ["259"], 99).order, ["257", "256", "258", "259"]);
  assert.throws(() => X.reorderSlides(d, ["256", "256"], 0), { code: "bad_args" });
  assert.throws(() => X.reorderSlides(d, ["9"], 0), { code: "slide_not_found" });
});

test("unit: sections, custom shows and slide-jump links stay consistent through add/duplicate/reorder/delete", () => {
  const d0 = deckOf();
  const rid257 = X.slideById(d0, "257").rid;
  setPart(d0, d0.part, (x) => x.replace("<p:defaultTextStyle>", `<p:custShowLst><p:custShow name="Corto" id="0"><p:sldLst><p:sld r:id="${rid257}"/></p:sldLst></p:custShow></p:custShowLst><p:defaultTextStyle>`)
    .replace("</p:presentation>", '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Uno" id="{A}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section><p14:section name="Dos" id="{B}"><p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>'));
  const d = X.openPptx(d0.pkg.save());
  const sections = () => Array.from(d.doc.getElementsByTagNameNS("http://schemas.microsoft.com/office/powerpoint/2010/main", "section")).map((s) => Array.from(s.getElementsByTagNameNS("http://schemas.microsoft.com/office/powerpoint/2010/main", "sldId")).map((e) => e.getAttribute("id")));
  const flat = () => sections().flat();
  const order = () => d.slides.map((s) => s.id);
  const { slide_id: dupId } = X.duplicateSlide(d, "256");
  assert.deepEqual(sections(), [["256", dupId], ["257"]]);
  const { slide_id: addId } = X.addSlide(d, "Blank", 0);
  assert.deepEqual(sections()[0][0], addId); assert.deepEqual(flat(), order());
  X.reorderSlides(d, ["257"], 1); assert.deepEqual(flat(), order());
  X.reorderSlides(d, [addId], 99); assert.deepEqual(flat(), order());
  // a link on slide 256 that jumps to slide 257
  const s1 = X.slideById(d, "256").part;
  const jump = addRel(d.pkg, s1, REL.slide, "slide2.xml");
  setPart(d, s1, (x) => x.replace("<a:r><a:t>Menú de octubre</a:t></a:r>", `<a:r><a:rPr><a:hlinkClick xmlns:r="${R_NS}" r:id="${jump}" action="ppaction://hlinksldjump"/></a:rPr><a:t>Menú de octubre</a:t></a:r>`));
  X.deleteSlide(d, "257");
  assert.ok(!flat().includes("257")); assert.deepEqual(flat(), order());
  assert.equal(d.doc.getElementsByTagNameNS(P_NS, "custShow").length, 1);
  assert.equal(d.doc.getElementsByTagNameNS(P_NS, "sld").length, 0, "the custom show no longer lists the deleted slide");
  assert.doesNotMatch(serializeXml(d.pkg.xml(s1)), /hlinkClick/);
  assertPackageConsistent(d.pkg.save());
  assert.equal(X.readDeck(d, false).find((s) => s.slide_id === "256").title, "Menú de octubre");
});

test("unit: a new slide gets sldIdLst in schema order on a deck with no slides; notes add notesMasterIdLst", () => {
  const d = X.openPptx(readFileSync(new URL("../bundles/workspace/server/templates/blank.pptx", import.meta.url)));
  assert.equal(d.slides.length, 0);
  const { slide_id } = X.addSlide(d, "Title Slide");
  X.editNotes(d, slide_id, "hola");
  const top = Array.from(d.doc.documentElement.childNodes).filter((n) => n.nodeType === 1).map((n) => n.localName);
  assert.deepEqual(top.slice(0, 4), ["sldMasterIdLst", "notesMasterIdLst", "sldIdLst", "sldSz"]);
  assert.equal(X.notesText(d, X.slideById(d, slide_id)), "hola");
  assertPackageConsistent(d.pkg.save());
});

test("review I1: duplicate slide_ids in find_replace are refused (no double replace, no version)", async () => {
  put("dd.pptx", "rich.pptx");
  const p0 = puts(); const before = bytesOf("S/dd.pptx");
  const r = await call("ws_slides_find_replace", { path: "S/dd.pptx", find: "Jueves", replace: "Jueves y viernes", slide_ids: ["257", "257"] });
  assert.equal(r.code, "bad_args"); assert.match(r.error, /duplicates/);
  assert.equal(puts(), p0); assert.equal(Buffer.compare(before, bytesOf("S/dd.pptx")), 0);
  const ok = await call("ws_slides_find_replace", { path: "S/dd.pptx", find: "Jueves", replace: "Jueves y viernes", slide_ids: ["257"] });
  assert.equal(ok.data.total_changes, 1);
  assert.equal((await call("ws_slides_read", { path: "S/dd.pptx" })).data.slides[1].title, "Jueves y viernes");
});

test("a reorder that changes nothing makes no version (single tool and batch)", async () => {
  put("ro.pptx", "rich.pptx");
  const p0 = puts(); const before = bytesOf("S/ro.pptx");
  const r = await call("ws_slides_reorder_slides", { path: "S/ro.pptx", slide_ids: ["256"], insertion_index: 0 });
  assert.equal(r.success, true); assert.deepEqual(r.data.order, ["256", "257"]);
  const b = await call("ws_slides_batch_update", { path: "S/ro.pptx", ops: [{ op: "reorder_slides", slide_ids: ["257"], insertion_index: 2 }] });
  assert.equal(b.success, true);
  assert.equal(puts(), p0); assert.equal(Buffer.compare(before, bytesOf("S/ro.pptx")), 0);
  await call("ws_slides_reorder_slides", { path: "S/ro.pptx", slide_ids: ["257"], insertion_index: 0 });
  assert.equal(puts() - p0, 1);
});

test("unit: a txBody created for a shape without one goes before p:extLst", () => {
  const d0 = deckOf();
  setPart(d0, X.slideById(d0, "256").part, (x) => x.replace('<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Casa Nueva</a:t></a:r></a:p></p:txBody>', '<p:spPr/><p:extLst><p:ext uri="{X}"/></p:extLst>'));
  const d = X.openPptx(d0.pkg.save());
  X.editShapeText(d, "256:3", "Hola");
  const sp = Array.from(d.pkg.xml(X.slideById(d, "256").part).getElementsByTagNameNS(P_NS, "sp"))[1];
  assert.deepEqual(Array.from(sp.childNodes).filter((n) => n.nodeType === 1).map((n) => n.localName), ["nvSpPr", "spPr", "txBody", "extLst"]);
  assert.equal(X.readDeck(d, false)[0].shapes[1].text, "Hola");
});

test("unit: add_slide drops layout placeholder parts that reference the layout's own relationships", () => {
  const d0 = deckOf();
  const layout = "ppt/slideLayouts/slideLayout2.xml";
  const rid = addRel(d0.pkg, layout, REL.hyperlink, "https://example.com/", true);
  setPart(d0, layout, (x) => x.replace(/(<p:cNvPr id="2" name="Title 1")\/>/, `$1><a:hlinkClick xmlns:r="${R_NS}" r:id="${rid}"/></p:cNvPr>`)
    .replace(/(<p:ph type="title"\/>)/, `$1<p:custDataLst><p:custData xmlns:r="${R_NS}" r:id="${rid}"/></p:custDataLst>`));
  assert.match(serializeXml(d0.pkg.xml(layout)), /hlinkClick[\s\S]*custData /, "fixture edit applied");
  const d = X.openPptx(d0.pkg.save());
  const { slide_id } = X.addSlide(d, "Title and Content");
  const xml = serializeXml(d.pkg.xml(X.slideById(d, slide_id).part));
  assert.doesNotMatch(xml, /r:id=|hlinkClick|custData/);
  assert.match(xml, /<p:ph type="title"\/>/);
  assertPackageConsistent(d.pkg.save());
});
