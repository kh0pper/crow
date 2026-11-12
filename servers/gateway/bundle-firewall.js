/**
 * Tailnet firewall rules for a bundle's published ports.
 *
 * Install used to run `ufw allow from 100.64.0.0/10 ...` for EVERY manifest port,
 * unconditionally: on a box without Tailscale the rule is meaningless noise, and for a
 * port the bundle publishes on 127.0.0.1 only there is nothing on the tailnet to reach
 * — a rule for it is at best dead weight and at worst suggests an exposure that does not
 * exist. The decision is made here, with pure injectable helpers so the tests never touch
 * sudo or ufw.
 *
 * Rules are scoped to the tailnet interface (`in on tailscale0`) so the same port is not
 * opened on a LAN interface too. The unscoped rule an install from before this change may
 * have left behind is removed best-effort on open (before adding, and before skipping a
 * loopback-only port) and again on uninstall.
 */

import os from "node:os";

const TAILNET_NAME = "tailscale0";
const TAILNET_CIDR = "100.64.0.0/10";

/** CGNAT tailnet IPv4: 100.64.0.0/10 — 100.64.x.x through 100.127.x.x. */
const TAILNET_V4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/\d{1,3})?$/;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * True only when this machine has a tailnet interface with a non-internal tailnet IPv4
 * address — i.e. Tailscale is actually up. An `interfaces` value may be injected (a plain
 * `os.networkInterfaces()` shape) so the caller can avoid re-reading the host's list.
 */
export function tailscaleUp(interfaces = os.networkInterfaces()) {
  const list = interfaces?.[TAILNET_NAME];
  if (!Array.isArray(list)) return false;
  return list.some((addr) => {
    if (!addr || typeof addr !== "object") return false;
    if (addr.internal === true) return false; // internal, or unspecified, is not proof of an up tailnet
    if (addr.family !== "IPv4" && addr.family !== 4) return false;
    const m = String(addr.address || "").match(TAILNET_V4);
    if (!m) return false;
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  });
}

function normalizeHost(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/**
 * True only when EVERY compose mapping that publishes `port` (tcp, or no protocol, since
 * tcp is the default) binds to loopback. A mixed set, a wildcard host, an unpublished
 * port, or a model we could not read (null) all mean "not provably loopback", so the
 * caller keeps the tailnet rule: unknown is never treated as loopback.
 */
export function portLoopbackOnly(model, port) {
  if (!model || typeof model !== "object") return false;
  const services = model.services;
  if (!services || typeof services !== "object") return false;
  const want = String(port);
  const matches = [];
  for (const svc of Object.values(services)) {
    const mappings = Array.isArray(svc?.ports) ? svc.ports : [];
    for (const m of mappings) {
      if (!m || typeof m !== "object") continue;
      if (m.published === null || m.published === undefined) continue;
      const proto = m.protocol === null || m.protocol === undefined ? "tcp" : String(m.protocol).toLowerCase();
      if (proto !== "tcp") continue;
      if (String(m.published) !== want) continue;
      matches.push(m);
    }
  }
  if (matches.length === 0) return false;
  return matches.every((m) => LOOPBACK_HOSTS.has(normalizeHost(m.host_ip)));
}

/** The ufw argv (run as sudo) that opens `port` to the tailnet only. */
export function tailnetRuleArgs(port, name) {
  return [
    "-n", "ufw", "allow", "in", "on", TAILNET_NAME, "from", TAILNET_CIDR,
    "to", "any", "port", String(port), "proto", "tcp",
    "comment", `Crow: ${name}`,
  ];
}

/**
 * The two ufw argv (run as sudo) that remove `port`'s tailnet rule: the scoped one this
 * version writes, and the unscoped one an earlier install may have left behind. Each
 * fails harmlessly when the rule is not there.
 */
export function deleteRuleArgs(port) {
  const tail = ["from", TAILNET_CIDR, "to", "any", "port", String(port), "proto", "tcp"];
  return [
    ["-n", "ufw", "delete", "allow", "in", "on", TAILNET_NAME, ...tail],
    ["-n", "ufw", "delete", "allow", ...tail],
  ];
}

/**
 * Open each port to the tailnet, skipping the ones that cannot need a rule: Tailscale is
 * not running here, or the port is published on loopback only. Where the tailnet is up,
 * the legacy unscoped rule is deleted first (best-effort, its outcome is ignored).
 * `run(command, argv, opts)`
 * is injected (install passes execFileSync) and may throw; a failed add is logged, not
 * propagated — a missing ufw must never fail an install.
 * @returns {Promise<Array<{port: any, action: "added"|"skipped-no-tailscale"|"skipped-loopback"|"failed"}>>}
 */
export async function openTailnetPorts({ ports = [], name = "", model = null, interfaces, run, log = () => {} } = {}) {
  const results = [];
  const up = tailscaleUp(interfaces);
  // Best-effort removal of the unscoped rule an earlier install may have written. It is
  // never allowed to change a port's result: a failure here is just a leftover rule.
  const removeLegacyRule = async (port) => {
    try {
      await run("sudo", deleteRuleArgs(port)[1], { timeout: 10000 });
    } catch { /* no such rule, or sudo/ufw unavailable — the add/skip below still stands */ }
  };
  for (const port of ports) {
    if (!up) {
      log(`Tailscale is not running here, so no tailnet firewall rule was added for port ${port} — reinstall the app once Tailscale is up`);
      results.push({ port, action: "skipped-no-tailscale" });
      continue;
    }
    if (portLoopbackOnly(model, port)) {
      await removeLegacyRule(port);
      log(`Port ${port} listens only on this machine, so no firewall rule is needed`);
      results.push({ port, action: "skipped-loopback" });
      continue;
    }
    await removeLegacyRule(port);
    try {
      await run("sudo", tailnetRuleArgs(port, name), { timeout: 10000 });
      log(`Opened firewall port ${port}/tcp for Tailscale`);
      results.push({ port, action: "added" });
    } catch {
      log(`Note: Could not open port ${port} (sudo/ufw not available — open manually if needed)`);
      results.push({ port, action: "failed" });
    }
  }
  return results;
}

/**
 * Remove each port's tailnet rules. Both deletes are attempted independently: the scoped
 * rule may never have been written (an install from before this change), and that must
 * not stop the legacy unscoped rule from being removed.
 * @returns {Promise<Array<{port: any, action: "closed"|"failed"}>>}
 */
export async function closeTailnetPorts({ ports = [], run, log = () => {} } = {}) {
  const results = [];
  for (const port of ports) {
    let closed = false;
    for (const argv of deleteRuleArgs(port)) {
      try {
        await run("sudo", argv, { timeout: 10000 });
        closed = true;
      } catch { /* that rule was not there — try the next one */ }
    }
    if (closed) {
      log(`Closed firewall port ${port}/tcp`);
      results.push({ port, action: "closed" });
    } else {
      log(`Note: Could not close port ${port} (sudo/ufw not available)`);
      results.push({ port, action: "failed" });
    }
  }
  return results;
}