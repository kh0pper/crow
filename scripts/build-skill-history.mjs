#!/usr/bin/env node
/**
 * bundles/skill-history.json — the bundle skill ledger (artifacts smoke
 * fixes, S2 fix 3; review H3).
 *
 * { "<bundle>/<skillPath>": ["<sha256>", …] }: the sha256 of every version a
 * shipped skill has had, LF-normalised (servers/gateway/bundle-skill-sync.js
 * skillHash). The boot-time skill sync reads it to tell an UNEDITED stale copy
 * (safe to refresh) from a copy the user changed (kept), with no runtime git:
 * git-archive builds, docker and npm installs have none.
 *
 *   node scripts/build-skill-history.mjs           append the CURRENT hash of
 *                                                  every shipped skill when
 *                                                  missing (run it after editing
 *                                                  a bundle skill; commit the result)
 *   node scripts/build-skill-history.mjs --check   CI (static-checks): fail when
 *                                                  any shipped skill's current
 *                                                  hash is missing. Works on a
 *                                                  shallow checkout.
 *   node scripts/build-skill-history.mjs --seed    ALSO walk each skill's full git
 *                                                  history (needs a full clone;
 *                                                  run once by the author).
 *   --root <repo>                                  operate on another checkout (tests)
 *
 * Append-only: an existing hash is never removed or reordered, so a copy of
 * any past release stays recognisable forever.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { skillHash, manifestSkillPaths, ledgerKey } from "../servers/gateway/bundle-skill-sync.js";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const rootArg = args.indexOf("--root");
const ROOT = rootArg >= 0 ? resolve(args[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(ROOT, "bundles");
const LEDGER = join(BUNDLES, "skill-history.json");

/** Every shipped skill: [{ key, id, path, file }]. */
function shippedSkills() {
  const out = [];
  for (const id of readdirSync(BUNDLES).sort()) {
    const mp = join(BUNDLES, id, "manifest.json");
    if (!existsSync(mp)) continue;
    let m;
    try { m = JSON.parse(readFileSync(mp, "utf8")); } catch { continue; }
    for (const p of manifestSkillPaths(m)) {
      const file = join(BUNDLES, id, p);
      if (existsSync(file)) out.push({ key: ledgerKey(id, p), id, path: p, file });
    }
  }
  return out;
}

function readLedger() {
  if (!existsSync(LEDGER)) return {};
  const j = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
  for (const [k, v] of Object.entries(j)) {
    if (!Array.isArray(v) || v.some((h) => typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h))) throw new Error(`bad entry ${k}`);
  }
  return j;
}

/** Every blob a path has had in this repo's history (renames followed). */
function historyHashes(relPath) {
  const git = (a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const hashes = [];
  let log;
  try { log = git(["log", "--follow", "--format=%H", "--name-only", "--", relPath]); } catch { return hashes; }
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  // Pairs: <sha> then the path it had in that commit.
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[0-9a-f]{40}$/.test(lines[i]) && lines[i + 1] && !/^[0-9a-f]{40}$/.test(lines[i + 1])) { pairs.push([lines[i], lines[i + 1]]); i++; }
  }
  for (const [sha, p] of pairs.reverse()) {   // oldest first
    try { hashes.push(skillHash(git(["show", `${sha}:${p}`]))); } catch { /* deleted in that commit */ }
  }
  return hashes;
}

let ledger;
try { ledger = readLedger(); }
catch (e) {
  console.error(`[skill-history] ${LEDGER} is malformed: ${e.message}`);
  process.exit(1);
}
const skills = shippedSkills();

if (flag("--check")) {
  const missing = skills.filter((s) => !(ledger[s.key] || []).includes(skillHash(readFileSync(s.file))));
  if (missing.length) {
    console.error("[skill-history] these shipped skills changed without a ledger update:");
    for (const s of missing) console.error(`  ${s.key}`);
    console.error("Run: node scripts/build-skill-history.mjs   (then commit bundles/skill-history.json)");
    process.exit(1);
  }
  console.log(`[skill-history] ok: ${skills.length} shipped skills covered`);
  process.exit(0);
}

let added = 0;
const append = (key, h) => { const list = (ledger[key] ||= []); if (!list.includes(h)) { list.push(h); added++; } };
for (const s of skills) {
  if (flag("--seed")) for (const h of historyHashes(`bundles/${s.id}/${s.path}`)) append(s.key, h);
  append(s.key, skillHash(readFileSync(s.file)));
}
const sorted = Object.fromEntries(Object.keys(ledger).sort().map((k) => [k, ledger[k]]));
writeFileSync(LEDGER, JSON.stringify(sorted, null, 2) + "\n");
console.log(`[skill-history] ${added} hash(es) added; ${Object.keys(sorted).length} skills in the ledger`);
