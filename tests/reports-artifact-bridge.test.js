// The artifact bridge: a report run writes its document as an artifact version, as the OWNER.
//
// Harness: a real init-db'd scratch crow.db (copied per test), the real artifacts bundle modules loaded
// from this repo's bundle folder (the same modules an installed copy has), a real local blob store under
// a temp data dir, and real report rows. `deps.artifacts` is how the bridge takes that runtime, so these
// tests exercise the same code path production does, without an installed bundle under CROW_HOME (which
// is an empty temp dir here, which is why the `artifacts_missing` case is the real loader's).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "reports-bridge-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");
const BUNDLE = join(REPO, "bundles", "artifacts", "server");
const bundleImport = (f) => import(pathToFileURL(join(BUNDLE, f)).href);

const { createDbClient } = await import("../servers/db.js");
const {
  ARTIFACTS_OUTDATED_TEXT, STORAGE_NEARLY_FULL_TEXT, PREVIEW_ARTIFACT_STATE_KEY, RESERVED_STATE_KEYS,
  _resetArtifactsRuntimeForTest, ensureReportArtifact, isRecipientSafeVersion, isReportVersion,
  isReservedStateKey, latestRecipientVersion, makeWriteVersion, normalizeAllowedLinks, reportVersionFor,
  writeRunVersion,
} = await import("../servers/gateway/reports/artifact-bridge.js");
const { approveGoLive, pauseReport, verifyLive } = await import(
  "../servers/gateway/reports/approvals.js");
const { createReport, getReport, getState, saveRecipe, setState, updateReportColumns } = await import(
  "../servers/gateway/reports/store.js");
const { executeRun, getRun, startRun } = await import("../servers/gateway/reports/run.js");

const bundleStore = await bundleImport("store.js");
const { initArtifactsTables } = await bundleImport("init-tables.js");
const { createBlobStore } = await bundleImport("blob-store-minio.js");
const bundleLimits = await bundleImport("limits.js");
const { markdownBlocks } = await import("../servers/blog/renderer.js");

const OWNER = Object.freeze({ kind: "owner" });
const SEED = Buffer.alloc(32, 3);
const PROJECT = 7;
const SENDER = "ma-0011223344556677";
const T0 = 1_700_000_000_000;
const BOT = "bot-1";

/** The block registry a later PR ships; here it marks the source-bearing block types. */
const REGISTRY = Object.freeze({
  mail_list: { sourceBearing: true },
  custom_step: { sourceBearing: true },
  columns: { sourceBearing: false },
});

const SOURCE_RECIPE = {
  blocks: [
    { id: "b1", type: "mail_list", settings: { account: SENDER, sinceDays: 7 } },
    { id: "b2", type: "columns", settings: { columns: ["subject", "date"] } },
  ],
};

const open = [];
let copied = 0;

after(() => {
  for (const db of open) { try { db.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
});

/* ------------------------------------------------------------------- the harness */

async function freshDb() {
  const dir = join(root, "t" + (++copied));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  const db = createDbClient(crow);
  open.push(db);
  return db;
}

/** The artifacts runtime the bridge takes: the real bundle modules and a real local blob store. */
async function runtime(db) {
  await initArtifactsTables(db);
  const dataDir = join(root, "blobs", String(++copied));
  mkdirSync(dataDir, { recursive: true });
  const blobs = await createBlobStore(db, dataDir, { forceKind: "local" });
  return { store: bundleStore, initArtifactsTables, blobs, markdownBlocks, limits: bundleLimits.LIMITS };
}

async function reportRow(db, { title = "Weekly listings" } = {}) {
  const { id } = await createReport(db, { projectId: PROJECT, owner: "owner", botId: BOT, title });
  return getReport(db, id);
}

/** A draft report and the artifact the bridge made for it, with the row read back. */
async function reportWithArtifact(db, deps) {
  const draft = await reportRow(db);
  const artifactId = await ensureReportArtifact(db, deps, draft);
  return { artifactId, report: await getReport(db, draft.id) };
}

async function versions(db, artifactId) {
  return (await db.execute({
    sql: "SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY n",
    args: [artifactId],
  })).rows;
}

async function reportVersions(db) {
  return (await db.execute({ sql: "SELECT * FROM report_versions ORDER BY n", args: [] })).rows;
}

async function currentVersion(db, artifactId) {
  const { rows } = await db.execute({
    sql: "SELECT current_version FROM artifacts WHERE id = ?",
    args: [artifactId],
  });
  return rows[0] == null ? null : Number(rows[0].current_version);
}

/** How many artifacts exist at all, so a test can say whether a write made a new one. */
async function artifactCount(db) {
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] });
  return Number(rows[0].n);
}

/** A plain owner-session artifact, as the artifacts panel (or a report's bot) would leave one behind. */
async function plainArtifact(db, rt, { title, actor, markdown = "# Untouched\n\n- one" }) {
  const { id } = await bundleStore.createArtifact(db, rt.blobs, {
    title,
    type: "document",
    source: { markdown, title },
    actor,
  }, { markdownBlocks });
  return id;
}

