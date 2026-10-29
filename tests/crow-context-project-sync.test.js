/**
 * A project-scoped crow.md section (crow_context) keeps its project across
 * instance sync, or stays home.
 *
 * crow_context.project_id is a LOCAL FK: project_spaces ids are per-instance,
 * so the same project is id 3 on one Crow and id 7 on another, and a sibling's
 * id 3 may be an unrelated project. The portable id is project_spaces.uuid:
 *   - outbound: OUTBOUND_TRANSFORMS.crow_context removes project_id; the
 *     sender's project uuid rides as project_uuid (null: no key at all);
 *   - inbound: mapInboundContextProject maps project_uuid to the local id, and
 *     DROPS the entry when this Crow has no such project or the sender sent a
 *     raw project_id (an un-upgraded peer);
 *   - project-scoped emission is gated (CROW_CONTEXT_PROJECT_SYNC=1) until
 *     every paired peer runs the receiver: an old receiver ignores
 *     project_uuid and would apply the section as its GLOBAL one.
 *
 * Real init-db stores and real InstanceSyncManagers (tests/fixtures/sync-fleet.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InstanceSyncManager, mapInboundContextProject, crowContextProjectUuid, contextProjectSyncEnabled,
  shouldSyncRow, buildCrowContextWireRow,
} from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { makeFleet, linkPeers, until } from "./fixtures/sync-fleet.mjs";

const U = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // the shared project: A id 3, B id 7
const V = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // B's UNRELATED project with id 3
const D = "dddddddddddddddddddddddddddddddd"; // a project B does not have (yet)
const K = "ctx_uuid_test";

async function addProject(db, id, uuid) {
  await db.execute({ sql: "INSERT INTO project_spaces (id, uuid, slug, name) VALUES (?, ?, ?, ?)", args: [id, uuid, `p${id}`, `p${id}`] });
}

async function seedSection(db, { key = K, content, deviceId = null, projectId = null, lamport = 1 }) {
  await db.execute({
    sql: `INSERT INTO crow_context (section_key, section_title, content, sort_order, enabled, device_id, project_id, lamport_ts)
          VALUES (?, 'T', ?, 100, 1, ?, ?, ?)`,
    args: [key, content, deviceId, projectId, lamport],
  });
}

/** Every row for the key, as [device_id, project_id, content] sorted. */
async function sections(db, key = K) {
  const { rows } = await db.execute({ sql: "SELECT device_id, project_id, content FROM crow_context WHERE section_key = ? ORDER BY project_id, device_id", args: [key] });
  return rows.map((r) => [r.device_id ?? null, r.project_id == null ? null : Number(r.project_id), r.content]);
}

async function count(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM crow_context");
  return Number(rows[0].n);
}

const wire = (extra) => ({ section_key: K, section_title: "T", content: "from A", sort_order: 100, enabled: 1, device_id: null, ...extra });

function signedEntry(identity, instanceId, entry) {
  const e = { ...entry, instance_id: instanceId };
  return { ...e, signature: sign(JSON.stringify(e), identity.ed25519Priv) };
}

/** Capture console.warn while `fn` runs. */
async function warnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => { seen.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.warn = orig; }
  return seen;
}

async function withGate(value, fn) {
  const prev = process.env.CROW_CONTEXT_PROJECT_SYNC;
  if (value === undefined) delete process.env.CROW_CONTEXT_PROJECT_SYNC;
  else process.env.CROW_CONTEXT_PROJECT_SYNC = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CROW_CONTEXT_PROJECT_SYNC;
    else process.env.CROW_CONTEXT_PROJECT_SYNC = prev;
  }
}

async function bFleet() {
  const fleet = await makeFleet();
  await addProject(fleet.a.db, 3, U);
  await addProject(fleet.b.db, 7, U);
  await addProject(fleet.b.db, 3, V);
  return fleet;
}

// ---------------------------------------------------------------- Task 1: the receiver

