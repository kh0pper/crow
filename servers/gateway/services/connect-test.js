/**
 * Connect and test: probe a service the owner is connecting, before it is saved.
 *
 * The owner types an address and the gateway fetches it, so this is an SSRF-shaped surface:
 *  - The address checked is the address connected to. The forbidden-target rule runs inside the
 *    request's own `lookup`, on the resolved addresses the socket then uses, so a name can't
 *    answer one address to a check and another to the connect (DNS rebinding). IP literals skip
 *    the lookup in node:net, so they are checked before the request.
 *  - This gateway's own port is refused on loopback, unspecified and own addresses (every
 *    spelling: new URL folds decimal/octal/hex/short IPv4, classifyIp decodes v4-mapped IPv6).
 *    Other ports on loopback stay allowed: a Home Assistant on this machine is the common case.
 *  - Redirects are never followed (node:http doesn't; a 3xx is reported as `redirect`).
 *  - One total deadline covers DNS, connect, headers and body. The body is read to at most 64 KB
 *    and discarded; it never reaches the caller.
 *  - Template values can't add a header line or change the URL's host.
 *  - Folders go through folderRefusal, the one rule the save route and the spawn re-check reuse.
 *  - The result is `{ ok: true, label? }` or `{ ok: false, error }` with `error` one fixed class
 *    (the plan's list, plus `bad_value` for a "." / ".." URL value).
 *    Nothing here logs, and no upstream message, header or body is ever returned.
 */
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, join } from "node:path";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { classifyIp, parseIPv6 } from "../../shared/ip-classify.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { checkedInstanceSecretsDirs } from "../../shared/secret-values.js";
import { gatewayListenPort } from "../listen-port.js";
import { t, fill } from "../dashboard/shared/i18n.js";

export const BODY_CAP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_]+)\}/g;
// Header bytes node:http accepts (validateHeaderValue). CR/LF/NUL are the injection risk; the
// rest are stripped too so a pasted value can never make request() throw.
const HEADER_BAD_RE = /[^\t\x20-\x7e\x80-\xff]/g;

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (error) => ({ ok: false, error });

/**
 * An owner-typed service address → canonical `scheme://host[:port][/path]` with one trailing
 * slash removed, or null. Only http/https, a host, and no userinfo, query or fragment.
 */
export function normalizeAddress(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password || s.includes("@")) return null;
  if (u.search || u.hash || s.includes("?") || s.includes("#")) return null;
  const href = u.href;
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

function fieldKinds(fields) {
  const kinds = new Map();
  for (const f of fields || []) if (f && f.name) kinds.set(f.name, f.kind);
  return kinds;
}

function substitute(tpl, values, kinds, where, probe) {
  return String(tpl ?? "").replace(PLACEHOLDER_RE, (_, name) => {
    if (kinds.get(name) === "address") {
      const addr = normalizeAddress(values?.[name]);
      if (addr == null) throw new ProbeError("bad_address");
      return where === "header" ? addr.replace(HEADER_BAD_RE, "") : addr;
    }
    const v = probe ?? String(values?.[name] ?? "");
    if (where === "header") return v.replace(HEADER_BAD_RE, "");
    // encodeURIComponent leaves "." and ".." alone and new URL resolves them as dot segments
    // (WHATWG treats "%2e" as a dot too), so a value that is exactly one would move the path.
    if (v === "." || v === "..") throw new ProbeError("bad_value");
    return encodeURIComponent(v);
  });
}

/**
 * Fill a `connect.test` template. `in: "url"` (default) or `"header"`.
 * Address fields go in normalised (a bad one throws `{code:"bad_address"}`); other values are
 * encodeURIComponent'd in a URL and stripped of CR/LF/NUL (and any byte a header can't carry) in a
 * header. In a URL a value that is exactly "." or ".." throws `{code:"bad_value"}`. For a URL, the rendered origin must equal the origin with every non-address value set to
 * a fixed probe, so no value can move the host.
 */
