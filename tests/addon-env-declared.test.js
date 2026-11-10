/**
 * Every environment key an installed add-on's server code reads must be one the
 * gateway actually hands it: the base allowlist, a key its registry entry
 * declares (`server.envKeys` / `env_vars[].name`), one of the storage keys the
 * four storage-reading bundles keep, or an exemption below.
 *
 * This is the CI half of the env pass. It reads the published registry (the
 * reviewed entries, not whatever a checkout's bundles/ folder holds) and the
 * bundle's own server code, plus the app modules a server `appImport`s — those
 * run in the same child, so an env read inside one is an add-on's read too.
 *
 * A read whose key is never delivered reads as undefined in a gateway-spawned
 * child — that is the bug this check exists to catch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STORAGE_ENV_KEYS, declaredEnvKeys, isAddonBaseKey, isDeniedAddonKey, isStorageEnvConsumer,
} from "../servers/gateway/addon-env.js";

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
  CROW_FOR_YOU: "gateway feature flag (=== \"1\"); a child that does not see it keeps the feature off, which is the default",
  CROW_KIOSK_STT_HOTWORDS: "operator switch for the hotwords experiment, read as === \"1\"; a child that does not see it keeps hotwords off, the shipped default",
  PI_BOT_ID: "set by the bot engine in a bot's own spawn_env, never in the gateway's environment",
  PI_BOT_PERCH_SESSION_ID: "set by the bot engine in a bot's own spawn_env, never in the gateway's environment",
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

/**
 * App modules an add-on's own server `appImport`s — they run in the child, so
 * their env reads are the add-on's. `keys` is every key the module reads
 * statically (asserted against the file below, so the list cannot drift); an
 * entry in `exempt` says why that key is deliberately not handed over.
 */
