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
  const unmask = (x) => x.replace(/ (\d+) /g, (_, i) => toks[Number(i)]);
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
 * and are silently skipped; revisit if a bundle adopts either form.
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
