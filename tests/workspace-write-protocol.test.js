import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

let fake, W, cfg, clock;
const text = (b) => Buffer.from(b).toString();
const appendMut = (s) => async (bytes) => ({ bytes: Buffer.from(text(bytes) + s), changed: 1, summary: `append ${s}` });
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  cfg = Object.freeze({ user: "crow-bot", appPassword: "pw", jwtSecret: "jwt", ncUrl: fake.ncUrl, ooUrl: fake.ooUrl, host: "h", webBase: "https://h:8456", secrets: ["pw", "jwt"] });
  W = await import("../bundles/workspace/server/write-protocol.js");
  let t = 0; clock = { now: () => t, sleep: async (ms) => { t += ms; fake.advance(ms); } };
});
after(() => fake.close());

test("unlocked write: one PUT, two labels, decodable version_id", async () => {
  const n = fake.addFile("S/a.txt", Buffer.from("x"), { owner: "admin" });
  const before = n.mtime;
  const r = await W.withFileWrite(cfg, { path: "S/a.txt" }, appendMut("y"), { clock });
  assert.equal(text(fake.node("S/a.txt").bytes), "xy");
  assert.equal(r.changed, 1);
  const v = W.decodeVersionId(r.version_id);
  assert.equal(v.f, n.fileId); assert.equal(v.b, String(before));
  const labels = fake.versionsOf("S/a.txt").map((x) => x.label);
  assert.ok(labels.includes("Before Crow: append y") && labels.includes("Crow: append y"));
});

test("zero changes → no PUT, no version", async () => {
  fake.addFile("S/z.txt", Buffer.from("x"));
  const puts = () => fake.calls.filter((c) => c.method === "PUT").length;
  const p0 = puts();
  const r = await W.withFileWrite(cfg, { path: "S/z.txt" }, async () => ({ changed: 0 }), { clock });
  assert.equal(r.version_id, null); assert.equal(puts(), p0);
});

test("editor lock clears inside 30 s → waits, then writes", async () => {
  fake.addFile("S/w.docx", Buffer.from("d"));
  fake.openInEditor("S/w.docx", ["admin"]);
  fake.state.pendingReleases.push({ at: fake.state.now + 6000, fn: () => { fake.node("S/w.docx").lock = null; } });
  const r = await W.withFileWrite(cfg, { path: "S/w.docx" }, appendMut("!"), { clock, ifOpen: "wait", waitS: 30 });
  assert.equal(r.changed, 1);
});

test("default with no queue provider = no wait, open_in_editor at once; queue provider → enqueue is called, nothing written", async () => {
  fake.addFile("S/q.docx", Buffer.from("d")); fake.openInEditor("S/q.docx", ["dayane"]);
  const t0 = clock.now();
  await assert.rejects(W.withFileWrite(cfg, { path: "S/q.docx" }, appendMut("!"), { clock }), (e) => e.code === "open_in_editor");
  assert.equal(clock.now(), t0, "default wait_s is 0");
  let got = null; const puts = fake.calls.filter((c) => c.method === "PUT").length;
  const r = await W.withFileWrite(cfg, { path: "S/q.docx" }, appendMut("!"), { clock, queue: { enqueue: async (sig) => { got = sig; return { queued: true, change_id: "pc_x" }; } } });
  assert.deepEqual(r, { queued: true, change_id: "pc_x" }); assert.equal(got.lock.data.open_by[0], "Dayane");
  assert.equal(fake.calls.filter((c) => c.method === "PUT").length, puts);
});

test("still open after 30 s (if_open wait) → open_in_editor naming the person, can_proceed", async () => {
  fake.addFile("S/o.docx", Buffer.from("d"));
  fake.openInEditor("S/o.docx", ["dayane"]);
  await assert.rejects(W.withFileWrite(cfg, { path: "S/o.docx" }, appendMut("!"), { clock, ifOpen: "wait", waitS: 30 }),
    (e) => e.code === "open_in_editor" && e.data.open_by[0] === "Dayane" && e.data.can_proceed === true && /open in the editor/.test(e.message));
});

test("proceed → drop → editor saves its typing first → bot change on top", async () => {
  fake.addFile("S/p.docx", Buffer.from("base"));
  fake.openInEditor("S/p.docx", ["admin"], { releaseAfterMs: 5000, typed: Buffer.from("base+kevin") });
  const r = await W.withFileWrite(cfg, { path: "S/p.docx" }, appendMut("+bot"), { clock, ifOpen: "force_close" });
  assert.equal(text(fake.node("S/p.docx").bytes), "base+kevin+bot");
  assert.ok(fake.calls.some((c) => c.method === "OO" && c.body?.c === "drop" && c.body.users[0] === "ocinst_admin"));
  assert.ok(r.version_id);
});

