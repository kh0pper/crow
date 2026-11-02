/**
 * Studio session hub — the authority for every open song in one gateway
 * process.
 *
 * The hub is the only writer of a song's document. It owns:
 *
 *   - the live `Y.Doc` of each song, built from the stored snapshot plus the
 *     update log and cached for the life of the process;
 *   - one serial promise queue per song, so an edit, an undo, a redo and a
 *     focus change land in arrival order and a lock or a focus that arrived a
 *     moment ago is seen by the command that follows it;
 *   - the ACL check on every write, the people-only commands, and the
 *     locked-track and focused-object refusals an agent runs into;
 *   - persistence: one Yjs update and one history entry per step, periodic
 *     snapshots, and the compaction of the updates a snapshot covers;
 *   - the broadcast every connected client of the song receives.
 *
 * It imports nothing from the gateway's own tree. The project ACL arrives
 * through `acl` — production injects `servers/shared/project-acl.js`, tests
 * inject a fake — which keeps this module runnable against a scratch database,
 * and keeps the one rule that matters explicit: the hub never decides access
 * by itself.
 *
 * Results are plain objects for the write paths — a command, an undo, a redo
 * and a song creation never throw for something a caller can act on:
 *
 *   {ok: true, entry, snapshot_version}            a command applied
 *   {ok: true, entry, conflicts, snapshot_version} an undo or a redo applied
 *   {ok: false, code, error, conflicts?}           a refusal
 *
 * `code` is one of "acl", "human_only", "locked", "focused", "limit",
 * "invalid", "conflict" or "not_found".
 *
 * The two reads (`openSong`, `history`) throw instead, because there is no
 * half-answer to hand back: a StudioError with code "not_found", or the ACL
 * error unchanged.
 */

import * as Y from "yjs";
import { newSongDoc, parseObjectRef, snapshot, splitRefField } from "./doc.js";
import { StudioError, applyCommand, prepareCommand } from "./commands/registry.js";
// The registry is populated by importing the commands for their side effect,
// so a hub started on its own always has every 1a command available.
import "./commands/core.js";
import {
  REDO_COMMAND,
  UNDO_COMMAND,
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
} from "./history.js";
import {
  appendHistory,
  appendUpdate,
  createSongRow,
  getSongRow,
  listHistory,
  listSongs as listSongRows,
  loadUpdates,
  markUndone,
  writeSnapshot,
} from "./store.js";
import { initStudioTables } from "./init-tables.js";

/** The error name a project ACL refusal carries; the hub maps it to "acl". */
const ACL_ERROR_NAME = "AclError";

/** Ten minutes of de-duplication, per song, when the caller names no window. */
const DEFAULT_DEDUPE_MS = 600000;

/** A snapshot every 200 applied updates, when the caller names no interval. */
const DEFAULT_SNAPSHOT_EVERY = 200;

/** The history action recorded for every applied step. */
const AUDIT_ACTION = "studio.command";

/** The history action recorded when a song row is created. */
const AUDIT_CREATE_ACTION = "studio.song.create";

