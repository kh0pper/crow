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
  assert.throws(() => makeRenderClient({ url: "http://127.0.0.1:8018/x" }), (e) => e.code === "render_unavailable" && e.reason === "not_loopback");
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
