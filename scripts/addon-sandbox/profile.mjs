/**
 * The add-on policy profile: what one add-on is allowed to reach, derived from
 * its manifest `sandbox` block, its owner-entered fields and its own compose file.
 *
 * Pure functions only — no spawn, no bind, no token. The wall itself (file
 * binds, fds, the relay) consumes the profile in a later task.
 *
 * Two rules decide most of this file:
 *  - First-party policy comes from the repo copy (`APP_BUNDLES/<id>/`), never
 *    from the installed copy, because unwalled code could have edited the
 *    installed one.
 *  - A manifest default is not a choice the owner made, and a default is never
 *    a real address unless it names this add-on's own published service
 *    (loopback + a port this add-on's compose publishes).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ADDON_DOORS, ADDON_STATE_DIRS } from "../../servers/shared/addon-doors.js";
import { labelPhrase } from "./words.mjs";

// --- compose ports ---------------------------------------------------------

/** `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?msg}` as a whole token. */
const ENV_TOKEN_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-?+])([\s\S]*))?\}$/;

/**
 * Resolve one compose token to a literal, or null when it has no default
 * (`${VAR}`, `${VAR:?msg}`, `${VAR+alt}`).
 */
function resolveToken(token) {
  const m = ENV_TOKEN_RE.exec(token);
  if (!m) return token;
  if (m[2] === "-") {
    const rest = (m[3] || "").trim();
    const inner = resolveToken(rest);
    return inner;
  }
  return null;
}

/** Split on `:` that is not inside a `${...}` reference. */
function splitComposeEntry(text) {
  const parts = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "$" && text[i + 1] === "{") { depth += 1; cur += "${"; i += 1; continue; }
    if (ch === "}" && depth > 0) { depth -= 1; cur += "}"; continue; }
    if (ch === ":" && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Drop a trailing `# comment` that is not inside a quote. */
function stripTrailingComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && /\s/.test(text[i - 1] || " ")) return text.slice(0, i);
  }
  return text;
}

function unquote(text) {
  const q = text[0];
  if ((q === '"' || q === "'") && text.length >= 2 && text.lastIndexOf(q) > 0) {
    return text.slice(1, text.lastIndexOf(q));
  }
  return text;
}

