/**
 * Port inventory — builds the runtime port table for the Settings → System
 * "Ports" section. Pure parsers + attribution are exported for unit testing;
 * thin fs/exec wiring composes them. Read-only (no mutation) in v1.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileP = promisify(execFile);
const CROW_HOME = process.env.CROW_HOME || join(homedir(), ".crow");
const BUNDLES_DIR = join(CROW_HOME, "bundles");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");

/** Core Crow services: shown, never bundle-attributed. */
export function coreServices() {
  return new Map([[parseInt(process.env.PORT || "3001", 10), "Crow gateway"]]);
}

function classifyHostPort(seg) {
  if (/^\d+$/.test(seg)) return { port: parseInt(seg, 10), portEnvVar: null };
  let m = seg.match(/^\$\{([A-Za-z_]\w*):-(\d+)\}$/);
  if (m) return { port: parseInt(m[2], 10), portEnvVar: m[1] };
  m = seg.match(/^\$\{([A-Za-z_]\w*)\}$/);
  if (m) return { port: null, portEnvVar: m[1] };
  return null;
}

function classifyBind(seg) {
  if (seg == null) return { bind: "0.0.0.0", bindKind: "all" };
  if (seg === "0.0.0.0" || seg === "::" || seg === "[::]") return { bind: "0.0.0.0", bindKind: "all" };
  if (seg === "127.0.0.1" || seg === "::1" || seg === "[::1]") return { bind: seg, bindKind: "loopback" };
  let m = seg.match(/^\$\{([A-Za-z_]\w*):-([^}]+)\}$/);
  if (m) {
    const def = m[2];
    if (def === "127.0.0.1" || def === "::1") return { bind: def, bindKind: "loopback" };
    if (def === "0.0.0.0") return { bind: def, bindKind: "all" };
    return { bind: def, bindKind: "specific" };
  }
  if (/^\$\{[A-Za-z_]\w*\}$/.test(seg)) return { bind: seg, bindKind: "template" };
  return { bind: seg, bindKind: "specific" };
}

function parseMapping(str) {
  let proto = "tcp";
  const pm = str.match(/\/(tcp|udp)$/i);
  if (pm) { proto = pm[1].toLowerCase(); str = str.slice(0, pm.index); }
  // Mask ${...} so its internal ':' doesn't break the split.
  const toks = [];
  const masked = str.replace(/\$\{[^}]*\}/g, (m) => { toks.push(m); return ` ${toks.length - 1} `; });
  const unmask = (x) => x.replace(/ (\d+) /g, (_, i) => { const n = Number(i); return n < toks.length ? toks[n] : ` ${i} `; });
  const segs = masked.split(":").map(unmask);
  if (segs.length < 2) return null;
  const hostSeg = segs[segs.length - 2];
  const bindSeg = segs.length >= 3 ? segs[0] : null;
  const hp = classifyHostPort(hostSeg);
  if (!hp) return null;
  const b = classifyBind(bindSeg);
  return { port: hp.port, portEnvVar: hp.portEnvVar, bind: b.bind, bindKind: b.bindKind, proto };
}

/**
 * Parse ALL published host-port mappings from a docker-compose.yml.
 * Limitation (acceptable for v1 — no current bundle uses these): bracketed IPv6
 * binds (`[::1]:8080:80`) and port ranges (`8000-8010:8000-8010`) are not parsed
 * and are silently skipped; revisit if a bundle adopts either form; the inline-array
 * `ports: ["8080:80"]` form is also skipped.
 * @returns {Array<{port:number|null, portEnvVar:string|null, bind:string, bindKind:string, proto:string}>}
 *   `port` is null only when the host port is an env var with no default (e.g.
 *   `${VAR}`); callers must tolerate null (such entries carry no usable port).
 */
export function parseComposeHostPorts(text) {
  const lines = text.split("\n");
  let inPorts = false;
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (/^\s*ports:\s*$/.test(line)) { inPorts = true; continue; }
    if (!inPorts) continue;
    const item = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
    if (!item) { if (line.trim() && !/^\s*-/.test(line)) inPorts = false; continue; }
    const parsed = parseMapping(item[1].trim());
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Parse `ss -tlnH` output into [{port, boundAddr}] (one per LISTEN row). */
export function parseSsListeners(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const local = f[3];
    const i = local.lastIndexOf(":");
    if (i < 0) continue;
    const port = parseInt(local.slice(i + 1), 10);
    if (!Number.isInteger(port)) continue;
    out.push({ port, boundAddr: local.slice(0, i) });
  }
  return out;
}

/** Normalize an ss bound address to an overlap identity (wildcard-aware). */
function addrId(a) {
  if (a == null) return "*";
  const s = String(a).replace(/%.*$/, ""); // strip %iface (e.g. 127.0.0.53%lo)
  if (s === "0.0.0.0" || s === "::" || s === "[::]" || s === "*") return "*";
  if (s === "::1" || s === "[::1]") return "::1";
  return s;
}
const overlap = (x, y) => x === "*" || y === "*" || x === y;

/**
 * Build one row per port. STATUS is "up" when the port has any ss listener
 * (correct even for tailscale-bound bundles whose resolved addr can't be
 * predicted from the compose template). CONFLICT is flagged only when 2+
 * LISTENERS on the same port have overlapping addresses (a genuine OS
 * double-bind); two listeners on different specific addrs (the :8004 case) do
 * not overlap. Multiple bundles merely declaring a port -> `shared` (info).
 * Foreign listeners -> informational. The displayed bound address is the actual
 * ss address when listening, else the declared bind.
 *
 * @param {Array<{bundleId,bundleName,port:number,bind:string,bindKind:string,proto:string,source:string,portEnvVar?:string}>} endpoints
 * @param {Array<{port:number,boundAddr:string}>} listeners
 * @param {Map<number,string>} coreSet
 */
