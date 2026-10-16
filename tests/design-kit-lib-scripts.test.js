// Design kit (spec §3.2): page-only script libraries. Vega and Vega-Lite load
// DOM-free in a vm; vega-embed and Mermaid are proven in a real browser under
// the page CSP by tests/artifact-isolation-live.test.js (PR 2). There is no
// separate vega-interpreter entry: vega-interpreter ships only an ES module, and
// vega-embed's minified build bundles it, using it when called with
// vegaEmbed(el, spec, { actions: false, ast: true }) (the CSP-safe path, no eval).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const LIB = new URL("../bundles/design-kit/lib/", import.meta.url).pathname;
const entries = new Map(JSON.parse(readFileSync(join(LIB, "manifest.json"), "utf8")).entries.map((e) => [e.name, e]));

test("the four page scripts are present, page-only, with their dependency chain", () => {
  for (const n of ["vega", "vega-lite", "vega-embed", "mermaid"]) {
    const e = entries.get(n);
    assert.ok(e, `${n} vendored`);
    assert.equal(e.kind, "script");
    assert.deepEqual(e.allowed, ["page"], `${n} is page-only (spec §3.2)`);
    assert.ok(e.global, `${n} records its UMD global`);
  }
  assert.equal(entries.get("vega-interpreter"), undefined, "the interpreter rides inside vega-embed (no ES-module-only entry)");
  assert.equal(entries.get("vega-lite").version, "6.5.0");
  assert.equal(entries.get("mermaid").version, "11.17.2", "11.x: 12.x bundles elkjs (EPL-2.0)");
  assert.ok((entries.get("mermaid").notes || []).some((n) => n.includes("pinned to 11.x: 12.x bundles elkjs (EPL-2.0)")));
  assert.deepEqual(entries.get("vega-lite").requires, ["vega"]);
  assert.deepEqual(entries.get("vega-embed").requires, ["vega", "vega-lite"]);
  for (const n of ["vega", "vega-lite", "vega-embed"]) assert.equal(entries.get(n).license, "BSD-3-Clause");
  assert.equal(entries.get("mermaid").license, "MIT");
  for (const n of ["mermaid", "vega", "vega-embed"]) {
    const notes = entries.get(n).notices || [];
    assert.equal(notes.length, 1, `${n}: bundled third-party licences recorded (review M9)`);
    assert.match(readFileSync(join(LIB, notes[0].path), "utf8"), /^Third-party code in /);
  }
});

test("vega and vega-lite load without a DOM and expose their globals", () => {
  // structuredClone: vega-lite 6 calls it at load (every target browser has it).
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, structuredClone });
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
  for (const n of ["vega", "vega-lite"]) vm.runInContext(readFileSync(join(LIB, entries.get(n).main), "utf8"), ctx, { filename: n });
  assert.equal(typeof ctx.vega.View, "function");
  assert.equal(typeof ctx.vegaLite.compile, "function");
});

test("each script file names its recorded global", () => {
  for (const n of ["vega-embed", "mermaid"]) {
    const e = entries.get(n);
    assert.ok(readFileSync(join(LIB, e.main), "utf8").includes(e.global), `${n}: "${e.global}" appears in ${e.main}`);
  }
});

test("vega-embed carries the bundled expression interpreter and switches to it on { ast: true }", () => {
  const js = readFileSync(join(LIB, entries.get("vega-embed").main), "utf8");
  // vega-embed 7.3.0: const{ast:m}=opts … m?{expr: vega.expressionInterpreter ?? opts.expr ?? <bundled>}:{}
  assert.match(js, /const\{ast:(\w+)\}=\w+/, "reads opts.ast");
  assert.match(js, /expr:\w+\.expressionInterpreter\?\?\w+\.expr\?\?\w+/, "falls back to the bundled interpreter");
  assert.match(js, /\{operator\(e,t\)\{const n=t\.ast/, "the interpreter's operator() is in the build");
});

// Spec licence list: what may be inside a vendored bundle.
const PERMITTED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "MPL-2.0", "(MPL-2.0 OR Apache-2.0)", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0", "OFL-1.1"]);
const notice = (n) => readFileSync(join(LIB, entries.get(n).notices[0].path), "utf8");
const listed = (text) => [...text.matchAll(/^==== (\S+)@(\S+) \((.+)\)$/gm)].map((m) => ({ name: m[1], version: m[2], license: m[3] }));

test("third-party notices list what is inside each bundle, with permitted licences only", () => {
  for (const n of ["mermaid", "vega", "vega-embed"]) {
    const pk = listed(notice(n));
    assert.ok(pk.length, `${n}: notice lists packages`);
    for (const p of pk) assert.ok(PERMITTED.has(p.license), `${n}: ${p.name}@${p.version} is ${p.license}`);
  }
  const mer = notice("mermaid");
  assert.doesNotMatch(mer, /^==== elkjs@/m, "no EPL-2.0 ELK in mermaid 11");
  assert.ok(!readFileSync(join(LIB, entries.get("mermaid").main), "utf8").includes("org.eclipse.elk"), "no ELK code in the build");
  assert.match(mer, /^==== khroma@2\.1\.0 \(MIT\)/m, "a package.json without a licence field takes the id its LICENSE file states");
  assert.match(mer, /^==== langium@/m, "code bundled through @mermaid-js/parser's own build is followed");
  assert.match(mer, /from the source map/, "mermaid's versions come from the source map, not today's resolution");
  assert.match(notice("vega-embed"), /^==== vega-interpreter@/m);
  assert.match(notice("vega"), /no source map/, "vega ships no map: the notice says its versions are today's resolution");
  assert.equal((entries.get("vega-lite").notices || []).length, 0, "vega-lite's bundle holds only its own source (vega is external)");
});
