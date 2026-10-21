/**
 * The per-instance skill on/off list (skills panel option C, PR 2).
 *
 * Stored in <CROW_HOME>/skill-state.json, next to skill-installs.json and
 * outside skills/ so the resolver and Bot Builder never list it. Per instance
 * by design (owner decision Q1): instances have different extensions and bots. Not in
 * the DB because every reader that must honour it (the skill resolver, the
 * pibot bridge, job runs, voice bots, the report CLI) is DB-free.
 *
 *   { "version": 1, "off": ["media"], ... }   (other keys are kept as they are)
 *
 * Readers FAIL OPEN: a missing or garbled file switches nothing off (the
 * opposite would silently strip every bot's skills). Writers refuse to rewrite
 * a garbled file, so a bad edit is never replaced by an empty list.
 * One writer per home (that instance's gateway); each read-modify-write is
 * synchronous, and atomicWrite gives other processes whole files.
 *
 * node: imports only — scripts/pi-bots/skill_resolver.mjs loads it.
 */
import { readFileSync, existsSync, writeFileSync, renameSync, chmodSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const SKILL_STATE_FILE = "skill-state.json";

/** The resolver's name rule (skill_proposals.mjs normalizeSkillName): kebab, ≤ 80, ".md" dropped. */
export function skillStateName(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (s.endsWith(".md")) s = s.slice(0, -3);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s) || s.length > 80) return null;
  return s;
}

const statePath = (crowHome) => join(crowHome, SKILL_STATE_FILE);

// Fail-open must be visible in the journal: warn once per file version
// (path + mtime), not on every read (the resolver reads it per spawn).
const warnedFor = new Map();
function warnUnreadable(p) {
  let mtime = 0;
  try { mtime = statSync(p).mtimeMs; } catch { /* gone meanwhile */ }
  if (warnedFor.get(p) === mtime) return;
  warnedFor.set(p, mtime);
  console.warn(`[skills] ${p}: skill-state.json can't be read; every skill is treated as on until it is fixed or removed`);
}

/** @returns {{ ok: boolean, state: { version: 1, off: string[] } }} */
export function readSkillState(crowHome) {
  const empty = { version: 1, off: [] };
  const p = statePath(crowHome);
  if (!existsSync(p)) return { ok: true, state: empty };
  const bad = () => { warnUnreadable(p); return { ok: false, state: empty }; };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return bad();
    if (j.off !== undefined && !Array.isArray(j.off)) return bad();
    const off = [...new Set((j.off || []).map(skillStateName).filter(Boolean))].sort();
    return { ok: true, state: { ...j, version: 1, off } };
  } catch {
    return bad();
  }
}

/** The names switched off on this instance (empty when the file is missing or garbled). */
export function offSkills(crowHome) {
  return new Set(readSkillState(crowHome).state.off);
}

function atomicWrite600(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

/** Switch a skill off (true) or back on (false). @returns {{ ok: true } | { ok: false, error: "invalid-name"|"unreadable" }} */
export function setSkillOff(crowHome, name, off) {
  const n = skillStateName(name);
  if (!n) return { ok: false, error: "invalid-name" };
  const { ok, state } = readSkillState(crowHome);
  if (!ok) return { ok: false, error: "unreadable" };
  const set = new Set(state.off);
  if (off) set.add(n); else set.delete(n);
  atomicWrite600(statePath(crowHome), JSON.stringify({ ...state, version: 1, off: [...set].sort() }, null, 2) + "\n");
  return { ok: true };
}

/**
 * "Keep mine" / "Keep" for a skill the Skills panel flags: recorded per
 * shipped version (`srcSha`, or null for a skill no longer shipped), so the
 * flag comes back when the extension ships another version.
 * @returns {{ ok: true } | { ok: false, error: "invalid-name"|"unreadable" }}
 */
export function ackSkill(crowHome, file, srcSha) {
  const n = skillStateName(file);
  if (!n) return { ok: false, error: "invalid-name" };
  const { ok, state } = readSkillState(crowHome);
  if (!ok) return { ok: false, error: "unreadable" };
  const ack = state.ack && typeof state.ack === "object" && !Array.isArray(state.ack) ? { ...state.ack } : {};
  ack[n + ".md"] = { srcSha: typeof srcSha === "string" ? srcSha : null, at: new Date().toISOString() };
  atomicWrite600(statePath(crowHome), JSON.stringify({ ...state, version: 1, ack }, null, 2) + "\n");
  return { ok: true };
}
