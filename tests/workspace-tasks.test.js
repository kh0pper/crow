import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { installFakePim } from "./helpers/workspace-fake-pim.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const unfold = (s) => s.replace(/\r\n[ \t]/g, "");
let fake, pim, client, call, close, puts;
before(async () => {
  fake = await startFakeNextcloud(); pim = installFakePim(fake);
  const inner = fake.extraRoutes; puts = [];
  fake.extraRoutes = async (req, res, body, h) => { if (req.method === "PUT") puts.push({ url: req.url, headers: req.headers, body: body.toString() }); return inner(req, res, body, h); };
  pim.addCalendar("tareas", "Tareas", { components: ["VTODO"] });
  pim.addCalendar("mixto", "Mixto", { components: ["VEVENT", "VTODO"] });
  pim.addCalendar("sinset", "Sin conjunto", { components: null });
  pim.addCalendar("solo-lectura", "Solo lectura", { components: ["VTODO"], writable: false });
  pim.addCalendar("agenda", "Agenda"); // VEVENT only
  ({ client, call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("event-only calendars are not task lists; no declared set counts for both; calendars keep their old listing", async () => {
  const t = await call("ws_tasks_list_lists", {});
  assert.deepEqual(t.data.lists.map((l) => [l.id, l.name, l.writable]), [["tareas", "Tareas", true], ["mixto", "Mixto", true], ["sinset", "Sin conjunto", true], ["solo-lectura", "Solo lectura", false]]);
  const c = await call("ws_cal_list_calendars", {});
  assert.deepEqual(c.data.calendars.map((x) => x.id), ["mixto", "sinset", "agenda"], "VEVENT default unchanged: the VTODO-only lists stay out");
  const nope = await call("ws_task_create", { list: "Agenda", summary: "x" });
  assert.equal(nope.success, false); assert.equal(nope.code, "calendar_not_found"); assert.match(nope.error, /task list/);
});

test("create writes one VTODO with If-None-Match, DUE as a date or UTC date-time, and escaped text", async () => {
  puts.length = 0;
  const r = await call("ws_task_create", { list: "Tareas", summary: "Comprar leche, pan; huevos", due: "2026-10-22", description: "linea 1\nlinea 2, con coma" });
  assert.equal(r.success, true); assert.match(r.data.ref, /^cal:tareas\//); assert.equal(r.data.ref, `cal:tareas/${r.data.uid}`);
  assert.ok(r.data.version_id.startsWith("j1.")); assert.equal(r.data.list, "Tareas");
  assert.equal(puts.length, 1); assert.equal(puts[0].headers["if-none-match"], "*");
  const body = unfold(puts[0].body);
  assert.match(body, /BEGIN:VTODO/); assert.match(body, /DUE;VALUE=DATE:20261022\r\n/);
  assert.ok(body.includes("SUMMARY:Comprar leche\\, pan\\; huevos")); assert.ok(body.includes("DESCRIPTION:linea 1\\nlinea 2\\, con coma"));
  assert.match(body, new RegExp(`UID:${r.data.uid}`)); assert.doesNotMatch(body, /BEGIN:VEVENT/);
  const dt = await call("ws_task_create", { list: "Mixto", summary: "Llamar", due: "2026-10-22T18:00:00-05:00" });
  assert.equal(dt.success, true);
  assert.match(puts.at(-1).body, /DUE:20261022T230000Z\r\n/);
  const none = await call("ws_task_create", { list: "sinset", summary: "sin fecha" });
  assert.equal(none.success, true); assert.doesNotMatch(puts.at(-1).body, /\r\nDUE/);
  assert.equal((await call("ws_task_create", { list: "Tareas", summary: "x", due: "2026-10-22T18:00" })).code, "bad_time");
  const empty = await client.callTool({ name: "ws_task_create", arguments: { list: "Tareas", summary: "" } });
  assert.equal(empty.isError, true, "an empty summary is refused by the schema");
});

test("a read-only list is refused with read_only before any write", async () => {
  puts.length = 0;
  const r = await call("ws_task_create", { list: "Solo lectura", summary: "no" });
  assert.equal(r.success, false); assert.equal(r.code, "read_only"); assert.equal(puts.length, 0);
});

test("undo deletes it through the existing undo tool", async () => {
  const r = await call("ws_task_create", { list: "Tareas", summary: "Deshacer esto" });
  assert.equal([...pim.calendars.get("tareas").objects.values()].some((o) => o.text.includes("Deshacer esto")), true);
  const u = await call("ws_undo_last_change", { path: r.data.ref, version_id: r.data.version_id });
  assert.equal(u.success, true); assert.equal(u.data.undone, "removed");
  assert.equal([...pim.calendars.get("tareas").objects.values()].some((o) => o.text.includes("Deshacer esto")), false);
});
