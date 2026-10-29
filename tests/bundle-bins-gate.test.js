/**
 * The requires-bins gate: an Extensions install of a bundle whose
 * `requires.bins` entry is not trusted-resolvable (uvx in ~/.local/bin) is
 * refused, because the installed add-on would be refused at spawn. The store
 * disables Install with an en/es line. The gate lifts once the bin resolves
 * as trusted, and the `.env` path for the same service is unchanged.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trustedBinsMissing, _setTrustedBinResolveForTest } from "../servers/shared/trusted-bins.js";
import { validateInstall } from "../servers/gateway/routes/bundles.js";
import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { legacyEnvSources } from "../servers/gateway/services/legacy-sources.js";
import { serviceById } from "../servers/shared/service-catalog.js";
import { _setDockerProbeForTest } from "../servers/gateway/dashboard/panels/extensions/data-queries.js";

_setDockerProbeForTest(true);

const REPO = join(import.meta.dirname, "..");
const manifest = (id) => JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
const NOT_TRUSTED = (c) => ({ command: c, resolved: false, missing: true, reason: "stub: not trusted" });
const TRUSTED = (c) => ({ command: `/usr/local/bin/${c}`, resolved: true, missing: false });

afterEach(() => _setTrustedBinResolveForTest(null));

test("trustedBinsMissing: lists only untrusted bins; none declared → []", () => {
  assert.deepEqual(trustedBinsMissing({}), []);
  assert.deepEqual(trustedBinsMissing({ requires: { bins: [] } }), []);
  assert.deepEqual(trustedBinsMissing({ requires: { bins: ["uvx"] } }, { resolve: NOT_TRUSTED }), ["uvx"]);
  assert.deepEqual(trustedBinsMissing({ requires: { bins: ["uvx"] } }, { resolve: TRUSTED }), []);
  // node always resolves to the gateway's own binary (resolve-command.js rules, unchanged)
  assert.deepEqual(trustedBinsMissing({ requires: { bins: ["node"] } }), []);
  // a path or junk is never a trusted bin name, and the resolver is not even asked
  let asked = 0;
  const spy = (c) => { asked++; return TRUSTED(c); };
  assert.deepEqual(trustedBinsMissing({ requires: { bins: ["/home/x/.local/bin/uvx", "../uvx", ""] } }, { resolve: spy }),
    ["/home/x/.local/bin/uvx", "../uvx", ""]);
  assert.equal(asked, 0);
});

test("validateInstall refuses a bundle whose bin is not trusted (409 bins_not_trusted), even with force_install", async () => {
  _setTrustedBinResolveForTest(NOT_TRUSTED);
  for (const id of ["arxiv", "zotero"]) {
    for (const forceInstall of [false, true]) {
      const r = await validateInstall(id, { forceInstall });
      assert.equal(r.ok, false, id);
      assert.equal(r.status, 409, id);
      assert.equal(r.code, "bins_not_trusted", id);
      assert.deepEqual(r.extra.bins, ["uvx"], id);
      assert.match(r.error, /uvx installed system-wide/);
    }
  }
});

test("validateInstall lets it through once the bin resolves as trusted (stubbed)", async () => {
  _setTrustedBinResolveForTest(TRUSTED);
  const r = await validateInstall("arxiv", { forceInstall: true });
  assert.notEqual(r.code, "bins_not_trusted", JSON.stringify(r));
});

test("store card: Install disabled with the en/es line while the bin is untrusted; a normal Install once trusted", () => {
  const arxiv = { ...manifest("arxiv"), official: true };
  const render = (lang) => buildExtensionsHTML({ installed: {}, available: [arxiv], registrySource: "test",
    communityStores: [], bundleStatus: {}, needsRepin: {}, lang });
  _setTrustedBinResolveForTest(NOT_TRUSTED);
  const en = render("en");
  assert.match(en.viewsHtml, /<button class="btn btn-sm btn-primary" disabled aria-disabled="true" data-testid="bins-not-trusted"/);
  assert.match(en.viewsHtml, /Needs uvx installed system-wide \(not in your home folder\) before Crow can run it\./);
  assert.doesNotMatch(en.viewsHtml, /class="btn btn-sm btn-primary bundle-install" data-id="arxiv"/);
  const reg = (r) => JSON.parse(r.addonRegistryScript.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
  assert.equal(reg(en).arxiv._noInstall, true, "the detail modal offers no Install either");
  const es = render("es").viewsHtml;
  assert.match(es, /Necesita uvx instalado para todo el sistema \(no en su carpeta personal\) antes de que Crow pueda ejecutarlo\./);
  _setTrustedBinResolveForTest(TRUSTED);
  const okR = render("en");
  assert.equal(reg(okR).arxiv._noInstall, false);
  const ok = okR.viewsHtml;
  assert.match(ok, /class="btn btn-sm btn-primary bundle-install" data-id="arxiv"/);
  assert.doesNotMatch(ok, /bins-not-trusted/);
});

test("the .env path is untouched by the gate: arxiv/zotero still spawn from .env and stay in the service catalog", () => {
  _setTrustedBinResolveForTest(NOT_TRUSTED);
  const ids = legacyEnvSources({ CROW_ENABLE_ARXIV: "1", ZOTERO_API_KEY: "k", ZOTERO_USER_ID: "1" }).map((s) => s.id).sort();
  assert.deepEqual(ids, ["arxiv", "zotero"]);
  const arxiv = legacyEnvSources({ CROW_ENABLE_ARXIV: "1" })[0];
  assert.equal(arxiv.command, "uvx");
  assert.deepEqual(arxiv.requires, ["uvx"]);
  assert.ok(serviceById("arxiv") && serviceById("zotero"));
});