/** @returns {object} a refusal a caller can relay. */
function refuse(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** @returns {object|null} the parsed JSON value, or null when the column is empty. */
function parseJson(text) {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Normalise a caller's author to the three fields the history stores.
 *
 * A call without an author is treated as an agent: the strictest reading, so a
 * caller that forgets to say who it is never gets the operator's privileges.
 * @param {{kind?: string, id?: string, label?: string}|null} author
 * @returns {{kind: string, id: string|null, label: string|null}}
 */
function normalizeAuthor(author) {
  if (!author || typeof author !== "object" || typeof author.kind !== "string") {
    return { kind: "agent", id: author?.id ?? "unknown", label: author?.label ?? "Unknown agent" };
  }
  return { kind: author.kind, id: author.id ?? null, label: author.label ?? null };
}

/**
 * The track a lock check has to look at for one touched ref.
 *
 * A clip belongs to the track it sits on; a track is itself; a scene or the
 * song's meta belong to no track. Nothing here walks to a clip's track from a
 * *focused* ref — focus matches the ref exactly.
 * @param {object} snap - a plain snapshot
 * @param {string} ref
 * @returns {string|null}
 */
function trackIdForRef(snap, ref) {
  const target = parseObjectRef(ref);
  if (!target) return null;
  if (target.kind === "track") return target.id;
  if (target.kind === "clip") return snap.clips?.[target.id]?.track_id ?? null;
  return null;
}

/**
 * The name to print for a ref in a refusal message.
 * @param {object} snap - a plain snapshot
 * @param {string} ref
 * @returns {string}
 */
function labelForRef(snap, ref) {
  const target = parseObjectRef(ref);
  if (!target) return ref;
  if (target.kind === "clip") return snap.clips?.[target.id]?.name ?? target.id;
  if (target.kind === "track") {
    return snap.tracks?.find((track) => track.id === target.id)?.name ?? target.id;
  }
  if (target.kind === "scene") {
    return snap.scenes?.find((scene) => scene.id === target.id)?.name ?? target.id;
  }
  return "the song";
}

/**
 * Map one row of `studio_history` to the entry `planUndo` and `planRedo` read.
 *
 * The store lists history by page but has no single-entry read, and the hub
 * needs one to undo an arbitrary step. Only the columns those planners use are
 * carried over.
 * @param {object} row
 * @returns {object}
 */
function entryFromRow(row) {
  const inverse = parseJson(row.inverse_json);
  return {
    id: String(row.id),
    song_id: String(row.song_id),
    seq: Number(row.seq),
    command: row.command,
    summary: row.summary ?? "",
    inverse: inverse ?? { before: {}, after: {} },
    undone_by: row.undone_by ?? null,
  };
}

/**
 * Create the session hub for one gateway process.
 *
 * @param {object} options
 * @param {object} options.db - @libsql/client-compatible client
 * @param {{assertProjectExists: Function, assertCapability: Function,
 *          appendAudit: Function}} options.acl - the project ACL module
 * @param {() => Date} [options.now] - clock, injectable so de-duplication windows are testable
 * @param {(song_id: string, payload: object) => any} [options.onBroadcast]
 *   called with `{update, entry}` after every applied step and `{presence}`
 *   after every presence change; whatever it returns is awaited
 * @param {number} [options.snapshotEvery] - write a snapshot every N updates
 * @param {number} [options.dedupeMs] - how long a `cmd_id` stays remembered
 * @returns {object} the hub: openSong, createSong, runCommand, undo, redo,
 *   setFocus, clientGone, presence, listSongs, history
 */
export function createHub({
  db,
  acl,
  now = () => new Date(),
  onBroadcast = () => {},
  snapshotEvery = DEFAULT_SNAPSHOT_EVERY,
  dedupeMs = DEFAULT_DEDUPE_MS,
} = {}) {
  if (!db || typeof db.execute !== "function") {
    throw new TypeError("Studio hub: a database client is required");
  }
  if (!acl || typeof acl !== "object") {
    throw new TypeError("Studio hub: an acl module is required");
  }
  for (const name of ["assertProjectExists", "assertCapability", "appendAudit"]) {
    if (typeof acl[name] !== "function") {
      throw new TypeError(`Studio hub: acl.${name} is required`);
    }
  }

  /** The bundle's tables, created once before the first use of the hub. */
  let tablesReady = null;

  /** @type {Map<string, {doc: Y.Doc, seq: number, project_id: number}>} */
  const songs = new Map();

  /** @type {Map<string, Promise<object>>} documents being loaded right now. */
  const loading = new Map();

  /** @type {Map<string, Promise<void>>} the tail of each song's serial queue. */
  const queues = new Map();

  /** @type {Map<string, Map<string, {result: object, at: number}>>} recent cmd_ids. */
  const dedupe = new Map();

  /** @type {Map<string, Map<string, {author: object, ref: string|null}>>} who has what open. */
  const focus = new Map();

  /** @returns {string} the injected clock as an ISO 8601 string. */
  function nowIso() {
    return now().toISOString();
  }

  /** @returns {Promise<void>} when the song, update and history tables exist. */
  function ensureTables() {
    if (!tablesReady) {
      tablesReady = initStudioTables(db).catch((err) => {
        tablesReady = null;
        throw err;
      });
    }
    return tablesReady;
  }

  /**
   * Run one operation behind every earlier operation for the same song.
   *
   * The tail advances on failure as well as success (`then(op, op)`), so one
   * refused or broken step never blocks the next. The caller always receives
   * its own operation's promise, rejection included.
   * @param {string} song_id
   * @param {() => Promise<any>} op
   * @returns {Promise<any>}
   */
  function enqueue(song_id, op) {
    const previous = queues.get(song_id) ?? Promise.resolve();
    const current = previous.then(op, op);
    queues.set(song_id, current.then(() => {}, () => {}));
    return current;
  }

  /**
   * Broadcast one payload to every client of a song.
   *
   * A broadcast that fails must never undo a step that is already persisted, so
   * the failure is swallowed here.
   * @param {string} song_id
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async function broadcast(song_id, payload) {
    try {
      await onBroadcast(song_id, payload);
    } catch {
      // Nothing to do: the edit is stored and every later client reloads it.
    }
  }

  /**
   * Record one step on the project's timeline. Audit failures never break an
   * edit, matching the ACL helper's own contract.
   * @param {number} project_id
   * @param {object} author
   * @param {string} action
   * @param {string} song_id
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async function audit(project_id, author, action, song_id, payload) {
    try {
      await acl.appendAudit(db, {
        project_id,
        actor_type: author.kind === "human" ? "local" : "bot",
        actor_id: author.id,
        action,
        target: "song:" + song_id,
        payload,
      });
    } catch {
      // See the comment above.
    }
  }

  /** @returns {object} the song row, or a "not_found" refusal. */
  async function readRow(song_id) {
    const row = await getSongRow(db, song_id);
    if (!row) {
      throw new StudioError("not_found", `There is no song "${song_id}".`);
    }
    return row;
  }

  /**
   * Build a song's document from its snapshot and its newer updates.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<{doc: Y.Doc, seq: number, project_id: number}>}
   */
  async function buildDoc(song_id, row) {
    const doc = new Y.Doc();
    if (row.snapshot) Y.applyUpdate(doc, row.snapshot);
    for (const update of await loadUpdates(db, song_id)) Y.applyUpdate(doc, update);

    const { rows } = await db.execute({
      sql: "SELECT COALESCE(MAX(seq), 0) AS seq FROM studio_updates WHERE song_id = ?",
      args: [song_id],
    });
    const seq = Math.max(Number(rows[0]?.seq ?? 0), Number(row.snapshot_seq ?? 0));
    return { doc, seq, project_id: Number(row.project_id) };
  }

  /**
   * The cached document of a song, loaded at most once even when two requests
   * race for it.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<{doc: Y.Doc, seq: number, project_id: number}>}
   */
  async function ensureDoc(song_id, row) {
    const cached = songs.get(song_id);
    if (cached) return cached;

    let pending = loading.get(song_id);
    if (!pending) {
      pending = buildDoc(song_id, row).then(
        (state) => {
          songs.set(song_id, state);
          loading.delete(song_id);
          return state;
        },
        (err) => {
          loading.delete(song_id);
          throw err;
        },
      );
      loading.set(song_id, pending);
    }
    return pending;
  }

  /**
   * Write a full-state snapshot once a song's update count reaches the
   * interval, then drop the updates it covers.
   *
   * The snapshot is written first: a process that stops between the two writes
   * leaves updates `loadUpdates` already ignores.
   * @param {string} song_id
   * @param {{doc: Y.Doc}} state
   * @param {number} seq
   * @returns {Promise<void>}
   */
  async function compactIfDue(song_id, state, seq) {
    if (!Number.isFinite(snapshotEvery) || snapshotEvery <= 0) return;
    if (seq % snapshotEvery !== 0) return;

    await writeSnapshot(db, song_id, Y.encodeStateAsUpdate(state.doc), seq);
    await deleteUpdatesUpTo(db, song_id, seq);
  }

  /**
   * Drop the update rows a snapshot has made redundant. It lives here rather
   * than in the store because the store is append-only by contract and the hub
   * is the one writer that knows a snapshot now covers them.
   *
   * Everything older than the snapshot's own `seq` goes; the row at `seq`
   * stays, because the store derives the next sequence number from the highest
   * row still in the table. Emptying the table would restart the log at 1
   * while the snapshot site still says `seq`, and the update written next would
   * then be skipped on load. `loadUpdates` already ignores everything at or
   * below `snapshot_seq`, so the one row left behind is invisible to every
   * reader and costs one blob per interval.
   * @param {object} client
   * @param {string} song_id
   * @param {number} seq - the seq the snapshot covers
   * @returns {Promise<void>}
   */
  async function deleteUpdatesUpTo(client, song_id, seq) {
    await client.execute({
      sql: "DELETE FROM studio_updates WHERE song_id = ? AND seq < ?",
      args: [song_id, seq],
    });
  }

  /**
   * The original result of a `cmd_id` seen recently, or null.
   *
   * De-duplication is per song: a client that resends a command after a
   * reconnect gets its first answer back and the step is not applied twice.
   * Entries past the window are dropped on every call.
   * @param {string} song_id
   * @param {string|null} cmd_id
   * @returns {object|null}
   */
  function recall(song_id, cmd_id) {
    const perSong = dedupe.get(song_id);
    if (!perSong) return null;

    const cutoff = now().getTime() - dedupeMs;
    for (const [key, record] of perSong) {
      if (record.at <= cutoff) perSong.delete(key);
    }
    if (perSong.size === 0) dedupe.delete(song_id);

    if (cmd_id == null || cmd_id === "") return null;
    return perSong.get(String(cmd_id))?.result ?? null;
  }

  /**
   * Remember a successful result against its `cmd_id`.
   * @param {string} song_id
   * @param {string|null} cmd_id
   * @param {object} result
   * @returns {void}
   */
  function remember(song_id, cmd_id, result) {
    if (cmd_id == null || cmd_id === "") return;
    let perSong = dedupe.get(song_id);
    if (!perSong) {
      perSong = new Map();
      dedupe.set(song_id, perSong);
    }
    perSong.set(String(cmd_id), { result, at: now().getTime() });
  }

  /** @returns {Map<string, {author: object, ref: string|null}>} a song's focus table. */
  function focusTable(song_id) {
    let clients = focus.get(song_id);
    if (!clients) {
      clients = new Map();
      focus.set(song_id, clients);
    }
    return clients;
  }

  /**
   * The refs a human client currently has open. Only people hold focus: an
   * agent's own focus (if it ever sets one) never blocks another agent.
   * @param {string} song_id
   * @returns {Set<string>}
   */
  function humanFocusRefs(song_id) {
    const refs = new Set();
    for (const { author, ref } of focus.get(song_id)?.values() ?? []) {
      if (!ref || author?.kind !== "human") continue;
      refs.add(ref);
    }
    return refs;
  }

  /**
   * Apply the agent rules to the refs one step will change: people-only
   * commands, locked tracks, and objects a human has open.
   * @param {string[]} refs
   * @param {object} snap - the plain snapshot taken before the step
   * @param {string} song_id
   * @param {object} author
   * @param {{humanOnly?: boolean, commandId?: string}} [rules]
   * @returns {object|null} a refusal, or null when the step may run
   */
  function checkAgentRules(refs, snap, song_id, author, { humanOnly = false, commandId = "" } = {}) {
    if (author.kind === "human") return null;

    if (humanOnly) {
      return refuse("human_only", `Only a person can run "${commandId}".`);
    }

    for (const ref of refs) {
      const trackId = trackIdForRef(snap, ref);
      if (!trackId) continue;
      const track = snap.tracks?.find((item) => item.id === trackId);
      if (track?.locked === true) {
        return refuse("locked", `Track "${track.name}" is locked by the operator.`);
      }
    }

    const focused = humanFocusRefs(song_id);
    if (focused.size === 0) return null;
    for (const ref of refs) {
      if (!focused.has(ref)) continue;
      return refuse("focused", `The operator has "${labelForRef(snap, ref)}" open right now.`);
    }
    return null;
  }

  /** @returns {string[]} the refs a before/after plan touches. */
  function planRefs(plan) {
    const refs = new Set();
    for (const key of plan.apply.keys()) {
      const split = splitRefField(key);
      if (split) refs.add(split.ref);
    }
    return [...refs];
  }

  /**
   * Load one history entry by id.
   * @param {string} song_id
   * @param {string} entry_id
   * @returns {Promise<object|null>}
   */
  async function readEntry(song_id, entry_id) {
    if (typeof entry_id !== "string" || entry_id === "") return null;
    const { rows } = await db.execute({
      sql: "SELECT * FROM studio_history WHERE id = ? AND song_id = ? LIMIT 1",
      args: [entry_id, song_id],
    });
    return rows.length ? entryFromRow(rows[0]) : null;
  }

  /**
   * Open one song: the live document plus its plain snapshot.
   *
   * A read, so an archived project still opens — its songs stay readable and
   * renderable. Throws a StudioError (code "not_found") for an unknown song
   * and lets an ACL refusal through unchanged.
   * @param {string} song_id
   * @returns {Promise<{doc: Y.Doc, snapshot: object, snapshot_version: number}>}
   */
  async function openSong(song_id) {
    await ensureTables();
    const row = await readRow(song_id);
    await acl.assertProjectExists(db, row.project_id, { allowArchived: true });
    const state = await ensureDoc(song_id, row);
    return {
      doc: state.doc,
      snapshot: snapshot(state.doc),
      snapshot_version: state.seq,
    };
  }

  /**
   * Create a song in a project.
   *
   * Needs `write_files`; an archived project is refused by the ACL module. The
   * new song's empty document is stored as its update seq 1, so opening it
   * later reproduces exactly what its author saw.
   * @param {{project_id: number, title: string, author: object}} request
   * @returns {Promise<{ok: true, song_id: string, snapshot_version: number}|{ok: false, code: string, error: string}>}
   */
  async function createSong(request) {
    await ensureTables();
    const { project_id, title, author } = request ?? {};
    const actor = normalizeAuthor(author);

    const projectId = Number(project_id);
    let songTitle;
    try {
      if (!Number.isInteger(projectId)) {
        throw new StudioError("invalid", "A new song needs the project it belongs to.");
      }
      if (typeof title !== "string" || title.trim() === "") {
        throw new StudioError("invalid", "A new song needs a title.");
      }
      songTitle = title.trim();
      await acl.assertCapability(db, projectId, null, "write_files");
    } catch (err) {
      return toRefusal(err);
    }

    let created;
    try {
      created = await createSongRow(db, { project_id: projectId, title: songTitle });
    } catch (err) {
      if (err instanceof StudioError || err?.name === ACL_ERROR_NAME) return toRefusal(err);
      if (/500 songs/.test(String(err?.message ?? ""))) return refuse("limit", err.message);
      throw err;
    }

    const song_id = created.id;
    const doc = newSongDoc({ title: songTitle });
    const update = Y.encodeStateAsUpdate(doc);
    const seq = await appendUpdate(db, song_id, update);
    songs.set(song_id, { doc, seq, project_id: projectId });

    await audit(projectId, actor, AUDIT_CREATE_ACTION, song_id, { title: songTitle });
    await broadcast(song_id, { update, entry: null });

    return { ok: true, song_id, snapshot_version: seq };
  }

  /**
   * Apply one registry command to a song.
   *
   * Everything happens on the song's serial queue: the de-duplication check,
   * the ACL check, the lock and focus check against the document as it is
   * right now, the edit itself, and the persistence of its update and history
   * entry. A refusal writes nothing and broadcasts nothing.
   * @param {{song_id: string, cmd_id?: string, command: string, args?: object, author: object}} request
   * @returns {Promise<object>} see the module header for the shape
   */
  function runCommand(request) {
    const { song_id, cmd_id = null, command, args, author } = request ?? {};
    if (typeof song_id !== "string" || song_id === "") {
      return Promise.resolve(refuse("invalid", "A command needs the song it applies to."));
    }
    return enqueue(song_id, () => runCommandNow({ song_id, cmd_id, command, args, author }));
  }

  /** The body of `runCommand`, run inside the song's queue. */
  async function runCommandNow({ song_id, cmd_id, command, args, author }) {
    await ensureTables();
    const replayed = recall(song_id, cmd_id);
    if (replayed) return replayed;

    const actor = normalizeAuthor(author);

    let row;
    let state;
    try {
      row = await readRow(song_id);
      await acl.assertCapability(db, row.project_id, null, "write_files");
      state = await ensureDoc(song_id, row);
    } catch (err) {
      return toRefusal(err);
    }

    let prepared;
    try {
      prepared = prepareCommand(state.doc, command, args);
    } catch (err) {
      return toRefusal(err);
    }

    const refused = checkAgentRules(prepared.touched, prepared.snap, song_id, actor, {
      humanOnly: prepared.command.humanOnly,
      commandId: prepared.command.id,
    });
    if (refused) return refused;

    // Capture the diff this one transaction produces: it is exactly the update
    // a client replays and the store keeps. A refusal inside applyCommand
    // leaves the document untouched (every command validates first), so the
    // catch below persists nothing.
    const stateVector = Y.encodeStateVector(state.doc);
    let applied;
    try {
      state.doc.transact(() => {
        applied = applyCommand(state.doc, prepared);
      }, { cmd_id, author: actor });
    } catch (err) {
      return toRefusal(err);
    }
    const update = Y.encodeStateAsUpdate(state.doc, stateVector);

    const seq = await appendUpdate(db, song_id, update);
    state.seq = seq;

    const entry = makeEntry({
      song_id,
      seq,
      command: prepared.command.id,
      args: prepared.args,
      author: actor,
      summary: applied.summary,
      touched: prepared.touched,
      before: applied.before,
      after: applied.after,
      created_at: nowIso(),
    });
    await appendHistory(db, entry);
    await compactIfDue(song_id, state, seq);
    await audit(row.project_id, actor, AUDIT_ACTION, song_id, { command: prepared.command.id });

    const result = { ok: true, entry, snapshot_version: seq };
    remember(song_id, cmd_id, result);
    await broadcast(song_id, { update, entry });
    return result;
  }

  /**
   * Take one history step back.
   * @param {{song_id: string, cmd_id?: string, entry_id: string, author: object}} request
   * @returns {Promise<object>} see the module header for the shape
   */
  function undo(request) {
    return historyStep("undo", request);
  }

  /**
   * Re-apply one undone step.
   * @param {{song_id: string, cmd_id?: string, entry_id: string, author: object}} request
   * @returns {Promise<object>} see the module header for the shape
   */
  function redo(request) {
    return historyStep("redo", request);
  }

  /** @param {"undo"|"redo"} kind */
  function historyStep(kind, request) {
    const { song_id, cmd_id = null, entry_id, author } = request ?? {};
    if (typeof song_id !== "string" || song_id === "") {
      return Promise.resolve(refuse("invalid", `A ${kind} needs the song it applies to.`));
    }
    return enqueue(song_id, () => historyStepNow(kind, { song_id, cmd_id, entry_id, author }));
  }

  /**
   * The body of `undo` and `redo`, run inside the song's queue.
   *
   * A step whose every field has been edited again since cannot go back: the
   * caller gets code "conflict" with the conflicting fields and nothing is
   * written. A partial undo applies what it still can and reports the rest.
   */
  async function historyStepNow(kind, { song_id, cmd_id, entry_id, author }) {
    await ensureTables();
    const replayed = recall(song_id, cmd_id);
    if (replayed) return replayed;

    const actor = normalizeAuthor(author);

    let row;
    let state;
    let target;
    try {
      row = await readRow(song_id);
      await acl.assertCapability(db, row.project_id, null, "write_files");
      state = await ensureDoc(song_id, row);
      target = await readEntry(song_id, entry_id);
    } catch (err) {
      return toRefusal(err);
    }
    if (!target) {
      return refuse("not_found", `There is no history step "${entry_id}" in this song.`);
    }

    let plan;
    try {
      plan = kind === "undo" ? planUndo(state.doc, target) : planRedo(state.doc, target);
    } catch (err) {
      return toRefusal(err);
    }

    if (plan.apply.size === 0) {
      return refuse(
        "conflict",
        kind === "undo"
          ? "Nothing to undo: every change in that step was edited again since."
          : "Nothing to redo: every change in that step was edited again since.",
        { conflicts: plan.conflicts },
      );
    }

    // A history step moves the same fields a command does, so an agent meets
    // the same locks and the same objects the operator has open.
    const refused = actor.kind === "human"
      ? null
      : checkAgentRules(planRefs(plan), snapshot(state.doc), song_id, actor);
    if (refused) return refused;

    const stateVector = Y.encodeStateVector(state.doc);
    try {
      state.doc.transact(() => {
        applyPlan(state.doc, plan);
      }, { cmd_id, author: actor });
    } catch (err) {
      return toRefusal(err);
    }
    const update = Y.encodeStateAsUpdate(state.doc, stateVector);

    const seq = await appendUpdate(db, song_id, update);
    state.seq = seq;

    const entry = makeUndoEntry({
      entry: target,
      plan,
      song_id,
      seq,
      author: actor,
      command: kind === "redo" ? REDO_COMMAND : UNDO_COMMAND,
    });
    await appendHistory(db, entry);
    await markUndone(db, target.id, entry.id);
    target.undone_by = entry.id;

    await compactIfDue(song_id, state, seq);
    await audit(row.project_id, actor, AUDIT_ACTION, song_id, { command: entry.command });

    const result = { ok: true, entry, conflicts: plan.conflicts, snapshot_version: seq };
    remember(song_id, cmd_id, result);
    await broadcast(song_id, { update, entry });
    return result;
  }

  /**
   * Say which object one client has open, or that it has closed it.
   *
   * Queued with the edits, so a command that arrived after a focus always sees
   * it. Only a human client's focus blocks agents, and it blocks the exact ref
   * — not the clip's track, not its other clips.
   * @param {string} song_id
   * @param {string} client_id
   * @param {string|null} ref - e.g. "clip:abc", or null to clear it
   * @param {object} [author] - who the client is; kept from its last focus when omitted
   * @returns {Promise<{ok: true, presence: object[]}>}
   */
  function setFocus(song_id, client_id, ref = null, author = null) {
    return enqueue(song_id, async () => {
      const clients = focusTable(song_id);
      const previous = clients.get(client_id);
      clients.set(client_id, {
        author: normalizeAuthor(author ?? previous?.author),
        ref: typeof ref === "string" && ref !== "" ? ref : null,
      });
      const presence = presenceIn(song_id);
      await broadcast(song_id, { presence });
      return { ok: true, presence };
    });
  }

  /**
   * Drop a client's presence — its socket closed.
   * @param {string} song_id
   * @param {string} client_id
   * @returns {Promise<{ok: true, presence: object[]}>}
   */
  function clientGone(song_id, client_id) {
    return enqueue(song_id, async () => {
      const clients = focus.get(song_id);
      const had = clients?.delete(client_id) ?? false;
      if (clients && clients.size === 0) focus.delete(song_id);
      const presence = presenceIn(song_id);
      if (had) await broadcast(song_id, { presence });
      return { ok: true, presence };
    });
  }

  /** @returns {object[]} who is on a song and what each of them has open. */
  function presenceIn(song_id) {
    const clients = focus.get(song_id);
    if (!clients) return [];
    return [...clients.entries()].map(([client_id, held]) => ({
      client_id,
      author: held.author,
      focus: held.ref,
    }));
  }

  /**
   * The presence list of one song.
   * @param {string} song_id
   * @returns {Array<{client_id: string, author: object|null, focus: string|null}>}
   */
  function presence(song_id) {
    return presenceIn(song_id);
  }

  /**
   * List songs, newest edit first.
   * @param {{project_ids?: number[]}} [filter] - restrict to these projects
   * @returns {Promise<Array<{id: string, project_id: number, title: string, updated_at: string}>>}
   */
  async function listSongs(options) {
    await ensureTables();
    const { project_ids } = options ?? {};
    return listSongRows(db, { project_ids });
  }

  /**
   * A song's shared history, newest first.
   *
   * A read: an archived project still lists what happened in its songs.
   * @param {string} song_id
   * @param {{limit?: number}} [options]
   * @returns {Promise<object[]>}
   */
  async function history(song_id, options) {
    await ensureTables();
    const { limit } = options ?? {};
    const row = await readRow(song_id);
    await acl.assertProjectExists(db, row.project_id, { allowArchived: true });
    return listHistory(db, song_id, { limit });
  }

  /**
   * Turn a refusal the hub knows into its result shape.
   *
   * A StudioError keeps its own code; an ACL refusal becomes "acl". Anything
   * else is a bug in the hub or a command, and is thrown rather than dressed
   * up as a refusal.
   * @param {Error} err
   * @returns {object}
   */
  function toRefusal(err) {
    if (err instanceof StudioError) return refuse(err.code, err.message);
    if (err?.name === ACL_ERROR_NAME) return refuse("acl", err.message);
    throw err;
  }

  return {
    openSong,
    createSong,
    runCommand,
    undo,
    redo,
    setFocus,
    clientGone,
    presence,
    listSongs,
    history,
  };
}