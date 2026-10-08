/**
 * Bot Builder — "Run commands" adapter: the ONE place that maps the editor's
 * command modes to the stored permission_policy.bash value.
 *
 *   UI mode   stored bash     meaning
 *   off       "deny"          the bot cannot run commands (bash leaves pi_builtin)
 *   ask       "ask"           ask the operator before each command
 *   auto      "auto"          a safety check decides per command
 *   list      "allowlist"     only commands starting with a bash_allow entry
 *
 * "ask" and "auto" are enforced by pi-lab's permission gate (bash policies
 * ask/auto; auto judges each command with the local safety classifier).
 * They are for bots you chat with in Perch only (Kevin's ruling,
 * 2026-10-08): the save guard refuses them for a bot that also answers on
 * another channel, and the bridge runs them as deny there.
 *
 * A stored "sandbox" (an option that never had an implementation — it runs
 * as deny) or any unknown value shows as Off and is kept exactly as stored
 * until the operator picks a mode; a stored "sandbox" also gets a one-click
 * "switch to Auto?" offer (confirm_sandbox_auto).
 */

import { BASH_POLICIES, isValidBashPolicy } from "../../../../shared/bot-bash-policy.js";

export const BASH_UI_TO_STORED = Object.freeze({ off: "deny", ask: "ask", auto: "auto", list: "allowlist" });

// The stored vocabulary is the shared one every definition write must pass.
export const BASH_STORED_VALUES = BASH_POLICIES;
export function isValidStoredBash(v) { return isValidBashPolicy(v); }

/** Modes the runtime enforces. */
export const BASH_MODES_LIVE = new Set(["off", "ask", "auto", "list"]);

/** UI modes in display order (list is shown only where its editor lives). */
export const BASH_MODES = Object.freeze(["off", "ask", "auto", "list"]);

export function storedToBashUi(pp) {
  const v = pp && pp.bash;
  if (v === "allowlist") return "list";
  if (v === "ask") return "ask";
  if (v === "auto") return "auto";
  return "off";
}

const splitLines = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/**
 * Apply a posted command mode to a definition (mutates def).
 * @param {object} def
 * @param {{mode:string, was:string, allowText?:string}} input
 *   allowText, when a string, replaces permission_policy.bash_allow.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function applyCommandsMode(def, { mode, was, allowText } = {}) {
  if (!Object.prototype.hasOwnProperty.call(BASH_UI_TO_STORED, mode)) return { ok: false, reason: "unknown_mode" };
  def.tools = def.tools || {};
  def.permission_policy = def.permission_policy || {};
  const pp = def.permission_policy;
  const changed = mode !== was;
  if (changed && !BASH_MODES_LIVE.has(mode)) return { ok: false, reason: "mode_not_available" };
  if (typeof allowText === "string") {
    const next = splitLines(allowText);
    const prev = Array.isArray(pp.bash_allow) ? pp.bash_allow : [];
    if (JSON.stringify(next) !== JSON.stringify(prev)) pp.bash_allow = next;
  }
  if (!changed) return { ok: true };
  const stored = BASH_UI_TO_STORED[mode];
  if (!isValidStoredBash(stored)) return { ok: false, reason: "invalid_stored_value" };
  pp.bash = stored;
  const builtin = Array.isArray(def.tools.pi_builtin) ? def.tools.pi_builtin.slice() : [];
  const without = builtin.filter((t) => t !== "bash");
  def.tools.pi_builtin = mode === "off" ? without : [...without, "bash"];
  return { ok: true };
}
