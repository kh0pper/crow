/**
 * N1c-10 — the one-time "keep a copy of your Crow identity off this machine"
 * nudge (the operator's ruling, 2026-11-05).
 *
 * `npm run backup` keeps identity.json in the LOCAL backup folder only, so the
 * identity lives on this disk unless the owner makes the passphrase-protected
 * copy. Crow therefore asks ONCE: a dismissable notification at boot, and never
 * again — neither on the next boot nor after the notification is dismissed. The
 * flag is claimed atomically before the send, and handed back if the send fails,
 * so a failed nudge leaves no flag behind.
 *
 * The scratch env is pinned BEFORE importing identity.js (it resolves its data
 * dir at import time), so `handleIdentityBackupPost` here sees a real
 * identity.json in a temp dir and never a real ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { rmScratch } from "./helpers/safe-rm.js";

const scratch = mkdtempSync(join(tmpdir(), "crow-identity-nudge-"));
const dataDir = join(scratch, "data");
mkdirSync(dataDir, { recursive: true });
process.env.CROW_DATA_DIR = dataDir;
process.env.CROW_DISABLE_NOSTR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

after(() => rmScratch(scratch));

// A plaintext-seed identity.json, exactly the shape identity.js writes.
const CROW_ID = "crow:nudgefirst";
writeFileSync(join(dataDir, "identity.json"), JSON.stringify({
  version: 1,
  crowId: CROW_ID,
  ed25519Pubkey: "22".repeat(32),
  secp256k1Pubkey: "33".repeat(33),
  createdAt: "2026-11-05T00:00:00.000Z",
  seed: "4d1e".repeat(16),
}, null, 2), { mode: 0o600 });

const { createNotification } = await import("../servers/shared/notifications.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
const {
  nudgeIdentityBackup, runIdentityBackupNudge,
  NUDGED_SETTING, EXPORTED_SETTING, NUDGE_SOURCE, NUDGE_TITLE_KEY, NUDGE_BODY_KEY,
  identityBackupActionUrl, identityBackupTarget,
} = await import("../servers/gateway/boot/identity-backup-nudge.js");
const { STEP_KEYS, handleIdentityBackupPost } = await import("../servers/gateway/dashboard/panels/onboarding.js");

const DONE_IDX = STEP_KEYS.indexOf("done");
const PASSPHRASE = "correct horse battery staple";

/** The two tables this file needs; the rest of the schema is irrelevant here. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'system',
    source TEXT,
    title TEXT NOT NULL,
    body TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    action_url TEXT,
    metadata TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_dismissed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    schedule_id INTEGER,
    expires_at TEXT,
    snoozed_until TEXT
  );
`;

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(SCHEMA);
  return db;
}

const setting = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;

const notifications = async (db) =>
  (await db.execute({ sql: "SELECT * FROM notifications ORDER BY id", args: [] })).rows;

/** The nudge with the REAL createNotification, minus the network fan-out. */
const notifyQuietly = (db, opts) => createNotification(db, { ...opts, deliver: false });

/** Run "a boot": the module's decision path, with an injected db and identity. */
const boot = (db, over = {}) =>
  nudgeIdentityBackup({
    db,
    notify: notifyQuietly,
    identityExists: () => true,
    ...over,
  });

test("the identity backup nudge is sent once", async () => {
  const db = await freshDb();
  const first = await boot(db);
  assert.deepEqual(first, { sent: true, reason: "sent" }, "the first boot nudges");
  assert.ok(await setting(db, NUDGED_SETTING), "the flag is recorded with the nudge");

  const [n, ...rest] = await notifications(db);
  assert.equal(rest.length, 0, `exactly one notification, saw ${rest.length} more`);
  assert.equal(n.type, "system");
  assert.equal(n.source, NUDGE_SOURCE);
  assert.equal(n.priority, "normal");
  assert.equal(n.action_url, `/dashboard/onboarding?step=${DONE_IDX}`);
  assert.equal(n.action_url, identityBackupActionUrl(), "one source for where the nudge points");
  assert.equal(n.title, "Keep a copy of your Crow identity off this machine");
  assert.equal(n.body, "Your nightly backups keep your identity on this machine only. Make a passphrase-protected copy and store it somewhere else, so a lost disk does not lose your Crow identity.");
  assert.equal(n.title, t(NUDGE_TITLE_KEY, "en"), "the title is the i18n en value");
  assert.equal(n.body, t(NUDGE_BODY_KEY, "en"), "the body is the i18n en value");

  // Boot again, and again: never a second one. Dismissing it changes nothing.
  assert.deepEqual(await boot(db), { sent: false, reason: "already" });
  await db.execute({ sql: "UPDATE notifications SET is_dismissed = 1", args: [] });
  assert.deepEqual(await boot(db), { sent: false, reason: "already" });
  assert.equal((await notifications(db)).length, 1, "still exactly one notification");

  // Spanish dashboard → the same nudge, in Spanish.
  const es = await freshDb();
  await es.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('language', 'es')", args: [] });
  assert.deepEqual(await boot(es), { sent: true, reason: "sent" });
  const [esNote] = await notifications(es);
  assert.equal(esNote.title, t(NUDGE_TITLE_KEY, "es"));
  assert.equal(esNote.body, t(NUDGE_BODY_KEY, "es"));
  assert.notEqual(esNote.title, t(NUDGE_TITLE_KEY, "en"), "es is a real translation");
});

