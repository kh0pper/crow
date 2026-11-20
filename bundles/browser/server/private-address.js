/**
 * Private and local-network addresses (2026-11-02).
 *
 * The browser container runs with host networking, so a page it is sent to can
 * reach services that listen only on 127.0.0.1, the RFC1918 LAN, the tailnet
 * (100.64.0.0/10), link-local, and the cloud metadata endpoints. This module is
 * the rule Crow's own browser tools apply: it classifies an address, parses the
 * many spellings a host can be written in, checks a URL before it is loaded,
 * and installs a Playwright context guard that covers every request the
 * browser makes (redirect hops, popups, new tabs, subframes, WebSockets).
 *
 * It is a rule inside Crow's tools, not a network wall. Anyone holding the
 * browser's control key (CROW_BROWSER_CDP_TOKEN), or driving it through the VNC
 * viewer, is not limited by it. The exception list is owner-set only, from the
 * environment (CROW_BROWSER_ALLOW_PRIVATE), never from a tool argument, and
 * cloud-metadata addresses are never excepted.
 */
import { promises as dnsPromises } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { addExitTask } from "./exit-tasks.js";

/** A name's addresses are reused this long, so one page's sub-requests resolve once. */
const NAME_CACHE_TTL_MS = 10_000;
/** How long a host that was served from a private address stays refused. */
const POISON_TTL_MS = 5 * 60_000;
/** The route-level reason for a host poisoned by a private server address. */
const POISON_REASON = "host resolved to a private address";
/** A node-side fetch gives up on a hop that has not answered by then (an idle timeout). */
const FETCH_TIMEOUT_MS = 30_000;
/** A node-side fetch never takes longer than this in total: every hop and the body. */
const FETCH_DEADLINE_MS = 60_000;
/** A node-side fetch never buffers more than this. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
/** Statuses whose responses carry no body (a Response may not be given one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** Redirect statuses the node-side fetch follows itself, one hop at a time. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Verdict for a name whose lookup failed: refused, never left to the browser's own resolver. */
const UNRESOLVED = "host did not resolve";
/** Metadata is never excepted, by name or by CIDR. */
const METADATA = "cloud metadata address";
/** Host names that reach a metadata service; refused before any lookup. */
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "metadata.goog", "instance-data"]);
/** How many recorded refusals a guard keeps. */
const MAX_REFUSALS = 50;
/** The first line of every refusal a tool hands back. */
const REFUSAL_HEAD = "Blocked: Crow's browser does not load private or local-network addresses";
/**
 * The fixed first line of the init script SOURCE that is handed to Playwright.
 *
 * The text passed to `Page.addScriptToEvaluateOnNewDocument` carries this marker
 * verbatim as its leading line comment, so whoever looks at that source can tell
 * the private-address guard's script from some other script. It is a fixed
 * string: never build it from anything that varies.
 *
 * It is NOT the first line Chromium evaluates (Playwright wraps that text before
 * the page world runs it), and nothing in the product reads the marker back. What
 * the guard's page-world half actually does is checked by a live test on its
 * effects, not by this string.
 */
export const GUARD_MARKER = "crow-private-address-guard:v1";

/** name -> { at, addresses } */
const nameCache = new Map();
/** The empty exception list, for callers that passed none. */
const NO_EXCEPTIONS = Object.freeze({ hosts: new Set(), cidrs: Object.freeze([]), rejected: Object.freeze([]) });

// ---------------------------------------------------------------------------
// Parsing addresses
// ---------------------------------------------------------------------------

/**
 * Parse a dotted decimal quad strictly (four parts, each 0-255).
 * @param {string} text
 * @returns {Uint8Array|null} 4 bytes, or null when it is not a dotted quad
 */
