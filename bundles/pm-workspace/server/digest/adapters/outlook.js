/**
 * Digest adapter — Outlook / Microsoft 365 via an "ingest" the digest pulls.
 *
 * Some tenants disable OAuth user-consent, so a direct Graph token for
 * mail/calendar is unavailable. This adapter instead reads a summary that an
 * external agent (e.g. a Power Automate scheduled flow) has already dropped
 * somewhere the digest can reach. Two sources are supported, in priority:
 *
 *   1. Google Drive drop — the flow writes a JSON file into a Drive folder the
 *      digest can read with an existing Google token. Set:
 *        OUTLOOK_DRIVE_FOLDER_ID — Drive folder to read the newest file from.
 *        GOOGLE_TOKEN_FILE       — Google OAuth2 authorized_user JSON (reused
 *                                  from the Google adapter; Drive read scope).
 *   2. HTTP pull — the flow POSTs to a small endpoint the digest GETs. Set:
 *        OUTLOOK_INGEST_URL / OUTLOOK_INGEST_TOKEN (bearer).
 *
 *   OUTLOOK_INGEST_MAX_AGE_MIN — optional; label the section stale if the
 *                          summary is older than this many minutes (default
 *                          1440 = 24h). Drive uses the file's modifiedTime;
 *                          HTTP uses the wrapper's received_at.
 *
 * Summary payload shape (either source):
 *   { calendar?: [{ start?, end?, subject?, location? }],
 *     messages?: [{ from?, subject? }],
 *     unread_count?: number }
 * (The HTTP source wraps it as { received_at, payload }.)
 *
 * Renders whatever known fields are present, never throws on missing ones.
 * Emitted section items use the renderer's { label, detail? } shape.
 */

import { existsSync } from "node:fs";
import { mintGoogleToken, newestFileInFolder, downloadJson } from "../../google-drive.js";

const HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_TZ = "America/Chicago";

/**
 * Render an event timestamp as a short local time (e.g. "1:00 PM").
 * The Office 365 "Get calendar view (V3)" connector returns UTC with no offset
 * by default, so a bare `YYYY-MM-DDTHH:MM:SS[.fffffff]` is treated as UTC and
 * converted to `tz`. Anything that isn't a recognizable datetime is returned
 * unchanged (already-formatted strings pass through).
 */
function toLocalTime(v, tz) {
  if (typeof v !== "string") return v;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  let iso = v.replace(/\.\d+/, ""); // drop fractional seconds (JS Date rejects 7-digit)
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += "Z"; // no offset → assume UTC (connector default)
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return v;
  try {
    return d.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  } catch {
    return v;
  }
}

/**
 * True when the event's start falls on today's date in `tz`. The ingest
 * window may span several days (rolling look-ahead for weekly planning);
 * the digest's calendar section renders only today's slice. Events whose
 * start can't be parsed are kept — better to over-show than silently drop.
 */
function isToday(v, tz) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return true;
  let iso = v.replace(/\.\d+/, "");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += "Z"; // no offset → assume UTC (connector default)
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return true;
  try {
    const day = (x) => x.toLocaleDateString("en-CA", { timeZone: tz });
    return day(d) === day(new Date());
  } catch {
    return true;
  }
}

// Digest sections render items as { label, detail? } (see render.js).
function fmtCalendar(items, tz) {
  return items.slice(0, 20).map((e) => {
    const when = [e.start, e.end].map((t) => toLocalTime(t, tz)).filter(Boolean).join("–");
    const where = e.location ? ` @ ${e.location}` : "";
    return { label: `${e.subject || "(no subject)"}${where}`, detail: when || undefined };
  });
}

function fmtMessages(items) {
  return items.slice(0, 20).map((m) => ({
    label: m.subject || "(no subject)",
    detail: m.from || undefined,
  }));
}

