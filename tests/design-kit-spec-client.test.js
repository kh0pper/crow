// Design kit (spec §3.3, §4.2, §6): specs are checked BEFORE any render, and the
// client turns every renderer answer into a fixed, short, retry-aware error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openKit, guardSpec, makeRenderClient, MERMAID_TYPES } from "../bundles/design-kit/server/kit.js";

const KIT = new URL("../bundles/design-kit", import.meta.url).pathname;
const reason = (engine, source) => { try { guardSpec(engine, source); return null; } catch (e) { return e.code === "bad_spec" ? e.reason : e.code; } };
const reply = (status, body) => async () => ({ status, json: async () => { if (body === undefined) throw new Error("not json"); return body; } });
const err = async (p) => { try { await p; return null; } catch (e) { return { code: e.code, category: e.category, line: e.line, retryable: e.retryable, reason: e.reason, message: e.message }; } };

test("guardSpec: Vega-Lite data must be inline; url and href are refused at any depth", () => {
  assert.equal(reason("vega-lite", JSON.stringify({ data: { values: [{ a: 1 }] }, mark: "bar" })), null);
  assert.equal(reason("vega-lite", JSON.stringify({ data: { url: "https://evil.example/d.csv" }, mark: "bar" })), "external_data");
  assert.equal(reason("vega-lite", JSON.stringify({ layer: [{ data: { url: "x.csv" } }] })), "external_data");
  assert.equal(reason("vega-lite", JSON.stringify({ encoding: { href: { field: "u" } } })), "external_data");
  assert.equal(reason("vega-lite", JSON.stringify({ data: { values: [{ url: "https://example.com/a", n: 1 }] }, mark: "bar" })), null, "a data column named url is data, not a fetch (review L10)");
  assert.equal(reason("vega-lite", JSON.stringify({ datasets: { d: [{ href: "x" }] }, data: { name: "d" }, mark: "bar" })), null);
  assert.equal(reason("vega-lite", "{not json"), "not_json");
  let deep = { values: [] }; for (let i = 0; i < 80; i++) deep = { a: deep };
  assert.equal(reason("vega-lite", JSON.stringify(deep)), "too_deep");
});

test("guardSpec: Mermaid click lines, directives and front-matter config are refused", () => {
  assert.equal(reason("mermaid", "flowchart LR\n  A --> B"), null);
  assert.equal(reason("mermaid", "flowchart LR\n  A --> B\n  click A href \"https://evil.example\""), "links");
  assert.equal(reason("mermaid", "%%{init: {'securityLevel':'loose'}}%%\nflowchart LR\n A-->B"), "directives");
  assert.equal(reason("mermaid", "---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A-->B"), "directives");
  assert.equal(reason("mermaid", "%% a comment\nsequenceDiagram\n  A->>B: hi"), null);
  assert.equal(reason("mermaid", "quadrantChart\n  title x"), "unsupported_type", "types outside MERMAID_TYPES are refused up front (review M7)");
});

test("guardSpec: D2 imports and remote icons or links are refused", () => {
  assert.equal(reason("d2", "a -> b: hello"), null);
  assert.equal(reason("d2", "x: @shapes"), "imports");
  assert.equal(reason("d2", "...@base"), "imports");
  assert.equal(reason("d2", "x: { icon: https://evil.example/i.svg }"), "icons");
  assert.equal(reason("d2", "x: { link: \"http://evil.example\" }"), "links");
  assert.equal(reason("d2", "x: { icon: /etc/hostname }"), "icons", "no icons at all: D2 would read local files (review L4)");
  assert.equal(reason("d2", "x.icon: ./a.svg"), "icons");
  // Task 8 fix: the renderer refuses any "icon" substring (D2 0.9.0 reads a
  // local icon even with --bundle=false), so the guard refuses the same and
  // the bot is told why instead of getting an unexplained "invalid spec".
  for (const s of ["a -> b: Silicon wafer", "lexicon -> b", "x: iconic", "ICONS: a"]) assert.equal(reason("d2", s), "icons", s);
});

