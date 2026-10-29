/**
 * One set of voice rules for every surface (phone overlay, kiosk, glasses): what each surface's turn
 * options share, built in one place. A surface spreads these first, then its own display-only options.
 * Bundles reach this module through their panel routes' appImport (never a static import).
 */
import { VOICE_DENY_TOOLS, CROW_VOICE_BOT_ID, isVoiceBotId, isVoiceBotDef, normalizeVoiceSettings } from "../../shared/voice-bot.js";
import { voiceLine } from "./voice-lines.js";
import { VOICE_OWN_TOOL_NAMES, resolveRoutineBackends } from "./own-tools.js";

// VOICE_OWN_TOOL_NAMES: Crow's own tools, for listing (Bot Builder, the editor); never a policy-gate exemption.
export { VOICE_DENY_TOOLS, CROW_VOICE_BOT_ID, isVoiceBotId, VOICE_OWN_TOOL_NAMES };

/** How long a surface keeps the loaded voice bot (as turn.js keeps a bot); a bot-defs change reloads it at once. */
export const VOICE_BOT_CACHE_MS = 30_000;

/**
 * The device as a voice turn uses it: the voice bot's speaking voice (tts_profile_id) and speech
 * recognition (stt_profile_id) in place of the device's, where the voice bot sets them. Returns a
 * copy when anything is replaced, else the device itself; never mutates the device, and nothing
 * stored is rewritten (a surface applies this in memory, per turn).
 */
export function withVoiceProfiles(device, voiceDef) {
  if (!device || !voiceDef || typeof voiceDef !== "object") return device;
  const { tts_profile_id: tts, stt_profile_id: stt } = normalizeVoiceSettings(voiceDef);
  if (!tts && !stt) return device;
  return { ...device, ...(tts ? { tts_profile_id: tts } : {}), ...(stt ? { stt_profile_id: stt } : {}) };
}

/**
 * Does the voice bot have any of Crow's own tools at hand (a calendar, reminders or tasks resolved, as own-tools.js
 * forTurn resolves them)? `connected`: the connected add-on tool names, a Set or a function returning one (the
 * gateway's connectedAddonToolNames); nothing else is read, never the network. false for any other bot or on doubt.
 * The kiosk's command-vocabulary STT prompt is gated on it (PR 2.1 [r2 I7]).
 */
export function ownToolsLoaded(voiceDef, connected = null) {
  if (!isVoiceBotDef(voiceDef)) return false;
  let conn = new Set();
  try {
    const c = typeof connected === "function" ? connected() : connected;
    if (c instanceof Set) conn = c;
    else if (Array.isArray(c)) conn = new Set(c);
  } catch { conn = new Set(); }
  try { return Object.values(resolveRoutineBackends(normalizeVoiceSettings(voiceDef), conn)).some(Boolean); } catch { return false; }
}

/**
 * Is the fast voice model a cloud one, under the strict check (roles phase 2 Task 20, Kevin Q2)? Anything not
 * proven local counts as cloud. The key is the one the turn would use (turn.js voiceKeys): the def's own key (a
 * `role:` ref resolved by the full walk, a raw "provider/model" as it is) is checked by strictVoiceCloud (every
 * hop, this box's "This is local" marks, a row flagged host "cloud" always cloud); a def with no fast key, an
 * unresolvable role or a malformed key uses the router's fast side, so its answer is resolveVoiceKeys'
 * `fastCloud`. Never throws: a failure is not proof of local.
 */
export async function fastModelIsCloud(db, def, { resolveVoiceKeysFn } = {}) {
  try {
    // Lazy: surfaces load this module through appImport; the store and the strict check load on use.
    const vk = await import("../../shared/voice-keys.js");
    const routerFast = async () => {
      const k = await (resolveVoiceKeysFn || vk.resolveVoiceKeys)(db);
      return k?.fastCloud !== false;
    };
    const key = normalizeVoiceSettings(def).fast_voice_model;
    if (typeof key !== "string" || !key) return await routerFast();
    let resolved = key;
    if (key.startsWith("role:")) {
      const [{ resolveRole }, { isRoleRef }] = await Promise.all([
        import("../../shared/model-roles-store.js"), import("../../shared/model-roles.js"),
      ]);
      if (!isRoleRef(key)) return await routerFast(); // a bare "role:" is no role
      const r = await resolveRole(db, key, { need: "chat" });
      if (!r?.key) return await routerFast(); // the turn falls back to the router's fast key
      resolved = r.key;
    }
    const i = resolved.indexOf("/");
    if (i <= 0 || i === resolved.length - 1) return await routerFast();
    return await vk.strictVoiceCloud(db, resolved);
  } catch { return true; }
}

