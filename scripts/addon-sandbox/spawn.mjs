/**
 * The walled spawn of one stdio MCP add-on: the mode decision, the command line
 * the wall runs, and everything the spawn owns (the egress relay, the door
 * token, the bind fds) with one cleanup for all of it.
 *
 * Two exports:
 *  - `addonWallMode` decides BETWEEN "walled" and "unwalled" from the gateway's
 *    env and `<CROW_HOME>/addon-walls.json` only. Nothing the add-on can write
 *    is consulted: not its data folder, not crow.db, not the child env.
 *  - `wrapAddonSpawn` builds a walled spawn. It never decides the mode: it is
 *    called only when the mode is "walled", and it fails CLOSED. Every error
 *    while building the wall (the plan, a bind fd, the relay, the seccomp file,
 *    the probe) closes what was opened, removes the relay dir, clears the token
 *    and throws `AddonWallRefused`. A caller never falls back to an unwalled
 *    spawn after a walled attempt.
 *
 * The child fd layout of a walled spawn:
 *   0,1,2 stdio; 3 the seccomp program (`--seccomp 3`, "ignore" when the arch
 *   has no filter table); 4 the info pipe (`--info-fd 4`); 5.. the plan's fds.
 * The add-on itself inherits exactly 0, 1 and 2: bwrap consumes its own fds,
 * and the in-namespace entry (`pi_netns_entry.mjs`) hands the command only the
 * three the wall names.
 */
import { closeSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADDON_DOORS, clearAddonDoorToken, doorPredicateFor, mintAddonDoorToken } from "../../servers/shared/addon-doors.js";
import { wallModeOverride } from "../../servers/shared/addon-walls-file.js";
import { createEgressRelay } from "../pi-bots/pi_egress.mjs";
import { probePiSandbox, scrubSandboxEnv } from "../pi-bots/pi_sandbox.mjs";
import { buildSeccompProgram, seccompSupported } from "../pi-bots/pi_seccomp.mjs";
import { isLoopbackHost } from "./profile.mjs";
import { wallChildEnv, wallResiduals } from "./wall-env.mjs";
import { buildAddonPlan } from "./plan.mjs";

/** The in-namespace entry the walled command runs first. */
const NETNS_ENTRY = fileURLToPath(new URL("../pi-bots/pi_netns_entry.mjs", import.meta.url));
/** An add-on id is one lowercase slug; it names folders and a relay dir. */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Where the door token appears inside the wall (bind DATA, never a host file). */
const DOOR_TOKEN_MOUNT = "/run/crow-addon/door-token";
/** bwrap reads the seccomp program here; bwrap's info pipe is the next fd. */
const SECCOMP_CHILD_FD = 3;
const INFO_CHILD_FD = 4;
/** The proxy variables the wall always decides for itself. */
const PROXY_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
];
/** The reason `probePiSandbox` gives when there is no bwrap binary at all. */
const BWRAP_MISSING_PREFIX = "bubblewrap (bwrap) is not installed";
/** The reason strings the mode decision hands a status surface. */
const KILL_SWITCH_REASON = "walls switched off by the operator (CROW_ADDON_WALLS=off)";
const DEFAULT_OFF_REASON = "walls are off on this computer";
const OWNER_REASON = "your choice";

/** A wall that could not be built: the add-on stays OFF. */
export class AddonWallRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "AddonWallRefused";
  }
}

/** `err` as an AddonWallRefused, keeping a message that already says "add-on refused". */
function asRefused(err) {
  if (err instanceof AddonWallRefused) return err;
  const text = err && typeof err.message === "string" && err.message ? err.message : "the wall could not be built";
  return new AddonWallRefused(/^add-on refused/.test(text) ? text : "add-on refused: " + text);
}

/**
 * Whether one add-on runs walled on this computer.
 *
 * The precedence, from the GATEWAY's env and the wall file only:
 *  1. `CROW_ADDON_WALLS=off` — the operator's kill switch;
 *  2. `CROW_ADDON_WALLS_DEFAULT` is not "walled" — the per-host default, off in
 *     this release;
 *  3. the owner's `"unwalled"` choice for this id in `addon-walls.json`;
 *  4. walled.
 * A missing, unreadable or corrupt wall file reads as no choice at all, so it
 * can never unwall anything.
 *
 * @returns {{mode: "walled"|"unwalled", reason: string|null, source: "kill-switch"|"default"|"owner"|"walled"}}
 */
