// Artifacts × Design kit (spec §4.2, §4.5, §6; §4.3 as amended 2026-10-15):
// with the kit, specs render to sanitized SVG on save and the spec is kept; a
// renderer that answers with a failure saves nothing; a renderer that is down
// leaves fences as code with a note; without the kit, fences are code exactly
// as today.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import { renderVersion, KIT_MISSING, RENDERER_DOWN_NOTE, hasExternalRef, checkRenderedSvg } from "../bundles/artifacts/server/render.js";
import { _overrideLimitsForTest } from "../bundles/artifacts/server/limits.js";
import { openKit, kitError } from "../bundles/design-kit/server/kit.js";

const KIT_DIR = new URL("../bundles/design-kit", import.meta.url).pathname;
const SVG = '<svg viewBox="0 0 10 10"><rect id="n1" width="5" height="5"><title>Node one</title></rect></svg>';
const s = { calls: [] };
let answer = async () => SVG;
const fakeKit = { themes: new Map(), resolve: () => ({ files: [], refs: [], entries: [] }), render: async (engine, src, opts) => { s.calls.push([engine, src, opts && opts.timeoutMs]); return answer(engine, src); } };
const deps = { markdownBlocks, design: { kit: async () => fakeKit } };
const noKit = { markdownBlocks, design: { kit: async () => null } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return { code: e.code, message: e.message, retryable: e.retryable }; } };
const bot = { kind: "bot", id: "bobby" };

before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "art-design-specs-"));
  s.db = createDbClient(join(s.home, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.home, "blobs"));
});
after(() => { try { s.db.close(); } catch {} rmSync(s.home, { recursive: true, force: true }); });

const MD = "# Plan\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.";