/**
 * Read the newest file in the ingest Drive folder → { payload, receivedAt }.
 * Returns { empty: true } when the folder has no files yet. Exported so the
 * planner can reconcile its exported events against the same drop.
 */
export async function readDriveDrop(config) {
  const token = await mintGoogleToken(config.GOOGLE_TOKEN_FILE);
  const file = await newestFileInFolder(token, config.OUTLOOK_DRIVE_FOLDER_ID);
  if (!file) return { empty: true };
  let payload = await downloadJson(token, file.id);
  // The flow may write the summary bare, or wrapped as { payload }.
  if (payload && typeof payload === "object" && payload.payload) payload = payload.payload;
  return { payload, receivedAt: file.modifiedTime || null };
}

/** Fetch the HTTP ingest → { payload, receivedAt } or { empty: true }. */
async function readHttpIngest(config) {
  const res = await fetch(config.OUTLOOK_INGEST_URL, {
    headers: { Authorization: `Bearer ${config.OUTLOOK_INGEST_TOKEN}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 404) return { empty: true };
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
  const record = await res.json();
  return { payload: (record && record.payload) || {}, receivedAt: record && record.received_at };
}

export async function outlookSections(config) {
  const cal = { title: "Outlook calendar (today)", available: false, items: [] };
  const mail = { title: "Outlook mail", available: false, items: [] };

  const driveMode = Boolean(config.OUTLOOK_DRIVE_FOLDER_ID && config.GOOGLE_TOKEN_FILE && existsSync(config.GOOGLE_TOKEN_FILE));
  const httpMode = Boolean(config.OUTLOOK_INGEST_URL && config.OUTLOOK_INGEST_TOKEN);
  if (!driveMode && !httpMode) {
    const reason = "not configured (set OUTLOOK_DRIVE_FOLDER_ID+GOOGLE_TOKEN_FILE, or OUTLOOK_INGEST_URL+TOKEN)";
    cal.reason = reason;
    mail.reason = reason;
    return [cal, mail];
  }

  let result;
  try {
    result = driveMode ? await readDriveDrop(config) : await readHttpIngest(config);
  } catch (err) {
    const reason = `Outlook ingest failed: ${err.message}`;
    cal.reason = reason;
    mail.reason = reason;
    return [cal, mail];
  }

  if (result.empty) {
    const reason = "no Outlook summary posted yet";
    cal.reason = reason;
    mail.reason = reason;
    return [cal, mail];
  }

  const payload = result.payload || {};
  const receivedAt = result.receivedAt || null;

  // Staleness label (does not suppress the section — better to show old data
  // labeled than to hide it).
  const maxAgeMin = Number(config.OUTLOOK_INGEST_MAX_AGE_MIN) || 1440;
  let staleNote = "";
  if (receivedAt) {
    const ageMin = (Date.now() - Date.parse(receivedAt)) / 60000;
    if (Number.isFinite(ageMin) && ageMin > maxAgeMin) {
      staleNote = ` (stale — posted ${Math.round(ageMin / 60)}h ago)`;
    }
  }

  if (Array.isArray(payload.calendar)) {
    cal.available = true;
    const tz = config.OUTLOOK_TZ || DEFAULT_TZ;
    cal.items = fmtCalendar(payload.calendar.filter((e) => isToday(e.start, tz)), tz);
    cal.title = `Outlook calendar (today)${staleNote}`;
    if (cal.items.length === 0) cal.items = [{ label: "No events." }];
  } else {
    cal.reason = "summary has no calendar field";
  }

  const mailBits = [];
  if (typeof payload.unread_count === "number") {
    mailBits.push({ label: `Unread: ${payload.unread_count}` });
  }
  if (Array.isArray(payload.messages)) mailBits.push(...fmtMessages(payload.messages));
  if (mailBits.length) {
    mail.available = true;
    mail.items = mailBits;
    mail.title = `Outlook mail${staleNote}`;
  } else {
    mail.reason = "summary has no mail fields";
  }

  return [cal, mail];
}
