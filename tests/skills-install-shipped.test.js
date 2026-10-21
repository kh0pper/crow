// Skills panel option C, PR 3: Apply update / Restore original / Restore write
// the extension's shipped skill on an explicit owner click. Each re-checks
// what the sync would do now and refuses if that changed since the page
// rendered (a race changes nothing), backs up an edited copy first, and
// writes in every sync mode (owner decision Q2).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, lstatSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShippedSkill, skillHash } from "../servers/gateway/bundle-skill-sync.js";

const scratch = mkdtempSync(join(tmpdir(), "install-shipped-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function world(shipped = "# Kiosk v2\n") {
  const root = join(scratch, `w${++n}`), home = join(root, "home"), apps = join(root, "apps");
  mkdirSync(join(home, "skills"), { recursive: true });
  mkdirSync(join(apps, "kiosk", "skills"), { recursive: true });
  writeFileSync(join(apps, "kiosk", "skills", "kiosk.md"), shipped);
  writeFileSync(join(apps, "kiosk", "manifest.json"), JSON.stringify({ id: "kiosk", skills: ["skills/kiosk.md"] }));
  writeFileSync(join(home, "installed.json"), JSON.stringify(["kiosk"]));
  const w = {
    home, apps,
    user: (t) => writeFileSync(join(home, "skills", "kiosk.md"), t),
    record: (o) => writeFileSync(join(home, "skill-installs.json"), typeof o === "string" ? o : JSON.stringify(o)),
    read: () => readFileSync(join(home, "skills", "kiosk.md"), "utf8"),
    rec: () => JSON.parse(readFileSync(join(home, "skill-installs.json"), "utf8"))["kiosk.md"],
    run: (expect) => installShippedSkill({ crowHome: home, appBundles: apps, skill: "kiosk.md", expect }),
    backups: () => { try { return readdirSync(join(home, "skill-backups")).sort(); } catch { return []; } },
  };
  return w;
}

test("apply update: an unedited stale copy is overwritten and the record updated", () => {
  const w = world(); w.user("# Kiosk v1\n"); w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# Kiosk v1\n"), installedAt: "t" } });
  assert.deepEqual(w.run(["refresh", "install"]), { ok: true, action: "refresh" });
  assert.equal(w.read(), "# Kiosk v2\n");
  assert.equal(w.rec().sha256, skillHash("# Kiosk v2\n"));
  assert.deepEqual(w.backups(), [], "nothing of the owner's to back up");
});

test("apply update refuses when the copy was edited since the page rendered; nothing written", () => {
  const w = world(); w.user("# Kiosk mine\n"); w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# Kiosk v1\n"), installedAt: "t" } });
  const before = readFileSync(join(w.home, "skill-installs.json"), "utf8");
  assert.deepEqual(w.run(["refresh", "install"]), { ok: false, error: "changed", action: "kept-edited", srcSha: skillHash("# Kiosk v2\n") });
  assert.equal(w.read(), "# Kiosk mine\n");
  assert.equal(readFileSync(join(w.home, "skill-installs.json"), "utf8"), before);
});

test("restore original: the edit is backed up byte-for-byte, then the shipped text written", () => {
  const w = world(); w.user("# Kiosk mine\r\nwith CRLF\n"); w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# Kiosk v1\n"), installedAt: "t" } });
  assert.equal(w.run(["kept-edited", "kept-unverified"]).ok, true);
  assert.equal(w.read(), "# Kiosk v2\n");
  const [b] = w.backups();
  assert.match(b, /^kiosk\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?Z?\.md$/);
  assert.equal(readFileSync(join(w.home, "skill-backups", b), "utf8"), "# Kiosk mine\r\nwith CRLF\n");
  assert.equal(w.rec().sha256, skillHash("# Kiosk v2\n"));
  assert.equal(w.rec().kept, undefined, "the kept/notified bookkeeping is reset");
});

test("restore a removed skill: a link tombstone becomes a regular file and the tombstone goes", () => {
  const w = world(); w.record({ "kiosk.md": { bundle: "kiosk", sha256: null, removedLink: true, removedAt: "t" } });
  assert.equal(w.run(["skip-deleted"]).ok, true);
  assert.ok(lstatSync(join(w.home, "skills", "kiosk.md")).isFile());
  assert.equal(w.read(), "# Kiosk v2\n");
  assert.equal(w.rec().removedLink, undefined);
  assert.equal(w.rec().sha256, skillHash("# Kiosk v2\n"));
});

test("writes in report mode too: an explicit click is the owner's intent", () => {
  const saved = process.env.CROW_SKILL_SYNC;
  process.env.CROW_SKILL_SYNC = "report";
  try {
    const w = world(); w.record({ "kiosk.md": { bundle: "kiosk", sha256: "abc", installedAt: "t" } });
    assert.equal(w.run(["skip-deleted"]).ok, true);
    assert.equal(w.read(), "# Kiosk v2\n");
  } finally { if (saved === undefined) delete process.env.CROW_SKILL_SYNC; else process.env.CROW_SKILL_SYNC = saved; }
});

test("refuses an unparseable record (byte-identical after), a link, a name no installed extension ships, and a bad name", () => {
  const w = world(); w.user("# Kiosk v1\n"); w.record("{ not json");
  assert.deepEqual(w.run(["refresh", "install", "kept-edited", "kept-unverified", "skip-deleted"]), { ok: false, error: "record-unreadable" });
  assert.equal(readFileSync(join(w.home, "skill-installs.json"), "utf8"), "{ not json");
  assert.equal(w.read(), "# Kiosk v1\n");
  const l = world(); writeFileSync(join(scratch, "elsewhere.md"), "# x\n"); symlinkSync(join(scratch, "elsewhere.md"), join(l.home, "skills", "kiosk.md"));
  assert.equal(l.run(["refresh", "kept-edited", "skip-deleted"]).ok, false);
  assert.equal(readFileSync(join(scratch, "elsewhere.md"), "utf8"), "# x\n", "never written through a link");
  const u = world(); writeFileSync(join(u.home, "installed.json"), "[]");
  assert.deepEqual(installShippedSkill({ crowHome: u.home, appBundles: u.apps, skill: "kiosk.md", expect: ["install"] }), { ok: false, error: "not-shipped" });
  assert.deepEqual(installShippedSkill({ crowHome: u.home, appBundles: u.apps, skill: "../x.md", expect: ["install"] }), { ok: false, error: "not-shipped" });
  assert.equal(existsSync(join(u.home, "skills", "kiosk.md")), false);
});

test("keeps only the newest 5 backups per name", () => {
  const w = world();
  mkdirSync(join(w.home, "skill-backups"), { recursive: true });
  for (let i = 0; i < 7; i++) writeFileSync(join(w.home, "skill-backups", `kiosk.2020-01-0${i + 1}T00-00-00Z.md`), `old ${i}`);
  writeFileSync(join(w.home, "skill-backups", "other.2020-01-01T00-00-00Z.md"), "other");
  w.user("# mine\n"); w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# v1\n"), installedAt: "t" } });
  assert.equal(w.run(["kept-edited"]).ok, true);
  const b = w.backups();
  assert.equal(b.filter((f) => f.startsWith("kiosk.")).length, 5);
  assert.ok(!b.includes("kiosk.2020-01-01T00-00-00Z.md"), "the oldest went");
  assert.ok(b.includes("other.2020-01-01T00-00-00Z.md"), "other names untouched");
});


test("apply refuses when the shipped version changed since the page rendered (srcSha), and a backups path that isn't a real directory", () => {
  const w = world(); w.user("# Kiosk v1\n"); w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# Kiosk v1\n"), installedAt: "t" } });
  const r = installShippedSkill({ crowHome: w.home, appBundles: w.apps, skill: "kiosk.md", expect: ["refresh"], srcSha: skillHash("# some other version\n") });
  assert.equal(r.ok, false);
  assert.equal(r.error, "changed");
  assert.equal(w.read(), "# Kiosk v1\n");
  assert.equal(installShippedSkill({ crowHome: w.home, appBundles: w.apps, skill: "kiosk.md", expect: ["refresh"], srcSha: skillHash("# Kiosk v2\n") }).ok, true);
  const again = installShippedSkill({ crowHome: w.home, appBundles: w.apps, skill: "kiosk.md", expect: ["refresh"], srcSha: skillHash("# Kiosk v2\n") });
  assert.deepEqual([again.ok, again.error, again.action, again.srcSha], [false, "changed", "same", skillHash("# Kiosk v2\n")], "a second click reports that the shipped version is already there");

  const b = world(); b.user("# mine\n"); b.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# v1\n"), installedAt: "t" } });
  writeFileSync(join(scratch, "not-a-dir"), "x");
  symlinkSync(join(scratch, "not-a-dir"), join(b.home, "skill-backups"));
  assert.deepEqual(b.run(["kept-edited"]), { ok: false, error: "backup-dir" });
  assert.equal(b.read(), "# mine\n", "nothing replaced without a backup");
});

test("backups are created with mode 600", async () => {
  const { statSync } = await import("node:fs");
  const w = world(); w.user("# mine\n"); w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# v1\n"), installedAt: "t" } });
  const r = w.run(["kept-edited"]);
  assert.equal(statSync(join(w.home, "skill-backups", r.backup)).mode & 0o777, 0o600);
});
