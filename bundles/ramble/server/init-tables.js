async function initTable(db, label, sql) {
  try { await db.executeMultiple(sql); }
  catch (err) { console.error(`[ramble init] ${label}:`, err.message); throw err; }
}

async function ensureColumn(db, table, column, ddl) {
  const info = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  if (!info.rows.some((r) => r.name === column)) {
    await initTable(db, `${table}.${column}`, `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

const CELL7 = /^[0-9bcdefghjkmnpqrstuvwxyz]{7}$/;

async function backfillCellsOnce(db) {
  try {
    const flag = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = 'cells.backfilled'", args: [],
    });
    if (flag.rows.length) return;

    const cells = new Set();
    const add = (c) => { if (typeof c === "string" && CELL7.test(c)) cells.add(c); };

    const credits = await db.execute({
      sql: "SELECT key FROM ramble_credits WHERE kind = 'visit_place'", args: [],
    });
    for (const r of credits.rows) add(String(r.key || "").split(":")[0]);

    const claims = await db.execute({ sql: "SELECT cell FROM ramble_nest_claims", args: [] });
    for (const r of claims.rows) add(r.cell);

    const mine = await db.execute({
      sql: "SELECT geohash FROM ramble_marks WHERE origin = 'local'", args: [],
    });
    for (const r of mine.rows) add(r.geohash);

    const at = Date.now();
    for (const cell of cells) {
      await db.execute({
        sql: `INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?)
              ON CONFLICT(cell) DO NOTHING`,
        args: [cell, at],
      });
    }
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES ('cells.backfilled', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [String(cells.size)],
    });
  } catch (err) {
    // Never block table creation: a missing legacy table on a fresh install is
    // the normal case, not a failure.
    try { console.warn("[ramble] cell backfill skipped:", err?.message); } catch {}
  }
}

export async function initRambleTables(db) {
  await initTable(db, "ramble_marks", `
    CREATE TABLE IF NOT EXISTS ramble_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mark_id TEXT UNIQUE NOT NULL,
      author TEXT NOT NULL,
      author_level TEXT,
      kind TEXT NOT NULL,
      anchor_kind TEXT NOT NULL,
      geohash TEXT, lat REAL, lon REAL, accuracy_m REAL, anchor_ref TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      reveal TEXT NOT NULL DEFAULT 'open',
      content_text TEXT, content_kind TEXT DEFAULT 'none', content_ref TEXT,
      thumb_enc TEXT, locked_blob TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      nostr_event_id TEXT UNIQUE,
      publish_state TEXT NOT NULL DEFAULT 'pending',
      origin TEXT NOT NULL DEFAULT 'local',
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_marks_geohash ON ramble_marks(geohash);
    CREATE INDEX IF NOT EXISTS ramble_marks_pubstate ON ramble_marks(publish_state);`);

  await initTable(db, "ramble_marks_fts", `
    CREATE VIRTUAL TABLE IF NOT EXISTS ramble_marks_fts USING fts5(
      content_text, mark_id UNINDEXED, content=ramble_marks, content_rowid=id
    );
    CREATE TRIGGER IF NOT EXISTS ramble_marks_ai AFTER INSERT ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(rowid, content_text, mark_id) VALUES (new.id, new.content_text, new.mark_id);
    END;
    CREATE TRIGGER IF NOT EXISTS ramble_marks_ad AFTER DELETE ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(ramble_marks_fts, rowid, content_text, mark_id) VALUES ('delete', old.id, old.content_text, old.mark_id);
    END;
    CREATE TRIGGER IF NOT EXISTS ramble_marks_au AFTER UPDATE ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(ramble_marks_fts, rowid, content_text, mark_id) VALUES ('delete', old.id, old.content_text, old.mark_id);
      INSERT INTO ramble_marks_fts(rowid, content_text, mark_id) VALUES (new.id, new.content_text, new.mark_id);
    END;`);

  await ensureColumn(db, "ramble_marks", "bird_species", "TEXT");
  await ensureColumn(db, "ramble_marks", "bird_seed", "INTEGER");
  await ensureColumn(db, "ramble_marks", "author_name", "TEXT");

  await initTable(db, "ramble_pet", `
    CREATE TABLE IF NOT EXISTS ramble_pet (
      owner TEXT PRIMARY KEY DEFAULT 'self',
      mood TEXT NOT NULL DEFAULT 'happy',
      energy INTEGER NOT NULL DEFAULT 60,
      last_fed_at INTEGER,
      places_week INTEGER NOT NULL DEFAULT 0,
      unlocks_week INTEGER NOT NULL DEFAULT 0,
      crows_week INTEGER NOT NULL DEFAULT 0
    );`);

  // week_start: added via a guarded ALTER TABLE rather than the CREATE above
  // so a host that already created ramble_pet before this column existed
  // still gets it, idempotently, with no SCHEMA_GENERATION bump (ramble_pet
  // replicates via instance sync; new columns must stay in EXCLUDED_COLUMNS-safe
  // shape — see servers/sharing/instance-sync.js).
  await ensureColumn(db, "ramble_pet", "week_start", "INTEGER");
  await ensureColumn(db, "ramble_pet", "active_egg_id", "TEXT");
  await ensureColumn(db, "ramble_pet", "chores_json", "TEXT");
  await ensureColumn(db, "ramble_pet", "lamport_ts", "INTEGER DEFAULT 0");

  await initTable(db, "ramble_settings", `
    CREATE TABLE IF NOT EXISTS ramble_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      lamport_ts INTEGER DEFAULT 0
    );`);

  // Pending NIP-09 deletes for already-published public marks. A TABLE, not a
  // `ramble_settings` JSON list: the gateway drain and the authoring path would
  // otherwise read-modify-write the same JSON blob and lose each other's
  // entries (R14). Deliberately has NO lamport_ts and is absent from
  // instance-sync's SYNCED_TABLES — a tombstone is one instance's outbound
  // work item, not shared state. Rows are deleted once a relay accepts.
  await initTable(db, "ramble_tombstones", `
    CREATE TABLE IF NOT EXISTS ramble_tombstones (
      nostr_event_id TEXT PRIMARY KEY,
      mark_id TEXT,
      kind TEXT NOT NULL,
      author_level TEXT,
      created_at INTEGER NOT NULL
    );`);

  await initTable(db, "ramble_groups", `
    CREATE TABLE IF NOT EXISTS ramble_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT,
      shared_key TEXT NOT NULL,
      members TEXT,
      created_at INTEGER NOT NULL
    );`);

  await initTable(db, "ramble_blocks", `
    CREATE TABLE IF NOT EXISTS ramble_blocks (
      persona TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );`);

  await initTable(db, "ramble_eggs", `
    CREATE TABLE IF NOT EXISTS ramble_eggs (
      egg_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'shelf',
      warmth INTEGER NOT NULL DEFAULT 0,
      species TEXT,
      seed INTEGER,
      found_cell TEXT,
      found_week TEXT,
      from_crow_id TEXT,
      created_at INTEGER NOT NULL,
      hatched_at INTEGER,
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_eggs_status ON ramble_eggs(status);`);

  // Phase 2: WHY an egg is on the shelf. 'sync' = a convergence loser (the
  // sync layer may re-promote it when the incubating slot empties); 'user' =
  // the user put it there (claimed from a nest, or swapped out by incubate)
  // and THE SYNC LAYER must never draft it back in. Phase 3's app-level
  // auto-promote (eggs.js promoteFromShelf, spec §4.2) DOES take 'user' eggs
  // deliberately — that is the release valve; the two are different
  // mechanisms with different triggers. Phase 1 only ever shelved convergence
  // losers, so a NULL shelf row on disk is one of those: backfill it to 'sync'
  // (idempotent, and a 'user' row is never NULL so it is never touched).
  await ensureColumn(db, "ramble_eggs", "shelf_origin", "TEXT");
  await db.execute({
    sql: "UPDATE ramble_eggs SET shelf_origin = 'sync' WHERE status = 'shelf' AND shelf_origin IS NULL",
    args: [],
  });

  await initTable(db, "ramble_credits", `
    CREATE TABLE IF NOT EXISTS ramble_credits (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      credited_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );`);

  // Phase 1 of the reward economy (spec 2026-09-08 §2, §6.2): one row per cell
  // the user has physically stood in. An unlock is an immutable, permanent
  // fact, so this table is append-only — the sync handler keeps the EARLIEST
  // first_unlocked_at and honours no deletes. ⚠ PRIVACY (spec §2.4): this is a
  // precise record of everywhere the user has been. It replicates to their OWN
  // instances and must never appear in any contact-facing payload.
  await initTable(db, "ramble_cells", `
    CREATE TABLE IF NOT EXISTS ramble_cells (
      cell TEXT PRIMARY KEY,
      first_unlocked_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );`);

  // The currency ledger (spec §6.1). Balances are NEVER stored as balances: two
  // instances each writing a running total would lose increments to
  // last-writer-wins, so every earn and spend is a row under a natural
  // idempotent key and the total is derived. Append-only, like ramble_cells.
  await initTable(db, "ramble_wallet", `
    CREATE TABLE IF NOT EXISTS ramble_wallet (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      delta INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (kind, key)
    );`);

  // Phase 2: which nests THIS instance's user has already claimed. Local by
  // design (spec §5): a claim is not shared state, the egg it produced is
  // (ramble_eggs replicates). PK (cell, week) makes a double-tap idempotent;
  // claimed_at drives the one-claim-per-local-day limit.
  await initTable(db, "ramble_nest_claims", `
    CREATE TABLE IF NOT EXISTS ramble_nest_claims (
      cell TEXT NOT NULL,
      week TEXT NOT NULL,
      egg_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY (cell, week)
    );`);

  // Phase 3: egg swaps. REPLICATED (the user's own instances show the same
  // open offers) — natural key trade_id, lamport_ts for the envelope LWW
  // (servers/sharing/instance-sync.js applyRambleTrade). `role` says which
  // side of the swap this instance's user is; `offer_json` is the sanitized
  // summary of the counterpart's egg as it arrived (display only; the egg
  // itself is materialized from the completing envelope); `expires_at` is
  // created_at + TRADE_TTL_MS, swept locally on the drain tick.
  await initTable(db, "ramble_trades", `
    CREATE TABLE IF NOT EXISTS ramble_trades (
      trade_id TEXT PRIMARY KEY,
      counterpart TEXT NOT NULL,
      role TEXT NOT NULL,
      my_egg_id TEXT,
      their_egg_id TEXT,
      offer_json TEXT,
      state TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_trades_state ON ramble_trades(state);`);

  // Phase 3: the contacts-delivery queue. LOCAL by design, exactly like
  // ramble_tombstones: one row per (recipient, thing to send); the gateway
  // transport turns each into one NIP-44 DM and deletes the row once a relay
  // accepted it. No lamport_ts, never in SYNCED_TABLES — only the instance
  // that authored a mark/gift/offer, or answered a swap step, delivers it (a
  // replicated copy on the user's other Crow must not send it a second time).
  await initTable(db, "ramble_outbox", `
    CREATE TABLE IF NOT EXISTS ramble_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_crow_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ramble_outbox_ref ON ramble_outbox(kind, ref_id);`);

  // The map arrived after people had already been walking. Without this, fog
  // covers ground the user has genuinely stood in and their whole public map
  // goes blank on upgrade — and on a desktop, where geolocation is far vaguer
  // than unlock.max.accuracy.m, it would never recover. visit_place credits are
  // only ever awarded from a real position fix, so they are exactly the record
  // we would have kept had this table existed. Local and un-emitted: each
  // instance seeds from its own history, and the MIN() apply makes any
  // resulting asymmetry benign.
  await backfillCellsOnce(db);
}
