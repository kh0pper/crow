#!/usr/bin/env node
/**
 * Generate `registry/addon-profiles.json` and `registry/addon-past-defaults.json`.
 *
 * The profiles file records the manifest-only profile of every registry entry
 * that declares a `server` (empty entries, so no owner values), including the
 * `refused` reasons. The past-defaults file records every `env_vars[].default`
 * each bundle manifest has ever shipped — the provenance rule for entries
 * written before `ownerSet` existed.
 *
 *   node scripts/build-addon-profiles.mjs           # write both files
 *   node scripts/build-addon-profiles.mjs --check   # exit 1 when either is stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectPastDefaults, isShallowRepo, profileFor } from "./addon-sandbox/profile.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILES_REL = "registry/addon-profiles.json";
const PAST_DEFAULTS_REL = "registry/addon-past-defaults.json";

/** `{ [id]: { [KEY]: string[] } }` for the whole repo. */
export function buildPastDefaults({ repoRoot = REPO_ROOT } = {}) {
  return collectPastDefaults({ repoRoot });
}

/**
 * `{ version: 1, profiles: { <id>: profile } }` (ids sorted) for every registry
 * entry with a `server`. The installed-bundles dir is a path that does not
 * exist: the registry run is the repo copy only.
 */
export function buildProfiles(pastDefaultsAll = {}, { repoRoot = REPO_ROOT } = {}) {
  const registryPath = join(repoRoot, "registry", "add-ons.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const profiles = {};
  for (const entry of Array.isArray(registry?.["add-ons"]) ? registry["add-ons"] : []) {
    if (!entry || !entry.server || typeof entry.id !== "string") continue;
    profiles[entry.id] = profileFor({
      id: entry.id,
      entry: {},
      appBundlesDir: join(repoRoot, "bundles"),
      installedBundlesDir: join(repoRoot, ".no-installed-bundles"),
      pastDefaultsAll,
    });
  }
  const sorted = {};
  for (const id of Object.keys(profiles).sort()) sorted[id] = profiles[id];
  return { version: 1, profiles: sorted };
}

/** `{ version: 1, defaults: <collectPastDefaults result> }`. */
export function buildPastDefaultsDoc(defaults) {
  return { version: 1, defaults };
}

function text(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function readCommitted(rel) {
  try { return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")); } catch { return null; }
}

function main(argv) {
  const check = argv.includes("--check");
  const shallow = isShallowRepo({ repoRoot: REPO_ROOT });

  if (check) {
    let pastDefaultsMap;
    if (shallow) {
      console.log("shallow clone: past-defaults comparison skipped, profiles compared against the committed past-defaults file");
      pastDefaultsMap = readCommitted(PAST_DEFAULTS_REL)?.defaults || {};
    } else {
      pastDefaultsMap = buildPastDefaults();
    }

    const profilesDoc = buildProfiles(pastDefaultsMap);
    const committedProfiles = readCommitted(PROFILES_REL);
    if (JSON.stringify(committedProfiles) !== JSON.stringify(profilesDoc)) {
      console.error(`${PROFILES_REL} is stale — run: node scripts/build-addon-profiles.mjs`);
      return 1;
    }

    if (!shallow) {
      const pastDoc = buildPastDefaultsDoc(pastDefaultsMap);
      const committedPast = readCommitted(PAST_DEFAULTS_REL);
      if (JSON.stringify(committedPast) !== JSON.stringify(pastDoc)) {
        console.error(`${PAST_DEFAULTS_REL} is stale — run: node scripts/build-addon-profiles.mjs`);
        return 1;
      }
    }
    console.log(`${PROFILES_REL} and ${PAST_DEFAULTS_REL} are up to date`);
    return 0;
  }

  if (shallow) {
    console.log("shallow clone: git history is incomplete, so the past-defaults file is written from the history this clone has");
  }
  const pastDefaultsMap = buildPastDefaults();

  const profilesPath = join(REPO_ROOT, PROFILES_REL);
  const existingProfiles = existsSync(profilesPath) ? readFileSync(profilesPath, "utf8") : null;
  const profilesText = text(buildProfiles(pastDefaultsMap));
  if (existingProfiles !== profilesText) writeFileSync(profilesPath, profilesText);
  console.log(`wrote ${PROFILES_REL} (${Object.keys(JSON.parse(profilesText).profiles).length} profiles)`);

  const pastDefaultsPath = join(REPO_ROOT, PAST_DEFAULTS_REL);
  const existingPast = existsSync(pastDefaultsPath) ? readFileSync(pastDefaultsPath, "utf8") : null;
  const pastText = text(buildPastDefaultsDoc(pastDefaultsMap));
  if (existingPast !== pastText) writeFileSync(pastDefaultsPath, pastText);
  console.log(`wrote ${PAST_DEFAULTS_REL} (${Object.keys(pastDefaultsMap).length} add-ons)`);
  return 0;
}

const invokedDirectly = typeof process.argv[1] === "string"
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));