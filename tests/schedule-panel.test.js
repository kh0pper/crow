/**
 * The Schedule panel (schedule panel PR 2): render, every POST action's effect and its 303, the
 * two-step delete, a refused create keeping what was typed, the bot-routine runner problem, the
 * briefing's link-only controls, owner-only writes, CSRF fields, 44 px targets and i18n parity.
 * Real init-db into a tmpdir (never ~/.crow).
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-sched-panel-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
process.env.CROW_DATA_DIR = tmpDir;
const { createDbClient } = await import("../servers/db.js");
const db = createDbClient(join(tmpDir, "crow.db"));
const { default: panel, schedulePreview, isOwnerRequest, _setBotGateForTest } = await import("../servers/gateway/dashboard/panels/schedule.js");
const { createHash } = await import("node:crypto");
const { cronNext } = await import("../servers/shared/schedule-core.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { SCHEDULE_CSS } = await import("../servers/gateway/dashboard/panels/schedule/css.js");
const { _setNowForTest } = await import("../servers/gateway/scheduler.js");
_setBotGateForTest({ engine: () => "ready", runtimeOn: async () => true });
after(() => { _setBotGateForTest(null); _setNowForTest(null); try { db.close(); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

beforeEach(async () => {
  await db.batch([
    "DELETE FROM schedules", "DELETE FROM schedule_runs", "DELETE FROM notifications", "DELETE FROM bot_jobs", "DELETE FROM pi_bot_defs",
    "DELETE FROM dashboard_settings WHERE key IN ('notification_prefs','media_briefing_config','instance_timezone','language','feature_flags')",
    "DELETE FROM dashboard_settings_overrides WHERE key IN ('notification_prefs','media_briefing_config','instance_timezone','language','feature_flags')",
  ]);
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC')", args: [] });
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)", args: [JSON.stringify({ bot_runtime: true })] });
  // Sessions as dashboard/auth.js stores them: a local password login and a peer sign-in (SSO).
  await db.execute("DELETE FROM oauth_tokens WHERE client_id = 'dashboard'");
  const hash = (t) => createHash("sha256").update(t).digest("hex");
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await db.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?), (?, 'access', 'dashboard', 'dashboard sso', ?)", args: [hash("sess-local"), until, hash("sess-sso"), until] });
});

async function seed(task, cron, nextRun, { tz = null, enabled = 1, description = null } = {}) {
  const r = await db.execute({ sql: "INSERT INTO schedules (task, cron_expression, next_run, tz, enabled, description) VALUES (?, ?, ?, ?, ?, ?)", args: [task, cron, nextRun, tz, enabled, description] });
  return Number(r.lastInsertRowid);
}

/** Call the handler like the dashboard router does. → { status, html, location, json } */
async function call({ method = "GET", query = {}, body = {}, lang = "en", session = "sess-local" } = {}) {
  const out = { status: 200, html: null, location: null, json: null };
  const req = { method, query, body, csrfToken: "tok123", dashboardSession: session || undefined };
  const res = {
    headersSent: false,
    status(n) { out.status = n; return this; },
    set() { return this; },
    json(v) { out.json = v; this.headersSent = true; },
    redirect(a, b) { out.status = typeof a === "number" ? a : 302; out.location = typeof a === "number" ? b : a; this.headersSent = true; },
    redirectAfterPost(url) { out.status = 303; out.location = url; this.headersSent = true; },
  };
  const layout = (o) => `<title>${o.title}</title>${o.content}`;
  const html = await panel.handler(req, res, { db, layout, lang });
  if (html !== undefined) out.html = html;
  return out;
}
const post = (body, opts = {}) => call({ method: "POST", body: { _csrf: "tok123", ...body }, ...opts });

