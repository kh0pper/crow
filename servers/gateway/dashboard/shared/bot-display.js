/**
 * Bot display helpers shared by the Bot Builder list and the Bot Board
 * (queue item 20, option A). Pure: no DB, no DOM, no clock of their own.
 *
 *   boardState(row)              — can this bot hold cards? on | off | custom
 *   friendlyModel(key, providers) — "Qwen3.6 35B A3B" instead of the raw key
 *   purposeLine(def, lang, on)    — one line on what the bot does
 *   agoText(isoUtc, now, lang)    — "updated 9 days ago"
 */
import { t, fill } from "./i18n.js";

function parseDef(definition) {
  if (definition && typeof definition === "object") return definition;
  try { return JSON.parse(definition || "{}") || {}; } catch { return {}; }
}

/**
 * A kanban board is keyed on the bot's project, so a bot can hold cards only
 * when its tracker is kanban/task-list AND a project is linked. An absent
 * tracker type means kanban (parseBotDef's default).
 *
 * @param {{definition: string|object, project_id: number|null}} row
 * @returns {{state: "on"|"off"|"custom", reason: string|null}}
 */
export function boardState(row) {
  const def = parseDef(row && row.definition);
  const tc = def.tracker_config || {};
  const type = tc.type || "kanban";
  if (type === "none") return { state: "off", reason: "none" };
  if (type === "custom") return tc.tracker_slug ? { state: "custom", reason: null } : { state: "off", reason: "no_slug" };
  if (row && row.project_id != null) return { state: "on", reason: null };
  return { state: "off", reason: "no_project" };
}

/**
 * The provider's display name for a model key ("provider/model"), cut at the
 * first " (" so a "(local, chat)" suffix does not crowd a row. Falls back to
 * the part after the provider, then to the key itself.
 */
export function friendlyModel(key, providerRows) {
  if (!key) return "";
  const s = String(key);
  const slash = s.indexOf("/");
  if (slash < 0) return s;
  const prov = s.slice(0, slash), mid = s.slice(slash + 1);
  const row = (providerRows || []).find((p) => p && p.id === prov);
  let models = row ? row.models : null;
  if (typeof models === "string") { try { models = JSON.parse(models); } catch { models = null; } }
  const m = Array.isArray(models) ? models.find((x) => x && typeof x === "object" && x.id === mid) : null;
  const name = m && typeof m.name === "string" ? m.name.trim() : "";
  if (!name) return mid;
  const cut = name.indexOf(" (");
  return cut > 0 ? name.slice(0, cut) : name;
}

const CHANNEL_NAMES = { gmail: "Gmail", discord: "Discord", telegram: "Telegram", slack: "Slack", "crow-messages": "Crow Messages" };

/** One short phrase per channel type; unknown types add nothing. */
function channelPhrase(type, lang) {
  if (type === "perch") return t("botbuilder.purposePerch", lang);
  if (type === "glasses") return t("botbuilder.purposeGlasses", lang);
  if (type === "companion") return t("botbuilder.purposeCompanion", lang);
  if (CHANNEL_NAMES[type]) return fill(t("botbuilder.purposeAnswersOn", lang), { channel: CHANNEL_NAMES[type] });
  return "";
}

/**
 * What the bot does, in one line: at most two channel phrases joined with
 * " · ". With no channel, a board-on bot "works through its board"; anything
 * else returns "" so the row leaves the line out.
 */
export function purposeLine(def, lang = "en", boardOn = false) {
  const phrases = [];
  for (const gw of (def && Array.isArray(def.gateways) ? def.gateways : [])) {
    const p = gw && channelPhrase(gw.type, lang);
    if (p && !phrases.includes(p)) phrases.push(p);
    if (phrases.length === 2) break;
  }
  if (phrases.length) return phrases.join(" · ");
  return boardOn ? t("botbuilder.purposeBoard", lang) : "";
}

/** SQLite's datetime() text ("YYYY-MM-DD HH:MM:SS") is UTC with no marker. */
function parseUtc(s) {
  const str = String(s).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str) ? str.replace(" ", "T") + "Z" : str;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * "updated N <unit> ago" with real singular/plural keys in each language.
 * @param {string} isoUtc  stored timestamp (SQLite UTC text or ISO)
 * @param {number} now     epoch ms (injected so tests and renders agree)
 * @param {string} [prefix] i18n key prefix: "botbuilder.updated" (default)
 *   or "botboard.added" — each has JustNow + AgoMinute(s)…AgoMonth(s) keys
 */
export function agoText(isoUtc, now, lang = "en", prefix = "botbuilder.updated") {
  if (!isoUtc) return "";
  const ms = parseUtc(isoUtc);
  if (ms == null) return "";
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return t(prefix + "JustNow", lang);
  const min = Math.floor(sec / 60), hr = Math.floor(min / 60), day = Math.floor(hr / 24), mon = Math.floor(day / 30);
  const pick = (n, one, many) => fill(t(n === 1 ? one : many, lang), { n });
  if (mon >= 1) return pick(mon, prefix + "AgoMonth", prefix + "AgoMonths");
  if (day >= 1) return pick(day, prefix + "AgoDay", prefix + "AgoDays");
  if (hr >= 1) return pick(hr, prefix + "AgoHour", prefix + "AgoHours");
  return pick(min, prefix + "AgoMinute", prefix + "AgoMinutes");
}
