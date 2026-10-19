/**
 * Folder grants (queue item 30, follow-up B): the host folders OUTSIDE Crow's home that
 * the owner allowed an extension to mount.
 *
 * The install security check (compose-guard.js) admits a host path outside Crow's home and
 * data folder only under one of these. A grant is key + value: `bundleId → KEY → folder`,
 * and it counts only while that key's CURRENT .env value still leads to the same folder.
 * So a hand edit, a value a peer instance set, a CLI install's value or a changed value is
 * not granted; uninstall leaves grants in place, so a reinstall that restores a retained
 * value is still granted (only for the same bundle, key and folder).
 *
 * Only the gateway writes the store (CROW_HOME/folder-grants.json), from the owner's own
 * local dashboard session; no container can mount CROW_HOME's files. Every change is a
 * read-modify-write of the live file.
 *
 * Node builtins + compose-guard only (bundles-config.js imports this).
 */
import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, isAbsolute, resolve as resolvePath, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { looksLikeHostPath, resolveHostPath, parseDotEnv } from "./compose-guard.js";

export const GRANTS_FILE = "folder-grants.json";
const ID = /^[a-z0-9][a-z0-9._-]*$/;

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

export function grantsPath(crowHome) { return join(crowHome, GRANTS_FILE); }

export function readGrants(crowHome) {
  try {
    const d = JSON.parse(readFileSync(grantsPath(crowHome), "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

function writeGrants(crowHome, data) {
  const p = grantsPath(crowHome);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

/** Apply `fn(data)` to the live store and write it back. */
export function updateGrants(crowHome, fn) {
  const data = readGrants(crowHome);
  fn(data);
  writeGrants(crowHome, data);
  return data;
}

/** A typed value as an absolute host path (`~/` expanded), or null. */
export function hostPathOf(value, home = homedir()) {
  if (!looksLikeHostPath(value)) return null;
  const abs = resolvePath(value.startsWith("~/") ? join(home, value.slice(2)) : value);
  return isAbsolute(abs) ? abs : null;
}

/** Names a compose text interpolates (`${NAME…}` / `$NAME`). */
export function composeReferencedKeys(text) {
  const out = new Set();
  const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) out.add(m[1]);
  return out;
}

/** True when the folder lies outside Crow's home and every data folder. */
export function outsideCrow(p, { crowHome, dataDirs = [] }) {
  const real = resolveHostPath(p);
  return ![crowHome, ...dataDirs].filter(Boolean).some((z) => {
    const zr = resolveHostPath(z);
    return under(real, zr) || under(p, resolvePath(z));
  });
}

/**
 * The grants an owner's install / Configure submission makes: for each submitted key the
 * compose file references, whose value is a host path outside Crow's home, that is not a
 * `secret` key, and that is NOT a value the bundle chose (the manifest's default/example,
 * the .env.example value, the value retained from an earlier install). The modals prefill
 * defaults, so a default is never taken as the owner's choice.
 * @returns {Record<string, {value: string, real: string}>}
 */
export function grantCandidates({ manifest, submitted, composeText, exampleEnv = {}, retained = {}, crowHome, dataDirs = [], home = homedir() }) {
  const used = composeReferencedKeys(composeText);
  const byName = new Map((manifest?.env_vars || []).filter((v) => v && typeof v.name === "string").map((v) => [v.name, v]));
  const out = {};
  for (const [k, v] of Object.entries(submitted || {})) {
    if (!used.has(k) || typeof v !== "string") continue;
    const decl = byName.get(k);
    if (decl?.secret === true) continue;
    const bundleChosen = [decl?.default, decl?.example, exampleEnv[k], retained[k]].filter((x) => typeof x === "string");
    if (bundleChosen.includes(v)) continue;
    const abs = hostPathOf(v, home);
    if (!abs || !outsideCrow(abs, { crowHome, dataDirs })) continue;
    out[k] = { value: v, real: resolveHostPath(abs) };
  }
  return out;
}

/**
 * The folders granted to a bundle that are live: the key's current .env value still leads
 * to the granted folder. Both the folder as written and where it really leads.
 */
export function activeRoots(bundleId, { crowHome, bundleDir, home = homedir(), grants = readGrants(crowHome) }) {
  const mine = grants[bundleId];
  if (!mine || typeof mine !== "object") return [];
  const env = parseDotEnv(join(bundleDir || join(crowHome, "bundles", bundleId), ".env"));
  const out = [];
  for (const [k, g] of Object.entries(mine)) {
    if (!g || typeof g.real !== "string") continue;
    const abs = hostPathOf(env[k], home);
    if (!abs || resolveHostPath(abs) !== g.real) continue;
    for (const r of [abs, g.real]) if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** Every OTHER bundle's live granted folders (no root may nest with one of these). */
export function otherBundlesRoots(bundleId, { crowHome, home = homedir(), grants = readGrants(crowHome) }) {
  const out = [];
  for (const id of Object.keys(grants)) {
    if (id === bundleId || id.startsWith("_") || !ID.test(id)) continue;
    for (const r of activeRoots(id, { crowHome, home, grants })) if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** The bundle's compose-referenced keys whose current value is an outside folder without a live grant. */
export function ungrantedFolderKeys(bundleId, { crowHome, dataDirs = [], home = homedir(), bundleDir = join(crowHome, "bundles", bundleId) }) {
  let text = "";
  try { text = readFileSync(join(bundleDir, "docker-compose.yml"), "utf8"); } catch { return []; }
  const used = composeReferencedKeys(text);
  const env = parseDotEnv(join(bundleDir, ".env"));
  const grants = readGrants(crowHome)[bundleId] || {};
  const out = [];
  for (const k of used) {
    const abs = hostPathOf(env[k], home);
    if (!abs || !outsideCrow(abs, { crowHome, dataDirs })) continue;
    if (grants[k]?.real === resolveHostPath(abs)) continue;
    out.push(k);
  }
  return out;
}

/**
 * One-time migration (the store has no `_migrated` marker yet): every bundle folder under
 * CROW_HOME/bundles with a compose file, with or without an installed.json record, gets
 * grants for its current .env's outside folders — they were accepted under the old rule.
 * After this, no grant means no folder. `exclude`: a bundle being installed right now.
 */
export function migrateGrants({ crowHome, dataDirs = [], home = homedir(), exclude = null }) {
  if (readGrants(crowHome)._migrated) return false;
  const found = {};
  let ids = [];
  try { ids = readdirSync(join(crowHome, "bundles")); } catch { /* none */ }
  for (const id of ids) {
    if (id === exclude || !ID.test(id)) continue;
    const dir = join(crowHome, "bundles", id);
    let text = "";
    try { text = readFileSync(join(dir, "docker-compose.yml"), "utf8"); } catch { continue; }
    const used = composeReferencedKeys(text);
    const env = parseDotEnv(join(dir, ".env"));
    for (const k of used) {
      const abs = hostPathOf(env[k], home);
      if (!abs || !outsideCrow(abs, { crowHome, dataDirs })) continue;
      (found[id] ||= {})[k] = { value: env[k], real: resolveHostPath(abs), at: new Date().toISOString(), migrated: true };
    }
  }
  updateGrants(crowHome, (d) => {
    if (d._migrated) return;
    for (const [id, keys] of Object.entries(found)) d[id] = { ...keys, ...(d[id] || {}) };
    d._migrated = 1;
  });
  return true;
}

/** Record grants for a bundle (replacing those keys). */
export function recordGrants(crowHome, bundleId, grants) {
  if (!Object.keys(grants || {}).length) return;
  const at = new Date().toISOString();
  updateGrants(crowHome, (d) => {
    const mine = (d[bundleId] && typeof d[bundleId] === "object") ? d[bundleId] : {};
    for (const [k, g] of Object.entries(grants)) mine[k] = { value: g.value, real: g.real, at };
    d[bundleId] = mine;
  });
}

/** Drop a bundle's grants for these keys (an owner set them to something else). */
export function dropGrants(crowHome, bundleId, keys) {
  if (!keys.length) return;
  updateGrants(crowHome, (d) => {
    if (!d[bundleId]) return;
    for (const k of keys) delete d[bundleId][k];
  });
}

