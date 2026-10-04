import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { statSync, readdirSync, utimesSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { installFakePim } from "./helpers/workspace-fake-pim.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const CHICAGO = ["BEGIN:VTIMEZONE", "TZID:America/Chicago", "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT", "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
const cal = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", CHICAGO, ...lines, "END:VCALENDAR"].join("\r\n");
const unfold = (s) => s.replace(/\r\n[ \t]/g, "");
let fake, pim, call, close, home;
before(async () => {
  fake = await startFakeNextcloud(); pim = installFakePim(fake);
  pim.addCalendar("menu_shared_by_admin", "Menu"); pim.addCalendar("feriados", "Feriados", { writable: false });
  pim.addEvent("menu_shared_by_admin", "cena.ics", cal("BEGIN:VEVENT", "UID:cena-1", "DTSTAMP:20261001T000000Z", "DTSTART;TZID=America/Chicago:20261022T180000", "DTEND;TZID=America/Chicago:20261022T190000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Cena: tacos al pastor con piña", "END:VEVENT"));
  ({ call, close, home } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("list calendars with writability; ambiguous/unknown names list the options", async () => {
  const r = await call("ws_cal_list_calendars", {});
  assert.deepEqual(r.data.calendars.map((c) => [c.name, c.writable]), [["Menu", true], ["Feriados", false]]);
  assert.equal(r.data.calendars[0].owner, "Casey");
  const nope = await call("ws_cal_list_events", { calendar: "Nope" });
  assert.equal(nope.code, "calendar_not_found"); assert.match(nope.error, /Menu.*Feriados/);
});

test("weekly recurrence across DST keeps wall time (Review Focus 4)", async () => {
  const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z" });
  assert.deepEqual(r.data.events.map((e) => e.start), ["2026-10-22T18:00:00-05:00", "2026-10-29T18:00:00-05:00", "2026-11-05T18:00:00-06:00"]);
  assert.deepEqual(r.data.events.map((e) => e.end), ["2026-10-22T19:00:00-05:00", "2026-10-29T19:00:00-05:00", "2026-11-05T19:00:00-06:00"]);
});

test("event summary with accents survives ICS round-trip (Review Focus 1)", async () => {
  // stored NFD (fixture) comes back NFC
  const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z", query: "piña" });
  assert.equal(r.data.events[0].summary, "Cena: tacos al pastor con piña", "NFD input comes back NFC; NFD query matches");
  // typed NFD (literal combining escapes) → stored + read back NFC, and an NFC query finds it
  const nfd = "Cena: tacos al pastor con piña — Menú de mí casa";
  assert.notEqual(nfd, nfd.normalize("NFC"));
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: nfd, start: "2026-10-16T18:00:00-05:00", end: "2026-10-16T19:00:00-05:00", location: "Cocina de José" });
  assert.equal(c.success, true);
  const obj = [...pim.calendars.get("menu_shared_by_admin").objects.values()].find((o) => unfold(o.text).includes(`UID:${c.data.uid}`)).text;
  assert.ok(unfold(obj).includes(`SUMMARY:${nfd.normalize("NFC")}`), "stored NFC");
  const g = await call("ws_cal_get_event", { calendar: "Menu", uid: c.data.uid });
  assert.equal(g.data.summary, nfd.normalize("NFC")); assert.equal(g.data.location, "Cocina de José");
  const l = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-16T00:00:00-05:00", time_max: "2026-10-17T00:00:00-05:00", query: "menú de mí" });
  assert.deepEqual(l.data.events.map((e) => e.uid), [c.data.uid]);
});

test("all-day on DST day stays a date (Review Focus 4); single-day end is made exclusive; list windows include it", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "Menú: pozole", start: "2026-11-01", end: "2026-11-01" });
  assert.equal(c.success, true); assert.match(c.data.ref, /^cal:menu_shared_by_admin\//);
  const obj = [...pim.calendars.get("menu_shared_by_admin").objects.values()].find((o) => o.text.includes("pozole")).text;
  assert.match(obj, /DTSTART;VALUE=DATE:20261101\r\n/); assert.match(obj, /DTEND;VALUE=DATE:20261102\r\n/);
  const l = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-11-01T00:00:00-05:00", time_max: "2026-11-02T00:00:00-06:00", query: "POZOLE" });
  assert.deepEqual(l.data.events.map((e) => [e.start, e.end, e.all_day]), [["2026-11-01", "2026-11-02", true]]);
  // an evening window late on Nov 1 local (already Nov 2 in UTC) still includes the all-day item
  const late = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-11-01T20:00:00-06:00", time_max: "2026-11-01T23:00:00-06:00", query: "pozole" });
  assert.equal(late.data.events.length, 1);
  // ... and a window that starts at local midnight of Nov 2 does not
  const next = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-11-02T00:00:00-06:00", time_max: "2026-11-03T00:00:00-06:00", query: "pozole" });
  assert.equal(next.data.events.length, 0);
  // an update of an all-day item keeps it a date
  await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, summary: "Menú: pozole rojo" });
  const obj2 = [...pim.calendars.get("menu_shared_by_admin").objects.values()].find((o) => o.text.includes("pozole rojo")).text;
  assert.match(obj2, /DTSTART;VALUE=DATE:20261101\r\n/); assert.match(obj2, /DTEND;VALUE=DATE:20261102\r\n/);
});