test("kit absent: fences render as code, byte-identical to today (Review Focus 1)", async () => {
  const today = await renderVersion("document", { markdown: MD }, { markdownBlocks });
  const r = await renderVersion("document", { markdown: MD }, noKit);
  assert.equal(r.files[0].body.toString(), today.files[0].body.toString());
  assert.equal(r.files.length, today.files.length, "no __render files");
  assert.equal(r.design, null, "no note: this is today's behaviour, not a failure");
  assert.equal((await errOf(renderVersion("diagram", { engine: "d2", source: "a -> b" }, noKit))).code, "kit_missing", "explicit kit features are still refused");
  assert.match(KIT_MISSING, /^the Design kit extension isn't installed/);
});

test("a fenced spec becomes an image of the stored SVG; the spec stays in the source", async () => {
  s.calls = [];
  answer = async () => SVG;
  const src = { markdown: MD };
  const r = await renderVersion("document", src, deps);
  assert.deepEqual(s.calls.map((c) => c.slice(0, 2)), [["mermaid", "flowchart LR\n  A --> B"]]);
  assert.ok(s.calls[0][2] > 0 && s.calls[0][2] <= 60000, "the call carries the remaining save deadline");
  const svg = r.files.find((f) => f.path === "__render/b2.svg");
  assert.equal(svg.contentType, "image/svg+xml");
  assert.match(svg.body.toString(), /^<svg/);
  const index = JSON.parse(r.files.find((f) => f.path === "__render/index.json").body.toString());
  assert.equal(index.items.length, 1);
  assert.match(index.items[0].key, /^mermaid:[0-9a-f]{64}$/);
  const html = r.files[0].body.toString();
  assert.ok(html.includes('<div class="blk" id="b2"><figure class="spec"><img src="__render/b2.svg" alt="Mermaid diagram"></figure></div>'));
  assert.ok(html.includes("figure.spec"), "spec CSS added only when a spec exists");
  assert.deepEqual(r.anchorMap.blocks.map((b) => b.id), ["b1", "b2", "b3"], "block anchors unchanged");
  assert.equal(r.anchorMap.blocks[1].plain, "Mermaid diagram", "a spec block's quote anchor is its alt text (review L7)");
  assert.equal(src.markdown, MD, "the spec is kept (source unchanged)");
  assert.deepEqual(r.design, { libs: [], house_style: null, rendered: 1, notes: [] });
});

test("text fence is never rendered", async () => {
  s.calls = [];
  const r = await renderVersion("document", { markdown: "```text\nflowchart LR\n  A --> B\n```" }, deps);
  assert.deepEqual(s.calls, []);
  assert.ok(!r.files.some((f) => f.path.startsWith("__render/")));
  assert.ok(!r.files[0].body.toString().includes("figure.spec"));
});

test("renderer down: fences stay code, the save succeeds with a note; {engine, source} is a retryable refusal", async () => {
  answer = async () => { throw kitError("render_unavailable", { retryable: true }); };
  const r = await renderVersion("document", { markdown: MD + "\n\n```d2\na -> b\n```" }, deps);
  assert.ok(!r.files.some((f) => f.path.endsWith(".svg")));
  assert.ok(r.files[0].body.toString().includes("flowchart LR"), "shown as code");
  assert.deepEqual(r.design.notes, [RENDERER_DOWN_NOTE]);
  assert.equal(r.design.rendered, 0);
  assert.match(RENDERER_DOWN_NOTE, /renderer is unavailable.*shown as code.*later/i);
  assert.deepEqual(await errOf(renderVersion("diagram", { engine: "d2", source: "a -> b" }, deps)),
    { code: "render_unavailable", message: "the chart and diagram renderer is not answering; try again in a minute", retryable: true });
});

test("the 60 s save deadline: later fences fall back to code instead of waiting", async () => {
  const restore = _overrideLimitsForTest({ saveRenderMs: 300 });
  try {
    s.calls = [];
    answer = async () => { await new Promise((r) => setTimeout(r, 200)); return SVG; };
    const md = ["```mermaid\nflowchart LR\n A-->B\n```", "```mermaid\nflowchart LR\n C-->D\n```", "```mermaid\nflowchart LR\n E-->F\n```"].join("\n\n");
    const t0 = Date.now();
    const r = await renderVersion("document", { markdown: md }, deps);
    assert.ok(Date.now() - t0 < 1000, "bounded by the deadline");
    assert.ok(r.design.rendered >= 1 && r.design.rendered < 3);
    assert.deepEqual(r.design.notes, [RENDERER_DOWN_NOTE]);
  } finally { restore(); }
});

test("cache: an unchanged spec is not re-rendered on the next version, nor twice in one save", async () => {
  answer = async () => SVG;
  const made = await store.createArtifact(s.db, s.blobs, { title: "Doc", type: "document", source: { markdown: MD + "\n\n```mermaid\nflowchart LR\n  A --> B\n```" }, actor: bot }, deps);
  s.calls = [];
  await store.addVersion(s.db, s.blobs, { artifactId: made.id, source: { markdown: MD.replace("After.", "After, fixed.") }, actor: bot }, deps);
  assert.deepEqual(s.calls, [], "the base version's render was reused");
  s.calls = [];
  await renderVersion("document", { markdown: MD + "\n\n" + MD }, deps);
  assert.equal(s.calls.length, 1, "duplicate fences in one save render once");
});

test("a rendered diagram uses the existing diagram path and anchors", async () => {
  answer = async () => SVG;
  const r = await renderVersion("diagram", { engine: "d2", source: "a -> b" }, deps);
  assert.match(r.files[0].body.toString(), /<svg viewBox="0 0 10 10">/);
  assert.deepEqual(r.anchorMap.elements, [{ id: "n1", tag: "rect", title: "Node one" }]);
  assert.equal(r.anchorMap.aspect, 1);
  assert.equal((await errOf(renderVersion("diagram", { engine: "d2" }, deps))).code, "bad_source");
});

test("a renderer that answers with a failure saves nothing and says only engine, category and line", async () => {
  answer = async () => { throw kitError("render_failed", { category: "parse error", line: 2 }); };
  const n0 = Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] })).rows[0].n);
  assert.deepEqual(await errOf(store.createArtifact(s.db, s.blobs, { title: "x", type: "document", source: { markdown: MD }, actor: bot }, deps)),
    { code: "render_failed", message: "mermaid: parse error at line 2", retryable: undefined });
  assert.equal(Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] })).rows[0].n), n0);
  answer = async () => { throw Object.assign(kitError("render_failed", { category: "SENTINEL-CAT-12", line: 7 }), { message: "SENTINEL-MSG-12" }); };
  assert.equal((await errOf(renderVersion("document", { markdown: MD }, deps))).message, "mermaid: render error at line 7");
  answer = async () => "<svg>" + "x".repeat(2 * 1024 * 1024) + "</svg>";
  assert.equal((await errOf(renderVersion("document", { markdown: MD }, deps))).code, "render_too_large");
});