test("guardSpec: engine, empty and size", () => {
  assert.equal(reason("graphviz", "digraph{}"), "engine");
  assert.equal(reason("mermaid", "   "), "empty");
  assert.equal(reason("mermaid", "flowchart LR\n" + "A-->B\n".repeat(12000)), "too_large");
});

test("render client: ok, unavailable, too large, failed — and never the server's text", async () => {
  const c = (impl) => makeRenderClient({ url: "http://127.0.0.1:8018", fetchImpl: impl });
  assert.equal(await c(reply(200, { svg: "<svg></svg>" }))("mermaid", "x"), "<svg></svg>");
  assert.deepEqual(await err(c(async () => { throw new TypeError("fetch failed"); })("mermaid", "x")), { code: "render_unavailable", category: undefined, line: undefined, retryable: true, reason: undefined, message: "the renderer is not answering" });
  assert.equal((await err(c(reply(503, { error: { code: "busy" } }))("mermaid", "x"))).code, "render_unavailable");
  assert.equal((await err(c(reply(502, undefined))("mermaid", "x"))).code, "render_unavailable");
  assert.equal((await err(c(reply(200, { svg: "<svg>" + "x".repeat(2 * 1024 * 1024) + "</svg>" }))("mermaid", "x"))).code, "render_too_large");
  assert.equal((await err(c(reply(422, { error: { code: "too_large", category: "output" } }))("mermaid", "x"))).code, "render_too_large");
  assert.equal((await err(c(reply(413, { error: { code: "too_large", category: "input" } }))("mermaid", "x"))).reason, "too_large");
  const f = await err(c(reply(422, { error: { code: "render_failed", category: "parse error", line: 3 } }))("mermaid", "x"));
  assert.deepEqual([f.code, f.category, f.line], ["render_failed", "parse error", 3]);
  const s = await err(c(reply(422, { error: { code: "render_failed", category: "SENTINEL-CAT", line: "SENTINEL-LINE", message: "SENTINEL-MSG" } }))("mermaid", "x"));
  assert.deepEqual([s.category, s.line], ["render error", null], "unknown category and non-integer line are dropped");
  assert.ok(!JSON.stringify(s).includes("SENTINEL"));
});

test("render client: a non-loopback URL never sends", async () => {
  let sent = false;
  const kit = openKit(KIT, { renderUrl: "http://192.0.2.10:8018", fetchImpl: async () => { sent = true; return { status: 200, json: async () => ({ svg: "<svg/>" }) }; } });
  const e = await err(kit.render("mermaid", "flowchart LR\n A-->B"));
  assert.equal(e.code, "render_unavailable");
  assert.equal(sent, false);
});

test("Kit.render guards before it sends", async () => {
  let sent = 0;
  const kit = openKit(KIT, { fetchImpl: async () => { sent++; return { status: 200, json: async () => ({ svg: "<svg/>" }) }; } });
  assert.equal((await err(kit.render("vega-lite", JSON.stringify({ data: { url: "x" } })))).reason, "external_data");
  assert.equal(sent, 0, "a refused spec never reaches the renderer");
  assert.equal(await kit.render("d2", "a -> b"), "<svg/>");
  assert.equal(sent, 1);
});

test("render client: misconfiguration answers (403 Host check, 415 content type, 404 wrong path) are unavailable, not failures (ruling F6)", async () => {
  const c = (impl) => makeRenderClient({ url: "http://127.0.0.1:8018", fetchImpl: impl });
  for (const status of [403, 404, 415]) {
    const e = await err(c(reply(status, { error: { code: "not_found", category: "parse error", line: 2 } }))("mermaid", "x"));
    assert.deepEqual([e.code, e.retryable], ["render_unavailable", true], `HTTP ${status}`);
    const plain = await err(c(reply(status, undefined))("mermaid", "x"));
    assert.equal(plain.code, "render_unavailable", `HTTP ${status} without JSON`);
  }
  assert.equal((await err(c(reply(200, { nope: 1 }))("mermaid", "x"))).code, "render_unavailable", "a 200 without an svg is a broken renderer");
});

