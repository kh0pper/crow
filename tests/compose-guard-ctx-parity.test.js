// Every path that runs `compose up` on a checked model builds its guard ctx through
// ONE helper (compose-guard.js guardCtx), so none can drop the ownership seams
// (volumeInfo: who owns an existing volume; knownBundleIds: who else could own the
// compose project). The model-container path (gpu-orchestrator preflightBundleUp)
// once built its ctx by hand without knownBundleIds; this test fails if any call
// site goes back to a hand-built ctx, or if the helper stops providing the seams.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const G = await import("../servers/gateway/compose-guard.js");

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules" || e.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (/\.(m?js)$/.test(e)) out.push(p);
  }
  return out;
}

test("every checkComposeModel call outside the guard passes ctx: guardCtx(...)", () => {
  const sites = [];
  for (const f of [...jsFiles(join(REPO, "servers")), ...jsFiles(join(REPO, "scripts"))]) {
    if (f.endsWith(join("gateway", "compose-guard.js"))) continue;
    const src = readFileSync(f, "utf8");
    let at = src.indexOf("checkComposeModel(");
    while (at !== -1) {
      if (!/function\s+$/.test(src.slice(Math.max(0, at - 12), at)) && !/import\s*\{[^}]*$/.test(src.slice(Math.max(0, at - 200), at))) {
        // the call's argument list, up to its matching parenthesis
        let depth = 0, end = at + "checkComposeModel".length;
        for (; end < src.length; end++) {
          if (src[end] === "(") depth++;
          else if (src[end] === ")") { depth--; if (!depth) break; }
        }
        sites.push({ f: f.slice(REPO.length), call: src.slice(at, end + 1) });
      }
      at = src.indexOf("checkComposeModel(", at + 1);
    }
  }
  const names = sites.map((s) => s.f).sort();
  for (const expected of ["servers/gateway/routes/bundles.js", "servers/gateway/gpu-orchestrator.js", "servers/gateway/preview/renderer.js"]) {
    assert.ok(names.includes(expected), expected + " still calls the guard");
  }
  for (const s of sites) {
    assert.match(s.call, /ctx:\s*guardCtx\(/, `${s.f}: build the guard ctx with guardCtx(), not by hand:\n${s.call}`);
  }
});

test("guardCtx always provides both ownership seams, and a caller cannot override them away", () => {
  const ctx = G.guardCtx({ crowHome: "/x", appRoot: "/y", volumeInfo: null, knownBundleIds: null, home: "/h" });
  assert.equal(ctx.volumeInfo, G.dockerVolumeInfo);
  assert.equal(typeof ctx.knownBundleIds, "function");
  assert.equal(ctx.home, "/h", "the caller's other fields are kept");
  // The bundle path and the model-container path end up with the same seam keys.
  const bundlePath = G.guardCtx({ crowHome: "/a", dataDir: "/a/data", appRoot: "/r", operatorRoots: [], otherRoots: [], home: "/h" });
  const modelPath = G.guardCtx({ crowHome: "/a", dataDir: "/a/data", appRoot: "/r", home: "/h", operatorRoots: [] });
  for (const k of ["volumeInfo", "knownBundleIds", "crowHome", "dataDir", "appRoot", "home"]) {
    assert.ok(k in bundlePath && k in modelPath, k);
  }
});

const tmp = mkdtempSync(join(tmpdir(), "crow-guard-ctx-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("knownBundleIds: the repo's bundles plus this instance's installed ids (array or object installed.json)", () => {
  const app = join(tmp, "app"), home = join(tmp, "home");
  for (const id of ["browser", "nextcloud"]) mkdirSync(join(app, "bundles", id), { recursive: true });
  writeFileSync(join(app, "bundles", "README.md"), "not a bundle");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "frigate" }, "legacy-string"]));
  assert.deepEqual(G.knownBundleIds(home, app).sort(), ["browser", "frigate", "legacy-string", "nextcloud"]);
  writeFileSync(join(home, "installed.json"), JSON.stringify({ minio: { version: "1" } }));
  assert.deepEqual(G.knownBundleIds(home, app).sort(), ["browser", "minio", "nextcloud"]);
  assert.deepEqual(G.knownBundleIds(join(tmp, "none"), join(tmp, "none")), []);
  // Through guardCtx, a community bundle on the model path gets the rival-project refusal too.
  const d = join(tmp, "b"); mkdirSync(d, { recursive: true });
  const r = G.checkComposeModel({ name: "crow-browser-r4", services: { app: { image: "busybox" } } },
    { bundleDir: d, manifest: { id: "browser-r4", origin: "community" }, consentVerified: false, ctx: G.guardCtx({ crowHome: home, dataDir: join(home, "data"), appRoot: app }) });
  assert.equal(r.valid, false);
  assert.match(r.reason, /also belongs to the 'browser' bundle/);
});
