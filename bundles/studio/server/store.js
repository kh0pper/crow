/**
 * Studio store — persistence for songs, Yjs updates, snapshots and the shared
 * history.
 *
 * Every function takes the database client as its first argument: production
 * passes the gateway's own @libsql/client-compatible client (via
 * `appImport("servers/db.js")`), tests pass a scratch client. The client needs
 * `execute({sql, args})`, and `batch(statements, "write")` for the two writes
 * that have to be all-or-nothing: `commitStep` and `createSongWithState`.
 *
 * BLOBs go in as Uint8Array and come out as Uint8Array. libsql hands a file
 * blob back as an ArrayBuffer and other drivers as a Buffer, so every read
 * normalises through `toBytes`.
 *
 * A song's row carries its latest snapshot; everything newer lives as an
 * append-only log of Yjs updates, which replays on top of the snapshot.
 */

import { randomUUID } from "node:crypto";

/** Spec §1: how many songs one project may hold. */
const MAX_SONGS_PER_PROJECT = 500;

/** Newest-first page of history when the caller names no limit. */
const DEFAULT_HISTORY_LIMIT = 50;

/** History pages are capped so one request cannot pull a whole song's past. */
const MAX_HISTORY_LIMIT = 200;

/** @returns {string} the current time as an ISO 8601 string. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalise any driver's blob value to a Uint8Array.
 * @param {unknown} value
 * @returns {Uint8Array|null}
 */
function toBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

/**
 * Prepare a caller's blob for a query argument, accepting a Uint8Array, a
 * Buffer or an ArrayBuffer.
 * @param {unknown} value
 * @returns {Uint8Array}
 */
function bindBytes(value) {
  const bytes = toBytes(value);
  if (!bytes) throw new TypeError("Studio store: a Uint8Array blob is required");
  return bytes;
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

/** Map a `studio_songs` row to a plain song row. */
function songRow(row) {
  return {
    id: String(row.id),
    project_id: Number(row.project_id),
    title: row.title,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    snapshot: toBytes(row.snapshot),
    snapshot_seq: Number(row.snapshot_seq ?? 0),
  };
}

/** Map a `studio_history` row to a plain history entry. */
function historyRow(row) {
  const inverse = parseJson(row.inverse_json);
  return {
    id: String(row.id),
    song_id: String(row.song_id),
    seq: Number(row.seq),
    command: row.command,
    args: parseJson(row.args_json),
    author: {
      kind: row.author_kind ?? null,
      id: row.author_id ?? null,
      label: row.author_label ?? null,
    },
    summary: row.summary ?? null,
    touched: parseJson(row.touched_json) ?? [],
    inverse,
    // The same inverse in the shape a command's apply/undo plan uses.
    before: inverse?.before ?? null,
    after: inverse?.after ?? null,
    undo_of: row.undo_of ?? null,
    undone_by: row.undone_by ?? null,
    created_at: row.created_at ?? null,
  };
}

/**
 * Create a song row for a project.
 *
 * Refuses the 501st song in a project before writing anything.
 * @param {object} db
 * @param {{project_id: number, title: string}} song
 * @returns {Promise<{id: string}>}
 */
export async function createSongRow(db, { project_id, title }) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM studio_songs WHERE project_id = ?",
    args: [project_id],
  });
  if (Number(rows[0]?.n ?? 0) >= MAX_SONGS_PER_PROJECT) {
    throw new Error("This project already has 500 songs, the most Studio allows.");
  }
  const id = randomUUID();
  const now = nowIso();
  await db.execute({
    sql: `INSERT INTO studio_songs (id, project_id, title, created_at, updated_at, snapshot, snapshot_seq)
          VALUES (?, ?, ?, ?, ?, NULL, 0)`,
    args: [id, project_id, title, now, now],
  });
  return { id };
}