export function addonWallMode({ id, gatewayEnv = process.env, crowHome } = {}) {
  const env = gatewayEnv && typeof gatewayEnv === "object" ? gatewayEnv : {};
  if (env.CROW_ADDON_WALLS === "off") {
    return { mode: "unwalled", reason: KILL_SWITCH_REASON, source: "kill-switch" };
  }
  if (env.CROW_ADDON_WALLS_DEFAULT !== "walled") {
    return { mode: "unwalled", reason: DEFAULT_OFF_REASON, source: "default" };
  }
  let override = null;
  try {
    override = wallModeOverride(crowHome, id);
  } catch {
    override = null; // an unreadable file is no choice: fail closed
  }
  if (override === "unwalled") {
    return { mode: "unwalled", reason: OWNER_REASON, source: "owner" };
  }
  return { mode: "walled", reason: null, source: "walled" };
}

/**
 * Write a seccomp program to an already-unlinked temp file and return its read
 * fd: nothing is left on disk for anyone to find, and the fd is the only way to
 * the bytes. The dir is removed either way.
 */
function openSeccompProgram(build, tmpdirFn) {
  const dir = mkdtempSync(join(tmpdirFn(), "crow-addon-seccomp-" + process.pid + "-"));
  const file = join(dir, "filter.bpf");
  let fd = null;
  try {
    writeFileSync(file, build(), { mode: 0o600 });
    fd = openSync(file, "r");
    unlinkSync(file);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  return fd;
}

/**
 * Build a walled spawn for one add-on.
 *
 * `deps` is a test seam; production passes nothing and gets the real modules.
 * The caller decides the mode (see `addonWallMode`) and calls this only for
 * "walled".
 *
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.command
 * @param {string[]} o.args
 * @param {object} [o.baseEnv]        the gateway's env: read ONLY through the wall's allowlist and the
 *                                    manifest's declared keys (wall-env.mjs), never spread
 * @param {object} [o.ownEnv]         the add-on's own env (entry env, connection values, derived keys)
 * @param {"addon"|"service"|"builtin"} [o.envKind] which env rule applies (wall-env.mjs): only a
 *                                    bundle add-on takes declared keys from the gateway env
 * @param {object} o.profile          `deriveProfile`'s output
 * @param {object} o.entry            the add-on's registry entry
 * @param {string} o.crowHome
 * @param {string} o.dataDir
 * @param {string} o.appRoot
 * @param {string} o.home
 * @param {string} o.nodeBin
 * @param {number} o.gatewayPort
 * @param {string} [o.installDir]
 * @param {string} [o.dataSubdir]
 * @param {{names: string[], addrs: string[]}} [o.selfTargets]
 * @param {Function} [o.listenerOwner]
 * @param {Function} [o.containerOwner]
 * @param {object} [o.deps] { probe, buildPlan, createRelay, seccompSupported, buildSeccompProgram, mintToken, clearToken, tmpdir }
 * @returns {Promise<object>} a WallResult
 * @throws {AddonWallRefused}
 */
export async function wrapAddonSpawn(o = {}) {
  const deps = o.deps && typeof o.deps === "object" ? o.deps : {};
  const id = o.id;
  if (typeof id !== "string" || !ADDON_ID_RE.test(id)) {
    throw new AddonWallRefused("add-on refused: invalid add-on id");
  }

  // The child env is the wall's own build, whatever env the spawn site holds:
  // an allowlisted slice of the gateway env, the declared keys, the add-on's own.
  // The env rule: a caller that names none gets the NARROWEST one (no declared or
  // storage passthrough); a name that is not one of the three is a refusal.
  const envKind = o.envKind === undefined || o.envKind === null ? "service" : o.envKind;
  if (!["addon", "service", "builtin"].includes(envKind)) {
    throw new AddonWallRefused("add-on refused: unknown spawn kind");
  }
  const childEnv = wallChildEnv({ id, kind: envKind, baseEnv: o.baseEnv, ownEnv: o.ownEnv });

  let probe;
  try {
    probe = typeof deps.probe === "function" ? deps.probe() : probePiSandbox();
  } catch (err) {
    throw asRefused(err);
  }

  // No usable bwrap: no wall, and say so. `setpriv --no-new-privs` still keeps
  // sudo and setuid binaries out of reach; without that either, the child is
  // plain. This is the one branch that returns `walled: false`, and only for a
  // probe that says bwrap is not installed at all: a bwrap that is present but
  // cannot start a sandbox here (a refused user namespace, a blocked binary, a
  // probe that timed out) is a refusal, never a weaker tier.
  if (!probe || probe.ok !== true) {
    const reason = probe && typeof probe.reason === "string" ? probe.reason : null;
    const notInstalled = reason !== null && reason.startsWith(BWRAP_MISSING_PREFIX);
    if (!notInstalled) {
      throw new AddonWallRefused(
        "add-on refused: bwrap is installed but cannot start a sandbox here ("
        + (reason || "the probe gave no reason")
        + ")",
      );
    }
    if (probe.setpriv) {
      return {
        walled: false,
        tier: "nnp",
        cmd: probe.setpriv,
        args: ["--no-new-privs", o.command, ...(Array.isArray(o.args) ? o.args : [])],
        env: scrubSandboxEnv(childEnv),
        reason,
      };
    }
    return { walled: false, tier: "none", reason };
  }
  if (probe.pidns === false) {
    throw new AddonWallRefused("add-on refused: bwrap cannot make a PID namespace here");
  }

  const buildPlan = typeof deps.buildPlan === "function" ? deps.buildPlan : buildAddonPlan;
  const createRelay = typeof deps.createRelay === "function" ? deps.createRelay : createEgressRelay;
  const supportsSeccomp = typeof deps.seccompSupported === "function" ? deps.seccompSupported : seccompSupported;
  const buildProgram = typeof deps.buildSeccompProgram === "function" ? deps.buildSeccompProgram : buildSeccompProgram;
  const mintToken = typeof deps.mintToken === "function" ? deps.mintToken : mintAddonDoorToken;
  const clearToken = typeof deps.clearToken === "function" ? deps.clearToken : clearAddonDoorToken;
  const tmpdirFn = typeof deps.tmpdir === "function" ? deps.tmpdir : osTmpdir;

  const profile = o.profile && typeof o.profile === "object" ? o.profile : {};
  const net = profile.network && typeof profile.network === "object" ? profile.network : {};
  const hosts = Array.isArray(net.hosts) ? net.hosts.filter((h) => h && typeof h.host === "string") : [];
  const selfTargets = {
    names: Array.isArray(o.selfTargets?.names) ? [...o.selfTargets.names] : [],
    addrs: Array.isArray(o.selfTargets?.addrs) ? [...o.selfTargets.addrs] : [],
  };

  const stdioExtra = [];
  let relayDir = null;
  let relay = null;
  let token = null;
  let cleaned = false;

  /** Close every host fd still in `stdioExtra` (the number is dropped first). */
  function discardFds() {
    for (const entry of stdioExtra) {
      if (!Number.isInteger(entry.fd)) continue;
      const fd = entry.fd;
      entry.fd = null;
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }

  /** Everything this spawn opened, in one idempotent place. */
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    discardFds();
    if (relay) {
      try {
        const done = relay.close?.();
        if (done && typeof done.then === "function") done.catch(() => {});
      } catch { /* the relay may already be down */ }
    }
    if (token) {
      try { clearToken(id, token); } catch { /* nothing held */ }
    }
    if (relayDir) {
      try { rmSync(relayDir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }

  try {
    // 1. The relay socket dir, only when this add-on reaches anything.
    const needsNet = net.internet === true || hosts.length > 0;
    if (needsNet) {
      relayDir = mkdtempSync(join(tmpdirFn(), "crow-addon-net-" + process.pid + "-" + id + "-"));
    }

    // 2. The door token: only for an add-on whose own door set it is.
    const doors = Array.isArray(profile.doors) ? profile.doors : [];
    if (doors.includes(id) && Object.prototype.hasOwnProperty.call(ADDON_DOORS, id)) {
      token = mintToken(id);
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        throw new AddonWallRefused("add-on refused: the door token could not be minted");
      }
    }

    // 3. The file side of the wall.
    const plan = buildPlan({
      id,
      profile,
      entry: o.entry,
      home: o.home,
      crowHome: o.crowHome,
      appRoot: o.appRoot,
      nodeBin: o.nodeBin,
      dataDir: o.dataDir,
      gatewayPort: o.gatewayPort,
      selfTargets: [...selfTargets.names, ...selfTargets.addrs],
      relayDir,
      doorTokenFd: token ? -1 : undefined,
      fdBase: 5,
      installDir: o.installDir,
      dataSubdir: o.dataSubdir,
    });
    if (!plan || typeof plan !== "object") throw new Error("the plan is not an object");
    const planNet = plan.net && typeof plan.net === "object" ? plan.net : null;

    // 4. The plan's own fds, registered now so that a later failure closes them.
    // The door token is bind DATA: it travels as a pipe the gateway writes once,
    // never as a host file. A layout this spawn cannot honour (an fd where bwrap's
    // own fds go, a slot that is not a whole number, a token with nothing minted)
    // is a refusal with every plan fd closed: a silently skipped entry would leak
    // its host fd into the gateway for the life of the process.
    const planFds = Array.isArray(plan.fds) ? plan.fds : [];
    const refusePlanFds = () => {
      const closed = new Set();
      for (const entry of stdioExtra) {
        if (!Number.isInteger(entry.fd)) continue;
        const fd = entry.fd;
        entry.fd = null;
        closed.add(fd);
        try { closeSync(fd); } catch { /* already closed */ }
      }
      for (const spec of planFds) {
        if (!spec || !Number.isInteger(spec.fd) || spec.fd < 0 || closed.has(spec.fd)) continue;
        closed.add(spec.fd);
        try { closeSync(spec.fd); } catch { /* already closed */ }
      }
      throw new AddonWallRefused("add-on refused: the plan's fd layout cannot be passed to the wall");
    };
    for (const spec of planFds) {
      if (!spec || typeof spec !== "object") continue;
      if (!Number.isInteger(spec.childFd)) refusePlanFds();
      if (spec.childFd === SECCOMP_CHILD_FD || spec.childFd === INFO_CHILD_FD) refusePlanFds();
      if (spec.role === "door-token") {
        if (!token) refusePlanFds();
        stdioExtra.push({ childFd: spec.childFd, pipe: "write", role: "door-token", data: token });
        continue;
      }
      if (!Number.isInteger(spec.fd) || spec.fd < 0) refusePlanFds();
      stdioExtra.push({ childFd: spec.childFd, fd: spec.fd, role: spec.role });
    }

    // 5. The relay, hosted in this process, for the lifetime of the spawn.
    if (planNet && planNet.sock) {
      const loopback = [];
      const plainHttpHosts = [];
      const listed = [];
      for (const h of hosts) {
        const port = Number(h.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (isLoopbackHost(h.host)) loopback.push({ port, source: h.source === "owner" ? "owner" : "default" });
        else if (h.scheme === "http") plainHttpHosts.push({ host: h.host, port });
        else listed.push({ host: h.host, port });
      }
      relay = createRelay({
        dir: relayDir,
        botId: "addon:" + id,
        gatewayPort: o.gatewayPort,
        egressPorts: [443],
        addon: {
          id,
          isDoor: token ? doorPredicateFor(id) : () => false,
          internet: net.internet === true,
          loopback,
          hosts: listed,
          plainHttpHosts,
          selfTargets,
          listenerOwner: o.listenerOwner,
          containerOwner: o.containerOwner,
        },
      });
      if (!relay || typeof relay !== "object" || typeof relay.close !== "function") {
        throw new Error("the egress relay did not start");
      }
    }

    // 6. The seccomp program, on an already-unlinked fd (bwrap reads it there).
    const withSeccomp = supportsSeccomp() === true;
    let seccompFd = null;
    if (withSeccomp) {
      seccompFd = openSeccompProgram(buildProgram, tmpdirFn);
      if (!Number.isInteger(seccompFd)) throw new Error("the seccomp filter could not be handed to the sandbox");
      stdioExtra.push({ childFd: SECCOMP_CHILD_FD, fd: seccompFd, role: "seccomp" });
    }
    const tier = withSeccomp ? "walled" : "walled-noseccomp";

    // 7. The info pipe (`--info-fd`): bwrap writes the child's pid and exit
    // status there, and the plan's fds sit above it.
    stdioExtra.push({ childFd: INFO_CHILD_FD, pipe: "read", role: "info" });

    // 8. The command line: the plan, then bwrap's own fds, then the entry that
    // hands the add-on exactly fds 0, 1 and 2.
    const ports = planNet && Array.isArray(planNet.ports) ? planNet.ports : [];
    const inner = [
      o.nodeBin,
      NETNS_ENTRY,
      ...(planNet && planNet.sock
        ? ["--sock", planNet.sock, "--ports", ports.join(","), "--proxy-port", String(planNet.proxyPort)]
        : []),
      "--fds", "0,1,2",
      "--",
      o.command,
      ...(Array.isArray(o.args) ? o.args : []),
    ];
    const args = [
      ...(Array.isArray(plan.args) ? plan.args : []),
      ...(withSeccomp ? ["--seccomp", String(SECCOMP_CHILD_FD)] : []),
      "--info-fd", String(INFO_CHILD_FD),
      "--",
      ...inner,
    ];

    // 9. The env: the plan's own, never the gateway's proxy or token settings.
    const env = { ...childEnv };
    for (const name of Array.isArray(plan.unsetEnv) ? plan.unsetEnv : []) delete env[name];
    for (const name of PROXY_VARS) delete env[name];
    for (const name of Object.keys(env)) if (name.startsWith("CROW_ADDON_DOOR")) delete env[name];
    const scrubbed = scrubSandboxEnv(env);
    Object.assign(scrubbed, plan.env && typeof plan.env === "object" ? plan.env : {});
    if (token) scrubbed.CROW_ADDON_DOOR_TOKEN_FILE = DOOR_TOKEN_MOUNT;

    return {
      walled: true,
      tier,
      cmd: probe.bwrap,
      args,
      env: scrubbed,
      stdioExtra,
      relay,
      profile,
      refused: Array.isArray(plan.refused) ? plan.refused : [],
      // What this add-on still reaches beyond its wall (LEDGER N1b-13 storage).
      residuals: wallResiduals({ id, kind: envKind }),
      discardFds,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw asRefused(err);
  }
}