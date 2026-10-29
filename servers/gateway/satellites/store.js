/**
 * Satellite store: the crow-side tables (servers/shared/satellite-schema.js), local-only.
 * Functions take a db client (`createDbClient` shape, db.execute({sql,args})).
 * Readers treat a missing table as empty (the instance has not migrated yet); writers throw an
 * Error with code "not_migrated" (routes map it to 503 not_migrated).
 */

export function isNotMigrated(err) {
  return !!err && /no such table/i.test(String(err.message || err));
}

function notMigrated(err) {
  const e = new Error("satellite tables are not migrated yet");
  e.code = "not_migrated";
  e.cause = err;
  return e;
}

async function read(db, sql, args, empty) {
  try {
    return await db.execute({ sql, args });
  } catch (err) {
    if (isNotMigrated(err)) return empty;
    throw err;
  }
}

async function write(db, sql, args) {
  try {
    return await db.execute({ sql, args });
  } catch (err) {
    if (isNotMigrated(err)) throw notMigrated(err);
    throw err;
  }
}

const EMPTY = { rows: [] };
const plain = (r) => (r ? { ...r } : null);

export async function listSatellites(db) {
  const r = await read(db, "SELECT * FROM satellites ORDER BY created_at, id", [], EMPTY);
  return r.rows.map(plain);
}

export async function getSatellite(db, id) {
  const r = await read(db, "SELECT * FROM satellites WHERE id = ?", [id], EMPTY);
  return plain(r.rows[0]);
}

const INSERT_COLS = ["id", "name", "tailnet_host", "satellite_pubkey", "mgmt_pubkey", "cert_json",
  "cert_serial", "cert_expires_at", "primary_url", "agent_protocol", "status", "last_status_json",
  "last_seen_at", "unreachable_since", "created_at", "revoked_at"];

export async function insertSatellite(db, row) {
  const cols = INSERT_COLS.filter((c) => row[c] !== undefined);
  await write(
    db,
    `INSERT INTO satellites (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    cols.map((c) => row[c]),
  );
}

const PATCH_COLS = ["name", "tailnet_host", "cert_json", "cert_serial", "cert_expires_at", "primary_url",
  "agent_protocol", "status", "last_status_json", "last_seen_at", "unreachable_since"];

export async function updateSatelliteStatus(db, id, patch) {
  const keys = Object.keys(patch || {});
  const bad = keys.filter((k) => !PATCH_COLS.includes(k));
  if (bad.length) throw new Error(`updateSatelliteStatus: unknown column(s): ${bad.join(", ")}`);
  if (!keys.length) return;
  await write(db, `UPDATE satellites SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((k) => patch[k]), id]);
}

/** True when the satellite tables exist; false on a not-yet-migrated instance. */
export async function satellitesMigrated(db) {
  try {
    await db.execute({ sql: "SELECT 1 FROM satellites LIMIT 0", args: [] });
    return true;
  } catch (err) {
    if (isNotMigrated(err)) return false;
    throw err;
  }
}

const REPLACE_COLS = ["name", "tailnet_host", "satellite_pubkey", "mgmt_pubkey", "cert_json", "cert_serial",
  "cert_expires_at", "primary_url", "agent_protocol", "last_seen_at"];

/**
 * Re-pair (spec §4.3): replace a REVOKED row in place with a fresh pairing (new cert and mgmt
 * key), status active, revoked_at NULL, unreachable_since and last_status_json cleared.
 * One UPDATE guarded by status = 'revoked', so it is atomic and never touches an active or
 * unreachable row. Revocation records are kept. Returns true when a row was replaced.
 */
export async function replaceRevokedSatellite(db, row) {
  const missing = REPLACE_COLS.filter((c) => c !== "last_seen_at" && c !== "agent_protocol" && (row[c] === undefined || row[c] === null));
  if (missing.length) throw new Error(`replaceRevokedSatellite: missing column(s): ${missing.join(", ")}`);
  const r = await write(
    db,
    `UPDATE satellites SET ${REPLACE_COLS.map((c) => `${c} = ?`).join(", ")},
       status = 'active', revoked_at = NULL, unreachable_since = NULL, last_status_json = NULL
     WHERE id = ? AND status = 'revoked'`,
    [...REPLACE_COLS.map((c) => row[c] ?? null), row.id],
  );
  return Number(r?.rowsAffected || 0) === 1;
}

export async function markRevoked(db, id, at) {
  await write(db, "UPDATE satellites SET status = 'revoked', revoked_at = ? WHERE id = ?", [at, id]);
}

export async function recordRevocation(db, rec) {
  await write(
    db,
    `INSERT OR IGNORE INTO satellite_revocations (serial, satellite_id, revoked_at, reason, payload_json, sig)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [rec.serial, rec.satellite_id, rec.revoked_at, rec.reason ?? null, rec.payload_json, rec.sig],
  );
}

export async function getToolPin(db, satelliteId, bundle) {
  const r = await read(db, "SELECT * FROM satellite_tool_pins WHERE satellite_id = ? AND bundle = ?",
    [satelliteId, bundle], EMPTY);
  return plain(r.rows[0]);
}

export async function putToolPin(db, pin) {
  await write(
    db,
    `INSERT INTO satellite_tool_pins (satellite_id, bundle, version, tools_sha256, tools_json, read_marks_json, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(satellite_id, bundle) DO UPDATE SET version = excluded.version,
       tools_sha256 = excluded.tools_sha256, tools_json = excluded.tools_json,
       read_marks_json = excluded.read_marks_json, approved_at = excluded.approved_at`,
    [pin.satellite_id, pin.bundle, pin.version ?? null, pin.tools_sha256, pin.tools_json,
      pin.read_marks_json ?? "[]", pin.approved_at],
  );
}

export async function deleteToolPins(db, satelliteId, bundle) {
  if (bundle === undefined || bundle === null) {
    await write(db, "DELETE FROM satellite_tool_pins WHERE satellite_id = ?", [satelliteId]);
  } else {
    await write(db, "DELETE FROM satellite_tool_pins WHERE satellite_id = ? AND bundle = ?", [satelliteId, bundle]);
  }
}

export async function getBotOptin(db, botId) {
  const r = await read(db, "SELECT any_turn FROM satellite_bot_optins WHERE bot_id = ?", [botId], EMPTY);
  return r.rows[0] ? Number(r.rows[0].any_turn) === 1 : false;
}

export async function setBotOptin(db, botId, anyTurn) {
  await write(
    db,
    `INSERT INTO satellite_bot_optins (bot_id, any_turn, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(bot_id) DO UPDATE SET any_turn = excluded.any_turn, updated_at = excluded.updated_at`,
    [botId, anyTurn ? 1 : 0],
  );
}
