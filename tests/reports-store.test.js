// The reports store and the daily caps: a report row, its recipe revisions, its own key/value state,
// its approval audit trail, and the counters that bound what a report can spend in a day. Every test
// works in a scratch DB built from REPORTS_DDL with its own dashboard_settings table, so nothing
// touches a real Crow data dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { REPORTS_DDL } from "../servers/shared/reports-schema.js";
import { recipeHash, sourcesHash } from "../servers/gateway/reports/recipe-hash.js";
import {
  APPROVAL_DECISIONS, EMPTY_RECIPE_JSON, REPORT_AUTHOR_KINDS, createReport, getReport, getRevision,
  getState, listReports, recordAudit, saveRecipe, setState, updateReportColumns,
} from "../servers/gateway/reports/store.js";
import {
  CAP_DEFAULTS, CAP_KEYS, addUsage, capState, dayInTz, getCaps, getUsage,
} from "../servers/gateway/reports/caps.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const T0 = 1_700_000_000_000;
const PROJECT = 7;

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-reports-store-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(REPORTS_DDL);
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

async function makeReport(db, overrides = {}) {
  const { id } = await createReport(db, {
    projectId: PROJECT,
    owner: "owner",
    botId: "bot-1",
    title: "Weekly listings",
    ...overrides,
  });
  return id;
}

function recipe(...blocks) {
  return { blocks };
}

const MAIL_RECIPE = recipe(
  { type: "mail_list", settings: { account: "ma-1", label: "Inbox", sinceDays: 7 } },
  { type: "columns", settings: { columns: ["subject", "date"] } },
);

async function countRows(db, table) {
  const { rows } = await db.execute({ sql: `SELECT count(*) AS n FROM ${table}`, args: [] });
  return Number(rows[0].n);
}

async function setSetting(db, key, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

/* --------------------------------------------------------------------------- the report row */

test("createReport makes a draft at revision 0 with an empty recipe and no revision row", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  assert.match(id, /^rpt-[0-9a-f]{16}$/);

  const report = await getReport(db, id);
  assert.equal(report.id, id);
  assert.equal(report.project_id, PROJECT);
  assert.equal(report.owner, "owner");
  assert.equal(report.bot_id, "bot-1");
  assert.equal(report.title, "Weekly listings");
  assert.equal(report.status, "draft");
  assert.equal(report.recipe_rev, 0);
  assert.equal(report.recipe_json, EMPTY_RECIPE_JSON);
  assert.equal(report.recipe_hash, null);
  assert.equal(report.sources_hash, null);
  assert.equal(report.ai_commentary, 0);
  assert.equal(report.comment_visibility, "own");
  assert.equal(report.comment_tier_default, "c");
  assert.equal(report.delivery_mode, "email_link");
  assert.equal(report.notify_every_run, 0);
  assert.equal(report.pending_free_change, 0);
  assert.equal(report.live_rev, null);
  assert.equal(report.live_seal, null);
  assert.equal(typeof report.created_at, "number");
  assert.equal(typeof report.updated_at, "number");
  assert.equal(await countRows(db, "report_recipe_revisions"), 0,
    "revision 0 is not a row: nothing has been saved yet");
  assert.equal(await getRevision(db, id, 0), null);
});

test("createReport refuses a bad project, owner or title", async () => {
  const db = await freshDb();
  const ok = { projectId: PROJECT, owner: "owner", title: "Weekly listings" };
  for (const fields of [
    { ...ok, projectId: "7" }, { ...ok, projectId: null }, { ...ok, projectId: 1.5 },
    { ...ok, owner: "" }, { ...ok, owner: 7 }, { ...ok, title: "  " }, { ...ok, title: null },
    { ...ok, botId: 7 },
  ]) {
    await assert.rejects(() => createReport(db, fields), { code: "bad_input" });
  }
  assert.equal(await countRows(db, "reports"), 0);
});

test("createReport stores an empty bot id as no bot at all", async () => {
  const db = await freshDb();
  const blank = await makeReport(db, { botId: "" });
  assert.equal((await getReport(db, blank)).bot_id, null, "the empty string is not a bot id");
  const named = await makeReport(db, { botId: "bot-1" });
  assert.equal((await getReport(db, named)).bot_id, "bot-1");
  const none = await makeReport(db, { botId: null });
  assert.equal((await getReport(db, none)).bot_id, null);
});

