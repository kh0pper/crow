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
 * The command-safety work that implements "ask" and "auto" owns flipping
 * BASH_MODES_LIVE (and, if it settles on different stored strings, the map
 * below). Until then those two modes render disabled and a save that picks
 * one fresh is refused: the pi-lab gate treats every value except
 * "allowlist" as fully blocked, so offering them would promise something the
 * runtime does not do. A value already stored is always kept as it is.
 *
 * A stored "sandbox" (an option that never had an implementation — the gate
 * blocks it like "deny") or any unknown value shows as Off and is kept
 * exactly as stored until the operator picks a mode.
 */

export const BASH_UI_TO_STORED = Object.freeze({ off: "deny", ask: "ask", auto: "auto", list: "allowlist" });

// The stored vocabulary. The command-safety work introduces the shared
// validator servers/shared/bot-bash-policy.js (BASH_POLICIES /
// isValidBashPolicy) that every definition write must pass; once it is on
// main this module imports it instead of this copy, and
// tests/bot-builder-def-adapter.test.js already pins the two lists equal
// whenever that module is present.
export const BASH_STORED_VALUES = Object.freeze(["deny", "ask", "auto", "allowlist"]);
export function isValidStoredBash(v) { return typeof v === "string" && BASH_STORED_VALUES.includes(v); }

/** Modes the runtime enforces today. */
export const BASH_MODES_LIVE = new Set(["off", "list"]);

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