const APP_MODULES = {
  "servers/db.js": {
    keys: ["CROW_DATA_DIR", "CROW_DB_PATH", "HOME", "USERPROFILE", "CROW_JOURNAL_MODE", "CROW_WAL_MIN_RAM_GB", "CROW_TEST_TOTALMEM", "CROW_WAL_TRIPWIRE_MS"],
    exempt: {
      CROW_JOURNAL_MODE: "gateway DB tuning knob; a child uses db.js's default for the same file CROW_DB_PATH points at",
      CROW_WAL_MIN_RAM_GB: "gateway DB tuning knob, defaulted; the child opens the same db with the same default",
      CROW_WAL_TRIPWIRE_MS: "gateway DB tuning knob, defaulted; the child opens the same db with the same default",
      CROW_TEST_TOTALMEM: "test seam (the memory reader is stubbed in tests), never set on a real host",
    },
  },
  "servers/storage/s3-client.js": { keys: [...STORAGE_ENV_KEYS], exempt: {} },
  "servers/sharing/identity.js": { keys: ["CROW_DATA_DIR", "HOME", "USERPROFILE"], exempt: {} },
  "servers/blog/figure-renderer.js": {
    keys: ["HOME", "BLOG_FIGURE_PYTHON"],
    exempt: { BLOG_FIGURE_PYTHON: "a developer override for the local Python that renders figures; the module finds its default venv by itself" },
  },
  "servers/blog/figures-bucket.js": {
    keys: ["CROW_BLOG_FIGURES_BUCKET", "BLOG_FIGURE_GATEWAY_URL"],
    exempt: {
      CROW_BLOG_FIGURES_BUCKET: "defaults to the same bucket name the gateway uses (blog-figures); naming another one is a later phase",
      BLOG_FIGURE_GATEWAY_URL: "defaults to this instance's own gateway port, which IS passed (CROW_GATEWAY_PORT/PORT)",
    },
  },
  "servers/shared/crow-home.js": {
    keys: ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_ALLOW_SHARED_DATA_DIR"],
    exempt: { CROW_ALLOW_SHARED_DATA_DIR: "the waiver for the boot-time instance-identity check; a child that does not see it never takes the waive path" },
  },
  "servers/gateway/dashboard/auth.js": {
    keys: ["CROW_HOSTED", "CROW_HOSTING_API_URL", "CROW_HOSTING_AUTH_TOKEN", "CROW_ALLOWED_IPS", "CROW_DASHBOARD_PUBLIC", "NODE_ENV"],
    exempt: {
      CROW_HOSTED: "set only on the hosted control plane; unset means the gateway is self-hosted, which is what the child must assume",
      CROW_HOSTING_API_URL: "read only inside the CROW_HOSTED branch, which a child never enters",
      CROW_HOSTING_AUTH_TOKEN: "the hosting control plane's own credential, read only inside the CROW_HOSTED branch a child never enters",
      CROW_ALLOWED_IPS: "the gateway's own client allowlist; a bundle server judges no network peers",
      CROW_DASHBOARD_PUBLIC: "the gateway's own exposure switch; a bundle server judges no network peers",
    },
  },
  "servers/gateway/dashboard/totp.js": {
    keys: ["CROW_HOSTED"],
    exempt: { CROW_HOSTED: "set only on the hosted control plane; a self-hosted child keeps the local-password path" },
  },
  "servers/gateway/dashboard/local-session.js": { keys: [], exempt: {} },
  "servers/gateway/for-you/flag.js": {
    keys: ["CROW_FOR_YOU"],
    exempt: { CROW_FOR_YOU: "gateway feature flag (=== \"1\"); a child that does not see it keeps the feature off, which is the default" },
  },
  "servers/gateway/media/pinned-upstream.js": {
    keys: ["FUNKWHALE_URL", "FUNKWHALE_ACCESS_TOKEN", "FUNKWHALE_STORAGE_ORIGIN"],
    exempt: {
      FUNKWHALE_URL: "the Funkwhale add-on's own entry in mcp-addons.json is read first (via CROW_HOME, which IS passed); the env fallback is for a hand-set gateway variable",
      FUNKWHALE_ACCESS_TOKEN: "the Funkwhale add-on's own entry in mcp-addons.json is read first (via CROW_HOME, which IS passed); the env fallback is for a hand-set gateway variable",
      FUNKWHALE_STORAGE_ORIGIN: "the Funkwhale add-on's own entry in mcp-addons.json is read first (via CROW_HOME, which IS passed); the env fallback is for a hand-set gateway variable",
    },
  },
  "servers/gateway/push/web-push.js": {
    keys: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_EMAIL", "CROW_PUSH_SEND_TIMEOUT_MS"],
    exempt: {
      VAPID_PUBLIC_KEY: "the gateway's push key pair stays in the gateway; without it initWebPush is a no-op and a bundle notifies through servers/shared/notifications.js",
      VAPID_PRIVATE_KEY: "the gateway's push key pair stays in the gateway (deny-listed); initWebPush is then a no-op",
      VAPID_EMAIL: "only read to configure that same key pair",
      CROW_PUSH_SEND_TIMEOUT_MS: "gateway-wide push timeout, defaulted; a no-op push never uses it",
    },
  },
  "servers/gateway/dashboard/settings/registry.js": { keys: ["CROW_HOME"], exempt: {} },
  "servers/shared/sqlite-datasets.js": { keys: ["CROW_DB_PATH", "PATH"], exempt: {} },
  "servers/shared/project-spaces.js": { keys: ["CROW_DB_PATH"], exempt: {} },
  "servers/shared/rate-limiter.js": { keys: [], exempt: {} },
  "servers/shared/notifications.js": { keys: [], exempt: {} },
  "servers/shared/sync-emit.js": { keys: [], exempt: {} },
  "servers/shared/bot-mention.js": { keys: [], exempt: {} },
  "servers/shared/fetch-page.js": { keys: [], exempt: {} },
  "servers/shared/ip-classify.js": { keys: [], exempt: {} },
  "servers/shared/sqlite-lock.js": { keys: [], exempt: {} },
  "servers/shared/artifact-trust.js": { keys: [], exempt: {} },
  "servers/shared/project-acl.js": { keys: [], exempt: {} },
  "servers/shared/peer-class.js": {
    keys: ["CROW_SERVE_PEER_UIDS"],
    exempt: { CROW_SERVE_PEER_UIDS: "the gateway's Tailscale Serve identity policy; a child that does not see it trusts no Serve headers, the conservative direction" },
  },
  "servers/shared/design-kit.js": { keys: [], exempt: {} },
  "servers/shared/relative-dates.js": { keys: [], exempt: {} },
  "servers/shared/browser-lease.js": { keys: [], exempt: {} },
  "servers/shared/confirm.js": {
    keys: ["CROW_SKIP_CONFIRM_GATES"],
    exempt: { CROW_SKIP_CONFIRM_GATES: "gateway-wide safety bypass, read as === \"1\"; a child that does not see it keeps its gates on" },
  },
  "servers/gateway/session-taint-memory.js": { keys: [], exempt: {} },
  "servers/gateway/bundle-env-codec.js": { keys: [], exempt: {} },
  "servers/gateway/for-you/settings.js": { keys: [], exempt: {} },
  "servers/gateway/for-you/weather.js": { keys: [], exempt: {} },
  "servers/gateway/board/util.js": { keys: [], exempt: {} },
  "servers/gateway/ai/tts/index.js": { keys: [], exempt: {} },
  "servers/research/actor.js": { keys: [], exempt: {} },
  "scripts/pi-bots/bot-jobs-schema.mjs": { keys: [], exempt: {} },
  "scripts/pi-bots/actor-env.mjs": { keys: [], exempt: {} },
};