test("manifest: route, icon, tools category, navOrder right after Skills' free slot", async () => {
  assert.equal(panel.id, "schedule");
  assert.equal(panel.route, "/dashboard/schedule");
  assert.equal(panel.icon, "schedule");
  assert.equal(panel.category, "tools");
  assert.equal(panel.navOrder, 41);
  const { appIconSvg } = await import("../servers/gateway/dashboard/shared/app-icons.js");
  assert.match(appIconSvg("schedule"), /<svg/);
  const idx = readFileSync(new URL("../servers/gateway/dashboard/index.js", import.meta.url), "utf8");
  assert.match(idx, /registerPanel\(skillsPanel\);\n\s*registerPanel\(schedulePanel\);/, "registered next to Skills");
  assert.match(idx, /router\.get\("\/dashboard\/schedule\/preview"/);
});

test("renders with no schedules: the green strip and the empty agenda", async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.match(r.html, /class="sc-attn ok"/);
  assert.match(r.html, /Everything is on schedule/);
  assert.match(r.html, /Nothing is scheduled/);
  const es = await call({ lang: "es" });
  assert.match(es.html, /Todo va según lo previsto/);
  assert.match(es.html, /<title>Agenda<\/title>/);
});

test("every POST form carries the CSRF field", async () => {
  await seed("reminder:stretch", "0 9 * * *", iso(Date.now() + HOUR));
  const id = (await all("SELECT id FROM schedules"))[0].id;
  const r = await call({ query: { id: `crow:${id}` } });
  const forms = r.html.match(/<form method="POST"[\s\S]*?<\/form>/g) || [];
  assert.ok(forms.length >= 4, `forms: ${forms.length}`);
  for (const f of forms) assert.match(f, /name="_csrf" value="tok123"/, f.slice(0, 120));
});

test("writes are owner-only: no session, a peer sign-in (SSO) session and a signed peer call get 403 and change nothing", async () => {
  const id = await seed("reminder:x", "0 9 * * *", iso(Date.now() + HOUR));
  for (const session of [null, "sess-sso", "not-a-session"]) {
    const r = await post({ action: "pause", id: String(id) }, { session });
    assert.equal(r.status, 403, String(session));
  }
  assert.equal((await all("SELECT enabled FROM schedules WHERE id = ?", [id]))[0].enabled, 1);
  assert.equal(await isOwnerRequest({ dashboardSession: "sess-local", crossHostAuth: true }), false);
  assert.equal(await isOwnerRequest({ dashboardSession: "sess-local" }), true);
  assert.equal((await post({ action: "pause", id: String(id) })).status, 303, "the local password session may write");
});

test("a repeated field (an array) is a 400, never a guess", async () => {
  const id = await seed("reminder:x", "0 9 * * *", iso(Date.now() + HOUR));
  const r = await post({ action: ["pause", "delete"], id: String(id) });
  assert.equal(r.status, 400);
});

test("create: 303 to the new row's detail; the detail shows it", async () => {
  const r = await post({ action: "create", text: "take the bins out", when: "every tuesday at 7", tz: "UTC", type: "reminder" });
  assert.equal(r.status, 303);
  const [row] = await all("SELECT * FROM schedules");
  assert.equal(r.location, `/dashboard/schedule?id=crow%3A${row.id}&done=created#sc-${row.id}`);
  assert.equal(row.task, "reminder:take the bins out");
  const d = await call({ query: { id: `crow:${row.id}`, done: "created" } });
  assert.match(d.html, /id="sc-detail"/);
  assert.match(d.html, /Every Tuesday at 7:00 AM/);
  assert.match(d.html, /Saved\. It runs at the time shown\./);
});

test("a refused create re-renders the sheet (422) with everything typed and the reason", async () => {
  const r = await post({ action: "create", text: "water the plants", when: "every 15 minutes", cron: "", tz: "Europe/Madrid" });
  assert.equal(r.status, 422);
  assert.match(r.html, /data-open-on-load/);
  assert.match(r.html, /value="water the plants"/);
  assert.match(r.html, /value="every 15 minutes"/);
  assert.match(r.html, /value="Europe\/Madrid" data-sc-tz/);
  assert.match(r.html, /role="alert"[^>]*>Reminders repeat at most once an hour/);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 0);
});

