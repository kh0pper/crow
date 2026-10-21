/**
 * Crow's own tools (PR 2, Task 2.5): the voice bot adds a calendar event, a reminder or a task itself, to
 * whichever system is installed. One small tool per routine object, run in-process by the voice turn
 * (turn.js deps.ownTools), never through the model's remote tool list:
 *
 *   crow_calendar_add_event → Workspace (ws_cal_create_event) or Google (gcal_create_event)
 *   crow_reminder_add       → Crow's own schedules (one '@once' row the scheduler fires once)
 *   crow_task_add           → Workspace tasks (ws_task_create) or a board card (tagged crow-voice, gated)
 *
 * Rules:
 * - The spoken success line is the server's, built from what the backend returned, and only after the write
 *   returned ok (#499). A backend error is { ok:false, code:"backend_error" } with no say: the turn's action
 *   guard then speaks its not-done line.
 * - Validation failures are { ok:false, code:"bad_args", message } (the model reads the message; the turn
 *   steps up once). A date-time needs its UTC offset, and a known time zone (opts.tz from the surface):
 *   without one, nothing is guessed.
 * - Strict confirm (the voice bot's voice.confirm "strict"), and the calendar-fallback reminder offer
 *   (ctx.fallback "calendar", rev 2.1), validate, hold the call as the device's pending "routine" entry and
 *   ask; nothing is written until a spoken yes reaches fastPath. Under "standard" the adds run at once.
 *
 * The own tools are exempt from the turn's policy gate only because turn.js runs them from the loaded own-tool
 * set (ownByName); VOICE_OWN_TOOL_NAMES is for listing them (Bot Builder, the editor), never for skipping a gate.
 */
import { normalizeVoiceSettings, isVoiceBotDef } from "../../shared/voice-bot.js";
import { ROUTINE_OBJECTS } from "./routine-objects.js";
import { voiceLine } from "./voice-lines.js";
import { matchYesNo } from "./pending.js";

export const VOICE_OWN_TOOL_NAMES = Object.freeze(["crow_calendar_add_event", "crow_reminder_add", "crow_task_add"]);

/**
 * The intent lists each own tool family is offered on (turn.js tool families): the routine-object vocabulary
 * (routine-objects.js, one list for "is this about a calendar / reminder / task") plus these few extra phrases
 * that ask for the tool without naming the object. Never a bare "to do" or "todo" ("apaga todo" is Spanish).
 */
export const OWN_INTENT_EXTRAS = Object.freeze({
  reminders: Object.freeze({ en: Object.freeze(["wake me up"]), es: Object.freeze(["despiertame"]) }),
});
export const OWN_TOOL_INTENTS = Object.freeze(Object.fromEntries(Object.keys(ROUTINE_OBJECTS).map((id) => [id, Object.freeze({
  en: Object.freeze([...ROUTINE_OBJECTS[id].en, ...(OWN_INTENT_EXTRAS[id]?.en || [])]),
  es: Object.freeze([...ROUTINE_OBJECTS[id].es, ...(OWN_INTENT_EXTRAS[id]?.es || [])]),
})])));

/** How long a calendar or task list found by listing stays chosen (per process). */
export const OWN_ID_CACHE_MS = 10 * 60 * 1000;

/** The board card's author: the owner, speaking through Crow's voice. */
const VOICE_ACTOR = Object.freeze({ kind: "human", id: "crow.voice", jobId: null });
const BACKEND_ERROR = Object.freeze({ ok: false, code: "backend_error" });
const TITLE_MAX = 200;

// ─── Dates and times ───
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Do these wall-clock fields name a real moment (no 30 February, no 25:00)? */
function realWall(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
}

/** "2026-10-26T12:00:00-05:00" → { ms, off (minutes east of UTC), date "2026-10-26" } | null (no offset → null). */
function parseDateTime(v) {
  if (typeof v !== "string") return null;
  const m = DT_RE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || "0"].map(Number);
  if (!realWall(y, mo, d, h, mi, s)) return null;
  let off = 0;
  if (m[7] !== "Z") {
    const sign = m[7][0] === "-" ? -1 : 1;
    const digits = m[7].slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 18 || om > 59) return null;
    off = sign * (oh * 60 + om);
  }
  return { ms: Date.UTC(y, mo - 1, d, h, mi, s) - off * 60_000, off, date: `${m[1]}-${m[2]}-${m[3]}` };
}

