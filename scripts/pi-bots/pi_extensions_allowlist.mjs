#!/usr/bin/env node
/**
 * Crow Bot Builder — curated pi-extension allowlist + install-approval gate
 * (Phase 2.4, plan §3).
 *
 * INVARIANT (the actual safety property): NO Bot Builder code path ever runs
 * `pi install`. pi loads its extension set from pi-lab via
 * `~/.pi/agent/settings.json` `packages[]` — a fixed, human-curated package.
 * The bridge spawns `pi --mode rpc …` with NO install/add-package step
 * (verified: bridge.mjs PiRpc args = mode/provider/model/session-dir
 * [+tools/+append-system-prompt/+session] only). Adding a NEW pi extension is
 * therefore a deliberate human operation in the pi-lab gitea repo
 * (clone → branch → `npm run test:extensions` → merge → `git -C ~/pi-lab
 * pull`), NEVER a GUI/bridge side effect at bot-save or bot-spawn time.
 *
 * This module is the single source of truth for which extensions a bot may
 * select. Every entry below is a pi-lab BUILT-IN already loaded for all pi on
 * crow (no install needed) — selecting it just opts this bot into using it.
 * Anything outside this list is REFUSED (logged) by the bridge and is never
 * offered by the GUI; obtaining a new one is the documented pi-lab human flow.
 */

export const PI_EXT_ALLOWLIST = Object.freeze([
  // pi-lab built-ins (extensions/ — loaded via settings.json packages[]):
  "plan-mode", // read-only exploration mode (pi-lab/extensions/plan-mode/)
  "todo", // task list extension (pi-lab/extensions/todo.ts)
  "subagent", // single/parallel/chain sub-agents (pi-lab/extensions/subagent/)
]);

const ALLOW = new Set(PI_EXT_ALLOWLIST);

/**
 * Split a requested extension list into allowed vs rejected.
 * @param {string[]} requested
 * @returns {{ allowed: string[], rejected: string[] }}
 */
export function validateExtensions(requested) {
  const list = Array.isArray(requested) ? requested : [];
  const allowed = [];
  const rejected = [];
  for (const e of list) {
    if (typeof e === "string" && ALLOW.has(e)) allowed.push(e);
    else rejected.push(String(e));
  }
  return { allowed, rejected };
}

// CLI: print the allowlist, or `validate a,b,c`
if (import.meta.url === "file://" + process.argv[1]) {
  const arg = process.argv[2];
  if (arg === "validate") {
    const r = validateExtensions((process.argv[3] || "").split(",").filter(Boolean));
    console.log(JSON.stringify(r));
    process.exit(r.rejected.length ? 1 : 0);
  }
  console.log(PI_EXT_ALLOWLIST.join("\n"));
  process.exit(0);
}