test("the no-JS Preview button renders the read-back and the next 3 runs without saving", async () => {
  const r = await post({ action: "preview", text: "stand up", when: "every weekday at 9", tz: "UTC" });
  assert.equal(r.status, 422);
  assert.match(r.html, /Every weekday at 9:00 AM/);
  assert.equal((r.html.match(/<ol class="sc-next">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length, 3);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 0);
});

test("the preview route answers JSON", async () => {
  let out;
  const res = { set() { return this; }, json(v) { out = v; } };
  await schedulePreview({ query: { when: "mañana a las 9", lang: "es", tz: "UTC" } }, res, db);
  assert.equal(out.ok, true);
  assert.match(out.summary, /^Una vez/);
  await schedulePreview({ query: { when: "whenever", lang: "en" } }, res, db);
  assert.equal(out.ok, false);
  assert.match(out.hint, /couldn't tell when/);
});

test("pause / resume / run now / dismiss: each effect and its 303", async () => {
  const id = await seed("reminder:stretch", "0 9 * * *", iso(Date.now() + HOUR));
  let r = await post({ action: "pause", id: String(id) });
  assert.equal(r.status, 303); assert.match(r.location, new RegExp(`id=crow%3A${id}&done=paused#sc-${id}$`));
  assert.equal((await all("SELECT enabled FROM schedules WHERE id = ?", [id]))[0].enabled, 0);
  r = await post({ action: "resume", id: String(id) });
  assert.match(r.location, /done=resumed/);
  assert.equal((await all("SELECT enabled FROM schedules WHERE id = ?", [id]))[0].enabled, 1);
  r = await post({ action: "run-now", id: String(id) });
  assert.match(r.location, /done=ran/);
  assert.equal((await all("SELECT COUNT(*) AS n FROM notifications WHERE source = 'scheduler'"))[0].n, 1);
  const run = await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, scheduled_for) VALUES (?, 'missed', '2026-10-20T09:00:00.000Z')", args: [id] });
  r = await post({ action: "ack-run", run: String(Number(run.lastInsertRowid)) });
  assert.match(r.location, /done=dismissed/);
  assert.ok((await all("SELECT acknowledged_at FROM schedule_runs WHERE id = ?", [Number(run.lastInsertRowid)]))[0].acknowledged_at);
});

test("resume refuses a one-shot whose time has passed, with the reason in the detail", async () => {
  const id = await seed("reminder:x", "@once", "2026-01-01T09:00:00.000Z", { enabled: 0 });
  const r = await post({ action: "resume", id: String(id) });
  assert.match(r.location, /error=once-passed/);
  const d = await call({ query: { id: `crow:${id}`, error: "once-passed" } });
  assert.match(d.html, /role="alert"[^>]*>Its time has passed\. Pick a new time/);
});

test("delete is two steps: without confirm=1 nothing changes and the pane asks; confirm=1 deletes", async () => {
  const id = await seed("reminder:old habit", "0 9 * * *", iso(Date.now() + HOUR));
  let r = await post({ action: "delete", id: String(id) });
  assert.equal(r.status, 303);
  assert.match(r.location, /confirm=delete/);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 1, "nothing deleted yet");
  const c = await call({ query: { id: `crow:${id}`, confirm: "delete" } });
  assert.match(c.html, /id="sc-confirm-text"[^>]*>Delete “old habit”\? Its run history goes too\./);
  assert.match(c.html, /name="confirm" value="1"/);
  r = await post({ action: "delete", id: String(id), confirm: "1" });
  assert.equal(r.location, "/dashboard/schedule?done=deleted");
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 0);
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/schedule/html.js", import.meta.url), "utf8") + readFileSync(new URL("../servers/gateway/dashboard/panels/schedule.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bconfirm\(/, "no window.confirm in the delete path");
  assert.doesNotMatch(src, /onsubmit=/);
});