test("render client: posts {engine, source} to /render with a per-call timeout signal", async () => {
  let seen;
  const c = makeRenderClient({ url: "http://localhost:8018", fetchImpl: async (u, init) => { seen = { u, init }; return { status: 200, json: async () => ({ svg: "<svg/>" }) }; } });
  assert.equal(await c("d2", "a -> b", { timeoutMs: 50 }), "<svg/>");
  assert.equal(seen.u, "http://localhost:8018/render");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { engine: "d2", source: "a -> b" });
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.equal(seen.init.redirect, "error", "the client never follows a redirect off loopback");
});

test("guardSpec: error messages never echo the spec", () => {
  const cases = [["vega-lite", JSON.stringify({ data: { url: "SENTINEL" } })], ["mermaid", "flowchart LR\n click SENTINEL href x"], ["d2", "SENTINEL: { icon: x }"], ["mermaid", "SENTINELchart\n a"]];
  for (const [engine, source] of cases) {
    try { guardSpec(engine, source); assert.fail("expected a refusal"); }
    catch (e) { assert.equal(e.code, "bad_spec"); assert.ok(!JSON.stringify({ ...e, message: e.message }).includes("SENTINEL")); }
  }
});

test("MERMAID_TYPES is one exported Set", () => {
  assert.ok(MERMAID_TYPES instanceof Set);
  assert.ok(MERMAID_TYPES.has("flowchart") && MERMAID_TYPES.has("sequencediagram"));
});

// ---- fix round 1 -----------------------------------------------------------

test("render client: maps by error code — only render_failed fails, too_large as before, everything else is unavailable", async () => {
  const c = (impl) => makeRenderClient({ url: "http://127.0.0.1:8018", fetchImpl: impl });
  const cases = [[400, { error: { code: "bad_request" } }], [400, { error: { code: "bad_engine" } }], [429, { error: { code: "busy" } }],
    [422, { error: { code: "busy" } }], [404, { error: { code: "not_found" } }], [422, { error: {} }], [422, {}], [422, { error: { code: "SENTINEL" } }],
    [400, { error: "render_failed" }]];
  for (const [status, body] of cases) {
    const e = await err(c(reply(status, body))("mermaid", "x"));
    assert.deepEqual([e.code, e.retryable], ["render_unavailable", true], JSON.stringify([status, body]));
    assert.ok(!JSON.stringify(e).includes("SENTINEL"));
  }
  const f = await err(c(reply(400, { error: { code: "render_failed", category: "invalid spec", line: 7 } }))("mermaid", "x"));
  assert.deepEqual([f.code, f.category, f.line], ["render_failed", "invalid spec", 7]);
});

test("render client: a non-loopback URL throws a fresh, non-retryable error on every call", async () => {
  let sent = false;
  const c = makeRenderClient({ url: "http://192.0.2.10:8018", fetchImpl: async () => { sent = true; return { status: 200, json: async () => ({ svg: "<svg/>" }) }; } });
  const a = await err(c("mermaid", "x")); const b = await err(c("mermaid", "x"));
  for (const e of [a, b]) assert.deepEqual([e.code, e.reason, e.retryable], ["render_unavailable", "not_loopback", false]);
  let e1, e2; try { await c("d2", "a"); } catch (e) { e1 = e; } try { await c("d2", "a"); } catch (e) { e2 = e; }
  assert.notEqual(e1, e2, "no shared mutable error object");
  e1.retryable = true; assert.equal((await err(c("d2", "a"))).retryable, false);
  assert.equal(sent, false);
  assert.equal((await err(makeRenderClient({ url: "http://127.0.0.1:8018/x", fetchImpl: async () => { sent = true; } })("d2", "a"))).reason, "not_loopback");
  assert.equal(sent, false);
});