test("datetimes need an offset; attendees get SCHEDULE-AGENT=CLIENT by default", async () => {
  assert.equal((await call("ws_cal_create_event", { calendar: "Menu", summary: "x", start: "2026-10-10T18:00", end: "2026-10-10T19:00" })).code, "bad_time");
  await call("ws_cal_create_event", { calendar: "Menu", summary: "Con invitados", start: "2026-10-10T18:00:00-05:00", end: "2026-10-10T19:00:00-05:00", attendees: ["alex@example.org"] });
  const obj = unfold([...pim.calendars.get("menu_shared_by_admin").objects.values()].find((o) => o.text.includes("Con invitados")).text);
  assert.match(obj, /ATTENDEE;[^:]*SCHEDULE-AGENT=CLIENT[^:]*:mailto:alex@example\.org/);
  assert.match(obj, /ORGANIZER[^:]*:mailto:crow-bot@crow\.test/i);
});

test("update + delete are journaled and undoable; undo refuses after a human edit; journal files are 600", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "Lunes: sopa", start: "2026-10-12", end: "2026-10-13" });
  const u = await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, summary: "Lunes: caldo" });
  assert.ok(u.data.version_id.startsWith("j1."));
  assert.equal((await call("ws_undo_last_change", { path: u.data.ref, version_id: u.data.version_id })).success, true);
  assert.equal((await call("ws_cal_get_event", { calendar: "Menu", uid: c.data.uid })).data.summary, "Lunes: sopa");
  const d = await call("ws_cal_delete_event", { calendar: "Menu", uid: c.data.uid });
  assert.equal((await call("ws_cal_get_event", { calendar: "Menu", uid: c.data.uid })).code, "event_not_found");
  const ud = await call("ws_undo_last_change", { path: d.data.ref, version_id: d.data.version_id });
  assert.equal(ud.data.undone, "restored");
  assert.equal((await call("ws_cal_get_event", { calendar: "Menu", uid: c.data.uid })).success, true);
  // S8: re-created at the SAME href
  assert.ok(pim.calendars.get("menu_shared_by_admin").objects.has(`${c.data.uid}.ics`));
  // a version_id may only undo the ref it belongs to
  assert.equal((await call("ws_undo_last_change", { path: "cal:menu_shared_by_admin/other", version_id: d.data.version_id })).code, "bad_version_id");
  const u2 = await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, location: "Casa" });
  const file = [...pim.calendars.get("menu_shared_by_admin").objects.entries()].find(([, o]) => o.text.includes(c.data.uid))[0];
  pim.addEvent("menu_shared_by_admin", file, pim.calendars.get("menu_shared_by_admin").objects.get(file).text.replace("Casa", "Casa de Alex"));
  assert.equal((await call("ws_undo_last_change", { path: u2.data.ref, version_id: u2.data.version_id })).code, "changed_since");
  // undo of a create removes it
  const c2 = await call("ws_cal_create_event", { calendar: "Menu", summary: "Temporal", start: "2026-10-14", end: "2026-10-14" });
  assert.equal((await call("ws_undo_last_change", { path: c2.data.ref, version_id: c2.data.version_id })).data.undone, "removed");
  assert.equal((await call("ws_cal_get_event", { calendar: "Menu", uid: c2.data.uid })).code, "event_not_found");
  assert.equal((await call("ws_undo_last_change", { path: c2.data.ref, version_id: "j1.zzzzzz-000000000000" })).code, "version_gone");
  const dir = join(home, "data", "workspace-tools", "journal");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const files = readdirSync(dir); assert.ok(files.length >= 6);
  for (const f of files) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
});