function parseDate(v) {
  if (typeof v !== "string") return null;
  const m = DATE_RE.exec(v.trim());
  if (!m || !realWall(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The moment `ms` written in the offset `off` ("2026-10-26T13:00:00-05:00"). */
function withOffset(ms, off) {
  const w = new Date(ms + off * 60_000);
  const o = off === 0 ? "Z" : `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}${o}`;
}

function nextDay(date) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** A usable IANA zone, or null. */
function validTz(tz) {
  if (typeof tz !== "string" || !tz.trim()) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

const locale = (lang) => (lang === "es" ? "es" : "en-US");
const whenAt = (ms, lang, tz) => new Intl.DateTimeFormat(locale(lang), { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(ms));
const whenDay = (date, lang) => new Intl.DateTimeFormat(locale(lang), { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

// ─── Validation ───
const bad = (message) => ({ error: message });
const NO_TZ = "No time zone is known on this device, so a time cannot be set here. Tell the user you can't set a time from this device.";
const NEED_OFFSET = "Give the time as a date-time with the UTC offset of the user's time zone, e.g. 2026-10-26T12:00:00-05:00.";

function cleanText(v, what) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return { error: `${what} is required.` };
  if (t.length > TITLE_MAX) return { error: `${what} is too long (at most ${TITLE_MAX} characters).` };
  return { value: t };
}

/** → { args, when } (args normalized; when spoken) | { error }. */
function validate(tool, raw, { tz, lang, now }) {
  const a = raw && typeof raw === "object" ? raw : {};
  if (tool === "crow_calendar_add_event") {
    const title = cleanText(a.title, "The title");
    if (title.error) return bad(title.error);
    const startDate = parseDate(a.start);
    const startDt = startDate ? null : parseDateTime(a.start);
    if (!startDate && !startDt) return bad(`The start is not a date or a date-time with an offset. ${NEED_OFFSET} Use YYYY-MM-DD for an all-day event.`);
    const allDay = !!startDate || a.all_day === true;
    if (allDay) {
      const start = startDate || startDt.date;
      let end = start;
      if (a.end != null && a.end !== "") {
        end = parseDate(a.end) || parseDateTime(a.end)?.date || null;
        if (!end) return bad("The end is not a date (YYYY-MM-DD) for an all-day event.");
        if (end < start) return bad("The end is before the start.");
      }
      return { args: { title: title.value, start, end, all_day: true }, when: whenDay(start, lang) };
    }
    if (!tz) return bad(NO_TZ);
    let end = withOffset(startDt.ms + 3_600_000, startDt.off);
    if (a.end != null && a.end !== "") {
      const e = parseDateTime(a.end);
      if (!e) return bad(`The end is not a date-time with an offset. ${NEED_OFFSET}`);
      if (e.ms <= startDt.ms) return bad("The end must be after the start.");
      end = String(a.end).trim();
    }
    return { args: { title: title.value, start: String(a.start).trim(), end, all_day: false }, when: whenAt(startDt.ms, lang, tz) };
  }
  if (tool === "crow_reminder_add") {
    const text = cleanText(a.text, "The reminder text");
    if (text.error) return bad(text.error);
    const at = parseDateTime(a.at);
    if (!at) return bad(`The time is not a date-time with an offset. ${NEED_OFFSET}`);
    if (!tz) return bad(NO_TZ);
    if (at.ms <= now) return bad("That time has already passed. Ask the user for a time in the future.");
    return { args: { text: text.value, at: String(a.at).trim() }, when: whenAt(at.ms, lang, tz), atIso: new Date(at.ms).toISOString() };
  }
  if (tool === "crow_task_add") {
    const title = cleanText(a.title, "The title");
    if (title.error) return bad(title.error);
    let due = null;
    if (a.due != null && a.due !== "") {
      due = parseDate(a.due);
      if (!due) return bad("The due date must be YYYY-MM-DD.");
    }
    return { args: { title: title.value, ...(due ? { due } : {}) }, when: null };
  }
  return bad("Unknown tool.");
}

const successLine = (tool, v, lang) => (tool === "crow_calendar_add_event" ? voiceLine("calendar_added", lang, { title: v.args.title, when: v.when })
  : tool === "crow_reminder_add" ? voiceLine("reminder_set", lang, { when: v.when, text: v.args.text })
    : voiceLine("task_added", lang, { title: v.args.title }));
const confirmLine = (tool, v, lang) => (tool === "crow_calendar_add_event" ? voiceLine("routine_confirm_calendar", lang, { title: v.args.title, when: v.when })
  : tool === "crow_reminder_add" ? voiceLine("routine_confirm_reminder", lang, { when: v.when, text: v.args.text })
    : voiceLine("routine_confirm_task", lang, { title: v.args.title }));

// ─── Definitions ───
const DEFINITIONS = Object.freeze({
  crow_calendar_add_event: {
    family: "own:calendar", intent: OWN_TOOL_INTENTS.calendar,
    definition: {
      name: "crow_calendar_add_event",
      description: "Add an event to the user's calendar. The server tells the user when it is done.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "What the event is" },
          start: { type: "string", description: "A date-time with the UTC offset of the user's time zone (2026-10-26T12:00:00-05:00), or YYYY-MM-DD for an all-day event" },
          end: { type: "string", description: "Optional; same form as start. Default: one hour after start, or the same day for an all-day event" },
          all_day: { type: "boolean", description: "True for an all-day event" },
        },
        required: ["title", "start"],
        additionalProperties: false,
      },
    },
  },
  crow_reminder_add: {
    family: "own:reminders", intent: OWN_TOOL_INTENTS.reminders,
    definition: {
      name: "crow_reminder_add",
      description: "Set a one-time reminder for the user at a given time. The server tells the user when it is set.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "What to remind the user of" },
          at: { type: "string", description: "When: a date-time with the UTC offset of the user's time zone (2026-10-26T09:30:00-05:00)" },
        },
        required: ["text", "at"],
        additionalProperties: false,
      },
    },
  },
  crow_task_add: {
    family: "own:tasks", intent: OWN_TOOL_INTENTS.tasks,
    definition: {
      name: "crow_task_add",
      description: "Add a task to the user's to-do list. The server tells the user when it is added.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: TITLE_MAX, description: "The task" },
          due: { type: "string", description: "Optional due date, YYYY-MM-DD" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
});
const OBJECT_OF = Object.freeze({ crow_calendar_add_event: "calendar", crow_reminder_add: "reminders", crow_task_add: "tasks" });

async function defaultOpenTasksDb() {
  const { createDbClient } = await import("../../db.js");
  const { tasksDbPath } = await import("../../../scripts/pi-bots/instance-paths.mjs");
  return createDbClient(tasksDbPath());
}

/**
 * createOwnTools({ pending, now, log, connected, openTasksDb }):
 *   pending      createPendingStore() (pending.js): the per-device pending confirmations
 *   connected()  → Set of connected add-on tool names (tool-executor connectedAddonToolNames)
 *   openTasksDb  → the instance-global tasks.db client (default: instance-paths tasksDbPath)
 * → { forTurn, fastPath, turnContext, resolveBackends }
 */
export function createOwnTools({ pending, now = Date.now, log = () => {}, connected = () => new Set(), openTasksDb = defaultOpenTasksDb } = {}) {
  if (!pending || typeof pending.set !== "function") throw new Error("own tools: a pending store is required");
  const idCache = new Map();   // "calendar" | "tasks" → { id, at }
  const connectedNow = () => { try { const s = connected(); return s instanceof Set ? s : new Set(s || []); } catch { return new Set(); } };

  /** settings: normalizeVoiceSettings(bot) (or anything with .routine). An explicit backend not connected → null. */
  function resolveBackends(settings, conn) {
    const r = normalizeVoiceSettings({ routine: settings?.routine }).routine;
    const has = (n) => conn instanceof Set && conn.has(n);
    const cal = r.calendar.backend;
    const calendar = cal === "workspace" ? (has("ws_cal_create_event") ? "workspace" : null)
      : cal === "google" ? (has("gcal_create_event") ? "google" : null)
        : cal === "auto" ? (has("ws_cal_create_event") ? "workspace" : has("gcal_create_event") ? "google" : null) : null;
    const reminders = r.reminders.backend === "off" ? null : "crow";
    const tb = r.tasks.backend;
    const tasks = tb === "workspace" ? (has("ws_task_create") ? "workspace" : null)
      : tb === "board" ? "board"
        : tb === "auto" ? (has("ws_task_create") ? "workspace" : "board") : null;
    return { calendar, reminders, tasks };
  }

  async function callTool(executor, name, args) {
    if (!executor || typeof executor.executeToolCalls !== "function") throw new Error("no tool executor");
    const [r] = await executor.executeToolCalls([{ id: `own-${name}`, name, arguments: args }]);
    if (!r || r.isError) throw new Error(`${name} failed`);
    // Every backend called here answers a JSON object (Workspace: { success, data }; Google: the API object).
    // Anything else (plain text, an array, null) is not a documented success: an error, never "added".
    let body = null;
    try { body = JSON.parse(String(r.result)); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${name} answered no JSON object`);
    if (body.success === false || (body.success !== true && body.error)) throw new Error(`${name} failed`);
    return body.success === true && "data" in body ? body.data : body;
  }

  /** The first writable calendar or task list, by listing once (cached OWN_ID_CACHE_MS). null when none. */
  async function firstWritable(kind, executor) {
    const hit = idCache.get(kind);
    if (hit && now() - hit.at < OWN_ID_CACHE_MS) return hit.id;
    const data = await callTool(executor, kind === "calendar" ? "ws_cal_list_calendars" : "ws_tasks_list_lists", {});
    const items = Array.isArray(data?.[kind === "calendar" ? "calendars" : "lists"]) ? data[kind === "calendar" ? "calendars" : "lists"] : [];
    const id = items.find((x) => x && x.writable === true && typeof x.id === "string" && x.id)?.id || null;
    if (id) idCache.set(kind, { id, at: now() });
    return id;
  }

  async function boardCard(v, settings) {
    const { createCard } = await import("../board/card-service.js");
    const tdb = await openTasksDb();
    try {
      await createCard(tdb, { title: v.args.title, due_date: v.args.due ?? null, tags: "crow-voice", project_id: settings.routine.tasks.project_id ?? null }, VOICE_ACTOR);
    } finally { try { tdb.close(); } catch {} }
  }

  /** Write a validated call. → the result object; a failure is BACKEND_ERROR (logged, never spoken as success). */
  async function perform(tool, v, { db, executor, settings, lang }) {
    const backend = resolveBackends(settings, connectedNow())[OBJECT_OF[tool]];
    try {
      if (!backend) throw new Error("no backend");
      if (tool === "crow_calendar_add_event") {
        const a = v.args;
        if (backend === "workspace") {
          const calendar = settings.routine.calendar.calendar || await firstWritable("calendar", executor);
          if (!calendar) throw new Error("no writable calendar");
          await callTool(executor, "ws_cal_create_event", { calendar, summary: a.title, start: a.start, end: a.end });
        } else {
          // Google's all-day end is exclusive: a same-day end becomes the next day.
          const end = a.all_day && a.end <= a.start ? nextDay(a.start) : a.end;
          await callTool(executor, "gcal_create_event", { summary: a.title, start: a.start, end, calendar_id: settings.routine.calendar.calendar || "primary" });
        }
      } else if (tool === "crow_reminder_add") {
        await db.execute({
          sql: "INSERT INTO schedules (task, cron_expression, description, next_run) VALUES ('reminder:' || ?, '@once', 'Set by Crow''s voice', ?)",
          args: [v.args.text, v.atIso],
        });
      } else if (backend === "workspace") {
        let list = settings.routine.tasks.list;
        if (!list) {
          try { list = await firstWritable("tasks", executor); }
          catch (err) { if (settings.routine.tasks.backend !== "auto") throw err; list = null; }
        }
        if (list) await callTool(executor, "ws_task_create", { list, summary: v.args.title, ...(v.args.due ? { due: v.args.due } : {}) });
        else if (settings.routine.tasks.backend === "auto") await boardCard(v, settings);   // auto: no list resolves → the board
        else throw new Error("no writable task list");
      } else {
        await boardCard(v, settings);
      }
    } catch (err) {
      log(`[voice-own-tools] ${tool} not written (${String(err?.message || err).slice(0, 120)})`);
      return { ...BACKEND_ERROR };
    }
    return { ok: true, code: "added", final: true, say: successLine(tool, v, lang) };
  }

  /** → { tools, unavailable } for one voice turn (turn.js deps.ownTools). */
  function forTurn({ bot, lang, tz } = {}) {
    const settings = normalizeVoiceSettings(bot);
    const zone = validTz(tz);
    const backends = resolveBackends(settings, connectedNow());
    const unavailable = Object.keys(backends).filter((k) => !backends[k]);
    const tools = VOICE_OWN_TOOL_NAMES.filter((n) => backends[OBJECT_OF[n]]).map((name) => {
      const d = DEFINITIONS[name];
      return {
        definition: d.definition,
        family: d.family,
        intent: d.intent,
        async execute(args, ctx = {}) {
          const v = validate(name, args, { tz: zone, lang, now: now() });
          if (v.error) return JSON.stringify({ ok: false, code: "bad_args", message: v.error });
          const offer = ctx.fallback === "calendar" && name === "crow_reminder_add";
          if (offer || settings.confirm === "strict") {
            const deviceId = ctx.device?.id;
            if (!deviceId) return JSON.stringify(BACKEND_ERROR);   // no device to hold the question: nothing is asked or written
            const say = offer ? voiceLine("calendar_fallback_offer", lang, { when: v.when, text: v.args.text }) : confirmLine(name, v, lang);
            pending.set(deviceId, { kind: "routine", tool: name, args: v.args, say, lang, tz: zone });
            return JSON.stringify({ ok: true, effect: false, code: "needs_confirm", final: true, say });
          }
          return JSON.stringify(await perform(name, v, { db: ctx.db, executor: ctx.executor, settings, lang }));
        },
      };
    });
    return { tools, unavailable };
  }

  /**
   * deps.voiceActions.fastPath: answers only this device's pending "routine" entry. yes → the held call runs
   * (validated again, under the voice bot's current settings) and the success line is spoken; no → declined;
   * anything else → null (the entry waits out its TTL). No device, or nothing pending → null: nothing ever runs
   * without a held question. A yes with no voice bot (disabled) or under another bot speaks not-done, writes nothing.
   */
  async function fastPath({ db, device, transcript, lang, bot, executor } = {}) {
    const id = device?.id;
    if (!id) return null;
    const peek = pending.get(id);
    if (!peek || peek.kind !== "routine") return null;
    const answer = matchYesNo(transcript);
    if (!answer) return null;
    const entry = pending.take(id);   // act on what take() returned, never the earlier copy
    if (!entry || entry.kind !== "routine" || !Object.hasOwn(DEFINITIONS, entry.tool)) return null;
    const speak = lang || entry.lang;
    if (answer === "no") return { say: voiceLine("declined", speak), verb: "routine_no" };
    // Only the voice bot writes: a yes while it is disabled (no bot) or under another bot (opts.botId) runs nothing.
    if (!bot || !isVoiceBotDef(bot)) return { say: voiceLine("not_done_say", speak), verb: "routine_failed" };
    const settings = normalizeVoiceSettings(bot);
    const v = validate(entry.tool, entry.args, { tz: entry.tz, lang: speak, now: now() });
    const res = v.error ? null : await perform(entry.tool, v, { db, executor, settings, lang: speak });
    return res?.ok === true ? { say: res.say, verb: "routine_yes" } : { say: voiceLine("not_done_say", speak), verb: "routine_failed" };
  }

  /** deps.voiceActions.turnContext (synchronous): while a routine question waits, the turn says so. */
  function turnContext({ device } = {}) {
    const entry = device?.id ? pending.get(device.id) : null;
    return entry && entry.kind === "routine" ? { text: `[Pending] ${entry.say}`, pending: true } : null;
  }

  return { forTurn, fastPath, turnContext, resolveBackends };
}
