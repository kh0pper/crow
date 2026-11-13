/**
 * Studio's second-amp gate: the first amp on a chain is an ordinary agent edit,
 * every amp after it is the operator's to accept, and no agent step — a command,
 * an undo or a redo — may leave a chain holding two amps that are not proposals.
 *
 * Every test runs against its own scratch crow.db in a temp directory with a
 * fake project ACL, so nothing here can touch a real instance.
 *
 * The writes no command makes — a whole insert recorded without its proposal
 * fields, a raw `proposed: false`, an insert's owner moved to another chain —
 * are recorded as history entries directly. That is the same door a step back
 * along the history comes through, and the gate judges those writes exactly as
 * it judges a command's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { appendHistory } from "../bundles/studio/server/store.js";

/** The project every song in these tests belongs to. */
const PROJECT = 21;

/** A GUI command's author, per the plan's attribution rule. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** An MCP command's author, per the plan's attribution rule. */
const AGENT = { kind: "agent", id: "mcp", label: "Agent (MCP)" };

/** What the agent's amp gate answers with, word for word. */
const AMP_SECOND_NEEDS_A_YES =
  "A second amp on a track is the operator's to accept; an agent can only propose one.";

/** What a proposal whose capture or cabinet an agent moves answers with. */
const AMP_PROPOSAL_FIXED =
  "A proposed amp's capture and cabinet are fixed once proposed; remove it and propose another.";

/** What a live amp whose capture or cabinet an agent moves answers with. */
const AMP_CAPTURE_NEEDS_A_YES = "Only the operator changes the capture or cabinet an amp plays.";

/** A capture's sha256, as the gateway's upload finish measures it. */
const CAPTURE_HASH = "c0ffee11".repeat(8);

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-amp-gate-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/** A project ACL that admits one project, driven by nothing in these tests. */
function fakeAcl() {
  async function assertProjectExists(db, projectId, { allowArchived = false } = {}) {
    if (Number(projectId) !== PROJECT) throw new AclError(`Project #${projectId} not found`, "not_found");
    return { id: PROJECT };
  }
  async function assertCapability(db, projectId) {
    await assertProjectExists(db, projectId);
    return { role: "owner", capabilities: { write_files: true } };
  }
  async function appendAudit() {}
  return { assertProjectExists, assertCapability, appendAudit };
}

/** A scratch database, a hub on it, and the broadcasts it made. */
async function setup(t) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const broadcasts = [];
  const hub = createHub({
    db,
    acl: fakeAcl(),
    onBroadcast: (song_id, payload) => {
      broadcasts.push({ song_id, ...payload });
    },
  });
  return { db, hub, broadcasts };
}

/** Run one command and assert it applied. */
async function applies(hub, song_id, cmd_id, command, args, author = HUMAN) {
  const result = await hub.runCommand({ song_id, cmd_id, command, args, author });
  assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  return result;
}

/** Assert a result is a refusal with this code, and return it. */
function refuses(result, code) {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code, `expected code "${code}", got "${result.code}": ${result.error}`);
  return result;
}

/**
 * The library entry `library.add` accepts for a capture or a cabinet, as the
 * gateway's upload finish route builds it.
 * @param {string} id
 * @param {"nam"|"ir"} kind
 * @returns {object}
 */
function makeLibraryFile(id, kind) {
  return {
    id,
    kind,
    name: `${kind === "nam" ? "Capture" : "Cabinet"} ${id}`,
    source: "upload",
    upload_id: `upload-${id}`,
    storage_key: `projects/21/studio/song/library/${id}.${kind === "nam" ? "nam" : "wav"}`,
    sha256: CAPTURE_HASH,
    bytes: 2048,
    licence: "",
    credit: "",
    author_label: "the operator",
  };
}

/** Add one library file the way Studio itself does, as the upload route issues it. */
async function addLibraryFile(hub, song_id, entry) {
  const added = await hub.runCommand({
    song_id,
    cmd_id: `add-library-${entry.id}`,
    command: "library.add",
    args: { entry },
    author: HUMAN,
    internal: true,
  });
  assert.equal(added.ok, true, `library.add was refused: ${added.error}`);
  return added;
}