test("moving a TZID weekly series keeps local wall time across DST and keeps the TZID (review I7, R-CAL-MASTER)", async () => {
  const u = await call("ws_cal_update_event", { calendar: "Menu", uid: "cena-1", start: "2026-10-22T19:00:00-05:00", end: "2026-10-22T20:00:00-05:00" });
  assert.equal(u.success, true);
  const text = unfold(pim.calendars.get("menu_shared_by_admin").objects.get("cena.ics").text);
  assert.match(text, /DTSTART;TZID=America\/Chicago:20261022T190000\r\n/);
  assert.match(text, /DTEND;TZID=America\/Chicago:20261022T200000\r\n/);
  assert.match(text, /RRULE:FREQ=WEEKLY;COUNT=3/);
  const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z", query: "Cena" });
  assert.deepEqual(r.data.events.map((e) => e.start), ["2026-10-22T19:00:00-05:00", "2026-10-29T19:00:00-05:00", "2026-11-05T19:00:00-06:00"]);
  // a UTC-written new start on the far side of DST still lands on the zone's wall time
  await call("ws_cal_update_event", { calendar: "Menu", uid: "cena-1", start: "2026-11-06T00:30:00Z", end: "2026-11-06T01:30:00Z" });
  assert.match(unfold(pim.calendars.get("menu_shared_by_admin").objects.get("cena.ics").text), /DTSTART;TZID=America\/Chicago:20261105T183000\r\n/);
});

test("read-only calendar refuses writes with a clear code", async () => {
  assert.equal((await call("ws_cal_create_event", { calendar: "Feriados", summary: "x", start: "2026-10-10", end: "2026-10-11" })).code, "read_only");
});

test("respond_to_event finds crow-bot via calendar-user-address-set and sets its own PARTSTAT; not an attendee → error", async () => {
  pim.addEvent("menu_shared_by_admin", "inv.ics", cal("BEGIN:VEVENT", "UID:inv-1", "DTSTAMP:20261001T000000Z", "DTSTART:20261015T230000Z", "DTEND:20261016T000000Z", "SUMMARY:Junta", "ORGANIZER:mailto:casey@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alex@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:MAILTO:Crow-Bot@crow.test", "END:VEVENT"));
  const r = await call("ws_cal_respond_to_event", { calendar: "Menu", uid: "inv-1", response: "accepted" });
  assert.equal(r.success, true); assert.ok(r.data.version_id.startsWith("j1."));
  const t = unfold(pim.calendars.get("menu_shared_by_admin").objects.get("inv.ics").text);
  assert.match(t, /ATTENDEE;PARTSTAT=ACCEPTED:MAILTO:Crow-Bot@crow\.test/);
  assert.match(t, /ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alex@example\.org/);
  assert.equal((await call("ws_cal_respond_to_event", { calendar: "Menu", uid: "cena-1", response: "accepted" })).code, "not_attendee");
});