/** The runs a go-live approval can read back: one finished preview of the report's head revision. */
function previewRunFor(report) {
  return { id: "prv-1", reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev };
}

async function addSchedule(db) {
  await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, tz) VALUES ('weekly-report', '0 7 * * 1', 'Europe/Berlin')",
    args: [],
  });
  const { rows } = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
  return Number(rows[0].id);
}

/** A report ready for go-live: a saved source revision and the settings the seal covers. */
async function prepare(db) {
  const scheduleId = await addSchedule(db);
  const { id } = await createReport(db, {
    projectId: PROJECT, owner: "owner", botId: BOT, title: "Weekly listings",
  });
  const saved = await saveRecipe(db, { reportId: id, recipe: SOURCE_RECIPE, authorKind: "owner", registry: REGISTRY });
  await updateReportColumns(db, id, {
    schedule_id: scheduleId,
    sender_account_id: SENDER,
    delivery_mode: "email_link",
    comment_tier_default: "c",
    comment_visibility: "own",
    ai_commentary: 0,
  });
  return { id, rev: saved.rev };
}

function approvalsDeps(getRunForApproval) {
  return {
    loadSeed: () => ({ seed: SEED }),
    now: () => T0,
    getRun: async (_db, runId) => getRunForApproval[runId] ?? null,
    senderReady: async () => true,
    registry: REGISTRY,
  };
}

/** A live report whose live set names an artifact (the production order: artifact, then go-live). */
async function liveReportWithArtifact() {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const report = await prepare(db);
  const artifactId = await ensureReportArtifact(db, deps, await getReport(db, report.id));
  const runs = {
    "prv-1": { id: "prv-1", reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev },
  };
  await approveGoLive(db, approvalsDeps(runs), { reportId: report.id, previewRunId: "prv-1", actor: OWNER });
  return { db, rt, deps, report, artifactId };
}

function runDeps(approvalDeps, over = {}) {
  return {
    approvals: approvalDeps,
    now: () => T0,
    getSecrets: () => [],
    deliver: async () => {},
    ...over,
  };
}

/* ------------------------------------------------------------------ one version per run */

test("each run writes one new artifact version, untrusted, mapped in report_versions", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const draft = await reportRow(db);

  const artifactId = await ensureReportArtifact(db, deps, draft);
  assert.match(artifactId, /^art_/);
  const pointed = await getReport(db, draft.id);
  assert.equal(pointed.artifact_id, artifactId, "the report points at its artifact from now on");

  const art = (await db.execute({ sql: "SELECT * FROM artifacts WHERE id = ?", args: [artifactId] })).rows[0];
  assert.equal(art.type, "document");
  assert.equal(art.title, "Weekly listings");
  assert.equal(art.created_by_bot, null, "the owner made it, not the report's bot");
  assert.equal(Number(art.title_tainted), 1, "the title is written by a session that may hold source text");
  assert.equal(Number(art.current_version), 1);
  const granted = await db.execute({
    sql: "SELECT 1 FROM artifact_bot_access WHERE artifact_id = ?", args: [artifactId],
  });
  assert.equal(granted.rows.length, 0, "no bot access row is written for the report's bot");

  const first = (await versions(db, artifactId))[0];
  assert.match(JSON.parse(first.source_json).markdown, /^# Weekly listings\n\nNo run yet\.$/);

  const run = { id: "rrn-0011223344556677", trigger: "manual", late: 0, createdAt: T0 };
  const n = await writeRunVersion(db, deps, {
    report: pointed,
    run,
    source: { markdown: "# Weekly listings\n\n- one", title: "Weekly listings" },
    allowedLinks: ["https://news.example.com/a"],
  });
  assert.equal(n, 2, "the run's version follows the initial one");

  const rows = await versions(db, artifactId);
  assert.equal(rows.length, 2, "exactly one new version");
  const stored = rows.find((r) => Number(r.n) === 2);
  assert.equal(stored.made_by, "user", "a session actor resolves to the owner");
  assert.equal(Number(stored.untrusted_input), 1, "every report version is untrusted");
  assert.equal(stored.change_note, `Run ${new Date(T0).toISOString().slice(0, 10)}`);

  const mapped = await reportVersionFor(db, artifactId, 2);
  assert.equal(mapped.report_id, draft.id);
  assert.equal(mapped.run_id, run.id);
  assert.equal(mapped.trigger, "manual");
  assert.deepEqual(JSON.parse(mapped.allowed_links_json), ["https://news.example.com/a"]);
  assert.equal(await isReportVersion(db, artifactId, 2), true);
  assert.equal(await isReportVersion(db, artifactId, 1), false, "the initial version belongs to no run");
  assert.equal(await isReportVersion(db, "art_nosuchversion", 2), false);
});

