/**
 * A trusted paired peer row for tests that only need a dashboard session
 * minted through mintSsoSession (PT-1: a mint re-checks its source peer).
 * Writes to whatever DB createDbClient() resolves in this process (the
 * test's scratch CROW_DATA_DIR / CROW_DB_PATH).
 */
import { createDbClient } from "../../servers/db.js";

export async function trustedSsoSource(id = "test") {
  const db = createDbClient();
  try {
    await db.execute({
      sql: "INSERT OR IGNORE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, 'active', 1)",
      args: [id, id, `crow:${id}`],
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return id;
}
