/** CalDAV client (+ the collection/object plumbing CardDAV shares) and iCalendar helpers (spec §4.7). */
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import { WsError } from "../result.js";
import { NS, kid, kids } from "../ooxml/xml.js";
import { ncFetch, httpFail } from "../nc/http.js";
import { parseMultistatus, propText } from "../nc/multistatus.js";
import { normEtag } from "../nc/dav.js";
import { displayName } from "../nc/ocs.js";
import { pimHref, pimHrefToSegs, pimHomeUrl, pimCollectionUrl, pimObjectUrl, principalUrl } from "../nc/paths.js";
import { recordChange, settleChange } from "./journal.js";
import { HOME_PROPFIND, ADDRESS_SET_PROPFIND, calendarQuery, uidQueryCal, uidQueryCard } from "./dav-xml.js";

// ---------- collections ----------
export async function listCollections(cfg, kind) {
  const r = await ncFetch(cfg, "PROPFIND", pimHomeUrl(cfg, kind), { headers: { Depth: "1", "Content-Type": "application/xml" }, body: HOME_PROPFIND });
  if (r.status !== 207) throw httpFail(r, kind === "card" ? "list address books" : "list calendars");
  const out = [];
  for (const x of parseMultistatus(await r.text())) {
    const rt = x.props.get(`${NS.d}|resourcetype`);
    const isIt = kind === "card" ? !!kid(rt, NS.card, "addressbook") : !!kid(rt, NS.cal, "calendar");
    if (!isIt) continue;
    const comps = x.props.get(`${NS.cal}|supported-calendar-component-set`);
    if (kind !== "card" && comps && !kids(comps, NS.cal, "comp").some((c) => c.getAttribute("name") === "VEVENT")) continue;
    const segs = pimHrefToSegs(cfg, kind, x.href);
    if (segs.length !== 1) continue; // the home itself (or a stray object row) is not a collection we list
    const id = segs[0];
    if (kind === "card" && /^z-(server|app)-generated--/.test(id)) continue;
    const priv = x.props.get(`${NS.d}|current-user-privilege-set`);
    const writable = !priv || ["write", "write-content", "all"].some((p) => priv.getElementsByTagNameNS(NS.d, p).length > 0);
    const ownerUid = (propText(x.props, NS.oc, "owner-principal") || "").replace(/\/$/, "").split("/").pop();
    out.push({ kind, id, href: pimHref(cfg, kind, [id]), name: propText(x.props, NS.d, "displayname") || id, writable, owner_uid: ownerUid || null, color: propText(x.props, "http://apple.com/ns/ical/", "calendar-color") || null });
  }
  for (const c of out) c.owner = c.owner_uid ? await displayName(cfg, c.owner_uid).catch(() => c.owner_uid) : null;
  return out;
}
export const listCalendars = (cfg) => listCollections(cfg, "cal");
export async function resolveCollection(cfg, kind, nameOrId) {
  const all = await listCollections(cfg, kind);
  const want = String(nameOrId).normalize("NFC");
  const byId = all.find((c) => c.id === want); if (byId) return byId;
  const byName = all.filter((c) => c.name.normalize("NFC").toLowerCase() === want.toLowerCase());
  if (byName.length === 1) return byName[0];
  const what = kind === "card" ? "address book" : "calendar";
  throw new WsError(byName.length ? "ambiguous" : `${kind === "card" ? "addressbook" : "calendar"}_not_found`, `${byName.length ? `More than one ${what} is named` : `No ${what} named`} "${nameOrId}" is shared with Crow bot. Available: ${all.map((c) => `${c.name} (${c.id})`).join(", ") || "none — ask the household to share one with Crow bot"}`);
}
export const resolveCalendar = (cfg, n) => resolveCollection(cfg, "cal", n);

