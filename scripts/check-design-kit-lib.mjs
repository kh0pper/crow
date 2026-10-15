#!/usr/bin/env node
/**
 * Design kit library check (CI `static-checks`; spec §3.2, §7): every hash,
 * every licence file, exact pins, no CSS that fetches, and no remote URL in the
 * kit's code or skills. Fix a failure by re-running
 * `node scripts/design-kit/vendor-lib.mjs` (never by editing a hash by hand).
 *   node scripts/check-design-kit-lib.mjs [--root <repo>]
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLib, checkNoRemoteRefs } from "../bundles/design-kit/server/lib-check.js";

const args = process.argv.slice(2);
const at = args.indexOf("--root");
const ROOT = at >= 0 ? resolve(args[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kit = join(ROOT, "bundles", "design-kit");
const lib = checkLib(join(kit, "lib"));
const errors = [...lib.errors, ...checkNoRemoteRefs(kit)];
if (errors.length) {
  console.error("Design kit library check FAILED:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`Design kit library check: ${lib.entries} entries verified`);
