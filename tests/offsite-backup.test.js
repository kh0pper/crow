/**
 * Crow's off-site vault: the nightly encrypted upload, the retention plan and the weekly verify
 * (SAT-8 part B, spec §12). The satellite is the in-test paired fake (helpers/fake-satellite-mgmt
 * .js) — it verifies every signed request, including the streamed PUT whose signature covers the
 * declared body hash. No network, no timers: both jobs are plain functions here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lutimesSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "offsite-home-"));
const DATA = mkdtempSync(join(tmpdir(), "offsite-data-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const dirs = [HOME, DATA];
after(() => { for (const d of dirs) rmScratch(d); });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const V = await import("../servers/shared/crow-vault.js");
const O = await import("../servers/gateway/satellites/offsite.js");
const OE = await import("../servers/gateway/satellites/offsite-key.js");
const K = await import("../servers/gateway/keychain/store.js");
const R = await import("../servers/gateway/keychain/reminder.js");
const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { backupFileName, localBackupContext } = await import("../servers/shared/backup-naming.js");
const { createMgmtFake, makeSatelliteRow, MGMT_HOST } = await import("./helpers/fake-satellite-mgmt.js");

const NOW = Date.parse("2026-11-02T03:10:00Z");
const DATE = "2026-11-02";
const NAME = "crow-db-20261102.vault";
const CROW_ID = "crow:test-offsite";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A crow.db-shaped SQLite file with `memories` rows (the verify reads them back). */
function makeBackupDb(path, memories) {
  const db = new Database(path);
  db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)");
  const ins = db.prepare("INSERT INTO memories (content) VALUES (?)");
  for (let i = 0; i < memories; i++) ins.run(`memory ${i}`);
  db.close();
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS dashboard_settings_overrides (
    key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id));
  CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
