// Queue item 24: a diagram's index.html is served as XHTML, so the browser's
// XML parser (not the HTML tokenizer) reads the SVG. These are the save-time
// rules: the wrapper is well-formed XML, the SVG is namespaced explicitly, and
// anything the XML parser would refuse is refused at save with a fixed
// message, never stored to show a parse-error page. The live check in a
// sandboxed frame is tests/artifact-diagram-xhtml-live.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { renderVersion, xmlSvg, xmlSvgCheck, XML_MESSAGES } from "../bundles/artifacts/server/render.js";

const CORPUS = JSON.parse(readFileSync(new URL("./fixtures/rendered-svg-corpus.json", import.meta.url), "utf8")).items;
const XHTML = "application/xhtml+xml; charset=utf-8";
const SVG_NS = "http://www.w3.org/2000/svg";
const errOf = async (p) => { try { await p; return null; } catch (e) { return { code: e.code, message: e.message }; } };

/** Strict XML parse: any warning, error or fatal error fails. */
function parseXml(text) {
  const errs = [];
  let doc = null;
  try { doc = new DOMParser({ onError: (level, msg) => errs.push(`${level}: ${String(msg).split("\n")[0]}`) }).parseFromString(text, "application/xhtml+xml"); }
  catch (e) { errs.push(`fatal: ${e.message}`); }
  return { doc, errs };
}
const indexOf = (r) => r.files.find((f) => f.path === "index.html");
const kitWith = (svg) => ({ design: { kit: async () => ({ themes: new Map(), resolve: () => ({ files: [], refs: [], entries: [] }), render: async () => svg }) } });

test("a diagram's index.html is XHTML: content type, XHTML namespace, strict-XML parse, SVG in the SVG namespace", async () => {
  const r = await renderVersion("diagram", { svg: '<svg viewBox="0 0 10 10"><rect id="n1" width="5" height="5"><title>Node &amp; one</title></rect></svg>' });
  const f = indexOf(r);
  assert.equal(f.contentType, XHTML);
  const text = f.body.toString("utf8");
  assert.ok(text.startsWith('<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">'), text.slice(0, 80));
  const { doc, errs } = parseXml(text);
  assert.deepEqual(errs, []);
  const svg = doc.getElementsByTagName("svg")[0];
  assert.equal(svg.namespaceURI, SVG_NS, "the injected default namespace makes it an SVG element");
  assert.equal(doc.documentElement.namespaceURI, "http://www.w3.org/1999/xhtml");
  // The anchor map is unchanged by the namespace injection.
  assert.deepEqual(r.anchorMap, { kind: "diagram", aspect: 1, elements: [{ id: "n1", tag: "rect", title: "Node &amp; one" }] });
});