/** A quote character class built from an array so this file needs no nested quoting. */
const QUOTES = ["[", '"', "'", "`", "]"].join("");

const JS_READS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  // process.env["X"], process.env['X'] and process.env[`X`]
  new RegExp("process\\.env\\s*\\[\\s*" + QUOTES + "([A-Za-z_][A-Za-z0-9_]*)" + QUOTES + "\\s*\\]", "g"),
];
/** `const env = process.env`, `function f(env = process.env)`: a local alias of the environment. */
const JS_ALIAS = /([A-Za-z_$][\w$]*)\s*=\s*process\.env(?![\w.[$])/g;
const JS_DESTRUCTURE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*process\.env/g;
const PY_READS = [
  /os\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];
/** `process.env[name]`: the key is a variable, so no static check can judge it. */
const JS_DYNAMIC = /process\.env\s*\[\s*(?!["'`])/;
/** `appImport("servers/db.js")`: app code the add-on's own process loads. */
const APP_IMPORT = /appImport\(\s*["']([^"']+)["']/g;

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

const escapeRe = (s) => s.replace(/[$]/g, "\\$");

/**
 * The text with comments and string/template bodies blanked to spaces, so a brace
 * position still lines up. Used only to find the block an alias belongs to.
 */
function blanked(text) {
  const out = text.split("");
  let i = 0;
  let mode = null; // null | "line" | "block" | the quote character
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === null) {
      if (c === "/" && next === "/") { mode = "line"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === "/" && next === "*") { mode = "block"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { mode = c; out[i] = " "; i += 1; continue; }
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = null;
      else out[i] = " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { out[i] = " "; out[i + 1] = " "; mode = null; i += 2; continue; }
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // Inside a quoted string: a backslash escapes the next character; the quote ends it.
    if (c === "\\") { out[i] = " "; out[i + 1] = " "; i += 2; continue; }
    if (c === mode) { out[i] = " "; mode = null; i += 1; continue; }
    if (c !== "\n") out[i] = " ";
    i += 1;
  }
  return out.join("");
}

/** The `[start, end)` span of the block opening at `open`, or null when it never closes. */
function blockAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  return null;
}

/** Every `alias = process.env` in `text`, as `{alias, at}`. */
function aliasIntros(text) {
  const intros = [];
  for (const m of text.matchAll(JS_ALIAS)) intros.push({ alias: m[1], at: m.index + m[0].indexOf(m[1]) });
  return intros;
}

/** The `[start, end)` span of the block containing `at`, or the whole file when none does. */
function enclosingBlock(code, at) {
  const stack = [];
  for (let i = 0; i < at && i < code.length; i += 1) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") stack.pop();
  }
  if (!stack.length) return [0, code.length]; // a module-level alias
  return blockAt(code, stack[stack.length - 1]) || [0, code.length];
}

/**
 * Where an alias introduced at `at` counts as the environment.
 *
 * A parameter default (`function f(env = process.env)`) counts inside that function's
 * body — the block after its parameter list — or on its own line for a concise arrow.
 * A variable alias (`const env = process.env`) counts inside the block it was declared
 * in. A plain parameter that is NOT the environment is never in the set: e.g.
 * `kioskMusicConfig(env, …)` takes a caller's dict. (A module-level alias does make a
 * same-named parameter elsewhere over-report; over-reporting is the safe direction —
 * the fix is an exemption that says why the key is not handed over.)
 */
function aliasSpan(code, at) {
  const before = code.slice(0, at).replace(/\s+$/, "");
  const isParam = before.endsWith("(") || before.endsWith(",");
  if (!isParam) return enclosingBlock(code, at);
  // Walk back to the '(' that opens the parameter list this parameter belongs to.
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i -= 1) {
    if (code[i] === ")") depth += 1;
    else if (code[i] === "(") {
      if (depth === 0) { open = i; break; }
      depth -= 1;
    }
  }
  if (open === -1) return enclosingBlock(code, at);
  depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth !== 0) continue;
      const lineEnd = code.indexOf("\n", i);
      const rest = code.slice(i + 1, lineEnd === -1 ? code.length : lineEnd);
      const brace = rest.indexOf("{");
      if (brace !== -1) return blockAt(code, i + 1 + brace) || [at, code.length];
      return [at, lineEnd === -1 ? code.length : lineEnd];
    }
  }
  return enclosingBlock(code, at);
}

