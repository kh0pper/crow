/**
 * Bot ↔ project shares (Phase 1): the store's grant/revoke/resolve rules, the live
 * outside-member suspension, and the two lifecycle endings that must revoke a share rather than
 * rely on a foreign-key cascade (a deleted bot, a deleted project).
 *
 * Scratch CROW_HOME + data dir, a real crow.db from scripts/init-db.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "crow-shares-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const REPO = join(import.meta.dirname, "..");

let db = null;
let createProjectSpace = null;
let L = null;
let S = null;
let handleDeleteConfirm = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  // delete-bot.js derives the bot's local contact from the instance identity.
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity("");
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  L = await import("../servers/shared/project-lifecycle.js");
  S = await import("../servers/shared/project-bot-shares.js");
  ({ handleDeleteConfirm } = await import("../servers/gateway/dashboard/panels/bot-builder/delete-bot.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
const audits = async (projectId, action) => (await db.execute({
  sql: "SELECT actor_type, actor_id, action, target, payload FROM project_audit_log WHERE project_id = ? AND action = ? ORDER BY id",
  args: [Number(projectId), action],
})).rows;
const payloadOf = (row) => {
  try { return JSON.parse(row.payload || "{}"); } catch { return {}; }
};

async function mkProject(name) {
  const r = await createProjectSpace(db, { name });
  return Number(r.id);
}

let botSeq = 0;
async function mkBot({ home = null, definition = {} } = {}) {
  botSeq += 1;
  const botId = `share-bot-${botSeq}`;
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, `Bot ${botSeq}`, JSON.stringify(definition), home],
  });
  return botId;
}

let contactSeq = 0;
async function mkOutsideMember(projectId, { revoked = false } = {}) {
  contactSeq += 1;
  const crowId = `peer-${contactSeq}`.padEnd(16, "0");
  const r = await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (?,?,?,?, 'remote')",
    args: [crowId, `Peer ${contactSeq}`, `${contactSeq}`.padEnd(64, "a"), `${contactSeq}`.padEnd(64, "b")],
  });
  const contactId = Number(r.lastInsertRowid);
  await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role, mode, revoked_at) VALUES (?,?, 'viewer', 'live', ?)",
    args: [Number(projectId), contactId, revoked ? "2026-01-01 00:00:00" : null],
  });
  return contactId;
}

const NO_ACCESS = Object.freeze({ kind: "none", level: null, suspended: false, reason: null });

// ---- grant ----

test("grant creates one live row and writes an audit row in BOTH projects", async () => {
  const home = await mkProject("Share home A");
  const x = await mkProject("Share target A");
  const botId = await mkBot({ home });

  const res = await S.grantShare(db, { projectId: x, botId, level: "read" });
  assert.equal(res.changed, "created");
  assert.ok(Number.isInteger(res.id) && res.id > 0, "returns the row id");
  assert.equal(res.remoteInvocationOn, false, "remote invocation is off unless it is both flagged and wired");

  const row = await one("SELECT project_id, bot_id, level, revoked_at FROM project_bot_shares WHERE id = ?", [res.id]);
  assert.equal(Number(row.project_id), x);
  assert.equal(row.bot_id, botId);
  assert.equal(row.level, "read");
  assert.equal(row.revoked_at, null, "a fresh grant is live");

  const onX = await audits(x, "share.grant");
  assert.equal(onX.length, 1);
  assert.equal(onX[0].actor_type, "local");
  assert.equal(onX[0].target, `bot:${botId}`);
  assert.deepEqual(payloadOf(onX[0]), { level: "read" });

  const onHome = await audits(home, "share.grant");
  assert.equal(onHome.length, 1, "the bot's own project tells the story too");
  assert.equal(onHome[0].target, `bot:${botId}`);
  const homePayload = payloadOf(onHome[0]);
  assert.equal(homePayload.level, "read");
  assert.equal(Number(homePayload.project_id), x, "the home log names the other project by id");
  assert.ok(!JSON.stringify(homePayload).includes("Share target A"), "never the shared project's name");
});

test("regrant at the same level is unchanged and writes nothing", async () => {
  const x = await mkProject("Share target B");
  const botId = await mkBot();
  const first = await S.grantShare(db, { projectId: x, botId, level: "read_write" });
  const again = await S.grantShare(db, { projectId: x, botId, level: "read_write" });
  assert.equal(again.changed, "unchanged");
  assert.equal(again.id, first.id, "the same live row");
  assert.equal((await audits(x, "share.level_changed")).length, 0);
  assert.equal((await audits(x, "share.grant")).length, 1);
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_bot_shares WHERE bot_id = ?", [botId]), 1);
});

test("regrant at another level is level_changed on the same row", async () => {
  const theHome = await mkProject("Share home C");
  const x = await mkProject("Share target C");
  const botId = await mkBot({ home: theHome });
  const first = await S.grantShare(db, { projectId: x, botId, level: "read" });
  const raised = await S.grantShare(db, { projectId: x, botId, level: "read_write" });
  assert.equal(raised.changed, "level_changed");
  assert.equal(raised.id, first.id);
  const row = await one("SELECT level FROM project_bot_shares WHERE id = ?", [first.id]);
  assert.equal(row.level, "read_write");
  const changed = await audits(x, "share.level_changed");
  assert.equal(changed.length, 1);
  assert.deepEqual(payloadOf(changed[0]), { level: "read_write" });
  assert.equal((await audits(theHome, "share.level_changed")).length, 1, "both logs");
});

test("a bad level is a ShareError('bad_level')", async () => {
  const x = await mkProject("Share target D");
  const botId = await mkBot();
  await assert.rejects(() => S.grantShare(db, { projectId: x, botId, level: "write" }),
    (err) => err instanceof S.ShareError && err.code === "bad_level");
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_bot_shares WHERE bot_id = ?", [botId]), 0);
});

test("a missing bot is bot_not_found", async () => {
  const x = await mkProject("Share target E");
  await assert.rejects(() => S.grantShare(db, { projectId: x, botId: "no-such-bot", level: "read" }),
    (err) => err instanceof S.ShareError && err.code === "bot_not_found");
});

test("grant refuses the bot's own project as same_project", async () => {
  const home = await mkProject("Share home F");
  const botId = await mkBot({ home });
  await assert.rejects(() => S.grantShare(db, { projectId: home, botId, level: "read" }),
    (err) => err instanceof S.ShareError && err.code === "same_project");
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_bot_shares WHERE bot_id = ?", [botId]), 0);
});

test("grant refuses while the shared project has an outside member", async () => {
  const x = await mkProject("Share target G");
  const botId = await mkBot();
  await mkOutsideMember(x);
  await assert.rejects(() => S.grantShare(db, { projectId: x, botId, level: "read" }),
    (err) => err instanceof S.ShareError && err.code === "outside_members");
});

test("grant refuses while the bot's HOME project has an outside member", async () => {
  const home = await mkProject("Share home H");
  const x = await mkProject("Share target H");
  const botId = await mkBot({ home });
  await mkOutsideMember(home);
  await assert.rejects(() => S.grantShare(db, { projectId: x, botId, level: "read" }),
    (err) => err instanceof S.ShareError && err.code === "outside_members");
});

test("a revoked contact member does not count as an outside member", async () => {
  const x = await mkProject("Share target I");
  const botId = await mkBot();
  await mkOutsideMember(x, { revoked: true });
  const res = await S.grantShare(db, { projectId: x, botId, level: "read" });
  assert.equal(res.changed, "created");
  assert.deepEqual(await S.outsideMembers(db, x), { count: 0 });
});

test("a grant an archived or tombstoned project is refused as project_not_found", async () => {
  const archived = await mkProject("Share target J");
  await L.archiveProject(db, archived);
  const botId = await mkBot();
  await assert.rejects(() => S.grantShare(db, { projectId: archived, botId, level: "read" }),
    (err) => err instanceof S.ShareError && err.code === "project_not_found");

  const tomb = await mkProject("Share target K");
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now'), status = 'archived' WHERE id = ?", args: [tomb] });
  await assert.rejects(() => S.grantShare(db, { projectId: tomb, botId, level: "read" }),
    (err) => err instanceof S.ShareError && err.code === "project_not_found");
});

test("a bot with no home project can be granted, and only the shared project is audited", async () => {
  const x = await mkProject("Share target L");
  const botId = await mkBot({ home: null });
  const res = await S.grantShare(db, { projectId: x, botId, level: "read_write" });
  assert.equal(res.changed, "created");
  assert.equal((await audits(x, "share.grant")).length, 1);
  const resolved = await S.resolveBotAccess(db, botId, x);
  assert.deepEqual(resolved, { kind: "share", level: "read_write", suspended: false, reason: null });
});

test("remoteInvocationOn reports a bot that is both flagged and wired for remote tools", async () => {
  const x = await mkProject("Share target M");
  const wired = await mkBot({ definition: { tools: { remote_mcp: ["abcdef1234567890::crow-memory"] } } });
  const unwired = await mkBot({ definition: { tools: { remote_mcp: [] } } });
  try {
    await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)", args: [JSON.stringify({ remote_invocation: true })] });
    assert.equal((await S.grantShare(db, { projectId: x, botId: wired, level: "read" })).remoteInvocationOn, true);
    assert.equal((await S.grantShare(db, { projectId: x, botId: unwired, level: "read" })).remoteInvocationOn, false);
    await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)", args: [JSON.stringify({ remote_invocation: false })] });
    assert.equal((await S.grantShare(db, { projectId: x, botId: wired, level: "read_write" })).remoteInvocationOn, false);
  } finally {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = 'feature_flags'", args: [] });
  }
});

// ---- resolve (use time) ----

test("resolveBotAccess is home for the bot's own project, share for a granted one, none otherwise", async () => {
  const home = await mkProject("Share home N");
  const x = await mkProject("Share target N");
  const other = await mkProject("Share target N2");
  const botId = await mkBot({ home });

  assert.deepEqual(await S.resolveBotAccess(db, botId, home), { kind: "home", level: null, suspended: false, reason: null });
  assert.deepEqual(await S.resolveBotAccess(db, botId, other), NO_ACCESS);

  await S.grantShare(db, { projectId: x, botId, level: "read" });
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), { kind: "share", level: "read", suspended: false, reason: null });
});

test("revoke leaves resolveBotAccess at none and audits both logs; a second revoke is no_such_share", async () => {
  const home = await mkProject("Share home O");
  const x = await mkProject("Share target O");
  const botId = await mkBot({ home });
  await S.grantShare(db, { projectId: x, botId, level: "read" });

  await S.revokeShare(db, { projectId: x, botId });
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), NO_ACCESS);
  assert.equal((await audits(x, "share.revoke")).length, 1);
  assert.equal((await audits(home, "share.revoke")).length, 1, "the home log says the share went away");
  assert.equal(await S.botHoldsLiveShare(db, botId), false);

  await assert.rejects(() => S.revokeShare(db, { projectId: x, botId }),
    (err) => err instanceof S.ShareError && err.code === "no_such_share");
});

test("a share added after the grant but before use is suspended on both sides", async () => {
  const x = await mkProject("Share target P");
  const botId = await mkBot();
  await S.grantShare(db, { projectId: x, botId, level: "read_write" });
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), { kind: "share", level: "read_write", suspended: false, reason: null });

  const contactId = await mkOutsideMember(x);
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), { kind: "share", level: "read_write", suspended: true, reason: "outside_member" });
  assert.equal(await S.botHoldsLiveShare(db, botId), true, "a suspended share still blocks the remote proxy");

  await db.execute({ sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE contact_id = ?", args: [contactId] });
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), { kind: "share", level: "read_write", suspended: false, reason: null });
});

test("an outside member on the bot's home project suspends the share too", async () => {
  const home = await mkProject("Share home Q");
  const x = await mkProject("Share target Q");
  const botId = await mkBot({ home });
  await S.grantShare(db, { projectId: x, botId, level: "read" });
  await mkOutsideMember(home);
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), { kind: "share", level: "read", suspended: true, reason: "outside_member" });
});

test("a deleted bot def, an archived project and a tombstoned project each resolve none", async () => {
  const home = await mkProject("Share home R");
  const x = await mkProject("Share target R");
  const botId = await mkBot({ home });
  await S.grantShare(db, { projectId: x, botId, level: "read" });

  // A deleted def: the share row is still there, the bot is not.
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id = ?", args: [botId] });
  assert.equal(await n("SELECT COUNT(*) AS n FROM project_bot_shares WHERE bot_id = ? AND revoked_at IS NULL", [botId]), 1,
    "the dead row survives the def (FK cascade does not fire in production)");
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), NO_ACCESS);
  assert.equal(await S.botHoldsLiveShare(db, botId), true, "the live row is what the proxy check reads");

  // A live bot whose shared project is archived, then tombstoned.
  const liveBot = await mkBot({ home });
  const y = await mkProject("Share target R2");
  await S.grantShare(db, { projectId: y, botId: liveBot, level: "read" });
  await L.archiveProject(db, y);
  assert.deepEqual(await S.resolveBotAccess(db, liveBot, y), NO_ACCESS);
  await db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now'), status = 'archived' WHERE id = ?", args: [y] });
  assert.deepEqual(await S.resolveBotAccess(db, liveBot, y), NO_ACCESS);
});

test("a share on an archived project comes back after the project is restored", async () => {
  const x = await mkProject("Share target S");
  const botId = await mkBot();
  await S.grantShare(db, { projectId: x, botId, level: "read" });
  await L.archiveProject(db, x);
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), NO_ACCESS);
  await L.restoreProject(db, x);
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), { kind: "share", level: "read", suspended: false, reason: null });
});

// ---- lists ----

test("listSharesForProject and listSharesForBot report live rows with their suspension", async () => {
  const home = await mkProject("Share home T");
  const x = await mkProject("Share target T");
  const botId = await mkBot({ home });
  const otherBot = await mkBot({ home });
  await S.grantShare(db, { projectId: x, botId, level: "read" });
  await S.grantShare(db, { projectId: x, botId: otherBot, level: "read_write" });

  const forProject = await S.listSharesForProject(db, x);
  assert.equal(forProject.length, 2);
  assert.deepEqual(forProject.map((r) => r.bot_id).sort(), [botId, otherBot].sort());
  for (const row of forProject) {
    assert.equal(Number(row.project_id), x);
    assert.equal(row.project_name, "Share target T");
    assert.equal(row.suspended, false);
    assert.equal(row.reason, null);
    assert.ok(row.granted_at, "grants carry their timestamp");
    assert.ok(row.bot_name, "the bot's display name is joined in");
  }

  const forBot = await S.listSharesForBot(db, botId);
  assert.equal(forBot.length, 1);
  assert.equal(Number(forBot[0].project_id), x);
  assert.equal(forBot[0].level, "read");

  await mkOutsideMember(home);
  const suspendedList = await S.listSharesForProject(db, x);
  assert.ok(suspendedList.every((r) => r.suspended === true && r.reason === "outside_member"));

  await S.revokeShare(db, { projectId: x, botId });
  assert.equal((await S.listSharesForProject(db, x)).length, 1, "a revoked share leaves the list");
  assert.equal((await S.listSharesForBot(db, botId)).length, 0);
});

// ---- revokeAllSharesForBot ----

test("revokeAllSharesForBot revokes every live share of one bot and audits each shared project", async () => {
  const x = await mkProject("Share target U");
  const y = await mkProject("Share target U2");
  const botId = await mkBot();
  const otherBot = await mkBot();
  await S.grantShare(db, { projectId: x, botId, level: "read" });
  await S.grantShare(db, { projectId: y, botId, level: "read_write" });
  await S.grantShare(db, { projectId: x, botId: otherBot, level: "read" });

  await S.revokeAllSharesForBot(db, botId, { reason: "bot_deleted" });

  assert.equal(await S.botHoldsLiveShare(db, botId), false);
  assert.equal(await S.botHoldsLiveShare(db, otherBot), true, "another bot's share is untouched");
  for (const projectId of [x, y]) {
    const rows = await audits(projectId, "share.revoke");
    assert.equal(rows.length, 1, `one revoke in project #${projectId}`);
    assert.equal(payloadOf(rows[0]).reason, "bot_deleted");
    assert.equal(rows[0].target, `bot:${botId}`);
  }
  // Idempotent: nothing live left, nothing written.
  await S.revokeAllSharesForBot(db, botId, { reason: "bot_deleted" });
  assert.equal((await audits(x, "share.revoke")).length, 1);
});

test("a bot with no live share is a no-op for revokeAllSharesForBot", async () => {
  await S.revokeAllSharesForBot(db, "never-shared-bot", { reason: "bot_deleted" });
  assert.equal(await S.botHoldsLiveShare(db, "never-shared-bot"), false);
});

// ---- the two lifecycle endings ----

test("purging a project revokes the shares pointing at it and audits each bot's home log", async () => {
  const home = await mkProject("Share home V");
  const x = await mkProject("Share target V");
  const withHome = await mkBot({ home });
  const homeless = await mkBot({ home: null });
  const shareWithHome = await S.grantShare(db, { projectId: x, botId: withHome, level: "read" });
  const shareHomeless = await S.grantShare(db, { projectId: x, botId: homeless, level: "read_write" });

  const res = await L.deleteProject(db, x, { confirmName: "Share target V", storageDelete: async () => {} });
  assert.equal(res.ok, true, JSON.stringify(res));

  const rows = await db.execute({
    sql: "SELECT id, revoked_at FROM project_bot_shares WHERE project_id = ? ORDER BY id",
    args: [x],
  });
  assert.equal(rows.rows.length, 2, "the rows are marked, never deleted");
  for (const row of rows.rows) assert.ok(row.revoked_at, "every live share on the deleted project is revoked");

  const homeLog = await audits(home, "share.revoke");
  assert.equal(homeLog.length, 1, "the bot's own project log records the loss");
  assert.equal(homeLog[0].target, `bot:${withHome}`);
  const payload = payloadOf(homeLog[0]);
  assert.equal(payload.reason, "project_deleted");
  assert.equal(Number(payload.project_id), x);

  assert.deepEqual(await S.resolveBotAccess(db, withHome, x), NO_ACCESS);
  assert.deepEqual(await S.resolveBotAccess(db, homeless, x), NO_ACCESS);
  assert.equal(await S.botHoldsLiveShare(db, withHome), false);
  assert.equal(await S.botHoldsLiveShare(db, homeless), false);
  assert.equal((await S.listSharesForProject(db, x)).length, 0);
  // The shares' ids are still named in the two projects' grant audits — nothing was rewritten.
  assert.equal((await audits(x, "share.grant")).length, 2);
  assert.ok(shareWithHome.id && shareHomeless.id);
});

test("deleting a bot through the Bot Builder revokes its shares; a new bot with the same id inherits nothing", async () => {
  const home = await mkProject("Share home W");
  const x = await mkProject("Share target W");
  const botId = "doomed-share-bot";
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, "Doomed Bot", "{}", home],
  });
  const granted = await S.grantShare(db, { projectId: x, botId, level: "read_write" });

  const res = { redirected: null, redirectAfterPost(u) { this.redirected = u; } };
  await handleDeleteConfirm({ body: { action: "delete_confirm", bot_id: botId } }, res, { db });
  assert.match(String(res.redirected), /deleted=doomed-share-bot/);
  assert.equal(await n("SELECT COUNT(*) AS n FROM pi_bot_defs WHERE bot_id = ?", [botId]), 0, "the def is gone");

  const row = await one("SELECT revoked_at FROM project_bot_shares WHERE id = ?", [granted.id]);
  assert.ok(row.revoked_at, "the share is revoked before the def row goes");
  const log = await audits(x, "share.revoke");
  assert.equal(log.length, 1);
  assert.equal(payloadOf(log[0]).reason, "bot_deleted");
  assert.equal(await S.botHoldsLiveShare(db, botId), false);

  // The same id re-created: a fresh bot must not inherit the old one's reach.
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, "Reborn Bot", "{}", home],
  });
  assert.deepEqual(await S.resolveBotAccess(db, botId, x), NO_ACCESS);
  assert.equal(await S.botHoldsLiveShare(db, botId), false);
});