test("namespaces are made explicit only when missing; an existing declaration is kept as written", () => {
  assert.equal(xmlSvg('<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>'), `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>`);
  const both = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>`;
  assert.equal(xmlSvg(both), both);
  assert.equal(xmlSvg("<svg><g/></svg>"), `<svg xmlns="${SVG_NS}"><g/></svg>`);
  assert.equal(xmlSvg('<svg\nviewBox="0 0 1 1"/>'), null, "a self-closed root is refused (markupOk agrees)");
  // Only two declarations exist (plan review I2): anything else, even well-formed, is refused.
  assert.equal(xmlSvgCheck('<svg xmlns:ink="http://www.inkscape.org/namespaces/inkscape"><g ink:label="x"/></svg>').reason, "namespace");
  assert.ok(xmlSvg('<svg xml:space="preserve"><text xml:lang="es">a</text></svg>'), "the xml prefix needs no declaration");
});

test("each refusal names its rule: case, namespace, duplicate, reference, characters, depth", () => {
  assert.equal(xmlSvgCheck('<svg viewbox="0 0 1 1"/>').reason, "case");
  assert.equal(xmlSvgCheck('<svg><g xmlns="http://www.w3.org/1999/xhtml"/></svg>').reason, "namespace");
  assert.equal(xmlSvgCheck('<svg><rect width="1" width="2"/></svg>').reason, "duplicate");
  assert.equal(xmlSvgCheck("<svg><text>&AMP;</text></svg>").reason, "ref");
  assert.equal(xmlSvgCheck("<svg><text>&#x110000;</text></svg>").reason, "ref", "checked before any clamp");
  assert.equal(xmlSvgCheck("<svg><text>\u0001</text></svg>").reason, "char");
  assert.equal(xmlSvgCheck("<svg><g></G></svg>").reason, "close", "close tags are compared byte-for-byte");
  assert.equal(xmlSvgCheck("<svg>" + "<g>".repeat(257) + "</g>".repeat(257) + "</svg>").reason, "depth");
  assert.ok(xmlSvgCheck("<svg>" + "<g>".repeat(255) + "</g>".repeat(255) + "</svg>").svg);
  assert.ok(xmlSvgCheck('<svg viewBox="0 0 1 1" preserveAspectRatio="none"><linearGradient gradientUnits="userSpaceOnUse"/><filter><feGaussianBlur stdDeviation="1"/></filter><clipPath clipPathUnits="objectBoundingBox"/><text><textPath startOffset="1">a</textPath></text></svg>').svg, "canonical camelCase names pass");
});

test("well-formed tricky cases are accepted and stay well-formed in the wrapper", async () => {
  for (const svg of [
    '<svg><style><![CDATA[ g > rect { fill: red } ]]></style><rect/></svg>',
    "<svg><text>a &lt; b &gt; c &quot;d&quot; &apos;e&apos; &#160; &#xA0; &#x1F600;</text></svg>",
    '<svg><linearGradient id="g"><stop offset="0"/></linearGradient><rect fill="url(#g)"/></svg>',
    "<svg viewBox='0 0 1 1'><g\tid='a'\r\n/></svg>",
    "<svg><text>a ]] b ] > c</text></svg>",
  ]) {
    const r = await renderVersion("diagram", { svg });
    const { errs } = parseXml(indexOf(r).body.toString("utf8"));
    assert.deepEqual(errs, [], svg);
  }
});

test("anything the XML parser would refuse is refused at save (bad_source, one fixed message), never stored", async () => {
  const cases = [
    ["case-mismatched close tag", "<svg><linearGradient id=\"g\"></lineargradient></svg>"],
    ["case-mismatched root close", "<svg><g/></SVG>"],
    ["upper-case named reference", "<svg><text>a &AMP; b</text></svg>"],
    ["upper-case X in a hex reference", "<svg><text>&#X41;</text></svg>"],
    ["reference to NUL", "<svg><text>&#0;</text></svg>"],
    ["reference to a surrogate", "<svg><text>&#xD800;</text></svg>"],
    ["form feed in a tag", "<svg\fviewBox=\"0 0 1 1\"><g/></svg>"],
    ["C0 control in text", "<svg><text>a\u0001b</text></svg>"],
    ["U+FFFE in text", "<svg><text>a￾b</text></svg>"],
    ["lone surrogate in text", "<svg><text>a\uD800b</text></svg>"],
    ["]]> in character data", "<svg><text>a ]]> b</text></svg>"],
    ["duplicate attribute", '<svg><rect width="1" width="2"/></svg>'],
    ["duplicate after namespace expansion", '<svg xmlns:l="http://www.w3.org/1999/xlink"><use xlink:href="#a" l:href="#b"/></svg>'],
    ["unbound prefix", '<svg><g foo:bar="1"/></svg>'],
    ["two colons in a name", '<svg xmlns:a="urn:x"><g a:b:c="1"/></svg>'],
    ["empty local name", '<svg xmlns:a="urn:x"><g a:="1"/></svg>'],
    ["XHTML default namespace on an inner element", '<svg><g xmlns="http://www.w3.org/1999/xhtml"><style>p{}</style></g></svg>'],
    ["XHTML default namespace on the root", '<svg xmlns="http://www.w3.org/1999/xhtml"><g/></svg>'],
    ["undeclaring the default namespace", '<svg xmlns=""><g/></svg>'],
    ["rebinding xml", '<svg xmlns:xml="urn:x"><g/></svg>'],
    ["declaring xmlns", '<svg xmlns:xmlns="urn:x"><g/></svg>'],
    ["empty prefixed declaration", '<svg xmlns:a=""><g/></svg>'],
    ["a prefix bound to the xml namespace", '<svg xmlns:a="http://www.w3.org/XML/1998/namespace"><g/></svg>'],
    ["an inner prefix declaration", '<svg><g xmlns:a="urn:x" a:b="1"/></svg>'],
    // Plan review I2: an xml:base alias through a prefix bound to the XML namespace.
    ["an xml:base alias", '<svg xmlns:p="http://www.w3.org/XML/1998/namespace"><g p:base="http://e.example/"/></svg>'],
    ["xlink with the wrong namespace", '<svg xmlns:xlink="urn:x"><use xlink:href="#a"/></svg>'],
    ["a reference inside xmlns", '<svg xmlns="http://www.w3.org/2000/sv&#x67;"><g/></svg>'],
    ["xlink:base", '<svg><use xlink:base="http://e.example/" xlink:href="#a"/></svg>'],
    // Plan review I1: names the HTML parser fixed up, the XML parser does not.
    ["lower-case linearGradient", '<svg><lineargradient id="g"><stop offset="0"/></lineargradient></svg>'],
    ["lower-case viewBox", '<svg viewbox="0 0 1 1"><g/></svg>'],
    ["upper-case root", "<SVG><g/></SVG>"],
    ["mixed-case plain element", "<svg><Rect/></svg>"],
    ["mixed-case plain attribute", '<svg><rect Fill="red"/></svg>'],
    ["camelCase filter in the wrong case", '<svg><filter id="f"><fegaussianblur stdDeviation="2"/></filter></svg>'],
    ["too deep", "<svg>" + "<g>".repeat(300) + "</g>".repeat(300) + "</svg>"],
  ];
  for (const [label, svg] of cases) {
    assert.equal(xmlSvg(svg), null, `${label}: xmlSvg refuses`);
    const e = await errOf(renderVersion("diagram", { svg }));
    assert.ok(e, `${label}: save refused`);
    assert.equal(e.code, "bad_source", label);
    assert.ok(Object.values(XML_MESSAGES).includes(e.message) || e.message.startsWith("svg must be plain SVG"), `${label}: a fixed message, got ${e.message}`);
    assert.ok(!e.message.includes(svg), `${label}: input never echoed`);
  }
});

test("renderer output must be well-formed too: a renderer SVG the XML parser would refuse fails the save as render_failed", async () => {
  const e = await errOf(renderVersion("diagram", { engine: "mermaid", source: "flowchart LR\n A-->B" }, kitWith(`<svg xmlns="${SVG_NS}"><rect width="1" width="2"/></svg>`)));
  assert.equal(e.code, "render_failed");
  assert.ok(!e.message.includes("width"));
});

test("real renderer output (mermaid, d2, vega-lite) passes unchanged and wraps to strict XML", async () => {
  assert.ok(CORPUS.length >= 25, "one item per Mermaid type, D2 shape families, Vega-Lite marks");
  for (const item of CORPUS) {
    assert.equal(xmlSvg(item.svg), item.svg, `${item.engine}: already explicit, so unchanged`);
    const r = await renderVersion("diagram", { engine: item.engine, source: item.source }, kitWith(item.svg));
    const f = indexOf(r);
    assert.equal(f.contentType, XHTML);
    const { doc, errs } = parseXml(f.body.toString("utf8"));
    assert.deepEqual(errs, [], item.engine);
    assert.equal(doc.getElementsByTagName("svg")[0].namespaceURI, SVG_NS, item.engine);
    assert.equal(r.files.find((x) => x.path === "__render/diagram.svg").body.toString("utf8"), item.svg, "the render cache keeps the renderer's SVG");
  }
});

test("font libs: the XHTML wrapper self-closes its <link/> and stays strict XML", async () => {
  const design = { kit: async () => ({ themes: new Map(), resolve: () => ({ files: [{ path: "__lib/font/x/font.css", body: Buffer.from("x"), contentType: "text/css" }], refs: ["font:x"], entries: [{ kind: "font", main: "__lib/font/x/font.css", family: "X & Y", fallback: "serif" }] }), render: async () => "" }) };
  const r = await renderVersion("diagram", { svg: '<svg><text>a</text></svg>', libs: ["font:x"] }, { design });
  const text = indexOf(r).body.toString("utf8");
  assert.match(text, /<link rel="stylesheet" href="__lib\/font\/x\/font\.css"\/>/);
  assert.deepEqual(parseXml(text).errs, []);
});

test("documents and pages are unchanged: still text/html", async () => {
  const { markdownBlocks } = await import("../servers/blog/renderer.js");
  assert.equal(indexOf(await renderVersion("document", { markdown: "# a" }, { markdownBlocks })).contentType, "text/html; charset=utf-8");
  assert.equal(indexOf(await renderVersion("page", { html: "<p>x</p>" })).contentType, "text/html; charset=utf-8");
});