/** A song with two captures, a cabinet and two audio tracks to play them on. */
async function seedAmpSong(hub) {
  const created = await hub.createSong({ project_id: PROJECT, title: "Amps", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  const song_id = created.song_id;
  for (const entry of [
    makeLibraryFile("cap-a", "nam"),
    makeLibraryFile("cap-b", "nam"),
    makeLibraryFile("cab-a", "ir"),
  ]) {
    await addLibraryFile(hub, song_id, entry);
  }
  await applies(hub, song_id, "seed-guitar", "track.add", { id: "guitar", name: "Guitar", kind: "audio" });
  await applies(hub, song_id, "seed-bass", "track.add", { id: "bass", name: "Bass", kind: "audio" });
  return song_id;
}

/** @returns {Promise<object>} the song as a plain snapshot. */
async function snapshotOf(hub, song_id) {
  return (await hub.openSong(song_id)).snapshot;
}

/** One amp insert as the document holds it, ready for a whole-object write. */
function ampObject(id, owner, capture, { order = 0, proposed = false, set_by = "operator" } = {}) {
  return {
    id,
    owner,
    order,
    kind: "amp",
    bypass: false,
    proposed,
    set_by,
    params: { model_id: capture, ir_id: null, input_db: 0, output_db: 0, ir_mix: 1 },
  };
}

/** The last sequence number a forged history step was written with. */
let forgedSeq = 900;

/**
 * Record one history step directly, so a test can hand the hub a write no
 * command makes: the raw fields a step back along the history writes.
 * @param {object} db
 * @param {string} song_id
 * @param {object} spec - `command`, `args`, and the entry's `inverse.before` /
 *   `inverse.after` maps
 * @returns {Promise<string>} the recorded entry's id
 */
async function forgeEntry(db, song_id, { command, args = null, before, after }) {
  forgedSeq += 1;
  return appendHistory(db, {
    song_id,
    seq: forgedSeq,
    command,
    args,
    author: HUMAN,
    summary: "A recorded step",
    touched: [],
    inverse: { before, after },
    created_at: "2026-11-02T12:00:00.000Z",
  });
}

test("through the hub, an agent's first amp is live and its second is a proposal", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);

  // The first amp on a chain with none is an agent's own edit, live at once.
  const first = await applies(
    hub,
    song_id,
    "agent-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    AGENT,
  );
  assert.equal(first.entry.command, "insert.add");
  assert.equal(first.entry.summary, "Added an amp to Guitar");

  // The second is a proposal: stored, counted, and not live.
  const second = await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );
  assert.equal(second.entry.summary, "Proposed a second amp on Guitar");
  const inserts = (await snapshotOf(hub, song_id)).inserts;
  assert.equal(inserts["amp-1"].proposed, false);
  assert.equal(inserts["amp-1"].set_by, "agent");
  assert.equal(inserts["amp-2"].proposed, true);
  assert.equal(inserts["amp-2"].set_by, "agent");

  // The operator's yes, and only the operator's: an agent's accept is refused
  // before it reaches the command at all, because the command is people-only.
  const refusedAccept = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-accept",
      command: "insert.accept",
      args: { id: "amp-2", expect: { owner: "track:guitar", model_id: "cap-b", ir_id: null } },
      author: AGENT,
    }),
    "human_only",
  );
  assert.match(refusedAccept.error, /Only a person can run "insert\.accept"/);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].proposed, true);

  const accepted = await applies(
    hub,
    song_id,
    "operator-accept",
    "insert.accept",
    { id: "amp-2", expect: { owner: "track:guitar", model_id: "cap-b", ir_id: null } },
    HUMAN,
  );
  assert.equal(accepted.entry.summary, "Accepted the second amp on Guitar");
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].proposed, false);
});

test("bypassing the first amp does not unlock a live second one", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );

  // A bypassed amp is still an amp on the chain the operator chose.
  await applies(hub, song_id, "agent-bypass", "insert.bypass", { id: "amp-1", bypass: true }, AGENT);
  const second = await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );
  assert.equal(second.entry.summary, "Proposed a second amp on Guitar");
  const inserts = (await snapshotOf(hub, song_id)).inserts;
  assert.equal(inserts["amp-1"].bypass, true);
  assert.equal(inserts["amp-2"].proposed, true);

  // And the agent may still retune and remove its own proposal: a proposal
  // plays nothing, so it carries nothing to lose.
  await applies(hub, song_id, "agent-retune", "insert.set", { id: "amp-2", params: { input_db: 6 } }, AGENT);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].params.input_db, 6);
  await applies(hub, song_id, "agent-decline", "insert.remove", { id: "amp-2" }, AGENT);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"], undefined);
});

