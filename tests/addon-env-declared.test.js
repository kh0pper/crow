/**
 * Every environment key an installed add-on's server code reads must be one the
 * gateway actually hands it: the base allowlist, the key its repo manifest
 * declares (`server.envKeys` / `env_vars[].name`), a key the manifest derives,
 * or an exemption below.
 *
 * This is the CI half of the env pass. It reads the published registry (the
 * repo manifests, not the installed copies) and the bundle's own server code.
 * A key read here that nothing declares reads as undefined in a gateway-spawned
 * child — that is the bug this check exists to catch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredEnvKeys, isAddonBaseKey } from "../servers/gateway/addon-env.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLES = join(ROOT, "bundles");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "registry", "add-ons.json"), "utf8"))["add-ons"];

/** Files whose code runs as (or as part of) the add-on's own server. */
const SOURCE_FILE = /\.(js|mjs|cjs|py)$/;
const MAX_DEPTH = 6;

/**
 * Keys a bundle reads with a default and never needs from the gateway. Each one
 * says where it is set instead. Keep this list short; a key whose value lives in
 * the gateway's .env belongs in that bundle's manifest, not here.
 */
const GLOBAL_EXEMPT = {
  USERPROFILE: "Windows home fallback, read after HOME and never set on this host",
  CROW_SKIP_CONFIRM_GATES: "gateway-wide safety bypass, read as === \"1\"; a child that does not see it keeps its gates on",
};

const EXEMPT = {
  browser: {
    CROW_BROWSER_CDP_URL: "override for the CDP endpoint, otherwise built from CROW_BROWSER_CDP_PORT",
  },
  vaultwarden: {
    VAULTWARDEN_DATA_DIR: "the data folder is set in the bundle's .env for compose; the child falls back to the same default",
  },
  workspace: {
    WORKSPACE_NC_INTERNAL_URL: "internal service URL, defaults to the published loopback port",
    WORKSPACE_OO_INTERNAL_URL: "internal service URL, defaults to the published loopback port",
    WORKSPACE_NC_INSTANCE_ID: "read as a fallback after the bundle's own .env, where bootstrap writes it",
  },
};

/** Reads whose key comes from a variable, per file: no static check can judge them. */
const DYNAMIC_READ_FILES = {
  "browser/server/instance.js": "setting(key): process.env over the bundle's own .env, for the CROW_BROWSER_* names its manifest declares",
  "pm-workspace/server/config.js": "loadConfig(): process.env over <CROW_HOME>/env/pm-workspace.env, one key of its own list at a time",
  "reader/server/config.js": "loadConfig(): process.env over <CROW_HOME>/env/reader.env, one key of its own list at a time",
  "sunvox-studio/server/outputs.js": "envInt(k): the SUNVOX_*/STORAGE_QUOTA_MB knobs, each read with a default",
  "sunvox-studio/server/sunvox-engine.js": "envInt(k): the SUNVOX_* knobs, each read with a default",
};

const JS_READS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
];
const JS_DESTRUCTURE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*process\.env/g;
const PY_READS = [
  /os\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];
/** `process.env[name]`: the key is a variable, so no static check can judge it. */
const JS_DYNAMIC = /process\.env\s*\[\s*(?!["'`])/;

function sourceFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path, depth + 1));
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every environment key name `text` reads literally, as `KEY` entries. */
function literalEnvReads(text, file) {
  const keys = [];
  for (const re of JS_READS) for (const m of text.matchAll(re)) keys.push(m[1]);
  for (const m of text.matchAll(JS_DESTRUCTURE)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.push(name);
    }
  }
  if (file.endsWith(".py")) for (const re of PY_READS) for (const m of text.matchAll(re)) keys.push(m[1]);
  return keys;
}

/** The keys a manifest allows: declared, derived, or the Crow host marker. */
function manifestKeys(manifest) {
  const keys = new Set(declaredEnvKeys(manifest));
  for (const key of Object.keys(manifest?.connect?.derived_env || {})) keys.add(key);
  keys.add("CROW_ADDON_HOST");
  return keys;
}

const withServer = REGISTRY.filter((entry) => {
  const server = entry?.server;
  if (!server || typeof server !== "object") return false;
  return existsSync(join(BUNDLES, entry.id, "server"));
});

test("every bundle with a stdio server is scanned and declares what its code reads", () => {
  const problems = [];
  const dynamic = [];
  for (const manifest of withServer) {
    const id = manifest.id;
    const allowed = manifestKeys(manifest);
    const exempt = { ...GLOBAL_EXEMPT, ...(EXEMPT[id] || {}) };
    for (const file of sourceFiles(join(BUNDLES, id, "server"))) {
      const rel = relative(BUNDLES, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        if (JS_DYNAMIC.test(line)) dynamic.push(rel);
      }
      for (const key of literalEnvReads(text, rel)) {
        if (isAddonBaseKey(key) || allowed.has(key) || Object.hasOwn(exempt, key)) continue;
        problems.push(`${id}: ${rel}: ${key}`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [], "these keys are read but not delivered to the add-on");
  assert.deepEqual([...new Set(dynamic)], Object.keys(DYNAMIC_READ_FILES), "a read whose key is a variable must be listed");
  assert.ok(withServer.length > 30, "the registry scan found the bundle servers");
});

test("every exemption is still needed, so the list cannot rot", () => {
  const scanned = new Set();
  for (const manifest of withServer) {
    for (const file of sourceFiles(join(BUNDLES, manifest.id, "server"))) {
      scanned.add(`${manifest.id}:${readFileSync(file, "utf8")}`);
    }
  }
  const all = [...scanned].join("\n");
  for (const [key, why] of Object.entries(GLOBAL_EXEMPT)) {
    assert.ok(all.includes(`.${key}`) || all.includes(`["${key}"]`), `GLOBAL_EXEMPT ${key} is no longer read anywhere (${why})`);
  }
  for (const [id, keys] of Object.entries(EXEMPT)) {
    assert.ok(withServer.some((m) => m.id === id), `EXEMPT names bundle ${id}, which has no server`);
    for (const key of Object.keys(keys)) {
      assert.ok(all.includes(`.${key}`) || all.includes(`["${key}"]`), `EXEMPT ${id}:${key} is no longer read`);
    }
  }
  for (const [file, why] of Object.entries(DYNAMIC_READ_FILES)) {
    assert.ok(existsSync(join(BUNDLES, file)), `DYNAMIC_READ_FILES names ${file}, which is gone (${why})`);
  }
});