/**
 * Create a song row and write its first update, in one transaction.
 *
 * The 500-song cap is checked before anything is written, exactly as
 * `createSongRow` checks it. The row and the document the song starts from
 * then go in as one `db.batch(..., "write")`: a failed save leaves no song row
 * behind, because a row whose first update is missing is a song nobody can
 * open and nothing can tidy away.
 * @param {object} db
 * @param {{project_id: number, title: string, update: Uint8Array}} song
 * @returns {Promise<{id: string, seq: number}>} the new song's id and the
 *   sequence number its first update was written with
 * @throws when the cap is reached or the batch fails — nothing is written then
 */
export async function createSongWithState(db, { project_id, title, update }) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM studio_songs WHERE project_id = ?",
    args: [project_id],
  });
  if (Number(rows[0]?.n ?? 0) >= MAX_SONGS_PER_PROJECT) {
    throw new Error("This project already has 500 songs, the most Studio allows.");
  }

  const id = randomUUID();
  const now = nowIso();
  // A brand-new song has no updates, so its first one is always seq 1.
  const seq = 1;
  await db.batch(
    [
      {
        sql: `INSERT INTO studio_songs (id, project_id, title, created_at, updated_at, snapshot, snapshot_seq)
              VALUES (?, ?, ?, ?, ?, NULL, 0)`,
        args: [id, project_id, title, now, now],
      },
      {
        sql: "INSERT INTO studio_updates (song_id, seq, data, created_at) VALUES (?, ?, ?, ?)",
        args: [id, seq, bindBytes(update), now],
      },
    ],
    "write",
  );
  return { id, seq };
}

/**
 * List song rows, newest edit first.
 * @param {object} db
 * @param {{project_ids?: number[]}} [filter] - restrict to these projects; omit for every song, pass [] for none
 * @returns {Promise<Array<{id: string, project_id: number, title: string, updated_at: string}>>}
 */
export async function listSongs(db, { project_ids } = {}) {
  if (Array.isArray(project_ids) && project_ids.length === 0) return [];
  const columns = "id, project_id, title, updated_at";
  let rows;
  if (Array.isArray(project_ids)) {
    const placeholders = project_ids.map(() => "?").join(", ");
    ({ rows } = await db.execute({
      sql: `SELECT ${columns} FROM studio_songs
             WHERE project_id IN (${placeholders})
             ORDER BY updated_at DESC, id ASC`,
      args: project_ids,
    }));
  } else {
    ({ rows } = await db.execute({
      sql: `SELECT ${columns} FROM studio_songs ORDER BY updated_at DESC, id ASC`,
    }));
  }
  return rows.map((row) => ({
    id: String(row.id),
    project_id: Number(row.project_id),
    title: row.title,
    updated_at: row.updated_at ?? null,
  }));
}

/**
 * Read one song row, including its snapshot.
 * @param {object} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getSongRow(db, id) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM studio_songs WHERE id = ?",
    args: [id],
  });
  return rows.length ? songRow(rows[0]) : null;
}

/**
 * Append one Yjs update to a song's log and return its sequence number.
 *
 * The sequence is computed inside the INSERT ... SELECT itself, so two
 * concurrent appends on the same connection each get their own seq instead of
 * both reading the same max. Also bumps the song's `updated_at`, since an
 * update is an edit.
 * @param {object} db
 * @param {string} song_id
 * @param {Uint8Array} update - a Yjs update blob
 * @returns {Promise<number>} the sequence number assigned to this update
 */
export async function appendUpdate(db, song_id, update) {
  const now = nowIso();
  const { rows } = await db.execute({
    sql: `INSERT INTO studio_updates (song_id, seq, data, created_at)
          SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?
            FROM studio_updates
           WHERE song_id = ?
          RETURNING seq`,
    args: [song_id, bindBytes(update), now, song_id],
  });
  const seq = Number(rows[0]?.seq);
  if (!Number.isFinite(seq)) throw new Error("Studio store: appendUpdate got no sequence number back");
  await db.execute({
    sql: "UPDATE studio_songs SET updated_at = ? WHERE id = ?",
    args: [now, song_id],
  });
  return seq;
}

/**
 * Load a song's updates newer than its latest snapshot, in seq order.
 * @param {object} db
 * @param {string} song_id
 * @returns {Promise<Uint8Array[]>}
 */