test("a bot routine with no runner shows the problem with Run now and Pause; Run now queues a job", async () => {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('lab-triage', 'Lab triage', '{}', 1)", args: [] });
  const id = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(Date.now() - 3 * HOUR), { description: JSON.stringify({ goal: "triage" }) });
  const r = await call();
  assert.match(r.html, /Waiting for a runner: bot routines don&#39;t start on their own|Waiting for a runner: bot routines don't start on their own/);
  const strip = r.html.match(/<section class="sc-attn"[\s\S]*?<\/section>/)[0];
  assert.match(strip, /name="action" value="run-now"[\s\S]*Run now/);
  assert.match(strip, /name="action" value="pause"[\s\S]*Pause/);
  const q = await post({ action: "run-now", id: String(id) });
  assert.match(q.location, /done=queued/);
  assert.equal((await all("SELECT COUNT(*) AS n FROM bot_jobs WHERE schedule_id = ?", [id]))[0].n, 1);
  const again = await post({ action: "run-now", id: String(id) });
  assert.match(again.location, /done=already-queued/);
});

test("the create sheet sends bot routines to Bot Builder", async () => {
  const r = await call({ query: { new: "1" } });
  const sheet = r.html.match(/<dialog id="sc-create"[\s\S]*?<\/dialog>/)[0];
  assert.match(sheet, /href="\/dashboard\/bot-builder"[^>]*>Bot routine<span class="sc-muted"> · made in Bot Builder/);
  assert.doesNotMatch(sheet, /value="bot_routine"/);
});

test("a briefing's controls are all links to News → Briefings (no POST); its POSTs are refused", async () => {
  const id = await seed("media:briefing", "0 7 * * *", iso(Date.now() + HOUR));
  const r = await call({ query: { id: `crow:${id}` } });
  const pane = r.html.match(/<div class="sc-detail"[\s\S]*?<div class="sc-d-sec"><b>Next runs/)[0];
  assert.doesNotMatch(pane, /<form/);
  assert.equal((pane.match(/href="\/dashboard\/media\?tab=briefings"/g) || []).length, 3);
  for (const action of ["pause", "resume", "run-now"]) {
    const p = await post({ action, id: String(id) });
    assert.match(p.location, /error=owned/);
  }
  const del = await post({ action: "delete", id: String(id), confirm: "1" });
  assert.match(del.location, /error=owned/);
  assert.equal((await all("SELECT COUNT(*) AS n FROM schedules"))[0].n, 1);
});

test("?run=<id> (a notification's link) opens that run's schedule", async () => {
  const id = await seed("reminder:stretch", "0 9 * * *", iso(Date.now() + HOUR));
  const run = await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, scheduled_for, missed_count) VALUES (?, 'missed', '2026-10-20T09:00:00.000Z', 1)", args: [id] });
  const r = await call({ query: { run: String(Number(run.lastInsertRowid)) } });
  assert.match(r.html, /id="sc-detail"/);
  assert.match(r.html, /<h2 id="sc-detail-h" tabindex="-1">stretch<\/h2>/);
  assert.match(r.html, /Missed the .* run while Crow wasn/);
});

test("an unknown ?id= or ?run= redirects to the plain page with a note", async () => {
  assert.equal((await call({ query: { id: "crow:99999" } })).location, "/dashboard/schedule?error=not-found");
  assert.equal((await call({ query: { run: "99999" } })).location, "/dashboard/schedule?error=not-found");
  const r = await call({ query: { error: "not-found" } });
  assert.match(r.html, /role="alert">That schedule no longer exists\./);
});