test("a late and a preview run say so in the change note", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { report } = await reportWithArtifact(db, deps);
  const day = new Date(T0).toISOString().slice(0, 10);
  const late = await writeRunVersion(db, deps, {
    report,
    run: { id: "rrn-0000000000000001", trigger: "schedule", late: 1, createdAt: T0 },
    source: { markdown: "# Weekly listings\n\n- one", title: "Weekly listings" },
  });
  const preview = await writeRunVersion(db, deps, {
    report,
    run: { id: "rrn-0000000000000002", trigger: "preview", late: 0, createdAt: T0 },
    source: { markdown: "# Weekly listings\n\n- two", title: "Weekly listings" },
  });
  const rows = await versions(db, report.artifact_id);
  const note = (n) => rows.find((r) => Number(r.n) === n).change_note;
  assert.equal(note(late), `Run ${day} (late)`);
  assert.equal(note(preview), `Run ${day} (preview)`);
});

/* ------------------------------------------------------- the batch, and who may write */

test("the report_versions row rides addVersion's batch: a failing insert leaves no version", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { report } = await reportWithArtifact(db, deps);
  const before = await versions(db, report.artifact_id);
  assert.equal(before.length, 1);

  // The map table is the only thing that can fail here; the version must roll back with it.
  await db.execute({ sql: "ALTER TABLE report_versions RENAME TO report_versions_gone", args: [] });
  await assert.rejects(() => writeRunVersion(db, deps, {
    report,
    run: { id: "rrn-0000000000000003", trigger: "manual", late: 0, createdAt: T0 },
    source: { markdown: "# Weekly listings\n\n- one", title: "Weekly listings" },
  }), /report_versions/);

  const after = await versions(db, report.artifact_id);
  assert.equal(after.length, 1, "no version was left behind");
  const art = (await db.execute({ sql: "SELECT current_version FROM artifacts WHERE id = ?", args: [report.artifact_id] })).rows[0];
  assert.equal(Number(art.current_version), 1, "the artifact's current version did not move");
});

test("the report's bot cannot read or add versions to the report artifact", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const artifactId = await ensureReportArtifact(db, deps, await reportRow(db));
  const art = await bundleStore.getArtifact(db, artifactId);
  const bot = { kind: "bot", id: BOT };

  assert.equal(await bundleStore.canAccess(db, bot, art), false, "the bot that wrote the recipe sees nothing");
  await assert.rejects(() => bundleStore.requireAccess(db, bot, artifactId), { code: "not_found" });
  await assert.rejects(() => bundleStore.addVersion(db, rt.blobs, {
    artifactId,
    source: { markdown: "# Weekly listings\n\n- from the bot", title: "Weekly listings" },
    actor: bot,
  }, { markdownBlocks }), { code: "not_found" });
  assert.equal((await versions(db, artifactId)).length, 1);
});

/* ------------------------------------------------------------------------ retention */

test("near-full storage fails honestly and writes nothing", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { report } = await reportWithArtifact(db, deps);
  const versionsBefore = (await versions(db, report.artifact_id)).length;
  const mappedBefore = (await reportVersions(db)).length;

  // Any non-zero usage is at or above 90% of a one-byte cap.
  const restore = bundleLimits._overrideLimitsForTest({ instanceBytes: 1 });
  try {
    await assert.rejects(() => writeRunVersion(db, deps, {
      report,
      run: { id: "rrn-0000000000000004", trigger: "manual", late: 0, createdAt: T0 },
      source: { markdown: "# Weekly listings\n\n- one", title: "Weekly listings" },
    }), (err) => {
      assert.equal(err.code, "storage_nearly_full");
      assert.equal(err.message, STORAGE_NEARLY_FULL_TEXT);
      return true;
    });
  } finally {
    restore();
  }

  assert.equal((await versions(db, report.artifact_id)).length, versionsBefore, "nothing was written");
  assert.equal((await reportVersions(db)).length, mappedBefore);
});

/* ------------------------------------------------------------------- allowed links */