`;

/**
 * A crow-side fixture: a db with the settings tables (plus `memories`, which the verify compares
 * against), the off-site key, a paired fake satellite with a vault, and a nightly backup file.
 * `satellites: 2` pairs a second fake on its own host (`satellite2.example.ts.net`) so the choice
 * of which one hosts the vault is testable; `statuses` sets each row's status in pairing order.
 */
async function setup({ memories = 10, backupMemories = 10, paired = true, exported = true, satellite = {}, satellites = 1, statuses = [] } = {}) {
  const dir = tmp("offsite-db-");
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SCHEMA);
  await db.executeMultiple(SATELLITE_DDL);
  await K.ensureKeychainTable(db);
  for (let i = 0; i < memories; i++) await db.execute({ sql: "INSERT INTO memories (content) VALUES (?)", args: [`live ${i}`] });

  const keychainKey = createKeychainKey({ crowHome: tmp("offsite-kc-") });
  const { key } = await OE.ensureOffsiteKey(db, keychainKey);
  if (exported) await R.recordKeychainExport(db, keychainKey.id);

  const backupDir = tmp("offsite-backups-");
  const ctx = localBackupContext(process.env);
  const backupName = backupFileName(ctx.label, ctx.tag, DATE);
  const raw = join(backupDir, "source.db");
  makeBackupDb(raw, backupMemories);
  const backupBytes = readFileSync(raw);
  writeFileSync(join(backupDir, backupName), backupBytes);
  // A real nightly backup is written minutes after its own date starts (02:30), so its mtime sits
  // inside the vault's rollback window; pin it there instead of the wall clock.
  utimesSync(join(backupDir, backupName), NOW / 1000, NOW / 1000);

  const files = new Map(); // name → {data, mtime}, the satellite's vault
  const notify = [];
  const routes = {
    "GET /satellite/v1/vault": () => ({ status: 200, json: [...files].map(([name, f]) => ({ name, size: f.data.length, sha256: sha(f.data), mtime: f.mtime })) }),
    "PUT /satellite/v1/vault/:name": ({ params, raw: body }) => {
      if (satellite.putError) return { status: satellite.putError.status, json: { error: satellite.putError.code } };
      const data = satellite.tamperStore ? Buffer.concat([body, Buffer.from("x")]) : body;
      files.set(params.name, { data, mtime: new Date(NOW).toISOString() });
      return { status: 200, json: { ok: true, name: params.name, size: data.length, sha256: sha(data) } };
    },
    "GET /satellite/v1/vault/:name": ({ params }) => (files.has(params.name) ? { status: 200, raw: files.get(params.name).data } : { status: 404, json: { error: "not_found" } }),
    "DELETE /satellite/v1/vault/:name": ({ params }) => { files.delete(params.name); return { status: 200, json: { ok: true, name: params.name } }; },
  };
  const fakes = [];
  const rows = [];
  for (let i = 0; i < Math.max(1, satellites); i++) {
    fakes.push(createMgmtFake({ host: i === 0 ? MGMT_HOST : `satellite${i + 1}.example.ts.net`, routes }));
  }
  if (paired) {
    for (let i = 0; i < fakes.length; i++) {
      // Pairing time = created_at; a second server is always paired after the first.
      const made = await makeSatelliteRow(db, fakes[i], { name: `sat-${i + 1}`, now: NOW + i * 1000, status: statuses[i] ?? "active" });
      rows.push(made.row);
    }
  }
  // One fetch impl for both hosts, so a test can see which server was actually contacted.
  const fetchImpl = (url, init) => {
    const host = new URL(url).host;
    const fake = fakes.find((f) => f.host === host);
    return fake ? fake.fetchImpl(url, init) : Promise.reject(new TypeError("fetch failed"));
  };

  const base = {
    db, key, keychainKey, files, notify, fake: fakes[0], fakes, rows, backupDir, backupName, backupBytes, backupPath: raw,
    opts: {
      db, now: () => NOW, fetchImpl, backupDir,
      identityFn: () => ({ crowId: CROW_ID }),
      keychainKeyFn: () => keychainKey,
      instanceIdFn: () => "inst-test",
      notify: (_db, n) => { notify.push(n); return { id: notify.length }; },
    },
  };
  return base;
}

const closeAll = async (t) => { try { t.db.close(); } catch { /* closed */ } };

/** A real crow-vault file of the fixture's backup, as the satellite would hold it. */
async function putRealVaultFile(t, { createdAt = new Date(NOW), backupDate = DATE, mtime = new Date(NOW) } = {}) {
  const name = O.vaultNameForDate(backupDate);
  const out = join(tmp("offsite-vault-"), name);
  await V.encryptVault({
    input: t.backupBytes, output: out, key: t.key, backupDate,
    createdAt, sourceInstanceId: "inst-test", crowId: CROW_ID,
  });
  t.files.set(name, { data: readFileSync(out), mtime: mtime.toISOString() });
  return out;
}

/** Scratch dirs the jobs create under the system temp dir (they must not survive a run). */
const scratchDirs = () => { try { return readdirSync(tmpdir()).filter((n) => n.startsWith("crow-offsite-")); } catch { return []; } };

// ── the export gate ─────────────────────────────────────────────────────────

test("no keychain export holds the key → skip, and exactly one notification a day", async () => {
  const t = await setup({ exported: false });
  try {
    assert.equal(await OE.offsiteKeyInExport(t.db), false);
    const r = await O.runOffsiteUpload(t.opts);
    assert.deepEqual(r, { ok: false, code: "no_key_export" });
    assert.equal(t.notify.length, 1);
    assert.match(t.notify[0].title, /keychain export/i);
    assert.ok(!JSON.stringify(t.notify[0]).includes(t.key.toString("base64")), "no key in a notification");
    assert.equal(t.fake.state.requests.length, 0, "nothing was sent to the server");

    // Same day: no second notification, still nothing uploaded.
    assert.equal((await O.runOffsiteUpload(t.opts)).code, "no_key_export");
    assert.equal((await O.runOffsiteUpload({ ...t.opts, now: () => NOW + 6 * 3600_000 })).code, "no_key_export");
    assert.equal(t.notify.length, 1);

    // The next day it speaks again.
    await O.runOffsiteUpload({ ...t.opts, now: () => NOW + 24 * 3600_000 });
    assert.equal(t.notify.length, 2);
    assert.equal(t.files.size, 0);

    // Once an export holds the key the gate opens.
    await R.recordKeychainExport(t.db, t.keychainKey.id);
    assert.equal(await OE.offsiteKeyInExport(t.db), true);
    assert.equal((await O.runOffsiteUpload(t.opts)).ok, true);
  } finally { await closeAll(t); }
});

// ── upload ─────────────────────────────────────────────────────────────────

test("upload: encrypted, streamed to the vault, and the signed list reports the same size and sha256", async () => {
  const t = await setup();
  try {
    const r = await O.runOffsiteUpload(t.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.name, NAME);
    assert.equal(r.size, t.files.get(NAME).data.length);
    assert.equal(r.sha256, sha(t.files.get(NAME).data));

    // The bytes on the server are a real crow-vault file of THIS backup, decryptable only with
    // the off-site key — the satellite never had anything else.
    const vaultFile = join(tmp("offsite-file-"), NAME);
    writeFileSync(vaultFile, t.files.get(NAME).data);
    const out = join(tmp("offsite-out-"), "crow.db");
    const header = await V.decryptVault({ file: vaultFile, out, key: t.key, date: DATE });
    assert.equal(header.backup_date, DATE);
    assert.equal(header.crow_id, CROW_ID);
    assert.equal(header.source_instance_id, "inst-test");
    assert.equal(sha(readFileSync(out)), sha(t.backupBytes));

    // The PUT was signed, declared its body hash up front, and the request carried the length.
    const put = t.fake.state.requests.find((q) => q.method === "PUT");
    assert.ok(put, "a PUT reached the satellite");
    assert.match(put.headers["X-Crow-Sat-Body-Sha256"], /^[0-9a-f]{64}$/);
    assert.equal(put.headers["X-Crow-Sat-Body-Sha256"], sha(t.files.get(NAME).data));
    assert.equal(put.headers["Content-Length"], String(t.files.get(NAME).data.length));
    assert.equal(put.headers["X-Crow-Sat-Caller"], "owner-local");

    // The encrypted temp copy does not survive the run.
    assert.deepEqual(scratchDirs(), [], "no crow-offsite-* scratch dir left behind");

    // The status the Servers page reads.
    const st = await O.readOffsiteStatus(t.db);
    assert.equal(st.last_uploaded_name, NAME);
    assert.equal(st.last_uploaded_size, r.size);
    assert.equal(Date.parse(st.last_uploaded_at), NOW);
    assert.equal(st.last_error, null);
    assert.equal(t.notify.length, 0);
  } finally { await closeAll(t); }
});

test("upload: a satellite that answers a wrong hash is a failed upload (and one notification)", async () => {
  for (const satellite of [{ putError: { status: 400, code: "hash_mismatch" } }, { tamperStore: true }]) {
    const t = await setup({ satellite });
    try {
      const r = await O.runOffsiteUpload(t.opts);
      assert.deepEqual(r, { ok: false, code: "upload_failed" }, JSON.stringify(satellite));
      assert.equal(t.notify.length, 1);
      assert.match(t.notify[0].title, /did not upload/i);
      // The encrypted temp copy is gone either way.
      assert.equal((await O.readOffsiteStatus(t.db)).last_uploaded_at, undefined);
      assert.equal((await O.readOffsiteStatus(t.db)).last_error, "upload_failed");
      // A second run the same day does not notify twice.
      await O.runOffsiteUpload(t.opts);
      assert.equal(t.notify.length, 1);
    } finally { await closeAll(t); }
  }
});

test("upload: no paired server, or no local backup yet → a skip with a reason and no notification", async () => {
  const none = await setup({ paired: false });
  try {
    assert.deepEqual(await O.runOffsiteUpload(none.opts), { ok: false, code: "no_satellite" });
    assert.equal(none.notify.length, 0);
    assert.equal(none.fake.state.requests.length, 0);
  } finally { await closeAll(none); }

  const t = await setup();
  try {
    rmSync(join(t.backupDir, t.backupName));
    assert.deepEqual(await O.runOffsiteUpload(t.opts), { ok: false, code: "no_backup" });
    assert.equal(t.notify.length, 0);
  } finally { await closeAll(t); }
});

test("upload: a local backup over 36 hours old is refused once a day, and nothing is sent", async () => {
  const t = await setup();
  const backupPath = join(t.backupDir, t.backupName);
  const age = (hours) => { const s = (NOW - hours * 3600_000) / 1000; utimesSync(backupPath, s, s); };
  try {
    age(37);
    const r = await O.runOffsiteUpload(t.opts);
    assert.deepEqual(r, { ok: false, code: "stale_backup" });
    assert.equal(t.notify.length, 1);
    assert.match(t.notify[0].body, /has not run for over a day/);
    assert.equal(t.fake.state.requests.length, 0, "nothing was sent");
    assert.equal(t.files.size, 0, "the old file was not re-sent");
    assert.equal((await O.readOffsiteStatus(t.db)).last_error, "stale_backup");

    // One notification a day for this reason: the same night, and six hours later, say nothing.
    await O.runOffsiteUpload(t.opts);
    await O.runOffsiteUpload({ ...t.opts, now: () => NOW + 6 * 3600_000 });
    assert.equal(t.notify.length, 1);
    await O.runOffsiteUpload({ ...t.opts, now: () => NOW + 24 * 3600_000 });
    assert.equal(t.notify.length, 2);

    // 35 hours is still fresh enough to send.
    age(35);
    const ok = await O.runOffsiteUpload(t.opts);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(t.files.has(NAME), true);
  } finally { await closeAll(t); }
});

test("upload: an unreachable paired server is tried, not skipped, so the night fails loudly", async () => {
  const t = await setup();
  try {
    t.fake.state.unreachable = true;
    const r = await O.runOffsiteUpload(t.opts);
    assert.deepEqual(r, { ok: false, code: "upload_failed" });
    assert.equal(t.notify.length, 1);
    assert.ok(t.fake.state.requests.length > 0, "it did try");
  } finally { await closeAll(t); }
});

// ── the satellite that hosts the vault ─────────────────────────────────────

test("no satellite is a skip even with no keychain export: a host that is not set up is never told to export a key", async () => {
  const t = await setup({ paired: false, exported: false });
  try {
    assert.deepEqual(await O.runOffsiteUpload(t.opts), { ok: false, code: "no_satellite" });
    assert.equal(t.notify.length, 0, "no notification: there is no off-site copy to make yet");
    assert.equal(t.fake.state.requests.length, 0);
    const st = await O.readOffsiteStatus(t.db);
    assert.equal(st.last_error, undefined, "nothing recorded as a failure");
  } finally { await closeAll(t); }
});

test("the off-site server is the first one paired, whatever its status — it never switches to another", async () => {
  // (a) A row marked unreachable is still the vault's host: the upload goes to it, not to the
  // server paired later.
  const first = await setup({ satellites: 2, statuses: ["unreachable", "active"] });
  try {
    const r = await O.runOffsiteUpload(first.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(first.fakes[0].state.requests.length > 0, "the first-paired server was used");
    assert.equal(first.fakes[1].state.requests.length, 0, "the second server was never contacted");
  } finally { await closeAll(first); }

  // (b) When the first-paired server cannot be reached the night fails with its normal
  // notification: silently failing over would move the vault and its retention history.
  const dead = await setup({ satellites: 2 });
  try {
    dead.fakes[0].state.unreachable = true;
    const r = await O.runOffsiteUpload(dead.opts);
    assert.deepEqual(r, { ok: false, code: "upload_failed" });
    assert.equal(dead.notify.length, 1);
    assert.ok(dead.fakes[0].state.requests.length > 0, "it tried the first-paired server");
    assert.equal(dead.fakes[1].state.requests.length, 0, "and never fell back to the other one");
    assert.equal(dead.files.size, 0, "nothing was written anywhere");
  } finally { await closeAll(dead); }

  // (c) Only a REVOKED server is passed over: the next by pairing time hosts the vault.
  const revoked = await setup({ satellites: 2, statuses: ["revoked", "active"] });
  try {
    const r = await O.runOffsiteUpload(revoked.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(revoked.fakes[0].state.requests.length, 0, "a revoked server is not the vault's host");
    assert.ok(revoked.fakes[1].state.requests.length > 0);
  } finally { await closeAll(revoked); }
});

test("retention: 7 daily + the last 4 Sundays are kept, everything else is deleted from the vault", async () => {
  const t = await setup();
  try {
    // 30 consecutive days of vault files, ending on the run date (a Monday).
    for (let i = 0; i < 30; i++) {
      const ms = NOW - i * 86_400_000;
      const day = new Date(ms).toISOString().slice(0, 10);
      const name = O.vaultNameForDate(day);
      t.files.set(name, { data: Buffer.from(`vault ${day}`), mtime: new Date(ms).toISOString() });
    }
    const before = t.files.size;
    const r = await O.runOffsiteUpload(t.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    // 7 daily + Sundays 11-01, 10-25, 10-18, 10-11 (Nov 2 is a Monday; the 7 daily are 10-27..11-02).
    const kept = [...t.files.keys()].sort();
    const expected = [
      "crow-db-20261011.vault", "crow-db-20261018.vault", "crow-db-20261025.vault", "crow-db-20261101.vault",
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => O.vaultNameForDate(new Date(NOW - i * 86_400_000).toISOString().slice(0, 10))),
    ].sort();
    assert.deepEqual(kept, [...new Set(expected)].sort());
    assert.equal(r.removed.length, before - new Set(expected).size);
    assert.equal(t.files.size, new Set(expected).size);
    const dels = t.fake.state.requests.filter((q) => q.method === "DELETE");
    assert.equal(dels.length, r.removed.length);
  } finally { await closeAll(t); }
});

test("retention: future-dated names take no daily slot, so tonight's upload and the real days survive", async () => {
  const t = await setup();
  try {
    // Eight files dated after today (a satellite clock that ran ahead) and ten real days back.
    const future = Array.from({ length: 8 }, (_, i) => new Date(NOW + (i + 1) * 86_400_000).toISOString().slice(0, 10));
    const past = Array.from({ length: 10 }, (_, i) => new Date(NOW - (i + 1) * 86_400_000).toISOString().slice(0, 10));
    for (const day of [...future, ...past]) {
      const ms = Date.parse(`${day}T00:00:00Z`);
      t.files.set(O.vaultNameForDate(day), { data: Buffer.from(`vault ${day}`), mtime: new Date(ms).toISOString() });
    }
    const r = await O.runOffsiteUpload(t.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(t.files.has(NAME), "the file just uploaded is never deleted by its own run");
    assert.ok(!r.removed.includes(NAME));
    for (const day of future) assert.ok(t.files.has(O.vaultNameForDate(day)), `future ${day} is kept`);
    // The 7 daily slots are real days (10-27 … 11-02) plus Sunday 10-25 — never a future name.
    for (const day of ["2026-11-02", "2026-11-01", "2026-10-31", "2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27", "2026-10-25"]) {
      assert.ok(t.files.has(O.vaultNameForDate(day)), `${day} is kept`);
    }
    // 10-26 is neither in the daily window nor a Sunday; 10-24 and 10-23 fall off the weekly edge.
    assert.deepEqual(r.removed.sort(), ["crow-db-20261023.vault", "crow-db-20261024.vault", "crow-db-20261026.vault"]);
  } finally { await closeAll(t); }
});

// ── the pure retention plan ────────────────────────────────────────────────
const names = (days) => days.map((d) => O.vaultNameForDate(d));

test("planRetention: 30 consecutive days → exactly 7 daily + 4 weekly, no duplicates, gaps handled", () => {
  // 2026-11-02 is a Monday. 30 days back: 2026-10-04 … 2026-11-02.
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-11-02T00:00:00Z") - i * 86_400_000).toISOString().slice(0, 10));
  const plan = O.planRetention(names(days), "2026-11-02");
  const daily = days.slice(0, 7); // 10-27 … 11-02
  const sundays = ["2026-11-01", "2026-10-25", "2026-10-18", "2026-10-11"];
  const expectKeep = [...new Set([...daily, ...sundays])].sort();
  assert.deepEqual([...plan.keep].sort(), names(expectKeep).sort());
  assert.equal(plan.keep.length, 10, "7 daily plus 3 Sundays outside the daily window (11-01 is already in it)");
  assert.equal(new Set(plan.keep).size, plan.keep.length, "no duplicates");
  assert.equal(plan.keep.length + plan.remove.length, 30, "every file is decided");
  for (const n of plan.remove) assert.ok(!plan.keep.includes(n));

  // Gaps: drop the Sunday files that are not already daily. Nothing is invented to fill them.
  const gapped = names(days.filter((d) => d !== "2026-10-11" && d !== "2026-10-18"));
  const gp = O.planRetention(gapped, "2026-11-02");
  assert.equal(gp.keep.length, 8);
  assert.ok(!gp.keep.includes("crow-db-20261011.vault"));
  assert.ok(!gp.remove.includes("crow-db-20261011.vault"), "a file that is not there is neither kept nor removed");
  assert.equal(gp.keep.length + gp.remove.length, 28);
});

test("planRetention: today on a Sunday keeps that Sunday once; a short history keeps everything; a future file is kept", () => {
  const sunday = "2026-11-08";
  const days = Array.from({ length: 10 }, (_, i) => new Date(Date.parse(`${sunday}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10));
  const plan = O.planRetention(names(days), sunday);
  // The 7 newest days (11-08 … 11-02) plus the previous Sunday 11-01, which today's Sunday does not
  // duplicate. 10-25 and 10-18 are outside the 10-day history.
  assert.equal(plan.keep.length, 8);
  assert.equal(new Set(plan.keep).size, 8, "no duplicates");
  assert.ok(plan.keep.includes("crow-db-20261108.vault"));
  assert.ok(plan.keep.includes("crow-db-20261101.vault"));
  assert.deepEqual(plan.remove, names(["2026-10-30", "2026-10-31"]));

  const few = O.planRetention(names(["2026-11-07", "2026-11-08"]), sunday);
  assert.deepEqual(few, { keep: names(["2026-11-07", "2026-11-08"]), remove: [] });

  const future = O.planRetention(names(["2026-11-08", "2026-11-30"]), sunday);
  assert.deepEqual(future.keep.sort(), names(["2026-11-08", "2026-11-30"]).sort(), "never deletes what it cannot reason about");
  assert.deepEqual(future.remove, []);

  // Not vault names: ignored entirely, never deleted by this plan.
  assert.deepEqual(O.planRetention(["README", "crow-db-2026-11-08.vault", "crow-db-20260230.vault"], sunday), { keep: [], remove: [] });
  assert.deepEqual(O.planRetention([], sunday), { keep: [], remove: [] });
});