test("the identity backup nudge is never sent without an identity, or after it", async () => {
  // No identity.json → nothing to nag about.
  const none = await freshDb();
  assert.deepEqual(await boot(none, { identityExists: () => false }), { sent: false, reason: "no-identity" });
  assert.equal((await notifications(none)).length, 0);
  assert.equal(await setting(none, NUDGED_SETTING), null, "and no flag was burned");

  // The owner already made the encrypted backup (the onboarding handler's flag).
  const exported = await freshDb();
  const t0 = new Date().toISOString();
  await exported.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)", args: [EXPORTED_SETTING, t0] });
  assert.deepEqual(await boot(exported), { sent: false, reason: "exported" });
  assert.equal((await notifications(exported)).length, 0);
  assert.equal(await setting(exported, NUDGED_SETTING), null);
});

test("a nudge that cannot be sent leaves the flag unset, so the next boot tries again", async () => {
  const db = await freshDb();
  const warn = console.warn;
  console.warn = () => {};
  let attempt;
  try {
    attempt = await boot(db, { notify: async () => { throw new Error("push is down"); } });
  } finally { console.warn = warn; }
  assert.deepEqual(attempt, { sent: false, reason: "error" });
  assert.equal(await setting(db, NUDGED_SETTING), null, "the claim was given back");
  assert.equal((await notifications(db)).length, 0);

  assert.deepEqual(await boot(db), { sent: true, reason: "sent" }, "the next boot nudges");
  assert.ok(await setting(db, NUDGED_SETTING));
});

test("the boot entry point opens and closes its own client and never throws", async () => {
  const db = await freshDb();
  let closed = 0;
  const result = await runIdentityBackupNudge({
    dbFactory: () => ({ execute: (...a) => db.execute(...a), close: () => { closed++; } }),
    notify: notifyQuietly,
    identityExists: () => true,
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { sent: true, reason: "sent" });
  assert.equal(closed, 1, "the client it opened is closed again");
  assert.equal((await notifications(db)).length, 1);

  // A client that cannot even be opened is a silent skip, not a boot failure.
  const failed = await runIdentityBackupNudge({
    dbFactory: () => { throw new Error("no database"); },
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(failed, { sent: false, reason: "error" });
});

test("the boot registers the nudge once, and only on a dashboard gateway", () => {
  // The one registration line lives in boot/post-listen.js. A --no-auth gateway
  // is never the operator's dashboard, so it must not nudge (its notifications
  // would go to no one).
  const src = readFileSync(new URL("../servers/gateway/boot/post-listen.js", import.meta.url), "utf8");
  assert.match(src, /import\("\.\/identity-backup-nudge\.js"\)/, "post-listen imports the nudge module");
  assert.match(src, /runIdentityBackupNudge\(\)/, "and runs it");
  const call = src.indexOf("runIdentityBackupNudge()");
  const guard = src.lastIndexOf("if (!noAuth) {", call);
  assert.ok(guard > 0 && guard < call, "the run sits inside a `!noAuth` guard");
  assert.equal(src.match(/runIdentityBackupNudge\(\)/g).length, 1, "registered exactly once");
  // A boot task must never be able to take the gateway down with it.
  assert.match(src.slice(call), /^[^;]*\.catch\(/, "the call is caught");
});

test("making the encrypted identity backup stops the nudge", async () => {
  assert.equal(existsSync(identityBackupTarget()), true, "the scratch identity.json is where the nudge looks");

  const db = await freshDb();
  // What the done step's form POSTs — the real handler, with a db supplied the
  // way production's route wrapper would.
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    redirectAfterPost(url) { this.redirected = url; },
    type(v) { this.contentType = v; return this; },
    send(body) { this.body = body; return this; },
  };
  await handleIdentityBackupPost({ method: "POST", headers: {}, query: {}, body: { passphrase: PASSPHRASE, confirm: PASSPHRASE } }, res, { db });
  assert.equal(res.redirected, undefined, "the download was sent, not a redirect");
  const payload = JSON.parse(res.body);
  assert.equal(payload.kind, "crow-identity-backup");
  assert.ok(!res.body.includes("4d1e".repeat(16)), "the payload never carries the plaintext seed");

  const exportedAt = await setting(db, EXPORTED_SETTING);
  assert.ok(exportedAt, "handleIdentityBackupPost recorded the export");
  assert.equal(EXPORTED_SETTING, "identity_backup_exported_at");

  // The boot nudge now declines, and records no nudge flag.
  assert.deepEqual(await boot(db), { sent: false, reason: "exported" });
  assert.equal((await notifications(db)).length, 0, "no nudge for an owner who already has the copy");
  assert.equal(await setting(db, NUDGED_SETTING), null);

  // A failed export (wrong confirm) records nothing.
  const other = await freshDb();
  const failRes = { setHeader() {}, type() { return this; }, send() { return this; }, redirectAfterPost(u) { this.redirected = u; } };
  await handleIdentityBackupPost({ method: "POST", headers: {}, query: {}, body: { passphrase: PASSPHRASE, confirm: "nope" } }, failRes, { db: other });
  assert.ok(failRes.redirected, "a bad confirm redirects back with an error");
  assert.equal(await setting(other, EXPORTED_SETTING), null, "nothing was recorded");

  // The identity the nudge promised to protect is still readable (0600).
  assert.equal((JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf8"))).crowId, CROW_ID);
});