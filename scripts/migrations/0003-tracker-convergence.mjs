// scripts/migrations/0003-tracker-convergence.mjs
//
// Track 0 Phase B: crow.db's tracker_defs/tracker_items converge into
// tasks.db's board_defs/tasks_items (slug boards). See the plan/spec for the
// full contract. Non-negotiables:
//   - tasks_items is NEVER rebuilt here (card ids are load-bearing:
//     pm_sync_state local_kind='kanban' keys on them). Columns arrive via
//     guarded ALTER TABLE ADD COLUMN only.
//   - Tracker item ids CANNOT survive (they collide with card ids). The
//     old→new map remaps pm_sync_state.local_id for local_kind='tracker'.
//   - Item copy is DELETE+recopy per board inside one transaction, so a
//     crashed run converges instead of duplicating.
//   - Copy-proof (count + field equality) before DROP; throw on mismatch —
//     the runner records nothing on throw.
import Database from "better-sqlite3";

export const id = "0003-tracker-convergence";

// F3: the gateway's migration carve-out (servers/gateway/index.js ~233-236)
// tolerates an error whose message matches this regex by deferring the whole
// migration registry run to next boot — meant for a transient SQLITE_BUSY on
// a bundle-owned store the gateway does not control. That is safe on the
// column-only path (nothing has moved), but NOT once tracker_defs is
// confirmed present in crow.db: a BUSY error firing mid-move would have the
// gateway serve Phase B code with the move unrecorded, and the next boot's
// DELETE+recopy per board would discard any tracker writes made in the
// window. The move half below wraps every error through this helper so a
// BUSY-shaped one comes back failing CLOSED (gateway boot fails hard) instead
// of being silently deferred again.
const GATEWAY_BUSY_CARVEOUT_RE = /SQLITE_BUSY|database is locked/i;

/**
 * Rethrow-wrap an error from the move half of run() so it can never be
 * mistaken for the gateway's transient-BUSY carve-out. Non-BUSY errors pass
 * through completely unchanged (identity) — this only touches the one shape
 * that would otherwise be deferred silently.
 * @param {Error} e
 * @returns {Error}
 */
export function failClosedOnBusyMidMove(e) {
  const msg = e && e.message != null ? String(e.message) : String(e);
  if (!GATEWAY_BUSY_CARVEOUT_RE.test(msg)) return e;
  // Deliberately do NOT interpolate the original message text into the
  // wrapped one: the original IS the string the carve-out regex matches
  // (that is exactly why we're here), so splicing it in verbatim would leave
  // the wrapped message matching the very regex it exists to escape. The
  // original is still fully available via `cause` for logs/diagnostics.
  const wrapped = new Error(
    "0003: interrupted mid-move — failing closed to protect tracker data (see cause for the original error)"
  );
  wrapped.cause = e;
  return wrapped;
}

const NEW_COLS = [
  ["board_id", "INTEGER"],
  ["bot_id", "TEXT"],
  ["action_needed", "TEXT"],
  ["next_followup_date", "TEXT"],
  ["processing_lease", "TEXT"],
  ["processing_lease_status", "TEXT"],
];

