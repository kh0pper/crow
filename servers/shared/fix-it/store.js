/**
 * Fix-it Cards store — CRUD for the local-only `fix_it_items` table.
 *
 * DB-pure: no registry, no notifications, no HTML. One focused unit.
 * `upsertItem` returns {id, notify} so the caller pushes exactly once on a
 * newly-created or reopened item (not on every dedup retry).
 */

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch { return fallback; }
}

function rowToItem(r) {
  return {
    id: Number(r.id),
    source: r.source,
    dedupKey: r.dedup_key,
    title: r.title,
    why: r.why,
    severity: r.severity,
    remedies: parseJson(r.remedies, []),
    context: parseJson(r.context, {}),
    status: r.status,
    count: Number(r.count),
    suppressedUntil: r.suppressed_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Insert or update a Fix-it item keyed by (source, dedup_key).
 * @returns {Promise<{id:number, notify:boolean}>}
 */
export async function upsertItem(db, item) {
  const { source, dedupKey, title, why = null, severity = "warn", remedies = [], context = null } = item;
  // Snapshot prior status to decide notify (new row vs reopened resolved).
  const prior = await db.execute({
    sql: "SELECT id, status FROM fix_it_items WHERE source = ? AND dedup_key = ?",
    args: [source, dedupKey],
  });
  const existed = prior.rows[0];

  await db.execute({
    sql: `INSERT INTO fix_it_items (source, dedup_key, title, why, severity, remedies, context)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, dedup_key) DO UPDATE SET
            count = count + 1,
            title = excluded.title,
            why = excluded.why,
            severity = excluded.severity,
            remedies = excluded.remedies,
            context = excluded.context,
            updated_at = datetime('now'),
            status = CASE WHEN fix_it_items.status = 'resolved' THEN 'pending' ELSE fix_it_items.status END`,
    args: [source, dedupKey, title, why, severity, JSON.stringify(remedies), context == null ? null : JSON.stringify(context)],
  });

  const after = await db.execute({
    sql: "SELECT id FROM fix_it_items WHERE source = ? AND dedup_key = ?",
    args: [source, dedupKey],
  });
  const id = Number(after.rows[0].id);
  const notify = !existed || existed.status === "resolved";
  return { id, notify };
}

export async function resolveByKey(db, source, dedupKey) {
  await db.execute({
    sql: "UPDATE fix_it_items SET status = 'resolved', updated_at = datetime('now') WHERE source = ? AND dedup_key = ?",
    args: [source, dedupKey],
  });
}

export async function markResolved(db, id) {
  await db.execute({
    sql: "UPDATE fix_it_items SET status = 'resolved', updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });
}

export async function dismiss(db, id, suppressDays = 7) {
  await db.execute({
    sql: `UPDATE fix_it_items
          SET status = 'dismissed',
              suppressed_until = datetime('now', '+' || ? || ' days'),
              updated_at = datetime('now')
          WHERE id = ?`,
    args: [suppressDays, id],
  });
}

export async function getItem(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM fix_it_items WHERE id = ?", args: [id] });
  return rows[0] ? rowToItem(rows[0]) : null;
}

export async function listPending(db) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM fix_it_items
          WHERE status = 'pending'
            AND (suppressed_until IS NULL OR suppressed_until <= datetime('now'))
          ORDER BY updated_at DESC, id DESC`,
    args: [],
  });
  return rows.map(rowToItem);
}