test("allowed_links_json keeps http(s) URLs only, de-duplicated and capped", () => {
  const many = [];
  for (let i = 0; i < 2005; i += 1) many.push(`https://links.example.com/${i}`);
  const kept = normalizeAllowedLinks([
    "https://a.example.com/x",
    "https://a.example.com/x",
    "http://b.example.com/y?z=1",
    "ftp://c.example.com/file",
    "javascript:alert(1)",
    "mailto:someone@b.example.com",
    "/relative/path",
    "not a url",
    42,
    null,
    ...many,
  ]);
  assert.equal(kept.length, 2000, "capped at 2000");
  assert.equal(kept[0], "https://a.example.com/x");
  assert.equal(kept[1], "http://b.example.com/y?z=1");
  assert.equal(new Set(kept).size, kept.length, "no duplicates");
  assert.ok(kept.every((u) => /^https?:\/\//.test(u)));

  assert.deepEqual(normalizeAllowedLinks(null), []);
  assert.deepEqual(normalizeAllowedLinks("https://a.example.com/x"), [], "a bare string is not a list");
});

test("allowed links longer than 2048 characters are dropped without being counted", () => {
  const atCap = "https://f.example.com/" + "y".repeat(2048 - "https://f.example.com/".length);
  const overCap = atCap + "y";
  assert.equal(atCap.length, 2048);
  assert.equal(overCap.length, 2049);

  const kept = normalizeAllowedLinks([overCap, atCap, "https://a.example.com/x"]);
  assert.deepEqual(kept, [atCap, "https://a.example.com/x"],
    "2048 characters is kept, one more is dropped, and the rest of the list is unaffected");
  assert.equal(kept.includes(overCap), false);
  assert.equal(normalizeAllowedLinks([overCap]).length, 0, "a list of only over-long URLs is empty");

  // Dropped silently: no separate count, no marker, and the cap on the number kept is untouched.
  const many = [];
  for (let i = 0; i < 10; i += 1) many.push(overCap + i);
  assert.deepEqual(normalizeAllowedLinks([...many, "https://b.example.com/z"]), ["https://b.example.com/z"]);
  assert.deepEqual(normalizeAllowedLinks(["javascript:" + "a".repeat(3000)]), [],
    "no scheme survives the length check either");
});

test("a run records only the http(s) links it was given", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { artifactId, report } = await reportWithArtifact(db, deps);
  await writeRunVersion(db, deps, {
    report,
    run: { id: "rrn-0000000000000005", trigger: "manual", late: 0, createdAt: T0 },
    source: { markdown: "# Weekly listings\n\n- one", title: "Weekly listings" },
    allowedLinks: [
      "https://a.example.com/x", "https://a.example.com/x", "ftp://c.example.com/file", 7,
    ],
  });
  const mapped = await reportVersionFor(db, artifactId, 2);
  assert.deepEqual(JSON.parse(mapped.allowed_links_json), ["https://a.example.com/x"]);
});

/* ------------------------------------------------------------------------ the seal */

test("a live report without an artifact id throws artifact_unsealed", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const report = await prepare(db);
  const runs = {
    "prv-1": { id: "prv-1", reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev },
  };
  await approveGoLive(db, approvalsDeps(runs), { reportId: report.id, previewRunId: "prv-1", actor: OWNER });
  const live = await getReport(db, report.id);
  assert.equal(live.status, "live");
  assert.equal(live.artifact_id, null);

  await assert.rejects(() => ensureReportArtifact(db, deps, live), { code: "artifact_unsealed" });
  const write = makeWriteVersion({ artifacts: rt });
  await assert.rejects(() => write(db, {
    report: live,
    run: { id: "rrn-0000000000000006", trigger: "manual", late: 0, createdAt: T0 },
    live: { artifactId: "" },
    result: { items: [], document: { markdown: "# Weekly listings\n\n- one" } },
  }), { code: "artifact_unsealed" });
  assert.equal((await reportVersions(db)).length, 0);
  const arts = await db.execute({ sql: "SELECT id FROM artifacts", args: [] });
  assert.equal(arts.rows.length, 0, "no artifact was made behind the seal's back");
});

/* ---------------------------------------------------------------------- the artifact */

test("ensureReportArtifact reuses the stored id and never makes a second artifact", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const draft = await reportRow(db);

  const first = await ensureReportArtifact(db, deps, draft);
  const second = await ensureReportArtifact(db, deps, await getReport(db, draft.id));
  assert.equal(second, first);
  const arts = await db.execute({ sql: "SELECT id FROM artifacts", args: [] });
  assert.equal(arts.rows.length, 1);

  // A draft whose artifact is gone gets a replacement and points at it; nothing is left dangling.
  await db.execute({ sql: "UPDATE artifacts SET deleted_at = datetime('now') WHERE id = ?", args: [first] });
  const third = await ensureReportArtifact(db, deps, await getReport(db, draft.id));
  assert.notEqual(third, first);
  assert.equal((await getReport(db, draft.id)).artifact_id, third);
});

test("without the artifacts bundle the bridge says artifacts_missing", async () => {
  _resetArtifactsRuntimeForTest();
  const db = await freshDb();
  const draft = await reportRow(db);
  await assert.rejects(() => ensureReportArtifact(db, {}, draft), (err) => {
    assert.equal(err.code, "artifacts_missing");
    return true;
  });
  assert.equal((await getReport(db, draft.id)).artifact_id, null, "the report was not pointed at anything");
});

/* --------------------------------------------------------------- end to end with the run engine */

