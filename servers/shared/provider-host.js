/**
 * providers.host vocabulary (spec: docs/superpowers/specs/2026-09-22-provider-host-identity-design.md).
 *
 *   "local"         the WRITER's own machine (loopback / own interface address).
 *   <instance-id>   32-hex id of the Crow instance serving the endpoint. Written
 *                   only explicitly — inference never writes one (D2).
 *   "cloud"         not managed from here: call base_url directly (public APIs
 *                   and unmanaged network boxes alike; Kevin, D1).
 *
 * `host` is NOT an orchestration gate (D9): the only veto it carries is "this
 * belongs to a different Crow instance" (isForeignInstanceHost). Whether this
 * machine may start a model is decided by address/owner checks elsewhere.
 */
import { isIP } from "node:net";
import { getOwnAddresses, addressClass, isPrivateHost } from "./locality.js";

const INSTANCE_ID_RE = /^[0-9a-f]{32}$/;

export function isInstanceIdShape(h) {
  return typeof h === "string" && INSTANCE_ID_RE.test(h);
}

export function isValidHost(h) {
  return h === "local" || h === "cloud" || isInstanceIdShape(h);
}

export function hostnameOf(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  try {
    return new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isIpLiteral(h) {
  return typeof h === "string" && isIP(h) !== 0;
}

export function inferHost(baseUrl, existingHost, { ownAddrs } = {}) {
  if (isValidHost(existingHost)) return existingHost;
  const h = hostnameOf(baseUrl);
  if (h === null) return "local";
  return (ownAddrs || getOwnAddresses()).has(h) ? "local" : "cloud";
}

/** The one veto `host` still carries. Reads the own id only for id-shaped hosts. */
export function isForeignInstanceHost(host, ownInstanceIdFn) {
  if (!isInstanceIdShape(host)) return false;
  return host !== ownInstanceIdFn();
}

/** Spec §3.4 scope: bundle, owned-native, local_only and disabled rows are never repaired. */
export function inRepairScope(row) {
  if (!row) return false;
  if (row.bundleId != null) return false;
  const gp = row.gpuPolicy || {};
  if (typeof gp.owner === "string" && gp.owner) return false;
  if (gp.local_only === true) return false;
  if (row.disabled) return false;
  return true;
}

function hasNonLoopback(ownAddrs) {
  for (const a of ownAddrs) {
    const c = addressClass(a);
    if (c && c !== "loopback" && c !== "linklocal") return true;
  }
  return false;
}

/** G1: an IP-literal target with a live own address of the same class. */
function judgeable(h, ownAddrs) {
  if (!isIpLiteral(h)) return false;
  const cls = addressClass(h);
  if (!cls || cls === "loopback" || cls === "linklocal") return false;
  for (const a of ownAddrs) if (addressClass(a) === cls) return true;
  return false;
}

/**
 * The host this row should be repaired to, or null (spec §3.4). Pure.
 */
export function repairHostDecision(row, { ownInstanceId, ownAddrs }) {
  if (!inRepairScope(row)) return null;
  if (!ownInstanceId || row.instance_id !== ownInstanceId) return null;      // D3
  const cur = row.host;
  if (isValidHost(cur) && cur !== "local") return null;
  const h = hostnameOf(row.baseUrl);
  if (cur === "local" && (h === null || !isIpLiteral(h) || ownAddrs.has(h))) return null; // G2 / own
  const next = inferHost(row.baseUrl, null, { ownAddrs });
  if (next === cur) return null;
  if (next === "cloud" && (!hasNonLoopback(ownAddrs) || !judgeable(h, ownAddrs))) return null; // G1
  return next;
}

/** Dashboard badge text for a provider row. Display only. */
export function hostLabel(p, { ownAddrs, ownInstanceId, instanceNames }) {
  const host = p?.host;
  const h = hostnameOf(p?.baseUrl);
  const away = () => (isPrivateHost(h) ? { kind: "network", text: "network" } : { kind: "cloud", text: "cloud" });
  if (host === "local") return h === null || ownAddrs.has(h) ? { kind: "this", text: "this machine" } : away();
  if (host === "cloud") return h !== null && isPrivateHost(h) ? { kind: "network", text: "network" } : { kind: "cloud", text: "cloud" };
  if (isInstanceIdShape(host)) {
    if (host === ownInstanceId) return { kind: "this", text: "this machine" };
    return { kind: "instance", text: instanceNames?.get(host) || host.slice(0, 18) };
  }
  return { kind: "invalid", text: String(host ?? "").slice(0, 18) };
}
