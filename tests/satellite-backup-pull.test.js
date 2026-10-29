// Pulling a satellite bundle's newest backup to crow (SAT-5, spec §7.2; the timer is deferred to
// deploy): the signed manifest names the file, its size and sha256; the plain stream must match
// both or nothing is kept; files land in <root>/<sat>/<bundle>/ at 700/600.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const HOME = mkdtempSync(join(tmpdir(), "satpull-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satpull-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const { pullNewestBackup } = await import("../servers/gateway/satellites/backup-pull.js");
const { createMgmtFake, makeSatelliteRow } = await import("./helpers/fake-satellite-mgmt.js");

const sha = (b) => createHash("sha256").update(b).digest("hex");

async function setup(files, { lie = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "satpull-db-"));
  const root = mkdtempSync(join(tmpdir(), "satpull-root-"));
  dirs.push(dir, root);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  const fake = createMgmtFake({
    routes: {
      "GET /satellite/v1/bundles/:id/backups": () => ({ status: 200, json: { backups: files.map((f) => ({ name: f.name, size: lie.size ?? f.data.length, sha256: lie.sha ?? sha(f.data), created_at: f.at })) } }),
      "GET /satellite/v1/bundles/:id/backups/:name": ({ params }) => {
        const f = files.find((x) => x.name === params.name);
        return f ? { status: 200, raw: lie.stream ?? f.data } : { status: 404, json: { error: "not_found" } };
      },
    },
  });
  await makeSatelliteRow(db, fake);
  return { db, fake, root };
}

const FILES = [
  { name: "gitea-dump-2.zip", data: Buffer.from("newest dump bytes"), at: "2026-11-02T00:00:00.000Z" },
  { name: "gitea-dump-1.zip", data: Buffer.from("older"), at: "2026-11-01T00:00:00.000Z" },
];

test("the newest backup is pulled, checked and stored at 700/600; a second pull is up to date", async () => {
  const s = await setup(FILES);
  const r = await pullNewestBackup(s.fake.satId, "gitea", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root });
  assert.equal(r.pulled, true, JSON.stringify(r));
  assert.equal(r.name, "gitea-dump-2.zip");
  const dir = join(s.root, s.fake.satId, "gitea");
  assert.equal(readFileSync(join(dir, "gitea-dump-2.zip"), "utf8"), "newest dump bytes");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "gitea-dump-2.zip")).mode & 0o777, 0o600);
  // Both requests were signed owner requests.
  const reqs = s.fake.state.requests.filter((q) => q.path.includes("/backups"));
  assert.equal(reqs.length, 2);
  for (const q of reqs) assert.ok(q.headers["X-Crow-Sat-Sig"]);
  const again = await pullNewestBackup(s.fake.satId, "gitea", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root });
  assert.deepEqual([again.pulled, again.code], [false, "up_to_date"]);
  assert.equal(s.fake.state.requests.filter((q) => q.path.includes("/backups/")).length, 1, "no second download");
});

test("a sha256 or size mismatch keeps nothing", async () => {
  for (const lie of [{ sha: "0".repeat(64) }, { stream: Buffer.from("newest dump bytes and more") }, { stream: Buffer.from("short") }]) {
    const s = await setup(FILES, { lie });
    const r = await pullNewestBackup(s.fake.satId, "gitea", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root });
    assert.equal(r.pulled, false);
    assert.match(r.code, /^(sha256_mismatch|size_mismatch|too_large)$/, JSON.stringify(lie));
    const dir = join(s.root, s.fake.satId, "gitea");
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], "no partial or temp file left");
  }
});

test("no backups, a bad name in the manifest, a bad bundle id, an unknown satellite", async () => {
  const s = await setup([]);
  assert.equal((await pullNewestBackup(s.fake.satId, "gitea", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root })).code, "no_backups");
  const b = await setup([{ name: "../escape.zip", data: Buffer.from("x"), at: "2026-11-02T00:00:00.000Z" }]);
  assert.equal((await pullNewestBackup(b.fake.satId, "gitea", { db: b.db, fetchImpl: b.fake.fetchImpl, root: b.root })).code, "bad_manifest");
  await assert.rejects(pullNewestBackup(s.fake.satId, "../x", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root }), /bad bundle/);
  assert.equal((await pullNewestBackup("sat_zzzzzzzzzzzzzzzzzzzz", "gitea", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root })).code, "not_found");
});

test("a symlinked destination dir is refused", async () => {
  const s = await setup(FILES);
  const elsewhere = mkdtempSync(join(tmpdir(), "satpull-else-"));
  dirs.push(elsewhere);
  mkdirSync(join(s.root, s.fake.satId), { recursive: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(elsewhere, join(s.root, s.fake.satId, "gitea"));
  const r = await pullNewestBackup(s.fake.satId, "gitea", { db: s.db, fetchImpl: s.fake.fetchImpl, root: s.root });
  assert.equal(r.code, "bad_destination");
  assert.deepEqual(readdirSync(elsewhere), []);
  writeFileSync(join(elsewhere, "keep"), "x");
});
