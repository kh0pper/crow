#!/usr/bin/env node
/**
 * Read-only dry run of the boot-time bundle skill sync for one Crow home
 * (servers/gateway/bundle-skill-sync.js). Prints, per installed bundle skill,
 * what the next gateway boot with CROW_SKILL_SYNC=on would do, then a count
 * per action. Writes nothing: not a skill file, not the record.
 *
 *   node scripts/ops/skill-sync-report.mjs --home <CROW_HOME> [--app <repo>]
 *
 * --home defaults to $CROW_HOME, then ~/.crow. --app is the checkout whose
 * bundles/ the gateway copies from (default: this script's repo).
 *
 * Run it for every instance before deploying a change that ships skills.
 * Any "kept-edited" or "kept-unverified" line is stop-and-look: that copy
 * differs from every version we shipped and will NOT be updated.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { syncBundleSkills, readSkillLedger } from "../../servers/gateway/bundle-skill-sync.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const home = resolve(opt("--home") || process.env.CROW_HOME || join(homedir(), ".crow"));
const app = resolve(opt("--app") || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const appBundles = join(app, "bundles");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const raw = readJson(join(home, "installed.json"));
const installed = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([id, v]) => ({ id, ...v })) : [];
const ledger = readSkillLedger(appBundles);
console.log(`skill sync report — home ${home}, source ${appBundles}`);
const counts = {};
for (const entry of installed) {
  const id = typeof entry === "string" ? entry : entry && entry.id;
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 64) continue;
  const src = join(appBundles, id);
  if (!existsSync(src)) continue;   // not first-party: the boot sync skips it too
  const { lines } = syncBundleSkills({
    id, src, manifest: readJson(join(src, "manifest.json")), installedManifest: readJson(join(home, "bundles", id, "manifest.json")),
    mode: "report", skillsDir: join(home, "skills"), recordPath: join(home, "skill-installs.json"), ledger, log: () => {},
  });
  for (const l of lines) {
    counts[l.action] = (counts[l.action] || 0) + 1;
    console.log(`  ${l.action.padEnd(16)} ${l.bundle}/${l.skill}`);
  }
}
console.log("summary: " + (Object.keys(counts).sort().map((k) => `${k} ${counts[k]}`).join(", ") || "nothing to sync"));
if (counts["kept-edited"] || counts["kept-unverified"]) console.log("STOP AND LOOK: kept copies will not be updated.");
