import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import * as C from "../pim/caldav.js";

const ref = (cal, uid) => `cal:${cal.id}/${uid}`;
const needWritable = (cal) => { if (!cal.writable) throw new WsError("read_only", `Crow bot can read "${cal.name}" but not change it. Ask the owner to share it with edit rights.`); };
/** A window bound: absolute ms plus its own wall-clock ms (for all-day/floating events, Review Focus 4). */
function bound(v, fallbackMs) {
  if (v === undefined) return { at: new Date(fallbackMs), wall: fallbackMs };
  const d = new Date(v); if (Number.isNaN(d.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(v)) throw new WsError("bad_time", `${v} is not a date-time with an offset (e.g. 2026-10-22T00:00:00-05:00)`);
  const m = /([+-])(\d{2}):(\d{2})$/.exec(v); const offMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return { at: d, wall: d.getTime() + offMin * 60000 };
}
const SLACK = 14 * 3600e3; // all-day items are matched by wall clock, so ask the server for a wider absolute range
const startMs = (s) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s).getTime();

export const calendarDefs = [
  { name: "ws_cal_list_calendars", description: "Calendars shared with Crow bot: id, name, owner, writable, color.", schema: {},
    run: async (_a, c) => ({ calendars: (await C.listCalendars(c.getConfig())).map(({ id, name, owner, writable, color }) => ({ id, name, owner, writable, color })) }) },
  { name: "ws_cal_list_events", description: "Events in a window (default now → +30 days, max 366 days). time_min/time_max are date-times with an offset. single_events expands repeats. query matches summary/description/location.",
    schema: { calendar: z.string().min(1).max(200), time_min: z.string().max(40).optional(), time_max: z.string().max(40).optional(), max_results: z.number().int().min(1).max(250).optional().default(20), query: z.string().max(200).optional(), single_events: z.boolean().optional().default(true) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar);
      const lo = bound(a.time_min, c.clock.now()); const hi = bound(a.time_max, lo.at.getTime() + 30 * 86400000);
      if (hi.at <= lo.at || hi.at - lo.at > 366 * 86400000) throw new WsError("bad_time", "time_max must be after time_min and within 366 days");
      const q = a.query ? a.query.normalize("NFC").toLowerCase() : null; let events = [];
      for (const o of await C.queryEvents(cfg, cal, new Date(lo.at.getTime() - SLACK), new Date(hi.at.getTime() + SLACK))) {
        events.push(...C.expandEvents(o.text, lo.at, hi.at, a.single_events, { floatStart: lo.wall, floatEnd: hi.wall }).map((e) => ({ ...e, ref: ref(cal, e.uid) })));
      }
      if (q) events = events.filter((e) => `${e.summary}\n${e.description}\n${e.location}`.normalize("NFC").toLowerCase().includes(q));
      events.sort((x, y) => startMs(x.start) - startMs(y.start));
      return { calendar: cal.name, events: events.slice(0, a.max_results) };
    } },
  { name: "ws_cal_get_event", description: "One event by uid: parsed fields plus raw ICS.", schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => { const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); const o = await C.findByUid(cfg, cal, a.uid); const ev = C.expandEvents(o.text, new Date(-8.64e15), new Date(8.64e15), false, { floatStart: -8.64e15, floatEnd: 8.64e15 })[0] || {}; return { ...ev, ref: ref(cal, a.uid), ics: o.text }; } },
  { name: "ws_cal_create_event", description: "Create an event. start/end: YYYY-MM-DD for all-day (end exclusive; same day is fine) or date-times with an offset. send_updates 'none' (default) sends no invitations. Undoable.",
    schema: { calendar: z.string().min(1).max(200), summary: z.string().min(1).max(500), start: z.string().max(40), end: z.string().max(40), description: z.string().max(20000).optional(), location: z.string().max(1000).optional(), attendees: z.array(z.string().max(320)).max(50).optional(), send_updates: z.enum(["none", "all"]).optional().default("none") },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); needWritable(cal);
      const organizer = a.attendees?.length ? (await C.myAddress(cfg))[0] : undefined;
      const { uid, ics } = C.buildEvent({ ...a, organizer });
      const href = C.newObjectHref(cfg, cal, uid, "ics");
      const version_id = await C.journaledWrite(cfg, { kind: "cal", ref: ref(cal, uid), href, op: "create", before_text: null }, () => C.putChecked(cfg, href, ics, { ifNoneMatch: "*" }, "add the event"));
      return { uid, ref: ref(cal, uid), calendar: cal.name, version_id };
    } },
  { name: "ws_cal_update_event", description: "Change fields of an event (the series master for repeating events; new times keep the event's time zone). Undoable.",
    schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500), summary: z.string().max(500).optional(), start: z.string().max(40).optional(), end: z.string().max(40).optional(), description: z.string().max(20000).optional(), location: z.string().max(1000).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); needWritable(cal);
      const o = await C.findByUid(cfg, cal, a.uid); const next = C.updateEvent(o.text, a);
      const version_id = await C.journaledWrite(cfg, { kind: "cal", ref: ref(cal, a.uid), href: o.href, op: "update", before_text: o.text }, () => C.putChecked(cfg, o.href, next, { ifMatch: o.etag }, "change the event"));
      return { uid: a.uid, ref: ref(cal, a.uid), version_id };
    } },
  { name: "ws_cal_delete_event", description: "Delete an event (Workspace keeps it in the calendar trash; also undoable here). Destructive: confirm intent with the user first.",
    schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); needWritable(cal); const o = await C.findByUid(cfg, cal, a.uid);
      const version_id = await C.journaledWrite(cfg, { kind: "cal", ref: ref(cal, a.uid), href: o.href, op: "delete", before_text: o.text }, () => C.deleteObject(cfg, o.href, o.etag));
      return { deleted: true, ref: ref(cal, a.uid), version_id };
    } },
  { name: "ws_cal_respond_to_event", description: "Accept, decline or tentatively accept an event Crow bot is invited to. Undoable.",
    schema: { calendar: z.string().min(1).max(200), uid: z.string().min(1).max(500), response: z.enum(["accepted", "declined", "tentative"]), comment: z.string().max(1000).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig(); const cal = await C.resolveCalendar(cfg, a.calendar); const o = await C.findByUid(cfg, cal, a.uid);
      const next = C.respond(o.text, await C.myAddress(cfg), a.response, a.comment);
      const version_id = await C.journaledWrite(cfg, { kind: "cal", ref: ref(cal, a.uid), href: o.href, op: "update", before_text: o.text }, () => C.putChecked(cfg, o.href, next, { ifMatch: o.etag }, "answer the invitation"));
      return { uid: a.uid, ref: ref(cal, a.uid), response: a.response, version_id };
    } },
];
export const registerCalendar = (server, ctx) => defineTools(server, ctx, calendarDefs);