// ---------- objects ----------
async function report(cfg, coll, body) {
  const r = await ncFetch(cfg, "REPORT", pimCollectionUrl(cfg, coll.kind, coll.href), { headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" }, body });
  if (r.status !== 207) throw httpFail(r, "search the collection");
  const out = [];
  for (const x of parseMultistatus(await r.text())) {
    const segs = pimHrefToSegs(cfg, coll.kind, x.href); // throws bad_path for anything outside crow-bot's home
    if (segs.length === 1 && segs[0] === coll.id) continue; // the collection itself
    if (segs.length !== 2 || segs[0] !== coll.id) throw new WsError("bad_path", "the server answered with an object outside the requested collection");
    out.push({ href: pimHref(cfg, coll.kind, segs), etag: normEtag(propText(x.props, NS.d, "getetag")), text: propText(x.props, NS.cal, "calendar-data") ?? propText(x.props, NS.card, "address-data") ?? "" });
  }
  return out;
}
export const queryEvents = (cfg, cal, start, end) => report(cfg, cal, calendarQuery(start, end));
export async function findByUid(cfg, coll, uid, kind = coll.kind) {
  const hits = await report(cfg, coll, kind === "card" ? uidQueryCard(uid) : uidQueryCal(uid));
  const re = new RegExp(`^UID(;[^:]*)?:${uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "m");
  const hit = hits.find((h) => re.test(h.text.replace(/\r?\n[ \t]/g, "")));
  if (!hit) throw new WsError(kind === "card" ? "contact_not_found" : "event_not_found", `No ${kind === "card" ? "contact" : "event"} with uid ${uid} in "${coll.name}"`);
  return hit;
}
export async function getObject(cfg, href) {
  const r = await ncFetch(cfg, "GET", pimObjectUrl(cfg, href));
  if (r.status === 404) return null;
  if (!r.ok) throw httpFail(r, "read the item");
  return { etag: normEtag(r.headers.get("etag")), text: await r.text() };
}
export function putObject(cfg, href, text, { ifMatch, ifNoneMatch } = {}) {
  const headers = { "Content-Type": href.endsWith(".vcf") ? "text/vcard; charset=utf-8" : "text/calendar; charset=utf-8" };
  if (ifMatch) headers["If-Match"] = `"${normEtag(ifMatch)}"`;
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return ncFetch(cfg, "PUT", pimObjectUrl(cfg, href), { headers, body: text });
}
/** PUT that must succeed: 412 → changed_concurrently, other failures → the usual httpFail mapping. */
export async function putChecked(cfg, href, text, cond, what = "save it") {
  const r = await putObject(cfg, href, text, cond);
  if (r.status === 201 || r.status === 204) return r;
  if (r.status === 412) throw new WsError("changed_concurrently", "Someone changed it at the same moment; read it again.");
  throw httpFail(r, what);
}
export async function deleteObject(cfg, href, etag) {
  const r = await ncFetch(cfg, "DELETE", pimObjectUrl(cfg, href), { headers: { "If-Match": `"${normEtag(etag)}"` } });
  if (r.status === 412) throw new WsError("changed_concurrently", "Someone changed it at the same moment; read it again.");
  if (r.status !== 204) throw httpFail(r, "delete it");
}
/** crow-bot's calendar-user addresses (lower-cased, e.g. "mailto:crow-bot@…") from its principal (F5). */
export async function myAddress(cfg) {
  const r = await ncFetch(cfg, "PROPFIND", principalUrl(cfg, cfg.user), { headers: { Depth: "0", "Content-Type": "application/xml" }, body: ADDRESS_SET_PROPFIND });
  if (r.status !== 207) return [];
  const set = parseMultistatus(await r.text())[0]?.props.get(`${NS.cal}|calendar-user-address-set`);
  return set ? kids(set, NS.d, "href").map((h) => h.textContent.trim().toLowerCase()).filter(Boolean) : [];
}
/**
 * Review I12: the journal entry is written BEFORE the PUT/DELETE (a journal failure stops the write); the
 * post-change etag is settled afterwards. A failed write leaves an entry whose undo can only refuse.
 */
export async function journaledWrite(cfg, entry, write) {
  const version_id = recordChange({ ...entry, after_etag: null });
  await write();
  if (entry.op !== "delete") settleChange(version_id, (await getObject(cfg, entry.href).catch(() => null))?.etag ?? null);
  return version_id;
}
export const newObjectHref = (cfg, coll, uid, ext) => pimHref(cfg, coll.kind, [coll.id, `${uid}.${ext}`]);

// ---------- iCalendar ----------
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const D = /^\d{4}-\d{2}-\d{2}$/;
const crlf = (s) => (s.endsWith("\r\n") ? s : `${s}\r\n`);
function registerZones(comp) { for (const tz of comp.getAllSubcomponents("vtimezone")) { const z = new ICAL.Timezone(tz); if (z.tzid && !ICAL.TimezoneService.has(z.tzid)) ICAL.TimezoneService.register(z.tzid, z); } }
const isFloating = (t) => t.isDate || !t.zone || t.zone.tzid === "floating";
const isUtc = (t) => t.zone === ICAL.Timezone.utcTimezone || t.zone?.tzid === "UTC";
/** Wall-clock ms of a time, read as if it were UTC (for floating/all-day comparisons). */
const naiveMs = (t) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
function iso(t) {
  if (t.isDate) return t.toString();
  if (isUtc(t)) return `${t.toString().replace(/Z?$/, "")}Z`;
  if (isFloating(t)) return t.toString();
  const off = t.utcOffset(); const s = off < 0 ? "-" : "+"; const a = Math.abs(off);
  return `${t.toString().replace(/Z$/, "")}${s}${String(Math.floor(a / 3600)).padStart(2, "0")}:${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}`;
}
export function parseCal(ics) {
  let comp;
  try { comp = new ICAL.Component(ICAL.parse(ics)); } catch { throw new WsError("malformed_event", "The event's iCalendar data could not be read."); }
  registerZones(comp); return comp;
}
function eventOut(ev, startT, endT, extra = {}) {
  const nfc = (x) => String(x || "").normalize("NFC");
  return { uid: ev.uid, summary: nfc(ev.summary), description: nfc(ev.description), location: nfc(ev.location), start: iso(startT), end: endT ? iso(endT) : null, all_day: startT.isDate, recurring: ev.isRecurring(), attendees: (ev.attendees || []).map((a) => ({ address: String(a.getFirstValue()).replace(/^mailto:/i, ""), status: a.getParameter("partstat") || null })), ...extra };
}
/**
 * Events of one calendar object overlapping [start, end). Timed events compare in absolute time; all-day and
 * floating events compare by wall clock against the window's own local bounds (floatStart/floatEnd = window
 * wall-clock ms), so an all-day item on 2026-11-01 is in a window 2026-11-01T20:00-06:00…23:00-06:00 even
 * though that is already Nov 2 in UTC (Review Focus 4).
 */
export function expandEvents(ics, start, end, single = true, { floatStart = start.getTime(), floatEnd = end.getTime() } = {}) {
  const comp = parseCal(ics); const vevents = comp.getAllSubcomponents("vevent");
  const master = vevents.find((v) => !v.hasProperty("recurrence-id")) || vevents[0]; if (!master) return [];
  const ev = new ICAL.Event(master, { exceptions: vevents.filter((v) => v !== master && v.hasProperty("recurrence-id")) });
  const ws = start.getTime(); const we = end.getTime();
  const ms = (t) => (isFloating(t) ? naiveMs(t) : t.toUnixTime() * 1000);
  const lo = (t) => (isFloating(t) ? floatStart : ws); const hi = (t) => (isFloating(t) ? floatEnd : we);
  const overlaps = (s, e0) => {
    const e = e0 || s; const a = ms(s); const b = ms(e);
    return b > a ? a < hi(s) && b > lo(e) : a >= lo(s) && a < hi(s); // zero-length: the instant must be inside
  };
  if (!ev.isRecurring() || !single) return overlaps(ev.startDate, ev.endDate) ? [eventOut(ev, ev.startDate, ev.endDate)] : [];
  const out = []; const it = ev.iterator(); let next; let guard = 0;
  while ((next = it.next()) && guard++ < 5000) {
    if (ms(next) >= hi(next) + 14 * 3600e3) break; // overridden instances may move; stop well past the window
    const det = ev.getOccurrenceDetails(next);
    if (overlaps(det.startDate, det.endDate)) out.push(eventOut(det.item, det.startDate, det.endDate, { recurrence_id: iso(det.recurrenceId) }));
  }
  return out;
}
function timeOf(v, field) {
  if (D.test(v)) { const t = ICAL.Time.fromDateString(v); if (Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) throw new WsError("bad_time", `${field} is not a real date`); return t; }
  if (DT.test(v)) { const d = new Date(v); if (Number.isNaN(d.getTime())) throw new WsError("bad_time", `${field} is not a real date-time`); return ICAL.Time.fromJSDate(d, true); }
  throw new WsError("bad_time", `${field} must be YYYY-MM-DD (all-day) or a date-time with an offset, e.g. 2026-10-22T18:00:00-05:00`);
}
/**
 * Review I7: a datetime with an offset is stored in UTC for NEW events, but an update of an event whose DTSTART
 * carries a TZID keeps that TZID (wall time in the same zone), so a weekly series keeps 18:00 local across a DST
 * change instead of drifting by an hour.
 */
function inZoneOf(t, existing) {
  if (!existing || t.isDate || isFloating(existing) || isUtc(existing)) return t;
  return t.convertToZone(existing.zone);
}
function setTimes(ve, start, end, keepZoneOf = null) {
  let s = timeOf(start, "start"); let e = timeOf(end, "end");
  s = inZoneOf(s, keepZoneOf); e = inZoneOf(e, keepZoneOf);
  if (s.isDate !== e.isDate) throw new WsError("bad_time", "start and end must both be dates or both be date-times");
  if (s.isDate && e.compare(s) <= 0) { e = s.clone(); e.adjust(1, 0, 0, 0); }
  if (e.compare(s) <= 0) throw new WsError("bad_time", "end must be after start");
  ve.removeAllProperties("duration");
  for (const [n, t] of [["dtstart", s], ["dtend", e]]) {
    ve.updatePropertyWithValue(n, t);
    const p = ve.getFirstProperty(n); p.removeParameter("tzid");
    if (!t.isDate && !isFloating(t) && !isUtc(t)) p.setParameter("tzid", t.zone.tzid); // keep the TZID so clients show the same zone
  }
}
const stamp = (ve) => { const now = ICAL.Time.fromJSDate(new Date(), true); ve.updatePropertyWithValue("dtstamp", now); ve.updatePropertyWithValue("last-modified", now); };
function setText(ve, name, v) { if (v === undefined) return; if (v === "" || v === null) ve.removeAllProperties(name); else ve.updatePropertyWithValue(name, String(v).normalize("NFC")); }

export function buildEvent({ summary, start, end, description, location, attendees, send_updates = "none", organizer }) {
  const vcal = new ICAL.Component(["vcalendar", [], []]);
  vcal.updatePropertyWithValue("prodid", "-//Crow//Workspace W2//EN"); vcal.updatePropertyWithValue("version", "2.0");
  const ve = new ICAL.Component("vevent"); const uid = randomUUID();
  ve.updatePropertyWithValue("uid", uid); stamp(ve); setTimes(ve, start, end);
  setText(ve, "summary", summary); setText(ve, "description", description); setText(ve, "location", location);
  if (attendees?.length) {
    if (organizer) ve.updatePropertyWithValue("organizer", organizer);
    for (const a of attendees) {
      if (!/^[^\s@:;,"]+@[^\s@:;,"]+$/.test(a)) throw new WsError("bad_args", `"${a}" is not an email address`);
      const p = new ICAL.Property("attendee"); p.setValue(`mailto:${a}`); p.setParameter("partstat", "NEEDS-ACTION"); p.setParameter("role", "REQ-PARTICIPANT");
      if (send_updates !== "all") p.setParameter("schedule-agent", "CLIENT");
      ve.addProperty(p);
    }
  }
  vcal.addSubcomponent(ve);
  return { uid, ics: crlf(vcal.toString()) };
}
const masterOf = (comp) => {
  const ve = comp.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
  if (!ve) throw new WsError("malformed_event", "The event has no series master to change.");
  return ve;
};
/** R-CAL-MASTER: edits the series master only; overridden instances (RECURRENCE-ID) are left as they are. */
export function updateEvent(ics, f) {
  const comp = parseCal(ics); const ve = masterOf(comp);
  setText(ve, "summary", f.summary); setText(ve, "description", f.description); setText(ve, "location", f.location);
  if (f.start !== undefined || f.end !== undefined) {
    const ev = new ICAL.Event(ve); const old = ev.startDate; const oldEnd = ev.endDate;
    let end = f.end;
    if (end === undefined && f.start !== undefined) { // only start moved: keep the event's length
      const s = inZoneOf(timeOf(f.start, "start"), old);
      if (s.isDate === old.isDate) { const e = s.clone(); e.addDuration(oldEnd.subtractDate(old)); end = iso(e); } else end = f.start;
    }
    const asInput = (t) => (!t.isDate && isFloating(t) ? `${iso(t)}Z` : iso(t)); // a floating time has no offset to re-read
    setTimes(ve, f.start ?? asInput(old), end ?? asInput(oldEnd), old);
  }
  ve.updatePropertyWithValue("sequence", Number(ve.getFirstPropertyValue("sequence") || 0) + 1); stamp(ve);
  return crlf(comp.toString());
}
export function respond(ics, addresses, response, comment) {
  const comp = parseCal(ics); const ve = masterOf(comp);
  const me = ve.getAllProperties("attendee").find((p) => addresses.includes(String(p.getFirstValue()).trim().toLowerCase()));
  if (!me) throw new WsError("not_attendee", "Crow bot is not invited to this event, so it cannot respond.");
  me.setParameter("partstat", response.toUpperCase()); me.removeParameter("rsvp");
  if (comment) setText(ve, "comment", comment);
  stamp(ve);
  return crlf(comp.toString());
}
