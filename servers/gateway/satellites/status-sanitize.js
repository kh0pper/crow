/**
 * The satellite's GET status body, cut down to what crow uses (SAT-5 review M1). The answer is
 * signed, but a compromised satellite still controls its content: only whitelisted fields of
 * the right type and size are stored in last_status_json, and everything that reads them
 * (cards, toolsState, the Nest) only ever sees this shape.
 */
import { isSatelliteId } from "../../shared/satellite-protocol.js";

const BUNDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const TOOL_ERRORS = new Set(["tools_too_large", "tools_unavailable"]);
const MEM_KEYS = ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"];
export const MAX_INSTALLED = 128;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v, max = Number.MAX_SAFE_INTEGER) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const str = (v, max) => (typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

export function sanitizeStatus(raw) {
  const s = isObj(raw) ? raw : {};
  const out = {
    satellite_id: isSatelliteId(s.satellite_id) ? s.satellite_id : null,
    agent_protocol: Number.isSafeInteger(s.agent_protocol) && s.agent_protocol >= 0 && s.agent_protocol < 1000 ? s.agent_protocol : null,
    sha: typeof s.sha === "string" && SHA40.test(s.sha) ? s.sha : null,
    cert: isObj(s.cert) ? { serial: str(s.cert.serial, 64), expires_at: str(s.cert.expires_at, 40) } : null,
    mem: isObj(s.mem) ? Object.fromEntries(MEM_KEYS.map((k) => [k, num(s.mem[k])])) : null,
    psi_memory_some_avg10: num(s.psi_memory_some_avg10, 100),
    disk_free_bytes: num(s.disk_free_bytes),
    uptime_s: Number.isSafeInteger(s.uptime_s) && s.uptime_s >= 0 ? s.uptime_s : null,
    installed: [],
    tools: {},
  };
  if (Array.isArray(s.installed)) {
    const seen = new Set();
    for (const b of s.installed) {
      if (out.installed.length >= MAX_INSTALLED) break;
      const id = isObj(b) ? b.id : b;
      if (typeof id !== "string" || !BUNDLE_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.installed.push({ id, version: isObj(b) ? str(b.version, 64) : null });
    }
  }
  if (isObj(s.tools)) {
    let n = 0;
    for (const [id, t] of Object.entries(s.tools)) {
      if (n >= MAX_INSTALLED) break;
      if (!BUNDLE_RE.test(id) || !isObj(t)) continue;
      const version = str(t.version, 64);
      if (typeof t.sha256 === "string" && SHA64.test(t.sha256)) out.tools[id] = { version, sha256: t.sha256 };
      else out.tools[id] = { version, error: TOOL_ERRORS.has(t.error) ? t.error : "tools_unavailable" };
      n += 1;
    }
  }
  return out;
}
