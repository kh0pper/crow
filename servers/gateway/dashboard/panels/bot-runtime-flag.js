/**
 * Bot runtime indicator (F3). Local-only (non-synced) signal for whether the
 * bot RUNTIME (Gmail/Telegram/Discord gateways + timers) runs on this instance.
 * Phase a: definitions work everywhere, runtime is MPA-only — so the panel
 * shows an honest "runtime not active here" banner when this returns false.
 *
 * Mirrors the F1.3 feature_flags pattern: explicit boolean wins, else default
 * to the auto-detected MPA host. feature_flags is absent from sync-allowlist.js
 * so it never replicates (genuinely per-instance).
 */
import { readSetting } from "../settings/registry.js";
import { isMpaHost } from "../../../shared/mpa-detect.js";

// NOTE: the resolve rule below is mirrored as a SYNC reader in
// scripts/pi-bots/runtime-gate.mjs (botRuntimeEnabledSync) for the bot
// runners. isMpaHost is now shared (mpa-detect.js); keep the bot_runtime
// resolve rule in step with runtime-gate.mjs's resolveBotRuntime.

export async function botRuntimeActive(db) {
  let flags = {};
  try {
    const raw = await readSetting(db, "feature_flags");
    if (raw) flags = JSON.parse(raw) || {};
  } catch { /* ignore malformed flags */ }
  if (typeof flags.bot_runtime === "boolean") return flags.bot_runtime;
  return isMpaHost();
}