test("planRetention: future-dated names take no slot, and the file just uploaded is always kept", () => {
  const past = Array.from({ length: 9 }, (_, i) => new Date(Date.parse("2026-11-02T00:00:00Z") - i * 86_400_000).toISOString().slice(0, 10));
  const future = Array.from({ length: 8 }, (_, i) => new Date(Date.parse("2026-11-03T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
  const plan = O.planRetention(names([...past, ...future]), "2026-11-02", { keepName: O.vaultNameForDate("2026-11-02") });
  // Before the fix the eight future names took the seven daily slots and pushed every real day —
  // tonight's upload included — into `remove`.
  for (const d of past.slice(0, 7)) assert.ok(plan.keep.includes(O.vaultNameForDate(d)), `daily ${d} is kept`);
  assert.ok(plan.keep.includes(O.vaultNameForDate("2026-10-25")), "the Sunday outside the daily window is kept");
  for (const d of future) assert.ok(plan.keep.includes(O.vaultNameForDate(d)), `future ${d} is kept`);
  assert.deepEqual(plan.remove, names(["2026-10-26"]), "only the one real day outside every window goes");
  assert.equal(plan.keep.length, 16);

  // keepName alone saves a file the date windows would have dropped: the file just uploaded (which
  // is also the one the satellite just confirmed) is never deleted.
  const twoDays = names(["2026-10-20", "2026-10-21"]);
  assert.deepEqual(O.planRetention(twoDays, "2026-10-21", { daily: 1, weekly: 0 }), { keep: names(["2026-10-21"]), remove: names(["2026-10-20"]) });
  assert.deepEqual(
    O.planRetention(twoDays, "2026-10-21", { daily: 1, weekly: 0, keepName: O.vaultNameForDate("2026-10-20") }),
    { keep: twoDays, remove: [] },
  );
});

test("vault names: a date in, the file name out, and a name back to its date", () => {
  assert.equal(O.vaultNameForDate("2026-11-02"), NAME);
  assert.deepEqual(O.parseVaultName(NAME), { name: NAME, date: DATE, ms: Date.parse(`${DATE}T00:00:00Z`) });
  for (const bad of ["crow-db-2026-11-02.vault", "crow-db-2026112.vault", "x.vault", "crow-db-20261332.vault", "", null]) {
    assert.equal(O.parseVaultName(bad), null, String(bad));
  }
});

// ── weekly verify ──────────────────────────────────────────────────────────

test("verify: a good file decrypts, integrity_check is ok, and the memory count matches the live DB", async () => {
  const t = await setup();
  try {
    await putRealVaultFile(t);
    const r = await O.runOffsiteVerify(t.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.name, NAME);
    assert.equal(r.memories, 10);
    assert.equal(r.live_memories, 10);
    assert.equal(t.notify.length, 0);
    const st = await O.readOffsiteStatus(t.db);
    assert.equal(st.last_verified_name, NAME);
    assert.equal(Date.parse(st.last_verified_at), NOW);
    // A signed manifest read and a plain download, no upload.
    assert.deepEqual([...new Set(t.fake.state.requests.map((q) => q.method))].sort(), ["GET"]);
    // No scratch copy survives.
    assert.deepEqual(scratchDirs(), [], "no crow-offsite-verify-* scratch dir left behind");
  } finally { await closeAll(t); }
});

test("verify: a flipped byte from the satellite fails the tag check, with one notification a day", async () => {
  const t = await setup();
  try {
    await putRealVaultFile(t);
    // The satellite corrupts the stored copy AND reports the corrupted hash, so the manifest check
    // passes and the failure is the vault's own authentication.
    const good = t.files.get(NAME).data;
    const bad = Buffer.from(good);
    bad[Math.floor(bad.length / 2)] ^= 0xff;
    t.files.set(NAME, { data: bad, mtime: new Date(NOW).toISOString() });
    const r = await O.runOffsiteVerify(t.opts);
    assert.deepEqual(r, { ok: false, code: "decrypt_failed" });
    assert.equal(t.notify.length, 1);
    assert.match(t.notify[0].title, /failed its check/i);
    assert.ok(!JSON.stringify(t.notify[0]).includes("crow.example"), "no hostname in the notification");
    assert.ok(!JSON.stringify(t.notify[0]).includes("vault"), "no path in the notification");
    assert.equal((await O.runOffsiteVerify(t.opts)).code, "decrypt_failed");
    assert.equal(t.notify.length, 1, "one a day");
  } finally { await closeAll(t); }
});

test("verify: a byte that no longer matches the signed manifest never reaches the decryptor", async () => {
  const t = await setup();
  try {
    await putRealVaultFile(t);
    const good = t.files.get(NAME).data;
    const bad = Buffer.from(good);
    bad[10] ^= 0xff;
    t.files.set(NAME, { data: bad, mtime: new Date(NOW).toISOString() });
    // The manifest is the SIGNED one: keep the old size/sha in the list by lying only in the body.
    t.fake.table["GET /satellite/v1/vault"] = () => ({ status: 200, json: [...t.files].map(([name, f]) => ({ name, size: good.length, sha256: sha(good), mtime: f.mtime })) });
    const r = await O.runOffsiteVerify(t.opts);
    assert.deepEqual(r, { ok: false, code: "download_failed" });
    assert.equal(t.notify.length, 1);
  } finally { await closeAll(t); }
});

test("verify: the 36-hour alarm reads the file's NAME date, not the satellite's mtime", async () => {
  // A satellite-reported mtime is not a clock crow trusts (F2): a file named today passes even when
  // the satellite claims it is four days old.
  const t = await setup();
  try {
    await putRealVaultFile(t, { mtime: new Date(NOW - 100 * 3600_000) });
    assert.equal((await O.runOffsiteVerify(t.opts)).ok, true);
    assert.equal(t.notify.length, 0);
  } finally { await closeAll(t); }

  // A file named 10-31 is 51 h old by its name: the alarm, and it is not even downloaded.
  const old = await setup();
  try {
    await putRealVaultFile(old, { backupDate: "2026-10-31", createdAt: new Date("2026-10-31T03:00:00Z") });
    const oldName = O.vaultNameForDate("2026-10-31");
    const downloads = () => old.fake.state.requests.filter((q) => q.path.endsWith("/" + oldName)).length;
    const before = downloads();
    const r = await O.runOffsiteVerify(old.opts);
    assert.deepEqual(r, { ok: false, code: "stale" });
    assert.equal(old.notify.length, 1);
    assert.match(old.notify[0].title, /36 hours/);
    assert.equal(downloads(), before, "no download");
    // Exactly one notification a day for this reason.
    assert.equal((await O.runOffsiteVerify(old.opts)).code, "stale");
    assert.equal(old.notify.length, 1);
    await O.runOffsiteVerify({ ...old.opts, now: () => NOW + 24 * 3600_000 });
    assert.equal(old.notify.length, 2);
  } finally { await closeAll(old); }

  // A file named yesterday is 27 h old by its date: still fresh enough.
  const y = await setup();
  try {
    await putRealVaultFile(y, { backupDate: "2026-11-01", createdAt: new Date("2026-11-01T03:00:00Z") });
    assert.equal((await O.runOffsiteVerify(y.opts)).ok, true);
  } finally { await closeAll(y); }
});

test("verify: a future-dated name is never chosen as the newest; the newest real day is", async () => {
  const t = await setup();
  try {
    await putRealVaultFile(t); // today's real file
    const future = Array.from({ length: 8 }, (_, i) => O.vaultNameForDate(new Date(NOW + (i + 1) * 86_400_000).toISOString().slice(0, 10)));
    for (const name of future) t.files.set(name, { data: Buffer.from(`future ${name}`), mtime: new Date(NOW).toISOString() });
    const r = await O.runOffsiteVerify(t.opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.name, NAME, "today's file, not a future-dated name");
    const fetched = t.fake.state.requests.map((q) => q.path);
    for (const name of future) assert.ok(!fetched.some((p) => p.endsWith("/" + name)), `${name} was not downloaded`);
  } finally { await closeAll(t); }
});

test("verify: a restored database with fewer than 90 % of the live memories is refused", async () => {
  const t = await setup({ memories: 100, backupMemories: 80 });
  try {
    await putRealVaultFile(t);
    const r = await O.runOffsiteVerify(t.opts);
    assert.deepEqual(r, { ok: false, code: "memories_low" });
    assert.equal(t.notify.length, 1);
    // 90 of 100 is enough (a backup taken before the last writes is normal).
    const t2 = await setup({ memories: 100, backupMemories: 91 });
    try {
      await putRealVaultFile(t2);
      assert.equal((await O.runOffsiteVerify(t2.opts)).ok, true);
    } finally { await closeAll(t2); }
  } finally { await closeAll(t); }
});

test("verify: no vault file yet, or no paired server, is a skip or a single alarm — never a crash", async () => {
  const empty = await setup();
  try {
    const r = await O.runOffsiteVerify(empty.opts);
    assert.deepEqual(r, { ok: false, code: "no_backups" });
    assert.equal(empty.notify.length, 1);
  } finally { await closeAll(empty); }
  const none = await setup({ paired: false });
  try {
    assert.deepEqual(await O.runOffsiteVerify(none.opts), { ok: false, code: "no_satellite" });
    assert.equal(none.notify.length, 0);
  } finally { await closeAll(none); }
});

test("upload then verify end to end, over the same fake server", async () => {
  const t = await setup();
  try {
    assert.equal((await O.runOffsiteUpload(t.opts)).ok, true);
    assert.equal(t.files.has(NAME), true);
    const v = await O.runOffsiteVerify(t.opts);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.name, NAME);
    assert.equal(v.memories, 10);
  } finally { await closeAll(t); }
});

test("the off-site key never appears in a notification, a status row or a job result", async () => {
  const t = await setup({ exported: false });
  try {
    await O.runOffsiteUpload(t.opts);
    await O.runOffsiteVerify(t.opts);
    const forms = [t.key.toString("base64"), t.key.toString("hex")];
    const surfaces = JSON.stringify(t.notify) + JSON.stringify(await O.readOffsiteStatus(t.db)) + JSON.stringify(t.fake.state.requests.map((r) => r.headers));
    for (const f of forms) assert.ok(!surfaces.includes(f), "the key is nowhere it could be stored or shown");
  } finally { await closeAll(t); }
});

// ── scratch cleanup (a killed run must not leave a decrypted database) ─────

test("an old scratch dir is swept by the next job, and a link under the prefix is never followed", async () => {
  const t = await setup();
  const oldScratch = mkdtempSync(join(tmpdir(), "crow-offsite-"));
  const target = tmp("offsite-link-target-");
  const linkName = `crow-offsite-link-${process.pid}-${Date.now()}`;
  const link = join(tmpdir(), linkName);
  try {
    writeFileSync(join(oldScratch, "crow.db"), "a decrypted database");
    const oldTime = new Date(Date.now() - 3 * 3600_000); // wall clock: the sweep's own age rule
    utimesSync(oldScratch, oldTime, oldTime);

    writeFileSync(join(target, "keep.txt"), "keep");
    symlinkSync(target, link);
    lutimesSync(link, oldTime, oldTime); // old, but still a link

    assert.equal((await O.runOffsiteUpload(t.opts)).ok, true);

    assert.equal(existsSync(oldScratch), false, "the old scratch dir is gone");
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "keep", "the link target was not touched");
    assert.ok(scratchDirs().includes(linkName), "the link itself is left alone");

    // The check sweeps too.
    const oldVerify = mkdtempSync(join(tmpdir(), "crow-offsite-verify-"));
    writeFileSync(join(oldVerify, "crow.db"), "a decrypted database");
    utimesSync(oldVerify, oldTime, oldTime);
    await putRealVaultFile(t);
    assert.equal((await O.runOffsiteVerify(t.opts)).ok, true);
    assert.equal(existsSync(oldVerify), false, "the check sweeps a killed check's scratch too");
  } finally {
    try { rmSync(link, { force: true }); } catch { /* gone */ }
    try { rmSync(oldScratch, { recursive: true, force: true }); } catch { /* gone */ }
    await closeAll(t);
  }
});

test("a killed job removes this run's scratch before exiting (SIGTERM and SIGINT)", async () => {
  // A real child process: the signal path (a handler, not an exception) is what the timer relies on.
  const moduleHref = new URL("../servers/gateway/satellites/offsite.js", import.meta.url).href;
  const script = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { installScratchCleanupOnSignal, makeScratch } from ${JSON.stringify(moduleHref)};
installScratchCleanupOnSignal();
const dir = makeScratch();
writeFileSync(join(dir, "crow.db"), "a decrypted database");
process.stdout.write("scratch:" + dir + "\\n");
setInterval(() => {}, 1000);
`;
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const dir = await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        out += d;
        const m = /^scratch:(.+)$/m.exec(out);
        if (m) resolve(m[1]);
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error(`the helper exited early: ${out}`)));
    });
    assert.equal(readFileSync(join(dir, "crow.db"), "utf8"), "a decrypted database");
    const closed = new Promise((resolve) => child.on("close", (c) => resolve(c)));
    child.kill(signal);
    assert.equal(await closed, code, `${signal} exits ${code}`);
    assert.equal(existsSync(dir), false, `${signal} took the scratch dir with it`);
  }
});

// ── the timer's entry point (scripts/offsite-run.mjs) ─────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "scripts", "offsite-run.mjs");

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A scratch home + data dir with the settings tables, and optionally one paired satellite row. */
function cliHome({ paired = false } = {}) {
  const home = tmp("offsite-cli-home-");
  const data = tmp("offsite-cli-data-");
  const db = new Database(join(data, "crow.db"));
  db.exec(SCHEMA);
  db.exec(SATELLITE_DDL);
  if (paired) {
    db.prepare(`INSERT INTO satellites (id, name, tailnet_host, satellite_pubkey, mgmt_pubkey, cert_json, cert_serial, cert_expires_at, primary_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "sat_cli0000000000000000", "sat", "satellite.example.ts.net", "a".repeat(64), "b".repeat(64),
      "{}", "s0", "2027-01-01T00:00:00Z", "https://crow.example.ts.net:8444", "active",
    );
  }
  db.close();
  return { ...process.env, CROW_HOME: home, CROW_DATA_DIR: data, CROW_DISABLE_INSTANCE_SYNC: "1" };
}

test("scripts/offsite-run.mjs: usage, a host with no satellite, and a missing export are clean results", async () => {
  const usage = await runCli([], { ...process.env });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /usage: node scripts\/offsite-run\.mjs upload\|verify/);

  // No server paired: nothing to do, whatever the export state is — and no keychain-export alert
  // (F3: a host with no satellite cannot export a key for one).
  for (const job of ["upload", "verify"]) {
    const r = await runCli([job], cliHome());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.split("\n")[0]), { ok: false, code: "no_satellite" });
    assert.match(r.stdout, /off-site (upload|verify) did not run to completion/);
    assert.equal(/at .*\.js:/.test(r.stderr), false, "no stack trace");
  }

  // A paired server and no keychain export: a real failure, exit 1, and still no stack trace.
  const up = await runCli(["upload"], cliHome({ paired: true }));
  assert.equal(up.code, 1, up.stderr);
  assert.deepEqual(JSON.parse(up.stdout.split("\n")[0]), { ok: false, code: "no_key_export" });
  assert.equal(/at .*\.js:/.test(up.stderr), false, "no stack trace");
});
test("a satellite list with an absurd size or a malformed hash is refused before any download", async () => {
  const { downloadVaultFile, MAX_VAULT_FILE_BYTES } = await import("../servers/gateway/satellites/offsite.js");
  let fetched = 0;
  const fetchImpl = async () => { fetched++; throw new Error("must not fetch"); };
  const base = { sat: { id: "sat-x", tailnet_host: "satellite.example.ts.net" }, name: "crow-db-20261101.vault", dest: "/nonexistent/x", mgmtKey: { ed25519_priv: "00".repeat(32) }, fetchImpl };
  const good = "a".repeat(64);
  for (const [size, sha] of [[Infinity, good], [Number.MAX_SAFE_INTEGER, good], [MAX_VAULT_FILE_BYTES + 1, good], [-1, good], ["100", good], [1.5, good], [100, "nothex"], [100, "A".repeat(64)], [100, undefined]]) {
    const r = await downloadVaultFile({ ...base, size, sha256: sha });
    assert.equal(r.code, "bad_manifest", `size=${String(size)} sha=${String(sha)}`);
  }
  assert.equal(fetched, 0, "nothing was fetched");
});