test("hostile renderer output is refused; fragments and data: fonts are fine (incl. review L3 bypasses)", async () => {
  const bad = [
    "<svg><script>alert(1)</script></svg>", "<svg><foreignObject><div/></foreignObject></svg>", '<svg><rect onload="x()"/></svg>',
    '<svg><a href="https://evil.example"><text>x</text></a></svg>', '<svg><image xlink:href="http://evil.example/i.png"/></svg>',
    '<svg><image href = "http://evil.example/i.png"/></svg>', '<svg><rect style="fill:url(https://evil.example/p)"/></svg>',
    "<svg><style>@import 'https://evil.example/x.css';</style></svg>", '<svg><image href=https://evil.example/i.png /></svg>',
    '<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>', '<svg><style>rect{fill:\\75 rl(https://evil.example)}</style></svg>',
    '<svg><rect style="background:image-set(\'https://evil.example/a.png\' 1x)"/></svg>', '<svg><style>@font-face{src:src("https://evil.example/f")}</style></svg>',
    '<svg><set attributeName="href" to="https://evil.example"/></svg>', '<svg><animate attributeName="href" values="https://evil.example"/></svg>',
  ];
  for (const svg of bad) {
    answer = async () => svg;
    assert.equal((await errOf(renderVersion("document", { markdown: MD }, deps))).code, "render_failed", svg);
  }
  answer = async () => '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/><style>@font-face{src:url( "data:font/woff2;base64,AA")}</style></svg>';
  assert.ok(await renderVersion("document", { markdown: MD }, deps));
  assert.equal(hasExternalRef('<a href="#x">'), false);
  assert.equal(hasExternalRef("<a href='//x'>"), true);
  assert.equal(hasExternalRef('<image href\n=\n"http://x">'), true);
  // Accepted false positive (review L3): text that looks like an event attribute is refused.
  answer = async () => "<svg><text>Sales online = 40%</text></svg>";
  assert.equal((await errOf(renderVersion("document", { markdown: MD }, deps))).code, "render_failed");
});

test("too many specs, and bad specs refused before any render", async () => {
  answer = async () => "<svg></svg>";
  const many = Array.from({ length: 13 }, (_, i) => `\`\`\`d2\na${i} -> b\n\`\`\``).join("\n\n");
  assert.deepEqual(await errOf(renderVersion("document", { markdown: many }, deps)), { code: "too_many_specs", message: "at most 12 charts and diagrams per document", retryable: undefined });
  assert.ok(await renderVersion("document", { markdown: many }, noKit), "without the kit they are just code");
  let sent = 0;
  const real = openKit(KIT_DIR, { fetchImpl: async () => { sent++; return { status: 200, json: async () => ({ svg: "<svg/>" }) }; } });
  const realDeps = { markdownBlocks, design: { kit: async () => real } };
  assert.deepEqual(await errOf(renderVersion("document", { markdown: "```vega-lite\n{\"data\":{\"url\":\"https://evil.example/d.csv\"},\"mark\":\"bar\"}\n```" }, realDeps)),
    { code: "bad_spec", message: "vega-lite: Vega-Lite data must be inline (data.values); url and href are not allowed", retryable: undefined });
  assert.equal((await errOf(renderVersion("diagram", { engine: "mermaid", source: "flowchart LR\n A-->B\n click A href \"x\"" }, realDeps))).message, "mermaid: links and click handlers are not allowed");
  assert.equal((await errOf(renderVersion("diagram", { engine: "d2", source: "x: { icon: /etc/hostname }" }, realDeps))).message, "d2: icons are not allowed");
  assert.equal((await errOf(renderVersion("diagram", { engine: "mermaid", source: "quadrantChart\n title x" }, realDeps))).message, "mermaid: this diagram type is not supported (the design-frontend skill lists the supported types)");
  assert.equal((await errOf(renderVersion("diagram", { engine: "graphviz", source: "x" }, realDeps))).message, "spec: unknown engine (use vega-lite, mermaid or d2)");
  assert.equal(sent, 0);
});