export async function loadUpdates(db, song_id) {
  const { rows } = await db.execute({
    sql: `SELECT data FROM studio_updates
           WHERE song_id = ?
             AND seq > COALESCE((SELECT snapshot_seq FROM studio_songs WHERE id = ?), 0)
           ORDER BY seq ASC`,
    args: [song_id, song_id],
  });
  return rows.map((r) => toBytes(r.data)).filter(Boolean);
}

/**
 * Store a full-state snapshot and the seq it covers.
 * @param {object} db
 * @param {string} song_id
 * @param {Uint8Array} state - the encoded Yjs document state
 * @param {number} upto_seq - every update up to and including this seq is covered
 * @returns {Promise<void>}
 */
export async function writeSnapshot(db, song_id, state, upto_seq) {
  const result = await db.execute({
    sql: `UPDATE studio_songs
             SET snapshot = ?, snapshot_seq = ?, updated_at = ?
           WHERE id = ?`,
    args: [bindBytes(state), upto_seq, nowIso(), song_id],
  });
  if (result.rowsAffected === 0) throw new Error(`Studio store: no song ${song_id} to snapshot`);
}

/**
 * Append one entry to a song's shared history.
 *
 * Accepts either the raw `*_json` columns or the structured values
 * (`args`, `touched`, `inverse`); the structured form wins when both are
 * absent. `inverse` falls back to `{before, after}` when those are passed.
 * @param {object} db
 * @param {{id?: string, song_id: string, seq: number, command: string, args?: object,
 *          args_json?: string, author?: {kind?: string, id?: string, label?: string},
 *          author_kind?: string, author_id?: string, author_label?: string,
 *          summary?: string, touched?: string[], touched_json?: string,
 *          inverse?: object, inverse_json?: string, undo_of?: string|null,
 *          undone_by?: string|null, created_at?: string}} entry
 * @returns {Promise<string>} the entry id
 */
export async function appendHistory(db, entry) {
  const { id, statement } = historyInsert(entry);
  await db.execute(statement);
  return id;
}

/**
 * Build the statement that inserts one history row, so the row can be written
 * on its own (`appendHistory`) or inside a step's batch (`commitStep`).
 * @param {object} entry - the shape `appendHistory` documents
 * @param {number} [seq] - the sequence number to write, when it is already
 *   known; `entry.seq` otherwise
 * @returns {{id: string, statement: {sql: string, args: any[]}}}
 */