/** Every environment key name `text` reads, as `KEY` entries. */
function literalEnvReads(text, file) {
  const keys = [];
  for (const re of JS_READS) for (const m of text.matchAll(re)) keys.push(m[1]);
  // Reads through a local alias of process.env: env.X, env?.X and env["X"].
  const code = blanked(text);
  for (const { alias, at } of aliasIntros(text)) {
    const [from, to] = aliasSpan(code, at);
    const a = escapeRe(alias);
    const body = text.slice(from, to);
    for (const m of body.matchAll(new RegExp("\\b" + a + "(?:\\?\\.|\\.)\\s*([A-Z_][A-Z0-9_]*)\\b", "g"))) keys.push(m[1]);
    for (const m of body.matchAll(new RegExp("\\b" + a + "\\s*\\[\\s*" + QUOTES + "([A-Z_][A-Z0-9_]*)" + QUOTES + "\\s*\\]", "g"))) keys.push(m[1]);
  }
  for (const m of text.matchAll(JS_DESTRUCTURE)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.push(name);
    }
  }
  if (file.endsWith(".py")) for (const re of PY_READS) for (const m of text.matchAll(re)) keys.push(m[1]);
  return keys;
}

/** The keys a registry entry allows: declared and not deny-listed, plus the Crow host marker. */
function manifestKeys(entry) {
  const keys = new Set(declaredEnvKeys(entry).filter((k) => !isDeniedAddonKey(k)));
  for (const key of Object.keys(entry?.connect?.derived_env || {})) keys.add(key);
  keys.add("CROW_ADDON_HOST");
  return keys;
}

/** Every key `entry` really receives from the gateway's environment (declared, or storage for the four). */
function deliveredKeys(entry) {
  const keys = manifestKeys(entry);
  if (isStorageEnvConsumer(entry.id)) for (const key of STORAGE_ENV_KEYS) keys.add(key);
  return keys;
}

const withServer = REGISTRY.filter((entry) => {
  const server = entry?.server;
  if (!server || typeof server !== "object") return false;
  return existsSync(join(BUNDLES, entry.id, "server"));
});

/** Every bundle folder with server code, published or not (an unpublished bundle is not scanned for keys). */
const allServerBundles = readdirSync(BUNDLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(BUNDLES, d.name, "server")))
  .map((d) => d.name);