test("getReport answers null for a missing or unusable id", async () => {
  const db = await freshDb();
  assert.equal(await getReport(db, "rpt-0000000000000000"), null);
  assert.equal(await getReport(db, ""), null);
  assert.equal(await getReport(db, null), null);
});

test("listReports is newest first, narrows to a project and leaves the recipe body out", async () => {
  const db = await freshDb();
  const older = await makeReport(db, { title: "Older" });
  const newer = await makeReport(db, { title: "Newer" });
  const elsewhere = await makeReport(db, { projectId: 9, title: "Elsewhere" });
  await db.execute({ sql: "UPDATE reports SET created_at = ? WHERE id = ?", args: [T0, older] });
  await db.execute({ sql: "UPDATE reports SET created_at = ? WHERE id = ?", args: [T0 + 1000, newer] });
  await db.execute({ sql: "UPDATE reports SET created_at = ? WHERE id = ?", args: [T0 + 2000, elsewhere] });

  const mine = await listReports(db, { projectId: PROJECT });
  assert.deepEqual(mine.map((r) => r.id), [newer, older], "newest first, one project only");
  for (const row of mine) {
    assert.ok(!Object.hasOwn(row, "recipe_json"), "a list row carries no recipe body");
    assert.equal(row.status, "draft");
    assert.equal(typeof row.recipe_rev, "number");
  }
  const all = await listReports(db);
  assert.deepEqual(all.map((r) => r.id), [elsewhere, newer, older]);
  await assert.rejects(() => listReports(db, { projectId: "7" }), { code: "bad_input" });
});

/* ------------------------------------------------------------------------------ saveRecipe */

test("saveRecipe writes revision 1 and moves the head in one step", async () => {
  const db = await freshDb();
  const id = await makeReport(db);

  const saved = await saveRecipe(db, {
    reportId: id, recipe: MAIL_RECIPE, authorKind: "owner", now: T0 + 5,
  });
  assert.deepEqual(saved, {
    rev: 1,
    hash: recipeHash(MAIL_RECIPE),
    sourcesHash: sourcesHash(MAIL_RECIPE, null),
  });

  const report = await getReport(db, id);
  assert.equal(report.recipe_rev, 1);
  assert.equal(report.recipe_hash, saved.hash);
  assert.equal(report.sources_hash, saved.sourcesHash);
  assert.equal(report.updated_at, T0 + 5);
  assert.deepEqual(JSON.parse(report.recipe_json), MAIL_RECIPE, "the head carries the saved recipe");

  const revision = await getRevision(db, id, 1);
  assert.equal(revision.report_id, id);
  assert.equal(revision.rev, 1);
  assert.equal(revision.author_kind, "owner");
  assert.equal(revision.recipe_hash, saved.hash);
  assert.equal(revision.sources_hash, saved.sourcesHash);
  assert.equal(revision.created_at, T0 + 5);
  assert.equal(await countRows(db, "report_recipe_revisions"), 1);
});

test("a second save is revision 2 and keeps revision 1 as it was", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  const first = await saveRecipe(db, { reportId: id, recipe: MAIL_RECIPE, authorKind: "bot", now: T0 });
  const next = recipe({ type: "mail_list", settings: { account: "ma-1", label: "Archive" } });
  const second = await saveRecipe(db, { reportId: id, recipe: next, authorKind: "owner", now: T0 + 10 });

  assert.equal(first.rev, 1);
  assert.equal(second.rev, 2);
  const one = await getRevision(db, id, 1);
  assert.equal(one.author_kind, "bot");
  assert.deepEqual(JSON.parse(one.recipe_json), MAIL_RECIPE);
  const two = await getRevision(db, id, 2);
  assert.equal(two.author_kind, "owner");
  assert.deepEqual(JSON.parse(two.recipe_json), next);
  const report = await getReport(db, id);
  assert.equal(report.recipe_rev, 2);
  assert.equal(report.recipe_hash, second.hash);
  assert.deepEqual(JSON.parse(report.recipe_json), next);
  assert.equal(await countRows(db, "report_recipe_revisions"), 2);
});

test("the saved recipe is stored canonically, so key order cannot fork a revision", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  const ordered = recipe({ type: "mail_list", settings: { account: "ma-1", sinceDays: 7 } });
  const jumbled = recipe({ settings: { sinceDays: 7, account: "ma-1" }, type: "mail_list" });
  const a = await saveRecipe(db, { reportId: id, recipe: ordered, authorKind: "owner" });
  const b = await saveRecipe(db, { reportId: id, recipe: jumbled, authorKind: "owner" });
  assert.equal(a.hash, b.hash);
  const report = await getReport(db, id);
  assert.equal(report.recipe_json, '{"blocks":[{"settings":{"account":"ma-1","sinceDays":7},"type":"mail_list"}]}');
});

