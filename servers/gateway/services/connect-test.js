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
 *  - The result is `{ ok: true, label? }` or `{ ok: false, error }` with `error` one fixed class.
 *    Nothing here logs, and no upstream message, header or body is ever returned.
 */
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, join } from "node:path";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { classifyIp, parseIPv6 } from "../../shared/ip-classify.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
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
    return where === "header" ? v.replace(HEADER_BAD_RE, "") : encodeURIComponent(v);
  });
}

/**
 * Fill a `connect.test` template. `in: "url"` (default) or `"header"`.
 * Address fields go in normalised (a bad one throws `{code:"bad_address"}`); other values are
 * encodeURIComponent'd in a URL and stripped of CR/LF/NUL (and any byte a header can't carry) in a
 * header. For a URL, the rendered origin must equal the origin with every non-address value set to
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

function labelFor(service, values, lang) {
  if (service.labelFrom !== "address") return undefined;
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
  } catch {
    return fail("bad_address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("bad_address");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const guarded = port === Number(gatewayPort);
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
      res.on("data", (chunk) => {
        read += chunk.length;
        if (read > BODY_CAP_BYTES) { settle(ok()); res.destroy(); }
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

async function realOr(p) {
  try { return await realpath(p); } catch { return p; }
}

async function probeFolder(service, { values, crowHome }) {
  const field = (service.fields || []).find((f) => f.kind === "folder");
  const raw = field ? values?.[field.name] : undefined;
  if (typeof raw !== "string" || !raw.trim() || !isAbsolute(raw.trim())) return fail("not_found");
  let real;
  try {
    real = await realpath(raw.trim());
  } catch {
    return fail("not_found");
  }
  // Refuse the secrets dir, anything in it, and anything containing it (a vault there would hand
  // the child every secret), comparing real paths both lexically and after symlinks.
  const home = resolvePath(crowHome);
  const secretsDirs = new Set([
    join(home, "secrets"),
    await realOr(join(home, "secrets")),
    join(await realOr(home), "secrets"),
  ]);
  for (const s of secretsDirs) {
    if (within(real, s) || within(s, real)) return fail("forbidden_target");
  }
  try {
    if (!(await stat(real)).isDirectory()) return fail("not_found");
  } catch {
    return fail("not_found");
  }
  const entry = service.test.expect_entry;
  if (entry != null) {
    if (typeof entry !== "string" || !entry || entry.includes("/") || entry.includes("\\") || entry === "." || entry === "..") {
      return fail("not_a_vault");
    }
    try {
      await stat(join(real, entry));
    } catch {
      return fail("not_a_vault");
    }
  }
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
} = {}) {
  const spec = service?.test;
  try {
    if (spec?.kind === "http") {
      return await probeHttp(service, {
        values, gatewayPort, ownAddrs: ownAddrs || probeOwnAddresses(), timeoutMs, request, resolve, lang,
      });
    }
    if (spec?.kind === "folder") return await probeFolder(service, { values, crowHome });
    return fail("unexpected_response");
  } catch {
    return fail("unreachable");
  }
}
