// Design kit renderer, LIVE (spec §3.3, §4.2, §7 "container smoke"). Runs only
// with CROW_DESIGN_RENDER_LIVE=1 AND an explicit CROW_DESIGN_RENDER_URL (the
// smoke instance, http://127.0.0.1:18018). It never defaults to the prod
// renderer on 8018, so a full `npm test` on crow cannot take its queue slots
// (review L6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openKit, MERMAID_TYPES } from "../bundles/design-kit/server/kit.js";

const URL_ = process.env.CROW_DESIGN_RENDER_URL || "";
const on = process.env.CROW_DESIGN_RENDER_LIVE === "1" && /^http:\/\/127\.0\.0\.1:\d+$/.test(URL_) && !URL_.endsWith(":8018");
const live = on && await fetch(URL_ + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
const skip = live ? false : "set CROW_DESIGN_RENDER_LIVE=1 and CROW_DESIGN_RENDER_URL to the smoke instance";
const kit = live ? openKit(new URL("../bundles/design-kit", import.meta.url).pathname, { renderUrl: URL_ }) : null;
const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };
// Straight to the renderer, past the kit guard: proves the container's own layer.
const direct = async (engine, source) => {
  const r = await fetch(URL_ + "/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine, source }), signal: AbortSignal.timeout(25000) });
  return { status: r.status, body: await r.json() };
};

test("vega-lite renders to SVG without a browser, through the interpreter (calculate works)", { skip }, async () => {
  const svg = await kit.render("vega-lite", JSON.stringify({ data: { values: [{ a: "x", b: 1 }, { a: "y", b: 3 }] }, transform: [{ calculate: "datum.b * 2 + 1", as: "c" }], mark: "bar", encoding: { x: { field: "a", type: "nominal" }, y: { field: "c", type: "quantitative" } } }));
  assert.match(svg, /^<svg/);
  assert.match(svg, /<path|<rect/);
});

test("vega-lite: a raw Vega $schema does not switch modes, and an unknown-function expression fails closed", { skip }, async () => {
  const spec = { $schema: "https://vega.github.io/schema/vega/v6.json", data: { values: [{ a: "x", b: 1 }] }, mark: "point", encoding: { x: { field: "a", type: "nominal" } } };
  assert.match(await kit.render("vega-lite", JSON.stringify(spec)), /^<svg/, "compiled as Vega-Lite whatever $schema says");
  const e = await fails(kit.render("vega-lite", JSON.stringify({ data: { values: [{ b: 1 }] }, transform: [{ calculate: "constructor.constructor('return 1')()", as: "c" }], mark: "point" })));
  assert.equal(e && e.code, "render_failed");
});

test("mermaid renders with SVG labels; hostile labels stay inert", { skip }, async () => {
  const svg = await kit.render("mermaid", "flowchart LR\n  A[Start] --> B[\"<img src=x onerror=alert(1)>\"]").catch((e) => e);
  // The kit guard refuses tag openers before the render; the direct call proves the renderer too.
  assert.equal(svg.code, "bad_spec");
  const r = await direct("mermaid", "flowchart LR\n  A[Start] --> B[\"<img src=x onerror=alert(1)>\"]");
  assert.equal(r.status, 200);
  for (const bad of ["<script", "<foreignobject", "onerror", "javascript:", "<img"]) assert.ok(!r.body.svg.toLowerCase().includes(bad), bad);
  assert.match(await kit.render("mermaid", "flowchart LR\n  A[Start] --> B[End]"), /^<svg/);
});

// Ruling 2026-10-15: front matter and directives cannot turn HTML labels or CSS
// back on, even though the kit guard already refuses both (second layer).
test("a spec's own config cannot turn htmlLabels, themeCSS, themeVariables or fontFamily on", { skip }, async () => {
  const body = "flowchart LR\n  A[alpha] --> B[beta]";
  const probes = [
    "---\nconfig:\n  htmlLabels: true\n---\n" + body,
    "---\nconfig:\n  flowchart:\n    htmlLabels: true\n---\n" + body,
    "---\nconfig:\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n  securityLevel: loose\n---\n" + body,
    '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\n' + body,
    '%%{init: {"themeCSS": ".crowprobecss { fill: #123457 }", "themeVariables": {"primaryColor": "#123456"}, "fontFamily": "CrowProbeFont"}}%%\n' + body,
    '%%{init: {"dompurifyConfig": {"ADD_TAGS": ["foreignObject"]}, "htmlLabels": true}}%%\n' + body,
  ];
  for (const src of probes) {
    const r = await direct("mermaid", src);
    assert.equal(r.status, 200, `${JSON.stringify(src.slice(0, 60))}: ${JSON.stringify(r.body)}`);
    const low = r.body.svg.toLowerCase();
    for (const bad of ["<foreignobject", "crowprobecss", "#123456", "#123457", "crowprobefont"]) assert.ok(!low.includes(bad), `${bad} in output of ${JSON.stringify(src.slice(0, 40))}`);
  }
});

// Review M7: one small example per advertised type. Every type left in
// MERMAID_TYPES must render without foreignObject.
const MERMAID_EXAMPLES = {
  flowchart: "flowchart LR\n  A --> B", graph: "graph TD\n  A --> B",
  sequencediagram: "sequenceDiagram\n  A->>B: hi", classdiagram: "classDiagram\n  class A\n  A <|-- B",
  statediagram: "stateDiagram\n  [*] --> S\n  S --> [*]", "statediagram-v2": "stateDiagram-v2\n  [*] --> S",
  erdiagram: "erDiagram\n  A ||--o{ B : has", gantt: "gantt\n  dateFormat YYYY-MM-DD\n  section S\n  T :t1, 2026-01-01, 3d",
  pie: "pie\n  \"a\" : 1\n  \"b\" : 2", timeline: "timeline\n  2026 : start", mindmap: "mindmap\n  root\n    child",
};
test("every Mermaid type the kit accepts renders as plain SVG", { skip }, async () => {
  const failed = [];
  for (const type of MERMAID_TYPES) {
    const e = await fails(kit.render("mermaid", MERMAID_EXAMPLES[type]).then((svg) => { if (svg.toLowerCase().includes("<foreignobject")) throw new Error("foreignObject"); }));
    if (e) failed.push(`${type}: ${e.category || e.message}`);
  }
  assert.deepEqual(failed, [], "remove these from MERMAID_TYPES in kit.js and from the skill's type list");
});

test("d2 renders; icons, imports and remote links never reach the container", { skip }, async () => {
  assert.match(await kit.render("d2", "a -> b: hello"), /^<svg/);
  assert.equal((await fails(kit.render("d2", "x: { icon: https://example.invalid/i.svg }"))).reason, "icons");
  assert.equal((await fails(kit.render("d2", "x: { icon: /etc/hostname }"))).reason, "icons");
});

// Found live (D2 0.9.0): --bundle=false does NOT stop a local-path icon being
// read and inlined as a data: URI. The kit guard refuses "icon"; the renderer
// refuses it too, before the binary runs (second layer).
test("d2 in the container: icons are refused before the binary runs, so no local file is read", { skip }, async () => {
  for (const src of ["x: { icon: /etc/hostname }", "x.icon: /etc/hostname", "*.icon: /etc/hostname\nx", "x: { ICON: /etc/hostname }", "x: { icon: https://example.invalid/i.svg }"]) {
    const r = await direct("d2", src);
    assert.deepEqual(r, { status: 422, body: { error: { code: "render_failed", category: "invalid spec" } } }, src);
  }
  const ok = await direct("d2", "lexicon -> iconography: words");
  assert.equal(ok.status, 422, "the renderer's check is a plain substring: stricter than the binary");
});

test("a huge graph fails or finishes inside the limit, and the renderer still serves", { skip, timeout: 60000 }, async () => {
  const big = "flowchart LR\n" + Array.from({ length: 2500 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n");
  const t0 = Date.now();
  const e = await fails(kit.render("mermaid", big.slice(0, 64000)));
  assert.ok(Date.now() - t0 < 25000, "within the client timeout");
  if (e) assert.ok(["render_failed", "render_too_large", "render_unavailable", "bad_spec"].includes(e.code), e.code);
  assert.match(await kit.render("mermaid", "flowchart LR\n A --> B"), /^<svg/, "next request served");
});

test("errors are short and fixed", { skip }, async () => {
  const e = await fails(kit.render("mermaid", "flowchart LR\n A --> \n SENTINEL-LIVE-5 ((("));
  assert.equal(e.code, "render_failed");
  assert.ok(!JSON.stringify({ m: e.message, c: e.category }).includes("SENTINEL"));
  const d = await direct("d2", "a -> b: {\n SENTINEL-LIVE-6");
  assert.equal(d.body.error.code, "render_failed");
  assert.ok(!JSON.stringify(d.body).includes("SENTINEL"));
});

test("the Host check holds through the door", { skip }, async () => {
  const http = await import("node:http");
  const { port } = new URL(URL_);
  const status = await new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: "/health", headers: { host: "rebind.example:" + port } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject); r.end();
  });
  assert.equal(status, 403);
});