function historyInsert(entry, seq) {
  const id = entry.id ?? randomUUID();
  const argsJson = entry.args_json !== undefined
    ? entry.args_json
    : JSON.stringify(entry.args ?? null);
  const touchedJson = entry.touched_json !== undefined
    ? entry.touched_json
    : JSON.stringify(entry.touched ?? []);
  const inverse = entry.inverse
    ?? (entry.before !== undefined || entry.after !== undefined
      ? { before: entry.before ?? {}, after: entry.after ?? {} }
      : null);
  const inverseJson = entry.inverse_json !== undefined
    ? entry.inverse_json
    : JSON.stringify(inverse);

  return {
    id,
    statement: {
      sql: `INSERT INTO studio_history
              (id, song_id, seq, command, args_json, author_kind, author_id, author_label,
               summary, touched_json, inverse_json, undo_of, undone_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        entry.song_id,
        seq ?? entry.seq,
        entry.command,
        argsJson,
        entry.author?.kind ?? entry.author_kind ?? null,
        entry.author?.id ?? entry.author_id ?? null,
        entry.author?.label ?? entry.author_label ?? null,
        entry.summary ?? null,
        touchedJson,
        inverseJson,
        entry.undo_of ?? null,
        entry.undone_by ?? null,
        entry.created_at ?? nowIso(),
      ],
    },
  };
}

/**
 * Save one step of a song: its Yjs update, its history entry and — for an undo
 * or a redo — the mark on the entry it takes back, all in one transaction.
 *
 * The sequence number is the next one this song's log has. It is read first
 * because the history row carries it, and the writes then go in as a single
 * `db.batch(..., "write")`, which libsql runs as one transaction: either every
 * row lands or none does. That matters more here than anywhere else in the
 * store, because a half-saved step cannot be repaired afterwards — an update
 * with no history entry is a change nobody can undo, and a history entry with
 * no update describes a song that never happened.
 *
 * `entry.seq` may be a placeholder: the sequence returned here is the real
 * one, and it is what the history row is written with.
 * @param {object} db
 * @param {{song_id: string, update: Uint8Array, entry?: object|null,
 *          undone?: {entry_id: string, by_entry_id: string|null}|null}} step
 *   `entry` takes the shape `appendHistory` documents and may be left out (a
 *   song's first update has no step to record); `undone` names the entry this
 *   step took back
 * @returns {Promise<number>} the sequence number the update was written with
 * @throws when the batch fails — nothing is written in that case
 */
export async function commitStep(db, { song_id, update, entry = null, undone = null } = {}) {
  if (typeof song_id !== "string" || song_id === "") {
    throw new TypeError("Studio store: commitStep needs a song_id");
  }

  const { rows } = await db.execute({
    sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM studio_updates WHERE song_id = ?",
    args: [song_id],
  });
  const seq = Number(rows[0]?.seq);
  if (!Number.isFinite(seq) || seq < 1) {
    throw new Error("Studio store: commitStep got no sequence number back");
  }

  const now = nowIso();
  const statements = [
    {
      sql: "INSERT INTO studio_updates (song_id, seq, data, created_at) VALUES (?, ?, ?, ?)",
      args: [song_id, seq, bindBytes(update), now],
    },
    {
      sql: "UPDATE studio_songs SET updated_at = ? WHERE id = ?",
      args: [now, song_id],
    },
  ];
  if (entry) {
    // The step's own song wins: one entry can never be filed under another
    // song's history by accident.
    statements.push(historyInsert({ ...entry, song_id }, seq).statement);
  }
  if (undone && typeof undone.entry_id === "string" && undone.entry_id !== "") {
    statements.push(markUndoneStatement(undone.entry_id, undone.by_entry_id));
  }

  await db.batch(statements, "write");
  return seq;
}

/**
 * The statement that marks a history entry as undone by another one.
 * @param {string} entry_id - the entry that was undone
 * @param {string|null} by_entry_id - the undo entry (null clears the mark)
 * @returns {{sql: string, args: any[]}}
 */
function markUndoneStatement(entry_id, by_entry_id) {
  return {
    sql: "UPDATE studio_history SET undone_by = ? WHERE id = ?",
    args: [by_entry_id ?? null, entry_id],
  };
}

/**
 * List a song's history, newest first.
 * @param {object} db
 * @param {string} song_id
 * @param {{limit?: number, before_seq?: number}} [opts]
 *   limit: default 50, capped at 200; before_seq: only entries older than this seq
 * @returns {Promise<Array<object>>}
 */
export async function listHistory(db, song_id, { limit, before_seq } = {}) {
  const wanted = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_HISTORY_LIMIT;
  const pageSize = Math.min(wanted, MAX_HISTORY_LIMIT);
  const args = [song_id];
  let where = "song_id = ?";
  if (before_seq !== undefined && before_seq !== null && Number.isFinite(Number(before_seq))) {
    where += " AND seq < ?";
    args.push(Number(before_seq));
  }
  args.push(pageSize);
  const { rows } = await db.execute({
    sql: `SELECT * FROM studio_history
           WHERE ${where}
           ORDER BY seq DESC, rowid DESC
           LIMIT ?`,
    args,
  });
  return rows.map(historyRow);
}

/**
 * Mark a history entry as undone by another entry.
 * @param {object} db
 * @param {string} entry_id - the entry that was undone
 * @param {string|null} by_entry_id - the undo entry (null clears the mark)
 * @returns {Promise<void>}
 */
export async function markUndone(db, entry_id, by_entry_id) {
  await db.execute(markUndoneStatement(entry_id, by_entry_id));
}