test("guardSpec: Mermaid fails closed on links, callbacks and directives anywhere", () => {
  const probes = {
    "flowchart LR\n A-->B %%{init: {\"flowchart\":{\"htmlLabels\":true}}}%%": "directives",
    "flowchart LR\r A-->B\r click A href \"https://evil\"": "links",
    "flowchart LR\r\n A-->B\r\n click A call cb()": "links",
    "flowchart LR\n A-->B; click A href \"x\"": "links",
    "flowchart LR\n A-->B\n click\tA cb": "links",
    "flowchart LR\n A-->B\n CLICK A cb": "links",
    "classDiagram\n class A\n link A \"https://evil\"": "links",
    "classDiagram\n class A\n callback A \"fn\"": "links",
    "sequenceDiagram\n participant A\n link A: Dash @ https://evil": "links",
    "sequenceDiagram\n participant A\n links A: {\"Dash\": \"x\"}": "links",
    "flowchart LR\n A[\"<a href=x>y</a>\"]": "links",
    "flowchart LR\n A[\"<script>x</script>\"]": "links",
    "flowchart LR\n A[\"<iframe src=x>\"]": "links",
    "flowchart LR\n A[\"javascript:alert(1)\"]": "links",
    "flowchart LR\n A[\"see ftp://x\"]": "links",
    "---\ntitle: t\ninit: {}\n---\nflowchart LR\n A-->B": "directives",
    "---\ntitle: t\n---\n%% c\n\nquadrantChart\n x": "directives", // ruling 2026-10-15: no front matter at all
    "---\ntitle: t\nflowchart LR\n A-->B": "directives",
  };
  for (const [src, want] of Object.entries(probes)) assert.equal(reason("mermaid", src), want, JSON.stringify(src));
  assert.equal(reason("mermaid", "---\ntitle: My chart\n---\n\n%% note\nflowchart LR\n A-->B"), "directives", "ruling 2026-10-15: even title-only front matter is refused");
  assert.equal(reason("mermaid", "flowchart LR\r\n A-->B"), null);
  assert.equal(reason("mermaid", "flowchart LR\n A[linked list] --> B[clicker]"), null, "word boundaries: linked, clicker are words of their own");
});

test("guardSpec: D2 fails closed on icons, imports, links, vars, config and markup anywhere", () => {
  const probes = {
    "x: { \"icon\": https://evil/i.svg }": "icons",
    "x: { ICON: a }": "icons",
    "x: @\"a b\"": "imports",
    "x: [@y]": "imports",
    "@base": "imports",
    "x: '@y'": "imports",
    "link: //evil.example/x": "links",
    "x: see //evil.example": "links",
    "x: see https://evil.example": "links",
    "x: { import: a }": "imports",
    "vars: { a: 1 }": "directives",
    "x: d2-config": "directives",
    "x: |md # hi |": "markup",
    "x: ||md # hi ||": "markup",
    "x: |latex x^2 |": "markup",
    "x: |tex a |": "markup",
  };
  for (const [src, want] of Object.entries(probes)) assert.equal(reason("d2", src), want, JSON.stringify(src));
  assert.equal(reason("d2", "a -> b: mail me@example.org"), null, "an @ after a letter is not an import");
  assert.equal(reason("d2", "x: |go fmt.Println(1) |"), null, "code blocks are text");
});

test("guardSpec: Vega-Lite usermeta is refused and only data.values / top-level datasets are skipped", () => {
  assert.equal(reason("vega-lite", JSON.stringify({ usermeta: { embedOptions: { config: "https://evil/c.json" } }, mark: "bar" })), "external_data");
  assert.equal(reason("vega-lite", JSON.stringify({ layer: [{ usermeta: {} }] })), "external_data");
  assert.equal(reason("vega-lite", JSON.stringify({ values: { data: { url: "x" } } })), "external_data");
  assert.equal(reason("vega-lite", JSON.stringify({ layer: [{ datasets: { d: [{ url: "x" }] } }] })), "external_data", "datasets is skipped at the top level only");
  assert.equal(reason("vega-lite", JSON.stringify({ layer: [{ data: { values: [{ url: "x" }] }, mark: "bar" }] })), null, "a layer's inline data.values is still data");
});

test("guardSpec: refusals carry a fixed message per reason", () => {
  const m = (engine, src) => { try { guardSpec(engine, src); } catch (e) { return e.message; } return null; };
  assert.equal(m("mermaid", "flowchart LR\n click A x"), "links, callbacks and directives are not allowed in diagrams");
  assert.equal(m("mermaid", "%%{init:{}}%%\nflowchart LR"), "links, callbacks and directives are not allowed in diagrams");
  assert.notEqual(m("d2", "x: { icon: a }"), m("vega-lite", "{"));
  for (const msg of [m("d2", "x: { icon: a }"), m("d2", "x: @y"), m("vega-lite", "{"), m("mermaid", "pie2\n x")]) assert.ok(typeof msg === "string" && msg.length > 5);
});