function parseDottedQuad(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

/** One part of an inet_aton style address: decimal, 0x hex, or leading-0 octal. */
function parseAddressPart(part) {
  if (!part) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    const n = parseInt(part.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  if (part.length > 1 && part[0] === "0") {
    // A leading zero means octal; a digit 8 or 9 makes it not an address at all.
    if (!/^[0-7]+$/.test(part)) return null;
    return parseInt(part, 8);
  }
  if (!/^\d+$/.test(part)) return null;
  const n = Number(part);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse every inet_aton spelling of an IPv4 address (a, a.b, a.b.c, a.b.c.d,
 * with decimal, hex or octal parts).
 * @param {string} text
 * @returns {Uint8Array|null} 4 bytes, or null when it is not an address
 */
function parseIpv4AnyBase(text) {
  const parts = String(text).split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    const n = parseAddressPart(part);
    if (n === null) return null;
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
  const value = nums[nums.length - 1];
  const maxLast = Math.pow(256, 5 - nums.length) - 1;
  if (value > maxLast) return null;
  let total = value;
  for (let i = 0; i < nums.length - 1; i++) total += nums[i] * Math.pow(256, 3 - i);
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) bytes[i] = Math.floor(total / Math.pow(256, 3 - i)) % 256;
  return bytes;
}

/**
 * Parse an IPv6 address in any text form: compressed or expanded, upper or
 * lower case, with a zone id, with brackets, and with an embedded IPv4 tail.
 * @param {string} input
 * @returns {Uint8Array|null} 16 bytes, or null when it is not an IPv6 address
 */
function parseIpv6(input) {
  let text = String(input).trim();
  if (text.startsWith("[")) text = text.slice(1);
  if (text.endsWith("]")) text = text.slice(0, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  // An embedded IPv4 tail stands for the last two groups.
  const lastColon = text.lastIndexOf(":");
  const tailPart = text.slice(lastColon + 1);
  if (tailPart.includes(".")) {
    const v4 = parseDottedQuad(tailPart);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = text.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const dbl = text.indexOf("::");
  if (dbl !== -1 && text.indexOf("::", dbl + 1) !== -1) return null;
  const headText = dbl === -1 ? text : text.slice(0, dbl);
  const tailText = dbl === -1 ? null : text.slice(dbl + 2);
  const toGroups = (s) => (s === "" ? [] : s.split(":"));
  const toNumbers = (groups) => groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = toNumbers(toGroups(headText));
  const tail = tailText === null ? [] : toNumbers(toGroups(tailText));
  if (head.some((n) => Number.isNaN(n)) || tail.some((n) => Number.isNaN(n))) return null;

  let groups;
  if (tailText === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 255;
    bytes[i * 2 + 1] = groups[i] & 255;
  }
  return bytes;
}

/** An address as bytes: IPv6 when it holds a colon, else every IPv4 spelling. */
function parseAddress(text) {
  const raw = String(text ?? "").trim();
  if (raw.includes(":")) {
    const bytes = parseIpv6(raw);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIpv4AnyBase(raw);
  return bytes ? { family: 4, bytes } : null;
}

/** The canonical text of an address, for comparing against the exception list. */
function canonicalAddress(text) {
  const parsed = parseAddress(text);
  if (!parsed) return null;
  return parsed.family === 4 ? joinBytes(parsed.bytes) : formatIpv6(parsed.bytes);
}

/** @param {Uint8Array} bytes */
function joinBytes(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** RFC 5952-ish text: lower case, longest run of zero groups compressed. */
function formatIpv6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
    i = j;
  }
  if (bestLen < 2) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLen).join(":")}`;
}

// ---------------------------------------------------------------------------
// Classifying addresses
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} b 4 bytes
 * @returns {string|null} the reason, or null when the address is public
 */
function classifyV4(b) {
  if (b[0] === 169 && b[1] === 254 && b[2] === 169 && b[3] === 254) return METADATA;
  if (b[0] === 100 && b[1] === 100 && b[2] === 100 && b[3] === 200) return METADATA;
  // 168.63.129.16: the Azure wireserver (a metadata-ish endpoint), reachable
  // from every Azure VM on a public-looking address.
  if (b[0] === 168 && b[1] === 63 && b[2] === 129 && b[3] === 16) return METADATA;
  // 192.0.0.0/24: .192 is another cloud metadata endpoint, the rest is reserved.
  if (b[0] === 192 && b[1] === 0 && b[2] === 0) return b[3] === 192 ? METADATA : "reserved address";
  // The three documentation ranges (RFC 5737).
  if (b[0] === 192 && b[1] === 0 && b[2] === 2) return "documentation address";
  if (b[0] === 198 && b[1] === 51 && b[2] === 100) return "documentation address";
  if (b[0] === 203 && b[1] === 0 && b[2] === 113) return "documentation address";
  // 192.88.99.0/24: the 6to4 relay anycast range (RFC 7526, deprecated).
  if (b[0] === 192 && b[1] === 88 && b[2] === 99) return "reserved (6to4 relay) address";
  if (b[0] === 0) return "unspecified address";
  if (b[0] === 127) return "loopback address";
  if (b[0] === 10) return "private network";
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return "private network";
  if (b[0] === 192 && b[1] === 168) return "private network";
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return "tailnet (carrier-grade NAT) address";
  if (b[0] === 169 && b[1] === 254) return "link-local address";
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return "reserved (benchmark) address";
  if (b[0] >= 224) return "multicast or reserved address";
  return null;
}

/**
 * @param {Uint8Array} b 16 bytes
 * @returns {string|null} the reason, or null when the address is public
 */
function classifyV6(b) {
  const zeroBefore = (end) => {
    for (let i = 0; i < end; i++) if (b[i] !== 0) return false;
    return true;
  };
  const zeroBetween = (from, to) => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false;
    return true;
  };

  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2) return METADATA; // fd00:ec2::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation address"; // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "reserved (Teredo tunnel) address"; // 2001::/32
  if (b[0] === 0x01 && b[1] === 0x00 && zeroBetween(2, 8)) return "discard-only address"; // 100::/64
  if (zeroBefore(16)) return "unspecified address"; // ::
  if (zeroBefore(15) && b[15] === 1) return "loopback address"; // ::1
  // Forms that carry an IPv4 destination are judged by that destination.
  if (zeroBefore(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)); // ::ffff:a.b.c.d
  if (zeroBefore(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return classifyV4(b.slice(12)); // ::ffff:0:a.b.c.d (SIIT / IPv4-translated)
  }
  // ISATAP (RFC 5214) in any prefix: the interface id is 0000:5efe:a.b.c.d or
  // 0200:5efe:a.b.c.d, so the destination is the IPv4 address it carries.
  if (((b[8] === 0x00 && b[9] === 0x00) || (b[8] === 0x02 && b[9] === 0x00)) && b[10] === 0x5e && b[11] === 0xfe) {
    return classifyV4(b.slice(12));
  }
  if (zeroBefore(12)) return classifyV4(b.slice(12)); // ::a.b.c.d (IPv4-compatible)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeroBetween(4, 12)) {
    return classifyV4(b.slice(12)); // 64:ff9b::/96 (NAT64)
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) {
    // 64:ff9b:1::/48 (local-use NAT64): judged by the IPv4 address in its low
    // 32 bits, refused outright when there is not one to decode.
    const embedded = b.length === 16 ? b.slice(12) : null;
    if (!embedded) return "reserved (local-use NAT64) address";
    return classifyV4(embedded);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 2002::/16 (6to4)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local address"; // fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "site-local address"; // fec0::/10
  if ((b[0] & 0xfe) === 0xfc) return "unique-local address"; // fc00::/7
  if (b[0] === 0xff) return "multicast address"; // ff00::/8
  return null;
}

/**
 * The reason an address is off limits, or null when it is public.
 *
 * Every spelling of an address is accepted here (dotted, hex, octal, short
 * forms, and every IPv6 text form). Anything that is not an address throws:
 * callers must not mistake a host name for a public address.
 * @param {string} ip
 * @returns {string|null}
 */
export function classifyIp(ip) {
  const parsed = parseAddress(ip);
  if (!parsed) throw new TypeError(`not an IP address: ${String(ip)}`);
  return parsed.family === 4 ? classifyV4(parsed.bytes) : classifyV6(parsed.bytes);
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/**
 * Split a URL hostname into an address or a name.
 *
 * Recognises every inet_aton IPv4 encoding (2130706433, 0x7f000001,
 * 017700000001, 127.1, mixed bases) and returns the dotted quad, and takes the
 * brackets and the zone id off an IPv6 address. A trailing dot is dropped and
 * the result is lowercased.
 * @param {string} host
 * @returns {{kind: "ip", ip: string}|{kind: "name", name: string}}
 */
export function parseHost(host) {
  let text = String(host ?? "").trim();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    text = end === -1 ? text.slice(1) : text.slice(1, end);
  }
  if (text.endsWith(".")) text = text.slice(0, -1);
  text = text.toLowerCase();
  if (text.includes(":")) {
    return parseIpv6(text) ? { kind: "ip", ip: text } : { kind: "name", name: text };
  }
  const bytes = parseIpv4AnyBase(text);
  if (bytes) return { kind: "ip", ip: joinBytes(bytes) };
  return { kind: "name", name: text };
}

// ---------------------------------------------------------------------------
// The owner's exception list
// ---------------------------------------------------------------------------

/**
 * Split an exception list into entries.
 *
 * A comma or a space separates entries, but a space inside a range
 * (`10.0.0.1/ 8`) does not: that entry is malformed, and keeping it whole lets
 * it be reported as rejected instead of silently becoming two entries, one of
 * which (`8`, read as the address 0.0.0.8) would except something nobody wrote.
 * @param {string|undefined} text
 * @returns {string[]}
 */
function splitExceptionEntries(text) {
  const entries = [];
  for (const chunk of String(text ?? "").split(",")) {
    const pieces = chunk.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i] === "/" && i + 1 < pieces.length) {
        entries.push(`/${pieces[++i]}`);
        continue;
      }
      if (pieces[i].endsWith("/") && i + 1 < pieces.length) {
        entries.push(`${pieces[i]} ${pieces[++i]}`);
        continue;
      }
      entries.push(pieces[i]);
    }
  }
  return entries;
}

/**
 * Parse an owner-supplied exception list: a comma or space separated string of
 * host names, IP addresses and CIDR ranges. Invalid entries are ignored and
 * reported in `rejected`.
 *
 * An entry here makes a non-metadata refusal pass. Cloud-metadata addresses
 * are never excepted, even when a CIDR covers them. A host name excepts
 * whatever that name resolves to (loopback included); see the docs.
 * @param {string|undefined} text
 * @returns {{hosts: Set<string>, cidrs: Array<{family: number, bytes: Uint8Array, prefix: number}>, rejected: string[]}}
 */
export function parseExceptions(text) {
  const hosts = new Set();
  const cidrs = [];
  const rejected = [];
  for (const entry of splitExceptionEntries(text)) {
    if (!entry) continue;
    if (entry.includes("/")) {
      // A range: a.b.c.d/n or an IPv6 address/n, both judged by their bytes.
      const cut = entry.lastIndexOf("/");
      const addressText = entry.slice(0, cut);
      const prefixText = entry.slice(cut + 1);
      const quad = parseDottedQuad(addressText);
      const v6 = quad ? null : parseIpv6(addressText);
      const range = quad ? { family: 4, bytes: quad } : (v6 ? { family: 6, bytes: v6 } : null);
      const maxPrefix = range && range.family === 4 ? 32 : 128;
      const prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
      if (!range || !(prefix >= 0 && prefix <= maxPrefix)) {
        rejected.push(entry);
        continue;
      }
      cidrs.push({ family: range.family, bytes: range.bytes, prefix });
      continue;
    }
    const host = parseHost(entry);
    if (host.kind === "ip") {
      const canonical = canonicalAddress(host.ip);
      if (canonical) hosts.add(canonical); else rejected.push(entry);
      continue;
    }
    if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host.name)) {
      hosts.add(host.name);
      continue;
    }
    rejected.push(entry);
  }
  return { hosts, cidrs, rejected };
}

/** True when one address is inside one CIDR entry. */
function cidrCovers(entry, family, bytes) {
  if (entry.family !== family) return false;
  const bits = entry.prefix;
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i++) if (entry.bytes[i] !== bytes[i]) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (entry.bytes[whole] & mask) === (bytes[whole] & mask);
}

/** True when the owner's list names this host name (or this address) outright. */
function hostExcepted(hostName, exceptions) {
  if (!hostName || !exceptions) return false;
  return exceptions.hosts.has(String(hostName).toLowerCase().replace(/\.$/, ""));
}

/** True when the owner's list names this address, or a CIDR in it covers it. */
function addressExcepted(address, exceptions) {
  if (!exceptions) return false;
  const parsed = parseAddress(address);
  if (!parsed) return false;
  const canonical = parsed.family === 4 ? joinBytes(parsed.bytes) : formatIpv6(parsed.bytes);
  if (exceptions.hosts.has(canonical)) return true;
  return exceptions.cidrs.some((entry) => cidrCovers(entry, parsed.family, parsed.bytes));
}

/** The exception list from the add-on's settings (owner-set, never a tool argument). */
export function exceptionsFromEnv(env = process.env) {
  return parseExceptions(env && env.CROW_BROWSER_ALLOW_PRIVATE);
}

// ---------------------------------------------------------------------------
// Checking a URL
// ---------------------------------------------------------------------------

/** The addresses of a name, reused for a few seconds so sub-requests do not each look it up. */
async function resolveName(name, opts) {
  const resolve = typeof opts.resolve === "function" ? opts.resolve : async (host) => {
    const answers = await dnsPromises.lookup(host, { all: true, verbatim: true });
    return answers.map((answer) => answer.address);
  };
  if (!opts.noCache) {
    const hit = nameCache.get(name);
    if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.addresses;
  }
  const answers = await resolve(name);
  const addresses = Array.isArray(answers) ? answers.map((answer) => String(answer)) : [];
  if (addresses.length) nameCache.set(name, { at: Date.now(), addresses });
  return addresses;
}

/**
 * Judge one URL before it is loaded.
 *
 * `mode: "navigate"` allows http(s) and ws(s) only (plus `about:blank`).
 * `mode: "subrequest"` also allows data:, blob: and about:blank, which carry no
 * network destination. A literal address is classified directly; a name is
 * resolved and EVERY answer must be public. The owner's exception list is
 * consulted last, and never for metadata.
 *
 * @param {string} url
 * @param {{resolve?: (host: string) => Promise<string[]>, exceptions?: object, mode?: "navigate"|"subrequest", noCache?: boolean}} [opts]
 * @returns {Promise<{ok: true}|{ok: false, reason: string, host: string, address?: string}>}
 */
export async function checkUrl(url, opts = {}) {
  const mode = opts.mode === "subrequest" ? "subrequest" : "navigate";
  const exceptions = opts.exceptions || NO_EXCEPTIONS;

  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return { ok: false, reason: "invalid URL", host: "" };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "about:" && parsed.href === "about:blank") return { ok: true };
  const networked = scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:";
  if (!networked) {
    if (mode === "subrequest" && (scheme === "data:" || scheme === "blob:")) return { ok: true };
    return { ok: false, reason: `scheme not allowed (${scheme})`, host: parsed.hostname || "" };
  }

  const host = parsed.hostname;
  if (!host) return { ok: false, reason: "invalid URL", host: "" };
  const parsedHost = parseHost(host);

  if (parsedHost.kind === "ip") {
    let reason;
    try {
      reason = classifyIp(parsedHost.ip);
    } catch {
      return { ok: false, reason: "invalid URL", host };
    }
    if (!reason) return { ok: true };
    if (reason === METADATA) return { ok: false, reason, host, address: parsedHost.ip };
    if (addressExcepted(parsedHost.ip, exceptions)) return { ok: true };
    return { ok: false, reason, host, address: parsedHost.ip };
  }

  const name = parsedHost.name;
  if (name === "localhost" || name.endsWith(".localhost")) {
    if (hostExcepted(name, exceptions)) return { ok: true };
    return { ok: false, reason: "loopback address", host: name };
  }
  if (METADATA_NAMES.has(name)) return { ok: false, reason: METADATA, host: name };

  let addresses;
  try {
    addresses = await resolveName(name, opts);
  } catch {
    return { ok: false, reason: UNRESOLVED, host: name };
  }
  if (!addresses.length) return { ok: false, reason: UNRESOLVED, host: name };

  const nameExcepted = hostExcepted(name, exceptions);
  let uncovered = null;
  for (const address of addresses) {
    let reason;
    try {
      reason = classifyIp(address);
    } catch {
      reason = "unrecognised address";
    }
    if (!reason) continue;
    if (reason === METADATA) return { ok: false, reason, host: name, address };
    if (nameExcepted || addressExcepted(address, exceptions)) continue;
    if (!uncovered) uncovered = { reason, address };
  }
  if (uncovered) return { ok: false, reason: uncovered.reason, host: name, address: uncovered.address };
  return { ok: true };
}

/** The sentence a tool hands a model when it refuses a destination. */
function refusalText(r) {
  const host = r && r.host ? r.host : "that host";
  const reason = r && r.reason ? r.reason : "private or local-network address";
  const address = r && r.address && r.address !== r.host ? ` (${r.address})` : "";
  return `${REFUSAL_HEAD}.\n\nHost: ${host}${address}\nReason: ${reason}\n\n` +
    "That covers loopback, private-network, tailnet, link-local, reserved and cloud-metadata addresses. " +
    "If this destination is intended, the owner can allow that specific host or range in the browser add-on " +
    "setting CROW_BROWSER_ALLOW_PRIVATE (a comma-separated list of host names, IP addresses and CIDR ranges, " +
    "for example 192.168.1.50 or 10.1.0.0/16). Cloud-metadata addresses are never allowed.";
}

/**
 * The MCP tool error for a refused URL.
 * @param {{reason: string, host: string, address?: string}} refusal
 */
export function refusalResult(refusal) {
  return { content: [{ type: "text", text: refusalText(refusal) }], isError: true };
}

// ---------------------------------------------------------------------------
// The Playwright guard
// ---------------------------------------------------------------------------

/**
 * Guard a Playwright BrowserContext.
 *
 * Every request the browser makes goes through `checkUrl` (so every redirect
 * hop, popup, new tab, subframe and sub-request is judged, not just the URL a
 * tool asked for), every WebSocket is judged before it connects, and every
 * response's server address is judged again — that last one catches a name
 * that the browser resolved differently from our own lookup (DNS rebinding).
 * Service workers' own requests cannot be intercepted, so their registration is
 * refused in the page (best effort), and the same init script replaces the
 * WebRTC constructors so a page cannot make a peer connection and send UDP at a
 * private address past every route (best effort too: a worker still has them).
 * That init script is installed as source text whose first line is
 * `GUARD_MARKER`. The marker tags the source only: Playwright wraps the text, so
 * it is not the first line Chromium evaluates, and nothing in the product reads
 * it back — a live test checks the guard's page-world effects instead. What the
 * script does is unchanged.
 *
 * A name we cannot resolve is refused too (fail closed): the browser's own
 * resolver may still reach a private address, and a failed lookup is no
 * evidence that the destination is public. A literal address, or a name that
 * resolves to one, is refused as before.
 *
 * Chrome's own lookup cannot be pinned from Playwright, so a name that answers
 * differently when Chrome resolves it can reach a private address once. The
 * response check then blanks the page, records the refusal and poisons that
 * host for five minutes, so every later request to it is refused at the route
 * level (`POISON_REASON`).
 *
 * @param {object} context - Playwright BrowserContext
 * @param {{exceptions?: object, resolve?: (host: string) => Promise<string[]>, log?: (line: string) => void, now?: () => number}} [opts]
 */
export async function installPrivateAddressGuard(context, opts = {}) {
  const exceptions = opts.exceptions || NO_EXCEPTIONS;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const refusals = [];
  /** host name -> the moment its poison lapses */
  const poisoned = new Map();

  const poisonHost = (hostName) => {
    const key = String(hostName || "").toLowerCase();
    if (key) poisoned.set(key, now() + POISON_TTL_MS);
  };
  const isPoisoned = (hostName) => {
    const key = String(hostName || "").toLowerCase();
    if (!key) return false;
    const until = poisoned.get(key);
    if (until === undefined) return false;
    if (now() < until) return true;
    poisoned.delete(key);
    return false;
  };

  const record = (refusal) => {
    refusals.push(refusal);
    while (refusals.length > MAX_REFUSALS) refusals.shift();
  };
  const refuse = (url, verdict) => {
    const refusal = { url: String(url), reason: verdict.reason, host: verdict.host, address: verdict.address, at: now() };
    record(refusal);
    log(`[browser] refused ${refusal.host || "a destination"} (${refusal.reason})`);
    return refusal;
  };

  /** A server address, judged with the owner's list (and the name it was reached by). */
  const checkAddress = (addressText, hostName) => {
    let reason;
    try {
      reason = classifyIp(addressText);
    } catch {
      // An address we cannot parse is not evidence of a public destination.
      return { ok: false, reason: "unparseable address" };
    }
    if (!reason) return { ok: true };
    if (reason === METADATA) return { ok: false, reason };
    if (hostExcepted(hostName, exceptions)) return { ok: true };
    if (addressExcepted(addressText, exceptions)) return { ok: true };
    return { ok: false, reason };
  };

  const hostOf = (url) => {
    try {
      const parsedHost = parseHost(new URL(String(url)).hostname);
      return parsedHost.kind === "ip" ? parsedHost.ip : parsedHost.name;
    } catch {
      return "";
    }
  };

  const onRoute = async (route) => {
    let url = "";
    try {
      url = route.request().url();
    } catch {
      // A request we cannot even read is not continued: an uncontinued route
      // would hang the request, an abort fails closed.
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    // A host name that was already served from a private address stays refused,
    // whatever the resolver says now: the browser's own lookup is what rebound.
    const routeHost = hostOf(url);
    if (isPoisoned(routeHost)) {
      refuse(url, { reason: POISON_REASON, host: routeHost });
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    let verdict;
    try {
      verdict = await checkUrl(url, { mode: "subrequest", exceptions, resolve: opts.resolve });
    } catch {
      verdict = { ok: false, reason: "invalid URL", host: "" };
    }
    if (!verdict.ok) {
      // A name our own lookup could not resolve is refused like any other: a
      // failed lookup is no evidence of a public destination, and leaving it to
      // the browser would reach a private address before the response listener
      // below could blank the page.
      refuse(url, verdict);
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  };
  await context.route("**/*", onRoute);

  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/, async (ws) => {
      const url = ws.url();
      const wsHost = hostOf(url);
      if (isPoisoned(wsHost)) {
        refuse(url, { reason: POISON_REASON, host: wsHost });
        await ws.close({ code: 1008, reason: "private address" }).catch(() => {});
        return;
      }
      let verdict;
      try {
        verdict = await checkUrl(url, { mode: "subrequest", exceptions, resolve: opts.resolve });
      } catch {
        verdict = { ok: false, reason: "invalid URL", host: "" };
      }
      if (!verdict.ok) {
        refuse(url, verdict);
        await ws.close({ code: 1008, reason: "private address" }).catch(() => {});
        return;
      }
      await ws.connectToServer().catch(() => {});
    });
  }

  const onResponse = async (response) => {
    try {
      const addr = typeof response.serverAddr === "function" ? await response.serverAddr() : null;
      const served = addr && addr.ipAddress ? String(addr.ipAddress) : "";
      if (!served) return;
      const url = (() => {
        try { return response.url(); } catch { return ""; }
      })();
      const hostName = hostOf(url);
      const verdict = checkAddress(served, hostName);
      if (verdict.ok) return;
      refuse(url, { reason: verdict.reason, host: hostName || served, address: served });
      // The browser went somewhere our tools did not send it (a rebound name).
      // Blank the page, and refuse this host for a while: our own lookup cannot
      // pin Chrome's, so every later request is stopped at the route level.
      poisonHost(hostName);
      // The page just loaded a private-address document: its pagehide/unload
      // requests have to be failed at its own CDP session first, or they ride
      // this navigation out to that server.
      try {
        await blankPageSafely(response.frame().page());
      } catch { /* the page may already be gone */ }
    } catch { /* nothing to judge: a closed target or a response without a page */ }
  };
  context.on("response", onResponse);

  try {
    // Built as source text, not handed to Playwright as a function, so the marker
    // is the source's first line and survives Function#toString into the text
    // handed to Chromium for every new document. Playwright wraps that text, so
    // this is NOT the first line Chromium evaluates, and nothing in the product
    // reads the marker back: a live test checks the guard's page-world effects
    // instead.
    const initScript = () => {
      try {
        const refuse = () => Promise.reject(new Error("service workers are disabled in Crow's browser"));
        const patch = (target) => {
          if (!target) return;
          try {
            Object.defineProperty(target, "register", { value: refuse, configurable: true, writable: true });
          } catch {
            try { target.register = refuse; } catch { /* frozen: best effort */ }
          }
        };
        // The page's own container, and the prototype: a container created anew
        // (another realm, an iframe) does not go through this instance.
        const sw = navigator.serviceWorker;
        if (sw) patch(sw);
        const Container = typeof ServiceWorkerContainer === "function" ? ServiceWorkerContainer : null;
        if (Container && Container.prototype) patch(Container.prototype);

        // WebRTC: a peer connection gathers ICE host candidates on the machine's
        // own interfaces and sends UDP straight at a private address, which no
        // route this guard installs can see. Replace the constructors in this
        // frame with one that throws — on the page's global object AND on the
        // original prototypes, so `new RTCPeerConnection(...)` and a constructor
        // reached through an existing prototype chain both fail.
        const webrtcRefusal = () => new TypeError("WebRTC is disabled by Crow's private-address rule");
        const block = (target, name) => {
          if (!target) return null;
          const refuseToConstruct = function () { throw webrtcRefusal(); };
          try {
            Object.defineProperty(target, name, { value: refuseToConstruct, configurable: true, writable: true });
          } catch {
            try { target[name] = refuseToConstruct; } catch { /* frozen: best effort */ }
          }
          return refuseToConstruct;
        };
        let view = null;
        try {
          if (typeof window !== "undefined" && window) view = window;
          else if (typeof self !== "undefined" && self) view = self;
        } catch { view = null; }
        for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "RTCDataChannel"]) {
          let Original = null;
          try { Original = view ? view[name] : null; } catch { Original = null; }
          const refusal = block(view, name);
          try {
            if (Original && Original.prototype) {
              Object.defineProperty(Original.prototype, "constructor", {
                value: refusal, configurable: true, writable: true,
              });
            }
          } catch { /* frozen: best effort */ }
        }
      } catch { /* best effort */ }
    };
    await context.addInitScript(`// ${GUARD_MARKER}\n(${initScript.toString()})();`);
  } catch { /* best effort */ }

  return {
    refusals,
    /** Forget every recorded refusal (a tool clears them before it starts). */
    clearRefusals() {
      refusals.length = 0;
    },
    /**
     * The newest refusal, once, if it is newer than maxAgeMs.
     *
     * With `{ url }` only a refusal recorded for that URL's host is reported, so
     * a stale refusal left by an earlier call is not mistaken for this one's;
     * `{ any: true }` reports the newest refusal whatever host it names (the
     * navigate tool uses it, because a redirect may have been refused on a
     * different host than the one it was asked for).
     */
    takeRefusal(maxAgeMs = 60_000, opts = {}) {
      const asked = opts && typeof opts === "object" ? opts : {};
      const wantedHost = asked.any ? "" : (asked.url ? hostOf(asked.url) : "");
      const pool = wantedHost ? refusals.filter((r) => hostOf(r.url) === wantedHost || r.host === wantedHost) : refusals;
      const newest = pool.length ? pool[pool.length - 1] : null;
      refusals.length = 0;
      if (!newest) return null;
      return now() - newest.at <= maxAgeMs ? newest : null;
    },
    /** Judge an address the browser says it reached (a navigation's server address). */
    checkAddress,
  };
}

// ---------------------------------------------------------------------------
// The guard's lifetime: blank the pages when this process goes away
// ---------------------------------------------------------------------------

/** How long the exit cleanup may take before the process is let go. */
const EXIT_CLEANUP_BUDGET_MS = 2_000;
/**
 * What the exit cleanup keeps back from its own budget for the work that comes AFTER a
 * settle: blanking and closing need time once the classification is done, so a settle must
 * never be handed every millisecond the cleanup has. Two seconds minus this reserve is
 * still a generous bound for the classification wait itself.
 */
const SETTLE_RESERVE_MS = 500;
/**
 * How long the exit cleanup waits for a `Browser.crash` to answer before it lets
 * the process go. A crash never answers: the socket dies with the browser.
 */
const CRASH_GRACE_MS = 300;
/**
 * How long `blankPageSafely` keeps its deny-all session attached after the blank
 * navigation settled, so a pagehide/unload request still in flight is failed
 * rather than released.
 */
const BLANK_GRACE_MS = 500;
/**
 * How long the exit cleanup waits, after a page's about:blank commit was OBSERVED,
 * before it issues that page's `page.close()`.
 *
 * Navigating to about:blank can swap the renderer, and the OLD document's
 * pagehide/unload handlers then run asynchronously in the old renderer AFTER the
 * navigation resolved. Chromium bounds that work at about 500 ms (the browser-side
 * unload timeout): either the handlers ran by then, or the old frame is deleted
 * without running them. A close issued before that destroys the page's target, and
 * with it the deny-all CDP session those handlers' requests are failed by, so a
 * handler that runs after the close sends with nothing in front of it.
 *
 * So the close waits that whole timeout out, and 250 ms longer: Chromium's
 * browser-side unload timeout is about 500 ms, and a request a handler sends at the
 * very END of it is paused at Fetch, where failing it still needs a round trip
 * through this process. `BLANK_GRACE_MS` (500 ms) is the timeout itself; this is
 * that plus the round trip.
 *
 * The wait is per PAGE and starts at that page's own commit, so the graces of
 * several pages overlap; they are never slept one after another.
 */
const UNLOAD_GRACE_MS = 750;
/**
 * The exit cleanup's WORST CASE, as ONE number: its budget, then a page's unload grace,
 * then two crash graces (the bounded wait the budget's exemption takes, and the
 * `Browser.crash` that wait ends in when it ran out with a page still open).
 *
 * Every SIGTERM->SIGKILL gap that can end this process has to stay above it — the pi
 * reaper's `REAP_KILL_GRACE_MS`, the satellite's `KILL_GRACE_MS`, the bridge's 5000 ms
 * bound — because a cleanup cut off half way leaves open pages behind routes that went
 * with the process. Exported so those bounds are compared against THIS number instead of
 * a sum re-derived by hand in each place. 3350 ms with the values above.
 */
export const EXIT_CLEANUP_WORST_CASE_MS = EXIT_CLEANUP_BUDGET_MS + UNLOAD_GRACE_MS + 2 * CRASH_GRACE_MS;
/**
 * The clock the close grace is counted on: monotonic, so a wall-clock jump (an NTP
 * step, a manual set) can neither shorten a page's grace nor stretch it. The values
 * it produces are only ever compared with each other, never with `Date.now()`.
 */
const monotonicNow = () => performance.now();

/**
 * The exit cleanup already registered for each proc.
 *
 * One proc gets one registration, and that registration holds ONE PAIR PER SERVER
 * (a context getter plus the page ownership it belongs to). A caller that reconnects
 * and calls `blankPagesOnExit` again only replaces its own pair's getter and is handed
 * the same cleanup back, instead of adding a second set of listeners that would run a
 * second cleanup on the same pages; a SECOND server in the same process keeps its own
 * pair, so neither server's pages are dropped from the cleanup.
 */
const exitRegistrations = new WeakMap();

/**
 * One page's class, with a classification that THROWS counted as "bot".
 *
 * `ownership.classify()` throwing is the one answer that proves nothing at all: it cannot be
 * read as "not the bot's", because that leaves the page unblanked and unclosed behind routes
 * that go away with this process. So it fails CLOSED and the page is cleaned like any page of
 * the bot's. A classification that answers normally is handed back untouched, so the
 * operator and uncertain classes keep their own handling (an uncertain page is still left
 * alone, and still counted for the one line that names it).
 *
 * @param {{classify: (page: object) => string}} ownership
 * @param {object} page
 * @returns {string} "bot", "operator", "uncertain", or "bot" when the call threw
 */
function classifyOrBot(ownership, page) {
  try {
    return ownership.classify(page);
  } catch {
    return "bot";
  }
}

/** Detach a CDP session without letting its failure matter. */
async function detachQuietly(cdp) {
  if (!cdp || typeof cdp.detach !== "function") return;
  try {
    const detached = cdp.detach();
    if (detached && typeof detached.catch === "function") await detached.catch(() => {});
  } catch { /* already gone: nothing to release */ }
}

/**
 * Detach a CDP session, but stop waiting for it after `ms`.
 *
 * The detach is best effort, and the callers of this one KEEP RUNNING: a session on a
 * connection that has already gone quiet can leave `detach()` unanswered for good, and a
 * caller held there would never start the next call — the safe close is serialised on one
 * chain, so ONE hung detach would wedge every later restart, proxy change and launch in the
 * process. A detach still outstanding at the grace is let go: it is already useless to a
 * caller that has moved on, and the browser drops that session with the connection.
 *
 * The timer is unref'd, so a detach that never answers cannot hold the process open either.
 * `detachQuietly` never throws, so this never rejects.
 *
 * @param {object} cdp
 * @param {number} ms
 * @returns {Promise<void>}
 */
function detachWithin(cdp, ms) {
  return new Promise((resolve) => {
    let answered = false;
    let timer = null;
    const finish = () => {
      if (answered) return;
      answered = true;
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, ms);
    if (typeof timer.unref === "function") timer.unref();
    detachQuietly(cdp).then(finish, finish);
  });
}

/**
 * Is this the error Playwright raises for a frame that is NOT out-of-process?
 *
 * `context.newCDPSession(frame)` only offers a session for an out-of-process
 * iframe (OOPIF): any other frame shares its process — and therefore its CDP
 * session — with the page, so there is nothing to attach for it. Exactly that
 * error is expected and ignored; anything else is a real failure.
 */
function isSameProcessFrameError(err) {
  const message = String((err && err.message) || err || "");
  return message.includes("does not have a separate CDP session") || message.includes("part of the parent frame");
}

/** Fail every request a session sees, before it leaves: one paused request, failed. */
function denyEveryRequest(cdp) {
  return (e) => {
    try {
      const failed = cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
      if (failed && typeof failed.catch === "function") failed.catch(() => {});
    } catch { /* the session went with the page: nothing left to fail */ }
  };
}

/**
 * Attach a deny-all raw CDP Fetch session to one page AND to every out-of-process
 * iframe of it, and hand back a handle that detaches all of them.
 *
 * This is a different layer from the context route guard, and it is the only
 * layer that sees what a page sends while it UNLOADS: a sendBeacon, a
 * `keepalive` fetch or an Image fired from pagehide/unload rides the navigation
 * away without passing through Playwright's interception, so the route guard
 * never judges it (verified live on Chromium 143, see
 * tests/browser-close-leak-live.test.js). Attaching this BEFORE the navigation
 * that fires those handlers is what stops them.
 *
 * A page's own session does NOT cover a CROSS-SITE iframe: with site isolation
 * on, such a frame is an out-of-process iframe (OOPIF) living in its own target
 * with its own CDP session, so the frame's pagehide/unload beacons would ride the
 * blank and the close out to the private server while the page's session held
 * (see the cross-site case in tests/browser-close-leak-live.test.js). So every
 * frame `page.frames()` lists besides `page.mainFrame()` is given the same
 * treatment (`context.newCDPSession(frame)`), and the handle below forgets none
 * of them. A frame that is not out-of-process has no session to attach and is
 * already covered by the page's: Playwright says so with an error naming that,
 * and ONLY that error is ignored (see `isSameProcessFrameError`). A page with no
 * `frames` at all — a fake page in the unit tests — yields the page session alone.
 *
 * A frame session denies ALL traffic at TWO layers, and both go on before the
 * caller navigates. `Fetch.enable` plus the `Fetch.requestPaused` handler fails a
 * paused request outright. That fail, though, is a ROUND TRIP through this
 * process, and the frame's target is torn down WHILE the page navigates: on a
 * live run the session died before `Fetch.failRequest` landed ("Target page,
 * context or browser has been closed") and the paused pagehide/unload requests
 * were released to the private server. So `Network.enable` and
 * `Network.setBlockedURLs` with `{ urls: ["*"] }` follow it: that one is enforced
 * inside the frame's own network stack, with no round trip, so it holds whatever
 * happens to this process's session. Both are kept on purpose — the Fetch handler
 * for the requests it can reach, the URL block for the ones it cannot.
 *
 * `null` comes back ONLY for a page that offers no `context().newCDPSession` (a
 * fake page in the unit tests): there is nothing to attach, and such a page is
 * simply blanked. A page that COULD have a session but whose attach fails — the
 * context rejects `newCDPSession` for the page or, for any reason other than the
 * same-process one, for a frame, a session has no `send`/`on`, or any of
 * `Fetch.enable`, `Network.enable` and `Network.setBlockedURLs` rejects — is not
 * a page anyone can safely navigate: everything already made is detached
 * best-effort and the error is THROWN. Callers fail closed on it: the exit path
 * crashes the browser, and `blankPageSafely` refuses to navigate at all, because
 * firing that page's pagehide beacons with no deny-all session in front of them
 * is exactly the leak this exists to stop.
 *
 * `opts.permanent` says the page is being blanked for good, not reused: the exit
 * path passes it (nothing is detached there), `blankPageSafely` does not (its page
 * keeps running after the detach). A permanent page's OWN session gets the same
 * `Network.enable` + `Network.setBlockedURLs { urls: ["*"] }` pair a frame session
 * gets, for the same reason: the Fetch fail is a round trip through this process,
 * and the page's target can die before it lands, releasing the paused
 * pagehide/unload requests. A page that is reused must NOT get it, because the
 * block is installed in the page's own network stack: it would keep denying every
 * request after the session (and so the Fetch handler) has been detached. A
 * failure of either send is a failed attach, exactly like `Fetch.enable`.
 *
 * @param {object} page
 * @param {{permanent?: boolean}} [opts] `permanent: true` when the page will not be
 *   reused after this (the exit path), so its own session is blocked at both layers
 * @returns {Promise<{detach: () => Promise<void>} | null>} a handle that detaches the
 *   page session and every frame session (never throws), or null when there is
 *   nothing to attach
 */
async function attachDenyAllSession(page, opts = {}) {
  const asked = opts && typeof opts === "object" ? opts : {};
  const permanent = asked.permanent === true;
  let cdp = null;
  const frameSessions = [];
  try {
    const context = page && typeof page.context === "function" ? page.context() : null;
    if (!context || typeof context.newCDPSession !== "function") return null;
    cdp = await context.newCDPSession(page);
    if (!cdp || typeof cdp.on !== "function" || typeof cdp.send !== "function") {
      throw new Error("the CDP session offered for this page has no on/send");
    }
    cdp.on("Fetch.requestPaused", denyEveryRequest(cdp));
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

    // A page that is going away for good gets the round-trip-free layer too: the
    // Fetch fail above is a round trip through this process, and the page's target
    // is torn down WHILE it navigates (measured on OOPIF frames: the session died
    // before the fail landed and the paused unload requests were released). This
    // block is enforced in the page's own network stack, so it holds even when the
    // session does not outlive the navigation. A page that is REUSED after the
    // blank must not have it: it would outlive the detach and keep denying.
    if (permanent) {
      await cdp.send("Network.enable");
      // `urls` is deprecated in newer Chromium in favour of `urlPatterns`. It is
      // honoured on the Chromium the live tests ran on, and a live test — the
      // cross-site case in tests/browser-close-leak-live.test.js — is what would
      // fail if it stopped being honoured.
      await cdp.send("Network.setBlockedURLs", { urls: ["*"] });
    }

    // The page's session stops the page's own requests, not an OOPIF frame's: a
    // cross-site frame is its own target, so it needs its own deny-all session.
    if (typeof page.frames === "function") {
      const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;
      for (const frame of page.frames() || []) {
        if (!frame || frame === mainFrame) continue;
        let frameCdp = null;
        try {
          frameCdp = await context.newCDPSession(frame);
        } catch (err) {
          // A same-process frame has no session of its own: the page's session
          // already covers it, so there is nothing to attach and nothing to fail.
          if (isSameProcessFrameError(err)) continue;
          throw err;
        }
        frameSessions.push(frameCdp);
        if (!frameCdp || typeof frameCdp.on !== "function" || typeof frameCdp.send !== "function") {
          throw new Error("the CDP session offered for a frame has no on/send");
        }
        frameCdp.on("Fetch.requestPaused", denyEveryRequest(frameCdp));
        await frameCdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        // Fetch.failRequest is a round trip through this process, and the frame's
        // target is torn down WHILE the page navigates: on a live run the session
        // died before the fail landed ("Target page, context or browser has been
        // closed"), so the paused pagehide/unload requests were released to the
        // private server. Block in the frame's own network stack as well:
        // Network.setBlockedURLs is enforced there with no round trip, and holds
        // even when the session does not outlive the navigation. The Fetch handler
        // above STAYS (belt and braces): it fails what it can reach, and this is
        // the layer that does not depend on the session's lifetime.
        await frameCdp.send("Network.enable");
        // `urls` is deprecated in newer Chromium in favour of `urlPatterns`. It is
        // honoured on the Chromium the live tests ran on, and a live test — the
        // cross-site case in tests/browser-close-leak-live.test.js — is what would
        // fail if it stopped being honoured.
        await frameCdp.send("Network.setBlockedURLs", { urls: ["*"] });
      }
    }

    const made = [cdp, ...frameSessions];
    return {
      /** Detach every session this attach made, best effort, never throwing. */
      async detach() {
        for (const session of made) {
          try {
            await detachQuietly(session);
          } catch { /* nothing left to release */ }
        }
      },
    };
  } catch (err) {
    for (const session of frameSessions) await detachQuietly(session);
    await detachQuietly(cdp);
    throw err;
  }
}

/**
 * Send one page to about:blank without letting the document it just had send
 * anything on its way out (pagehide/unload beacons, `keepalive` fetches, images).
 *
 * The context route guard does not see those requests (see
 * `attachDenyAllSession`), and a page that has just loaded a private-address
 * document is exactly where they are fired. So: attach the deny-all session
 * FIRST, blank the page, then — still in the `finally`, so a failed `goto` gets
 * the same treatment — wait `opts.graceMs` (default 500 ms, `0` for none) and
 * DETACH the session, so the page stays usable by later navigations (unlike the
 * exit path, this page lives on). The grace is there because a pagehide/unload
 * request can still be in flight when the about:blank navigation resolves:
 * detaching right then releases anything still paused and re-opens the very leak
 * the session was attached to stop. The attach covers the page AND every
 * out-of-process (cross-site) iframe of it, and the detach releases all of them
 * together: an OOPIF frame's unload beacons are not seen by the page's session,
 * and a frame left attached would keep denying requests on a page that lives on.
 *
 * A page that cannot be given a deny-all session is not navigated at all: the
 * attach throws before the `goto`, so nothing fires unguarded. That includes a
 * frame session whose `Network.enable` or `Network.setBlockedURLs` rejects (see
 * `attachDenyAllSession`: the frame is blocked at both layers or not at all). A
 * `goto` that fails still propagates exactly as `page.goto` does (the session is
 * detached first), so a caller's existing `.catch` handling is unchanged.
 *
 * The attach is deliberately NOT `permanent` (see `attachDenyAllSession`): this
 * page is reused after the detach, and a network-stack block installed in the
 * page's own stack would survive the detach and keep denying every later request
 * it made. The exit path, which never detaches, passes `permanent: true`.
 *
 * @param {object} page
 * @param {{graceMs?: number}} [opts]
 * @returns {Promise<void>}
 */
export async function blankPageSafely(page, opts = {}) {
  const asked = opts && typeof opts === "object" ? opts : {};
  const graceMs = Number.isFinite(asked.graceMs) ? Math.max(0, asked.graceMs) : BLANK_GRACE_MS;
  const cdp = await attachDenyAllSession(page);
  try {
    await page.goto("about:blank");
  } finally {
    if (cdp && graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
    await detachQuietly(cdp);
  }
}

/**
 * Blank the guarded context's pages when this process goes away.
 *
 * The route guard lives in THIS process's Playwright connection: the moment the
 * MCP server exits, its routes go with it and a page left open keeps running
 * unguarded. This registers ONE set of exit handlers per proc (stdin
 * "close"/"end", SIGTERM, SIGINT, "beforeExit"), and they all run ONE cleanup —
 * swallowing errors and spending at most `EXIT_CLEANUP_WORST_CASE_MS` in total (3350 ms
 * with the values here: a 2000 ms budget; then up to 750 ms of unload grace plus 300 ms
 * of crash grace for the bounded wait the budget's exemption takes when every page is
 * already handled; then up to another 300 ms of crash grace for the `Browser.crash` that
 * wait ends in when it ran out with a page still open behind it). Every process that
 * SIGTERMs this one and SIGKILLs it later has to give it longer than that.
 *
 * TWO MODES. With `opts.ownership` (the MCP server passes it) the cleanup cleans
 * up only the pages this MCP opened or drove (see `page-ownership.js`), and every
 * other page — the operator's own VNC tabs, another CDP client's tab — is left
 * exactly as it is: never navigated, never closed, never given a CDP session, never
 * written to and never probed (no method is called on it at all), so it cannot be
 * affected at all. The fresh page-list read taken right before a close is what says
 * such a page is still there (see THE LAST-PAGE CHECK). Without `opts.ownership`,
 * the legacy behaviour below is kept: every page in the context is blanked and closed.
 *
 * The ownership mode, in order:
 *
 *  0. Open the browser-level CDP session FIRST, as the legacy mode does (the crash
 *     below may need it, and by then there is no time to open one).
 *  1. `ownership.settle()`, then read `context.pages()`. A page that appeared a
 *     moment ago is classified by an asynchronous `opener()` lookup, and a page
 *     read out of the middle of that lookup would be treated as nobody's. Every
 *     page is then classed `bot`, `operator` or `uncertain`; BOT pages are the only
 *     ones this cleanup will touch.
 *  2. One `console.error` line names the count of UNCERTAIN pages (a page that
 *     appeared after the ownership attached with no resolvable opener AND no CDP
 *     `openerId`: another CDP client's tab, or one the operator opened themselves).
 *     They are left alone like the operator's, for these reasons: a deny-all Fetch
 *     session dies with this process, so it protects nothing after the exit; a block
 *     that would survive us (`Network.setBlockedURLs`) would leave an operator or
 *     lane-A tab permanently dead with nothing left to remove it; and closing or
 *     blanking would destroy a tab nobody can prove is the bot's. Residual risk,
 *     recorded on purpose, and narrower than it used to be: an INDEPENDENT tab (no
 *     opener at all, so nobody opened it from a page in this browser) keeps running
 *     unguarded after the exit, because the routes that refused private addresses
 *     went with this process. Nothing else is left unguarded — a popup of a bot page
 *     is the bot's whether or not its opener survived, and a page whose class could
 *     not be decided at all fails closed (see `page-ownership.js`).
 *
 *     A page is the OPERATOR's only on positive proof (it existed at attach, its
 *     `opener()` resolved to an operator page, or its CDP `openerId` is the target id
 *     of a LIVE operator page, resolved on demand); every other arrival is BOT and is
 *     cleaned up. The limits that are accepted, recorded on purpose: an OPERATOR popup
 *     whose operator opener tab closed first, or any page created in the operator's VNC
 *     browser with an `openerId` this process cannot prove, is blanked and closed at the
 *     exit — it cannot be told apart from a popup of a bot tab, and the alternative is a
 *     page of the bot's left armed behind routes that went with this process. A
 *     reconnect after a bot mark whose target id never resolved cleans the unmatched
 *     tabs for the same reason. An INDEPENDENT tab (no `openerId` at all: another CDP
 *     client's tab, the operator's fresh Ctrl+T) is NOT affected — it answers "nobody
 *     opened this", stays uncertain and is left exactly as an operator page is.
 *  3. No bot page at all: nothing happens — no survivor, no navigation, no close,
 *     no crash. The `console.error` line about the uncertain pages (if any) is the
 *     whole record of that cleanup.
 *  4. A FRESH survivor (`context.newPage()`) is created FIRST, but ONLY when no
 *     non-bot live page would remain — i.e. when every page the context holds is
 *     the bot's. Why no survivor when an operator (or uncertain) page exists: that
 *     page keeps the browser alive on its own, and a fresh blank tab left behind on
 *     every turn would pile up in the window the operator is looking at. Why one IS
 *     needed when every page is the bot's: the headful last-page rule — closing the
 *     last page exits the whole browser — so the survivor has to exist before the
 *     first close. A survivor that cannot be created fails closed (crash, no closer
 *     and no navigation). This is the answer for the pages read at the START; every
 *     close is preceded by the same question asked again, against the pages that exist
 *     at that moment (see THE LAST-PAGE CHECK).
 *  5. Then, one at a time, only the bot's pages: settle again, RE-READ the pages
 *     (a popup the old document opens while it is being blanked is a live,
 *     unguarded page too, and the initial snapshot would never see it; a page
 *     already handled is skipped, so the loop ends when no bot page is left),
 *     detach-free deny-all session attach, blank, observed about:blank commit, then a
 *     close scheduled for that page's commit plus `UNLOAD_GRACE_MS` (see THE GRACE
 *     below). The fail-closed rules of the legacy mode apply unchanged to a bot
 *     page: an unattachable page, a blank that rejects and a blank whose commit was
 *     never observed are never closed, and the browser is crashed instead, ending
 *     the cleanup. The BUDGET therefore counts bot pages only (walking 60 operator
 *     tabs costs nothing), and it still ends in a crash with one `console.error`
 *     line when it runs out.
 *
 * R-IDLE (why a touched operator tab is CLOSED rather than reused): once the bot
 * has driven a page the page is the bot's, and the cleanup blanks it and then
 * closes it. Blanking alone is not enough — a blank keeps the tab's history
 * entries, so a Back press in the VNC viewer walks straight back into the bot's
 * page — so the close is what removes the history. Chromium's own "reopen closed
 * tab" can restore it again; that is outside what this code can prevent, and it is
 * the operator's own action on their own browser. The same rule is why the
 * survivor is a page with no history rather than a reused page 0.
 *
 * LANE A's CDP TAB (a lane's own tooling attaches raw to a tab it created itself,
 * `cdp.mjs`, and the MCP never drives it) is the OPERATOR class: it existed before
 * the ownership attached, or it appeared later with no opener (which is
 * `uncertain`). Either way it is left alone — its network is not blocked, it is not
 * navigated and it is not closed — unless the bot actually touches it, which makes
 * it the bot's like any other tab.
 *
 * THE CLOSE PHASE. The page loop stops as soon as a re-read of `context.pages()` finds
 * nothing left to handle — but what is left after that is not nothing: each blanked page's
 * close waits out its own grace (`UNLOAD_GRACE_MS`), so those pages are still OPEN, and the
 * documents they just had can still be running their unload work. A page that appears in
 * that window (a popup, a new tab) is a live page with a document of its own and no deny-all
 * session, and "only closes are left" is a fact about the pages that were READ, not about
 * the ones that arrive afterwards. So the cleanup does not stop when the loop does: it waits
 * the scheduled closes out, then RE-READS every context (after `ownership.settle()` in the
 * ownership mode, exactly as the first pass does) and blanks any page still unhandled — bot
 * pages only with an ownership, every page but the survivor in the legacy mode — and keeps
 * doing that until a pass finds no new page to blank AND no close is pending. Each page
 * taken that way is blanked and closed like any other, with its own grace counted from its
 * own commit, so the graces overlap instead of adding up.
 *
 * The LEGACY mode (no `ownership`), unchanged:
 *
 *  0. Open the browser-level CDP session FIRST (`browser.newBrowserCDPSession()`)
 *     and keep it for the crash below. The budget can run out while a page is
 *     still being blanked, and by then there is no time left to open a session:
 *     the crash that ends a cleanup with armed pages needs one that already
 *     exists.
 *  1. Create a FRESH survivor page (`context.newPage()`) before anything else is
 *     touched. The page left behind has to be a page with no history: page 0
 *     keeps the bot's history and back-forward cache, and a Back press in the
 *     VNC viewer could restore the bot's page on a page that survived the
 *     cleanup. Making it first is also what keeps the headful last-page rule —
 *     in headful Chromium closing the LAST page exits the browser — because the
 *     survivor already exists before any old page is closed.
 *  2. For every page the context holds that is neither the survivor nor already
 *     handled, one at a time: attach a deny-all raw CDP Fetch session to the
 *     page AND to each of its out-of-process (cross-site) iframes — a page-level
 *     session does not cover an OOPIF frame, which lives in its own target with
 *     its own session, so the frame's pagehide/unload beacons would otherwise
 *     escape the blank and the close — plus, because this page is never reused,
 *     the round-trip-free `Network.enable` + `Network.setBlockedURLs { urls: ["*"] }`
 *     block on the page's own session too (`attachDenyAllSession(page, { permanent: true })`).
 *     Then send it to about:blank, and close it
 *     ONLY once that navigation resolved AND `page.url()` is exactly
 *     "about:blank" — and, from that commit, `UNLOAD_GRACE_MS` later (see THE GRACE
 *     below). Nothing is detached here: the browser is going away. The
 *     page list is
 *     `context.pages()` RE-READ after each page, because a page the old document
 *     opens while it is being blanked is a live, unguarded page too and the
 *     initial snapshot would never see it; a page already handled is skipped, so
 *     the loop ends when nothing unprocessed is left. A page whose `isClosed()`
 *     answers true is skipped outright — no navigation, no close, no crash: it
 *     is already gone, so there is nothing left to protect and nothing to fail
 *     closed about either.
 *
 * Why the raw session and not just the route guard: the route guard alone does
 * not stop the requests a page fires while it unloads — pagehide/unload
 * sendBeacon, `keepalive` fetch and Image requests still reach a private server
 * through a navigation away and through a close (verified live on Chromium 143,
 * see tests/browser-close-leak-live.test.js). Failing every request at the
 * page's own CDP session, attached before the navigation, is what stops them.
 *
 * FAIL CLOSED. A page whose blank rejects, a page whose goto resolves without the
 * about:blank commit ever showing, and a page whose deny-all session cannot be
 * attached (it has a context, so it could have one) are NEVER closed — closing
 * them fires their pagehide/unload beacons exactly like the navigation would, and
 * with the blank failed (or never attempted, because an unattachable page must
 * not be navigated either) there is nothing in front of them. The only safe end
 * for that page is the death of the browser it lives in, so the cleanup kills the
 * browser with `Browser.crash`, stops processing further pages, and never touches
 * the survivor either. A page that is already gone when the cleanup reaches it
 * rejects its `goto` and takes that same path: nothing is lost, the browser is
 * going away anyway. If the survivor itself cannot be created, nothing is
 * navigated or closed and the browser is killed the same way: without a fresh
 * survivor in front of them, every close in this cleanup is the browser's last
 * page.
 *
 * THE GRACE BEFORE A CLOSE. A page whose about:blank commit was observed is not
 * closed on the spot: its close is issued `UNLOAD_GRACE_MS` (750 ms) after THAT
 * page's commit, and the cleanup awaits every scheduled close before it finishes
 * (before the process is let go, and after the last page the loop finds). The wait
 * is what keeps the deny-all session alive while the OLD document can still send:
 * navigating to about:blank can swap the renderer, and the old document's
 * pagehide/unload handlers then run asynchronously in the old renderer AFTER the
 * navigation resolved, up to Chromium's unload timeout of about 500 ms. The close
 * destroys the target and, with it, that session — so a close issued earlier lets a
 * handler that runs after it send with nothing in front of it. The grace belongs to
 * the COMMIT, never to the cleanup: the next page is blanked as soon as this one's
 * blank committed, and the graces of several pages overlap instead of adding up
 * (one grace per page, slept one after another, would spend half a second of the
 * exit budget on each page). A page that was blanked and whose close is still
 * inside its grace is still OPEN, so a re-read of the page list would offer it
 * again: `blankAndCloseOnePage` records the pages it handled and skips them. A page
 * with no deny-all session has nothing for a close to destroy, so it is closed at
 * once (only a page Playwright does not hand over in the product lacks a session).
 * A page whose blank did NOT commit is never closed and gets no grace: that is the
 * fail-closed path below, and it must not be delayed. The cleanup waits for every
 * scheduled close before it finishes, and re-reads the pages after each of those waits
 * (see THE CLOSE PHASE): a page that appeared meanwhile gets its own blank, its own grace
 * and its own close.
 *
 * THE LAST-PAGE CHECK. The survivor of step 4 (and, in the legacy mode, step 1) is made
 * for the pages that exist WHEN IT RUNS, and a close can be issued hundreds of milliseconds
 * later: an operator page that kept the browser alive then can be gone by then, and the close
 * the cleanup issues would be the context's LAST page — which, in headful Chromium, exits the
 * whole browser and fires every page's close-time beacons with nothing in front of them. So no
 * close is issued blind: immediately before each one (a scheduled close, and the immediate
 * close of a page that has no deny-all session) the pages are read AGAIN and one OTHER live
 * page has to exist — not this page, and not one whose close this cleanup already scheduled or
 * issued (a closed page is simply not in the list that fresh read returned). When there is
 * none, a fresh `context.newPage()` (about:blank) is
 * made first and added to the survivors: it is never blanked, never closed, never probed. A
 * survivor that cannot be made means the close is NOT issued and the browser is crashed
 * instead. The check is serialised, so two closes landing at the same moment make ONE survivor,
 * not two.
 *
 * The BUDGET. If the cleanup is still running when `budgetMs` expires, the pages
 * behind the one being worked on are left with their beacons armed, so the browser
 * is crashed too — over the session opened in step 0, and one `console.error` line
 * says the cleanup ran out of budget. In the ownership mode that crash is reserved
 * for a cleanup that had already found (or reached) a page of the bot's, or for an
 * ownership that reports one (`ownership.botPageCount()`) or a bot mark whose target
 * id it never got (`ownership.unresolvedMarks()` — such a mark can be ANY tab). A
 * page whose owner was never decided counts as the bot's only while one of those is
 * set (`ownership.pending()` is read together with them, never on its own): pending
 * work with no bot page marked and nothing unresolved is an OPERATOR arrival's, and
 * crashing the browser for it would destroy the operator's tabs to fail closed about
 * nothing of the bot's. An ownership that cannot report those counts at all gets the
 * old, fail-closed answer: not being able to tell is not "nothing of the bot's".
 *
 * ONE exception, and it is not a page left behind. A budget that expires when every page the
 * cleanup found is already handled — blanked (its close scheduled), closed, or the survivor
 * the cleanup made — does NOT crash: nothing is armed behind those pages, and the crash
 * exists for the pages that were never blanked. That is decided by READING THE PAGES AGAIN at
 * the moment the budget expires, never by an answer stored earlier: the list that was read is
 * not the list that exists, and a page that arrived after it was read is exactly as armed as
 * one that was there from the start. So each context's pages are re-read there (with the
 * ownership classification; only bot pages are examined, and operator and uncertain pages are
 * never even probed), and the exemption holds only when every one of them is handled. An
 * unhandled bot page (legacy: any page but the survivor), a classification still in flight, or
 * a page list that cannot be read means the crash, exactly as before. A page that merely SITS
 * at about:blank is not a handled page: it can arrive there (or navigate itself back to it)
 * with a live document of its own that this cleanup never blanked and never put a deny-all
 * session in front of. The exemption also needs
 * the cleanup's own page walk to have finished at least once: a settle that never answered
 * never read a page list, so nothing there can say the pages are handled. When the exemption
 * does hold, the cleanup waits the closes out, bounded by `UNLOAD_GRACE_MS` plus the crash
 * grace so a close that never answers cannot hold the process open.
 *
 * That bound ends the WAIT, not the danger. The wait says whether the cleanup actually settled;
 * a wait that ran out with the cleanup still running is decided a SECOND time, by reading the
 * pages again: a page that read does not prove handled, and a close this cleanup issued that
 * never got an answer for (a page still open behind the wait), end the cleanup exactly as an
 * expired budget does — one `console.error` line, and the crash. Only a cleanup that settled
 * inside the bound, or whose second read finds every page handled with no close outstanding, is
 * left to finish.
 *
 * That first look is taken SYNCHRONOUSLY, before this cleanup's own first await
 * (opening the browser session): opening it is the first await, and a budget of a few
 * dozen milliseconds can expire while it is still pending — a case that used to be
 * decided by a flag only ever set after that await, which meant a hung CDP call
 * swallowed the budget entirely (no line, no crash, pages armed). A bot page known
 * before the await is armed pages behind the stuck opening, so the crash happens.
 *
 * Opening the browser session is the cleanup's own first await, so the budget can
 * expire while it is still PENDING: the crash then
 * waits for it up to `CRASH_GRACE_MS` and sends it once it arrives, instead of
 * giving up with no session at all. `crashed` is set only once a `Browser.crash`
 * was actually sent (or the give-up line was logged), and the budget path and the
 * failure path share one kill, so at most one crash goes out per cleanup. The
 * crash is never awaited: a real `Browser.crash` does not answer, the socket dies
 * with the browser. It gets a short grace (`CRASH_GRACE_MS`) and then the process
 * is let go.
 *
 * TWO SERVERS, ONE PROCESS. The registration is per proc but holds one pair per
 * server (see `exitRegistrations`), and the one cleanup walks the pairs in
 * registration order under this single budget and this one crash machinery: the
 * browser session and the crash that ends the cleanup belong to the pair being
 * worked on, and once a crash has gone out nothing further is touched anywhere.
 *
 * NEVER `Browser.close`. Closing the browser closes its live pages, and every one
 * of those closes fires the pagehide/unload beacons this cleanup exists to stop —
 * the close-time leak comes straight back. So when there is no session to crash
 * the browser over, or the crash reports a failure, there is no second attempt:
 * the pages are left alone (they were at least blank-attempted) and ONE line goes
 * to `console.error` naming the failure. The browser may survive that; an unclosed
 * page is still the safer end.
 *
 * A crash that runs no handler at all (SIGKILL, a segfault, the OOM killer) cannot
 * be cleaned up here; the real fix for that is network-layer enforcement (an
 * egress filter), which Crow does not provide.
 *
 * TWO CALLERS, ONE MACHINERY. The exit path is one caller. The other is
 * `closeGuardedPages`, which the launcher awaits before it REPLACES the browser (a proxy
 * change, a restart): pages close on a `browser.close()` exactly as they would on the exit,
 * so they need the same order — deny-all session, about:blank, close after the grace —
 * behind a call that can run again later in the same process. It runs the same machinery
 * over fresh state for that call (nothing memoised, nothing registered on the process, not
 * in the shared exit tasks) and answers `{ ok }`: false when that run ended in the crash
 * path, so the caller knows the pages were not cleaned and the connection is gone.
 *
 * The cleanup is also registered with the shared exit tasks (exit-tasks.js),
 * so the lease guard's SIGTERM/SIGINT exit — which would otherwise cut it off
 * half way — awaits it before it calls `exit`.
 *
 * @param {() => object|null} getContext - returns the guarded BrowserContext
 * @param {{proc?: object, budgetMs?: number, ownership?: object}} [opts] `ownership`
 *   is the MCP process's page ownership (`page-ownership.js`): when it is passed,
 *   only the bot's pages are cleaned up and the operator's are left untouched.
 *   Calling this again for the same `proc` with a new getter (a reconnect) and the
 *   same ownership updates that server's entry; a DIFFERENT ownership (a second
 *   server in this process) adds one, and the single cleanup walks them all. Without an
 *   ownership (the legacy mode) the GETTER FUNCTION is the pair's identity: the same
 *   getter re-registers on its pair, a different getter is another pair.
 * @returns {() => Promise<void>} the cleanup, so a caller can await it
 */
export function blankPagesOnExit(getContext, opts = {}) {
  const proc = opts.proc || process;
  // Only the real process goes into the shared exit tasks (exit-tasks.js): an
  // injected fake proc belongs to a test, and its cleanup must not land on the
  // process-wide instance.
  const shared = !opts.proc || opts.proc === process;

  // One registration per proc, holding ONE PAIR PER SERVER (a context plus the page
  // ownership it belongs to). Two MCP server instances can live in one process, and
  // the second one must not replace the first one's ownership: the first server's
  // bot page would then never be cleaned up at all. A later call is matched to an
  // existing pair by its OWNERSHIP (identity) when it brings one — never by its getter,
  // because two servers may share one context factory — and by its getter only when it
  // brings none (the legacy mode); either way only that pair's getter is swapped, so
  // re-connecting the same server does not add pairs and the pages are never cleaned up
  // twice. Listeners and the shared exit task stay per proc: one cleanup, one budget,
  // one crash machinery.
  const already = exitRegistrations.get(proc);
  if (already) {
    already.addOrUpdate(getContext, opts.ownership);
    return already.run;
  }

  const cleanup = createExitCleanup({ budgetMs: cleanupBudgetMs(opts) });
  cleanup.own(getContext, opts.ownership);

  // A signal listener replaces node's default exit, so hand the signal back once
  // the pages are blanked: the MCP server must still stop when it is told to.
  const onSignal = (signal) => {
    cleanup.run().then(() => {
      try {
        if (typeof proc.kill === "function" && proc.pid) proc.kill(proc.pid, signal);
        else if (typeof proc.exit === "function") proc.exit(0);
      } catch { /* already gone */ }
    });
  };

  const register = (target, event, handler) => {
    try {
      if (target && typeof target.once === "function") target.once(event, handler);
    } catch { /* a proc without that event */ }
  };
  register(proc, "SIGTERM", () => onSignal("SIGTERM"));
  register(proc, "SIGINT", () => onSignal("SIGINT"));
  register(proc, "beforeExit", () => { cleanup.run(); });
  // The MCP transport is stdin/stdout: when stdin closes the server is going away.
  register(proc.stdin, "close", () => { cleanup.run(); });
  register(proc.stdin, "end", () => { cleanup.run(); });

  // And the shared exit promise (exit-tasks.js): the lease guard replaces node's
  // default exit for SIGTERM/SIGINT, so it awaits `runExitTasks()` before it
  // calls exit — without this registration that exit would cut this cleanup off
  // half way, leaving an open page with its route guard gone. Registered once,
  // like the listeners above: a later call for the same proc only swaps the
  // getter. (A task registered after the first run is ignored for that run;
  // this one is registered when the browser connects, long before any exit.)
  if (shared) addExitTask(cleanup.run);

  // Registered once per proc: a later call for the same proc only swaps the pair it
  // belongs to (an ownership pair by its ownership, a legacy pair by its getter), so a
  // re-connect keeps reading the newest context while a SECOND server's ownership keeps
  // its own pair, and the caller gets the same one cleanup back.
  exitRegistrations.set(proc, { run: cleanup.run, addOrUpdate: cleanup.own });

  return cleanup.run;
}

/**
 * The budget a cleanup is given: `opts.budgetMs` when it is a positive number, else
 * `EXIT_CLEANUP_BUDGET_MS`.
 *
 * @param {{budgetMs?: number}} opts
 * @returns {number}
 */
function cleanupBudgetMs(opts) {
  const asked = opts && typeof opts === "object" ? opts.budgetMs : undefined;
  return Number.isFinite(asked) && asked > 0 ? asked : EXIT_CLEANUP_BUDGET_MS;
}

/**
 * Close the pages this MCP opened or drove BEFORE something else replaces the browser.
 *
 * `crow_browser_launch` replaces the browser on a proxy change and on a restart, and a
 * bare `browser.close()` closes the live pages — every one of those closes fires exactly
 * the pagehide/unload beacons this module exists to stop. So the pages go through the SAME
 * machinery the exit path runs (deny-all session first, then about:blank, then the close
 * after that page's grace; bot pages only, an operator page left exactly as it is), with
 * one difference that matters to a caller that keeps running: the state is FRESH for every
 * call — nothing is memoised, nothing is registered on this process, and nothing goes into
 * the shared exit tasks — so the call can be made again after the next connect.
 *
 * It resolves `{ ok }`, and `ok` is false exactly when that run could not finish safely:
 * it ended in the crash path (`Browser.crash` was sent, so the browser and this
 * connection are gone), it logged an exhausted budget with pages still armed, or it could
 * not make a survivor to keep the browser alive behind a close. `ok: true` covers the
 * ordinary case, and the ones with nothing to do (no context yet, no page of the bot's).
 *
 * The verdict is read only once the work behind `run()` has SETTLED (bounded by
 * `EXIT_CLEANUP_WORST_CASE_MS`): `run()` can resolve through the budget's exemption while
 * the cleanup is still inside its close-phase loop, and a crash that lands after that
 * point is not in `failed()` yet — answering `ok: true` there would say the pages were
 * cleaned while the browser was crashed. A bound that passes with the work STILL RUNNING is
 * not a finished cleanup either, whatever `failed()` says at that moment: that work can
 * still blank a page, or crash the browser, after the answer went out. So the wait reports
 * which of the two happened, and `{ ok: false }` is the answer for a run that did not settle
 * inside its bound. The browser-level CDP session this cleanup opens (for the crash it may
 * need) is detached once, at the end of EVERY call, and a detach that fails is swallowed —
 * as is a detach that never answers, which is given up on after `CRASH_GRACE_MS`: a caller
 * that keeps running must neither leak a session per restart nor be wedged by one.
 *
 * CALLS ARE SERIALISED, in this process, on a module-level chain: a second call starts
 * after the first one has finished, never in the middle of it. Two runs walking the same
 * context at once would blank a page the other had just attached a deny-all session to,
 * and each would make its own survivor.
 *
 * ACCEPTED LIMITS, recorded on purpose. (1) A `closeGuardedPages` run is serialised with
 * other `closeGuardedPages` runs but NOT with the process-exit cleanup (`blankPagesOnExit`):
 * two runs — a safe close and the process-exit cleanup — can each pass their last-page check
 * on their OWN survivor and then close the other's. The last-page check narrows that window
 * but does not close it, and the browser can then exit on the last close. Every page closed
 * that way has already been blanked behind its deny-all session, so the beacons its close
 * fires are failed at the page's own session rather than reaching the private server.
 * (2) A tool call running in the same process while a restart's safe close is in progress can
 * open a page AFTER the cleanup's last re-read of `context.pages()`. That page was never
 * blanked and never given a deny-all session, so at the container restart its pagehide/unload
 * beacons fire unguarded. A mutex across the launch tool and the other tool handlers would be
 * needed to close this, and the launch tool's description (a restart that must not overlap
 * other browser calls) is advisory only: MCP clients can call tools in parallel, so a
 * description cannot serialise them. That mutex is follow-up work.
 *
 * @param {() => object|null} getContext - returns the guarded BrowserContext
 * @param {{ownership?: object, budgetMs?: number}} [opts] `ownership` is the MCP
 *   process's page ownership (`page-ownership.js`); without it every page in the context
 *   is cleaned up (the legacy mode)
 * @returns {Promise<{ok: boolean}>}
 */
export function closeGuardedPages(getContext, opts = {}) {
  const result = closeGuardedPagesChain.then(() => runCloseGuardedPages(getContext, opts));
  // The chain never carries a rejection: one failing call must not block the next.
  closeGuardedPagesChain = result.then(() => undefined, () => undefined);
  return result;
}

/** The serialisation chain of `closeGuardedPages` calls in this process. */
let closeGuardedPagesChain = Promise.resolve();

/**
 * One `closeGuardedPages` call: fresh cleanup, its work waited for (bounded — a run whose
 * work outlives the bound did not finish, and answers `{ ok: false }`), the verdict read last,
 * and the browser-level session it opened detached on every way out.
 *
 * @param {() => object|null} getContext
 * @param {{ownership?: object, budgetMs?: number}} opts
 * @returns {Promise<{ok: boolean}>}
 */
async function runCloseGuardedPages(getContext, opts) {
  const cleanup = createExitCleanup({ budgetMs: cleanupBudgetMs(opts) });
  cleanup.own(getContext, opts.ownership);
  try {
    await cleanup.run();
    // The bound is a fact to act on, never a formality: work still running when it passed can
    // still blank a page or crash the browser, so only a run that SETTLED inside the bound may
    // be answered from `failed()`.
    const settledInTime = await cleanup.settled();
    return { ok: settledInTime === true && cleanup.failed() !== true };
  } finally {
    await cleanup.releaseBrowserSession();
  }
}

/**
 * The cleanup machinery one proc (or one `closeGuardedPages` call) gets.
 *
 * Everything a cleanup needs — the registered pairs, the handled/blanked/survivor records,
 * the pending closes, the budget clock and the one crash — lives HERE, per call, and never
 * in the module: two cleanups must not share a `crashed` flag, a budget or a survivor. The
 * doc comment above `blankPagesOnExit` describes what the machinery does; this function only
 * builds it and hands back the seams its callers need.
 *
 * @param {{budgetMs: number}} opts
 * @returns {{run: () => Promise<unknown>, own: (getContext: Function, ownership?: object) => void, failed: () => boolean, settled: () => Promise<boolean>, releaseBrowserSession: () => Promise<void>}}
 *   `run` is the once-only cleanup (raced against the budget), `own` registers (or re-points)
 *   one server's context getter plus ownership, `failed` says whether this run took the crash
 *   path, `settled` answers whether the work behind `run` settled inside its bound (`false`
 *   when the bound passed first), and `releaseBrowserSession` detaches the browser-level
 *   sessions this cleanup opened, each one bounded
 */
function createExitCleanup({ budgetMs }) {
  /**
   * One server's cleanup target: {
   *   getter: () => the guarded BrowserContext,
   *   ownership: the page ownership this context is cleaned up for, or null for the
   *              legacy "blank and close every page" mode.
   * }
   */
  const pairs = [];
  const addOrUpdate = (nextGetter, nextOwnership) => {
    const getter = typeof nextGetter === "function" ? nextGetter : () => null;
    const ownership = nextOwnership || null;
    // A pair is the SAME pair only when it belongs to the same SERVER.
    //
    // With an ownership, that server IS its ownership, matched by identity: two servers
    // can hand over the same context getter (a factory returning one shared context), and
    // matching on the getter merged them — the second call then replaced the first
    // server's ownership, and that first server's bot page was never cleaned up at all.
    // A getter match must never overwrite another server's ownership.
    //
    // A legacy registration (no ownership, the "blank and close every page" mode) has
    // nothing else to be identified by, so THERE the getter function is the identity, and
    // a legacy re-registration swaps its getter exactly as before. Two legacy
    // registrations with different getters are two pairs: no ownership compares equal to
    // no ownership, which is how they used to be merged into one.
    const match = ownership
      ? pairs.find((pair) => pair.ownership === ownership)
      : pairs.find((pair) => !pair.ownership && pair.getter === getter);
    if (match) {
      match.getter = getter;
      return;
    }
    pairs.push({ getter, ownership });
  };
  /**
   * True once a page of the BOT's is known (or is being blanked) IN ANY registered
   * pair, or an ownership reports one of its own (`botPageCount()`,
   * `unresolvedMarks()`): from then on a budget that expires is a fail-closed case,
   * exactly as in the legacy mode. While it is false and no registered ownership holds
   * anything of the bot's, nothing of ours has been touched or armed, so the budget path
   * crashes nothing — destroying the operator's tabs to fail closed about pages that
   * were never the bot's would be the worse harm. Pending classification work on its own
   * is not bot work (A6): see `ownsBotWork`.
   */
  let botWorkPending = false;
  let pending = null;
  /**
   * When the cleanup started, so the page-ownership settle it calls can be given what is LEFT
   * of `budgetMs` (minus the reserve kept back for the blanking and closing behind it) instead
   * of a fresh walk deadline of its own: a settle with no budget can
   * outlive the cleanup that started it, and the pages behind it would then be read while it
   * still runs. 0 until the cleanup begins (the first `settle()` is inside it).
   */
  let startedAt = 0;
  /** What is left of the cleanup's own budget, as a number a settle can be bounded by. */
  const remainingBudgetMs = () => {
    if (!startedAt) return budgetMs;
    const left = budgetMs - (Date.now() - startedAt);
    return left > 0 ? left : 1;
  };
  /**
   * The budget one settle is given: what is left MINUS the reserve kept back for the blanking
   * and closing behind it, floored at 1 ms so it is never 0 or negative.
   */
  const settleBudgetMs = () => Math.max(1, remainingBudgetMs() - SETTLE_RESERVE_MS);
  /**
   * Whether a page's CLASS can still change: an arrival being classified or a relatives walk is
   * still in flight.
   *
   * This is `ownership.classifying()`, NOT `ownership.pending()`: pending also counts the
   * target-id and relation-only lookups a bot mark starts, and those record an id without
   * deciding anything. Reading them here failed a cleanup whose page list was already final —
   * an incomplete relatives walk fail-closes on every page it never proved, each of those marks
   * starts a lookup, and the browser was crashed over a list that could not change. An
   * ownership that cannot answer the narrow question is read through `pending()`: the wider,
   * fail-closed answer, which is what every caller had before `classifying()` existed.
   */
  const classificationsInFlight = (ownership) => {
    try {
      if (typeof ownership.classifying === "function") return ownership.classifying() === true;
      return typeof ownership.pending === "function" ? ownership.pending() === true : false;
    } catch {
      // A probe that THROWS has not said "nothing is in flight": not being able to tell is
      // not the same answer, and reading it as "nothing" would let a page whose owner is
      // still being decided be taken for a final list. Fail closed: still in flight.
      return true;
    }
  };
  /**
   * A settle that came back with a classification STILL in flight did not finish the page list
   * it was asked for: the page whose owner is being decided right now may be the bot's. The
   * settle is handed what is left of the cleanup's budget MINUS the reserve, so there is no
   * time left to wait for it — and the cleanup must not go on blanking on a list that is not
   * final. Fail closed exactly as an expired budget does: the browser is crashed when anything
   * of the bot's is armed (its pages would otherwise be left open and unguarded), and nothing
   * at all is touched when nothing of ours was armed (A6).
   *
   * Returns true when it ended the cleanup.
   */
  const endOnUnfinishedSettle = async (ownership) => {
    if (!classificationsInFlight(ownership)) return false;
    // ONE more settle before concluding: work can have STARTED just after the settle above
    // returned (a popup the bot's own page opened while it was being handled), and that work
    // is not a spent budget. What is still in flight after the retry is.
    try {
      await ownership.settle({ budgetMs: settleBudgetMs() });
    } catch { /* never rejects */ }
    if (!classificationsInFlight(ownership)) return false;
    if (!botWorkIsArmed()) {
      // NOTHING OF THE BOT'S IS ARMED, so nothing is crashed and no page is touched — but the
      // cleanup is stopping with a page still UNCLASSIFIED, and a silent stop reads as a
      // finished cleanup. Say so in one line, like the armed path below.
      logUnclassifiedAndUnarmed();
      return true;
    }
    logSettleBudgetExhausted();
    await killBrowser();
    return true;
  };
  /** The browser-level session opened at the start, for the crash the cleanup may need. */
  let browserSession = null;
  /**
   * Every browser-level session this cleanup opened, so a caller that KEEPS running can
   * release them (see `closeGuardedPages`). The exit path never does: the browser is going
   * away, and a detach there would release anything the session is still failing.
   */
  const openedBrowserSessions = new Set();
  /**
   * The session OPENING, kept as a promise and not only awaited: the budget can
   * expire while `newBrowserCDPSession()` is still pending, and the crash that then
   * ends the cleanup has to be able to wait for it (see `killBrowser`).
   */
  let browserSessionOpening = null;
  /** True once a crash was actually SENT, or the give-up line was logged. */
  let crashed = false;
  /**
   * The pages a close was already issued for, or scheduled for: ONE cleanup-level
   * record, so no re-read of `context.pages()` can hand the same page to
   * `blankAndCloseOnePage` twice. A page whose close is still inside its grace is
   * an OPEN page whose url() is already about:blank — visible in the page list of
   * the loop that is looking for the next page — so the record is what keeps a
   * second pass from blanking it again (and scheduling a second close). A page that
   * was already gone when the cleanup reached it is recorded here too: nothing is
   * left to do to it, and a later re-read must not offer it again either. The loops
   * keep their own `handled` sets for the pages they picked; this is the guard that
   * does not depend on a caller's bookkeeping.
   */
  const handledPages = new WeakSet();
  /**
   * The pages whose about:blank commit was OBSERVED (and, with it, the pages whose close is
   * scheduled or already issued). `handledPages` is NOT this record: a page that was TAKEN UP
   * is in it as soon as the cleanup starts on it — attached, navigated — even when its blank
   * never committed, and such a page is exactly what the crash exists for. Only a page here is
   * one the budget may read as already handled, and `page.url()` is never that record: a page
   * can sit at about:blank with a live document nothing here ever blanked. A page here whose
   * close is still outstanding is still OPEN, which is what the budget's exemption reads after
   * its bounded wait (see the doc comment above `blankPagesOnExit`).
   */
  const blankedPages = new WeakSet();
  /**
   * The pages this cleanup created ITSELF (a fresh survivor, one per context that had
   * nothing but the bot's pages): never blanked, never closed, never probed, whatever a
   * later re-read says about them.
   */
  const survivorPages = new WeakSet();
  /**
   * The closes that are waiting out their page's grace, one promise per page. The
   * cleanup awaits every one of them before it finishes: the survivor/last-page
   * rule and the process exit both rest on those closes having been issued.
   */
  const pendingCloses = new Set();
  /**
   * Issue one page's close and swallow whatever it does. Never rejects: a close
   * that fails may not take another page's close down with it.
   */
  const closeQuietly = async (page) => {
    try {
      const closed = page.close();
      if (closed && typeof closed.then === "function") await closed.catch(() => {});
    } catch { /* the page, or the browser it lived in, may already be gone */ }
  };
  /**
   * THE LAST-PAGE CHECK: no close is issued blind (see the doc comment above
   * `blankPagesOnExit`).
   *
   * Closing the LAST page of a headful context exits the whole browser, and every other
   * page's close-time beacons then fire with nothing in front of them. The survivor made at
   * the start of a cleanup answers that for the pages that existed THEN; a close is issued
   * later (a scheduled one waits out its page's unload grace), and an operator page that kept
   * the browser alive at the start can be gone by then. So right before a close the pages are
   * read AGAIN and one OTHER page has to be one that will still be there afterwards:
   *
   *   - the cleanup's own survivors (`survivorPages`): never blanked, never closed, so always
   *     there;
   *   - a page this cleanup will NOT close — the operator's or an uncertain one, in the
   *     ownership mode — that the fresh list holds. Membership IS the liveness signal: a
   *     closed page is removed from `context.pages()`, and this list was read a moment ago,
   *     so a candidate found in it is a page that is still there. Nothing is asked of such a
   *     page — no method is called on it, ever;
   *   - and nothing else: a page of the bot's that this cleanup has not reached yet is one it
   *     is going to close, so it cannot keep the browser alive behind this close, and neither
   *     can a page whose close is already scheduled or issued (`blankedPages`). In the legacy
   *     mode every page but a survivor is closed, so only the survivors count.
   *
   * With no such page, a fresh `context.newPage()` (about:blank) is made first and added to
   * the survivors: this cleanup never blanks, closes or probes it. A survivor that cannot be
   * made means the close is NOT issued and the browser is crashed instead — the same
   * fail-closed end as a survivor that cannot be made at the start.
   *
   * The check is SERIALISED (one chain, `lastPageCheck`): two closes landing at the same
   * moment must make ONE survivor, not one each.
   *
   * @returns {Promise<boolean>} true when the close may be issued, false when the browser
   *   was crashed instead (the caller must stop)
   */
  let lastPageCheck = Promise.resolve();
  const keepAPageBehindTheClose = (page, context, ownership) => {
    const checked = lastPageCheck.then(async () => {
      let live = [];
      try {
        live = Array.from((context && typeof context.pages === "function" && context.pages()) || []);
      } catch {
        live = [];
      }
      const keepsTheBrowser = (candidate) => {
        if (!candidate || candidate === page) return false;
        // The cleanup's own fresh page: never closed, so it is there afterwards whatever
        // the page list says.
        if (survivorPages.has(candidate)) return true;
        // Its close is already scheduled or issued: it is on its way out.
        if (blankedPages.has(candidate)) return false;
        // A page of the bot's that this cleanup has not reached yet is one it is going to
        // close (`classifyOrBot`: a classification that throws counts as the bot's too), so
        // it cannot keep the browser alive behind this close. The legacy mode closes every
        // page but the survivors, so nothing else counts there either.
        if (!ownership || classifyOrBot(ownership, candidate) === "bot") return false;
        // An operator or uncertain page: it is left exactly as it is — never navigated,
        // closed, blocked, written to or probed (no method is called on it). It keeps the
        // browser alive, and the fresh page list this runs on is the answer: the list was
        // read a moment ago, and a real Playwright context drops a closed page from it, so
        // a candidate found there is a page that is still there.
        return true;
      };
      if (live.some(keepsTheBrowser)) return true;
      if (!context || typeof context.newPage !== "function") {
        // Neither readable nor able to make a page: nothing here can say this close is not
        // the last one, so it is not issued.
        await killBrowser();
        return false;
      }
      let fresh = null;
      try {
        fresh = await context.newPage();
      } catch {
        fresh = null;
      }
      if (!fresh) {
        await killBrowser();
        return false;
      }
      survivorPages.add(fresh);
      return true;
    });
    // The chain never carries a rejection: one page's failed check must not skip the next.
    lastPageCheck = checked.then(() => undefined, () => undefined);
    return checked;
  };
  /**
   * Issue ONE page's close, but only once something else is left to keep the browser alive
   * (see `keepAPageBehindTheClose`).
   *
   * @returns {Promise<boolean>} true when the close was issued, false when it was not (the
   *   browser was crashed instead)
   */
  const closeWithSurvivor = async (page, context, ownership) => {
    if (!(await keepAPageBehindTheClose(page, context, ownership))) return false;
    await closeQuietly(page);
    return true;
  };
  /**
   * Schedule ONE page's close for `at` (its commit plus its grace) and track it as a
   * pending close, so the cleanup carries on blanking the next page while this one
   * waits. The graces therefore overlap instead of adding up.
   *
   * The close itself goes through `closeWithSurvivor`: the grace it waited out is exactly the
   * window in which a page that kept the browser alive can disappear.
   *
   * The timer is deliberately NOT unref'd: awaiting the close is exactly what the
   * cleanup does next, and an unref'd timer would let the process go with the close
   * never issued. The promise settles either way (see `closeQuietly`), so one page's
   * failure can never skip another page's close.
   */
  const scheduleClose = (page, at, context, ownership) => {
    const closing = new Promise((resolve) => {
      const settle = () => {
        pendingCloses.delete(closing);
        resolve();
      };
      setTimeout(() => { closeWithSurvivor(page, context, ownership).then(settle, settle); }, Math.max(0, at - monotonicNow()));
    });
    pendingCloses.add(closing);
  };
  /**
   * Wait for every close this cleanup scheduled, so it finishes only once the pages
   * are closed. The set is re-read after each wait: the loop it follows can schedule
   * a close up to the moment it stops finding pages.
   */
  const closeScheduledPages = async () => {
    while (pendingCloses.size) {
      await Promise.all(Array.from(pendingCloses));
    }
  };
  /** One kill per cleanup: the budget path and a failure path share this promise. */
  let killing = null;
  /**
   * True once this cleanup took a FAIL-CLOSED end: the browser was crashed, a give-up line was
   * logged instead of a crash, or pages were left armed by an exhausted budget. `run` still
   * resolves (the exit path has nothing to report to), and `closeGuardedPages` is the caller
   * that reads this: its answer is `{ ok: false }` exactly when this is true.
   */
  let cleanupFailed = false;

  /** One `console.error` line naming why the browser could not be crashed. */
  const logCrashFailure = (failure) => {
    try {
      console.error(
        `[browser] the exit cleanup could not crash the browser (${failure}): its pages are left open ` +
          "rather than closed, because closing them fires the pagehide/unload beacons this cleanup stops",
      );
    } catch { /* a console that is already gone */ }
  };

  /**
   * One `console.error` line when the budget ran out: the pages the cleanup had not
   * reached are still armed, so a silent browser crash would look like a fault.
   */
  const logBudgetExhausted = () => {
    try {
      console.error(
        `[browser] the exit cleanup ran out of its ${budgetMs} ms budget with pages still open: the pages it ` +
          "had not reached yet were not blanked, so the browser is crashed rather than closed",
      );
    } catch { /* a console that is already gone */ }
  };

  /**
   * One `console.error` line when a settle came back with a classification STILL in flight:
   * the page list it was asked for is not final, so the pages it does not prove are as
   * unproven as they are after an expired budget.
   */
  const logSettleBudgetExhausted = () => {
    try {
      console.error(
        `[browser] the exit cleanup's classification budget ran out with pages still unclassified: ` +
          "they could be the bot's, so the browser is crashed rather than left with them open",
      );
    } catch { /* a console that is already gone */ }
  };

  /**
   * One `console.error` line when a settle came back still CLASSIFYING and nothing of the bot's
   * is armed: nothing is crashed and no page is touched (there is nothing to fail closed about),
   * but a page is left UNCLASSIFIED and a silent stop would read as a finished cleanup.
   */
  const logUnclassifiedAndUnarmed = () => {
    try {
      console.error(
        "[browser] the exit cleanup stopped with a classification still unfinished and nothing of the bot's armed: " +
          "the page(s) it left unclassified are not navigated, blocked or closed, because nothing here could prove one of them is the bot's",
      );
    } catch { /* a console that is already gone */ }
  };

  /**
   * One `console.error` line naming the pages nobody could prove are the bot's (or
   * the operator's). They are left alone — neither blocked, navigated nor closed —
   * so a cleanup that skipped them says so instead of looking like it finished.
   */
  const logUncertainPages = (count) => {
    try {
      console.error(
        `[browser] the exit cleanup left ${count} page(s) of uncertain ownership alone: they appeared after ` +
          "this MCP attached to the browser and nothing here can prove who owns them (another CDP client's tab, " +
          "or a popup whose opener went away first), so they are not blocked, navigated or closed",
      );
    } catch { /* a console that is already gone */ }
  };

  /**
   * Does this ownership hold — or possibly hold — a page of the bot's?
   *
   * `botPageCount() > 0` is a page some path classed BOT; `unresolvedMarks() > 0` is a
   * bot mark whose target id was never had, so ANY tab could be that one (a reconnect
   * cannot even try to prove otherwise). Together they are what makes pending
   * classification work count as bot work: while neither is set, nothing of the bot's
   * is known to be armed, so a budget that expires on pending work alone — an operator
   * popup's `opener()` still in flight — must not crash the operator's browser.
   *
   * Those two counts are the ownership's REPORTING SEAMS, and they are the ownership's
   * own accounting (on its prototype, so a shallow copy of it does not carry them). An
   * ownership that cannot report them gets the pre-A6 answer instead, which is what
   * every caller had before the seams existed: pending work fails closed. Not being
   * able to tell is not the same as "nothing of the bot's", and a crash costs the
   * operator's tabs while an armed bot page costs the rule this whole file exists for.
   */
  const ownsBotWork = (ownership) => {
    if (typeof ownership.botPageCount === "function" && typeof ownership.unresolvedMarks === "function") {
      try {
        return ownership.botPageCount() > 0 || ownership.unresolvedMarks() > 0;
      } catch {
        return true; // a reporting failure proves nothing: fail closed
      }
    }
    // No reporting seams (a wrapper, a double, a copy of an ownership): pending work is
    // bot work, exactly as it was before A6.
    try {
      return typeof ownership.pending === "function" ? ownership.pending() === true : true;
    } catch {
      return true;
    }
  };

  /**
   * The fail-closed end: kill the browser, and every page in it, without closing a
   * page (a close would run the pagehide handlers nothing is in front of any
   * more).
   *
   * There is deliberately NO fallback to `Browser.close`: a browser close closes
   * the live pages, which fires exactly the close-time beacons this cleanup exists
   * to prevent. The crash is sent over the session opened at the start of the
   * cleanup, at most once, and never awaited — a crash does not answer. That
   * session may still be OPENING when the budget fires, so it is waited for (no
   * longer than `CRASH_GRACE_MS`) instead of being given up on with the browser
   * left alive; when it never arrives, or the send fails, one line names the
   * failure through `console.error`.
   */
  const crashBrowser = async () => {
    if (crashed) return;

    // The session may still be OPENING: opening it is this cleanup's first await,
    // and a budget of a few dozen milliseconds can expire while it is pending.
    // Giving up there would leave the browser alive with its pages armed for
    // nothing, so wait for the opening — but no longer than the crash grace.
    let session = browserSession;
    if (!session && browserSessionOpening) {
      session = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), CRASH_GRACE_MS);
        if (typeof timer.unref === "function") timer.unref();
        browserSessionOpening.then(
          (opened) => { clearTimeout(timer); resolve(opened || null); },
          () => { clearTimeout(timer); resolve(null); },
        );
      });
    }
    if (!session) {
      // A crash was never attempted, so the give-up line is the one record of it.
      crashed = true;
      logCrashFailure("no browser CDP session is open");
      return;
    }
    crashed = true;
    const sent = (() => {
      try {
        const answer = session.send("Browser.crash");
        return answer && typeof answer.then === "function" ? answer : Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    })();
    // A crash never answers: it is given a short grace, not awaited outright.
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), CRASH_GRACE_MS);
      if (typeof timer.unref === "function") timer.unref();
      sent.then(
        () => { clearTimeout(timer); resolve({ timedOut: false }); },
        (err) => { clearTimeout(timer); resolve({ timedOut: false, err }); },
      );
    });
    if (outcome.timedOut) return; // silence is what a crash does: the browser is going
    if (outcome.err) {
      logCrashFailure(outcome.err && outcome.err.message ? outcome.err.message : String(outcome.err));
    }
  };

  /** The one kill per cleanup: the budget path and a failure path share it. */
  const killBrowser = () => {
    cleanupFailed = true;
    killing ||= crashBrowser();
    return killing;
  };

  /**
   * `promise`, or `ms` passing — whichever is first, and WHICH of the two it was. The timer
   * never holds the process open (it is unref'd), so a close that never answers cannot keep
   * the exit waiting.
   *
   * @returns {Promise<boolean>} true when `promise` SETTLED within `ms`, false when `ms`
   *   passed first. "false" must never be read as "the work is finished": the work is still
   *   running at that moment, and whatever it was waiting on (a close that never answered) is
   *   still outstanding.
   */
  const withinMs = (promise, ms) => new Promise((resolve) => {
    let answered = false;
    let timer = null;
    const finish = (settled) => {
      if (answered) return;
      answered = true;
      if (timer !== null) clearTimeout(timer);
      resolve(settled);
    };
    timer = setTimeout(() => finish(false), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(() => finish(true), () => finish(true));
  });

  /**
   * Blank and close ONE page of the bot's, fail-closed.
   *
   * This is the per-page half of the cleanup, shared by both modes (the legacy one
   * calls it for every page, the ownership one only for the bot's pages):
   *
   * Every request at the page's own CDP session is denied FIRST, so the
   * pagehide/unload requests the blanking below fires are already blocked (the
   * context route guard cannot see them). A page that has an endpoint but cannot be
   * attached is not navigated at all: fail closed. `permanent: true` because this
   * page is never reused (nothing is detached here — the browser is going away), so
   * its own session gets the network-stack block as well as the Fetch deny-all.
   *
   * Then the page is blanked and closed ONLY once the blank really committed. A page
   * whose blank rejects, or whose goto resolves without the about:blank commit ever
   * showing, is never closed: closing it fires its pagehide/unload beacons with
   * nothing in front of them, so the browser is crashed instead and the cleanup
   * stops (the survivor is not touched either). A page that is already closed is
   * skipped outright: there is nothing left to protect and nothing to fail closed
   * about.
   *
   * The close of a blanked page is NOT issued on the commit: it is scheduled for the
   * commit plus `UNLOAD_GRACE_MS`, and this function returns at once so the page
   * behind it can be blanked while the first one waits (the graces overlap). The
   * wait exists because the old document's pagehide/unload work runs in the old
   * renderer after the commit, and the close is what destroys the deny-all session
   * those handlers' requests are failed by (see `UNLOAD_GRACE_MS`). The scheduled
   * close is one of `pendingCloses`, and the cleanup awaits them all. A page with no
   * deny-all session has nothing for the close to destroy, so it is closed at once.
   *
   * @param {object} page
   * @param {object} context the BrowserContext `page` belongs to (the last-page check reads it)
   * @param {object|null} ownership the page ownership, or null in the legacy mode (the
   *   last-page check reads it to tell a page this cleanup will close from one it will not)
   * @returns {Promise<boolean>} true to carry on with the next page (its close may
   *   still be pending); false when the cleanup has to stop (the browser was crashed)
   */
  const blankAndCloseOnePage = async (page, context, ownership) => {
    // A page a close was already issued or scheduled for is skipped, whatever the
    // re-read that handed it over again: it is still OPEN (its close waits out the
    // grace), and handling it twice would blank an already-blanked page and close it
    // twice.
    if (handledPages.has(page)) return true;

    // A page that is already closed has nothing left to protect: there is
    // nothing to navigate, nothing to close, and nothing to fail closed about.
    let gone = false;
    try {
      gone = typeof page.isClosed === "function" && page.isClosed() === true;
    } catch {
      gone = false;
    }
    if (gone) {
      // Nothing left to protect and nothing to fail closed about — but a later re-read
      // must not hand it over again either.
      handledPages.add(page);
      return true;
    }
    handledPages.add(page);

    // Deny every request at the page's own CDP session FIRST, so the
    // pagehide/unload requests the blanking below fires are already blocked
    // (the context route guard cannot see them). A page that has an endpoint
    // but cannot be attached is not navigated at all: fail closed.
    //
    // `permanent: true`: this page is never reused (nothing is detached here —
    // the browser is going away), so its own session gets the network-stack
    // block as well as the Fetch deny-all.
    let denyAll = null;
    try {
      denyAll = await attachDenyAllSession(page, { permanent: true });
    } catch {
      await killBrowser();
      return false;
    }

    // Then blank it, and close it only once the blank really committed.
    let blanked = false;
    try {
      const navigation = typeof page.goto === "function" ? page.goto("about:blank") : null;
      if (navigation && typeof navigation.then === "function") await navigation;
      blanked = typeof page.url === "function" && page.url() === "about:blank";
    } catch {
      // A goto that rejects did not blank the page: its old document, and its
      // armed pagehide beacons, are still there.
      blanked = false;
    }
    if (!blanked) {
      // FAIL CLOSED: never close a page whose blank did not commit, and stop
      // here — the survivor is not touched either.
      await killBrowser();
      return false;
    }
    blankedPages.add(page);
    if (typeof page.close !== "function") return true;
    // The commit is what the grace is counted from: the old document's pagehide /
    // unload work can start running the moment this navigation resolved.
    const committedAt = monotonicNow();
    if (!denyAll) {
      // Nothing to destroy: a page Playwright never hands over in the product
      // (every real page offers a CDP session), where the grace would only delay a
      // close that can break nothing. Closed here, as it always was — but through the
      // last-page check first, which every close in this cleanup goes through.
      return closeWithSurvivor(page, context, ownership);
    }
    scheduleClose(page, committedAt + UNLOAD_GRACE_MS, context, ownership);
    return true;
  };

  /**
   * The ownership mode: clean up the pages this MCP opened or drove, and nothing
   * else (see the doc comment above `blankPagesOnExit` for the classes and why an
   * uncertain page is left alone).
   *
   * The classes are settled BEFORE the pages are read: a page that appeared a
   * moment ago is classified by an asynchronous `opener()` lookup, and a page read
   * out of the middle of that lookup would be treated as nobody's. The survivor
   * rule and the re-read loop are the legacy ones, narrowed to bot pages: a fresh
   * survivor only when every live page is the bot's (otherwise an operator tab keeps
   * the browser alive, and a stray blank tab per turn would pile up), and the page
   * list re-read after each page so a popup the bot's page opens while it is being
   * blanked is cleaned up too.
   */
  const blankOwnedPages = async (context, ownership) => {
    const readPages = () => {
      try {
        return Array.from(context.pages() || []);
      } catch {
        return null;
      }
    };

    // A first look that does NOT wait for the classifications in flight: whether the
    // budget expires into a fail-closed crash or into nothing at all depends on
    // whether anything here is the bot's, and that must be known before the waiting
    // starts (a classification that hangs until the budget is exactly the case).
    // Pending classification work is NOT bot work by itself (A6): it is counted only
    // while the ownership reports a page of the bot's or a mark whose id it never got.
    // An OPERATOR arrival's `opener()` in flight therefore arms nothing. A
    // classification that THROWS counts as the bot's (`classifyOrBot`): it proves nothing.
    for (const page of readPages() || []) {
      if (page && classifyOrBot(ownership, page) === "bot") {
        botWorkPending = true;
        break;
      }
    }
    if (!botWorkPending && ownsBotWork(ownership)) botWorkPending = true;

    try {
      await ownership.settle({ budgetMs: settleBudgetMs() });
    } catch { /* settle() swallows everything: this is belt and braces */ }
    if (await endOnUnfinishedSettle(ownership)) return;

    let pages = [];
    try {
      pages = Array.from(context.pages() || []);
    } catch {
      return;
    }

    let botPages = 0;
    let others = 0;
    let uncertain = 0;
    for (const page of pages) {
      if (!page) continue;
      const owner = classifyOrBot(ownership, page);
      if (owner === "bot") {
        botPages += 1;
        continue;
      }
      // Operator and uncertain pages are never navigated, closed, blocked or given a CDP
      // session here, and are never probed either: no method is called on them anywhere in
      // this cleanup, not even at a close (see `keepAPageBehindTheClose`, which reads the
      // page list instead).
      others += 1;
      if (owner === "uncertain") uncertain += 1;
    }
    if (uncertain > 0) logUncertainPages(uncertain);
    if (botPages) botWorkPending = true;

    // Nothing the bot owns: nothing is made, navigated, closed or crashed.
    if (!botPages) return;

    // A survivor only when every live page would otherwise be gone: with an
    // operator (or uncertain) page left, the browser has a window already and a
    // fresh blank tab per turn would just pile up in it.
    let survivor = null;
    if (!others) {
      try {
        survivor = await context.newPage();
      } catch {
        // No survivor means every close is the browser's last page: crash, and
        // navigate and close nothing.
        await killBrowser();
        return;
      }
      survivorPages.add(survivor);
    }

    const handled = new Set();
    for (;;) {
      // Settle before every re-read, for the same reason as before the first read, under
      // what is left of the cleanup's own budget.
      try {
        await ownership.settle({ budgetMs: settleBudgetMs() });
      } catch { /* never rejects */ }
      // The same rule as after the first settle: a page still being classified is not on the
      // list above yet, so an unfinished settle ends the cleanup fail closed instead of
      // concluding there is nothing more of the bot's.
      if (await endOnUnfinishedSettle(ownership)) return;
      let live = [];
      try {
        live = Array.from(context.pages() || []);
      } catch {
        return;
      }
      const page = live.find(
        (candidate) =>
          candidate &&
          candidate !== survivor &&
          !handled.has(candidate) &&
          classifyOrBot(ownership, candidate) === "bot",
      );
      if (!page) break;
      handled.add(page);
      botWorkPending = true;
      if (!(await blankAndCloseOnePage(page, context, ownership))) return;
    }
  };

  /**
   * One more pass over ONE registered pair, taken after the cleanup's own page loop has
   * already found nothing left: settle (in the ownership mode, exactly as the first pass
   * does), RE-READ the context's pages, and blank the first one still needing it.
   *
   * The list the first pass walked is the list that existed while it walked. A page the old
   * document opens from inside its own close grace is still OPEN (its close is only
   * scheduled) and nothing in the first pass ever sees it, so the same question is asked
   * again here: the same ownership classification (bot pages only, legacy: every page but
   * the survivor), the same fail-closed helper, and a close of its own counted from that
   * page's own commit.
   *
   * @returns {Promise<"blanked"|"none"|"stopped">} "blanked" when a page was taken (its
   *   close may now be pending), "none" when there is nothing left here, "stopped" when
   *   the cleanup has to end (the browser was crashed)
   */
  const blankNextPageInContext = async (pair) => {
    let context = null;
    try {
      context = typeof pair.getter === "function" ? pair.getter() : null;
    } catch {
      context = null;
    }
    if (!context || typeof context.pages !== "function") return "none";

    const ownership = pair.ownership;
    if (ownership) {
      try {
        await ownership.settle({ budgetMs: settleBudgetMs() });
      } catch { /* never rejects */ }
      // A page still being classified is not on the list read below, so an unfinished
      // settle ends the cleanup fail closed instead of concluding nothing is left.
      if (await endOnUnfinishedSettle(ownership)) return "stopped";
    }

    let live = [];
    try {
      live = Array.from(context.pages() || []);
    } catch {
      return "none";
    }
    const page = live.find((candidate) => {
      if (!candidate || survivorPages.has(candidate) || handledPages.has(candidate)) return false;
      if (!ownership) return true;
      // A classification that THROWS is not "not the bot's": it proves nothing about the
      // page, so the page is taken as the bot's and cleaned (`classifyOrBot`).
      return classifyOrBot(ownership, candidate) === "bot";
    });
    if (!page) return "none";
    botWorkPending = true;
    return (await blankAndCloseOnePage(page, context, pair.ownership)) ? "blanked" : "stopped";
  };

  /**
   * Is this page already taken care of: the survivor the cleanup made, a page this cleanup
   * BLANKED (its close scheduled or issued), or a page that is already closed?
   *
   * Those three, and nothing else. `page.url()` is deliberately not one of them: a page can
   * arrive already at about:blank, or navigate itself back to it, and that says nothing about
   * this cleanup — nothing attached a deny-all session to it and it was never offered a goto,
   * so its pagehide/unload beacons are as armed as any untouched page's. Only a page this
   * cleanup blanked is in `blankedPages`.
   *
   * Only ever asked about a page that IS the bot's (or, in the legacy mode, a page that is
   * not the survivor), so the probes below never reach an operator tab.
   */
  const pageIsHandled = (page) => {
    if (!page || survivorPages.has(page)) return true;
    if (blankedPages.has(page)) return true;
    try {
      if (typeof page.isClosed === "function" && page.isClosed() === true) return true;
    } catch { /* a probe that throws proves nothing */ }
    return false;
  };

  /**
   * Is EVERY page that exists right now already handled?
   *
   * Computed FRESH each time it is asked, by re-reading each context's page list and
   * classifying it: an answer stored earlier is an answer about the pages that were read
   * then, and a page that arrived afterwards is exactly as armed as one that was there from
   * the start. Only bot pages are examined — an operator or uncertain page is left alone by
   * design and is never even probed — and in the legacy mode every page but the survivor has
   * to be handled.
   *
   * Anything that cannot be read or classified answers false: not being able to tell is not
   * the same as "every page is handled", and the crash is the safe end.
   */
  const everyPageHandled = () => {
    for (const pair of pairs) {
      let context = null;
      try {
        context = typeof pair.getter === "function" ? pair.getter() : null;
      } catch {
        return false;
      }
      if (!context || typeof context.pages !== "function") return false;
      // A class still being decided is a page that may be the bot's and armed: not a final
      // list. The NARROW question (`classifying()`): a target-id lookup records an id and
      // decides nothing, so a page list that is already final must not be crashed over it.
      if (pair.ownership && classificationsInFlight(pair.ownership)) return false;
      let pages = null;
      try {
        pages = Array.from(context.pages() || []);
      } catch {
        return false;
      }
      for (const page of pages) {
        if (!page || survivorPages.has(page)) continue;
        // A classification that THROWS counts as the bot's here too: "could not decide"
        // is not "handled", and the page is then judged by `pageIsHandled` like any other
        // page of the bot's (an unhandled one still ends in the crash).
        if (pair.ownership && classifyOrBot(pair.ownership, page) !== "bot") continue;
        if (!pageIsHandled(page)) return false;
      }
    }
    return true;
  };

  /**
   * The synchronous first look at one pair: does anything of the bot's exist here
   * ALREADY — a page some path classed BOT, or a mark whose target id it never got?
   *
   * This has to run before the cleanup's first await (the browser-session opening),
   * because a budget that expires while that opening is still pending can only choose
   * between a fail-closed crash and nothing at all by what is known HERE: a bot page
   * known now is armed pages behind the stuck opening, so the crash has to happen; no
   * bot page and nothing unresolved means nothing of ours was navigated or armed, and a
   * crash would destroy the operator's tabs for nothing.
   *
   * Pending classification work is deliberately NOT read here on its own (A6): with no
   * bot page marked and nothing unresolved, the work in flight is an operator arrival's
   * and nothing of the bot's can be armed behind it. `ownsBotWork` is what says whether
   * there is anything of the bot's for that work to be about (and for an ownership that
   * cannot report its two counts, it keeps the old answer: pending work does count).
   * Never throws, and never calls anything on a page.
   */
  const primeBotWork = (pair) => {
    // The legacy mode cleans up everything, so it always fails closed on a budget.
    if (!pair.ownership) return;
    let pages = null;
    try {
      const context = typeof pair.getter === "function" ? pair.getter() : null;
      pages = context && typeof context.pages === "function" ? Array.from(context.pages() || []) : null;
    } catch {
      pages = null;
    }
    for (const page of pages || []) {
      // A classification that THROWS proves nothing, and is read as the bot's here as
      // everywhere else in this cleanup (`classifyOrBot`).
      if (classifyOrBot(pair.ownership, page) === "bot") {
        botWorkPending = true;
        return;
      }
    }
    // Pages that exist are not the bot's, so the only bot work this pair could still
    // hold is one of its own accounting: a page it classed BOT earlier, or a mark whose
    // target id was never resolved (which a reconnect would have to fail closed on).
    if (ownsBotWork(pair.ownership)) botWorkPending = true;
  };

  /** One pair: open its browser session, then clean its context in its own mode. */
  const blankOneContext = async (pair) => {
    let context = null;
    try {
      context = typeof pair.getter === "function" ? pair.getter() : null;
    } catch {
      context = null;
    }
    if (!context || typeof context.pages !== "function") return;

    // 0. The browser session FIRST: the budget can expire while a page is still
    //    being blanked, and the crash that then has to end the cleanup needs a
    //    session that already exists.
    browserSession = null;
    browserSessionOpening = null;
    try {
      const browser = typeof context.browser === "function" ? context.browser() : null;
      if (browser && typeof browser.newBrowserCDPSession === "function") {
        // Held as a promise as well as awaited: a budget that fires while this is
        // pending must wait for it instead of concluding there is no session.
        browserSessionOpening = (async () => {
          try {
            browserSession = await browser.newBrowserCDPSession();
            return browserSession;
          } catch {
            return null;
          }
        })();
      }
    } catch {
      browserSessionOpening = null;
    }
    if (browserSessionOpening) await browserSessionOpening;
    if (browserSession) openedBrowserSessions.add(browserSession);

    // With an ownership (the MCP server always passes one), only the pages the bot
    // opened or drove are cleaned up: every other page in this context is the
    // operator's, or one nobody can prove, and is left completely alone — no CDP
    // session, no navigation, no close, no write, no method called at all. (The fresh page
    // list read right before a close is what keeps such a page behind it: see
    // `keepAPageBehindTheClose`.)
    if (pair.ownership) {
      await blankOwnedPages(context, pair.ownership);
      return;
    }

    // The OLD pages, snapshotted BEFORE the survivor is made: a page the
    // survivor-making call itself creates must never be blanked or closed.
    let oldPages = [];
    try {
      oldPages = Array.from(context.pages() || []);
    } catch {
      return;
    }
    if (!oldPages.length) return; // no page to protect: make nothing, kill nothing

    // 1. The fresh survivor FIRST. Without it no close below can be safe: in
    //    headful Chromium closing the last page exits the browser, and a page 0
    //    left behind would keep the bot's history and back-forward cache.
    let survivor = null;
    try {
      survivor = await context.newPage();
    } catch {
      // No survivor means every close is the last page, and no page can be left
      // behind either: kill the browser (never close it), close and navigate
      // nothing.
      await killBrowser();
      return;
    }
    survivorPages.add(survivor);

    // 2. Every page the context holds that is neither the survivor nor already
    //    handled, one at a time.
    const handled = new Set();
    for (;;) {
      let live = [];
      try {
        live = Array.from(context.pages() || []);
      } catch {
        return;
      }
      const page = live.find((candidate) => candidate && candidate !== survivor && !handled.has(candidate));
      if (!page) break;
      handled.add(page);

      // One page: deny, blank, observe the commit, and schedule the close — or crash
      // and stop (the survivor is not touched either).
      if (!(await blankAndCloseOnePage(page, context, null))) return;
    }
  };

  /**
   * Every registered pair, in registration order, under the one budget below.
   *
   * The first looks are ALL synchronous and come first, before this cleanup's first
   * await: see `primeBotWork`.
   */
  const blankAll = async () => {
    for (const pair of pairs) primeBotWork(pair);
    for (const pair of pairs) {
      // A crash (or the give-up) already ended the cleanup: nothing further is
      // touched, in any context.
      if (crashed) return;
      await blankOneContext(pair);
    }
    // The page list has been walked to its end at least once, so what is left is a page
    // list the cleanup has actually read (see the budget's exemption in `run`).
    pageWalkFinished = true;
    // Nothing is waiting on a grace: no page was blanked, so no page is still open
    // behind a scheduled close, and no page of the bot's is left to be spawned by one.
    if (!pendingCloses.size) return;
    // THE CLOSE PHASE (see the doc comment above `blankPagesOnExit`). Every page the pairs
    // found is blanked by now; what is left is the grace each close waits out before it is
    // issued — and those pages are still OPEN while they wait, so a document can still open
    // a page in that window. The cleanup therefore does not finish here: it waits the closes
    // out, re-reads every context, blanks what arrived, and goes round again until a pass
    // finds no new page AND no close is pending. The closes it schedules in those passes are
    // waited out by the same loop, so the survivor rule and the process exit still rest on
    // the pages actually being closed.
    for (;;) {
      if (pendingCloses.size) await closeScheduledPages();
      if (crashed) return;
      let taken = false;
      for (const pair of pairs) {
        for (;;) {
          if (crashed) return;
          const outcome = await blankNextPageInContext(pair);
          if (outcome === "stopped") return;
          if (outcome === "none") break;
          taken = true;
        }
      }
      if (!taken && !pendingCloses.size) return;
    }
  };

  /**
   * True once every registered pair has been walked once: the cleanup has a page list it
   * actually read. NOT a statement about any page — that one is computed fresh, from the pages
   * themselves, where it is needed (see `everyPageHandled`) — but the budget's exemption needs
   * both facts: a settle that never answered never read a list, so nothing can say the pages
   * are handled, whatever a read taken now would say about a list nobody has walked.
   */
  let pageWalkFinished = false;
  /**
   * Is anything of the bot's known (or still possible) in ANY registered pair? That is
   * what decides whether a budget that ran out ends in a crash.
   *
   * A bot page already seen, or an ownership reporting one (`botPageCount()`) or a mark
   * whose id it never got (`unresolvedMarks()`). Pending classification work is not a
   * reason by itself (A6): with neither set, the work in flight is nobody's but the
   * operator's. An ownership that cannot report gets the old fail-closed answer.
   */
  const botWorkIsArmed = () => {
    if (botWorkPending) return true;
    for (const pair of pairs) {
      // The legacy mode cleans up every page in its context: it always fails closed,
      // exactly as it did before the ownership existed.
      if (!pair.ownership) return true;
      if (ownsBotWork(pair.ownership)) return true;
    }
    return false;
  };

  /**
   * The cleanup's own WORK (`blankAll`), as opposed to `run`, which RACES that work against
   * the budget. `run` can resolve through the budget's exemption (every page handled, no
   * close pending) while this promise is still inside the close-phase loop, and a crash
   * that lands after that point is not in `failed()` yet. A caller that keeps running reads
   * the verdict only once this has settled (see `settled`).
   */
  let workPromise = null;

  /**
   * Waits for the cleanup's own work, bounded by `EXIT_CLEANUP_WORST_CASE_MS`, and answers
   * WHICH of the two happened: `true` when the work SETTLED inside the bound, `false` when
   * the bound passed with the work still running. Never rejects. The bound is the cleanup's
   * own worst case, so a close that never answers cannot hold a caller past the point where
   * every process that signals this one is allowed to kill it.
   *
   * The answer is a fact the caller has to act on: work still running at the bound may yet
   * blank a page, or crash the browser, so `failed()` read at that moment is not final. "false"
   * therefore means "this run did NOT prove it finished", never "the work is over": a caller
   * that keeps running (`closeGuardedPages`) reports it as a close that cannot be called clean.
   */
  const settled = () => {
    const work = workPromise || Promise.resolve();
    return new Promise((resolve) => {
      let answered = false;
      let timer = null;
      const finish = (settledInTime) => {
        if (answered) return;
        answered = true;
        if (timer !== null) clearTimeout(timer);
        resolve(settledInTime);
      };
      // Deliberately NOT unref'd: a caller waiting on this bound keeps running, and it has to
      // be ANSWERED (false) rather than let go with the process.
      timer = setTimeout(() => finish(false), EXIT_CLEANUP_WORST_CASE_MS);
      work.then(
        () => finish(true),
        () => finish(true),
      );
    });
  };

  /**
   * Detach every browser-level session this cleanup opened, once each, swallowing failures —
   * and never waiting for one longer than `CRASH_GRACE_MS` (see `detachWithin`).
   *
   * The EXIT path never calls this (the browser is going away); `closeGuardedPages` does, so a
   * restart does not leak one CDP session per call. That caller KEEPS RUNNING, and its calls are
   * serialised on one module-level chain: a detach that never answers — a session on a
   * connection that has already gone quiet — would otherwise wedge this call, every call
   * behind it, and the process's next restart or proxy change. The session is taken out of
   * this cleanup's record either way, and a detach still outstanding at the grace is let go:
   * it is already useless to a caller that has moved on.
   */
  const releaseBrowserSession = async () => {
    for (const session of openedBrowserSessions) {
      openedBrowserSessions.delete(session);
      await detachWithin(session, CRASH_GRACE_MS);
    }
  };

  const run = () => {
    if (pending) return pending;
    startedAt = Date.now();
    workPromise = blankAll().then(() => "done", () => "done");
    const work = workPromise;
    const budget = new Promise((resolve) => {
      const timer = setTimeout(() => resolve("budget"), budgetMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    pending = Promise.race([work, budget])
      .then(async (which) => {
        if (which !== "budget") return;
        // A budget that expires before anything of the bot's was found has nothing
        // to fail closed about: nothing of ours was navigated or armed, and a crash
        // would destroy the operator's tabs for nothing. Pending classification work
        // counts only while the ownership reports a bot page or an unresolved mark
        // (A6) — an operator arrival's `opener()` still in flight is not bot work.
        // The legacy mode (a pair with no ownership) always fails closed, as it
        // always did.
        if (!botWorkIsArmed()) return;
        // Is everything that exists right now already handled? Asked FRESH, by re-reading
        // each context's pages (see `everyPageHandled`): the answer stored for the pages a
        // pass READ says nothing about a page that arrived after that pass — one landing in
        // a close grace is still open and still unblanked, and it is the very page the crash
        // exists for. Nothing stored is trusted here.
        if (pageWalkFinished && everyPageHandled()) {
          // Every page is blanked, closed, or the survivor: nothing armed is left behind,
          // and what the cleanup is waiting on is the grace before each close
          // (`UNLOAD_GRACE_MS`). The crash exists for pages that were never blanked — their
          // close-time beacons would fire with nothing in front of them — and there are none:
          // these pages are blank, and their closes are already scheduled. Crashing here
          // would destroy the browser the cleanup has just made safe, so the cleanup waits
          // for those closes instead, bounded, so a close that never answers cannot hold the
          // process open.
          //
          // The bound is the end of the WAIT, never the end of the danger: it is reached with
          // a page still OPEN when its close never answered, and that page is exactly what
          // the crash exists for. So the wait reports whether the cleanup actually SETTLED,
          // and a wait that ran out is decided again, FRESH, below — never by the answer that
          // granted the exemption.
          const settledInTime = await withinMs(work, UNLOAD_GRACE_MS + CRASH_GRACE_MS);
          if (settledInTime) return;
          // The cleanup is still running at the bound. A close it issued and never got an
          // answer for is a page still open behind the wait, and a page a re-read taken NOW
          // does not prove handled is armed exactly as it was at the budget. Only a list that
          // is fully handled with nothing outstanding may be left to finish; anything else
          // ends where an expired budget ends: one line, and the crash.
          if (pendingCloses.size === 0 && everyPageHandled()) return;
          logBudgetExhausted();
          await killBrowser();
          return;
        }
        // Out of budget with pages still armed: the browser is the only safe end.
        // Say so first — a crash with no explanation reads as a fault.
        logBudgetExhausted();
        await killBrowser();
      })
      .catch(() => {});
    return pending;
  };

  return { run, own: addOrUpdate, failed: () => cleanupFailed, settled, releaseBrowserSession };
}

// ---------------------------------------------------------------------------
// The node-side fetch (the PDF tool)
// ---------------------------------------------------------------------------

/**
 * The addresses a URL's request may connect to, and the refusal otherwise.
 *
 * `checkUrl` makes the decision; this returns the exact address list it judged,
 * so a caller can pin a connection to those addresses instead of resolving the
 * name a second time (a name that answers differently on the second lookup is
 * how a DNS-rebinding request slips past a check-then-connect fetch).
 *
 * @param {string} url
 * @param {{resolve?: (host: string) => Promise<string[]>, exceptions?: object, noCache?: boolean}} [opts]
 * @returns {Promise<{ok: true, addresses: string[], nameExcepted?: boolean}|{ok: false, reason: string, host: string, address?: string}>}
 */
export async function resolveChecked(url, opts = {}) {
  const verdict = await checkUrl(url, {
    mode: "navigate",
    resolve: opts.resolve,
    exceptions: opts.exceptions,
    noCache: opts.noCache,
  });
  if (!verdict.ok) return verdict;

  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return { ok: false, reason: "invalid URL", host: "" };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return { ok: true, addresses: [], nameExcepted: false };
  const parsedHost = parseHost(parsed.hostname);
  if (parsedHost.kind === "ip") return { ok: true, addresses: [parsedHost.ip], nameExcepted: false };

  const addresses = await resolveName(parsedHost.name, opts).catch(() => []);
  if (!addresses.length) return { ok: false, reason: UNRESOLVED, host: parsedHost.name };
  // The name (not just the address) may be on the owner's list: a caller pinning the
  // connection has to know, or it would refuse a name `checkUrl` just allowed.
  const nameExcepted = hostExcepted(parsedHost.name, opts.exceptions || NO_EXCEPTIONS);
  return { ok: true, addresses, nameExcepted };
}

/** Which family an address text belongs to (4 when it cannot be parsed). */
function familyOf(address) {
  const parsed = parseAddress(address);
  return parsed ? parsed.family : 4;
}

/** The error a pinned lookup hands node when it refuses an address. */
function pinnedError(reason) {
  return Object.assign(new Error(`Crow's browser refuses a connection to that address (${reason})`), {
    code: "ECROWPRIVATEADDRESS",
  });
}

/**
 * A node `lookup` that answers with the addresses already judged, and never with
 * a fresh DNS answer. Give it to `http.request`/`https.request` so the socket is
 * opened at the address the check saw.
 *
 * Each pinned address is judged again (cloud metadata is never excepted), so a
 * lookup built by hand cannot pin a private destination by mistake. `nameExcepted`
 * is the host-name exception `checkUrl` applied to this hop: without it the PDF
 * tool would refuse a name the browser tools just allowed. It never covers
 * cloud-metadata addresses, which are refused before it is consulted.
 *
 * @param {string[]} addresses
 * @param {{exceptions?: object, nameExcepted?: boolean}} [opts]
 * @returns {(hostname: string, options: object|Function, callback?: Function) => void}
 */
export function pinnedLookup(addresses, opts = {}) {
  const exceptions = opts.exceptions || NO_EXCEPTIONS;
  const nameExcepted = opts.nameExcepted === true;
  const pinned = (Array.isArray(addresses) ? addresses : []).map((address) => String(address));

  const resolveWith = (settings) => {
    let allowed = [];
    for (const address of pinned) {
      let reason;
      try {
        reason = classifyIp(address);
      } catch {
        reason = "unrecognised address";
      }
      if (reason === METADATA) throw pinnedError(reason);
      if (reason && !(nameExcepted || addressExcepted(address, exceptions))) throw pinnedError(reason);
      allowed.push(address);
    }
    const family = settings && (settings.family === 4 || settings.family === 6) ? settings.family : 0;
    if (family) allowed = allowed.filter((address) => familyOf(address) === family);
    if (!allowed.length) throw pinnedError(UNRESOLVED);
    return allowed;
  };

  /**
   * @param {string} _hostname the name the caller asked for; never resolved
   * @param {object|Function} options node's dns options, or the callback
   * @param {Function} [callback] `(err, addresses)` when `options.all`, else `(err, address, family)`
   */
  return function lookup(_hostname, options, callback) {
    const settings = typeof options === "function" ? {} : (options || {});
    const done = typeof options === "function" ? options : callback;
    if (typeof done !== "function") return;
    setTimeout(() => {
      let allowed;
      try {
        allowed = resolveWith(settings);
      } catch (err) {
        done(err);
        return;
      }
      if (settings.all) {
        done(null, allowed.map((address) => ({ address, family: familyOf(address) })));
        return;
      }
      done(null, allowed[0], familyOf(allowed[0]));
    }, 0);
  };
}

/** The error a fetch hands back when its overall deadline runs out. */
function deadlineError(deadlineMs) {
  const how = deadlineMs >= 1000 ? `${Math.round(deadlineMs / 1000)} seconds` : `${Math.round(deadlineMs)} ms`;
  return new Error(`Fetch gave up after ${how} (the whole fetch, redirects and body included).`);
}

/** `promise`, or a rejection at `deadlineAt`; the timer never keeps the process alive. */
function withDeadline(promise, deadlineAt, deadlineMs) {
  return new Promise((resolve, reject) => {
    const left = deadlineAt - Date.now();
    if (left <= 0) { reject(deadlineError(deadlineMs)); return; }
    const timer = setTimeout(() => reject(deadlineError(deadlineMs)), left);
    if (typeof timer.unref === "function") timer.unref();
    const clear = () => clearTimeout(timer);
    Promise.resolve(promise).then(
      (value) => { clear(); resolve(value); },
      (err) => { clear(); reject(err); },
    );
  });
}

/**
 * One hop of the node-side fetch: connects only to `checked.addresses` (through a
 * pinned lookup, which also honours a host-name exception), never follows a
 * redirect and never keeps the whole body of one. The `deadlineAt` it is given is
 * the whole fetch's, so the body read is covered by it too.
 *
 * @param {string} url
 * @param {{addresses: string[], nameExcepted?: boolean}} checked
 * @param {{exceptions?: object, headers?: object, deadlineAt?: number, deadlineMs?: number}} opts
 * @returns {Promise<Response>}
 */
function requestPinned(url, checked, opts) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const secure = target.protocol === "https:";
    const transport = secure ? httpsRequest : httpRequest;
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const headers = { ...((opts && opts.headers) || {}) };
    // An explicit Host header, so an IPv6 literal is bracketed and a name keeps
    // its name (the connection goes to the pinned address, not to the name).
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "host")) {
      const label = hostname.includes(":") ? `[${hostname}]` : hostname;
      headers.host = target.port ? `${label}:${target.port}` : label;
    }
    const deadlineAt = opts && Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : 0;
    const deadlineMs = opts && Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? opts.deadlineMs : FETCH_DEADLINE_MS;

    // One settlement only: a response, an error or the deadline, whichever is
    // first, and the deadline timer goes with it.
    let timer = null;
    let settled = false;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      fn(value);
    };
    const succeed = finish(resolve);
    const fail = finish(reject);

    const requestOptions = {
      protocol: target.protocol,
      hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: (opts && opts.method) || "GET",
      headers,
      lookup: pinnedLookup(checked.addresses, {
        exceptions: opts && opts.exceptions,
        // The host name itself may be on the owner's list: `checkUrl` allowed
        // this hop, so the connection has to agree (metadata is still refused).
        nameExcepted: checked.nameExcepted === true,
      }),
      // A connection opened for this hop is never reused by a later, unpinned one.
      agent: false,
    };
    // SNI has to name the virtual host the URL asked for, never the IP literal.
    if (secure && isIP(hostname) === 0) requestOptions.servername = hostname;

    const req = transport(requestOptions, (res) => {
      const status = Number(res.statusCode) || 0;
      if (status < 200) {
        // A Response cannot carry an informational status (101 and the like).
        res.resume();
        fail(new Error(`Fetch got an unusable response status (${status}).`));
        return;
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, String(item));
        else responseHeaders.set(key, String(value));
      }
      const statusText = res.statusMessage || "";

      if (REDIRECT_STATUSES.has(status) || NULL_BODY_STATUSES.has(status)) {
        // The caller only reads the status and the location: do not buffer a body.
        res.resume();
        succeed(new Response(null, { status, statusText, headers: responseHeaders }));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`Fetch refused a response larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          succeed(new Response(Buffer.concat(chunks), { status, statusText, headers: responseHeaders }));
        } catch (err) {
          fail(err);
        }
      });
      res.on("error", fail);
    });

    if (deadlineAt) {
      const left = deadlineAt - Date.now();
      if (left <= 0) {
        // The check used the budget up: never open a connection for this hop.
        try { req.destroy(); } catch { /* gone */ }
        fail(deadlineError(deadlineMs));
        return;
      }
      // The overall deadline, not the idle timeout below: it ends a hop that is
      // dribbling a body as well as one that never answers.
      timer = setTimeout(() => {
        const err = deadlineError(deadlineMs);
        try { req.destroy(err); } catch { fail(err); }
      }, left);
      if (typeof timer.unref === "function") timer.unref();
    }

    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS / 1000} seconds.`));
    });
    req.on("error", fail);
    req.end();
  });
}