export function renderTemplate(tpl, values, { fields, in: where = "url" } = {}) {
  const kinds = fieldKinds(fields);
  const out = substitute(tpl, values, kinds, where, null);
  if (where !== "url") return out;
  let real, ref;
  try {
    real = new URL(out);
    ref = new URL(substitute(tpl, values, kinds, where, "x"));
  } catch {
    throw new ProbeError("bad_address");
  }
  if (real.origin !== ref.origin || real.username || real.password) throw new ProbeError("bad_address");
  return out;
}

/** Canonical key for an IP literal (v4-mapped → its IPv4), or the lower-cased name. */
function addrKey(a) {
  const s = String(a ?? "").trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (isIP(s) === 4) return s;
  const c = classifyIp(s);
  if (c.via === "mapped" || c.via === "siit") return c.v4;
  const g = parseIPv6(s);
  return g ? g.map((x) => x.toString(16)).join(":") : s.replace(/\.$/, "");
}

/**
 * True when `addr` (an IP literal or a hostname) is loopback, unspecified or one of `ownAddrs`.
 * The caller applies it only on this gateway's port.
 */
export function isForbiddenTarget(addr, ownAddrs) {
  const s = String(addr ?? "").trim().replace(/^\[(.*)\]$/, "$1").toLowerCase().replace(/\.$/, "");
  if (!s) return true;
  if (s === "localhost" || s.endsWith(".localhost")) return true;
  if (isIP(s)) {
    const c = classifyIp(s);
    if (c.cls === "loopback" || c.cls === "unspecified" || c.cls === "invalid") return true;
    const v4 = isIP(s) === 4 ? s : c.v4;
    if (v4 && v4.startsWith("0.")) return true; // 0.0.0.0/8 "this network"
  }
  const key = addrKey(s);
  for (const own of ownAddrs || []) if (addrKey(own) === key) return true;
  return false;
}

/**
 * The default own-address set: getOwnAddresses() (the locality set model roles use) plus EVERY
 * interface address. getOwnAddresses skips docker/bridge interfaces on purpose (a shared bridge IP
 * is not machine identity), but a gateway bound to 0.0.0.0 answers on those too, so for the
 * forbidden-target rule they count.
 */
export function probeOwnAddresses() {
  const own = new Set(getOwnAddresses());
  try {
    for (const addrs of Object.values(networkInterfaces())) for (const a of addrs || []) own.add(a.address);
  } catch {}
  return own;
}

function defaultRequest(url, options) {
  return (url.protocol === "https:" ? https : http).request(url, options);
}

function classifyStatus(status, expect) {
  if (Array.isArray(expect) && expect.includes(status)) return null;
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401 || status === 403) return "auth_failed";
  return "unexpected_response";
}

/**
 * The account label a `label_from: "address"` service suggests, with no network: the same label
 * testConnection returns. A loopback host gives "this Crow :{port}" (services.connect.labelHere,
 * the port of the typed address, i.e. the service's own port on this machine); any other host gives
 * its hostname. undefined when the service has no labelFrom or no usable address.
 * @param {object} service  a catalog entry
 * @param {object} values   the typed values
 * @param {{lang?: string}} [opts]
 */
export function suggestLabel(service, values, { lang = "en" } = {}) {
  return labelFor(service, values, lang);
}

function labelFor(service, values, lang) {
  if (!service || service.labelFrom !== "address") return undefined;
  const field = (service.fields || []).find((f) => f.kind === "address");
  const addr = field && normalizeAddress(values?.[field.name]);
  if (!addr) return undefined;
  const u = new URL(addr);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  const h = host.toLowerCase().replace(/\.$/, "");
  const loopback = h === "localhost" || h.endsWith(".localhost") || (isIP(h) && classifyIp(h).cls === "loopback");
  if (loopback) {
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return fill(t("services.connect.labelHere", lang), { port });
  }
  return host;
}