test("saveRecipe refuses a bad author kind or a bad recipe and writes nothing", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  await saveRecipe(db, { reportId: id, recipe: MAIL_RECIPE, authorKind: "owner", now: T0 });
  const head = await getReport(db, id);

  assert.deepEqual([...REPORT_AUTHOR_KINDS], ["owner", "bot"]);
  for (const authorKind of ["human", "", null, "OWNER"]) {
    await assert.rejects(
      () => saveRecipe(db, { reportId: id, recipe: MAIL_RECIPE, authorKind, now: T0 + 1 }),
      { code: "bad_author_kind" },
    );
  }
  for (const recipe of [null, {}, { blocks: null }, { blocks: [{ settings: {} }] }]) {
    await assert.rejects(
      () => saveRecipe(db, { reportId: id, recipe, authorKind: "owner", now: T0 + 1 }),
      { code: "bad_recipe" },
    );
  }
  const after = await getReport(db, id);
  assert.equal(after.recipe_rev, head.recipe_rev, "the head did not move");
  assert.equal(after.recipe_hash, head.recipe_hash);
  assert.equal(after.updated_at, head.updated_at);
  assert.equal(await countRows(db, "report_recipe_revisions"), 1, "no revision was written");
});

test("saveRecipe on a missing report throws not_found and writes nothing", async () => {
  const db = await freshDb();
  await assert.rejects(
    () => saveRecipe(db, { reportId: "rpt-0011223344556677", recipe: MAIL_RECIPE, authorKind: "owner" }),
    { code: "not_found" },
  );
  await assert.rejects(
    () => saveRecipe(db, { reportId: "not a report id", recipe: MAIL_RECIPE, authorKind: "owner" }),
    { code: "bad_input" },
  );
  assert.equal(await countRows(db, "report_recipe_revisions"), 0);
});

/* ----------------------------------------------------------------------------------- state */

test("report state is read, written and overwritten as JSON", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  assert.equal(await getState(db, id, "diff_baseline"), null, "a key nobody wrote is null");

  const first = await setState(db, id, "diff_baseline", { ids: ["a", "b"], seenAt: T0 });
  assert.deepEqual(first.value, { ids: ["a", "b"], seenAt: T0 });
  assert.deepEqual(await getState(db, id, "diff_baseline"), { ids: ["a", "b"], seenAt: T0 });

  await setState(db, id, "diff_baseline", { ids: ["c"], seenAt: T0 + 60_000 });
  assert.deepEqual(await getState(db, id, "diff_baseline"), { ids: ["c"], seenAt: T0 + 60_000 });
  assert.equal(await countRows(db, "report_state"), 1, "the write is an upsert, not a second row");

  await setState(db, id, "unread_count", 0);
  assert.equal(await getState(db, id, "unread_count"), 0);
  assert.equal(await countRows(db, "report_state"), 2);

  await assert.rejects(() => setState(db, id, "", 1), { code: "bad_input" });
  await assert.rejects(() => setState(db, "rpt-0011223344556677", "k", 1), { code: "not_found" });
  assert.equal(await getState(db, id, ""), null);
});

/* ------------------------------------------------------------------------- head columns */

test("updateReportColumns writes only the columns the approvals module owns", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  await db.execute({ sql: "UPDATE reports SET updated_at = ? WHERE id = ?", args: [T0, id] });

  const updated = await updateReportColumns(db, id, {
    status: "paused",
    pause_reason: "You changed settings. Preview and go live again.",
    pending_free_change: 1,
    live_seal: null,
  });
  assert.equal(updated.status, "paused");
  assert.equal(updated.pause_reason, "You changed settings. Preview and go live again.");
  assert.equal(updated.pending_free_change, 1);
  assert.ok(updated.updated_at > T0, "updated_at moves with the write");

  for (const forbidden of ["recipe_json", "recipe_rev", "id", "project_id", "owner", "created_at",
    "not_a_column"]) {
    await assert.rejects(
      () => updateReportColumns(db, id, { [forbidden]: 1 }),
      { code: "unknown_column" },
      `${forbidden} is not writable here`,
    );
  }
  assert.equal((await getReport(db, id)).status, "paused", "a refused write changed nothing");
  await assert.rejects(() => updateReportColumns(db, id, {}), { code: "bad_input" });
  await assert.rejects(() => updateReportColumns(db, "rpt-0011223344556677", { status: "live" }),
    { code: "not_found" });
});

