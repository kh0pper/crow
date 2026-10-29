/**
 * Which project-service connections are SENSITIVE (project services Task 16c; roles spec §11,
 * Kevin 2026-10-29). A sensitive connection's content is never given to a bot until the Private
 * role and bot containment ship (roles spec §11.6): the services mount answers every list and
 * call on it with a refusal (mount.js), and every other path that offers a connection to a bot
 * (the pi blocks, the dashboard chat) must skip it through isSensitiveConnection below. The
 * owner's own Connect and test, Test again, Disconnect and Restart are unaffected: sensitivity
 * only decides what bots get.
 *
 * Two parts, and neither may be defined by anything a bot can write:
 *  - the DEFAULT and the LOCK of each service live here, in code. Not in a manifest, a setting or
 *    a crow.db row: a bot can write crow.db and the bundle dirs. A service not listed here is
 *    sensitive and locked (fail closed), so a new service is private until someone decides here.
 *  - the owner's per-connection OVERRIDE (an unlocked service only) lives in a small JSON file in
 *    the instance's hidden secrets dir, read and written only through the anchored dir
 *    (secret-values.js anchoredPath, the same mechanism as the service-hash list): a bot's
 *    sandbox hides that dir, and a dir planted at its path is never read.
 *
 * Effective sensitivity = locked ? default : (override ?? default). A missing, unreadable or
 * corrupt override file, or an entry that is not a boolean, reads as "no override": the default,
 * never "not sensitive" on its own account. Any other failure in isSensitiveConnection reads as
 * sensitive.
 *
 * Google mail, calendar and contacts (services PR 6) will be added here as sensitive and LOCKED
 * when Google arrives (roles spec §11.2: mail, calendar, contacts and file contents).
 */
import { resolveCrowHome } from "./crow-home.js";
import { anchoredPath, readSecretValuesFile, writeSecretValuesFile } from "./secret-values.js";

const S = (isDefault, locked) => Object.freeze({ default: isDefault, locked });

/**
 * Kevin 2026-10-29 ("let the user decide, with sensible defaults"): obsidian reads local files
 * (§11.2), so it is always private; notion and discord hold private writing and messages, so
 * they start private and the owner may turn that off; the rest start open and the owner may
 * turn private on.
 */
export const SERVICE_SENSITIVITY = Object.freeze({
  obsidian: S(true, true),
  notion: S(true, false),
  discord: S(true, false),
  github: S(false, false),
  "home-assistant": S(false, false),
  "brave-search": S(false, false),
  trello: S(false, false),
  "canvas-lms": S(false, false),
  zotero: S(false, false),
  render: S(false, false),
  arxiv: S(false, false),
});

/** A service this file doesn't name: sensitive, and the owner can't turn it off. */
export const UNKNOWN_SERVICE_SENSITIVITY = S(true, true);

/** The override file, inside the anchored secrets dir. */
export const SENSITIVITY_OVERRIDES_FILENAME = "service-sensitivity-overrides";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The code-declared {default, locked} of a service (unknown: sensitive and locked). */
export function serviceSensitivity(serviceId) {
  return typeof serviceId === "string" && Object.hasOwn(SERVICE_SENSITIVITY, serviceId)
    ? SERVICE_SENSITIVITY[serviceId]
    : UNKNOWN_SERVICE_SENSITIVITY;
}

const envFor = (crowHome) => ({ ...process.env, CROW_HOME: crowHome || resolveCrowHome() });

/**
 * The owner's overrides: uuid -> boolean. Only the anchored path is read. A missing, unreadable
 * or corrupt file is an empty map (every connection takes its default); an entry whose key is
 * not a uuid or whose value is not a boolean is left out.
 * @returns {Map<string, boolean>}
 */
export function readSensitivityOverrides({ crowHome } = {}) {
  const out = new Map();
  try {
    const p = anchoredPath(envFor(crowHome), SENSITIVITY_OVERRIDES_FILENAME);
    const f = p ? readSecretValuesFile(p, { raw: true }) : null;
    if (!f || f.lines.length !== 1) return out;
    const obj = JSON.parse(f.lines[0]);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (UUID_RE.test(k) && typeof v === "boolean") out.set(k.toLowerCase(), v);
    }
  } catch {
    out.clear();
  }
  return out;
}

/** {sensitive, locked, default} for one connection ({uuid, serviceId}). */
export function connectionSensitivity(conn, { crowHome, overrides } = {}) {
  const s = serviceSensitivity(conn?.serviceId);
  if (s.locked) return { sensitive: s.default, locked: true, default: s.default };
  const uuid = typeof conn?.uuid === "string" ? conn.uuid.toLowerCase() : "";
  const map = overrides instanceof Map ? overrides : readSensitivityOverrides({ crowHome });
  const o = map.get(uuid);
  return { sensitive: typeof o === "boolean" ? o : s.default, locked: false, default: s.default };
}

/**
 * THE predicate every bot-facing path uses (the services mount now; the pi blocks, Task 18, and
 * the dashboard chat, Task 20, must skip a connection for which this is true). Any failure is
 * true (fail closed).
 * @param {{uuid: string, serviceId: string}} conn
 * @param {{crowHome?: string}} [opts]
 */
export function isSensitiveConnection(conn, { crowHome } = {}) {
  try {
    return connectionSensitivity(conn, { crowHome }).sensitive !== false;
  } catch {
    return true;
  }
}

export class SensitivityError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * The owner's switch: record `sensitive` for one connection. Only the dashboard's owner route
 * calls this (services-api.js, a local password session from another machine + CSRF). A locked
 * service (unknown included) throws SensitivityError('locked'); a write that can't go through the
 * anchored dir throws. Written atomically (temp file, fsync, rename; mode 600). A corrupt file is
 * replaced by the new map (its contents were already being read as "no override").
 * @returns {{sensitive: boolean, locked: false, default: boolean}}
 */
export function setSensitivityOverride(conn, sensitive, { crowHome } = {}) {
  if (typeof sensitive !== "boolean") throw new SensitivityError("bad_value");
  const uuid = typeof conn?.uuid === "string" ? conn.uuid.toLowerCase() : "";
  if (!UUID_RE.test(uuid)) throw new SensitivityError("bad_value");
  const s = serviceSensitivity(conn?.serviceId);
  if (s.locked) throw new SensitivityError("locked");
  const env = envFor(crowHome);
  const p = anchoredPath(env, SENSITIVITY_OVERRIDES_FILENAME);
  if (!p) throw new Error("no anchored secrets dir");
  const map = readSensitivityOverrides({ crowHome });
  map.set(uuid, sensitive);
  const obj = Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeSecretValuesFile(p, [JSON.stringify(obj)], { raw: true });
  return connectionSensitivity({ uuid, serviceId: conn.serviceId }, { crowHome });
}
