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

/** Auto-detect the MPA host from its data-dir convention (~/.crow-mpa). */
function isMpaHost() {
  const probe = `${process.env.CROW_HOME || ""}|${process.env.CROW_DATA_DIR || ""}`;
  return /\.crow-mpa(\/|\b|$)/.test(probe);
}

export async function botRuntimeActive(db) {
  let flags = {};
  try {
    const raw = await readSetting(db, "feature_flags");
    if (raw) flags = JSON.parse(raw) || {};
  } catch { /* ignore malformed flags */ }
  if (typeof flags.bot_runtime === "boolean") return flags.bot_runtime;
  return isMpaHost();
}