const stripOf = (html) => (html.match(/<section class="sc-attn[\s\S]*?<\/section>/) || [""])[0];
const reminderNotes = async () => (await all("SELECT COUNT(*) AS n FROM notifications WHERE source = 'scheduler'"))[0].n;

test("Run now on a missed run: posts its run id, sends once, clears the strip; a second click sends nothing", async () => {
  const id = await seed("reminder:stretch", "0 9 * * *", iso(Date.now() + HOUR));
  const run = Number((await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, scheduled_for, missed_count) VALUES (?, 'missed', '2026-10-20T09:00:00.000Z', 1)", args: [id] })).lastInsertRowid);
  const strip = stripOf((await call()).html);
  assert.match(strip, new RegExp(`name="action" value="run-now"><input type="hidden" name="id" value="${id}"><input type="hidden" name="run" value="${run}">`));
  const first = await post({ action: "run-now", id: String(id), run: String(run) });
  assert.match(first.location, /done=ran/);
  assert.equal(await reminderNotes(), 1);
  assert.match(stripOf((await call()).html), /Everything is on schedule/);
  const second = await post({ action: "run-now", id: String(id), run: String(run) });
  assert.match(second.location, /done=already-done/);
  assert.equal(await reminderNotes(), 1, "the second click does not send again");
});

test("Run now on a missed run that fails keeps the problem (the claim is undone)", async () => {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('off-bot', 'Off', '{}', 0)", args: [] });
  const id = await seed("pipeline:botcron:off-bot", "0 9 * * *", iso(Date.now() + HOUR), { description: JSON.stringify({ goal: "x" }) });
  const run = Number((await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, scheduled_for, missed_count) VALUES (?, 'missed', '2026-10-20T09:00:00.000Z', 1)", args: [id] })).lastInsertRowid);
  const r = await post({ action: "run-now", id: String(id), run: String(run) });
  assert.match(r.location, /error=cant-run/);
  assert.equal((await all("SELECT acknowledged_at FROM schedule_runs WHERE id = ?", [run]))[0].acknowledged_at, null);
});

test("Turn back on after an upgrade pause: resumes, clears the strip; a second click is a no-op", async () => {
  const id = await seed("check the logs", "0 * * * *", null, { enabled: 0 });
  const run = Number((await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status, source, scheduled_for, detail) VALUES (?, 'paused', 'upgrade', 'upgrade:0009', ?)", args: [id, JSON.stringify({ reason: "frequent", every_min: 5 })] })).lastInsertRowid);
  assert.match(stripOf((await call()).html), new RegExp(`value="resume"><input type="hidden" name="id" value="${id}"><input type="hidden" name="run" value="${run}">`));
  assert.match((await post({ action: "resume", id: String(id), run: String(run) })).location, /done=resumed/);
  const [row] = await all("SELECT enabled, next_run FROM schedules WHERE id = ?", [id]);
  assert.equal(row.enabled, 1); assert.ok(row.next_run);
  assert.match(stripOf((await call()).html), /Everything is on schedule/);
  await db.execute({ sql: "UPDATE schedules SET enabled = 0 WHERE id = ?", args: [id] });
  assert.match((await post({ action: "resume", id: String(id), run: String(run) })).location, /done=already-done/);
  assert.equal((await all("SELECT enabled FROM schedules WHERE id = ?", [id]))[0].enabled, 0, "the second click changed nothing");
});

test("a run id that belongs to another schedule settles nothing", async () => {
  const a = await seed("reminder:a", "0 9 * * *", iso(Date.now() + HOUR));
  const b = await seed("reminder:b", "0 9 * * *", iso(Date.now() + HOUR));
  const run = Number((await db.execute({ sql: "INSERT INTO schedule_runs (schedule_id, status) VALUES (?, 'missed')", args: [b] })).lastInsertRowid);
  assert.match((await post({ action: "run-now", id: String(a), run: String(run) })).location, /done=already-done/);
  assert.equal(await reminderNotes(), 0);
  assert.equal((await all("SELECT acknowledged_at FROM schedule_runs WHERE id = ?", [run]))[0].acknowledged_at, null);
});

test("Run now on a bot routine when the bot runtime is off (or no engine) is refused, never 'Queued'", async () => {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('lab-triage', 'Lab triage', '{}', 1)", args: [] });
  const id = await seed("pipeline:botcron:lab-triage", "0 9 * * *", iso(Date.now() + HOUR), { description: JSON.stringify({ goal: "triage" }) });
  for (const gate of [{ runtimeOn: async () => false }, { engine: () => "absent" }]) {
    _setBotGateForTest({ engine: () => "ready", runtimeOn: async () => true, ...gate });
    try {
      const r = await post({ action: "run-now", id: String(id) });
      assert.match(r.location, /error=cant-run/);
    } finally { _setBotGateForTest({ engine: () => "ready", runtimeOn: async () => true }); }
  }
  assert.equal((await all("SELECT COUNT(*) AS n FROM bot_jobs"))[0].n, 0);
});

test("a day row in another zone whose local date differs from its day group shows its weekday", async () => {
  const now = Date.now();
  const next = cronNext("0 9 * * *", "Pacific/Kiritimati", now); // UTC+14: 09:00 there is 19:00 UTC the day before
  const id = await seed("reminder:island call", "0 9 * * *", iso(next), { tz: "Pacific/Kiritimati" });
  const html = (await call()).html;
  const at = html.match(new RegExp(`id="sc-${id}"><a class="sc-hit"[^>]*><span class="sc-at">([\\s\\S]*?)</span>`))[1];
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Kiritimati", weekday: "short" }).format(new Date(next));
  assert.match(at, new RegExp(`${weekday} 9:00 AM`), at);
  const local = await seed("reminder:here", "0 15 * * *", iso(cronNext("0 15 * * *", "UTC", now)));
  const at2 = (await call()).html.match(new RegExp(`id="sc-${local}"><a class="sc-hit"[^>]*><span class="sc-at">([\\s\\S]*?)</span>`))[1];
  assert.match(at2, />3:00 PM</, "same date: time only");
});

test("every button, link-button, switch and summary sits in a ≥ 44px rule", () => {
  const css = SCHEDULE_CSS;
  const minH = (sel) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{]*\\{[^}]*min-height:\\s*(4[4-9]|[5-9]\\d)px").test(css);
  for (const sel of [".sc-page .btn", ".sc-page .btn-sm", ".sc-close", ".sc-switch", ".sc-hit", ".sc-fold-h", ".sc-filter", ".sc-attn-name", ".sc-type", ".sc-input", ".sc-adv > summary"]) {
    assert.ok(minH(sel), `${sel} has min-height ≥ 44px`);
  }
  assert.match(css, /bottom: calc\(var\(--crow-player-h, 0px\) \+ 12px\)/, "the toast clears the player bar");
  assert.match(css, /max-height: calc\(100dvh - var\(--crow-player-h, 0px\)/, "the pane and sheet clear the player bar");
  assert.match(css, /\.sc-dialog \{[^}]*z-index: 1200/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/, "Perch tokens only, no hex colours");
});

test("i18n: every schedule.* key has en and es, different, with the same placeholders", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("schedule.") || k === "nav.schedule");
  assert.ok(keys.length > 100);
  for (const k of keys) {
    const { en, es } = translations[k];
    assert.ok(en && es && en !== es, k);
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    assert.equal(ph(en), ph(es), k);
  }
  // Every key the panel names exists.
  const src = ["schedule.js", "schedule/html.js"].map((f) => readFileSync(new URL(`../servers/gateway/dashboard/panels/${f}`, import.meta.url), "utf8")).join("\n");
  for (const m of src.matchAll(/t\("(schedule\.[\w.-]+)"/g)) assert.ok(translations[m[1]], `missing ${m[1]}`);
  for (const s of ["ok", "late", "failed", "requested", "running", "paused", "job-queued", "job-running", "job-completed", "job-failed"]) assert.ok(translations[`schedule.run.${s}`], s);
  for (const s of ["no-bot", "voice-bot", "bot-missing", "bot-disabled", "no-goal"]) assert.ok(translations[`schedule.p.cant.${s}`], s);
  for (const s of ["ready", "failed", "generating", "other"]) assert.ok(translations[`schedule.briefing.${s}`], s);
});
