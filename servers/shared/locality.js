/**
 * Physical locality predicate — shared by the GPU orchestrator (F-INSTALL-10)
 * and the providers reconciler (owner-asserts sync design).
 *
 * The only trustworthy signal for "does this provider endpoint live on THIS
 * machine" is whether its baseUrl points at loopback or one of our own
 * interface addresses. The providers `host` column cannot be used: it syncs
 * fleet-wide with the seeding instance's perspective baked in (live fleet:
 * grackle's own embed row says host='grackle-5fc01ac74463b6f4', crow's
 * bundles say 'local' everywhere), so a host-string gate either breaks a
 * peer keeping its own bundle resident or lets a fresh install start the
 * maintainer-lab's bundles.
 *
 * Caveat for sync-ownership callers: loopback addresses are in every
 * instance's own-address set, so a loopback baseUrl is "local" EVERYWHERE —
 * this predicate is a locality test, not a fleet-wide ownership partition.
 * Loopback provider rows are kept off the sync wire entirely (see
 * shouldSyncRow('providers') in servers/sharing/instance-sync.js).
 */

import { networkInterfaces } from "node:os";

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
