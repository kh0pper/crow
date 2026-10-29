/**
 * Which bots Crow may hand work to, and the one line about each that the voice model reads in the
 * crow_handoff tool description (never in the system message, which stays byte-stable).
 *
 *   listHandoffCandidates(db, voiceDef) — the candidates, by the same rule a confirm re-checks
 *   botCapabilitySummary(row)           — "<purpose>; tools: …; skills: …; model: …", at most 160 chars
 *   createSummaryCache({ ttlMs, now })  — the candidates, cached until the TTL or a bot-def save
 *
 * Everything shown to the model is one clean line: names and descriptions can come from a peer's
 * patch, so control characters and line breaks never reach the tool description.
 */
import defaultBus from "../../shared/event-bus.js";
import { isVoiceBotId, isVoiceBotDef, normalizeVoiceSettings } from "../../shared/voice-bot.js";
import { boardState, purposeLine, friendlyModel, oneLine } from "../dashboard/shared/bot-display.js";
import { perchAttached } from "../shared/perch-attached.js";
import { HANDOFF_SUMMARY_MAX_CHARS, HANDOFF_MAX_CANDIDATES } from "./handoff-constants.js";

const NAME_MAX = 40;
const MAX_TOOLS = 5;
const MAX_SKILLS = 4;
/** A skill name the model may read: a plain slug (anything else could carry instructions). */
const SAFE_SKILL = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** An unmapped server id or a model name shown as itself: a plain token, never a sentence (a peer can
 * patch tools.crow_mcp and models.*). Anything else is dropped. */
const SAFE_SERVER = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,39}$/;

const FRIENDLY_SERVERS = {
  "crow-memory": "memory",
  "brave-search": "web search",
  "google-workspace": "Google Workspace",
  workspace: "Workspace documents and calendar",
  artifacts: "documents (Artifacts)",
  "crow-tasks": "tasks",
};

function parseDef(definition) {
  if (definition && typeof definition === "object") return definition;
  try { const d = JSON.parse(definition || "{}"); return d && typeof d === "object" ? d : {}; } catch { return {}; }
}

/** A display name for the model: one line, at most 40 characters, else the bot id. */
export function cleanName(displayName, botId) {
  return oneLine(displayName, NAME_MAX) || String(botId);
}

/** The server of a crow_mcp entry: "server/tool", "server__tool" or a bare "server". */
function serverOf(entry) {
  const s = entry.split("/")[0];
  const j = s.indexOf("__");
  return j > 0 ? s.slice(0, j) : s;
}

function toolsPart(def) {
  const list = def.tools && Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp : [];
  const names = [];
  for (const e of list) {
    if (typeof e !== "string" || !e) continue;
    const server = serverOf(e);
    const name = FRIENDLY_SERVERS[server] || (SAFE_SERVER.test(server) ? server : "");
    if (name && !names.includes(name)) names.push(name);
    if (names.length === MAX_TOOLS) break;
  }
  return names.length ? "tools: " + names.join(", ") : "";
}

function skillsPart(def) {
  const names = (Array.isArray(def.skills) ? def.skills : [])
    .filter((s) => typeof s === "string" && SAFE_SKILL.test(s)).slice(0, MAX_SKILLS);
  return names.length ? "skills: " + names.join(", ") : "";
}

/** The bot's own description, else its Crow Messages tagline, else what its channels say it does. */
function purposePart(def, boardOn) {
  const own = oneLine(def.description);
  if (own) return own;
  const cm = (Array.isArray(def.gateways) ? def.gateways : []).find((gw) => gw && gw.type === "crow-messages");
  const tagline = cm ? oneLine(cm.description) : "";
  if (tagline) return tagline;
  return oneLine(purposeLine(def, "en", boardOn));
}

/** Cut to `max` UTF-16 units (the token budget is what the cap protects), never splitting a surrogate pair. */
function cut(s, max) {
  if (s.length <= max) return s;
  let head = s.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head.trimEnd() + "…";
}