// Task 8 review: <style> contents, CSS url(), escaped at-rules and character
// references are checked too; Task 6 review: links in rendered SVG are inert
// because no <a> (or any element outside the SVG allowlist) is ever stored.
test("rendered SVG fails closed: CSS, escapes, references, links and stray markup", () => {
  const refused = (svg) => { try { checkRenderedSvg(svg); return null; } catch (e) { return e.code; } };
  const bad = [
    "<svg><style>rect{fill:url(https://evil.example/p)}</style></svg>",
    "<svg><style>rect{fill:url( 'https://evil.example/p')}</style></svg>",
    "<svg><style>@\\69mport 'x.css';</style></svg>",
    "<svg><style><![CDATA[@\\69mport 'x.css';]]></style></svg>",
    "<svg><style><![CDATA[@import 'x.css';]]></style></svg>",
    "<svg><style>@font-face{src:url(data:image/svg+xml;base64,PHN2Zz4=)}</style></svg>",
    "<svg><style>a{b:url(data:text/html,x)}</style></svg>",
    '<svg><rect style="fill:u&#114;l(https://evil.example/p)"/></svg>',
    '<svg><rect style="fill:u&#x72;l(https://evil.example/p)"/></svg>',
    "<svg><style>&#64;import 'https://evil.example/x.css';</style></svg>",
    '<svg><rect style="fill:url&lpar;https://evil.example/p)"/></svg>',
    '<svg><rect fill="url(https://evil.example/p#g)"/></svg>',
    '<svg><rect filter="url(//evil.example/f)"/></svg>',
    '<svg><rect style="fill:red\\;x"/></svg>',
    '<svg><a href="#n1"><text>x</text></a></svg>',
    '<svg><a xlink:href="#n1"><text>x</text></a></svg>',
    '<svg><A HREF="https://evil.example"><text>x</text></A></svg>',
    '<svg><svg:a href="#n1"><text>x</text></svg:a></svg>',
    "<svg><a/></svg>",
    '<svg><use href="other.svg#g"/></svg>',
    '<svg><image href="#g"/></svg>',
    '<svg><filter><feImage href="#g"/></filter></svg>',
    "<svg><!-- x --></svg>",
    "<svg><![CDATA[x]]></svg>",
    "<svg><?php x ?></svg>",
    "<svg></svg><img src=https://evil.example/i.png><svg></svg>",
    "<svg><iframe></iframe></svg>",
    "<svg><style>a{}</svg>",
    "<svg><animateTransform attributeName=\"transform\"/></svg>",
    // An unquoted value with a stray quote: an HTML parser (the inlined
    // diagram) would see the iframe the quote seems to hide.
    "<svg><rect x=a'b><iframe src=https://evil.example/></iframe><rect y='/></svg>",
    "<svg><rect x=a'b><b>x</b><rect y='/></svg>", "<svg><rect x='a'b'/></svg>", "<svg><rect x=1/></svg>", "<svg><rect x=\"1\\\"/></svg>",
  ];
  for (const svg of bad) assert.equal(refused(svg), "render_failed", svg);
  // What real renderers emit is fine: CDATA style with a data: font (D2),
  // @keyframes (Mermaid), XML references in text, mixed-case element names.
  const good = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style type="text/css"><![CDATA[@font-face{font-family:f;src:url("data:application/font-woff;base64,AA")}.a > .b{fill:url(#g)}]]></style><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect/></clipPath></defs><g clip-path="url(#c)"><text>a &lt; b &amp; c &quot;d&quot; &#x2014;</text></g></svg>',
    "<svg><style>@keyframes dash{to{stroke-dashoffset:0}}#m .edge{animation:dash 1s}</style><marker id=\"m\"><path d=\"M0 0\"/></marker></svg>",
    '<?xml version="1.0" encoding="utf-8"?>\n<svg><text>İstanbul ſ K</text></svg>',
  ];
  for (const svg of good) assert.ok(checkRenderedSvg(svg).startsWith("<svg"), svg);
});

test("a cached render is re-checked before reuse; a rendered diagram's hostile output is refused", async () => {
  s.calls = [];
  answer = async () => SVG;
  const key = "mermaid:" + (await import("node:crypto")).createHash("sha256").update("flowchart LR\n  A --> B").digest("hex");
  const r = await renderVersion("document", { markdown: MD }, { ...deps, priorRenders: new Map([[key, '<svg><a href="https://evil.example"><text>x</text></a></svg>']]) });
  assert.equal(s.calls.length, 1, "the bad cache entry was ignored and the spec rendered again");
  assert.equal(r.files.find((f) => f.path === "__render/b2.svg").body.toString(), SVG);
  answer = async () => '<svg viewBox="0 0 1 1"><a href="#n1"><rect id="n1"/></a></svg>';
  assert.equal((await errOf(renderVersion("diagram", { engine: "mermaid", source: "flowchart LR\n A-->B" }, deps))).code, "render_failed");
  answer = async () => SVG;
  const d = await renderVersion("diagram", { engine: "d2", source: "a -> b" }, deps);
  assert.deepEqual(d.files.map((f) => f.path), ["index.html", "__render/diagram.svg", "__render/index.json"]);
  assert.deepEqual(d.design, { libs: [], house_style: null, rendered: 1, notes: [] });
});

// Ruling F2: real Mermaid, Vega-Lite and D2 output passes checkRenderedSvg.
// LIVE only: CROW_DESIGN_RENDER_LIVE=1 and an explicit CROW_DESIGN_RENDER_URL
// (the smoke instance), never the prod renderer on 8018 (review L6).
const LIVE_URL = process.env.CROW_DESIGN_RENDER_URL || "";
const liveOn = process.env.CROW_DESIGN_RENDER_LIVE === "1" && /^http:\/\/127\.0\.0\.1:\d+$/.test(LIVE_URL) && !LIVE_URL.endsWith(":8018");
const liveUp = liveOn && await fetch(LIVE_URL + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
const LIVE_EXAMPLES = [
  ["mermaid", "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| D[Retry<br>later]\n  subgraph S [Group]\n    C\n  end"],
  ["mermaid", "graph TD\n  A --> B"],
  ["mermaid", "sequenceDiagram\n  participant A\n  A->>B: hi\n  Note right of B: note\n  loop Every day\n    B-->>A: ok\n  end"],
  ["mermaid", "classDiagram\n  class A {\n    +int x\n    +go() bool\n  }\n  <<interface>> A\n  A <|-- B"],
  ["mermaid", "stateDiagram\n  [*] --> S\n  S --> [*]"],
  ["mermaid", "stateDiagram-v2\n  [*] --> S\n  state fork_state <<fork>>\n  S --> fork_state"],
  ["mermaid", "erDiagram\n  A ||--o{ B : has\n  A {\n    string name\n  }"],
  ["mermaid", "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section S\n  T :t1, 2026-01-01, 3d\n  U :after t1, 2d"],
  ["mermaid", "pie title Pets\n  \"a\" : 1\n  \"b\" : 2"],
  ["mermaid", "timeline\n  title History\n  2026 : start : more\n  2027 : next"],
  ["mermaid", "mindmap\n  root((Root))\n    child\n      leaf\n    other"],
  ["vega-lite", JSON.stringify({ title: "Sales", data: { values: [{ a: "x", b: 1 }, { a: "y", b: 3 }] }, mark: "bar", encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" }, tooltip: { field: "b" } } })],
  ["vega-lite", JSON.stringify({ data: { values: [{ t: "2026-01-01", v: 1, s: "a" }, { t: "2026-02-01", v: 3, s: "a" }, { t: "2026-01-01", v: 2, s: "b" }] }, mark: { type: "line", point: true }, encoding: { x: { field: "t", type: "temporal" }, y: { field: "v", type: "quantitative" }, color: { field: "s", type: "nominal" } } })],
  ["vega-lite", JSON.stringify({ data: { values: [{ c: "a < b & c", v: 4 }, { c: "z", v: 6 }] }, mark: { type: "arc", innerRadius: 30 }, encoding: { theta: { field: "v", type: "quantitative" }, color: { field: "c", type: "nominal" } } })],
  ["vega-lite", JSON.stringify({ data: { values: [{ a: 1, b: 2 }, { a: 2, b: 5 }] }, mark: { type: "area", color: { x1: 1, y1: 1, x2: 1, y2: 0, gradient: "linear", stops: [{ offset: 0, color: "white" }, { offset: 1, color: "darkgreen" }] } }, encoding: { x: { field: "a", type: "quantitative" }, y: { field: "b", type: "quantitative" } } })],
  ["d2", "a -> b: hello\nb -> c"],
  ["d2", "server: Web server { shape: cylinder }\nq: Queue { shape: queue }\nserver -> q: jobs\nu: User { shape: person }\nu -> server"],
  ["d2", "cloud: Cloud {\n  api -> db\n}\nclient -> cloud.api: calls\nclient.style.fill: \"#eef\""],
  ["d2", "users: {\n  shape: sql_table\n  id: int {constraint: primary_key}\n  name: text\n}\nposts: {\n  shape: sql_table\n  user_id: int {constraint: foreign_key}\n}\nposts.user_id -> users.id"],
  ["d2", "shape: sequence_diagram\nalice -> bob: hello\nbob -> alice: hi"],
  ["d2", "C: {\n  shape: class\n  +name: string\n  +go(): bool\n}"],
];
test("LIVE: real Mermaid, Vega-Lite and D2 output passes checkRenderedSvg, end to end (ruling F2)", { skip: liveUp ? false : "set CROW_DESIGN_RENDER_LIVE=1 and CROW_DESIGN_RENDER_URL to the smoke instance", timeout: 300000 }, async () => {
  const real = openKit(KIT_DIR, { renderUrl: LIVE_URL });
  const failed = [];
  for (const [engine, src] of LIVE_EXAMPLES) {
    try { checkRenderedSvg(await real.render(engine, src)); } catch (e) { failed.push(`${engine} ${JSON.stringify(src.slice(0, 30))}: ${e.code} ${e.message}`); }
  }
  assert.deepEqual(failed, []);
  const md = LIVE_EXAMPLES.slice(0, 12).map(([e, src]) => "```" + e + "\n" + src + "\n```").join("\n\n");
  const r = await renderVersion("document", { markdown: md }, { markdownBlocks, design: { kit: async () => real } });
  assert.deepEqual(r.design, { libs: [], house_style: null, rendered: 12, notes: [] });
  const d = await renderVersion("diagram", { engine: "d2", source: LIVE_EXAMPLES.at(-2)[1] }, { markdownBlocks, design: { kit: async () => real } });
  assert.equal(d.design.rendered, 1);
});

// Fix round 1: HTML-tokenizer differentials (the diagram path inlines the SVG
// into HTML; the CSP contains these, the checker must fail closed on its own).
test("fix round 1: attribute grammar follows the HTML tokenizer, fail closed", () => {
  const refused = (svg) => { try { checkRenderedSvg(svg); return null; } catch (e) { return e.code; } };
  const bad = [
    '<svg><rect x="1"onload="alert(1)"/></svg>',
    '<svg><rect\fonload="alert(1)"/></svg>',
    '<svg><rect x="1"\fonload="alert(1)"/></svg>',
    "<svg><rect =\"a><div><video poster='https://evil.example/p.png'></video></div>\"/></svg>",
    "<svg><rect =\"a><meta http-equiv='refresh' content='0;url=https://evil.example/'>\"/></svg>",
    "<svg><rect =\"a><table background='https://evil.example/t.png'></table>\"/></svg>",
    '<svg><rect x="1" ="2"/></svg>',
    '<svg><rect x="1"y="2"/></svg>',
    '<svg><rect 1x="1"/></svg>',
    '<svg><rect x/></svg>',
    '<svg><rect x="1" / y="2"/></svg>',
    '<svg><rect ONLOAD="x()"/></svg>',
    '<svg><rect onbegin="x()"/></svg>',
    '<svg><rect x="a<b"/></svg>',
    '<svg xml:base="https://evil.example/"><use href="#g"/></svg>',
    '<svg><g></g x="1"></svg>',
    '<svg><style>a{b:url(data:font/woff2)}</style></svg>', '<svg><style>a{b:url(data:image/png+svg,AA)}</style></svg>',
    '<svg><style>a{b:url(data:image/pngx,AA)}</style></svg>',
    '<svg><style>a{b:url(data:application/font-woff)}</style></svg>',
  ];
  for (const svg of bad) assert.equal(refused(svg), "render_failed", JSON.stringify(svg));
  const good = [
    '<svg viewBox="0 0 1 1"><rect x="1" y=\'2\' class="a b"/><g\ttransform="x"\n></g ></svg>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#g" data-et_al="1"/><text x="1">a > b</text></svg>',
    '<svg><style>a{b:url(data:font/woff2;base64,AA)}c{d:url("data:image/png,AA")}e{f:url(data:application/font-woff;base64,AA)}</style></svg>',
  ];
  for (const svg of good) assert.ok(checkRenderedSvg(svg).startsWith("<svg"), svg);
});

test("fix round 1: a non-retryable unavailable (not_loopback) stays non-retryable; text fixed", async () => {
  answer = async () => { throw kitError("render_unavailable", { reason: "not_loopback", retryable: false }); };
  assert.deepEqual(await errOf(renderVersion("diagram", { engine: "d2", source: "a -> b" }, deps)),
    { code: "render_unavailable", message: "the chart and diagram renderer is not answering; try again in a minute", retryable: false });
  const r = await renderVersion("document", { markdown: MD }, deps);
  assert.deepEqual(r.design.notes, [RENDERER_DOWN_NOTE], "a document still falls back to code");
  answer = async () => SVG;
});

