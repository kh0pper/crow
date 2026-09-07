/**
 * Ramble privacy grid — the 3x3 audience x channel matrix, the master "I'm
 * visible" switch on top of it, and the public identity level. Every cell is
 * off by default; nothing broadcasts until BOTH the master switch and the
 * specific (audience, channel) cell are explicitly turned on (spec §2).
 *
 * Storage: flat key/value rows in `ramble_settings` (no dedicated table) —
 * `master` = "1"/"0", `grid.<audience>.<channel>` = "1"/"0",
 * `public_identity_level` ∈ IDENTITY_LEVELS, `local.active_area` (read-only
 * here — Task 10 owns writing it) is a JSON array of geohash cells. Grid and
 * master and identity-level keys are NOT `local.`-prefixed, so they replicate
 * across the user's own instances via instance sync (Task 8) — they are user
 * state, not per-boot machinery.
 *
 * Phase 1 only ever gates the `geo` channel and only ever publishes `public`
 * rows (D1), but the grid itself stores all nine cells so the UI and later
 * phases (`ble`/`lan`, `contacts`/`groups` delivery) have somewhere to live.
 */

export const AUDIENCES = ["public", "contacts", "groups"];
export const CHANNELS = ["ble", "lan", "geo"];
export const IDENTITY_LEVELS = ["rotating", "pseudonym", "real"];

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble grid] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

/** Tolerates a missing `ramble_settings` table (fresh db, no gateway boot yet) by returning null. */
async function readSetting(db, key) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function writeSetting(db, key, value, { emit } = {}) {
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
  await safeEmit(emit, "ramble_settings", "update", { key, value });
}

/**
 * Current grid state, with every value defaulted so a fresh install (or a db
 * whose `ramble_settings` table doesn't exist yet) reads as fully-off/rotating
 * rather than throwing.
 */
export async function getGrid(db) {
  const cells = {};
  for (const audience of AUDIENCES) {
    const row = {};
    for (const channel of CHANNELS) {
      // eslint-disable-next-line no-await-in-loop
      row[channel] = (await readSetting(db, `grid.${audience}.${channel}`)) === "1";
    }
    cells[audience] = row;
  }

  const master = (await readSetting(db, "master")) === "1";
  const identityLevel = (await readSetting(db, "public_identity_level")) ?? "rotating";

  let activeArea = [];
  const rawArea = await readSetting(db, "local.active_area");
  if (rawArea) {
    try {
      const parsed = JSON.parse(rawArea);
      if (Array.isArray(parsed)) activeArea = parsed.filter((c) => typeof c === "string" && c.length > 0);
    } catch {
      // malformed JSON in local.active_area -- treat as empty rather than throw
    }
  }

  return { master, cells, identityLevel, activeArea };
}

export async function setCell(db, audience, channel, on, { emit } = {}) {
  if (!AUDIENCES.includes(audience)) throw new Error(`unknown audience: ${audience}`);
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel}`);
  await writeSetting(db, `grid.${audience}.${channel}`, on ? "1" : "0", { emit });
}

/**
 * The master "I'm visible" switch. Turning it off stops ALL broadcasting
 * immediately and drops any live LOCAL caw (a caw means "I am here right
 * now" — it cannot survive going invisible), mirroring the delete-emit
 * pattern in `marks.js`'s `expireMarks`. Ordinary local marks and anything of
 * remote origin are left untouched.
 */
export async function setMaster(db, on, { emit } = {}) {
  await writeSetting(db, "master", on ? "1" : "0", { emit });

  if (on === false) {
    const { rows } = await db.execute({
      sql: "SELECT * FROM ramble_marks WHERE kind = 'caw' AND origin = 'local'",
      args: [],
    });
    if (rows.length === 0) return;

    await db.execute({
      sql: "DELETE FROM ramble_marks WHERE kind = 'caw' AND origin = 'local'",
      args: [],
    });
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await safeEmit(emit, "ramble_marks", "delete", row);
    }
  }
}

export async function setIdentityLevel(db, level, { emit } = {}) {
  if (!IDENTITY_LEVELS.includes(level)) throw new Error(`unknown identity level: ${level}`);
  await writeSetting(db, "public_identity_level", level, { emit });
}

/** True only when the master switch AND the specific (audience, channel) cell are both on. */
export function emitAllowed(grid, audience, channel) {
  return grid.master === true && grid.cells[audience]?.[channel] === true;
}

/** Maps a mark's `visibility` column to the grid row that governs it. */
export function audienceOf(visibility) {
  if (visibility === "public") return "public";
  if (visibility === "contacts") return "contacts";
  if (typeof visibility === "string" && visibility.startsWith("group:")) return "groups";
  throw new Error(`unknown visibility: ${visibility}`);
}

/**
 * The gateway drain's default publish gate (phase 1 is geo-only, D1): a row
 * is publishable exactly when the grid allows its audience on the geo
 * channel, re-read fresh on every call so a mid-flight grid change takes
 * effect on the very next drain tick without a restart.
 */
export function makePublishGate(db) {
  return async (row) => emitAllowed(await getGrid(db), audienceOf(row.visibility), "geo");
}