test("mapInboundContextProject: uuid maps, raw ids drop, unknown uuids drop, no key is global; pure", async () => {
  const fleet = await bFleet();
  try {
    const db = fleet.b.db;
    const r1 = wire({ project_uuid: U });
    assert.deepEqual(await mapInboundContextProject(db, r1), { row: { ...wire(), project_id: 7 }, drop: null });
    assert.equal(r1.project_uuid, U, "pure: input untouched");
    assert.deepEqual(await mapInboundContextProject(db, wire({ project_id: 3, project_uuid: U })), { row: { ...wire(), project_id: 7 }, drop: null },
      "a raw project_id alongside a uuid is ignored");
    const raw = await mapInboundContextProject(db, wire({ project_id: 3 }));
    assert.match(raw.drop, /raw project_id/);
    const unknown = await mapInboundContextProject(db, wire({ project_uuid: D }));
    assert.match(unknown.drop, /unknown or archived project uuid/);
    assert.deepEqual(await mapInboundContextProject(db, wire()), { row: { ...wire(), project_id: null }, drop: null }, "no key: global");
    assert.deepEqual(await mapInboundContextProject(db, wire({ project_id: null })), { row: { ...wire(), project_id: null }, drop: null }, "an old sender's global row");
    assert.deepEqual(await mapInboundContextProject(db, wire({ project_uuid: null })), { row: { ...wire(), project_id: null }, drop: null });
    assert.match((await mapInboundContextProject(db, wire({ project_id: 3, project_uuid: null }))).drop, /raw project_id/,
      "a raw id with a null uuid never lands global");
    assert.match((await mapInboundContextProject(db, wire({ project_uuid: 42 }))).drop, /project uuid/, "a non-string uuid drops");
    assert.deepEqual(await mapInboundContextProject(db, wire({ project_uuid: "" })), { row: { ...wire(), project_id: null }, drop: null }, "an empty uuid is no project");
    const broken = { execute: async () => { throw new Error("db gone"); } };
    assert.match((await mapInboundContextProject(broken, wire({ project_uuid: U }))).drop, /lookup failed/, "a lookup error drops, never lands global");
  } finally {
    await fleet.cleanup();
  }
});

test("uuid maps to the local project; the same-NUMBER unrelated project is untouched", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    await seedSection(b.db, { content: "B-decoy", projectId: 3 });
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "insert", row: wire({ project_uuid: U }), lamport_ts: 50 }));
    assert.deepEqual(await sections(b.db), [[null, 3, "B-decoy"], [null, 7, "from A"]]);
  } finally {
    await fleet.cleanup();
  }
});

test("a raw project_id from an old sender is dropped (warned), never applied as the global or the same-number section", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    await seedSection(b.db, { content: "B-decoy", projectId: 3 });
    await seedSection(b.db, { content: "B-global" });
    const before = await count(b.db);
    // The handler itself (Task 1) warns and drops...
    const seen = await warnings(() => b.mgr._applyCrowContext("update", wire({ project_id: 3, content: "old A" }), 50, a.id));
    assert.ok(seen.some((w) => /raw project_id/.test(w)), `warned: ${JSON.stringify(seen)}`);
    // ...and the full inbound path drops it too (the gate refuses a raw id first).
    for (const op of ["insert", "update", "delete"]) {
      await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op, row: wire({ project_id: 3, content: "old A" }), lamport_ts: 60 }));
    }
    assert.equal(await count(b.db), before);
    assert.deepEqual(await sections(b.db), [[null, null, "B-global"], [null, 3, "B-decoy"]]);
  } finally {
    await fleet.cleanup();
  }
});

test("a raw project_id alongside a uuid is ignored: lands in the uuid's project", async () => {
  const fleet = await bFleet();
  try {
    const { a, b } = fleet;
    await b.mgr._applyCrowContext("insert", wire({ project_id: 3, project_uuid: U }), 50, a.id);
    assert.deepEqual(await sections(b.db), [[null, 7, "from A"]]);
  } finally {
    await fleet.cleanup();
  }
});

test("an unknown uuid drops; once the project exists here, a later update lands", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    const before = await count(b.db);
    const seen = await warnings(() => b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "insert", row: wire({ project_uuid: D }), lamport_ts: 50 })));
    assert.ok(seen.some((w) => /unknown or archived project uuid/.test(w)));
    assert.equal(await count(b.db), before, "dropped: nothing lands, not even unfiled-as-global");
    await addProject(b.db, 9, D);
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "update", row: wire({ project_uuid: D, content: "later" }), lamport_ts: 51 }));
    assert.deepEqual(await sections(b.db), [[null, 9, "later"]]);
  } finally {
    await fleet.cleanup();
  }
});

test("a uuid naming an ARCHIVED project here drops, like an unknown one", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    await b.db.execute("UPDATE project_spaces SET archived_at = datetime('now') WHERE id = 7");
    const before = await count(b.db);
    const seen = await warnings(() => b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "insert", row: wire({ project_uuid: U }), lamport_ts: 50 })));
    assert.ok(seen.some((w) => /archived project uuid/.test(w)), JSON.stringify(seen));
    assert.equal(await count(b.db), before, "nothing filed under the tombstone, nothing global");
  } finally {
    await fleet.cleanup();
  }
});