test("makeWriteVersion works end to end: the run row keeps the version, and a preview writes one", async () => {
  const { db, rt, report, artifactId } = await liveReportWithArtifact();
  const runs = {
    "prv-1": { id: "prv-1", reportId: report.id, kind: "preview", status: "ok", recipeRev: report.rev },
  };
  const writeVersion = makeWriteVersion({ artifacts: rt });
  const deps = runDeps(approvalsDeps(runs), {
    writeVersion,
    runBlocks: async () => ({
      items: [{ subject: "one" }],
      sourceErrors: [],
      document: { markdown: "# Weekly listings\n\n- one", title: "Weekly listings" },
      allowedLinks: ["https://news.example.com/a"],
    }),
  });

  const { runId } = await startRun(db, deps, {
    reportId: report.id, trigger: "manual", requestedBy: "owner",
  });
  const manual = await executeRun(db, deps, runId);
  assert.equal(manual.status, "ok");
  assert.equal(manual.artifactVersion, 2);

  const runRow = await getRun(db, runId);
  assert.equal(runRow.artifactVersion, 2, "artifact_version is stored on the run row");
  const mapped = await reportVersionFor(db, artifactId, 2);
  assert.equal(mapped.run_id, runId);
  assert.equal(mapped.report_id, report.id);
  assert.equal(mapped.trigger, "manual");
  assert.equal(await isReportVersion(db, artifactId, 2), true);

  const preview = await startRun(db, deps, {
    reportId: report.id, trigger: "preview", requestedBy: "owner",
  });
  const previewOut = await executeRun(db, deps, preview.runId);
  assert.equal(previewOut.status, "ok");
  const previewState = await getState(db, report.id, "preview_artifact_id");
  assert.match(previewState.artifactId, /^art_/);
  assert.notEqual(previewState.artifactId, artifactId, "a preview never lands on the sealed artifact");
  assert.equal(previewOut.artifactVersion, 2, "the first version under the preview artifact");
  const previewMapped = await reportVersionFor(db, previewState.artifactId, 2);
  assert.equal(previewMapped.trigger, "preview");
  const previewRow = await versions(db, previewState.artifactId);
  assert.match(previewRow.find((r) => Number(r.n) === 2).change_note, /\(preview\)$/);
  assert.equal((await getReport(db, report.id)).artifact_id, artifactId,
    "every version stayed on the sealed artifact");
  assert.equal(await currentVersion(db, artifactId), 2, "the sealed artifact's current version is the run's");
});

/* ------------------------------------------------------------------- previews and the seal */

const PREVIEW_SOURCE = Object.freeze({
  markdown: "# Weekly listings\n\n- preview one",
  title: "Weekly listings",
});

function previewRun(suffix) {
  return { id: `rrn-00000000000000${suffix}`, trigger: "preview", late: 0, createdAt: T0 };
}

test("a preview of a live report writes a separate preview artifact and leaves the seal's current version", async () => {
  const { db, deps, report, artifactId } = await liveReportWithArtifact();
  const live = await getReport(db, report.id);
  assert.equal(Number(live.live_rev), report.rev);
  assert.equal(await currentVersion(db, artifactId), 1, "the sealed artifact holds only its first version");

  const first = await writeRunVersion(db, deps, {
    report: live, run: previewRun("21"), source: PREVIEW_SOURCE,
  });

  const state = await getState(db, report.id, "preview_artifact_id");
  assert.match(state.artifactId, /^art_/);
  assert.notEqual(state.artifactId, artifactId, "the preview artifact is its own artifact");
  assert.equal(first, 2, "the preview artifact's own initial version stands under it");

  const previewArt = (await db.execute({
    sql: "SELECT * FROM artifacts WHERE id = ?", args: [state.artifactId],
  })).rows[0];
  assert.equal(previewArt.type, "document");
  assert.equal(previewArt.title, "Weekly listings (preview)");
  assert.equal(previewArt.created_by_bot, null, "the owner's session made it, not the report's bot");
  assert.equal(Number(previewArt.title_tainted), 1);
  assert.equal(Number(previewArt.current_version), 2);
  const granted = await db.execute({
    sql: "SELECT 1 FROM artifact_bot_access WHERE artifact_id = ?", args: [state.artifactId],
  });
  assert.equal(granted.rows.length, 0, "no bot access row is written for it");

  const mapped = await reportVersionFor(db, state.artifactId, 2);
  assert.equal(mapped.trigger, "preview");
  assert.equal(mapped.report_id, report.id);

  assert.equal(await currentVersion(db, artifactId), 1, "the sealed artifact's current version did not move");
  assert.equal((await versions(db, artifactId)).length, 1, "no preview version was added to the sealed artifact");

  const second = await writeRunVersion(db, deps, {
    report: live, run: previewRun("22"), source: { ...PREVIEW_SOURCE, markdown: "# Weekly listings\n\n- preview two" },
  });
  assert.equal(second, 3);
  assert.deepEqual(await getState(db, report.id, "preview_artifact_id"), state,
    "a second preview reuses the same preview artifact");
  assert.equal((await versions(db, state.artifactId)).length, 3);
  assert.equal(await currentVersion(db, artifactId), 1, "still nothing on the sealed artifact");
  assert.equal((await getReport(db, report.id)).artifact_id, artifactId);
});

test("a preview of a paused report that kept its seal also stays out of the sealed artifact", async () => {
  const { db, deps, report, artifactId } = await liveReportWithArtifact();
  await pauseReport(db, {}, { reportId: report.id, actor: OWNER });
  const paused = await getReport(db, report.id);
  assert.equal(paused.status, "paused");
  assert.equal(Number(paused.live_rev), report.rev, "a pause keeps the seal");
  assert.ok(paused.live_seal);

  const n = await writeRunVersion(db, deps, {
    report: paused, run: previewRun("23"), source: PREVIEW_SOURCE,
  });
  const state = await getState(db, report.id, "preview_artifact_id");
  assert.match(state.artifactId, /^art_/);
  assert.notEqual(state.artifactId, artifactId);
  assert.equal(n, 2);
  assert.equal(await currentVersion(db, artifactId), 1);
  assert.equal((await versions(db, artifactId)).length, 1);
  assert.equal(await reportVersionFor(db, state.artifactId, 2).then((row) => row.trigger), "preview");
  assert.equal((await getReport(db, report.id)).artifact_id, artifactId);
});