async function probeHttp(service, opts) {
  const { values, gatewayPort, ownAddrs, timeoutMs, request, resolve, lang } = opts;
  const spec = service.test;
  let url;
  const headers = {};
  try {
    url = new URL(renderTemplate(spec.url, values, { fields: service.fields }));
    for (const [k, v] of Object.entries(spec.headers || {})) {
      headers[k] = renderTemplate(v, values, { fields: service.fields, in: "header" });
    }
  } catch (e) {
    return fail(e instanceof ProbeError && e.code === "bad_value" ? "bad_value" : "bad_address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("bad_address");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  // An unusable gateway port fails closed: the rule then guards every port.
  const gp = Number(gatewayPort);
  const guarded = !Number.isInteger(gp) || gp < 1 || gp > 65535 || port === gp;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  // IP literals and "localhost" are decided here: node:net connects to a literal without a lookup.
  if (guarded && isForbiddenTarget(host, ownAddrs)) return fail("forbidden_target");

  // The socket's own lookup: one resolution, checked, then used for the connect.
  const lookup = (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    const o = typeof options === "number" ? { family: options } : { ...(options || {}) };
    resolve(hostname, { ...o, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [];
      if (!list.length) return cb(new ProbeError("unreachable"));
      if (guarded && list.some((a) => isForbiddenTarget(a.address, ownAddrs))) {
        return cb(new ProbeError("forbidden_target"));
      }
      if (o.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };

  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((done) => {
    let settled = false;
    let req = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (req) req.destroy();
      done(r);
    };
    const onAbort = () => settle(fail("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      req = request(url, { method: "GET", headers, lookup, signal, agent: false });
    } catch {
      return settle(fail("unreachable"));
    }
    req.on("error", (err) => {
      if (signal.aborted || err?.name === "AbortError") return settle(fail("timeout"));
      if (err instanceof ProbeError && err.code === "forbidden_target") return settle(fail("forbidden_target"));
      settle(fail("unreachable"));
    });
    req.on("response", (res) => {
      const cls = classifyStatus(res.statusCode, spec.expect);
      if (cls) { res.destroy(); return settle(fail(cls)); }
      const ok = () => {
        const label = labelFor(service, values, lang);
        return label === undefined ? { ok: true } : { ok: true, label };
      };
      let read = 0;
      // Exactly BODY_CAP_BYTES are kept (and then dropped): the chunk that crosses the cap is
      // sliced, and the socket is destroyed.
      res.on("data", (chunk) => {
        if (settled) return;
        const room = BODY_CAP_BYTES - read;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        read += kept.length;
        if (kept !== chunk || read >= BODY_CAP_BYTES) { settle(ok()); res.destroy(); }
      });
      res.on("end", () => settle(ok()));
      res.on("error", () => settle(signal.aborted ? fail("timeout") : fail("unreachable")));
      res.on("aborted", () => settle(signal.aborted ? fail("timeout") : fail("unreachable")));
    });
    req.end();
  });
}

/** True when `child` is `parent` or inside it (both absolute, already resolved). */
function within(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The one folder rule, shared by Connect and test, the save route and the spawn re-check.
 * Returns null when `path` may be used as a folder service's root, else the error class:
 *  - `not_found`: not a non-empty absolute path, missing, or not a directory;
 *  - `forbidden_target`: after realpath, inside or containing this instance's home (its secrets,
 *    bundles' .env files, data/crow.db) or any other Crow home's secrets dir on this host
 *    (checkedInstanceSecretsDirs: the scan plus every other-instance dir this instance hid before, the same rule the bot launcher uses). A scan that can't be completed, or a remembered dir that is gone or replaced, refuses (fail closed);
 *  - `not_a_vault`: `expectEntry` given and not present (a name, never a path).
 * Options: `crowHome`, `env` and `instanceScan` (passed to checkedInstanceSecretsDirs), or
 * `otherSecretsDirs` to supply the other homes' secrets dirs directly. `scanLinks` (the spawn
 * re-check, Task 14 M4) also walks the folder and refuses it (`forbidden_target`) when any
 * symlink inside resolves into or around a guarded dir, or when the folder holds more than
 * MAX_LINK_SCAN_ENTRIES entries (fail closed: the walk could not finish). Symlinked folders are
 * followed by real path (loops end), and a dangling link refuses.
 */
export const MAX_LINK_SCAN_ENTRIES = 100_000;

export function folderRefusal(path, {
  crowHome = resolveCrowHome(),
  expectEntry = null,
  env = process.env,
  instanceScan,
  otherSecretsDirs,
  scanLinks = false,
  maxScanEntries = MAX_LINK_SCAN_ENTRIES,
} = {}) {
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path.trim())) return "not_found";
  let real;
  try {
    real = realpathSync(path.trim());
  } catch {
    return "not_found";
  }
  const home = resolvePath(crowHome);
  const guarded = new Set([home, realOr(home), join(home, "secrets"), realOr(join(home, "secrets"))]);
  try {
    const others = otherSecretsDirs ?? checkedInstanceSecretsDirs({ ...env, CROW_HOME: home }, instanceScan);
    for (const d of others) { guarded.add(resolvePath(d)); guarded.add(realOr(d)); }
  } catch {
    return "forbidden_target";
  }
  for (const g of guarded) {
    if (within(real, g) || within(g, real)) return "forbidden_target";
  }
  try {
    if (!statSync(real).isDirectory()) return "not_found";
  } catch {
    return "not_found";
  }
  if (expectEntry != null) {
    const e = expectEntry;
    if (typeof e !== "string" || !e || e.includes("/") || e.includes("\\") || e === "." || e === "..") return "not_a_vault";
    try {
      statSync(join(real, e));
    } catch {
      return "not_a_vault";
    }
  }
  if (scanLinks) return plantedLinkRefusal(real, guarded, maxScanEntries);
  return null;
}

/**
 * M4 (defence in depth; the real fix is confining the child, a follow-up): walks the folder by
 * REAL path, following symlinked folders (a visited set of real paths ends loops), and refuses
 * when any real path it reaches, folder or file, is inside or contains a guarded dir. A link that
 * doesn't resolve refuses too (fail closed: it could be satisfied later). Every visited entry
 * counts toward `maxEntries`; a walk that can't finish within it refuses.
 */
function plantedLinkRefusal(root, guarded, maxEntries) {
  const hit = (real) => {
    for (const g of guarded) if (within(real, g) || within(g, real)) return true;
    return false;
  };
  const visited = new Set([root]);
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;   // unreadable subfolder: the child can't read it either
    }
    for (const ent of entries) {
      if (++seen > maxEntries) return "forbidden_target";
      const p = join(dir, ent.name);
      let real = p;
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          real = realpathSync(p);
          isDir = statSync(real).isDirectory();
        } catch {
          return "forbidden_target";   // dangling (or unreadable) link
        }
      }
      if (hit(real)) return "forbidden_target";
      if (isDir && !visited.has(real)) {
        visited.add(real);
        stack.push(real);
      }
    }
  }
  return null;
}