test("an agent cannot repoint a proposal at another capture or cabinet", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    AGENT,
  );

  // A proposal is the choice the operator is being asked about, so another
  // capture or another cabinet is another question, and not the agent's to put.
  for (const params of [{ model_id: "cap-b" }, { ir_id: "cab-a" }]) {
    const repointed = refuses(
      await hub.runCommand({
        song_id,
        cmd_id: `agent-repoint-${Object.keys(params)[0]}`,
        command: "insert.set",
        args: { id: "amp-2", params },
        author: AGENT,
      }),
      "human_only",
    );
    assert.equal(repointed.error, AMP_PROPOSAL_FIXED);
  }
  const held = (await snapshotOf(hub, song_id)).inserts["amp-2"];
  assert.equal(held.params.model_id, "cap-a", "still the capture it was proposed with");
  assert.equal(held.params.ir_id, null);
  assert.equal(held.proposed, true);

  // Its own settings are still its own, and so is taking it back.
  await applies(hub, song_id, "agent-retune", "insert.set", { id: "amp-2", params: { input_db: 6 } }, AGENT);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].params.input_db, 6);
  await applies(hub, song_id, "agent-decline", "insert.remove", { id: "amp-2" }, AGENT);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"], undefined);
});

test("the operator's yes is bound to the proposal they were shown", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );

  // A proposal can be taken back and proposed again under the same id, so a yes
  // that no longer names the chain, capture and cabinet the row showed is a yes
  // to something the operator never saw.
  const stale = [
    { owner: "track:bass", model_id: "cap-b", ir_id: null },
    { owner: "track:guitar", model_id: "cap-a", ir_id: null },
    { owner: "track:guitar", model_id: "cap-b", ir_id: "cab-a" },
  ];
  for (const [at, expect] of stale.entries()) {
    const refused = refuses(
      await hub.runCommand({
        song_id,
        cmd_id: `operator-accept-stale-${at}`,
        command: "insert.accept",
        args: { id: "amp-2", expect },
        author: HUMAN,
      }),
      "conflict",
    );
    assert.match(refused.error, /is not the proposal you were shown any more/);
    assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].proposed, true, "it stays a proposal");
  }

  // The proposal as it stands is what the operator says yes to.
  await applies(
    hub,
    song_id,
    "operator-accept",
    "insert.accept",
    { id: "amp-2", expect: { owner: "track:guitar", model_id: "cap-b", ir_id: null } },
    HUMAN,
  );
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].proposed, false);
});

test("the operator may leave a chain holding two live amps", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "operator-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    HUMAN,
  );
  const inserts = (await snapshotOf(hub, song_id)).inserts;
  assert.equal(inserts["amp-1"].proposed, false);
  assert.equal(inserts["amp-2"].proposed, false, "the operator's second amp is live");
  assert.equal(inserts["amp-2"].set_by, "operator");
});

test("an agent cannot turn a proposal live through a history step", async (t) => {
  const { db, hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );

  // The raw write an accept makes, recorded under an ordinary command's name:
  // the gate reads the fields, so the command the step names does not matter.
  const forged = await forgeEntry(db, song_id, {
    command: "insert.set",
    args: { id: "amp-2", params: { input_db: 1 } },
    before: { "insert:amp-2|proposed": false },
    after: { "insert:amp-2|proposed": true },
  });
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-accept", entry_id: forged, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_SECOND_NEEDS_A_YES);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].proposed, true);

  // The operator may take that step; it is their yes to give.
  const allowed = await hub.undo({ song_id, cmd_id: "operator-undo-accept", entry_id: forged, author: HUMAN });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].proposed, false);
});

test("an agent cannot add a live second amp with a whole insert", async (t) => {
  const { db, hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );

  // An `insert.add` with its proposal fields stripped: the chain already holds
  // an amp, so this would be the second live one.
  const live = ampObject("amp-9", "track:guitar", "cap-b", { order: 9, set_by: "agent" });
  const forged = await forgeEntry(db, song_id, {
    command: "insert.add",
    args: { owner: "track:guitar", kind: "amp" },
    before: { "insert:amp-9|*": live },
    after: { "insert:amp-9|*": null },
  });
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-live-add", entry_id: forged, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_SECOND_NEEDS_A_YES);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-9"], undefined);

  // The operator's own step puts it there: a chain may hold two live amps when
  // that is what they asked for.
  const allowed = await hub.undo({ song_id, cmd_id: "operator-undo-live-add", entry_id: forged, author: HUMAN });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  const inserts = (await snapshotOf(hub, song_id)).inserts;
  assert.equal(inserts["amp-1"].proposed, false);
  assert.equal(inserts["amp-9"].proposed, false);
});