/* ---------------------------------------------------------------------------------- audit */

test("an approval decision appends to the audit trail", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  assert.deepEqual([...APPROVAL_DECISIONS], ["approved", "refused", "revoked"]);

  const approved = await recordAudit(db, {
    reportId: id, kind: "recipient", subject: "sam@example.com", actor: "owner", decided: "approved", at: T0,
  });
  assert.ok(Number.isInteger(approved.id) && approved.id > 0);

  const refused = await recordAudit(db, {
    reportId: id, kind: "host", subject: "api.example.test", actor: { kind: "owner" },
    decided: "refused", at: T0 + 1,
  });
  assert.ok(refused.id > approved.id, "each decision gets its own row");

  const { rows } = await db.execute({
    sql: `SELECT report_id, kind, subject, actor, decided, at FROM report_approvals_audit
          ORDER BY id`,
    args: [],
  });
  assert.deepEqual(rows, [
    {
      report_id: id, kind: "recipient", subject: "sam@example.com", actor: "owner",
      decided: "approved", at: T0,
    },
    {
      report_id: id, kind: "host", subject: "api.example.test", actor: '{"kind":"owner"}',
      decided: "refused", at: T0 + 1,
    },
  ]);
  assert.equal(await countRows(db, "report_approvals_audit"), 2);
});

test("recordAudit refuses a bad decision and a missing report", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  for (const decided of ["approved ", "APPROVED", "maybe", null]) {
    await assert.rejects(
      () => recordAudit(db, { reportId: id, kind: "recipient", decided }),
      { code: "bad_input" },
    );
  }
  await assert.rejects(
    () => recordAudit(db, { reportId: id, kind: "", decided: "approved" }),
    { code: "bad_input" },
  );
  await assert.rejects(
    () => recordAudit(db, { reportId: "rpt-0011223344556677", kind: "host", decided: "approved" }),
    { code: "not_found" },
  );
  assert.equal(await countRows(db, "report_approvals_audit"), 0, "a refused audit writes no row");
});

/* ----------------------------------------------------------------------------------- caps */

test("the caps are the documented defaults until an operator overrides one", async () => {
  const db = await freshDb();
  assert.deepEqual(await getCaps(db), {
    maxEmailsPerReportDay: 50,
    maxCommentsPerRecipientDay: 20,
    maxBotMinutesPerReportDay: 30,
    maxExtraStepRunsPerReportDay: 10,
  });
  assert.deepEqual(CAP_DEFAULTS, await getCaps(db));
  assert.deepEqual(CAP_KEYS, {
    maxEmailsPerReportDay: "reports.max_emails_per_report_day",
    maxCommentsPerRecipientDay: "reports.max_comments_per_recipient_day",
    maxBotMinutesPerReportDay: "reports.max_bot_minutes_per_report_day",
    maxExtraStepRunsPerReportDay: "reports.max_extra_step_runs_per_report_day",
  });

  await setSetting(db, CAP_KEYS.maxEmailsPerReportDay, "3");
  await setSetting(db, CAP_KEYS.maxBotMinutesPerReportDay, "12.5");
  const caps = await getCaps(db);
  assert.equal(caps.maxEmailsPerReportDay, 3);
  assert.equal(caps.maxBotMinutesPerReportDay, 12.5);
  assert.equal(caps.maxCommentsPerRecipientDay, 20, "an untouched cap stays the default");
});

test("a cap override that is not a non-negative number falls back to the default", async () => {
  const db = await freshDb();
  for (const bad of ["lots", "", " ", "-5", "-0.5", "12abc", "NaN", "Infinity", "1e999"]) {
    await setSetting(db, CAP_KEYS.maxEmailsPerReportDay, bad);
    assert.equal((await getCaps(db)).maxEmailsPerReportDay, CAP_DEFAULTS.maxEmailsPerReportDay,
      `${JSON.stringify(bad)} keeps the default`);
  }
  await setSetting(db, CAP_KEYS.maxEmailsPerReportDay, "0");
  assert.equal((await getCaps(db)).maxEmailsPerReportDay, 0, "zero is a number an operator may set");
});

