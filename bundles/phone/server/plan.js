// Pure plan + number policy for the Phone bundle. No I/O: used by the gateway
// (plan time and dispatch time) and mirrored in the runner (policy.py).
import { createHash } from "node:crypto";

export const OUTCOMES = ["booked","info_gathered","needs_callback","no_answer","voicemail","busy","not_in_service","refused","phone_busy","phone_unreachable","line_lost","taken_over","not_admissible","stopped","failed"];
const NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const SHAREABLE_FIELDS = ["name","callback_number","date_of_birth","insurance_member_id","address","email"];
const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Backlog P7: run_after (the owner's AND the bot's proposal) is a strict ISO-8601 instant with an explicit zone
// (what Date#toISOString sends). Date.parse alone accepts "Tue, 6 Oct 2026",
// a zone-less time read in the gateway's own clock, and rolls 2026-02-30 over.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
export function parseIsoInstant(v) {
  if (typeof v !== "string") return null;
  const m = ISO_INSTANT.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function fail(code, message, extra = {}) { const e = new Error(message); e.code = code; Object.assign(e, extra); return e; }

export function normalizeNumber(raw) {
  const s = String(raw ?? "").trim();
  // Anything that could be an MMI / supplementary-service code or a pause/wait is refused outright.
  if (/[*#,;wWpP]/.test(s)) throw fail("invalid_number", "number contains dial codes");
  let d = s.replace(/[\s().\-]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (!/^\d+$/.test(d)) throw fail("invalid_number", "number has non-digits");
  if (d.length === 10) d = "1" + d;
  const e164 = "+" + d;
  if (!NANP.test(e164)) throw fail("invalid_number", "only US/Canada (NANP) numbers are supported");
  return e164;
}

export function checkNumberPolicy(e164, { ownerNumber, suppressed } = {}) {
  const block = (reason) => { throw fail("number_blocked", `number blocked: ${reason}`, { reason }); };

  // Validate input is E.164 formatted
  if (!NANP.test(e164)) block("not_e164");

  const area = e164.slice(2, 5), exch = e164.slice(5, 8);
  if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(exch)) block("n11");
  if (area === "900" || exch === "900" || exch === "976") block("premium");

  // Normalize ownerNumber for comparison; if invalid, ignore it
  if (ownerNumber) {
    let normalizedOwner;
    try {
      normalizedOwner = normalizeNumber(ownerNumber);
    } catch (_e) {
      // Invalid ownerNumber is ignored, not thrown
      normalizedOwner = null;
    }
    if (normalizedOwner && e164 === normalizedOwner) block("owner_number");
  }

  if (suppressed && suppressed.has(e164)) block("suppressed");
}

function str(v, max, field) {
  const s = String(v ?? "").trim();
  if (!s || s.length > max) throw fail("invalid_plan", `${field} must be 1-${max} characters`);
  return s;
}

function limits(l = {}) {
  if (l === null || (l != null && typeof l !== "object")) throw fail("invalid_plan", "limits must be an object");
  const out = {};
  if (l?.date_range) {
    const { from, to } = l.date_range;
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw fail("invalid_plan", "date_range invalid");
    out.date_range = { from, to };
  }
  if (l?.days_of_week) {
    if (!Array.isArray(l.days_of_week) || !l.days_of_week.every((d) => DAYS.includes(d))) throw fail("invalid_plan", "days_of_week invalid");
    out.days_of_week = [...new Set(l.days_of_week)];
  }
  if (l?.time_window) {
    const { start, end, tz } = l.time_window;
    if (!TIME.test(start) || !TIME.test(end) || start >= end || !tz) throw fail("invalid_plan", "time_window invalid");
    out.time_window = { start, end, tz: String(tz) };
  }
  if (l?.max_price) {
    const amount = Number(l.max_price.amount);
    if (!Number.isFinite(amount) || amount < 0) throw fail("invalid_plan", "max_price invalid");
    out.max_price = { amount, currency: String(l.max_price.currency || "USD") };
  }
  if (l?.duration_minutes != null) {
    const m = Number(l.duration_minutes);
    if (!Number.isInteger(m) || m <= 0 || m > 600) throw fail("invalid_plan", "duration_minutes invalid");
    out.duration_minutes = m;
  }
  if (l?.notes) out.notes = str(l.notes, 500, "limits.notes");
  return out;
}

export function validatePlan(input) {
  const i = input || {};
  const language = i.language || "en";
  if (!["en", "es"].includes(language)) throw fail("invalid_plan", "language must be en or es");
  const shareable = {};
  for (const k of SHAREABLE_FIELDS) if (i.shareable?.[k] != null && String(i.shareable[k]).trim()) shareable[k] = String(i.shareable[k]).trim().slice(0, 200);
  let run_after = null;
  if (i.run_after) { run_after = parseIsoInstant(i.run_after); if (!run_after) throw fail("invalid_plan", "run_after must be an ISO-8601 date and time with a time zone, e.g. 2026-10-06T15:30:00-05:00"); }
  let number_e164;
  try { number_e164 = normalizeNumber(i.number); } catch (e) { throw fail("invalid_plan", e.message); }
  return {
    business_name: str(i.business_name, 200, "business_name"),
    number_e164,
    goal: str(i.goal, 1000, "goal"),
    limits: limits(i.limits),
    shareable,
    language,
    notes: i.notes ? str(i.notes, 1000, "notes") : null,
    run_after,
  };
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

export function planHash(plan) {
  const { business_name, number_e164, goal, limits, shareable, language, notes } = plan;
  return createHash("sha256").update(JSON.stringify(canonical({ business_name, number_e164, goal, limits, shareable, language, notes }))).digest("hex");
}