test("an agent cannot move a live amp into a chain that holds one", async (t) => {
  const { db, hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "operator-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:bass", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );

  // The guitar's amp, moved to the bass chain: two live amps there, none left
  // on the guitar. A move within one chain never writes `owner`, so this is the
  // raw write a history step makes when it re-parents an insert.
  const forged = await forgeEntry(db, song_id, {
    command: "insert.move",
    args: { id: "amp-1", after: null },
    before: { "insert:amp-1|owner": "track:bass" },
    after: { "insert:amp-1|owner": "track:guitar" },
  });
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-move", entry_id: forged, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_SECOND_NEEDS_A_YES);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-1"].owner, "track:guitar");

  const allowed = await hub.undo({ song_id, cmd_id: "operator-undo-move", entry_id: forged, author: HUMAN });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-1"].owner, "track:bass");
});

test("a proposal in a chain does not let a live amp move in beside it", async (t) => {
  const { db, hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );
  await applies(
    hub,
    song_id,
    "operator-bass-amp",
    "insert.add",
    { id: "amp-3", owner: "track:bass", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );

  // The bass's amp moved into the guitar chain: the proposal waiting there holds
  // a place in the chain, not the answer to a second LIVE amp, so this would be
  // the operator's amp plus another one live beside it.
  const forged = await forgeEntry(db, song_id, {
    command: "insert.move",
    args: { id: "amp-3", after: null },
    before: { "insert:amp-3|owner": "track:guitar" },
    after: { "insert:amp-3|owner": "track:bass" },
  });
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-proposed-move", entry_id: forged, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_SECOND_NEEDS_A_YES);
  const live = Object.values((await snapshotOf(hub, song_id)).inserts).filter(
    (insert) => insert.owner === "track:guitar" && insert.proposed !== true,
  );
  assert.deepEqual(live.map((insert) => insert.id), ["amp-1"], "Guitar still holds one live amp");

  // The operator may take that step: the second live amp is theirs to allow.
  const allowed = await hub.undo({ song_id, cmd_id: "operator-undo-proposed-move", entry_id: forged, author: HUMAN });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-3"].owner, "track:guitar");
});

test("an agent cannot swap a proposal's capture with a whole params write", async (t) => {
  const { db, hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );

  // The params map written WHOLE, which is the shape a step back along the
  // history writes: the capture the operator was asked about would move under
  // their yes, so it is refused like the one-field write it stands for.
  const held = (await snapshotOf(hub, song_id)).inserts["amp-2"].params;
  const forged = await forgeEntry(db, song_id, {
    command: "insert.set",
    args: { id: "amp-2" },
    before: { "insert:amp-2|params": { ...held, model_id: "cap-a" } },
    after: { "insert:amp-2|params": held },
  });
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-proposal-params", entry_id: forged, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_PROPOSAL_FIXED);
  const inserts = (await snapshotOf(hub, song_id)).inserts;
  assert.equal(inserts["amp-2"].params.model_id, "cap-b", "still the capture it was proposed with");
  assert.equal(inserts["amp-2"].proposed, true);

  // The operator may take that step: the proposal is theirs to repoint.
  const allowed = await hub.undo({
    song_id,
    cmd_id: "operator-undo-proposal-params",
    entry_id: forged,
    author: HUMAN,
  });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-2"].params.model_id, "cap-a");
});

test("an agent cannot swap a live amp's capture with a whole params write", async (t) => {
  const { db, hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );

  // The same whole-params write on the amp that plays: the capture it names is
  // the operator's choice, so a history step may not move it either.
  const held = (await snapshotOf(hub, song_id)).inserts["amp-1"].params;
  const forged = await forgeEntry(db, song_id, {
    command: "insert.set",
    args: { id: "amp-1" },
    before: { "insert:amp-1|params": { ...held, model_id: "cap-b" } },
    after: { "insert:amp-1|params": held },
  });
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-live-params", entry_id: forged, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_CAPTURE_NEEDS_A_YES);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-1"].params.model_id, "cap-a");

  // The operator may take that step: the capture an amp plays is theirs.
  const allowed = await hub.undo({ song_id, cmd_id: "operator-undo-live-params", entry_id: forged, author: HUMAN });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-1"].params.model_id, "cap-b");
});