test("hrefs from the server are validated: an encoded '..' or a foreign collection is refused", async () => {
  for (const h of ["/remote.php/dav/calendars/crow-bot/menu_shared_by_admin/%2e%2e", "/remote.php/dav/calendars/crow-bot/feriados/x.ics", "/remote.php/dav/files/crow-bot/secret.ics", "/remote.php/dav/calendars/crow-bot/menu_shared_by_admin/a%2fb.ics"]) {
    pim.injectHrefs = [h];
    const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z" });
    assert.equal(r.code, "bad_path", h);
  }
});

test("journal first (review I12): if the journal cannot be written, the delete does not happen", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "No borrar", start: "2026-10-19", end: "2026-10-19" });
  const broken = join(home, "broken-data"); mkdirSync(broken); writeFileSync(join(broken, "workspace-tools"), "not a directory");
  const saved = process.env.CROW_DATA_DIR; process.env.CROW_DATA_DIR = broken; // the server runs in-process
  try {
    const d = await call("ws_cal_delete_event", { calendar: "Menu", uid: c.data.uid });
    assert.equal(d.success, false);
    assert.ok(pim.calendars.get("menu_shared_by_admin").objects.has(`${c.data.uid}.ics`), "event still there");
    assert.ok(!fake.calls.some((x) => x.method === "DELETE" && x.url.includes(c.data.uid)), "no DELETE was sent");
  } finally { process.env.CROW_DATA_DIR = saved; }
});

test("pruneJournal drops entries older than 30 days and keeps at most maxEntries", async () => {
  const { recordChange, pruneJournal, loadChange } = await import("../bundles/workspace/server/pim/journal.js");
  const dir = join(home, "data", "workspace-tools", "journal");
  const old = recordChange({ kind: "cal", ref: "cal:x/old", href: "/x", op: "update", before_text: "a", after_etag: "e" });
  const oldFile = join(dir, `${old.slice(3)}.json`); const t = (Date.now() - 31 * 86400000) / 1000; utimesSync(oldFile, t, t);
  const fresh = recordChange({ kind: "cal", ref: "cal:x/new", href: "/x", op: "update", before_text: "b", after_etag: "e" });
  assert.ok(pruneJournal() >= 1);
  assert.equal(loadChange(fresh).ref, "cal:x/new");
  assert.throws(() => loadChange(old), { code: "version_gone" });
  pruneJournal({ maxEntries: 1 });
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal(loadChange(fresh).ref, "cal:x/new", "the newest entry is the one kept");
});

const journalEntry = (versionId) => JSON.parse(readFileSync(join(home, "data", "workspace-tools", "journal", `${versionId.slice(3)}.json`), "utf8"));

test("T10-I2: a daily series since 2010 lists the window's 7 occurrences (TZID wall time kept); an hourly series since 2010 too", async () => {
  pim.addEvent("menu_shared_by_admin", "diario.ics", cal("BEGIN:VEVENT", "UID:diario-1", "DTSTAMP:20261001T000000Z", "DTSTART;TZID=America/Chicago:20100104T073000", "DTEND;TZID=America/Chicago:20100104T080000", "RRULE:FREQ=DAILY", "SUMMARY:Desayuno diario", "END:VEVENT"));
  const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-29T00:00:00-05:00", time_max: "2026-11-05T00:00:00-06:00", query: "Desayuno diario", max_results: 50 });
  assert.equal(r.data.truncated, undefined);
  assert.deepEqual(r.data.events.map((e) => e.start), ["2026-10-29T07:30:00-05:00", "2026-10-30T07:30:00-05:00", "2026-10-31T07:30:00-05:00", "2026-11-01T07:30:00-06:00", "2026-11-02T07:30:00-06:00", "2026-11-03T07:30:00-06:00", "2026-11-04T07:30:00-06:00"]);
  pim.addEvent("menu_shared_by_admin", "hora.ics", cal("BEGIN:VEVENT", "UID:hora-1", "DTSTAMP:20261001T000000Z", "DTSTART:20100101T001500Z", "DTEND:20100101T002000Z", "RRULE:FREQ=HOURLY;INTERVAL=6", "SUMMARY:Regar plantas", "END:VEVENT"));
  const h = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-29T00:00:00Z", time_max: "2026-10-30T00:00:00Z", query: "Regar" });
  assert.equal(h.data.truncated, undefined);
  assert.deepEqual(h.data.events.map((e) => e.start), ["2026-10-29T00:15:00Z", "2026-10-29T06:15:00Z", "2026-10-29T12:15:00Z", "2026-10-29T18:15:00Z"]);
});