export function attributeAndDetect(endpoints, listeners, coreSet) {
  const ports = new Set([
    ...endpoints.map((e) => e.port).filter((p) => p != null),
    ...listeners.map((l) => l.port),
    ...coreSet.keys(),
  ]);
  const rows = [];
  for (const port of ports) {
    const eps = endpoints.filter((e) => e.port === port);
    const lis = listeners.filter((l) => l.port === port);
    const listening = lis.length > 0;
    // Conflict = two listeners on this port whose addresses overlap.
    let conflict = false;
    for (let i = 0; i < lis.length && !conflict; i++) {
      for (let j = i + 1; j < lis.length; j++) {
        if (overlap(addrId(lis[i].boundAddr), addrId(lis[j].boundAddr))) { conflict = true; break; }
      }
    }
    const liveAddr = [...new Set(lis.map((l) => l.boundAddr))].join(", ") || null;

    if (eps.length) {
      const bundleIds = [...new Set(eps.map((e) => e.bundleId))];
      const declaredBind = [...new Set(eps.map((e) => e.bind))].join(", ");
      const isManaged = eps.every((e) => e.source === "manifest");
      rows.push({
        port,
        bundleId: bundleIds.join(", "),
        bundleName: [...new Set(eps.map((e) => e.bundleName))].join(" / "),
        declaredBind,
        boundAddr: listening ? liveAddr : declaredBind,
        kind: isManaged ? "managed" : (eps.some((e) => e.portEnvVar) ? "parameterized" : "hardcoded"),
        listening,
        status: listening ? "up" : "down",
        shared: bundleIds.length > 1,
        conflict,
        conflictReason: conflict ? `Port ${port} has multiple overlapping listeners` : null,
      });
    } else if (coreSet.has(port)) {
      rows.push({
        port, bundleId: null, bundleName: coreSet.get(port), declaredBind: null,
        boundAddr: liveAddr, kind: "core", listening, status: listening ? "up" : "down",
        shared: false, conflict, conflictReason: conflict ? `Port ${port} has multiple overlapping listeners` : null,
      });
    } else {
      rows.push({
        port, bundleId: null, bundleName: null, declaredBind: null,
        boundAddr: liveAddr, kind: "foreign", listening: true, status: "up",
        shared: false, conflict, conflictReason: conflict ? `Port ${port} has multiple overlapping listeners` : null,
      });
    }
  }
  rows.sort((a, b) => a.port - b.port);
  return rows;
}

/** Read installed bundle ids and their declared endpoints from ~/.crow/bundles. */
export function listInstalledBundles() {
  if (!existsSync(INSTALLED_PATH)) return [];
  let installed;
  try { installed = JSON.parse(readFileSync(INSTALLED_PATH, "utf8")); } catch { return []; }
  if (!Array.isArray(installed)) return [];

  const endpoints = [];
  for (const entry of installed) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!id) continue;
    const dir = join(BUNDLES_DIR, id);
    const composePath = join(dir, "docker-compose.yml");
    const manifestPath = join(dir, "manifest.json");

    let name = id, manifestPort = null;
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (m.name) name = m.name;
        if (typeof m.port === "number") manifestPort = m.port;
      } catch { /* keep defaults */ }
    }

    let mappings = [];
    if (existsSync(composePath)) {
      mappings = parseComposeHostPorts(readFileSync(composePath, "utf8"));
      // Overlay the bundle's .env for any port-position env var (reflects config).
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) {
        const env = readFileSync(envPath, "utf8");
        for (const mp of mappings) {
          if (mp.portEnvVar) {
            const em = env.match(new RegExp(`^${mp.portEnvVar}=(\\d+)\\s*$`, "m"));
            if (em) mp.port = parseInt(em[1], 10);
          }
        }
      }
    }

    if (mappings.length) {
      for (const mp of mappings) {
        endpoints.push({ bundleId: id, bundleName: name, port: mp.port, bind: mp.bind, bindKind: mp.bindKind, proto: mp.proto, portEnvVar: mp.portEnvVar, source: "compose" });
      }
    } else if (manifestPort != null) {
      // Containerless / orchestrator-managed: attribute by manifest port only.
      endpoints.push({ bundleId: id, bundleName: name, port: manifestPort, bind: "0.0.0.0", bindKind: "all", proto: "tcp", portEnvVar: null, source: "manifest" });
    }
  }
  return endpoints;
}

/** Run `ss -tlnH`; empty array if unavailable. */
export async function readListeners() {
  try {
    const { stdout } = await execFileP("ss", ["-tlnH"], { timeout: 5000 });
    return parseSsListeners(stdout);
  } catch { return []; }
}

let _cache = null; // { at:number, rows }
/** Build the inventory; `ttlMs`>0 returns a recent cached result (for getPreview). */
export async function buildPortInventory({ ttlMs = 0, now = 0 } = {}) {
  if (ttlMs > 0 && _cache && now - _cache.at < ttlMs) return _cache.rows;
  const rows = attributeAndDetect(listInstalledBundles(), await readListeners(), coreServices());
  if (ttlMs > 0) _cache = { at: now, rows };
  return rows;
}
