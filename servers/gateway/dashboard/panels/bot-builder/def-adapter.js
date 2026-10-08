/**
 * Bot Builder — definition <-> editor adapters (files, learning, "always ask
 * before", tool sources, stale-form revision).
 *
 * PRESERVE-UNLESS-CHANGED: every composite control posts its new value and
 * the value it was rendered with ("__was"). When the two are equal the
 * fields under that control are left exactly as stored — including values
 * the simplified editor can no longer express. That rule is the whole
 * migration for existing bots: nothing is rewritten until an operator
 * actually changes a control.
 */
import { createHash } from "node:crypto";
import { expandSourceMode } from "./tool-access.js";

// pi built-in tool names (pi 0.85 allToolNames: read, bash, powershell, edit,
// write, grep, find, ls). The old editor offered "list"/"glob", which pi
// does not have; a stored one is kept by the unchanged rule.
export const FILES_READ = Object.freeze(["read", "grep", "find", "ls"]);
export const FILES_EDIT = Object.freeze(["read", "grep", "find", "ls", "edit", "write"]);
const FILE_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "list", "glob"]);

/** "edit" when the bot can change files, else "read" (an empty set ran as read). */
export function filesMode(builtin) {
  const b = Array.isArray(builtin) ? builtin : [];
  return b.includes("edit") || b.includes("write") ? "edit" : "read";
}

export function applyFilesMode(def, { mode, was } = {}) {
  if (mode !== "read" && mode !== "edit") return { ok: false, reason: "unknown_mode" };
  if (mode === was) return { ok: true };
  def.tools = def.tools || {};
  const builtin = Array.isArray(def.tools.pi_builtin) ? def.tools.pi_builtin : [];
  const rest = builtin.filter((t) => !FILE_TOOLS.has(t));
  def.tools.pi_builtin = [...(mode === "edit" ? FILES_EDIT : FILES_READ), ...rest];
  return { ok: true };
}

// ---- self-learning: self_authoring + skill_learning as one choice ----

const LEARNING = {
  off: { self_authoring: false, skill_learning: "off" },
  propose: { self_authoring: true, skill_learning: "propose" },
  auto: { self_authoring: true, skill_learning: "auto" },
};

export function learningMode(pp) {
  const sa = !!(pp && pp.self_authoring === true);
  const sl = (pp && pp.skill_learning) || "off";
  for (const [k, v] of Object.entries(LEARNING)) {
    if (v.self_authoring === sa && v.skill_learning === sl) return k;
  }
  return "custom";
}

export function applyLearningMode(pp, { mode, was } = {}) {
  if (mode === was) return { ok: true };
  if (!LEARNING[mode]) return { ok: false, reason: "unknown_mode" };
  Object.assign(pp, LEARNING[mode]);
  return { ok: true };
}

// ---- "Always ask before…" (permission_policy.confirm) ----
// pi matches mcp__<server>__<tool>; the voice turn matches the bare tool
// name. A checked tool stores both.

const piName = (t) => `mcp__${t.server}__${t.name}`;

/**
 * @param {string[]} confirm - stored list
 * @param {{key:string, server:string, name:string}[]} tools - the bot's write-class tools
 * @returns {{checked:string[], other:string[]}}
 */
export function confirmView(confirm, tools) {
  const list = Array.isArray(confirm) ? confirm : [];
  const set = new Set(list);
  const claimed = new Set();
  const checked = [];
  for (const t of tools || []) {
    const hit = set.has(piName(t)) || set.has(t.name);
    if (hit) {
      checked.push(t.key);
      claimed.add(piName(t));
      claimed.add(t.name);
    }
  }
  return { checked, other: list.filter((x) => !claimed.has(x)) };
}

/**
 * @param {string[]} before
 * @param {{key:string, server:string, name:string}[]} tools
 * @param {{checked:string[], otherText:string}} input
 * @returns {string[]} the new confirm list (order of kept entries preserved)
 */
export function applyConfirm(before, tools, { checked, otherText } = {}) {
  const prev = Array.isArray(before) ? before : [];
  const list = tools || [];
  const want = new Set(checked || []);
  const wanted = list.filter((t) => want.has(t.key));
  // pi names are per server (per account); a bare name (the voice turn's
  // vocabulary) is shared by every account that has that tool, so it stays
  // while ANY ticked tool still carries it.
  const keepNames = new Set();
  for (const t of wanted) { keepNames.add(piName(t)); keepNames.add(t.name); }
  const toolNames = new Set();
  for (const t of list) { toolNames.add(piName(t)); toolNames.add(t.name); }
  const others = String(otherText || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const othersSet = new Set(others);
  const out = [];
  const seen = new Set();
  const push = (x) => { if (!seen.has(x)) { seen.add(x); out.push(x); } };
  for (const x of prev) {
    if (toolNames.has(x) ? keepNames.has(x) : othersSet.has(x)) push(x);
  }
  for (const x of others) push(x);
  for (const t of wanted) { push(piName(t)); push(t.name); }
  return out;
}

// ---- tool sources ----

/**
 * Apply per-source posted modes to the stored crow_mcp selection.
 * @param {string[]} stored
 * @param {Object<string, {name:string, access:string}[]>} catalog - per source, as rendered
 * @param {Object<string, {mode:string, was:string, custom:string[]}>} posted
 * @returns {string[]}
 */
export function applySourceModes(stored, catalog, posted) {
  let out = Array.isArray(stored) ? stored.slice() : [];
  for (const [server, p] of Object.entries(posted || {})) {
    if (!p || !catalog || !catalog[server]) continue; // not rendered with a catalog: keep
    if (p.mode === p.was && p.mode !== "custom") continue; // unchanged: keep exactly
    const prefix = server + "/";
    const known = new Set(catalog[server].map((t) => prefix + t.name));
    const prevMine = out.filter((k) => typeof k === "string" && k.startsWith(prefix));
    let mine;
    if (p.mode === "custom") {
      const picked = (p.custom || []).filter((k) => typeof k === "string" && known.has(k));
      // stored names the catalog no longer lists stay (the operator could not see them)
      const unseen = prevMine.filter((k) => !known.has(k));
      mine = [...picked, ...unseen];
    } else {
      mine = expandSourceMode(server, p.mode, catalog[server]);
    }
    // same set as stored: leave the array (and its order) alone
    const a = new Set(mine), b = new Set(prevMine);
    if (a.size === b.size && [...a].every((k) => b.has(k))) continue;
    out = out.filter((k) => !(typeof k === "string" && k.startsWith(prefix))).concat(mine);
  }
  return out;
}

// ---- stale-form guard ----

/**
 * Revision of what an editor page shows: the definition text plus the two
 * columns the editor also edits (name, project). A stale page is refused.
 */
export function rowRev(row) {
  const r = row || {};
  return defRev(String(r.definition || "") + "\u0000" + String(r.display_name ?? "") + "\u0000" + String(r.project_id ?? ""));
}

/** Short revision of the stored definition text (sha256 prefix). */
export function defRev(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}
