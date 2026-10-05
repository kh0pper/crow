/**
 * Wall-clock time in a named time zone, from the platform's own zone data (Intl). No dependency.
 */
export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return true; } catch { return false; }
}

const formatters = new Map();
/** Wall-clock parts of a UTC instant in `tz`: { year, month, day, hour, minute, dow (0 = Sunday) }. */
export function localParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, dow: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() };
}

/** This host's zone, by name ("America/Chicago"), or "UTC" when it cannot be read. */
export function hostTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