// ---- fix round 2 -----------------------------------------------------------

test("guardSpec: Mermaid refuses every backslash (YAML escapes can spell config/init)", () => {
  const probes = [
    '---\n"\\x63onfig": {}\n---\nflowchart LR\n A-->B',
    '---\n"\\u0063onfig": {}\n---\nflowchart LR\n A-->B',
    '---\n"con\\\n  fig": {}\n---\nflowchart LR\n A-->B',
    'flowchart LR\n A["a\\nb"] --> B',
  ];
  for (const src of probes) assert.equal(reason("mermaid", src), "escapes", JSON.stringify(src));
});

test("guardSpec: Mermaid refuses shape data, protocol-relative urls, url( and tag openers", () => {
  const probes = [
    'flowchart LR\n A@{ img: "//evil.example/x.png" }',
    'flowchart LR\n A@{ shape: rect }',
    'flowchart LR\n A["see //evil.example/x"]',
    'flowchart LR\n A["url(x)"]',
    'flowchart LR\n A["<img src=x>"]',
    'flowchart LR\n A["<IMG src=x>"]',
    'flowchart LR\n A["<style>*{}</style>"]',
    'flowchart LR\n A["<foreignObject>"]',
    'flowchart LR\n A["</b>"]',
    'flowchart LR\n A["<!-- x -->"]',
    'flowchart LR\n A["<?xml?>"]',
  ];
  for (const src of probes) assert.equal(reason("mermaid", src), "links", JSON.stringify(src));
  const ok = [
    "flowchart LR\n A --> B\n B <--> C\n C -.-> D\n D ==> E\n E <-.-> F\n F --o G\n G --x H",
    "classDiagram\n A <|-- B\n C *-- D\n E o-- F\n G <.. H\n I ..|> J",
    "sequenceDiagram\n A->>B: hi\n B-->>A: ok\n A-xB: x\n A-)B: async",
    "erDiagram\n A ||--o{ B : has",
    "stateDiagram-v2\n [*] --> S\n S --> [*]",
    "flowchart LR\n A[a < b] --> B[2 < 3]",
  ];
  for (const src of ok) assert.equal(reason("mermaid", src), null, JSON.stringify(src));
});

test("guardSpec: D2 refuses an @ not preceded by a name character, and every backslash", () => {
  for (const src of ["x: [a;@y]", "x;@y", "x: {@y}", "x: (@y)", "x: <@y>", "x:\t@y"]) assert.equal(reason("d2", src), "imports", JSON.stringify(src));
  assert.equal(reason("d2", "a -> b: mail first.last+tag@example.org"), null);
  assert.equal(reason("d2", "a -> b: v1_2-x@y"), null);
  for (const src of ["x: { ic\\on: a }", "x: { l\\ink: a }", 'x: { "\\u0069con": a }', 'x: { "ic\\x6fn": a }', "x: { i\\\ncon: a }", 'a: "say \\"hi\\""']) {
    assert.equal(reason("d2", src), "escapes", JSON.stringify(src));
  }
});

test("guardSpec: escapes carry a fixed message", () => {
  const m = (engine, src) => { try { guardSpec(engine, src); } catch (e) { return e.message; } return null; };
  assert.equal(m("d2", "x: ic\\on"), "escapes and look-alike letters are not allowed in diagrams");
  assert.equal(m("mermaid", "flowchart LR\n A[\\x41]"), "escapes and look-alike letters are not allowed in diagrams");
});

// ---- fix round 3 -----------------------------------------------------------

