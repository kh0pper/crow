/**
 * Digest adapter — Outlook / Microsoft 365 via an HTTP "ingest" pull.
 *
 * Some tenants disable OAuth user-consent, so a direct Graph token for
 * mail/calendar is unavailable. This adapter instead PULLS a summary that an
 * external agent (e.g. a Power Automate scheduled flow) has already posted to a
 * small ingest endpoint. The digest simply reads the latest posted payload.
 *
 * Env:
 *   OUTLOOK_INGEST_URL   — GET here for the latest summary (bearer-authed).
 *   OUTLOOK_INGEST_TOKEN — bearer token sent as `Authorization: Bearer …`.
 *   OUTLOOK_INGEST_MAX_AGE_MIN — optional; if the payload's received_at is
 *                          older than this many minutes, the section is labeled
 *                          stale (default 1440 = 24h).
 *
 * Expected response shape (the ingest receiver wraps the posted body):
 *   { received_at: ISO8601, payload: {
 *       calendar?: [{ start?, end?, subject?, location? }],
 *       messages?: [{ from?, subject?, received? }],
 *       unread_count?: number,
 *       note?: string
 *   } }
 *
 * The payload is producer-defined; this adapter renders whatever known fields
 * are present and never throws on missing ones.
 */

const HTTP_TIMEOUT_MS = 15_000;

function fmtCalendar(items) {
  return items.slice(0, 20).map((e) => {
    const when = [e.start, e.end].filter(Boolean).join("–");
    const where = e.location ? ` @ ${e.location}` : "";
    return { text: `${when ? when + "  " : ""}${e.subject || "(no subject)"}${where}` };
  });
}

function fmtMessages(items) {
  return items.slice(0, 20).map((m) => {
    const from = m.from ? `${m.from}: ` : "";
    return { text: `${from}${m.subject || "(no subject)"}` };
  });
}

export async function outlookSections(config) {
  const cal = { title: "Outlook calendar (today)", available: false, items: [] };
  const mail = { title: "Outlook mail", available: false, items: [] };

  const url = config.OUTLOOK_INGEST_URL;
  const token = config.OUTLOOK_INGEST_TOKEN;
  if (!url || !token) {
    const reason = "not configured (OUTLOOK_INGEST_URL/OUTLOOK_INGEST_TOKEN unset)";
    cal.reason = reason;
    mail.reason = reason;
    return [cal, mail];
  }

  let record;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 404) {
      const reason = "no Outlook summary posted yet";
      cal.reason = reason;
      mail.reason = reason;
      return [cal, mail];
    }
    if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
    record = await res.json();
  } catch (err) {
    const reason = `ingest fetch failed: ${err.message}`;
    cal.reason = reason;
    mail.reason = reason;
    return [cal, mail];
  }

  const payload = (record && record.payload) || {};
  const receivedAt = record && record.received_at ? record.received_at : null;

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
    cal.items = fmtCalendar(payload.calendar);
    cal.title = `Outlook calendar (today)${staleNote}`;
    if (cal.items.length === 0) cal.items = [{ text: "No events." }];
  } else {
    cal.reason = "summary has no calendar field";
  }

  const mailBits = [];
  if (typeof payload.unread_count === "number") {
    mailBits.push({ text: `Unread: ${payload.unread_count}` });
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
