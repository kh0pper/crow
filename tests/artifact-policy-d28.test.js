// D28 (spec v1.7; plan 2026-10-14 rev 2): documents run the anchor helper and
// ONLY the helper; scripts-off pages move to a separate, fully SEALED row
// that is byte-identical to the pre-D28 script-free policy. One function
// (frameGrantFor) decides sandbox + "speaks" for every consumer (review H2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as policy from "../servers/gateway/artifact-origin/policy.js";

const TOKEN = "https://art.example/v/TOKEN/";
const FA = "https://dash.example";
// The pre-D28 `document` policy, captured verbatim on main 29a59f62.
const SEALED_BEFORE = "default-src 'none'; connect-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; manifest-src 'none'; media-src 'none'; style-src https://art.example/v/TOKEN/ 'unsafe-inline'; img-src https://art.example/v/TOKEN/; font-src https://art.example/v/TOKEN/; frame-ancestors https://dash.example; sandbox";

test("the sealed row is byte-identical to the pre-D28 script-free policy; 'sealed' is never a creatable type", () => {
  assert.equal(policy.cspFor("sealed", { tokenBase: TOKEN, frameAncestors: FA }), SEALED_BEFORE);
  assert.ok(!policy.ARTIFACT_TYPES.includes("sealed"));
  assert.equal(policy.isScriptedType("sealed"), false);
  assert.equal(policy.iframeSandboxFor("sealed"), "");
});

test("a document is helper-only: allow-scripts, script-src = exactly the helper's path, no inline, no eval, nothing else changed", () => {
  const csp = policy.cspFor("document", { tokenBase: TOKEN, frameAncestors: FA });
  const dir = Object.fromEntries(csp.split("; ").map((d) => { const i = d.indexOf(" "); return i < 0 ? [d, ""] : [d.slice(0, i), d.slice(i + 1)]; }));
  assert.equal(dir["script-src"], TOKEN + "__crow/anchor-helper.js");
  assert.equal(dir.sandbox, "allow-scripts");
  assert.ok(!/unsafe-inline|unsafe-eval|unsafe-hashes|'nonce-|'strict-dynamic'/.test(dir["script-src"]));
  // Everything but script-src and sandbox is exactly the sealed row's.
  const strip = (c) => c.split("; ").filter((d) => !/^(script-src|sandbox)/.test(d)).join("; ");
  assert.equal(strip(csp), strip(SEALED_BEFORE));
  assert.equal(policy.isScriptedType("document"), false, "D20 unchanged: documents have no content scripts");
});

test("frameGrantFor: one decision for every type × scripts-off — sandbox and speaks always agree", () => {
  const SCRIPTED = ["page", "slides", "data", "map", "pdf"];
  for (const type of policy.ARTIFACT_TYPES) {
    for (const scriptsOff of [false, true]) {
      const g = policy.frameGrantFor(type, scriptsOff);
      assert.equal(g.sandbox === "allow-scripts", g.speaks, `${type}/${scriptsOff}: sandbox and speaks agree`);
      assert.equal(g.sandbox, policy.iframeSandboxFor(g.effectiveType));
      if (SCRIPTED.includes(type)) {
        assert.deepEqual(g, scriptsOff ? { effectiveType: "sealed", sandbox: "", speaks: false } : { effectiveType: type, sandbox: "allow-scripts", speaks: true }, `${type}/${scriptsOff}`);
      } else if (type === "document") {
        assert.deepEqual(g, { effectiveType: "document", sandbox: "allow-scripts", speaks: true }, `document/${scriptsOff}`);
      } else {
        assert.deepEqual(g, { effectiveType: type, sandbox: "", speaks: false }, `${type}/${scriptsOff}`);
      }
      assert.equal(policy.speaks(g.effectiveType), g.speaks);
    }
  }
});

test("review H2: every routes-shaped grant passes the REAL viewer validGrant (no grant mismatch can flag a version)", () => {
  const src = readFileSync(new URL("../bundles/artifacts/panel/static/viewer.js", import.meta.url), "utf8");
  const sandbox = { window: {}, URL, location: { origin: "https://dash.example" }, document: { createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }), addEventListener() {} }, setTimeout, clearTimeout, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const { validGrant } = sandbox.CrowArtifactViewer;
  for (const type of policy.ARTIFACT_TYPES) {
    for (const scriptsOff of [false, true]) {
      const fg = policy.frameGrantFor(type, scriptsOff);
      // The view-mint route's shape, for every type × scripts-off; the REAL
      // route's grants are fed to validGrant in artifacts-panel-routes.test.js.
      const g = { url: "https://art.example/v/" + "A".repeat(43) + "/", tokenId: "x".repeat(64), nonce: "n".repeat(22), type, fragment: null, sandbox: fg.sandbox, scripted: fg.speaks, scriptsOff, isolation: "own-host" };
      assert.equal(validGrant(g), true, `${type}/${scriptsOff}`);
    }
  }
});
