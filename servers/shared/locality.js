/**
 * Physical locality predicate — shared by the GPU orchestrator (F-INSTALL-10)
 * and the providers reconciler (owner-asserts sync design).
 *
 * The only trustworthy signal for "does this provider endpoint live on THIS
 * machine" is whether its baseUrl points at loopback or one of our own
 * interface addresses. The providers `host` column cannot be used: it syncs
 * fleet-wide with the seeding instance's perspective baked in (historically,
 * grackle's own embed row carried host='grackle-5fc01ac74463b6f4' while
 * crow's bundles said 'local' everywhere), so a host-string gate either
 * breaks a peer keeping its own bundle resident or lets a fresh install
 * start the maintainer-lab's bundles.
 *
 * Caveat for sync-ownership callers: loopback addresses are in every
 * instance's own-address set, so a loopback baseUrl is "local" EVERYWHERE —
 * this predicate is a locality test, not a fleet-wide ownership partition.
 * Loopback provider rows are kept off the sync wire entirely (see
 * shouldSyncRow('providers') in servers/sharing/instance-sync.js).
 */

import { networkInterfaces } from "node:os";
import { isIP } from "node:net";

// Bridge/virtual interfaces carry SHARED-SUBNET gateway IPs (every docker
// host has 172.17.0.1; libvirt ships 192.168.122.1) — never machine identity
// (R2-M1). Skip them so a peer's hypothetical bridge-IP baseUrl can't
// false-match here.
const VIRTUAL_IF_RE = /^(docker|br-|veth|virbr|vmnet|lxc|cni)/;

export function getOwnAddresses() {
  const own = new Set(["localhost", "127.0.0.1", "::1"]);
  try {
    for (const [ifname, addrs] of Object.entries(networkInterfaces())) {
      if (VIRTUAL_IF_RE.test(ifname)) continue;
      for (const a of addrs || []) own.add(a.address);
    }
  } catch {}
  return own;
}

export function isLocallyOrchestratable(p, ownAddrs = getOwnAddresses()) {
  if (!p?.baseUrl) return false;
  try {
    // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]"); interface
    // addresses don't have them.
    const h = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, "");
    return ownAddrs.has(h);
  } catch {
    return false;
  }
}

function v4Octets(h) {
  let m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (m) return isIP(m[1]) === 4 ? m[1].split(".").map(Number) : null;
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h); // WHATWG-normalised mapped form
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255];
  }
  return isIP(h) === 4 ? h.split(".").map(Number) : null;
}

/**
 * Network class of an IP literal, or null for a DNS name. Used by the
 * providers host-repair guard G1 (spec 2026-09-22 §3.4) and by display.
 * NEVER a locality or ownership answer — that is own-address membership
 * (isLocallyOrchestratable), not a range test.
 */
export function addressClass(h) {
  if (typeof h !== "string" || !h) return null;
  const o = v4Octets(h);
  if (o) {
    const [a, b] = o;
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "linklocal";
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "rfc1918";
    return "public4";
  }
  if (isIP(h) !== 6) return null;
  const x = h.toLowerCase();
  if (x === "::1") return "loopback";
  if (/^fe[89ab]/.test(x)) return "linklocal";
  if (/^f[cd]/.test(x)) return "ula";
  return "public6";
}

/**
 * DISPLAY ONLY: does this hostname look like it lives on a private network?
 * Never use it to decide routing, ownership or whether to start a model —
 * conflating "private address" with "this machine" was the inferHost bug.
 */
export function isPrivateHost(h) {
  if (typeof h !== "string" || !h) return false;
  const c = addressClass(h);
  if (c) return c !== "public4" && c !== "public6";
  const n = h.toLowerCase();
  if (!n.includes(".")) return true;
  return /\.(local|lan|internal|home\.arpa|ts\.net)$/.test(n);
}
