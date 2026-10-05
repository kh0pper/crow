/**
 * Classify an IP address literal: is it public, or loopback / private / link-local / reserved?
 *
 * Every textual form of an address must land in the same class. The WHATWG URL parser rewrites a
 * bracketed `[::ffff:127.0.0.1]` to `::ffff:7f00:1` and `127.1` / `0x7f.1` / `2130706433` to
 * `127.0.0.1`, DNS answers arrive in yet other spellings, and several IPv6 ranges carry an IPv4
 * address inside them (v4-mapped, v4-compatible, SIIT, NAT64, 6to4, Teredo). So an IPv6 address is
 * expanded to its eight 16-bit groups first, any embedded IPv4 is decoded, and the class is decided
 * on numbers, never on string prefixes. Anything that does not parse is "invalid", which no caller
 * treats as public (fail closed).
 *
 * Node built-ins only. Imported by bundles through the app root, never a relative path.
 */
import { isIP } from "node:net";

/** "a.b.c.d" (strict dotted quad, as net.isIP accepts it) → 32-bit unsigned int. */
function v4ToInt(s) {
  return s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

const inV4 = (n, base, bits) => bits === 0 || Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4ToInt(base) / 2 ** (32 - bits));

/** IPv4 ranges that are not public, most specific first where it matters. */
const V4_RANGES = [
  ["0.0.0.0", 32, "unspecified"],
  ["0.0.0.0", 8, "reserved"],          // "this network"
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "cgnat"],         // shared address space; also the tailnet's range
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "linklocal"],    // includes the cloud metadata address
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],       // IETF protocol assignments
  ["192.0.2.0", 24, "reserved"],       // documentation
  ["192.88.99.0", 24, "reserved"],     // deprecated 6to4 relay anycast
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "reserved"],      // benchmarking
  ["198.51.100.0", 24, "reserved"],    // documentation
  ["203.0.113.0", 24, "reserved"],     // documentation
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],        // includes 255.255.255.255
];

function classifyV4Int(n) {
  for (const [base, bits, cls] of V4_RANGES) if (inV4(n, base, bits)) return cls;
  return "public";
}

const intToV4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/**
 * Expand an IPv6 literal to eight 16-bit numbers, or null. Accepts compressed, zero-padded,
 * upper-case and dotted-tail forms and a zone id (`fe80::1%eth0`); rejects everything else.
 */
export function parseIPv6(input) {
  let s = String(input ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  if (isIP(s) !== 6) return null;
  s = s.replace(/%.*$/, "").toLowerCase();
  if (s.includes(".")) {
    // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes its two hex groups.
    const at = s.lastIndexOf(":") + 1;
    const v4 = s.slice(at);
    if (isIP(v4) !== 4) return null;
    const n = v4ToInt(v4);
    s = s.slice(0, at) + (n >>> 16).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(":").filter((x) => x !== "").map((x) => parseInt(x, 16)) : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

const v4Of = (hi, lo) => ((hi << 16) >>> 0) + lo;

/**
 * Classify one address. Returns { cls, v4, via }:
 *   cls — "public", "unspecified", "loopback", "private", "cgnat", "linklocal", "ula",
 *         "multicast", "reserved" or "invalid";
 *   v4  — the embedded IPv4 the class was decided on (dotted), or null;
 *   via — how it was embedded: "mapped", "siit", "compatible", "nat64", "6to4", "teredo", or null.
 */
export function classifyIp(input) {
  const plain = (cls) => ({ cls, v4: null, via: null });
  const raw = String(input ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  if (isIP(raw) === 4) return plain(classifyV4Int(v4ToInt(raw)));
  const g = parseIPv6(raw);
  if (!g) return plain("invalid");
  const embedded = (hi, lo, via) => { const n = v4Of(hi, lo); return { cls: classifyV4Int(n), v4: intToV4(n), via }; };
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);

  if (zero(0, 8)) return plain("unspecified");
  if (zero(0, 7) && g[7] === 1) return plain("loopback");
  if (zero(0, 5) && g[5] === 0xffff) return embedded(g[6], g[7], "mapped");             // ::ffff:0:0/96
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return embedded(g[6], g[7], "siit"); // ::ffff:0:0:0/96
  if (zero(0, 6)) return embedded(g[6], g[7], "compatible");                            // ::/96 (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded(g[6], g[7], "nat64"); // 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return plain("reserved"); // local-use NAT64 /48
  if (g[0] === 0x2002) return embedded(g[1], g[2], "6to4");                                // 2002::/16
  if (g[0] === 0x2001 && g[1] === 0) {                                                     // Teredo 2001::/32
    const server = embedded(g[2], g[3], "teredo");
    const client = embedded(g[6] ^ 0xffff, g[7] ^ 0xffff, "teredo");                       // client v4 is stored inverted
    return client.cls !== "public" ? client : server;
  }
  const first = g[0];
  if ((first & 0xff00) === 0xff00) return plain("multicast");        // ff00::/8
  if ((first & 0xffc0) === 0xfe80) return plain("linklocal");        // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return plain("private");          // fec0::/10, deprecated site-local
  if ((first & 0xfe00) === 0xfc00) return plain("ula");              // fc00::/7
  if ((first & 0xe000) !== 0x2000) return plain("reserved");         // outside global unicast 2000::/3
  if (first === 0x2001 && g[1] === 0x0db8) return plain("reserved"); // documentation
  if (first === 0x2001 && g[1] < 0x0200) return plain("reserved");   // 2001::/23 IETF protocol assignments (benchmarking, ORCHID, …)
  if (first === 0x3fff && g[1] < 0x1000) return plain("reserved"); // 3fff::/20 documentation
  return plain("public");
}

/** True only for a public unicast address. Unparseable input is never public. */
export function isPublicIp(address) {
  return classifyIp(address).cls === "public";
}

const LOCAL_CLASSES = new Set(["loopback", "private", "cgnat", "linklocal", "ula"]);

/**
 * True for an address on this host or the operator's own network, reached directly: loopback,
 * RFC 1918, CGNAT/tailnet, link-local, unique-local, and the v4-mapped spelling of any of those.
 * An IPv4 reached through a translator or tunnel (NAT64, 6to4, Teredo, v4-compatible) is not
 * local, and neither are unspecified, multicast or reserved addresses.
 */
export function isLocalNetworkIp(address) {
  const { cls, via } = classifyIp(address);
  return LOCAL_CLASSES.has(cls) && (via === null || via === "mapped");
}
