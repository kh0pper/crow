/**
 * MinIO is deprecated in favour of File Storage (Garage) (Garage migration PR 1).
 *
 * The upstream project stopped publishing images (minio/minio is gone from Docker Hub),
 * so the bundle is pinned to the exact build existing installs run and is used only from
 * the local copy. Installed copies are never switched to another engine by a refresh:
 * a docker bundle's compose file is never copied on a manifest-bump refresh, so the
 * running MinIO keeps its own compose until the owner runs the explicit upgrade.
 * The Extensions page badges it and offers no Install for a new one.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { loadCollections } from "../servers/gateway/dashboard/panels/extensions/collections.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(REPO, "bundles", "minio");
const DIGEST = "sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const manifest = () => JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const compose = () => readFileSync(join(DIR, "docker-compose.yml"), "utf8");
const registry = () => JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"));

test("manifest: deprecated since 2026-10-27, superseded by garage, tagged, version bumped", () => {
  const m = manifest();
  assert.deepEqual(m.deprecated, { since: "2026-10-27", superseded_by: "garage" });
  assert.ok(m.tags.includes("deprecated"));
  assert.equal(m.version, "1.0.3");
  const reg = registry()["add-ons"].find((a) => a.id === "minio");
  assert.deepEqual(reg.deprecated, m.deprecated, "the registry carries the deprecation");
  assert.ok(registry()["add-ons"].find((a) => a.id === "garage"), "its successor is in the registry");
});

test("compose: pinned to the exact build installs run, used from the local copy only", () => {
  const images = [...compose().matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(images, [`minio/minio@${DIGEST}`]);
  assert.match(compose(), /^\s*pull_policy:\s*never\s*$/m);
  assert.match(compose(), /CANNOT be\s*\n?#*\s*pulled/);
  assert.doesNotMatch(compose(), /:latest\b/);
});

test("image freshness skips it (pull_policy: never), so the nightly job does not fail on an image that cannot exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-minio-fresh-"));
  try {
    execFileSync("python3", [join(REPO, "scripts/extract-bundle-images.py"), join(dir, "images.txt"), join(dir, "fail.txt")], { cwd: REPO, stdio: "pipe" });
    const images = readFileSync(join(dir, "images.txt"), "utf8");
    assert.doesNotMatch(images, /^minio\/minio/m);
    assert.match(images, /^dxflrs\/garage:v2\.4\.1@sha256:9c96caa2/m, "Garage's pinned image is still checked");
  } finally {
    rmScratch(dir);
  }
});

test("collections offer Garage, not MinIO", () => {
  const ids = loadCollections().flatMap((c) => c.members.map((m) => m.id));
  assert.ok(!ids.includes("minio"));
  assert.ok(ids.includes("garage"));
});

// ── Extensions page ──

const ADDONS = [
  { id: "minio", name: "File Storage (MinIO)", description: "d", type: "bundle", category: "storage", version: "1.0.3", author: "Crow", tags: ["deprecated"], deprecated: { since: "2026-10-27", superseded_by: "garage" } },
  { id: "garage", name: "File Storage (Garage)", description: "d", type: "bundle", category: "storage", version: "1.0.0", author: "Crow", tags: [] },
  { id: "nextcloud", name: "Nextcloud (connect existing)", description: "d", type: "skill", category: "productivity", version: "1.1.1", author: "Crow", tags: [], deprecated: { since: "2026-10-02", superseded_by: "workspace" } },
];
const render = (installed = {}, lang = "en") => buildExtensionsHTML({ installed, available: ADDONS, collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang });
const card = (html, id) => {
  const start = html.indexOf(`data-addon-id="${id}"`);
  return html.slice(start, html.indexOf("ext-card__footer", start) + 400);
};

test("a not-installed deprecated bundle: badge, the successor's name, no Install anywhere", () => {
  const { viewsHtml, addonRegistryScript } = render();
  const c = card(viewsHtml, "minio");
  assert.match(c, /ext-card__badge--deprecated/);
  assert.match(c, /Replaced by File Storage \(Garage\)/);
  assert.doesNotMatch(c, /bundle-install/);
  const reg = JSON.parse(addonRegistryScript.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
  assert.equal(reg.minio._noInstall, true, "the detail modal hides Install too");
  assert.equal(reg.garage._noInstall, false);
  assert.match(card(viewsHtml, "garage"), /bundle-install/, "the successor installs normally");
});

test("Spanish copy", () => {
  const c = card(render({}, "es").viewsHtml, "minio");
  assert.match(c, /Obsoleto/);
  assert.match(c, /Sustituido por File Storage \(Garage\)/);
});

test("an installed deprecated bundle keeps its Installed state; a deprecated skill keeps Install", () => {
  const { viewsHtml } = render({ minio: { id: "minio" } });
  assert.doesNotMatch(card(viewsHtml, "minio"), /ext-card__replaced/);
  assert.match(card(viewsHtml, "minio"), /ext-card__badge--deprecated/);
  assert.match(card(viewsHtml, "nextcloud"), /bundle-install/, "the rule is for bundles (their image may be gone)");
  assert.match(card(viewsHtml, "nextcloud"), /ext-card__badge--deprecated/);
});

// ── refresh never swaps an installed MinIO's compose ──

let CROW_HOME, B, APP;
before(async () => {
  CROW_HOME = mkdtempSync(join(tmpdir(), "crow-minio-dep-home-"));
  process.env.CROW_HOME = CROW_HOME;
  B = await import("../servers/gateway/routes/bundles.js");
  APP = mkdtempSync(join(tmpdir(), "crow-minio-dep-app-"));
});
after(() => { for (const d of [CROW_HOME, APP]) if (d) rmScratch(d); });

test("refresh 1.0.2 → 1.0.3 copies the manifest only: the installed compose, .env and image stay as they are", async () => {
  cpSync(DIR, join(APP, "minio"), { recursive: true });
  const dest = join(CROW_HOME, "bundles", "minio");
  mkdirSync(dest, { recursive: true });
  const oldCompose = "services:\n  minio:\n    image: minio/minio:latest\n";
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ ...manifest(), version: "1.0.2", deprecated: undefined }));
  writeFileSync(join(dest, "docker-compose.yml"), oldCompose);
  writeFileSync(join(dest, ".env"), "MINIO_BIND_ADDR=100.64.20.5\n", { mode: 0o600 });
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "minio" }]));
  const out = await B.repairInstalledBundleAssets({ appBundles: APP, run: async () => ({ stdout: "", stderr: "" }), skillMode: "off", log: () => {} });
  assert.ok(out.repaired.some((r) => r.startsWith("minio: refreshed 1.0.2 -> 1.0.3")), JSON.stringify(out));
  assert.equal(readFileSync(join(dest, "docker-compose.yml"), "utf8"), oldCompose);
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), "MINIO_BIND_ADDR=100.64.20.5\n");
  assert.equal(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")).deprecated.superseded_by, "garage");
});