test("no uuid and no project_id is the global section (unchanged)", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "insert", row: wire(), lamport_ts: 50 }));
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "update", row: wire({ project_id: null, content: "old shape" }), lamport_ts: 51 }));
    assert.deepEqual(await sections(b.db), [[null, null, "old shape"]]);
  } finally {
    await fleet.cleanup();
  }
});

test("device + project maps the same way", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "insert", row: wire({ device_id: "dev1", project_uuid: U }), lamport_ts: 50 }));
    assert.deepEqual(await sections(b.db), [["dev1", 7, "from A"]]);
  } finally {
    await fleet.cleanup();
  }
});

test("delete by uuid removes only the uuid-matched row: never the same-number decoy nor the global section", async () => {
  const fleet = await bFleet();
  try {
    const { a, b, identity } = fleet;
    await seedSection(b.db, { content: "B-decoy", projectId: 3 });
    await seedSection(b.db, { content: "B-mapped", projectId: 7 });
    await seedSection(b.db, { content: "B-global" });
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "delete", row: { section_key: K, device_id: null, project_uuid: U }, lamport_ts: 50 }));
    assert.deepEqual(await sections(b.db), [[null, null, "B-global"], [null, 3, "B-decoy"]]);
    // A delete for a project B lacks deletes nothing.
    await b.mgr._applyEntry(a.id, signedEntry(identity, a.id, { table: "crow_context", op: "delete", row: { section_key: K, device_id: null, project_uuid: D }, lamport_ts: 51 }));
    assert.deepEqual(await sections(b.db), [[null, null, "B-global"], [null, 3, "B-decoy"]]);
  } finally {
    await fleet.cleanup();
  }
});

// ---------------------------------------------------------------- Task 2: the emitter

test("crowContextProjectUuid: the local project's uuid, or null", async () => {
  const fleet = await bFleet();
  try {
    assert.equal(await crowContextProjectUuid(fleet.a.db, 3), U);
    assert.equal(await crowContextProjectUuid(fleet.a.db, 99), null);
    assert.equal(await crowContextProjectUuid(fleet.a.db, null), null);
    assert.equal(await crowContextProjectUuid(fleet.a.db, undefined), null);
  } finally {
    await fleet.cleanup();
  }
});

test("wire row has no project_id; project_uuid rides; the stamp hits the LOCAL row", async () => {
  const fleet = await bFleet();
  try {
    await withGate("1", async () => {
      const { a, identity } = fleet;
      const probe = new InstanceSyncManager(identity, a.db, "ctx-probe");
      probe.feedsDisabled = false;
      const captured = [];
      probe.outFeeds.set("probe-peer", { append: async (e) => captured.push(e) });
      await seedSection(a.db, { content: "A-proj", projectId: 3, lamport: 0 });
      await seedSection(a.db, { content: "A-global", lamport: 0 });
      const local = async (pid) => (await a.db.execute({ sql: "SELECT * FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS ?", args: [K, pid] })).rows[0];

      const projRow = buildCrowContextWireRow(await local(3), U);
      assert.equal(projRow.project_id, 3, "the caller's row keeps the local id (for the stamp)");
      assert.equal(projRow.project_uuid, U);
      await probe.emitChange("crow_context", "update", projRow);
      await probe.emitChange("crow_context", "update", buildCrowContextWireRow(await local(null)));
      const [p, g] = captured.filter((e) => e.table === "crow_context");
      assert.ok(p && g, "both reached the probe feed");
      assert.equal(p.row.project_id, undefined, "project_id is local: never on the wire");
      assert.equal(p.row.project_uuid, U);
      assert.ok(!("project_id" in g.row) && !("project_uuid" in g.row), "a global row carries neither key");
      assert.equal(projRow.project_id, 3, "the caller's row is not mutated");
      assert.equal(Number((await local(3)).lamport_ts), p.lamport_ts, "the project row was stamped");
      assert.equal(Number((await local(null)).lamport_ts), g.lamport_ts, "the global row was stamped");
      try { await probe.close(); } catch {}
    });
  } finally {
    await fleet.cleanup();
  }
});