/** One `ports:` list item → a host port, or null when it is not loopback TCP. */
function hostPortFromEntry(raw) {
  let text = stripTrailingComment(raw).trim();
  if (!text) return null;
  text = unquote(text).trim();
  let proto = "tcp";
  const protoMatch = /^(.*)\/(tcp|udp)$/i.exec(text);
  if (protoMatch) { proto = protoMatch[2].toLowerCase(); text = protoMatch[1]; }
  const parts = splitComposeEntry(text);
  if (parts.length !== 3) return null; // `CONTAINER` alone or `HOST:CONTAINER`: every interface
  const addr = resolveToken(parts[0].trim());
  const hostPort = resolveToken(parts[1].trim());
  if (addr === null || hostPort === null) return null;
  if (addr.trim() !== "127.0.0.1") return null;
  if (proto === "udp") return null;
  const port = Number(hostPort.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * Every host port the compose text publishes on 127.0.0.1 over TCP. Sorted,
 * unique. `manifest` is not read: a manifest can name any port, so `ports[]`
 * and `webUI.port` never make a port count as this add-on's own service (the
 * parameter is kept for callers' sake).
 *
 * There is no YAML parser in the repo, so the text is read directly: a publish
 * is a `-` list item inside a `ports:` block.
 */
export function composePortsFrom(composeText, manifest) {
  const ports = new Set();
  const lines = String(composeText || "").split(/\r?\n/);
  let inBlock = false;
  let blockIndent = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (inBlock) {
      if (text.startsWith("#")) continue;
      if (text.startsWith("-") && indent > blockIndent) {
        const port = hostPortFromEntry(text.replace(/^-[ \t]*/, ""));
        if (port !== null) ports.add(port);
        continue;
      }
      if (indent > blockIndent) continue; // a nested key inside the block: not a publish
      inBlock = false;
    }
    const key = /^ports\s*:\s*(.*)$/.exec(text);
    if (key) {
      // An inline array (`ports: ["127.0.0.1:8000:8000"]`) carries no list items.
      if (!key[1].trim().startsWith("[")) { inBlock = true; blockIndent = indent; }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// --- the crow.db scan ------------------------------------------------------

/**
 * Drop `/* ... *\/` blocks and `//` line comments. Only `//` at line start (after
 * whitespace) or preceded by whitespace counts, and never inside a quote, so
 * `"http://..."` survives.
 */
function stripComments(text) {
  const noBlocks = String(text).replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks.split(/\r?\n/).map(stripLineComment).join("\n");
}

function stripLineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") {
      const before = line.slice(0, i);
      if (before.trim() === "" || /\s$/.test(before)) return before;
    }
  }
  return line;
}

const DB_IMPORT_PATTERNS = [
  // A call to the bundle app-import helper with the servers/db.js specifier —
  // any quote style, optional spaces.
  /appImport\s*\(\s*(["'`])servers\/db\.js\1\s*\)/,
  // A dynamic import whose specifier is one or more parent-directory segments
  // followed by the servers/db.js path.
  /\bimport\s*\(\s*(["'`])(?:\.\.\/)+servers\/db\.js\1\s*\)/,
  // A re-export clause naming the same relative servers/db.js specifier.
  /\bfrom\s*(["'`])(?:\.\.\/)+servers\/db\.js\1/,
  // pathToFileURL over a join of the root, then the servers and db.js segments.
  /pathToFileURL\s*\(\s*join\s*\([^()]*(["'`])servers\1\s*,\s*(["'`])db\.js\2/,
];

/**
 * True when any `.js`/`.mjs`/`.cjs` file under `serverDir` opens crow.db by any
 * route. `existsSync(join(p, "servers", "db.js"))` — every bundle's app-root.js
 * probe — is NOT an import and must not count.
 */
export function scanCrowDb(serverDir) {
  if (!serverDir) return false;
  let found = false;
  const walk = (dir, depth) => {
    if (found || depth > 8) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found) return;
      if (e.name === "node_modules") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!/\.(?:js|mjs|cjs)$/.test(e.name)) continue;
      let text;
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      const code = stripComments(text);
      if (DB_IMPORT_PATTERNS.some((re) => re.test(code))) { found = true; return; }
    }
  };
  walk(serverDir, 0);
  return found;
}

// --- addresses -------------------------------------------------------------

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** `localhost`, `*.localhost`, a 127.0.0.0/8 literal, or `::1`. */
export function isLoopbackHost(host) {
  if (typeof host !== "string" || !host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
}

/** A private, link-local, loopback or CGNAT address literal (v4 or v6). */
function isPrivateIpLiteral(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10
  return false;
}

/**
 * A URL (`http`/`https`/`ws`/`wss`) or a bare `host:port` → `{ host, port, scheme }`
 * with brackets removed and the default port filled in. Anything else: null.
 */
export function parseHostValue(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    let url = null;
    try { url = new URL(raw); } catch { url = null; }
    if (url) {
      const scheme = url.protocol.replace(/:$/, "").toLowerCase();
      if (scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss") {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (!host) return null;
        const port = url.port ? Number(url.port) : scheme === "http" || scheme === "ws" ? 80 : 443;
        if (!validPort(port)) return null;
        return { host, port, scheme };
      }
    }
  }
  const v6 = /^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/.exec(raw);
  if (v6) {
    const port = Number(v6[2]);
    return validPort(port) ? { host: v6[1], port, scheme: "tcp" } : null;
  }
  const bare = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(raw);
  if (bare) {
    const port = Number(bare[2]);
    return validPort(port) ? { host: bare[1], port, scheme: "tcp" } : null;
  }
  return null;
}

// --- owner-entered provenance ---------------------------------------------

function manifestDefaults(manifest) {
  const map = new Map();
  for (const v of Array.isArray(manifest?.env_vars) ? manifest.env_vars : []) {
    if (!v || typeof v.name !== "string") continue;
    if (v.default === undefined || v.default === null) continue;
    map.set(v.name, String(v.default));
  }
  return map;
}

/**
 * The keys of `entryEnv` that no manifest version ever shipped as a default —
 * the provenance rule for an entry written before `ownerSet` existed.
 */
export function legacyOwnerKeys(entryEnv, manifest, pastDefaultsForId) {
  const defaults = manifestDefaults(manifest);
  const past = pastDefaultsForId && typeof pastDefaultsForId === "object" ? pastDefaultsForId : {};
  const out = [];
  for (const [key, value] of Object.entries(entryEnv || {})) {
    const text = String(value);
    const pastValues = Object.prototype.hasOwnProperty.call(past, key) ? past[key] : null;
    const known = Array.isArray(pastValues) ? pastValues.map(String) : [];
    if (known.includes(text)) continue;
    if (defaults.has(key) && defaults.get(key) === text) continue;
    out.push(key);
  }
  return out.sort();
}

/**
 * The keys counted as owner-entered: the entry's own `ownerSet` when it has one,
 * else the legacy rule above.
 */
export function ownerSetKeys(entry, manifest, pastDefaultsForId) {
  if (entry && Array.isArray(entry.ownerSet)) return new Set(entry.ownerSet);
  return new Set(legacyOwnerKeys(entry?.env, manifest, pastDefaultsForId));
}

// --- policy source ---------------------------------------------------------

function readJsonFile(path, what) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (err) {
    throw new Error(`cannot read ${what} (${path}): ${err.message}`);
  }
  try { return JSON.parse(text); } catch (err) {
    throw new Error(`cannot parse ${what} (${path}): ${err.message}`);
  }
}

/**
 * Where an add-on's policy comes from. For a first-party bundle the repo copy
 * wins (manifest, compose text, server dir), and the installed manifest is read
 * only so a difference can be reported.
 */
export function loadPolicySource({ id, appBundlesDir, installedBundlesDir }) {
  const repoDir = join(appBundlesDir, id);
  const installedDir = join(installedBundlesDir, id);
  const repoManifestPath = join(repoDir, "manifest.json");

  if (existsSync(repoManifestPath)) {
    const manifest = readJsonFile(repoManifestPath, `manifest for ${id}`);
    const rel = typeof manifest?.docker?.composefile === "string" && manifest.docker.composefile
      ? manifest.docker.composefile
      : "docker-compose.yml";
    let composeText = "";
    try { composeText = readFileSync(join(repoDir, rel), "utf8"); } catch { composeText = ""; }
    const installedManifestPath = join(installedDir, "manifest.json");
    const installedManifest = existsSync(installedManifestPath)
      ? readJsonFile(installedManifestPath, `installed manifest for ${id}`)
      : null;
    return { manifest, composeText, serverDir: join(repoDir, "server"), source: "repo", installedManifest };
  }

  const installedManifestPath = join(installedDir, "manifest.json");
  const manifest = readJsonFile(installedManifestPath, `manifest for ${id}`);
  const rel = typeof manifest?.docker?.composefile === "string" && manifest.docker.composefile
    ? manifest.docker.composefile
    : "docker-compose.yml";
  let composeText = "";
  try { composeText = readFileSync(join(installedDir, rel), "utf8"); } catch { composeText = ""; }
  return { manifest, composeText, serverDir: join(installedDir, "server"), source: "installed", installedManifest: null };
}

// --- the profile -----------------------------------------------------------

const HOST_FIELD_NAME_RE = /(_URL|_HOST|_BASE_URL)$/;

/** One part's phrases, from the one words module every surface reads. */
function labelPhrases(part) {
  return labelPhrase(part);
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** `env_vars[].default` as a stable, comparable list. */
function defaultsFingerprint(manifest) {
  const pairs = [];
  for (const [name, value] of manifestDefaults(manifest)) pairs.push([name, value]);
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Derive one add-on's profile. This shape is the contract the wall consumes.
 *
 * @param {object} manifest  the policy-source manifest
 * @param {object} entry     the mcp-addons.json entry (may be `{}`)
 * @param {object} opts      { composePorts, pastDefaults, crowDbScan, installedManifest, source, gatewayPort }
 */
export function deriveProfile(manifest, entry = {}, opts = {}) {
  const {
    composePorts = [],
    pastDefaults = {},
    crowDbScan = false,
    installedManifest = null,
    source = "repo",
    gatewayPort = null,
  } = opts || {};
  const id = typeof manifest?.id === "string" ? manifest.id : "";
  const sandbox = manifest?.sandbox && typeof manifest.sandbox === "object" ? manifest.sandbox : null;
  const entryEnv = entry?.env && typeof entry.env === "object" ? entry.env : {};
  const declared = Array.isArray(manifest?.env_vars) ? manifest.env_vars.filter((v) => v && typeof v.name === "string") : [];
  const defaults = manifestDefaults(manifest);
  const ownerKeys = ownerSetKeys(entry, manifest, pastDefaults);
  const refused = [];

  /** The effective value of one env field: entry value first, then the manifest default. */
  const fieldOf = (name) => {
    const raw = Object.prototype.hasOwnProperty.call(entryEnv, name) ? entryEnv[name] : undefined;
    if (raw !== undefined && raw !== null && String(raw) !== "") {
      return { value: String(raw), fromEntry: true, source: ownerKeys.has(name) ? "owner" : "default" };
    }
    if (defaults.has(name) && defaults.get(name) !== "") return { value: defaults.get(name), fromEntry: false, source: "default" };
    return null;
  };

  // The installed copy may have been edited by unwalled code; say so and ignore it.
  if (installedManifest) {
    if (!sameJson(sandbox, installedManifest?.sandbox) || !sameJson(defaultsFingerprint(manifest), defaultsFingerprint(installedManifest))) {
      refused.push({ what: "installed manifest differs", reason: "first-party policy is read from the repo copy" });
    }
  }

  // --- network ---
  const network = sandbox?.network;
  let internet = true;
  let candidates = [];
  let listedOnly = false; // the manifest named these fields: an unset one is a refusal
  if (network === undefined || network === null) {
    internet = true;
    const names = new Set([...declared.map((v) => v.name), ...Object.keys(entryEnv)]);
    candidates = [...names].filter((n) => HOST_FIELD_NAME_RE.test(n)).sort();
  } else if (network === "none") {
    internet = false;
  } else if (network === "internet") {
    internet = true;
  } else if (typeof network === "object") {
    internet = network.internet === true;
    listedOnly = true;
    candidates = (Array.isArray(network.hosts) ? network.hosts : []).map((h) => String(h).replace(/^env:/, ""));
  }

  const hosts = [];
  for (const name of candidates) {
    const field = fieldOf(name);
    if (!field) {
      if (listedOnly) refused.push({ what: `host:${name}`, reason: `the field ${name} is not set` });
      continue;
    }
    const parsed = parseHostValue(field.value);
    if (!parsed) {
      if (listedOnly) refused.push({ what: `host:${name}`, reason: `the field ${name} is not a host address` });
      continue;
    }
    if (field.source === "owner") {
      hosts.push({ host: parsed.host, port: parsed.port, scheme: parsed.scheme, from: name, source: "owner" });
      continue;
    }
    if (isLoopbackHost(parsed.host) && composePorts.includes(parsed.port)) {
      // A default may only name a port this add-on's own compose publishes. For the repo copy
      // that is this add-on's own service. Any other source (`installed`: a local or
      // third-party bundle, whose compose and manifest unwalled code could have written) gets
      // `default-installed-compose` instead: a third-party compose can say anything, so the
      // wall must then reach it only through a listener published by this add-on's OWN running
      // compose project, which the relay's owner check enforces for every non-owner entry.
      if (Number.isInteger(gatewayPort) && parsed.port === gatewayPort) {
        refused.push({ what: `host:${name}`, reason: "a default address never names Crow's gateway port" });
        continue;
      }
      hosts.push({
        host: parsed.host,
        port: parsed.port,
        scheme: parsed.scheme,
        from: name,
        source: source === "repo" ? "default-own-service" : "default-installed-compose",
      });
      continue;
    }
    const coveredByInternet = internet
      && (parsed.scheme === "https" || parsed.scheme === "wss")
      && !isLoopbackHost(parsed.host)
      && !isPrivateIpLiteral(parsed.host);
    if (coveredByInternet) continue;
    refused.push({ what: `host:${name}`, reason: "a default address that is not this add-on's own published service" });
  }
  hosts.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
    || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)
    || a.port - b.port);
  const seenHosts = new Set();
  const uniqueHosts = [];
  for (const h of hosts) {
    const key = `${h.host}:${h.port}`;
    if (seenHosts.has(key)) continue;
    seenHosts.add(key);
    uniqueHosts.push(h);
  }

  // --- doors (core table only, first-party only; a manifest can never widen it) ---
  const hasOwn = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  const doors = [];
  const doorsSpec = sandbox?.doors;
  if (doorsSpec === undefined) {
    if (source === "repo" && hasOwn(ADDON_DOORS, id)) doors.push(id);
  } else if (Array.isArray(doorsSpec)) {
    for (const name of doorsSpec) {
      if (name !== id) refused.push({ what: `door:${name}`, reason: "an add-on can only name its own door set" });
      else if (!hasOwn(ADDON_DOORS, name)) refused.push({ what: `door:${name}`, reason: "no such door set" });
      else if (source !== "repo") refused.push({ what: `door:${name}`, reason: "doors are for first-party add-ons only" });
      else if (!doors.includes(name)) doors.push(name);
    }
  }

  // --- files ---
  const readPaths = [];
  const writePaths = [];
  let oauthDir = null;
  const filesSpec = sandbox?.files && typeof sandbox.files === "object" ? sandbox.files : null;
  if (filesSpec) {
    const nameOf = (v) => (typeof v === "string" && v.startsWith("env:") ? v.slice(4) : null);
    // A path is only ever the owner's: a manifest default is not a choice, so a
    // default-only field is refused rather than bound.
    const collect = (list, target) => {
      for (const raw of Array.isArray(list) ? list : []) {
        const name = nameOf(raw);
        if (!name) continue;
        const field = fieldOf(name);
        if (!field) { refused.push({ what: `file:${name}`, reason: `the field ${name} is not set` }); continue; }
        if (field.source !== "owner") {
          refused.push({ what: `file:${name}`, reason: "a default path the owner did not choose" });
          continue;
        }
        target.push({ from: name, path: field.value, source: "owner" });
      }
    };
    collect(filesSpec.read, readPaths);
    collect(filesSpec.write, writePaths);
    const oauthName = nameOf(filesSpec.oauthDir);
    if (oauthName) {
      const field = fieldOf(oauthName);
      if (!field) refused.push({ what: `file:${oauthName}`, reason: `the field ${oauthName} is not set` });
      else if (field.source !== "owner") {
        refused.push({ what: `file:${oauthName}`, reason: "a default path the owner did not choose" });
      } else oauthDir = { from: oauthName, path: field.value, source: "owner" };
    }
  }

  // --- state dirs: core allowlist, first-party only ---
  const state = source === "repo" && hasOwn(ADDON_STATE_DIRS, id) && Array.isArray(ADDON_STATE_DIRS[id])
    ? [...ADDON_STATE_DIRS[id]]
    : [];

  // --- crow.db ---
  const crowDb = !!crowDbScan;
  if (sandbox?.crowDb === false && crowDbScan) {
    refused.push({ what: "crowDb", reason: "profile error: the server code opens crow.db" });
  }

  const ownEnvFile = sandbox?.ownEnvFile === true;

  // --- labels ---
  const labelParts = [];
  if (internet) labelParts.push({ kind: "internet" });
  for (const h of uniqueHosts) {
    // Both default sources ("default-own-service", "default-installed-compose") label alike: the
    // label says what the add-on reaches, and the relay's own-service check is what gates it.
    if (isLoopbackHost(h.host)) {
      const label = manifest?.webUI?.port === h.port && typeof manifest?.webUI?.label === "string"
        ? manifest.webUI.label
        : `${h.host}:${h.port}`;
      labelParts.push({ kind: "local-host", label, host: h.host, port: h.port });
    } else {
      labelParts.push({ kind: "network-host", host: h.host, port: h.port });
    }
  }
  for (const door of doors) labelParts.push({ kind: "door", id: door });
  labelParts.push({ kind: "own-folder" });
  if (oauthDir) labelParts.push({ kind: "oauth-dir" });
  if (crowDb) labelParts.push({ kind: "crow-db" });

  const label = { en: [], es: [] };
  for (const part of labelParts) {
    const [en, es] = labelPhrases(part);
    label.en.push(en);
    label.es.push(es);
  }

  return {
    id,
    source,
    network: { internet, hosts: uniqueHosts },
    doors,
    files: { read: readPaths, write: writePaths, oauthDir, state },
    crowDb,
    ownEnvFile,
    refused,
    labelParts,
    label,
  };
}

/** An add-on id this file may be asked about (`^[a-z0-9][a-z0-9-]*$`). */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Load an add-on's policy source and derive its profile.
 *
 * `id` is validated before it is ever joined onto a directory: `../x`, `a/b` and
 * `__proto__` would otherwise read (or look up) something that is not an add-on.
 * A manifest whose own `id` is different from the one asked for is refused too —
 * policy is keyed by id, so a file claiming another add-on's id must not supply it.
 *
 * @param {object} opts { id, entry, appBundlesDir, installedBundlesDir, pastDefaultsAll, gatewayPort }
 */
export function profileFor({ id, entry = {}, appBundlesDir, installedBundlesDir, pastDefaultsAll = {}, gatewayPort = null }) {
  if (typeof id !== "string" || !ADDON_ID_RE.test(id)) throw new Error("invalid add-on id");
  const src = loadPolicySource({ id, appBundlesDir, installedBundlesDir });
  if (src?.manifest?.id !== id) throw new Error("manifest id does not match");
  return deriveProfile(src.manifest, entry, {
    composePorts: composePortsFrom(src.composeText, src.manifest),
    pastDefaults: pastDefaultsAll && Object.prototype.hasOwnProperty.call(pastDefaultsAll, id) ? pastDefaultsAll[id] : {},
    crowDbScan: scanCrowDb(src.serverDir),
    installedManifest: src.installedManifest,
    source: src.source,
    // Optional: the wall passes the gateway's own port so a manifest default can never
    // name it. The registry build passes none, so the generated profiles are unchanged.
    gatewayPort,
  });
}

// --- past defaults (git history) -------------------------------------------

const defaultRunGit = (repoRoot) => (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * Every `env_vars[].default` (as a string) that ANY committed version of
 * `bundles/<id>/manifest.json` has shipped, plus the working-tree file's.
 * `{ [id]: { [KEY]: string[] } }`, ids/keys/values sorted; ids with no defaults
 * are omitted.
 *
 * @param {object} opts { repoRoot, runGit }
 */
export function collectPastDefaults({ repoRoot, runGit }) {
  const git = typeof runGit === "function" ? runGit : defaultRunGit(repoRoot);
  const bundlesDir = join(repoRoot, "bundles");
  let entries = [];
  try { entries = readdirSync(bundlesDir, { withFileTypes: true }); } catch { entries = []; }
  const ids = entries
    .filter((e) => e.isDirectory() && existsSync(join(bundlesDir, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();

  const out = {};
  for (const id of ids) {
    const rel = `bundles/${id}/manifest.json`;
    const values = new Map();
    const add = (manifest) => {
      for (const v of Array.isArray(manifest?.env_vars) ? manifest.env_vars : []) {
        if (!v || typeof v.name !== "string") continue;
        if (v.default === undefined || v.default === null) continue;
        if (!values.has(v.name)) values.set(v.name, new Set());
        values.get(v.name).add(String(v.default));
      }
    };

    let log = "";
    try { log = String(git(["log", "--format=%H", "--", rel]) || ""); } catch { log = ""; }
    for (const sha of log.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      let text = null;
      try { text = git(["show", `${sha}:${rel}`]); } catch { continue; }
      try { add(JSON.parse(String(text))); } catch { /* a version that does not parse is skipped */ }
    }
    try { add(JSON.parse(readFileSync(join(repoRoot, rel), "utf8"))); } catch { /* no working-tree copy */ }

    if (values.size === 0) continue;
    out[id] = Object.fromEntries(
      [...values.keys()].sort().map((key) => [key, [...values.get(key)].sort()]),
    );
  }
  return out;
}

/** True on a shallow clone, where history-derived defaults are incomplete. */
export function isShallowRepo({ runGit, repoRoot = process.cwd() } = {}) {
  const git = typeof runGit === "function" ? runGit : defaultRunGit(repoRoot);
  try { return String(git(["rev-parse", "--is-shallow-repository"])).trim() === "true"; } catch { return false; }
}