/**
 * F3 (BH-5a) — the unresolved sync_conflicts SELECT had no LIMIT (the
 * resolved SELECT already has LIMIT 25). With the live fleet count growing
 * daily (BH-5b, out of scope here) the page grows unboundedly. Fix: cap the
 * unresolved query at 200 rows and, when the true unresolved count exceeds
 * 200, show an honest "showing first 200 of N" notice above the list —
 * never a silent truncation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import section from "../servers/gateway/dashboard/settings/sections/sync-conflicts.js";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "sync-conflicts-limit-"));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return createClient({ url: "file:" + join(dir, "crow.db") });
}

async function seedUnresolved(db, count) {
  for (let i = 0; i < count; i++) {
    await db.execute({
      sql: `INSERT INTO sync_conflicts
              (table_name, row_id, winning_instance_id, losing_instance_id,
               winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
            VALUES (?, ?, 'inst-a', 'inst-b', ?, ?, '{}', '{}', 0, 'update')`,
      args: ["test_table", `row-${i}`, i + 1, i],
    });
  }
}

function fakeReq() {
  return { csrfToken: "test-csrf", query: {} };
}

test("205 unresolved rows: render caps at 200 rows and shows the honest 'showing first 200 of 205' notice", async () => {
  const db = fresh();
  try {
    await seedUnresolved(db, 205);
    const html = await section.render({ req: fakeReq(), db, lang: "en" });

    const rowMatches = html.match(/row-\d+/g) || [];
    assert.equal(rowMatches.length, 200, "unresolved table must be capped at 200 rendered rows");

    assert.match(html, /Showing first 200 of 205/, "must show the honest over-limit notice naming the true total");
  } finally {
    await db.close();
  }
});

test("5 unresolved rows: no over-limit notice", async () => {
  const db = fresh();
  try {
    await seedUnresolved(db, 5);
    const html = await section.render({ req: fakeReq(), db, lang: "en" });

    const rowMatches = html.match(/row-\d+/g) || [];
    assert.equal(rowMatches.length, 5, "all 5 rows render");

    assert.ok(!/Showing first/.test(html), "no notice when under the limit");
  } finally {
    await db.close();
  }
});