test("over a real link (gate on): A's project section lands in B's project for the same uuid, edits follow, the delete hits only it", async () => {
  const fleet = await bFleet();
  let link;
  try {
    await withGate("1", async () => {
      const { a, b } = fleet;
      await seedSection(b.db, { content: "B-decoy", projectId: 3 });
      link = await linkPeers(a, b);
      await seedSection(a.db, { content: "A-proj", projectId: 3, lamport: 0 });
      const row = (await a.db.execute({ sql: "SELECT * FROM crow_context WHERE section_key = ? AND project_id = 3", args: [K] })).rows[0];
      await a.mgr.emitChange("crow_context", "insert", buildCrowContextWireRow(row, U));
      assert.ok(await until(async () => (await sections(b.db)).some(([, p]) => p === 7)), "B received it");
      assert.deepEqual(await sections(b.db), [[null, 3, "B-decoy"], [null, 7, "A-proj"]]);
      await a.db.execute({ sql: "UPDATE crow_context SET content = 'A-edit' WHERE section_key = ? AND project_id = 3", args: [K] });
      const edited = (await a.db.execute({ sql: "SELECT * FROM crow_context WHERE section_key = ? AND project_id = 3", args: [K] })).rows[0];
      await a.mgr.emitChange("crow_context", "update", buildCrowContextWireRow(edited, U));
      assert.ok(await until(async () => (await sections(b.db)).some(([, p, c]) => p === 7 && c === "A-edit")), "the edit followed");
      await a.mgr.emitChange("crow_context", "delete", { section_key: K, device_id: null, project_id: 3, project_uuid: U });
      assert.ok(await until(async () => !(await sections(b.db)).some(([, p]) => p === 7)), "the delete followed");
      assert.deepEqual(await sections(b.db), [[null, 3, "B-decoy"]]);
      assert.deepEqual(await sections(a.db), [[null, 3, "A-edit"]], "A keeps its own row filed locally");
    });
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

// ---------------------------------------------------------------- Task 3: the gate

test("contextProjectSyncEnabled: on only for exactly \"1\"", () => {
  assert.equal(contextProjectSyncEnabled({}), false);
  assert.equal(contextProjectSyncEnabled({ CROW_CONTEXT_PROJECT_SYNC: "1" }), true);
  for (const v of ["0", "true", "yes", " 1", ""]) assert.equal(contextProjectSyncEnabled({ CROW_CONTEXT_PROJECT_SYNC: v }), false, v);
});

test("shouldSyncRow crow_context: project rows need the gate AND a uuid; global rows always sync", async () => {
  const proj = { section_key: K, device_id: null, project_id: 3 };
  await withGate(undefined, () => {
    assert.equal(shouldSyncRow("crow_context", { ...proj, project_uuid: U }), false, "gate off: project row not syncable");
    assert.equal(shouldSyncRow("crow_context", { section_key: K, device_id: null, project_id: null }), true, "global row");
    assert.equal(shouldSyncRow("crow_context", { section_key: K, device_id: "dev1" }), true, "device row");
    assert.equal(shouldSyncRow("crow_context", { section_key: K, project_uuid: U }), true, "a new sender's wire row (no project_id) is not gated inbound");
  });
  await withGate("1", () => {
    assert.equal(shouldSyncRow("crow_context", proj), false, "gate on without uuid: not syncable");
    assert.equal(shouldSyncRow("crow_context", { ...proj, project_uuid: null }), false);
    assert.equal(shouldSyncRow("crow_context", { ...proj, project_uuid: "" }), false);
    assert.equal(shouldSyncRow("crow_context", { ...proj, project_uuid: U }), true, "gate on with uuid: syncable");
    assert.equal(shouldSyncRow("crow_context", { section_key: K, project_id: null }), true, "global row");
  });
});

test("gate off: a project section is never broadcast; the global one still is", async () => {
  const fleet = await bFleet();
  try {
    await withGate(undefined, async () => {
      const { a, identity } = fleet;
      const probe = new InstanceSyncManager(identity, a.db, "ctx-probe-off");
      probe.feedsDisabled = false;
      const captured = [];
      probe.outFeeds.set("probe-peer", { append: async (e) => captured.push(e) });
      assert.equal(await probe.emitChange("crow_context", "insert", { ...wire({ project_id: 3, project_uuid: U }) }), null);
      assert.equal(await probe.emitChange("crow_context", "delete", { section_key: K, device_id: null, project_id: 3, project_uuid: U }), null);
      await probe.emitChange("crow_context", "insert", wire({ project_id: null }));
      assert.deepEqual(captured.filter((e) => e.table === "crow_context").map((e) => e.row.project_uuid ?? null), [null], "only the global row went out");
      try { await probe.close(); } catch {}
    });
  } finally {
    await fleet.cleanup();
  }
});