test("drop that never releases → could_not_close_editor", async () => {
  fake.addFile("S/n.docx", Buffer.from("d"));
  fake.openInEditor("S/n.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  await assert.rejects(W.withFileWrite(cfg, { path: "S/n.docx" }, appendMut("!"), { clock, ifOpen: "force_close" }), (e) => e.code === "could_not_close_editor");
});

test("a person's manual lock is never overridden, even with proceed", async () => {
  fake.addFile("S/m.docx", Buffer.from("d"), { lock: { type: 0, owner: "dayane", displayName: "Dayane" } });
  await assert.rejects(W.withFileWrite(cfg, { path: "S/m.docx" }, appendMut("!"), { clock, ifOpen: "force_close", waitS: 0 }),
    (e) => e.code === "locked_by_person" && e.data.can_proceed === false);
  assert.ok(!fake.calls.some((c) => c.method === "OO" && c.body?.c === "drop" && c.body.key === "k" + fake.node("S/m.docx").fileId));
});

test("editor lock with no live session → stale_editor_lock, no drop", async () => {
  fake.addFile("S/s.docx", Buffer.from("d"), { owner: "admin", lock: { type: 1, owner: "onlyoffice", displayName: "ONLYOFFICE" } });
  await assert.rejects(W.withFileWrite(cfg, { path: "S/s.docx" }, appendMut("!"), { clock, waitS: 0, ifOpen: "force_close" }),
    (e) => e.code === "stale_editor_lock" && /Unlock/.test(e.message));
});

test("412 once → re-read and re-apply; twice → changed_concurrently", async () => {
  fake.addFile("S/c.txt", Buffer.from("1"));
  let n = 0;
  const r = await W.withFileWrite(cfg, { path: "S/c.txt" }, async (bytes) => { if (n++ === 0) { fake.node("S/c.txt").etag = '"bumped"'; } return { bytes: Buffer.from(text(bytes) + "2"), changed: 1, summary: "x" }; }, { clock });
  assert.equal(text(fake.node("S/c.txt").bytes), "12"); assert.ok(r.version_id);
  await assert.rejects(W.withFileWrite(cfg, { path: "S/c.txt" }, async (bytes) => { fake.node("S/c.txt").etag = `"b${Math.random()}"`; return { bytes, changed: 1, summary: "x" }; }, { clock }), (e) => e.code === "changed_concurrently");
});

test("concurrent writes to one file serialize and both apply (Review Focus 2)", async () => {
  fake.addFile("S/k.txt", Buffer.from(""));
  const v0 = fake.versionsOf("S/k.txt").length;
  const t0 = clock.now();
  const [a, b] = await Promise.all([
    W.withFileWrite(cfg, { path: "S/k.txt" }, appendMut("A"), { clock }),
    W.withFileWrite(cfg, { path: "S/k.txt" }, appendMut("B"), { clock }),
  ]);
  const final = text(fake.node("S/k.txt").bytes);
  assert.ok(final === "AB" || final === "BA", final);
  assert.equal(fake.versionsOf("S/k.txt").length, v0 + 2);
  assert.ok(clock.now() - t0 >= 1100, "second write waited ≥ 1.1 s");
  assert.notEqual(a.version_id, b.version_id);
});

test("undo restores the before-version; refuses once the file changed since", async () => {
  fake.addFile("S/u.txt", Buffer.from("orig"));
  const r = await W.withFileWrite(cfg, { path: "S/u.txt" }, appendMut("-bot"), { clock });
  const u = await W.undoFileChange(cfg, { path: "S/u.txt" }, r.version_id, { clock });
  assert.equal(text(fake.node("S/u.txt").bytes), "orig");
  assert.ok(u.version_id, "undo is itself undoable");
  const r2 = await W.withFileWrite(cfg, { path: "S/u.txt" }, appendMut("-again"), { clock });
  await W.withFileWrite(cfg, { path: "S/u.txt" }, appendMut("-human"), { clock });
  await assert.rejects(W.undoFileChange(cfg, { path: "S/u.txt" }, r2.version_id, { clock }), (e) => e.code === "changed_since");
});

test("undo with proceed: the editor's drop-save changes the file → changed_since, nothing restored (review C3)", async () => {
  fake.addFile("S/up.docx", Buffer.from("orig"));
  const r = await W.withFileWrite(cfg, { path: "S/up.docx" }, appendMut("+bot"), { clock });
  fake.openInEditor("S/up.docx", ["admin"], { releaseAfterMs: 3000, typed: Buffer.from("orig+bot+kevin") });
  await assert.rejects(W.undoFileChange(cfg, { path: "S/up.docx" }, r.version_id, { clock, ifOpen: "force_close" }), (e) => e.code === "changed_since");
  assert.equal(text(fake.node("S/up.docx").bytes), "orig+bot+kevin");
});

test("proceed: the person's save and the bot write become two DISTINCT versions (same-second overwrite modelled, review C2)", async () => {
  fake.state.realisticMtime = () => Math.floor(clock.now() / 1000);
  fake.addFile("S/two.docx", Buffer.from("base"));
  fake.openInEditor("S/two.docx", ["admin"], { releaseAfterMs: 500, typed: Buffer.from("base+kevin") });
  const v0 = fake.versionsOf("S/two.docx").length;
  await W.withFileWrite(cfg, { path: "S/two.docx" }, appendMut("+bot"), { clock, ifOpen: "force_close" });
  const vs = fake.versionsOf("S/two.docx");
  assert.equal(vs.length, v0 + 2, "kevin's save and the bot write are separate rows");
  assert.equal(vs.at(-2).bytes.toString(), "base+kevin");
  fake.state.realisticMtime = null;
});

test("version_id carries the PUT's own etag, not a later write's", async () => {
  fake.addFile("S/et.txt", Buffer.from("a"));
  fake.state.afterPutHook = (n) => { if (n.path === "S/et.txt") { n.bytes = Buffer.from("a+bot+sneaky"); n.etag = '"sneaky"'; } };
  const r = await W.withFileWrite(cfg, { path: "S/et.txt" }, appendMut("+bot"), { clock });
  fake.state.afterPutHook = null;
  assert.notEqual(W.decodeVersionId(r.version_id).a, "sneaky");
  await assert.rejects(W.undoFileChange(cfg, { path: "S/et.txt" }, r.version_id, { clock }), (e) => e.code === "changed_since");
});

test("undo of an undo works, and restoring onto a human-labeled version keeps that label (review r2)", async () => {
  const n = fake.addFile("S/uu.txt", Buffer.from("v1"));
  n.versions[0].label = "Kevin: approved";
  const r = await W.withFileWrite(cfg, { path: "S/uu.txt" }, appendMut("+bot"), { clock });
  const u = await W.undoFileChange(cfg, { path: "S/uu.txt" }, r.version_id, { clock });
  assert.equal(text(fake.node("S/uu.txt").bytes), "v1");
  assert.equal(fake.versionsOf("S/uu.txt").find((x) => x.bytes.toString() === "v1").label, "Kevin: approved");
  await W.undoFileChange(cfg, { path: "S/uu.txt" }, u.version_id, { clock });
  assert.equal(text(fake.node("S/uu.txt").bytes), "v1+bot");
});

test("a person's own version label is never overwritten (review I9)", async () => {
  const n = fake.addFile("S/lab.txt", Buffer.from("a"));
  n.versions[0].label = "Kevin: final draft";
  await W.withFileWrite(cfg, { path: "S/lab.txt" }, appendMut("b"), { clock });
  assert.equal(fake.versionsOf("S/lab.txt")[0].label, "Kevin: final draft");
});

test("undo of a created file moves it to the trash; a forged version_id is refused", async () => {
  fake.addFolder("S/new");
  const c = await W.createFile(cfg, ["S", "new"], "made.txt", Buffer.from("hi"), { label: "Crow", summary: "create" });
  await W.undoFileChange(cfg, { path: "S/new/made.txt" }, c.version_id, { clock });
  assert.equal(fake.node("S/new/made.txt"), undefined);
  assert.throws(() => W.decodeVersionId("v1.notbase64!!"), (e) => e.code === "bad_version_id");
});

test("423 between lock check and PUT: the retry keeps the caller's if_open (queue) (spec §5 step 6)", async () => {
  fake.addFile("S/r423.docx", Buffer.from("d"));
  let got = null;
  const queue = { enqueue: async (sig) => { got = sig; return { queued: true, change_id: "pc_423" }; } };
  const r = await W.withFileWrite(cfg, { path: "S/r423.docx" }, async (bytes) => {
    if (!fake.node("S/r423.docx").lock) fake.openInEditor("S/r423.docx", ["dayane"]); // the editor opens it mid-write
    return { bytes: Buffer.concat([Buffer.from(bytes), Buffer.from("!")]), changed: 1, summary: "x" };
  }, { clock, queue });
  assert.deepEqual(r, { queued: true, change_id: "pc_423" });
  assert.equal(got.lock.code, "open_in_editor");
  assert.equal(text(fake.node("S/r423.docx").bytes), "d");
});

test("force_close: a 423 on the retry never sends a second drop", async () => {
  fake.addFile("S/twice.docx", Buffer.from("base"));
  const key = fake.openInEditor("S/twice.docx", ["admin"], { releaseAfterMs: 1000 });
  const drops = () => fake.calls.filter((c) => c.method === "OO" && c.body?.c === "drop" && c.body.key === key).length;
  await assert.rejects(W.withFileWrite(cfg, { path: "S/twice.docx" }, async (bytes) => {
    if (!fake.node("S/twice.docx").lock) fake.openInEditor("S/twice.docx", ["admin"], { releaseAfterMs: 1000 }); // re-opened right after the drop
    return { bytes: Buffer.from(bytes), changed: 1, summary: "x" };
  }, { clock, ifOpen: "force_close" }), (e) => e.code === "open_in_editor");
  assert.equal(drops(), 1, "exactly one drop");
});

test("undo of a created file that is open: queued like any write (F12), nothing removed", async () => {
  fake.addFolder("S/q2");
  const c = await W.createFile(cfg, ["S", "q2"], "made.docx", Buffer.from("hi"), { clock });
  fake.openInEditor("S/q2/made.docx", ["dayane"]);
  let got = null;
  const r = await W.undoFileChange(cfg, { path: "S/q2/made.docx" }, c.version_id, { clock, queue: { enqueue: async (sig) => { got = sig; return { queued: true, change_id: "pc_u" }; } } });
  assert.deepEqual(r, { queued: true, change_id: "pc_u" });
  assert.deepEqual(got.lock.data.open_by, ["Dayane"]);
  assert.ok(fake.node("S/q2/made.docx"));
  // without a queue provider the default (queue, wait 0) surfaces open_in_editor at once
  const t0 = clock.now();
  await assert.rejects(W.undoFileChange(cfg, { path: "S/q2/made.docx" }, c.version_id, { clock }), (e) => e.code === "open_in_editor");
  assert.equal(clock.now(), t0, "default wait_s is 0");
});

test("createFile and withFileWrite share the injected clock for the 1.1 s spacing", async () => {
  fake.addFolder("S/cl");
  const t0 = clock.now();
  await W.createFile(cfg, ["S", "cl"], "c.txt", Buffer.from("a"), { clock });
  await W.withFileWrite(cfg, { path: "S/cl/c.txt" }, appendMut("b"), { clock });
  const spent = clock.now() - t0;
  assert.ok(spent >= 1100 && spent < 10_000, `spacing measured on one clock (spent ${spent} ms)`);
  // a created file's PUT etag is the undo token's after-etag
  assert.equal(text(fake.node("S/cl/c.txt").bytes), "ab");
});

test("classifyLock keys on lock-owner-type only: a NULL owner (spike S6) is still an editor lock", async () => {
  const { classifyLock } = await import("../bundles/workspace/server/nc/locks.js");
  const { stat } = await import("../bundles/workspace/server/nc/dav.js");
  fake.addFile("S/cls.docx", Buffer.from("d")); fake.openInEditor("S/cls.docx", ["admin", "dayane"]);
  const c = await classifyLock(cfg, await stat(cfg, ["S", "cls.docx"]));
  assert.equal(c.code, "open_in_editor"); assert.deepEqual(c.data.open_by, ["Kevin", "Dayane"]);
  assert.deepEqual(c.users, ["ocinst_admin", "ocinst_dayane"]); assert.match(c.message, /Kevin and Dayane have/);
  fake.addFile("S/tok.docx", Buffer.from("d"), { lock: { type: 2, owner: null, displayName: null } });
  const t = await classifyLock(cfg, await stat(cfg, ["S", "tok.docx"]));
  assert.equal(t.code, "locked_by_person"); assert.match(t.message, /^Someone locked/);
});