test("a preview of a never-live report keeps writing into the primary artifact", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { artifactId, report } = await reportWithArtifact(db, deps);
  assert.equal(report.live_rev, null, "nothing is sealed on this report yet");

  const n = await writeRunVersion(db, deps, {
    report, run: previewRun("24"), source: PREVIEW_SOURCE,
  });
  assert.equal(n, 2);
  assert.equal(await currentVersion(db, artifactId), 2, "the artifact go-live will seal carries the preview");
  assert.equal(await getState(db, report.id, "preview_artifact_id"), null,
    "no preview artifact is made while nothing is sealed");
  const arts = await db.execute({ sql: "SELECT id FROM artifacts", args: [] });
  assert.equal(arts.rows.length, 1);
});

/* ------------------------------------------- the stored preview id is not trusted */

test("a stored preview id that names this report's own sealed artifact is ignored", async () => {
  const { db, deps, report, artifactId } = await liveReportWithArtifact();
  const live = await getReport(db, report.id);
  // A tampered (or stale, wrongly written) state row: a block's setState can write report_state, so the
  // stored id is input, never an instruction.
  await setState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY, { artifactId });

  const n = await writeRunVersion(db, deps, {
    report: live, run: previewRun("41"), source: PREVIEW_SOURCE,
  });
  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  assert.match(state.artifactId, /^art_/);
  assert.notEqual(state.artifactId, artifactId, "the sealed artifact is never reused as a preview one");
  assert.equal(n, 2, "the fresh preview artifact's seed version stands under it");
  assert.equal(await currentVersion(db, artifactId), 1, "nothing moved on the sealed artifact");
  assert.equal((await versions(db, artifactId)).length, 1, "no version was written to the sealed artifact");
  assert.equal((await reportVersionFor(db, state.artifactId, 2)).trigger, "preview");
  assert.equal((await getReport(db, report.id)).artifact_id, artifactId, "the report still points at the seal's artifact");
});

test("a stored preview id that names another report's primary artifact is ignored", async () => {
  const { db, deps, report, artifactId } = await liveReportWithArtifact();
  const other = await reportWithArtifact(db, deps);
  const live = await getReport(db, report.id);
  await setState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY, { artifactId: other.artifactId });

  await writeRunVersion(db, deps, { report: live, run: previewRun("42"), source: PREVIEW_SOURCE });

  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  assert.notEqual(state.artifactId, other.artifactId, "another report's artifact is not a preview artifact");
  assert.notEqual(state.artifactId, artifactId);
  assert.equal(await currentVersion(db, other.artifactId), 1, "the other report's artifact did not move");
  assert.equal((await versions(db, other.artifactId)).length, 1);
  assert.equal((await getReport(db, other.report.id)).artifact_id, other.artifactId,
    "the other report still points at its own artifact");
  assert.equal((await reportVersionFor(db, state.artifactId, 2)).trigger, "preview");
});

test("a stored preview id that names an unrelated owner artifact is ignored", async () => {
  const { db, rt, deps, report } = await liveReportWithArtifact();
  const stray = await plainArtifact(db, rt, { title: "Notes", actor: { kind: "session" } });
  const live = await getReport(db, report.id);
  await setState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY, { artifactId: stray });

  await writeRunVersion(db, deps, { report: live, run: previewRun("43"), source: PREVIEW_SOURCE });

  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  assert.notEqual(state.artifactId, stray, "an artifact that is not titled as a preview is not reused");
  const previewArt = (await db.execute({ sql: "SELECT title FROM artifacts WHERE id = ?", args: [state.artifactId] })).rows[0];
  assert.equal(previewArt.title, "Weekly listings (preview)");
  assert.equal(await currentVersion(db, stray), 1, "the unrelated artifact did not move");
  assert.equal((await versions(db, stray)).length, 1);
});

test("a stored preview id that names a bot-created artifact is ignored", async () => {
  const { db, rt, deps, report } = await liveReportWithArtifact();
  // Every other check passes for this one: right title shape, no report claims it, one seed version.
  // Only `created_by_bot` makes it unusable, which is the check that keeps a bot's artifact out.
  const botArtifact = await plainArtifact(db, rt, {
    title: "Weekly listings (preview)",
    actor: { kind: "bot", id: BOT },
    markdown: "# Weekly listings (preview)\n\n- from the bot",
  });
  const live = await getReport(db, report.id);
  await setState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY, { artifactId: botArtifact });

  await writeRunVersion(db, deps, { report: live, run: previewRun("44"), source: PREVIEW_SOURCE });

  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  assert.notEqual(state.artifactId, botArtifact, "a bot's artifact is never made the report's preview one");
  const previewArt = (await db.execute({
    sql: "SELECT created_by_bot FROM artifacts WHERE id = ?", args: [state.artifactId],
  })).rows[0];
  assert.equal(previewArt.created_by_bot, null, "the replacement is the owner's, made by the bridge");
  assert.equal(await currentVersion(db, botArtifact), 1, "the bot's artifact did not move");
});

