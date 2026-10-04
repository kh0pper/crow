import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8, unzipSync } from "fflate";
import { OoxmlPackage, ZIP_LIMITS } from "../bundles/workspace/server/ooxml/zip.js";
import { addRel, readRels, resolveTarget, mainPart, setOverride } from "../bundles/workspace/server/ooxml/opc.js";
import { assertOnlyPartsChanged } from "./helpers/ooxml-assert.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");

for (const f of ["rich.docx", "oo-rich.docx", "rich.xlsx", "oo-rich.xlsx", "rich.pptx", "oo-rich.pptx"]) {
  test(`${f}: open + save with no edits keeps every part byte-identical and [Content_Types].xml first`, () => {
    const before = readFileSync(join(FIX, f));
    const after = OoxmlPackage.open(before).save();
    assertOnlyPartsChanged(before, after, []);
    assert.equal(Object.keys(unzipSync(after))[0], "[Content_Types].xml");
  });
}

test("zip bomb (ratio) and too many entries are refused before inflating", () => {
  const bomb = zipSync({ "[Content_Types].xml": strToU8("<x/>"), "big.xml": new Uint8Array(5 * 1024 * 1024) }, { level: 9 });
  assert.throws(() => OoxmlPackage.open(bomb), (e) => e.code === "malformed_document" && /compress/.test(e.message));
  const many = {}; for (let i = 0; i < 20; i++) many[`f${i}`] = strToU8("a");
  assert.throws(() => OoxmlPackage.open(zipSync({ "[Content_Types].xml": strToU8("<x/>"), ...many }), { ...ZIP_LIMITS, maxEntries: 10 }), (e) => e.code === "malformed_document");
});

test("DOCTYPE in any part is refused", () => {
  const z = zipSync({ "[Content_Types].xml": strToU8('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Types/>') });
  assert.throws(() => OoxmlPackage.open(z).xml("[Content_Types].xml"), (e) => e.code === "malformed_document");
});

test("not a zip → malformed_document", () => {
  assert.throws(() => OoxmlPackage.open(Buffer.from("hello")), (e) => e.code === "malformed_document");
});

test("rels: resolve, add with a fresh id, external link; content-type override", () => {
  const pkg = OoxmlPackage.open(readFileSync(join(FIX, "rich.docx")));
  assert.equal(mainPart(pkg), "word/document.xml");
  assert.equal(resolveTarget("word/document.xml", "../customXml/item1.xml"), "customXml/item1.xml");
  const ids = new Set(readRels(pkg, "word/document.xml").map((r) => r.id));
  const id = addRel(pkg, "word/document.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", "https://example.org/a?b=1&c=2", true);
  assert.ok(!ids.has(id));
  setOverride(pkg, "/word/x.xml", "application/x-test");
  const out = OoxmlPackage.open(pkg.save());
  assert.equal(readRels(out, "word/document.xml").find((r) => r.id === id).target, "https://example.org/a?b=1&c=2");
  assert.match(out.text("[Content_Types].xml"), /PartName="\/word\/x\.xml"/);
});

test("total uncompressed size limit is enforced before inflating", () => {
  const z = zipSync({ "[Content_Types].xml": strToU8("<x/>"), "a.bin": strToU8("x".repeat(5000)) });
  assert.throws(() => OoxmlPackage.open(z, { ...ZIP_LIMITS, maxTotal: 1000 }), (e) => e.code === "malformed_document" && /200 MB/.test(e.message));
  assert.equal(ZIP_LIMITS.maxTotal, 200 * 1024 * 1024);
  assert.equal(ZIP_LIMITS.maxEntries, 5000);
  assert.equal(ZIP_LIMITS.maxRatio, 200);
  assert.equal(ZIP_LIMITS.maxXml, 30 * 1024 * 1024);
});