/**
 * A surface's loader for the Crow voice bot: loadVoiceBot(db) → { def, cloud } | null.
 *   def    the voice bot's parsed definition
 *   cloud  its fast voice model is not proven local (fastModelIsCloud; crowVoiceTurnOptions' `cloud`)
 * null when the row is missing, disabled or corrupt, or the read fails: the surface then applies no
 * profiles and the turn speaks the no-assistant line (turn.js). Never throws. Cached VOICE_BOT_CACHE_MS;
 * `generation()` (turn.js defaultVoiceDeps' botDefsGeneration, bumped on pibots:defs-changed) drops
 * the cache at once. `resolveVoiceKeysFn` (a seam) is fastModelIsCloud's router-keys reader.
 */
export function createVoiceBotLoader({ now = Date.now, generation = () => 0, ttlMs = VOICE_BOT_CACHE_MS, resolveVoiceKeysFn } = {}) {
  let hit = null;
  return async function loadVoiceBot(db) {
    let gen = 0;
    try { gen = generation(); } catch { gen = 0; }
    if (hit && hit.gen === gen && now() - hit.at < ttlMs) return hit.value;
    let value = null;
    try {
      const row = (await db.execute({ sql: "SELECT definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [CROW_VOICE_BOT_ID] })).rows[0];
      if (row && Number(row.enabled) === 1) {
        const def = JSON.parse(row.definition);
        if (def && typeof def === "object" && !Array.isArray(def)) value = { def, cloud: await fastModelIsCloud(db, def, { resolveVoiceKeysFn }) };
      }
    } catch { value = null; }
    hit = { value, gen, at: now() };
    return value;
  };
}

/**
 * → the shared turn options.
 *   surface           "phone" | "kiosk" | "glasses" (turn.js records it as timings.surface)
 *   lang              the surface's language for the spoken lines
 *   voiceDef          the voice bot's definition, when the caller has it: escalation off → noEscalate
 *   cloud             the caller's answer to "is the fast voice model not proven local?" (loadVoiceBot's `cloud`).
 *                     A cloud model is capable, so the tool-family gate (there for the small local
 *                     model's latency) is off. The lookup is the caller's.
 *   actionWhen, actionFollowWhen   the surface's action-intent tests (queue item 29)
 *   tz                the surface's IANA time zone (kiosk: the hub's; glasses: the server's), passed on as
 *                     opts.tz: Crow's own tools read times in it, and refuse a time without one
 *   relayThreadId     the R1.2 session's thread id on a turn whose transcript is not the operator's own speech (the
 *                     relayed turn and the speak-the-answer call): copied on when non-empty (turn.js's relay contract)
 *   relayKind         with relayThreadId only: "answer" on the speak-the-answer call (the transcript is the bot's text);
 *                     "operator" only when absent or "operator"; any unknown value is "answer" (the safer one)
 */
export function crowVoiceTurnOptions({ surface, lang, voiceDef = null, cloud = false, actionWhen, actionFollowWhen, tz = null, relayThreadId = null, relayKind = null } = {}) {
  const o = {
    surface,
    familiesOnIntent: cloud !== true,
    denyTools: VOICE_DENY_TOOLS,
    actionWhen,
    actionFollowWhen,
    cantDoText: voiceLine("cant_do_say", lang),
    notDoneText: voiceLine("not_done_say", lang),
    notReadyText: voiceLine("not_ready_say", lang),
    memoOnlyText: voiceLine("memo_only_say", lang),
    unsureText: voiceLine("unsure_say", lang),
    partlyDoneText: voiceLine("partly_done_say", lang),
    hintText: voiceLine("hint_say", lang),
  };
  // The turn's own spoken lines (Crow's own tools, their confirmations) follow the surface's language and zone.
  if (typeof lang === "string" && lang) o.lang = lang;
  if (typeof tz === "string" && tz) o.tz = tz;
  if (typeof relayThreadId === "string" && relayThreadId.trim()) {
    o.relayThreadId = relayThreadId;
    o.relayKind = relayKind == null || relayKind === "operator" ? "operator" : "answer";
  }
  if (voiceDef && normalizeVoiceSettings(voiceDef).escalation === "off") o.noEscalate = true;
  return o;
}
