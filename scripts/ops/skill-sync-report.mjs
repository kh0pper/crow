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
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { skillSyncPlan } from "../../servers/gateway/skills-catalog.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const home = resolve(opt("--home") || process.env.CROW_HOME || join(homedir(), ".crow"));
const app = resolve(opt("--app") || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const appBundles = join(app, "bundles");

// The same report-mode pass the Skills panel reads (skills-catalog.js), so
// this CLI and the panel can never disagree about what the next boot does.
console.log(`skill sync report — home ${home}, source ${appBundles}, mode report (writes nothing; shows what a boot with CROW_SKILL_SYNC=on would do)`);
const { lines } = skillSyncPlan({ crowHome: home, appBundles, mode: "report" });
const counts = {};
for (const l of lines) {
  counts[l.action] = (counts[l.action] || 0) + 1;
  console.log(`  ${l.action.padEnd(16)} ${l.bundle}/${l.skill}`);
}
console.log("summary: " + (Object.keys(counts).sort().map((k) => `${k} ${counts[k]}`).join(", ") || "nothing to sync"));
if (counts["kept-edited"] || counts["kept-unverified"]) console.log("STOP AND LOOK: kept copies will not be updated.");