test("an XML part over the XML limit is refused (too_large) from its declared size, before inflating", () => {
  for (const name of ["big.xml", "word/_rels/document.xml.rels"]) {
    const z = zipSync({ "[Content_Types].xml": strToU8("<x/>"), [name]: strToU8(`<a>${"y".repeat(3000)}</a>`) });
    assert.throws(() => OoxmlPackage.open(z, { ...ZIP_LIMITS, maxXml: 1000 }), (e) => e.code === "too_large" && e.message.includes(name));
  }
  // a big non-XML part (an image) is governed by the total/ratio caps only
  const img = zipSync({ "[Content_Types].xml": strToU8("<x/>"), "word/media/image1.png": strToU8("y".repeat(3000)) }, { level: 0 });
  assert.doesNotThrow(() => OoxmlPackage.open(img, { ...ZIP_LIMITS, maxXml: 1000 }));
  const ok = OoxmlPackage.open(zipSync({ "[Content_Types].xml": strToU8("<x/>"), "small.xml": strToU8("<a/>") }), { ...ZIP_LIMITS, maxXml: 1000 });
  assert.doesNotThrow(() => ok.xml("small.xml"));
});

test("the part map is prototype-safe: entries named like Object.prototype members behave as plain names", () => {
  const z = zipSync({ "[Content_Types].xml": strToU8("<x/>"), constructor: strToU8("c"), toString: strToU8("t") });
  const pkg = OoxmlPackage.open(z);
  assert.equal(Buffer.from(pkg.bytes("constructor")).toString(), "c");
  assert.equal(Buffer.from(pkg.bytes("toString")).toString(), "t");
  assert.deepEqual(Object.keys(unzipSync(pkg.save())), ["[Content_Types].xml", "constructor", "toString"]);
  const plain = OoxmlPackage.open(zipSync({ "[Content_Types].xml": strToU8("<x/>") }));
  for (const n of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) assert.equal(plain.has(n), false, n);
  assert.deepEqual(plain.names(), ["[Content_Types].xml"]);
  plain.setBytes("__proto__", strToU8("p"));
  assert.equal(plain.has("__proto__"), true);
  assert.equal(Buffer.from(plain.bytes("__proto__")).toString(), "p");
});

test("a zip entry named __proto__ is refused cleanly (it cannot be held by the unzip map)", () => {
  // build the entry under a same-length placeholder name, then rename it in the raw bytes (local + central headers)
  const raw = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<x/>"), "__xxxxx__": strToU8("p") }));
  const renamed = Buffer.from(raw.toString("latin1").split("__xxxxx__").join("__proto__"), "latin1");
  assert.throws(() => OoxmlPackage.open(renamed), (e) => e.code === "malformed_document" && /__proto__/.test(e.message));
});

test("a DOCTYPE hidden in a non-first part is refused when that part is parsed", () => {
  const z = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8('<?xml version="1.0"?><!DOCTYPE d SYSTEM "x"><d/>') });
  assert.throws(() => OoxmlPackage.open(z).xml("word/document.xml"), (e) => e.code === "malformed_document" && /DOCTYPE/.test(e.message));
});

test("an edit touches only the edited part; the rest stays byte-identical and in order (rich + oo-rich)", () => {
  for (const f of ["rich.docx", "oo-rich.docx"]) {
    const before = readFileSync(join(FIX, f));
    const pkg = OoxmlPackage.open(before);
    const doc = pkg.xml("word/document.xml");
    doc.documentElement.setAttribute("data-t", "1");
    pkg.markDirty("word/document.xml");
    const after = pkg.save();
    assert.deepEqual(assertOnlyPartsChanged(before, after, ["word/document.xml"]), ["word/document.xml"]);
    assert.deepEqual(Object.keys(unzipSync(after)), Object.keys(unzipSync(new Uint8Array(before))));
  }
});

test("docx-model exports the shared separator set", async () => {
  const { SEP } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  assert.ok(SEP.has("tab") && SEP.has("drawing"));
});