test("every bundle with a stdio server is scanned and declares what its code reads", () => {
  const problems = [];
  const dynamic = [];
  for (const entry of withServer) {
    const id = entry.id;
    const delivered = deliveredKeys(entry);
    const exempt = { ...GLOBAL_EXEMPT, ...(EXEMPT[id] || {}) };
    for (const file of sourceFiles(join(BUNDLES, id, "server"))) {
      const rel = relative(BUNDLES, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (JS_DYNAMIC.test(line)) dynamic.push(rel);
      }
      for (const key of literalEnvReads(text, rel)) {
        if (isAddonBaseKey(key) || delivered.has(key) || Object.hasOwn(exempt, key)) continue;
        problems.push(`${id}: ${rel}: ${key}`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [], "these keys are read but not delivered to the add-on");
  assert.deepEqual([...new Set(dynamic)], Object.keys(DYNAMIC_READ_FILES), "a read whose key is a variable must be listed");
  assert.ok(withServer.length > 30, "the registry scan found the bundle servers");
});

test("an app module a server appImports is scanned too, and its env reads are accounted for", () => {
  const problems = [];
  const imported = new Map(); // module -> [bundle ids]
  for (const entry of withServer) {
    const delivered = deliveredKeys(entry);
    const exempt = { ...GLOBAL_EXEMPT, ...(EXEMPT[entry.id] || {}) };
    for (const file of sourceFiles(join(BUNDLES, entry.id, "server"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(APP_IMPORT)) {
        const mod = m[1];
        if (!mod.startsWith("servers/") && !mod.startsWith("scripts/")) continue;
        if (!imported.has(mod)) imported.set(mod, new Set());
        imported.get(mod).add(entry.id);
        const known = APP_MODULES[mod];
        if (!known) { problems.push(`${entry.id}: ${mod} is appImported but not in APP_MODULES`); continue; }
        const path = join(ROOT, mod);
        if (!existsSync(path)) { problems.push(`${mod} (appImported by ${entry.id}) does not exist`); continue; }
        for (const key of new Set(literalEnvReads(readFileSync(path, "utf8"), mod))) {
          if (isAddonBaseKey(key) || delivered.has(key) || Object.hasOwn(known.exempt, key) || Object.hasOwn(exempt, key)) continue;
          problems.push(`${entry.id}: ${mod}: ${key}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [], "an app module reads a key the add-on never gets");
  // No rot: every curated module is really imported, and every exemption is still needed.
  const importedAnywhere = new Set();
  for (const id of allServerBundles) {
    for (const file of sourceFiles(join(BUNDLES, id, "server"))) {
      for (const m of readFileSync(file, "utf8").matchAll(APP_IMPORT)) {
        if (m[1].startsWith("servers/") || m[1].startsWith("scripts/")) importedAnywhere.add(m[1]);
      }
    }
  }
  for (const [mod, ids] of imported) {
    assert.ok(APP_MODULES[mod], `${mod} is appImported by ${[...ids].join(", ")} but not curated`);
  }
  for (const [mod, spec] of Object.entries(APP_MODULES)) {
    assert.ok(importedAnywhere.has(mod), `APP_MODULES lists ${mod}, which no bundle server appImports`);
    const reads = new Set(literalEnvReads(readFileSync(join(ROOT, mod), "utf8"), mod));
    assert.deepEqual([...reads].sort(), [...spec.keys].sort(), `${mod}: the curated key list must match the module's reads`);
    for (const [key, why] of Object.entries(spec.exempt)) {
      assert.ok(reads.has(key), `APP_MODULES ${mod}: ${key} is exempted but no longer read (${why})`);
    }
  }
  // The storage keys are exactly what the storage client reads.
  assert.deepEqual([...APP_MODULES["servers/storage/s3-client.js"].keys].sort(), [...STORAGE_ENV_KEYS].sort());
});

test("no published entry declares a deny-listed key for its server", () => {
  const offenders = [];
  for (const entry of withServer) {
    for (const key of entry.server?.envKeys || []) {
      if (isDeniedAddonKey(key) && !isAddonBaseKey(key)) offenders.push(`${entry.id}: ${key}`);
    }
  }
  assert.deepEqual(offenders, [], "the deny list is absolute, so declaring these is dead weight");
});

test("the scanner sees alias, backtick and destructured reads — and not someone else's dict", () => {
  const aliased = [
    "const env = process.env;",
    "export function f(env2 = process.env) { return env2.ALIAS_PARAM_KEY; }",
    "export const g = (env3 = process.env) => env3?.ALIAS_ARROW_KEY;",
    "const ticked = process.env[`BACKTICK_KEY`];",
    "const quoted = process.env['QUOTED_KEY'];   // and process.env.CALLED_NOT_A_KEY in prose",
    "const { DESTRUCTURED_KEY } = process.env;",
    "if (env.VARIABLE_ALIAS_KEY) {} else {}",
  ].join("\n");
  const keys = new Set(literalEnvReads(aliased, "synthetic.js"));
  for (const key of ["ALIAS_PARAM_KEY", "ALIAS_ARROW_KEY", "BACKTICK_KEY", "QUOTED_KEY", "DESTRUCTURED_KEY", "VARIABLE_ALIAS_KEY"]) {
    assert.ok(keys.has(key), key + " was not seen");
  }
  assert.ok(!keys.has("C"), "prose after `env.` is not a key");
  // No alias in the file: a parameter named `env` is a caller's dict, not process.env.
  const plain = new Set(literalEnvReads("export function other(env, settings = {}) { return env.SOMEONE_ELSES_DICT; }", "plain.js"));
  assert.deepEqual([...plain], []);
});

test("every exemption is still needed, so the list cannot rot", () => {
  const scanned = new Set();
  for (const manifest of withServer) {
    for (const file of sourceFiles(join(BUNDLES, manifest.id, "server"))) {
      scanned.add(`${manifest.id}: ${readFileSync(file, "utf8")}`);
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