test("a stored preview id that names a deleted artifact is ignored", async () => {
  const { db, rt, deps, report } = await liveReportWithArtifact();
  const dead = await plainArtifact(db, rt, { title: "Weekly listings (preview)", actor: { kind: "session" } });
  await db.execute({ sql: "UPDATE artifacts SET deleted_at = datetime('now') WHERE id = ?", args: [dead] });
  const live = await getReport(db, report.id);
  await setState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY, { artifactId: dead });

  await writeRunVersion(db, deps, { report: live, run: previewRun("45"), source: PREVIEW_SOURCE });

  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  assert.notEqual(state.artifactId, dead, "a deleted artifact is never reused");
  assert.equal((await reportVersionFor(db, state.artifactId, 2)).trigger, "preview");
  const liveArtifact = (await db.execute({
    sql: "SELECT current_version FROM artifacts WHERE id = ?", args: [live.artifact_id],
  })).rows[0];
  assert.equal(Number(liveArtifact.current_version), 1, "the sealed artifact did not move");
});

test("a valid stored preview artifact id is reused, with no second artifact made", async () => {
  const { db, deps, report } = await liveReportWithArtifact();
  const live = await getReport(db, report.id);
  await writeRunVersion(db, deps, { report: live, run: previewRun("46"), source: PREVIEW_SOURCE });
  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  const count = await artifactCount(db);

  const n = await writeRunVersion(db, deps, {
    report: live,
    run: previewRun("47"),
    source: { ...PREVIEW_SOURCE, markdown: "# Weekly listings\n\n- preview two" },
  });
  assert.equal(n, 3, "the second preview is the next version of the same preview artifact");
  assert.deepEqual(await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY), state,
    "the stored id was reused, not replaced");
  assert.equal(await artifactCount(db), count, "no second preview artifact was made");
});

test("the preview state key is reserved for the bridge", () => {
  assert.deepEqual([...RESERVED_STATE_KEYS], ["preview_artifact_id"]);
  assert.equal(Object.isFrozen(RESERVED_STATE_KEYS), true);
  assert.equal(PREVIEW_ARTIFACT_STATE_KEY, "preview_artifact_id");
  assert.equal(isReservedStateKey("preview_artifact_id"), true);
  assert.equal(isReservedStateKey("preview_artifact_id "), false, "no trimming: a near miss is another key");
  assert.equal(isReservedStateKey("preview_artifact"), false);
  assert.equal(isReservedStateKey("last_source_day"), false);
  assert.equal(isReservedStateKey(""), false);
  assert.equal(isReservedStateKey(null), false);
  assert.equal(isReservedStateKey(undefined), false);
  assert.equal(isReservedStateKey(7), false);
});

test("the preview_into_live backstop refuses a preview the store routes onto the sealed artifact", async () => {
  const { db, rt, report, artifactId } = await liveReportWithArtifact();
  const live = await getReport(db, report.id);
  // The state validation and the backstop are two layers: a store that hands the sealed artifact back as
  // the preview one still writes nothing.
  const hijacked = { ...rt, store: { ...bundleStore, createArtifact: async () => ({ id: artifactId }) } };

  await assert.rejects(() => writeRunVersion(db, { artifacts: hijacked }, {
    report: live, run: previewRun("48"), source: PREVIEW_SOURCE,
  }), (err) => {
    assert.equal(err.code, "preview_into_live");
    return true;
  });

  assert.equal(await currentVersion(db, artifactId), 1, "nothing moved on the sealed artifact");
  assert.equal((await versions(db, artifactId)).length, 1, "no version was written");
  assert.equal((await reportVersions(db)).length, 0, "no run-to-version row either");
});

/* -------------------------------------------- a preview that started before go-live */

test("a preview that started before go-live still lands on the preview artifact", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { artifactId, report } = await reportWithArtifact(db, deps);
  const stale = await getReport(db, report.id);
  assert.equal(stale.live_rev, null, "the caller's snapshot was read while nothing was sealed");

  // Go live between the engine's read and the write: the row now carries the seal and the primary artifact.
  await updateReportColumns(db, report.id, { status: "live", live_rev: Number(report.recipe_rev) || 1 });
  assert.ok(Number((await getReport(db, report.id)).live_rev) >= 1, "the row is sealed now");

  const n = await writeRunVersion(db, deps, {
    report: stale, run: previewRun("49"), source: PREVIEW_SOURCE,
  });

  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  assert.match(state.artifactId, /^art_/);
  assert.notEqual(state.artifactId, artifactId, "the preview was routed away from the now-sealed artifact");
  assert.equal(n, 2);
  assert.equal(await currentVersion(db, artifactId), 1, "the sealed artifact's current version did not move");
  assert.equal((await versions(db, artifactId)).length, 1);
  assert.equal(await reportVersionFor(db, state.artifactId, 2).then((row) => row.trigger), "preview");
  assert.equal((await getReport(db, report.id)).artifact_id, artifactId);
});

