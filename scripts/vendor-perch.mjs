#!/usr/bin/env node
/**
 * Vendor the Perch hub into bundles/perch-hub/payload/.
 *
 * Perch lives upstream in the pi-lab repo (LIVE infrastructure — this script
 * NEVER writes to it, and never touches the checkout the running pi-hub
 * service uses). We copy a pinned FILE LIST at a pinned GIT REF into the
 * bundle payload, record the exact commit in payload/UPSTREAM, and stamp the
 * payload digest into the manifest so `scripts/check-vendored-payloads.mjs`
 * can prove on every CI run that the tree on disk is what this script wrote.
 *
 * Contents are read with `git show <ref>:<path>` rather than off the working
 * tree: a dirty pi-lab worktree can then never leak into the payload, and the
 * recorded commit is guaranteed to be the source of the bytes.
 *
 * The hub imports `../lib/sessions.mjs`, so the `hub/` + `lib/` SIBLING layout
 * is load-bearing and is preserved verbatim. There is no static-assets
 * directory (hub/ holds only server.mjs + install.sh + pi-hub.service
 * upstream); total payload is ~30 KB.
 *
 *   node scripts/vendor-perch.mjs                       # ref crow-mode, PI_LAB_DIR or ~/pi-lab
 *   node scripts/vendor-perch.mjs --ref <ref>
 *   PI_LAB_DIR=/path/to/pi-lab node scripts/vendor-perch.mjs
 *   node scripts/vendor-perch.mjs --dry-run             # report only, write nothing
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { computePayloadDigest, listPayloadFiles } from "./check-vendored-payloads.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Test seam only (repo idiom): lets the round-trip test vendor into a scratch
// bundle dir instead of the real one. Unset in every real invocation.
const BUNDLE_DIR = process.env.PERCH_VENDOR_BUNDLE_DIR || join(REPO_ROOT, "bundles", "perch-hub");
const PAYLOAD_DIR = join(BUNDLE_DIR, "payload");
const MANIFEST_PATH = join(BUNDLE_DIR, "manifest.json");

/**
 * The pinned file list. Deliberately explicit rather than a directory glob:
 * vendoring by glob is how an unreviewed upstream file silently enters the
 * product. Adding a file here is a reviewable diff.
 */
export const PINNED_FILES = [
  "hub/server.mjs",
  "hub/auth-source.mjs",
  "hub/bots-page.mjs",
  "lib/sessions.mjs",
];

const DEFAULT_REF = "crow-mode";

function fail(message) {
  console.error(`vendor-perch: ${message}`);
  process.exit(1);
}

function git(dir, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", ["-C", dir, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Read one path at one ref. Returns a Buffer, or null when the path does not
 * exist at that ref (git exits non-zero — the caller turns that into a clear
 * "not present upstream yet" message rather than a raw git stack).
 */
export function readAtRef(piLabDir, ref, relPath) {
  try {
    return git(piLabDir, ["show", `${ref}:${relPath}`], { encoding: "buffer" });
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const refIdx = argv.indexOf("--ref");
  return {
    ref: refIdx !== -1 && argv[refIdx + 1] ? argv[refIdx + 1] : DEFAULT_REF,
    dryRun: argv.includes("--dry-run"),
  };
}

/** Bump the patch component of a semver-ish "x.y.z" string. */
export function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(version || ""));
  if (!m) return "0.1.1";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] || ""}`;
}

function main() {
  const { ref, dryRun } = parseArgs(process.argv.slice(2));
  const piLabDir = process.env.PI_LAB_DIR || join(homedir(), "pi-lab");

  if (!existsSync(join(piLabDir, ".git"))) {
    fail(`no git repository at ${piLabDir} — set PI_LAB_DIR to a pi-lab checkout`);
  }

  let commit;
  try {
    commit = git(piLabDir, ["rev-parse", ref]).trim();
  } catch {
    fail(`ref "${ref}" does not exist in ${piLabDir} — fetch it, or pass --ref <existing ref>`);
  }

  // Read EVERY pinned file before writing anything: a half-vendored payload
  // whose digest happens to compute is worse than a clean refusal.
  const contents = new Map();
  const missing = [];
  for (const rel of PINNED_FILES) {
    const buf = readAtRef(piLabDir, ref, rel);
    if (buf === null) missing.push(rel);
    else contents.set(rel, buf);
  }
  if (missing.length) {
    fail(
      `pinned file(s) not present at ${ref} (${commit.slice(0, 12)}) in ${piLabDir}:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\nLand the upstream work on that ref first (PL-1/PL-2), then re-run. Nothing was written.`,
    );
  }

  const isoDate = new Date().toISOString();
  if (dryRun) {
    console.log(`vendor-perch: DRY RUN — ${PINNED_FILES.length} files at ${ref} (${commit}), nothing written`);
    for (const rel of PINNED_FILES) console.log(`  ${rel}  ${contents.get(rel).length} bytes`);
    return;
  }

  // Replace the payload wholesale so a file removed from PINNED_FILES cannot
  // linger (a stale file would still be inside the digest and look "verified").
  rmSync(PAYLOAD_DIR, { recursive: true, force: true });
  mkdirSync(PAYLOAD_DIR, { recursive: true });
  for (const rel of PINNED_FILES) {
    const dest = join(PAYLOAD_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents.get(rel));
  }
  writeFileSync(join(PAYLOAD_DIR, "UPSTREAM"), `${commit}\n${isoDate}\n`);

  const digest = computePayloadDigest(PAYLOAD_DIR);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const previous = manifest.payload_sha256;
  manifest.version = bumpPatch(manifest.version);
  manifest.payload_sha256 = digest;
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const files = listPayloadFiles(PAYLOAD_DIR);
  console.log(`vendor-perch: ${files.length} files from ${piLabDir} @ ${ref} (${commit})`);
  for (const f of files) console.log(`  payload/${f}`);
  console.log(`  version      ${manifest.version}`);
  console.log(`  payload_sha256 ${digest}${previous && previous !== digest ? ` (was ${previous})` : ""}`);
  console.log(
    manifest.draft === true
      ? "\nStill draft: flip \"draft\": false and run `npm run build-registry` to publish."
      : "\nRun `npm run build-registry` to refresh registry/add-ons.json.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