function probeFolder(service, { values, crowHome, env, instanceScan, otherSecretsDirs }) {
  const field = (service.fields || []).find((f) => f.kind === "folder");
  const raw = field ? values?.[field.name] : undefined;
  const refusal = folderRefusal(raw, {
    crowHome, expectEntry: service.test.expect_entry ?? null, env, instanceScan, otherSecretsDirs,
  });
  if (refusal) return fail(refusal);
  const label = labelFor(service, values);
  return label === undefined ? { ok: true } : { ok: true, label };
}

/**
 * Run a service's `connect.test` against the typed values.
 * @returns {Promise<{ok:true, label?:string} | {ok:false, error:string}>}
 */
export async function testConnection(service, {
  values = {},
  gatewayPort = gatewayListenPort(),
  ownAddrs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  request = defaultRequest,
  resolve = dnsLookup,
  crowHome = resolveCrowHome(),
  lang = "en",
  env = process.env,
  instanceScan,
  otherSecretsDirs,
} = {}) {
  const spec = service?.test;
  try {
    if (spec?.kind === "http") {
      return await probeHttp(service, {
        values, gatewayPort, ownAddrs: ownAddrs || probeOwnAddresses(), timeoutMs, request, resolve, lang,
      });
    }
    if (spec?.kind === "folder") return probeFolder(service, { values, crowHome, env, instanceScan, otherSecretsDirs });
    return fail("unexpected_response");
  } catch {
    return fail("unreachable");
  }
}
