/**
 * Generate registry/add-ons.json from per-bundle manifests.
 *
 * The registry is a committed, generated artifact (lockfile model): every
 * bundle whose manifest passes the contract, is not `draft`, and is git-tracked
 * is emitted (full manifest + official:true), sorted by id. Untracked dirs are
 * implicit drafts (safe WIP handling) — excluded and reported. Orphan registry
 * entries vanish automatically (no manifest, no entry).
 *
 *   node scripts/build-registry.mjs            # write registry/add-ons.json
 *   node scripts/build-registry.mjs --check    # validate + drift-check, no write (CI)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateManifest, detectSurfaces } from "./lib/bundle-contract.mjs";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES_ROOT = join(APP_ROOT, "bundles");
const REGISTRY_PATH = join(APP_ROOT, "registry", "add-ons.json");

/** Set of bundle dir names whose manifest.json is git-tracked; null if git unavailable. */
export function trackedBundleSet() {
  try {
    const out = execFileSync("git", ["ls-files", "bundles"], { cwd: APP_ROOT, encoding: "utf8" });
    const set = new Set();
    for (const line of out.split("\n")) {
      const m = line.match(/^bundles\/([^/]+)\/manifest\.json$/);
      if (m) set.add(m[1]);
    }
    return set;
  } catch {
    return null; // git unavailable (e.g. tarball checkout) → treat all as tracked
  }
}

/**
 * @param {{bundlesRoot?: string, tracked?: Set<string>|null}} [opts]
 *   tracked: explicit tracked set (tests). `null` = treat all as tracked.
 *   omitted = derive from `git ls-files`.
 * @returns {{registry: object, audit: object[]}}
 */
export function buildRegistry(opts = {}) {
  const bundlesRoot = opts.bundlesRoot || BUNDLES_ROOT;
  const trackedSet = "tracked" in opts ? opts.tracked : trackedBundleSet();

  const dirs = readdirSync(bundlesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const bundleExists = (id) => existsSync(join(bundlesRoot, id, "manifest.json"));

  const entries = [];
  const audit = [];
  for (const id of dirs) {
    const manifestPath = join(bundlesRoot, id, "manifest.json");
    if (!existsSync(manifestPath)) continue; // not a bundle
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      audit.push({ id, type: "?", surfaces: [], ok: false, errors: [`manifest.json parse error: ${e.message}`], warnings: [], status: "invalid" });
      continue;
    }
    const bundleDir = join(bundlesRoot, id);
    const { ok, errors, warnings } = validateManifest(manifest, bundleDir, { bundleExists });
    const isTracked = trackedSet === null ? true : trackedSet.has(id);
    const isDraft = manifest.draft === true;
    let status = "published";
    if (!ok) status = "invalid";
    else if (isDraft) status = "draft";
    else if (!isTracked) status = "untracked";
    audit.push({ id, type: manifest.type, surfaces: detectSurfaces(manifest), ok, errors, warnings: warnings || [], status });
    if (ok && !isDraft && isTracked) {
      // `official` is DERIVED, never trusted from the manifest: first-party
      // (no `origin`, or `origin: "official"`) stamps true; a third-party
      // listing declares `origin: "community"` and gets false. The `origin`
      // field itself rides through via ...rest so the store can render
      // provenance. Bogus origin values are rejected by the schema enum.
      const { official: _ignored, ...rest } = manifest;
      entries.push({ ...rest, official: rest.origin !== "community" });
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { registry: { version: 2, "add-ons": entries }, audit };
}

export function formatRegistry(registry) {
  return JSON.stringify(registry, null, 2) + "\n";
}

function main() {
  const isCheck = process.argv.includes("--check");
  const { registry, audit } = buildRegistry();
  const generated = formatRegistry(registry);

  for (const a of audit) {
    const tag = a.status.toUpperCase().padEnd(9);
    const surf = (a.surfaces || []).join("+") || "-";
    const errs = a.errors && a.errors.length ? "  :: " + a.errors.join("; ") : "";
    console.log(`${tag} ${a.id.padEnd(28)} ${(a.type || "?").padEnd(10)} ${surf}${errs}`);
    for (const w of a.warnings || []) console.log(`  WARN      ${a.id.padEnd(28)} :: ${w}`);
  }
  const n = (s) => audit.filter((a) => a.status === s).length;
  console.log(`\n${audit.length} bundles | ${registry["add-ons"].length} published | ${n("invalid")} invalid | ${n("draft")} draft | ${n("untracked")} untracked`);

  const failures = n("invalid");
  if (isCheck) {
    const current = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : "";
    const drift = current !== generated;
    if (drift) console.error("\nDRIFT: registry/add-ons.json is out of date — run `npm run build-registry`.");
    if (failures || drift) process.exit(1);
    console.log("\nOK: all manifests valid, registry in sync.");
  } else {
    if (failures) { console.error(`\nRefusing to write: ${failures} invalid manifest(s).`); process.exit(1); }
    writeFileSync(REGISTRY_PATH, generated);
    console.log(`\nWrote ${REGISTRY_PATH}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
