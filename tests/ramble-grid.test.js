/**
 * Task 11 — privacy grid + master "I'm visible" switch + public identity level.
 *
 * Every cell of the 3x3 (audience x channel) grid starts off, and so does the
 * master switch: nothing broadcasts until BOTH the master switch and the
 * specific cell are explicitly turned on. Turning the master off also drops
 * any live local caw immediately (a caw is inherently "I am here right now" —
 * it must not survive going invisible), while ordinary local marks and
 * anything remote are left alone.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, insertRemoteMark } from "../bundles/ramble/server/marks.js";
import {
  AUDIENCES, CHANNELS, IDENTITY_LEVELS,
  getGrid, setCell, setMaster, setIdentityLevel, emitAllowed, audienceOf, makePublishGate,
  sanitizeWorldName, WORLD_NAME_MAX, setWorldName,
} from "../bundles/ramble/server/grid.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
});

beforeEach(async () => {
  // Reset settings-derived state between tests without recreating the db
  // (marks table state is test-local anyway; only a couple of tests touch it).
  await db.execute("DELETE FROM ramble_settings");
});

const ANCHOR = { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 20 };

test("constants: the full 3x3 shape and the three identity levels", () => {
  assert.deepEqual([...AUDIENCES].sort(), ["contacts", "groups", "public"]);
  assert.deepEqual([...CHANNELS].sort(), ["ble", "geo", "lan"]);
  assert.deepEqual([...IDENTITY_LEVELS].sort(), ["pseudonym", "real", "rotating"]);
});

test("default grid: master off, every cell off, rotating identity, empty active area", async () => {
  const grid = await getGrid(db);
  assert.equal(grid.master, false);
  for (const audience of AUDIENCES) {
    for (const channel of CHANNELS) {
      assert.equal(grid.cells[audience][channel], false, `${audience}/${channel} must default off`);
    }
  }
  assert.equal(grid.identityLevel, "rotating");
  assert.deepEqual(grid.activeArea, []);
});

test("getGrid tolerates a missing ramble_settings table by returning defaults", async () => {
  const bareDb = createClient({ url: "file::memory:" }); // no initRambleTables at all
  const grid = await getGrid(bareDb);
  assert.equal(grid.master, false);
  assert.equal(grid.cells.public.geo, false);
  assert.equal(grid.identityLevel, "rotating");
  assert.deepEqual(grid.activeArea, []);
});

test("default grid blocks every (audience, channel) — master off", async () => {
  const grid = await getGrid(db);
  for (const audience of AUDIENCES) {
    for (const channel of CHANNELS) {
      assert.equal(emitAllowed(grid, audience, channel), false);
    }
  }
});

test("master on but every cell still off blocks every (audience, channel)", async () => {
  await setMaster(db, true);
  const grid = await getGrid(db);
  assert.equal(grid.master, true);
  for (const audience of AUDIENCES) {
    for (const channel of CHANNELS) {
      assert.equal(emitAllowed(grid, audience, channel), false);
    }
  }
});

test("enabling (public, geo) + master allows exactly that cell", async () => {
  await setCell(db, "public", "geo", true);
  await setMaster(db, true);
  const grid = await getGrid(db);
  assert.equal(emitAllowed(grid, "public", "geo"), true);
  assert.equal(emitAllowed(grid, "contacts", "geo"), false);
  assert.equal(emitAllowed(grid, "public", "ble"), false);
  assert.equal(emitAllowed(grid, "groups", "geo"), false);
});

test("setMaster(false) blocks everything again and deletes live local caws only", async () => {
  await setCell(db, "public", "geo", true);
  await setMaster(db, true);

  const caw = await createMark(db, {
    author: "pk-self", author_level: "rotating", kind: "caw",
    anchor: ANCHOR, visibility: "public",
    content: { content_text: "here now" },
  });
  const mark = await createMark(db, {
    author: "pk-self", author_level: "rotating", kind: "mark",
    anchor: ANCHOR, visibility: "public",
    content: { content_text: "a durable mark" },
  });
  const remoteCaw = await insertRemoteMark(db, {
    mark_id: "remote-caw-1", author: "pk-other", kind: "caw", anchor_kind: "geo",
    geohash: "9v6m2", lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "open",
    content_text: "someone else, here now", created_at: Date.now(), expires_at: Date.now() + 3600000,
    nostr_event_id: "ev-remote-caw",
  });
  assert.equal(remoteCaw.inserted, true);

  const emitted = [];
  await setMaster(db, false, { emit: async (table, op, row) => { emitted.push({ table, op, row }); } });

  const grid = await getGrid(db);
  assert.equal(grid.master, false);
  for (const audience of AUDIENCES) {
    for (const channel of CHANNELS) {
      assert.equal(emitAllowed(grid, audience, channel), false);
    }
  }

  const remaining = await db.execute("SELECT mark_id, kind, origin FROM ramble_marks ORDER BY mark_id");
  const ids = remaining.rows.map((r) => r.mark_id);
  assert.ok(!ids.includes(caw.mark_id), "the local caw must be deleted when master goes off");
  assert.ok(ids.includes(mark.mark_id), "an ordinary local mark must survive");
  assert.ok(ids.includes("remote-caw-1"), "a remote caw must survive");

  const deletes = emitted.filter((e) => e.table === "ramble_marks" && e.op === "delete");
  assert.equal(deletes.length, 1, "exactly one delete emit for the deleted local caw");
  assert.equal(deletes[0].row.mark_id, caw.mark_id);
});

test("setMaster(false) with no live local caws emits no ramble_marks delete", async () => {
  const emitted = [];
  await setMaster(db, true);
  await setMaster(db, false, { emit: async (table, op, row) => { emitted.push({ table, op, row }); } });
  const deletes = emitted.filter((e) => e.table === "ramble_marks" && e.op === "delete");
  assert.equal(deletes.length, 0);
});

test("setCell rejects an unknown audience or channel", async () => {
  await assert.rejects(() => setCell(db, "friends", "geo", true), /unknown audience/i);
  await assert.rejects(() => setCell(db, "public", "wifi", true), /unknown channel/i);
});

test("setIdentityLevel rejects an unknown level", async () => {
  await assert.rejects(() => setIdentityLevel(db, "anonymous", { emit: async () => {} }), /unknown identity level/i);
});

test("setIdentityLevel accepts each of the three levels and getGrid reflects it", async () => {
  for (const level of IDENTITY_LEVELS) {
    // eslint-disable-next-line no-await-in-loop
    await setIdentityLevel(db, level);
    // eslint-disable-next-line no-await-in-loop
    const grid = await getGrid(db);
    assert.equal(grid.identityLevel, level);
  }
});

test("settings writes (cell, master, identity) each emit a ramble_settings update", async () => {
  const emitted = [];
  const emit = async (table, op, row) => { emitted.push({ table, op, row }); };

  await setCell(db, "public", "geo", true, { emit });
  await setMaster(db, true, { emit });
  await setIdentityLevel(db, "pseudonym", { emit });

  const settingsEmits = emitted.filter((e) => e.table === "ramble_settings" && e.op === "update");
  assert.ok(settingsEmits.some((e) => e.row.key === "grid.public.geo" && e.row.value === "1"));
  assert.ok(settingsEmits.some((e) => e.row.key === "master" && e.row.value === "1"));
  assert.ok(settingsEmits.some((e) => e.row.key === "public_identity_level" && e.row.value === "pseudonym"));
});

test("a settings write with no emit hook does not throw", async () => {
  await setCell(db, "contacts", "ble", true);
  await setMaster(db, true);
  await setIdentityLevel(db, "real");
  const grid = await getGrid(db);
  assert.equal(grid.cells.contacts.ble, true);
  assert.equal(grid.master, true);
  assert.equal(grid.identityLevel, "real");
});

test("a throwing emit hook does not propagate out of a settings write (best-effort)", async () => {
  const emit = async () => { throw new Error("sync layer is down"); };
  await setCell(db, "public", "lan", true, { emit });
  const grid = await getGrid(db);
  assert.equal(grid.cells.public.lan, true, "the write itself must still land");
});

test("audienceOf maps visibility strings to grid rows", () => {
  assert.equal(audienceOf("public"), "public");
  assert.equal(audienceOf("contacts"), "contacts");
  assert.equal(audienceOf("group:abc123"), "groups");
});

test("makePublishGate: false under the default grid, true once enabled", async () => {
  const gate = makePublishGate(db);
  const publicRow = { visibility: "public" };
  assert.equal(await gate(publicRow), false);

  await setCell(db, "public", "geo", true);
  await setMaster(db, true);
  assert.equal(await gate(publicRow), true);

  const contactsRow = { visibility: "contacts" };
  assert.equal(await gate(contactsRow), false, "contacts row is never gated true by the geo cell alone");
});

test("sanitizeWorldName: controls and bidi stripped, whitespace collapsed, crow:/req: rejected, hex-only rejected, capped at 24 code points, empty is null", () => {
  assert.equal(sanitizeWorldName("Kevin"), "Kevin");
  assert.equal(sanitizeWorldName("  Kevin\u202E   H\u0000 "), "Kevin H");
  assert.equal(sanitizeWorldName("crow:kevin"), null);
  assert.equal(sanitizeWorldName("REQ:x"), null);
  assert.equal(sanitizeWorldName("f665c26b"), null, "a key look-alike");
  assert.equal(sanitizeWorldName("DEADBEEF1234"), null);
  assert.equal(sanitizeWorldName("Kev1"), "Kev1", "hex-ish but not all hex");
  assert.equal(sanitizeWorldName("Kev · f665"), "Kev f665", "the label separator cannot be faked");
  assert.equal(sanitizeWorldName("f6\u200B65c26b"), null, "a zero-width space cannot hide a key look-alike");
  assert.equal(sanitizeWorldName("cro\u200Dw:kevin"), null, "a zero-width joiner cannot hide the crow: prefix");
  assert.equal(sanitizeWorldName("Ke\uFEFFvin"), "Kevin", "a BOM is stripped");
  assert.equal(sanitizeWorldName("abc"), "abc", "3 hex chars is a word, not a tail");
  assert.equal(sanitizeWorldName("x".repeat(40)), "x".repeat(24));
  assert.equal(sanitizeWorldName("x".repeat(23) + " yz"), "x".repeat(23), "a cut that lands on a space is re-trimmed");
  assert.equal(sanitizeWorldName("🐦".repeat(30)), "🐦".repeat(24), "code points, not UTF-16 units");
  assert.equal(sanitizeWorldName(""), null);
  assert.equal(sanitizeWorldName("   "), null);
  assert.equal(sanitizeWorldName(123), null);
  assert.equal(sanitizeWorldName(null), null);
  assert.equal(WORLD_NAME_MAX, 24);
});

test("world name: set/read through the grid; unset reads null; the setting replicates (not local.)", async () => {
  assert.equal((await getGrid(db)).worldName, null);
  const calls = [];
  assert.equal(await setWorldName(db, "  Kevin  ", { emit: async (t, op, row) => calls.push([t, op, row.key, row.value]) }), "Kevin");
  assert.equal((await getGrid(db)).worldName, "Kevin");
  assert.deepEqual(calls, [["ramble_settings", "update", "world.name", "Kevin"]]);
  assert.equal(await setWorldName(db, "crow:nope"), null);
  assert.equal((await getGrid(db)).worldName, null, "a rejected name clears the setting");
  assert.equal(await setWorldName(db, "f665c26b"), null);
});