/**
 * fetch() that checks every hop itself: redirects are followed manually, and the
 * connection of each hop is pinned to the addresses the check judged — so a name
 * that answers differently the second time cannot carry the request somewhere
 * private.
 *
 * A caller may pass `fetchImpl` to do the transfer itself (the existing tests
 * do); the address check still runs first, but that implementation is then the
 * caller's business. Without it, node:http/https is used with a pinned lookup.
 *
 * The idle timeout in a hop only stops a hop that has gone quiet. On top of it
 * there is ONE deadline for the whole fetch — every redirect hop and the body of
 * the last one — `deadlineMs` (60 s by default), so a server that dribbles bytes,
 * or a redirect chain that keeps answering, cannot hold a tool call forever.
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, resolve?: (host: string) => Promise<string[]>, exceptions?: object, maxRedirects?: number, deadlineMs?: number}} [opts]
 * @returns {Promise<Response>}
 */
export async function guardedFetch(url, opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : null;
  const maxRedirects = Number.isInteger(opts.maxRedirects) ? opts.maxRedirects : 5;
  const deadlineMs = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? opts.deadlineMs : FETCH_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (Date.now() >= deadlineAt) throw deadlineError(deadlineMs);
    const checked = await resolveChecked(current, {
      resolve: opts.resolve,
      exceptions: opts.exceptions,
      noCache: opts.noCache,
    });
    if (!checked.ok) throw new Error(refusalText(checked));
    if (Date.now() >= deadlineAt) throw deadlineError(deadlineMs);
    const response = fetchImpl
      ? await withDeadline(fetchImpl(current, { redirect: "manual" }), deadlineAt, deadlineMs)
      : await requestPinned(current, checked, { ...opts, deadlineAt, deadlineMs });
    const isRedirect = REDIRECT_STATUSES.has(response.status);
    const location = isRedirect ? response.headers.get("location") : null;
    if (!isRedirect || !location) return response;
    current = new URL(location, current).href;
  }
  throw new Error(`Too many redirects (more than ${maxRedirects}).`);
}