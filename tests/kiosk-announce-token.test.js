import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/registry.js";
import { ensureKioskAnnounceToken, validateKioskAnnounceToken, KIOSK_ANNOUNCE_TOKEN_KEYS } from "../servers/gateway/local-token.js";

let home, db; const saved = { h: process.env.CROW_HOME, d: process.env.CROW_DATA_DIR };
before(() => {
  home = mkdtempSync(join(tmpdir(), "kiosk-ann-"));
  process.env.CROW_HOME = home; process.env.CROW_DATA_DIR = join(home, "data");
  const p = join(home, "crow.db");
  const c = new Database(p);
  c.exec(`CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (key, instance_id));`);
  c.close();
  db = createDbClient(p);
});
after(() => { db.close(); rmSync(home, { recursive: true, force: true }); for (const [k, v] of [["CROW_HOME", saved.h], ["CROW_DATA_DIR", saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test("mint writes a 0600 file and a local-scope hash; validate is exact; ensure is idempotent", async () => {
  assert.deepEqual(await ensureKioskAnnounceToken(db), { minted: true });
  const file = join(home, "kiosk-announce-token");
  const tok = readFileSync(file, "utf8");
  assert.match(tok, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await validateKioskAnnounceToken(db, tok), true);
  assert.equal(await validateKioskAnnounceToken(db, tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0")), false);
  assert.equal(await validateKioskAnnounceToken(db, ""), false);
  assert.deepEqual(await ensureKioskAnnounceToken(db), { minted: false });
  assert.equal(readFileSync(file, "utf8"), tok);
  assert.equal(isSyncable(KIOSK_ANNOUNCE_TOKEN_KEYS.HASH), false, "never syncs to peers");
});
