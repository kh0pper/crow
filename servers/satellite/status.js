/**
 * `GET /satellite/v1/status` body (SAT-3, spec §8 Servers card): identity, version, cert, memory
 * (/proc/meminfo, bytes), memory PSI (/proc/pressure/memory "some avg10", percent), free disk
 * under SAT_HOME (statfs), host uptime, the installed bundles and each bundle's cached tool-list hash. Never more than 64 KiB: the
 * installed list is cut (installed_truncated: true) if it would not fit. All readers injectable.
 */
import { readFileSync, statfsSync } from "node:fs";
import { uptime as osUptime } from "node:os";
import { AGENT_PROTOCOL } from "../shared/satellite-protocol.js";

export const STATUS_MAX_BYTES = 64 * 1024;
const MEM_KEYS = ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"];

export function readTextOrNull(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** The four fields in bytes (meminfo is in kB); a missing field is null. */
export function parseMeminfo(text) {
  const out = Object.fromEntries(MEM_KEYS.map((k) => [k, null]));
  for (const line of String(text || "").split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m && MEM_KEYS.includes(m[1])) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

export function parsePsiSomeAvg10(text) {
  const m = /^some\s+avg10=([\d.]+)/m.exec(String(text || ""));
  return m ? Number(m[1]) : null;
}

export function collectStatus({
  satelliteId, sha, cert, installed = [], tools = {}, satHome = ".",
  readText = readTextOrNull, statfs = statfsSync, uptime = osUptime,
}) {
  let disk = null;
  try { const s = statfs(satHome); disk = Number(s.bavail) * Number(s.bsize); } catch { disk = null; }
  const status = {
    satellite_id: satelliteId,
    agent_protocol: AGENT_PROTOCOL,
    sha: sha || null,
    cert: cert?.payload ? { serial: cert.payload.serial, expires_at: cert.payload.expires_at } : null,
    mem: parseMeminfo(readText("/proc/meminfo")),
    psi_memory_some_avg10: parsePsiSomeAvg10(readText("/proc/pressure/memory")),
    disk_free_bytes: Number.isFinite(disk) ? disk : null,
    uptime_s: Math.floor(Number(uptime()) || 0),
    installed: installed.map((b) => ({ id: String(b.id), version: b.version == null ? null : String(b.version) })),
    // tool_cache per bundle (§7.3, §9.1): crow pins the sha256 of each bundle's cached tools/list.
    tools: Object.fromEntries(Object.entries(tools || {}).map(([id, t]) => [String(id), { version: t?.version == null ? null : String(t.version), sha256: String(t?.sha256 || "") }])),
  };
  const size = () => Buffer.byteLength(JSON.stringify(status));
  if (size() > STATUS_MAX_BYTES) {
    status.installed_truncated = true;
    while (status.installed.length && size() > STATUS_MAX_BYTES) {
      status.installed.length = Math.floor((status.installed.length * STATUS_MAX_BYTES) / size());
    }
    if (size() > STATUS_MAX_BYTES) { status.tools = {}; status.tools_truncated = true; }
  }
  return status;
}