test("guardSpec: Mermaid front matter closes only on an unindented ---; config/init anywhere before the type is refused", () => {
  const bypass = "---\ntitle: x\n  ---\n  flowchart\nconfig:\n  htmlLabels: true\n  theme: forest\n---\nflowchart LR\n A-->B";
  assert.equal(reason("mermaid", bypass), "directives");
  assert.equal(reason("mermaid", "---\ntitle: x\n\t---\nflowchart LR\n A-->B"), "directives");
  assert.equal(reason("mermaid", "flowchart LR\n A-->B\n  ---"), "directives", "an indented --- line is refused anywhere");
  assert.equal(reason("mermaid", "%% config: {}\nflowchart LR\n A-->B"), "directives");
  assert.equal(reason("mermaid", "\n\nInit\nflowchart LR\n A-->B"), "directives");
  assert.equal(reason("mermaid", "---\ntitle: x\n---   \nflowchart LR\n A-->B"), "directives", "ruling 2026-10-15: no front matter at all");
  assert.equal(reason("mermaid", "flowchart LR\n A[config] --> B"), null, "config inside the diagram body is a label");
});

test("guardSpec: Unicode case-fold look-alikes — D2 refuses them, Mermaid folds them before keyword checks", () => {
  for (const src of ["x: { İcon: /etc/hostname }", "linK: x", "d2-confİg: x", "x: ſy"]) assert.equal(reason("d2", src), "escapes", JSON.stringify(src));
  assert.equal(reason("mermaid", "flowchart LR\n A-->B\n clİcK A cb"), "links");
  assert.equal(reason("mermaid", "İnit\nflowchart LR\n A-->B"), "directives");
});

test("guardSpec: Mermaid allows exact <br> tokens and the fixed annotation list only", () => {
  for (const src of ['flowchart LR\n A["a<br>b"]', 'flowchart LR\n A["a<BR/>b"]', 'flowchart LR\n A["a<br />b"]',
    "classDiagram\n class A\n <<interface>> A", "classDiagram\n class A\n <<Abstract>> A", "classDiagram\n class A\n <<enumeration>> A",
    "classDiagram\n class A\n <<service>> A", "stateDiagram-v2\n state f <<fork>>\n state j <<join>>\n state c <<choice>>"]) {
    assert.equal(reason("mermaid", src), null, JSON.stringify(src));
  }
  for (const src of ['flowchart LR\n A["<br onload=x>"]', 'flowchart LR\n A["<br  />"]', "classDiagram\n class A\n <<style>> A", "classDiagram\n class A\n <<img>> A",
    "classDiagram\n class A\n <<svg>> A", 'flowchart LR\n A["<b<br>r>"]', 'flowchart LR\n A["<b<<interface>>r>"]', 'flowchart LR\n A["<<inter<br>face>>"]', "classDiagram\n class A\n <<interface >> A"]) {
    assert.equal(reason("mermaid", src), "links", JSON.stringify(src));
  }
});

// ---- fix round 4 -----------------------------------------------------------
// Mermaid's own front-matter regex decides where the block ends; its opener
// greedily eats whitespace-only lines, so "---" right after the opener does not
// close the block in Mermaid. The guard applies that exact regex and allows
// only blank lines and one plain title line inside it.

test("guardSpec: Mermaid front matter follows Mermaid's own regex; a --- right after the opener does not close it", () => {
  const cfg = "flowchart LR: 1\nconfig:\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n---\nflowchart LR\n A-->B";
  for (const src of [
    "---\n---\n" + cfg,
    "---\n---\nflowchart LR: 1\nconfig:\n  themeCSS: 'x'\n---\nflowchart LR\n A-->B",
    "---\n\n---\n" + cfg,
    "---\n  \t\n---\n" + cfg,
    "---  \n---\n" + cfg,
    "---\r---\rflowchart LR: 1\rconfig:\r  htmlLabels: true\r---\rflowchart LR\r A-->B",
    "---\n---\nflowchart LR: 1\ninit:\n  htmlLabels: true\n---\nflowchart LR\n A-->B",
    "---\n---\nflowchart LR: &a {htmlLabels: true}\n? config\n: *a\n---\nflowchart LR\n A-->B",
    "---\ntitle: x\n? config\n: {htmlLabels: true}\n---\nflowchart LR\n A-->B",
    "---\ntitle: x\nfoo: 1\n---\nflowchart LR\n A-->B",
    "---\ntitle: a\ntitle: b\n---\nflowchart LR\n A-->B",
    "---\ntitle: &a x\n---\nflowchart LR\n A-->B",
    "---\ntitle: {config: 1}\n---\nflowchart LR\n A-->B",
    "---\ntitle: 'x'\n---\nflowchart LR\n A-->B",
    "---\ntitle: |\n  x\n---\nflowchart LR\n A-->B",
    "---\ntitle: x\n",
    "---\ntitle: x\n---\nflowchart LR\n A-->B\n---\nconfig:\n  htmlLabels: true\n---",
    "flowchart LR\n A-->B\n---",
    "flowchart LR\n A-->B\n---  ",
  ]) assert.equal(reason("mermaid", src), "directives", JSON.stringify(src));
});