test("a preview leaves the live seal verifying and the report's artifact id alone", async () => {
  const { db, deps, report, artifactId } = await liveReportWithArtifact();
  const approvalDeps = approvalsDeps({ "prv-1": previewRunFor(report) });
  const before = await verifyLive(db, approvalDeps, await getReport(db, report.id));
  assert.ok(before, "the report went live");
  assert.equal(before.artifactId, artifactId);

  await writeRunVersion(db, deps, {
    report: await getReport(db, report.id), run: previewRun("26"), source: PREVIEW_SOURCE,
  });

  const live = await getReport(db, report.id);
  assert.equal(live.artifact_id, artifactId, "the report still points at its approved artifact");
  assert.equal(Number(live.live_rev), Number(report.rev));
  const after = await verifyLive(db, approvalDeps, live);
  assert.ok(after, "the seal still verifies after a preview");
  assert.equal(after.artifactId, artifactId);
});

/* ------------------------------------------------------- recipient version pinning */

test("latestRecipientVersion skips a newer preview and names the last real run's version", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { artifactId, report } = await reportWithArtifact(db, deps);
  const manual = await writeRunVersion(db, deps, {
    report, run: { id: "rrn-0000000000000031", trigger: "manual", late: 0, createdAt: T0 },
    source: PREVIEW_SOURCE,
  });
  const preview = await writeRunVersion(db, deps, {
    report, run: previewRun("32"), source: PREVIEW_SOURCE,
  });
  assert.equal(manual, 2);
  assert.equal(preview, 3);
  assert.equal(await currentVersion(db, artifactId), 3,
    "a draft-time preview can sit at current, which is why a recipient render may not use it");
  assert.equal(await latestRecipientVersion(db, artifactId), 2, "the preview is skipped");

  // A real run whose version retention has since pruned is not named either.
  await db.execute({ sql: "DELETE FROM artifact_versions WHERE artifact_id = ? AND n = 2", args: [artifactId] });
  assert.equal(await latestRecipientVersion(db, artifactId), null);
  assert.equal(await latestRecipientVersion(db, "art_nosuch"), null);
  assert.equal(await latestRecipientVersion(db, null), null);
});

test("isRecipientSafeVersion is false for a preview and true for a run", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const deps = { artifacts: rt };
  const { artifactId, report } = await reportWithArtifact(db, deps);
  await writeRunVersion(db, deps, {
    report, run: { id: "rrn-0000000000000033", trigger: "manual", late: 0, createdAt: T0 },
    source: PREVIEW_SOURCE,
  });
  await writeRunVersion(db, deps, { report, run: previewRun("34"), source: PREVIEW_SOURCE });

  assert.equal(await isRecipientSafeVersion(db, artifactId, 2), true);
  assert.equal(await isRecipientSafeVersion(db, artifactId, 3), false, "a preview was never sent");
  assert.equal(await isRecipientSafeVersion(db, artifactId, 1), false, "the owner's initial version is no run");
  assert.equal(await isRecipientSafeVersion(db, artifactId, 99), false);
  assert.equal(await isRecipientSafeVersion(db, "art_nosuch", 2), false);
});

/* ------------------------------------------------------------ an older installed bundle */

test("a store without holdVersion fails up front with artifacts_outdated and writes nothing", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const stale = { ...rt, store: { ...bundleStore, holdVersion: undefined } };
  const draft = await reportRow(db);

  await assert.rejects(() => writeRunVersion(db, { artifacts: stale }, {
    report: draft,
    run: { id: "rrn-0000000000000035", trigger: "manual", late: 0, createdAt: T0 },
    source: PREVIEW_SOURCE,
  }), (err) => {
    assert.equal(err.code, "artifacts_outdated");
    assert.equal(err.message, ARTIFACTS_OUTDATED_TEXT);
    return true;
  });

  const arts = await db.execute({ sql: "SELECT id FROM artifacts", args: [] });
  assert.equal(arts.rows.length, 0, "no artifact was made either");
  assert.equal((await reportVersions(db)).length, 0);
  assert.equal((await getReport(db, draft.id)).artifact_id, null);
});

test("a store whose addVersion ignores extraStatements fails with artifacts_outdated after the write", async () => {
  const db = await freshDb();
  const rt = await runtime(db);
  const ignoring = {
    ...rt,
    store: {
      ...bundleStore,
      addVersion: (db2, blobs, input, opts) => bundleStore.addVersion(
        db2, blobs, { ...input, extraStatements: null }, opts,
      ),
    },
  };
  const { artifactId, report } = await reportWithArtifact(db, { artifacts: ignoring });

  await assert.rejects(() => writeRunVersion(db, { artifacts: ignoring }, {
    report,
    run: { id: "rrn-0000000000000036", trigger: "manual", late: 0, createdAt: T0 },
    source: PREVIEW_SOURCE,
  }), (err) => {
    assert.equal(err.code, "artifacts_outdated");
    assert.equal(err.message, ARTIFACTS_OUTDATED_TEXT);
    return true;
  });

  assert.equal((await versions(db, artifactId)).length, 2, "the version was written");
  assert.equal((await reportVersions(db)).length, 0, "and it is unmapped, which is the honest failure");
  assert.equal(await currentVersion(db, artifactId), 2);
});