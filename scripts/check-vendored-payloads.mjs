#!/usr/bin/env node
/**
 * Vendored-payload integrity check (CI, `static-checks` job).
 *
 * Some bundles ship VENDORED upstream code under `bundles/<id>/payload/` —
 * source we did not write, copied in at a pinned upstream commit by a vendor
 * script (e.g. `scripts/vendor-perch.mjs`). Reviewing a diff of vendored code
 * is not the same as knowing the tree on disk is exactly what the vendor
 * script produced, so the vendor script stamps a `payload_sha256` into the
 * manifest and this check recomputes it on every push.
 *
 * Contract:
 *   - A manifest WITHOUT `payload_sha256` is SKIPPED, by design. That is the
 *     pre-vendor state of a draft bundle (manifest lands first, payload is
 *     vendored later) and it must not redden CI in the interim. `draft: true`
 *     keeps such a bundle out of the registry, so nothing installable is ever
 *     unguarded. (If a `payload/` directory is nonetheless present without a
 *     stamp, that skip is announced as a WARN — still non-fatal, never silent.)
 *   - A manifest WITH `payload_sha256` must have a `payload/` directory whose
 *     digest matches exactly. Missing dir, empty dir, or any byte/path change
 *     → exit 1, listing the offending bundle and the differing files.
 *
 *   node scripts/check-vendored-payloads.mjs              # check this repo
 *   node scripts/check-vendored-payloads.mjs --root DIR   # check a fixture tree (tests)
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every file under `dir`, as posix-style paths relative to `dir`, sorted. */
export function listPayloadFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(relative(dir, child).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Digest of a vendored payload directory.
 *
 * Framing (a CONTRACT — every stamped manifest depends on it): for each file,
 * in lexicographic order of its posix relative path, absorb
 * `<relpath> NUL <bytes> NUL`. Paths are absorbed, not just contents, so a
 * rename is a change; the NUL framing keeps a path/content boundary
 * unambiguous. Symlinks and non-regular files are not followed — a vendored
 * payload is plain files.
 *
 * @param {string} dir absolute path to the payload directory
 * @returns {string} lowercase hex sha256
 */
export function computePayloadDigest(dir) {
  const hash = createHash("sha256");
  for (const rel of listPayloadFiles(dir)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * @param {string} root repo root containing a `bundles/` directory
 * @returns {{results: Array<{id:string,status:"ok"|"skipped"|"unstamped"|"mismatch"|"missing",expected?:string,actual?:string,files?:string[]}>}}
 */
export function checkVendoredPayloads(root = REPO_ROOT) {
  const bundlesRoot = join(root, "bundles");
  const results = [];
  if (!existsSync(bundlesRoot)) return { results };

  const dirs = readdirSync(bundlesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const id of dirs) {
    const manifestPath = join(bundlesRoot, id, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // manifest shape is build-registry's job, not ours
    }
    const payloadDir = join(bundlesRoot, id, "payload");
    const hasPayloadDir = existsSync(payloadDir) && statSync(payloadDir).isDirectory();
    const expected = manifest && manifest.payload_sha256;
    if (typeof expected !== "string" || !expected) {
      // Two very different situations, both non-fatal:
      //   - no payload dir either → an ordinary bundle, nothing to guard (quiet).
      //   - payload dir present but unstamped → vendored bytes outside the gate.
      //     Legitimate only between "manifest lands" and "vendor script runs",
      //     so it warns loudly rather than passing in silence.
      results.push({ id, status: hasPayloadDir ? "unstamped" : "skipped" });
      continue;
    }
    if (!hasPayloadDir) {
      results.push({ id, status: "missing", expected });
      continue;
    }
    const actual = computePayloadDigest(payloadDir);
    if (actual === expected) results.push({ id, status: "ok", expected, actual });
    else results.push({ id, status: "mismatch", expected, actual, files: listPayloadFiles(payloadDir) });
  }
  return { results };
}

function main() {
  const i = process.argv.indexOf("--root");
  const root = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : REPO_ROOT;
  const { results } = checkVendoredPayloads(root);

  let failures = 0;
  for (const r of results) {
    if (r.status === "skipped") {
      // Ordinary bundle, no vendored payload — nothing to say.
    } else if (r.status === "unstamped") {
      console.log(`WARN     ${r.id.padEnd(28)} payload/ present but no payload_sha256 — run its vendor script to stamp it`);
    } else if (r.status === "ok") {
      console.log(`OK       ${r.id.padEnd(28)} ${r.actual}`);
    } else if (r.status === "missing") {
      failures++;
      console.error(`MISSING  ${r.id.padEnd(28)} manifest stamps payload_sha256 but bundles/${r.id}/payload/ does not exist`);
    } else {
      failures++;
      console.error(`MISMATCH ${r.id.padEnd(28)} expected ${r.expected}`);
      console.error(`         ${" ".repeat(28)} actual   ${r.actual}`);
      for (const f of r.files || []) console.error(`           payload/${f}`);
    }
  }

  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `${results.length} bundles | ${n("ok")} verified | ${n("skipped")} skipped (no vendored payload)` +
      ` | ${n("unstamped")} unstamped | ${failures} failed`,
  );
  if (failures) {
    console.error("\nVendored payload does not match its stamped digest — re-run the bundle's vendor script, or revert the hand edit.");
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