test("guardSpec: title-only front matter is refused too (ruling 2026-10-15, was allowed in round 4)", () => {
  for (const src of ["---\ntitle: My chart\n---\nflowchart LR\n A-->B", "---\r\ntitle: My chart\r\n---\r\nflowchart LR\r\n A-->B",
    "---\n\ntitle: My chart\n\n---\n\nflowchart LR\n A-->B", "---\ntitle: x\n---   \nflowchart LR\n A-->B"]) {
    assert.equal(reason("mermaid", src), "directives", JSON.stringify(src));
  }
});

// ---- fix round 5 -----------------------------------------------------------
// guardSpec runs synchronously in the gateway: no 64 KB input may make a regex
// backtrack. Front matter is searched for only in a short leading window, and
// D2's markup rule starts only at the first pipe of a run. Titles may use
// YAML indicator characters after the first character.

const fastest = (engine, src) => {
  let best = Infinity; let r;
  for (let i = 0; i < 3; i++) { const t = performance.now(); r = reason(engine, src); best = Math.min(best, performance.now() - t); }
  return { r, ms: best };
};

test("guardSpec: adversarial 64 KB inputs finish in under 50 ms", () => {
  const N = 65000;
  for (const [engine, src, want] of [
    ["mermaid", "---" + "\n".repeat(65530), "directives"],
    ["mermaid", "---" + "\r".repeat(65530), "directives"],
    ["mermaid", "---" + " \n".repeat(32000), "directives"],
    ["mermaid", "---" + "\r\n".repeat(32760), "directives"],
    ["mermaid", "---\n" + "title: x\n".repeat(7000), "directives"],
    ["mermaid", "---\n" + "\n".repeat(N) + "---\nflowchart LR\n A-->B", "directives"],
    ["mermaid", "---\ntitle: x\n---" + " \n".repeat(32000) + "flowchart LR\n A-->B", "directives"],
    ["mermaid", "flowchart LR\n" + " ---\n".repeat(13000), "directives"],
    ["mermaid", "flowchart LR\n A-->B\n" + " ---".repeat(16000), null],
    ["mermaid", "flowchart LR\n" + "\u00a0".repeat(N / 2) + "---", "directives"],
    ["mermaid", "flowchart LR\n" + "\u3000\n".repeat(N / 5), null],
    ["mermaid", " ".repeat(N) + "---", "directives"],
    ["mermaid", "\n".repeat(N) + "flowchart LR\n A-->B", null],
    ["mermaid", "flowchart LR\n" + " ".repeat(N) + "x", null],
    ["mermaid", "flowchart LR\n" + "@" + " ".repeat(N), null],
    ["mermaid", "flowchart LR\n" + "<<".repeat(N / 2), null],
    ["mermaid", "flowchart LR\n" + "---   ".repeat(N / 6), null],
    ["d2", "|".repeat(N), null],
    ["d2", "|".repeat(N / 2) + "`".repeat(N / 2), null],
    ["d2", "|`".repeat(N / 2), null],
    ["d2", "| ".repeat(N / 2), null],
    ["d2", "|".repeat(N - 3) + " md", "markup"],
    ["d2", ".".repeat(N), null],
  ]) {
    const { r, ms } = fastest(engine, src);
    assert.equal(r, want, `${engine} ${JSON.stringify(src.slice(0, 20))}`);
    assert.ok(ms < 50, `${engine} ${JSON.stringify(src.slice(0, 20))} took ${ms.toFixed(1)} ms`);
  }
});