function open(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

function mapFields(columnsJson) {
  let cols;
  try { cols = JSON.parse(columnsJson || "[]"); } catch { cols = []; }
  if (!Array.isArray(cols)) cols = [];
  // Spread-preserve: client.js reads entry keys beyond key/label (`type` drives
  // the json-field renderer at client.js:134, `readonly` at :135) and the source
  // tables are DROPPED after this run — a keep-list here would destroy them
  // unrecoverably. Only key/label/storage are normalized.
  return cols.filter((c) => c && typeof c === "object" && c.key).map((c) => ({
    ...c,
    key: String(c.key),
    label: String(c.label || c.key),
    storage: "data",
  }));
}

export async function run({ dbPath, tasksDbPath, log = () => {} }) {
  const tdb = open(tasksDbPath);
  try {
    const hasTasks = tdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_items'").get();
    if (!hasTasks) return { deferred: true }; // bundle not started yet — retry next boot

    // ---- converged columns + indexes (always, even with nothing to move) ----
    const cols = tdb.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    for (const [name, type] of NEW_COLS) {
      if (!cols.includes(name)) tdb.exec(`ALTER TABLE tasks_items ADD COLUMN ${name} ${type}`);
    }
    tdb.exec("CREATE INDEX IF NOT EXISTS idx_tasks_items_board ON tasks_items(board_id, status)");
    tdb.exec("CREATE INDEX IF NOT EXISTS idx_tasks_items_lease ON tasks_items(processing_lease_status)");

    const cdb = open(dbPath);
    try {
      const hasTracker = cdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracker_defs'").get();
      if (!hasTracker) {
        log("  no tracker tables — columns converged, nothing to move");
        return;
      }

      // From here on, a data-bearing move is pending (tracker_defs confirmed
      // present) — any error whose message matches the gateway's transient-
      // BUSY carve-out must be rethrown wrapped so it does NOT match, and
      // fails the gateway boot closed instead of deferring silently (F3).
      try {

      // board_defs may be missing if 0002 deferred on this store shape; it is
      // part of the converged world this migration needs.
      tdb.exec(`CREATE TABLE IF NOT EXISTS board_defs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, project_id INTEGER UNIQUE,
        display_name TEXT NOT NULL, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL,
        fields_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

      const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      await cdb.backup(`${dbPath}.bak-0003-${ts}`);
      await tdb.backup(`${tasksDbPath}.bak-0003-${ts}`);
      log(`  backups: crow.db.bak-0003-${ts}, tasks.db.bak-0003-${ts}`);

      const defs = cdb.prepare("SELECT id, slug, display_name, columns_json, status_values FROM tracker_defs ORDER BY id").all();
      const hasSyncState = !!cdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pm_sync_state'").get();
      const idMap = new Map(); // old tracker_items.id → new tasks_items.id
      let totalTrackerItemsCopied = 0; // orphan guard input (see below)

      for (const def of defs) {
        let statuses;
        try { statuses = JSON.parse(def.status_values || "[]"); } catch { statuses = []; }
        const terminals = Array.isArray(statuses) && statuses.includes("done") ? ["done"] : [];
        tdb.prepare(
          "INSERT OR IGNORE INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?)"
        ).run(def.slug, def.display_name, def.status_values,
          JSON.stringify(terminals), JSON.stringify(mapFields(def.columns_json)));
        const boardId = tdb.prepare("SELECT id FROM board_defs WHERE slug=?").get(def.slug).id;

        // A pre-existing slug row (operator-created, or a crashed prior run)
        // wins via OR IGNORE — but never silently: statuses that differ from
        // the tracker def's can make copied items invisible on the board
        // (renderCustomTracker only draws the def's columns).
        const kept = tdb.prepare("SELECT status_values, fields_json FROM board_defs WHERE slug=?").get(def.slug);
        if (kept.status_values !== def.status_values) {
          log(`  ${def.slug}: pre-existing board_defs row kept — its statuses ${kept.status_values} differ from the tracker's ${def.status_values}`);
        }
        const wouldWrite = JSON.stringify(mapFields(def.columns_json));
        if (kept.fields_json !== wouldWrite) {
          log(`  ${def.slug}: pre-existing board_defs row kept — its fields differ from the tracker's columns (source is about to be dropped; sidecar backup holds the original)`);
        }

        const items = cdb.prepare(
          `SELECT id, bot_id, status, priority, label, data_json, action_needed,
                  next_followup_date, processing_lease, processing_lease_status,
                  created_at, updated_at
           FROM tracker_items WHERE tracker_id=? ORDER BY id`
        ).all(def.id);
        totalTrackerItemsCopied += items.length;

        const ins = tdb.prepare(
          `INSERT INTO tasks_items (board_id, bot_id, status, priority, title, data_json,
             action_needed, next_followup_date, processing_lease, processing_lease_status,
             created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        tdb.transaction(() => {
          const del = tdb.prepare("DELETE FROM tasks_items WHERE board_id=?").run(boardId);
          if (del.changes) log(`  ${def.slug}: recopy — deleted ${del.changes} row(s) from a prior partial run`);
          for (const it of items) {
            const r = ins.run(boardId, it.bot_id, it.status, it.priority, it.label,
              it.data_json, it.action_needed, it.next_followup_date,
              it.processing_lease, it.processing_lease_status, it.created_at, it.updated_at);
            idMap.set(Number(it.id), Number(r.lastInsertRowid));
          }
        })();

        // ---- copy-proof before anything is dropped ----
        const copied = tdb.prepare(
          "SELECT id, bot_id, status, priority, title, data_json, action_needed, next_followup_date, processing_lease, processing_lease_status FROM tasks_items WHERE board_id=? ORDER BY id"
        ).all(boardId);
        if (copied.length !== items.length) {
          throw new Error(`0003: ${def.slug} copied ${copied.length}/${items.length} — refusing to drop`);
        }
        for (let i = 0; i < items.length; i++) {
          const a = items[i], b = copied[i];
          if (b.title !== a.label || b.status !== a.status || b.priority !== a.priority ||
              b.data_json !== a.data_json || b.action_needed !== a.action_needed ||
              b.next_followup_date !== a.next_followup_date ||
              b.processing_lease !== a.processing_lease ||
              b.processing_lease_status !== a.processing_lease_status ||
              b.bot_id !== a.bot_id || idMap.get(Number(a.id)) !== Number(b.id)) {
            throw new Error(`0003: ${def.slug} row mismatch at old id ${a.id} — refusing to drop`);
          }
        }
        log(`  moved ${def.slug}: ${items.length} item(s) → board_defs id ${boardId}`);
      }

      // Orphan guard: items whose tracker_id has no def row were never copied
      // and would die in the DROP. Refuse — loud beats lossy.
      const totalItems = cdb.prepare("SELECT COUNT(*) AS n FROM tracker_items").get().n;
      if (totalItems !== totalTrackerItemsCopied) {
        throw new Error(`0003: ${totalItems - totalTrackerItemsCopied} orphaned tracker_items (tracker_id without a def) — refusing to drop`);
      }

      // Remap + drop in ONE crow.db transaction: a crash between them would
      // strand pm_sync_state pointing at ids a re-run's DELETE+recopy just
      // discarded — the Monday mirror would then duplicate every item.
      // The remap itself is two-phase (old→-new, then flip) because new ids
      // can overlap old ids on small stores, and a single pass chains:
      // a row set to N gets re-matched by a later (oldId=N) entry.
      cdb.transaction(() => {
        if (hasSyncState && idMap.size) {
          const upd = cdb.prepare("UPDATE pm_sync_state SET local_id=? WHERE local_kind='tracker' AND local_id=?");
          let remapped = 0;
          for (const [oldId, newId] of idMap) remapped += upd.run(-newId, oldId).changes;
          cdb.prepare("UPDATE pm_sync_state SET local_id = -local_id WHERE local_kind='tracker' AND local_id < 0").run();
          log(`  pm_sync_state: remapped ${remapped} tracker row(s)`);
          // Stale rows (local_id not in the idMap — their item was deleted
          // before this migration) keep ids that can now collide with card /
          // item ids: the mirror would UPDATE the wrong row. Loud, not silent.
          const stale = cdb.prepare(
            `SELECT id, board_id, item_id, local_id FROM pm_sync_state WHERE local_kind='tracker' AND local_id NOT IN (${[...idMap.values()].join(",") || "NULL"})`
          ).all();
          for (const s of stale) {
            log(`  pm_sync_state: STALE tracker row (state id ${s.id}, monday item ${s.item_id}) points at missing item ${s.local_id} — clear it manually before the next mirror pull`);
          }
        }
        cdb.exec("DROP TABLE tracker_items");
        cdb.exec("DROP TABLE tracker_defs");
      })();
      log("  dropped crow.db tracker_items, tracker_defs");
      } catch (e) {
        throw failClosedOnBusyMidMove(e);
      }
    } finally {
      cdb.close();
    }
  } finally {
    tdb.close();
  }
}