test("dayInTz is the calendar day in the report's own zone", () => {
  const at = Date.UTC(2024, 2, 5, 23, 30); // 2024-03-05T23:30:00Z
  assert.equal(dayInTz(at, "UTC"), "2024-03-05");
  assert.equal(dayInTz(at, "Europe/Berlin"), "2024-03-06");
  assert.equal(dayInTz(at, "America/Los_Angeles"), "2024-03-05");
  assert.equal(dayInTz(at, "Pacific/Kiritimati"), "2024-03-06");
  assert.equal(dayInTz(at, "Pacific/Midway"), "2024-03-05");
  // An unusable zone counts in UTC rather than throwing a cap counter over.
  assert.equal(dayInTz(at, "Mars/Olympus"), "2024-03-05");
  assert.equal(dayInTz(at, "not a zone"), "2024-03-05");
  assert.equal(dayInTz(at, ""), "2024-03-05");
  assert.equal(dayInTz(at, undefined), "2024-03-05");
  assert.throws(() => dayInTz(Number.NaN, "UTC"), { code: "bad_input" });
});

test("usage starts at zero and each add accumulates", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  const day = "2024-03-05";

  assert.deepEqual(await getUsage(db, id, day), { emails: 0, botMs: 0, extraStepRuns: 0 });

  await addUsage(db, { reportId: id, day, emails: 2, botMs: 60_000, extraStepRuns: 1 });
  assert.deepEqual(await getUsage(db, id, day), { emails: 2, botMs: 60_000, extraStepRuns: 1 });

  await addUsage(db, { reportId: id, day, emails: 3, botMs: 90_000 });
  assert.deepEqual(await getUsage(db, id, day), { emails: 5, botMs: 150_000, extraStepRuns: 1 });
  assert.equal(await countRows(db, "report_usage"), 1, "one row per report per day");

  const nextDay = await addUsage(db, { reportId: id, day: "2024-03-06", emails: 1 });
  assert.deepEqual(nextDay, { emails: 1, botMs: 0, extraStepRuns: 0 }, "a new day starts fresh");
  assert.deepEqual(await getUsage(db, id, day), { emails: 5, botMs: 150_000, extraStepRuns: 1 },
    "yesterday's counts are untouched");

  assert.deepEqual(await addUsage(db, { reportId: id, day }), { emails: 5, botMs: 150_000, extraStepRuns: 1 },
    "an add of nothing is a read");

  for (const bad of [-1, Number.NaN, "3"]) {
    await assert.rejects(() => addUsage(db, { reportId: id, day, emails: bad }), { code: "bad_input" });
  }
  await assert.rejects(() => addUsage(db, { reportId: id, day: "5 March", emails: 1 }),
    { code: "bad_input" });
  await assert.rejects(() => getUsage(db, id, "2024-3-5"), { code: "bad_input" });
});

test("capState puts each cap next to what is used and says when it is reached", async () => {
  const db = await freshDb();
  const id = await makeReport(db);
  const day = "2024-03-05";
  await setSetting(db, CAP_KEYS.maxEmailsPerReportDay, "4");
  await setSetting(db, CAP_KEYS.maxBotMinutesPerReportDay, "2");
  await setSetting(db, CAP_KEYS.maxExtraStepRunsPerReportDay, "1");

  const empty = await capState(db, { reportId: id, day });
  assert.deepEqual(empty, {
    emails: { used: 0, max: 4, exceeded: false },
    botMinutes: { used: 0, max: 2, exceeded: false },
    extraStepRuns: { used: 0, max: 1, exceeded: false },
  });

  await addUsage(db, { reportId: id, day, emails: 3, botMs: 60_000, extraStepRuns: 1 });
  const partway = await capState(db, { reportId: id, day });
  assert.deepEqual(partway.emails, { used: 3, max: 4, exceeded: false });
  assert.deepEqual(partway.botMinutes, { used: 1, max: 2, exceeded: false });
  assert.deepEqual(partway.extraStepRuns, { used: 1, max: 1, exceeded: true },
    "reaching the cap is exceeding it");

  await addUsage(db, { reportId: id, day, emails: 2, botMs: 60_000 });
  const over = await capState(db, { reportId: id, day });
  assert.deepEqual(over.emails, { used: 5, max: 4, exceeded: true });
  assert.deepEqual(over.botMinutes, { used: 2, max: 2, exceeded: true });
});