test("T10-I2: a rule too dense to expand is flagged truncated with a warning naming the event", async () => {
  pim.addEvent("menu_shared_by_admin", "denso.ics", cal("BEGIN:VEVENT", "UID:denso-1", "DTSTAMP:20261001T000000Z", "DTSTART:20200101T000000Z", "DTEND:20200101T000001Z", "RRULE:FREQ=SECONDLY;BYMINUTE=0", "SUMMARY:Ping", "END:VEVENT"));
  const r = await call("ws_cal_list_events", { calendar: "Menu", time_min: "2026-10-29T00:00:00Z", time_max: "2026-10-30T00:00:00Z" });
  assert.equal(r.success, true); assert.equal(r.data.truncated, true);
  assert.ok(r.data.warnings.some((w) => w.includes('"Ping"') && w.includes("denso-1")), JSON.stringify(r.data.warnings));
  pim.calendars.get("menu_shared_by_admin").objects.delete("denso.ics");
});

test("T10-I3: after_etag comes from the PUT's ETag, so a person's edit right after the bot's write is never undone", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "Jueves: enchiladas", start: "2026-10-15", end: "2026-10-15" });
  const before = fake.calls.length;
  pim.afterPut = (col, file) => col.objects.set(file, { text: col.objects.get(file).text.replace("enchiladas", "enchiladas verdes (Alex)"), etag: pim.nextEtag() });
  const u = await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, summary: "Jueves: enchiladas rojas" });
  const e = journalEntry(u.data.version_id);
  assert.ok(e.after_etag); assert.equal(e.after_etag_posthoc, undefined);
  assert.ok(!fake.calls.slice(before).some((x) => x.method === "GET"), "no GET needed when the PUT answers with an ETag");
  assert.equal((await call("ws_undo_last_change", { path: u.data.ref, version_id: u.data.version_id })).code, "changed_since");
  assert.match(pim.calendars.get("menu_shared_by_admin").objects.get(`${c.data.uid}.ics`).text, /verdes \(Alex\)/, "the person's edit survives");
  // no ETag on the PUT → GET fallback, marked post-hoc
  pim.omitPutEtag = true;
  try {
    const u2 = await call("ws_cal_update_event", { calendar: "Menu", uid: c.data.uid, location: "Casa" });
    const e2 = journalEntry(u2.data.version_id);
    assert.ok(e2.after_etag); assert.equal(e2.after_etag_posthoc, true);
  } finally { pim.omitPutEtag = false; }
});

test("T10-I4: undo of a create that loses a DELETE race (412) answers changed_since", async () => {
  const c = await call("ws_cal_create_event", { calendar: "Menu", summary: "Viernes: pizza", start: "2026-10-16", end: "2026-10-16" });
  pim.failNext = { method: "DELETE", status: 412 };
  assert.equal((await call("ws_undo_last_change", { path: c.data.ref, version_id: c.data.version_id })).code, "changed_since");
  assert.ok(pim.calendars.get("menu_shared_by_admin").objects.has(`${c.data.uid}.ics`));
});