test("an agent cannot undo its way to a second live amp", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(
    hub,
    song_id,
    "operator-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    HUMAN,
  );
  // The operator takes one of the two away, so the chain holds one live amp.
  const removed = await applies(hub, song_id, "operator-remove", "insert.remove", { id: "amp-1" }, HUMAN);
  assert.deepEqual(Object.keys((await snapshotOf(hub, song_id)).inserts), ["amp-2"]);

  // Putting the amp back beside the one that replaced it would make a second
  // live amp, which is the operator's yes and not an agent's step.
  const refused = refuses(
    await hub.undo({ song_id, cmd_id: "agent-undo-remove", entry_id: removed.entry.id, author: AGENT }),
    "human_only",
  );
  assert.equal(refused.error, AMP_SECOND_NEEDS_A_YES);
  assert.deepEqual(Object.keys((await snapshotOf(hub, song_id)).inserts), ["amp-2"]);

  // The operator's own undo goes through: the chain goes back to two amps.
  const allowed = await hub.undo({ song_id, cmd_id: "operator-undo-remove", entry_id: removed.entry.id, author: HUMAN });
  assert.equal(allowed.ok, true, `the operator's undo was refused: ${allowed.error}`);
  assert.deepEqual(Object.keys((await snapshotOf(hub, song_id)).inserts).sort(), ["amp-1", "amp-2"]);
});

test("a proposed amp neither blocks a library file's removal nor a render's list", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a", ir_id: "cab-a" } },
    HUMAN,
  );
  // The proposal names a capture of its own, so the two files are told apart.
  await applies(
    hub,
    song_id,
    "agent-amp-2",
    "insert.add",
    { id: "amp-2", owner: "track:guitar", kind: "amp", params: { model_id: "cap-b" } },
    AGENT,
  );

  // The live amp still plays cap-a, so the operator's own removal is refused.
  const inUse = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "remove-cap-a",
      command: "library.remove",
      args: { library_id: "cap-a" },
      author: HUMAN,
    }),
    "conflict",
  );
  assert.match(inUse.error, /cap-a|Guitar/);

  // The proposal plays nothing, so cap-b is nobody's: an agent may tidy it away.
  const tidied = await applies(
    hub,
    song_id,
    "agent-remove-cap-b",
    "library.remove",
    { library_id: "cap-b" },
    AGENT,
  );
  assert.equal(tidied.entry.command, "library.remove");
  assert.equal((await snapshotOf(hub, song_id)).library["cap-b"], undefined);
});

test("no command makes a second live amp beside the operator's amp", async (t) => {
  const { hub } = await setup(t);
  const song_id = await seedAmpSong(hub);
  await applies(
    hub,
    song_id,
    "operator-amp-1",
    "insert.add",
    { id: "amp-1", owner: "track:guitar", kind: "amp", params: { model_id: "cap-a" } },
    HUMAN,
  );
  await applies(hub, song_id, "operator-eq", "insert.add", { id: "eq-1", owner: "track:guitar", kind: "eq" }, HUMAN);

  // An effect cannot be turned into an amp by a parameter write: `insert.set`
  // names parameters, and a `kind` argument is not one of them.
  const kindChange = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-kind",
      command: "insert.set",
      args: { id: "eq-1", params: { mix: 0.5 }, kind: "amp" },
      author: AGENT,
    }),
    "invalid",
  );
  assert.match(kindChange.error, /Unrecognized key|unrecognized/i);

  // A proposed amp on the master is a proposal too, and the master's chain is
  // judged like a track's.
  await applies(hub, song_id, "operator-master-amp", "insert.add", { id: "amp-m", owner: "master", kind: "amp", params: { model_id: "cap-a" } }, HUMAN);
  const proposed = await applies(hub, song_id, "agent-master-amp-2", "insert.add", { id: "amp-m2", owner: "master", kind: "amp", params: { model_id: "cap-b" } }, AGENT);
  assert.equal(proposed.entry.summary, "Proposed a second amp on the master");
  assert.equal((await snapshotOf(hub, song_id)).inserts["amp-m2"].proposed, true);

  // The library reference a proposal holds is still checked: the song does not
  // accept an amp pointing at nothing.
  const nowhere = refuses(
    await hub.runCommand({
      song_id,
      cmd_id: "agent-amp-nowhere",
      command: "insert.add",
      args: { id: "amp-x", owner: "track:bass", kind: "amp", params: { model_id: "nowhere" } },
      author: AGENT,
    }),
    "invalid",
  );
  assert.match(nowhere.error, /no capture with id "nowhere"/);
});