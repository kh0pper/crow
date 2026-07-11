#!/usr/bin/env node
/**
 * Crow Bot Builder — gateway registry (Hermes-parity, A1 step 3).
 *
 * Distilled AFTER the two concrete dial-out adapters (telegram, slack) existed,
 * so the shape is derived from real adapters, not guessed up front. The registry
 * is the single place that knows about gateway TYPES:
 *
 *   - hostAdapters()      — adapter modules the gateway_runner.mjs host starts
 *                           (have a start({bot_id, gw, log}) -> {stop}). v1 =
 *                           telegram + slack. Gmail (poll, pibot-bridge.timer)
 *                           and Discord (its own pibot-discord.service) are NOT
 *                           host-managed in v1, so they're metadata-only here.
 *   - getAdapter(type)    — one host adapter, or null.
 *   - gatewayHint(type, threadId) — the per-turn prompt line for a gateway.
 *                           bridge.mjs delegates to this. The gmail + discord
 *                           strings MUST stay byte-identical to bridge.mjs's
 *                           previous hardcoded if/else (they're part of the
 *                           system-prompt prefix the KV cache depends on); the
 *                           generic fallback is fixed/stable for new types.
 *   - capabilitiesForUI() — [{type, mode, label, configFields}] for the Bot
 *                           Builder gateway editor (A4).
 */
import telegram from "./telegram.mjs";
import slack from "./slack.mjs";
import crowMessages from "./crow-messages.mjs";

/** Adapter modules the host process owns (each exports start() -> {stop}). */
const HOST_ADAPTERS = [telegram, slack, crowMessages];
const HOST_BY_TYPE = Object.fromEntries(HOST_ADAPTERS.map((a) => [a.type, a]));

export function hostAdapters() { return HOST_ADAPTERS.slice(); }
export function getAdapter(type) { return HOST_BY_TYPE[type] || null; }
export function isHostManaged(type) { return !!HOST_BY_TYPE[type]; }

/**
 * Per-turn gateway hint. gmail/discord are reproduced byte-for-byte from the
 * pre-registry bridge.mjs:429-439 if/else (cache-prefix stability); telegram/
 * slack use their adapter's gatewayHint; anything else gets the stable generic
 * fallback (also byte-identical to the old `else`).
 */
export function gatewayHint(type, threadId) {
  if (type === "discord") {
    return "\nGATEWAY: discord — your reply text is sent to the Discord channel automatically. "
      + "Do NOT use gmail tools. (thread ref: " + threadId + ")";
  }
  if (type === "gmail") {
    return "\nGATEWAY THREAD: gmail thread_id=" + threadId
      + " — pass this verbatim as thread_id when drafting your reply via gmail_create_draft.";
  }
  if (type === "board") {
    return "\nGATEWAY: board (card ref: " + threadId + ") — this run was dispatched from the "
      + "kanban board. Do NOT use gmail/discord tools to reply; write your durable result under "
      + "the plan file's \"## Result\" section and keep your final reply to a short summary.";
  }
  const a = HOST_BY_TYPE[type];
  if (a && typeof a.gatewayHint === "function") return a.gatewayHint(threadId);
  return "\nGATEWAY: " + type + " (thread ref: " + threadId
    + ") — your reply text is delivered automatically.";
}

/** UI metadata for gateway types Crow can edit. gmail/discord field sets mirror
 *  what the Bot Builder already collected; telegram/slack come from the adapters. */
const STATIC_META = {
  gmail: {
    type: "gmail", mode: "poll", label: "Gmail",
    configFields: [
      { key: "address", label: "Bot address (user+alias@…)", required: true },
      { key: "allowlist", label: "Allowed sender emails", type: "list" },
    ],
  },
  discord: {
    type: "discord", mode: "socket", label: "Discord",
    configFields: [
      { key: "token", label: "Bot token", secret: true, required: true },
      { key: "guild_id", label: "Guild ID (optional)" },
      { key: "channel_ids", label: "Restrict to channel IDs (optional)", type: "list" },
      { key: "allowlist", label: "Allowed user IDs", type: "list" },
    ],
  },
};

const LABEL_OVERRIDES = { "crow-messages": "Crow Messages" };

export function capabilitiesForUI() {
  const out = [STATIC_META.gmail, STATIC_META.discord];
  for (const a of HOST_ADAPTERS) {
    const label = LABEL_OVERRIDES[a.type] || (a.type.charAt(0).toUpperCase() + a.type.slice(1));
    out.push({ type: a.type, mode: a.mode, label, configFields: a.configFields || [] });
  }
  return out;
}

export default { hostAdapters, getAdapter, isHostManaged, gatewayHint, capabilitiesForUI };