/**
 * One line on what a bot is for, at most HANDOFF_SUMMARY_MAX_CHARS: the purpose, its tools and its
 * skills joined by "; ", and its model last. When the line is too long the front is cut, so the
 * model always fits.
 *
 * @param {{definition: string|object, project_id: number|null}} row  a pi_bot_defs row
 */
export function botCapabilitySummary(row) {
  const def = parseDef(row && row.definition);
  const boardOn = boardState(row || {}).state === "on";
  const body = [purposePart(def, boardOn), toolsPart(def), skillsPart(def)].filter(Boolean).join("; ");
  const key = def.models && typeof def.models.default === "string" ? def.models.default : "";
  // A bot on the instance default model (no models.default) gets no model part.
  const shown = key ? friendlyModel(key) : "";
  const model = SAFE_MODEL.test(shown) ? shown : "";
  if (!model) return cut(body, HANDOFF_SUMMARY_MAX_CHARS);
  const tail = "model: " + model;
  if (!body) return tail;
  return cut(body, HANDOFF_SUMMARY_MAX_CHARS - tail.length - 2) + "; " + tail;
}

/** The read behind both exports: `ok` false means the table could not be read (never cached). */
async function readCandidates(db, voiceDef) {
  const allowed = normalizeVoiceSettings(voiceDef).handoff.allowed_bots;
  let rows;
  try {
    rows = (await db.execute(
      "SELECT bot_id, display_name, definition, project_id FROM pi_bot_defs WHERE enabled=1 ORDER BY bot_id",
    )).rows;
  } catch {
    return { ok: false, list: [] };
  }
  const list = [];
  for (const row of rows) {
    const botId = String(row.bot_id);
    if (isVoiceBotId(botId)) continue;
    if (allowed.length && !allowed.includes(botId)) continue;
    const def = parseDef(row.definition);
    if (isVoiceBotDef(def)) continue;
    if (boardState(row).state !== "on") continue;
    list.push({
      bot_id: botId,
      name: cleanName(row.display_name, botId),
      summary: botCapabilitySummary(row),
      perch: perchAttached(def),
      model_key: def.models?.default ?? null,
    });
    if (list.length === HANDOFF_MAX_CANDIDATES) break;
  }
  return { ok: true, list };
}

/**
 * The bots Crow may hand work to: enabled, not the voice bot, board on, and in the voice bot's
 * `handoff.allowed_bots` when that list is non-empty. Sorted by bot_id, at most
 * HANDOFF_MAX_CANDIDATES. A bot without Perch is still listed (`perch: false`). An unreadable
 * table reads as no candidates.
 *
 * @returns {Promise<Array<{bot_id: string, name: string, summary: string, perch: boolean, model_key: string|null}>>}
 */
export async function listHandoffCandidates(db, voiceDef) {
  return (await readCandidates(db, voiceDef)).list;
}

/**
 * The candidates, cached per allowed list for `ttlMs` and dropped on every bot-def save
 * (`pibots:defs-changed`). A failed read is not cached. `dispose()` unsubscribes.
 */
export function createSummaryCache({ ttlMs = 60_000, now = Date.now, bus = defaultBus } = {}) {
  const entries = new Map();
  let gen = 0; // a read that straddles an invalidate must not store its stale answer
  const invalidate = () => { gen++; entries.clear(); };
  const onChange = () => { try { invalidate(); } catch {} };
  bus.on("pibots:defs-changed", onChange);
  return {
    async get(db, voiceDef) {
      const key = JSON.stringify(normalizeVoiceSettings(voiceDef).handoff.allowed_bots);
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.list;
      const at = now(), g = gen;
      const { ok, list } = await readCandidates(db, voiceDef);
      if (ok && g === gen) entries.set(key, { at, list });
      return list;
    },
    invalidate,
    dispose() { bus.off("pibots:defs-changed", onChange); entries.clear(); },
  };
}