test("guardSpec: former windowed front-matter cases are all refused now (ruling 2026-10-15)", () => {
  for (const src of ["---\n\n\n\n\n\ntitle: x\n---\nflowchart LR\n A-->B", "---\n\n\n\n\n\n\ntitle: x\n---\nflowchart LR\n A-->B",
    "---\ntitle: " + "x".repeat(1100) + "\n---\nflowchart LR\n A-->B", "---\ntitle: x\n---" + " \n".repeat(600) + "flowchart LR\n A-->B",
    "---\ntitle: x\n---\n" + "\n".repeat(20) + "flowchart LR\n A-->B", "---\ntitle: x\n---" + " \n".repeat(600) + "   ---\nflowchart LR\n A-->B",
    "---\n\n---\n" + "\n".repeat(10) + "x: 1\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A-->B"]) {
    assert.equal(reason("mermaid", src), "directives", JSON.stringify(src.slice(0, 40)));
  }
});

test("guardSpec: Mermaid titles are refused whatever they hold (ruling 2026-10-15; was round 5's indicator allowlist)", () => {
  for (const t of ["Revenue & costs", "50% growth", "Café — 2026", "&a x", "a: b", "x {htmlLabels: true}"]) {
    assert.equal(reason("mermaid", `---\ntitle: ${t}\n---\nflowchart LR\n A-->B`), "directives", t);
  }
});

// ---- fix round 6 (controller ruling 2026-10-15) ------------------------------
// Mermaid's closer \1-{3}\s*[\n\r]+ uses JS Unicode whitespace, so a space/tab
// fence check missed NBSP / \v / \f / U+FEFF / U+3000 closers and leaked config.
// Ruling: Mermaid diagrams take NO front matter. Any line that is "---" with
// Unicode whitespace around it (/^\s*-{3}\s*$/mu) is refused anywhere.

const UNI_WS = ["\u00a0", "\v", "\f", "\ufeff", "\u3000", "\u2028", "\u2029", "\u2003", "\u1680", " ", "\t"];

test("guardSpec: a Unicode-whitespace closer outside the old window is refused (the re-review bypass)", () => {
  const bypass = "---\n\n---\nflowchart: LR\na: 1\nb: 1\nc: 1\nd: 1\ne: 1\nconfig:\n  htmlLabels: true\n--- \nflowchart LR\n A-->B";
  assert.equal(reason("mermaid", bypass), "directives");
  const cfg = "flowchart: LR\na: 1\nb: 1\nc: 1\nd: 1\ne: 1\nf: 1\nconfig:\n  htmlLabels: true\n";
  for (const ws of UNI_WS) {
    for (const src of [
      "---\n\n---\n" + cfg + "---" + ws + "\nflowchart LR\n A-->B",
      "---\n\n---\n" + cfg + ws + "---\nflowchart LR\n A-->B",
      "---\r\n\r\n---\r\n" + cfg.replace(/\n/g, "\r\n") + "---" + ws + "\r\nflowchart LR\r\n A-->B",
      "---\n" + "\n".repeat(10) + "---\n" + cfg + "---" + ws + "\nflowchart LR\n A-->B",
      ws + "---\n" + cfg + ws + "---" + ws + "\nflowchart LR\n A-->B",
      "---" + ws + "\n" + cfg + "---\nflowchart LR\n A-->B",
      "flowchart LR\n A-->B\n" + ws + "---" + ws,
    ]) assert.equal(reason("mermaid", src), "directives", JSON.stringify(src));
  }
});

test("guardSpec: Mermaid takes no front matter — the type check runs on the source after blank and %% lines", () => {
  assert.equal(reason("mermaid", "\n\n%% a\n  \nflowchart LR\n A-->B"), null);
  assert.equal(reason("mermaid", "\u00a0\n\u3000\n%% a\npie\n \"a\": 1"), null, "Unicode-blank lines are blank");
  assert.equal(reason("mermaid", "%% a\nquadrantChart\n x"), "unsupported_type");
  assert.equal(reason("mermaid", "flowchart LR\n A---B"), null, "a --- link inside a line is not a fence");
  assert.equal(reason("mermaid", "flowchart LR\n A-->B\n----"), null, "four dashes are not a fence");
  assert.equal(reason("mermaid", "flowchart LR\n A-->B\n-- -"), null);
});
