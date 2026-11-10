/**
 * Keyed data-backend approvals (security audit N1b-11).
 *
 * An `mcp_server` data backend is a command the gateway runs. Its owner approval
 * used to be a plain SHA-256 kept in the SAME crow.db row, so anything that can
 * write crow.db could compute it and plant an "approved" row. The stored value is
 * now `hmac1:<hex>`: an HMAC over that same hash, keyed by 32 random bytes in
 * `<CROW_HOME>/secrets/` — a file a crow.db writer cannot read or forge.
 *
 * Everything runs in a scratch HOME / data dir set BEFORE any app import.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-dbapproval-"));
const CROW_HOME = join(HOME, ".crow");
const DATA = join(CROW_HOME, "data");
mkdirSync(DATA, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = join(DATA, "crow.db");
after(() => rmSync(HOME, { recursive: true, force: true }));

execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: ROOT, env: process.env, stdio: "pipe" });
const CORE = join(DATA, "crow.db");

const {
  approveBackend, approvalHash, prepareSpawn, isApproved, hasApproval, isLegacyApproval,
  LEGACY_APPROVAL_MESSAGE,
} = await import("../servers/shared/data-backend-approval.js");
const { approvalKeyPath, ensureApprovalKey, readApprovalKey, APPROVAL_KEY_BYTES } =
  await import("../servers/shared/data-backend-approval-key.js");
const { createDbClient } = await import("../servers/db.js");
const { loadDynamicBackends } = await import("../servers/gateway/proxy.js");
const fixitStore = await import("../servers/shared/fix-it/store.js");

function raw() { return new Database(CORE); }
function projectId() {
  const d = raw();
  try {
    const row = d.prepare("SELECT id FROM project_spaces LIMIT 1").get();
    return row ? row.id : Number(d.prepare("INSERT INTO project_spaces (name, slug, type) VALUES ('t', 't-hmac', 'data_connector')").run().lastInsertRowid);
  } finally { d.close(); }
}
function pendingRow(ref, approved = null) {
  const d = raw();
  try {
    return Number(d.prepare("INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status, approved_ref_sha256) VALUES (?, 'p', 'mcp_server', ?, 'pending_approval', ?)")
      .run(projectId(), ref, approved).lastInsertRowid);
  } finally { d.close(); }
}
function rowById(id) {
  const d = raw();
  try { return d.prepare("SELECT * FROM data_backends WHERE id = ?").get(id); } finally { d.close(); }
}
function markerRef(marker) {
  return JSON.stringify({ command: "node", args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] });
}

beforeEach(() => {
  const d = raw();
  try {
    d.prepare("DELETE FROM data_backends").run();
    d.prepare("DELETE FROM fix_it_items").run();
  } finally { d.close(); }
});

// ------------------------------------------------------------------ the key file

test("the approval key is 32 bytes, 0600, in a 0700 secrets dir, and made once", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-keyhome-"));
  const key = ensureApprovalKey({ crowHome: home });
  assert.equal(key.length, APPROVAL_KEY_BYTES);
  const path = approvalKeyPath(home);
  assert.equal(path, join(home, "secrets", "data-backend-approval.key"));
  assert.equal(statSync(path).mode & 0o777, 0o600, "key file mode");
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700, "secrets dir mode");
  assert.deepEqual(ensureApprovalKey({ crowHome: home }), key, "a second call returns the same bytes");
  assert.deepEqual(readApprovalKey({ crowHome: home }), key);
  // A file that is not a key reads as no key (never throws).
  writeFileSync(path, "short");
  assert.equal(readApprovalKey({ crowHome: home }), null);
  rmSync(home, { recursive: true, force: true });
});

test("the check path never creates a key: a missing key means no approval is valid", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-nokey-"));
  const ref = markerRef(join(home, "never"));
  const row = { connection_ref: ref, approved_ref_sha256: `hmac1:${"a".repeat(64)}` };
  assert.equal(isApproved(row, { crowHome: home }), false);
  assert.equal(prepareSpawn(row, undefined, { crowHome: home }).ok, false);
  assert.equal(existsSync(approvalKeyPath(home)), false, "a key was created on the check path");
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------- forged approvals

test("a row carrying the PLAIN approval hash is not approved, and is not started", async () => {
  ensureApprovalKey();  // this instance's key exists, so only the plain shape is at issue
  const marker = join(HOME, "plain-forged");
  const ref = markerRef(marker);
  const plain = approvalHash(ref);
  assert.match(plain, /^[0-9a-f]{64}$/);
  const row = { connection_ref: ref, approved_ref_sha256: plain };
  assert.equal(isApproved(row), false, "a plain hash is recomputable from the row");
  assert.equal(prepareSpawn(row).ok, false);
  assert.equal(isLegacyApproval(row), true);
  assert.equal(hasApproval(row), false);

  const id = pendingRow(ref, plain);
  await loadDynamicBackends();
  assert.equal(existsSync(marker), false, "a forged row was started");
  const after = rowById(id);
  assert.equal(after.status, "pending_approval");
  assert.equal(after.last_error, LEGACY_APPROVAL_MESSAGE);
  assert.equal(after.approved_ref_sha256, plain, "the old value is left as it is, never deleted");
});

test("an hmac1 value made with a DIFFERENT key is refused", async () => {
  const marker = join(HOME, "wrong-key");
  const ref = markerRef(marker);
  const realKey = ensureApprovalKey();  // this instance's key (CROW_HOME)
  const pin = approvalHash(ref);
  const forged = "hmac1:" + createHmac("sha256", Buffer.alloc(32, 7)).update(pin, "utf8").digest("hex");
  const row = { connection_ref: ref, approved_ref_sha256: forged };
  assert.ok(realKey, "the real key is on disk");
  assert.equal(isApproved(row), false);
  assert.equal(prepareSpawn(row).ok, false);
  // Shape-wise it looks like an approval: display says so, the check still says no.
  assert.equal(hasApproval(row), true);

  const id = pendingRow(ref, forged);
  await loadDynamicBackends();
  assert.equal(existsSync(marker), false, "a row forged with another key was started");
  assert.equal(rowById(id).status, "pending_approval");
});

test("approveBackend writes a keyed value; an edited command or pinned file voids it", async () => {
  const db = createDbClient(CORE);
  try {
    const marker = join(HOME, "approved-keyed");
    const ref = markerRef(marker);
    const id = pendingRow(ref);
    const r = await approveBackend(db, id);
    assert.equal(r.ok, true, r.reason);
    const stored = rowById(id).approved_ref_sha256;
    assert.match(stored, /^hmac1:[0-9a-f]{64}$/);
    assert.equal(stored.includes(approvalHash(ref)), false, "the plain hash is not part of the stored value");

    const row = rowById(id);
    assert.equal(isApproved(row), true);
    assert.equal(hasApproval(row), true);
    assert.equal(isLegacyApproval(row), false);
    assert.equal(prepareSpawn(row).ok, true);

    // A changed command line voids it.
    assert.equal(isApproved({ ...row, connection_ref: markerRef(join(HOME, "swapped")) }), false);

    // A changed pinned file voids it too.
    const script = join(HOME, "pinned-server.js");
    writeFileSync(script, "// original");
    const pinnedRef = JSON.stringify({ command: "node", args: [script] });
    const pinnedId = pendingRow(pinnedRef);
    assert.equal((await approveBackend(db, pinnedId)).ok, true);
    assert.equal(isApproved(rowById(pinnedId)), true, "positive control");
    writeFileSync(script, "// edited");
    assert.equal(isApproved(rowById(pinnedId)), false, "an edited pinned file kept the approval");
  } finally {
    db.close();
  }
});

test("approving refuses when the key cannot be created, and stores nothing", async () => {
  const db = createDbClient(CORE);
  const blocked = mkdtempSync(join(tmpdir(), "crow-badkeyhome-"));
  try {
    // secrets/ is a plain file: neither the dir nor the key can be made.
    writeFileSync(join(blocked, "secrets"), "x");
    const id = pendingRow(markerRef(join(HOME, "unapprovable")));
    const r = await approveBackend(db, id, undefined, { crowHome: blocked });
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not create its approval key; nothing was approved/);
    assert.equal(rowById(id).approved_ref_sha256, null);
  } finally {
    db.close();
    rmSync(blocked, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- shape helpers

test("hasApproval and isLegacyApproval only accept their own shape", () => {
  const plain = "a".repeat(64);
  const keyed = `hmac1:${"b".repeat(64)}`;
  assert.equal(hasApproval({ approved_ref_sha256: keyed }), true);
  assert.equal(hasApproval({ approved_ref_sha256: plain }), false);
  assert.equal(hasApproval({ approved_ref_sha256: null }), false);
  assert.equal(hasApproval({ approved_ref_sha256: `hmac1:${"B".repeat(64)}` }), false);
  assert.equal(hasApproval(null), false);
  assert.equal(isLegacyApproval({ approved_ref_sha256: plain }), true);
  assert.equal(isLegacyApproval({ approved_ref_sha256: keyed }), false);
  assert.equal(isLegacyApproval({ approved_ref_sha256: null }), false);
  assert.equal(isLegacyApproval({}), false);
});

// ------------------------------------------------------------------ fix-it card

const detector = (await import("../servers/gateway/fix-it/detectors/data-backend-reapproval.js")).default;

test("fix-it: the re-approval check runs through the gateway's boot checks", async () => {
  const { BOOT_CHECK_DETECTORS } = await import("../servers/gateway/fix-it/index.js");
  assert.ok(BOOT_CHECK_DETECTORS.some((d) => d.source === "data-backend-reapproval"));
});

function boundStore(db) {
  return {
    db,
    upsertItem: (item) => fixitStore.upsertItem(db, item),
    resolveByKey: (source, key) => fixitStore.resolveByKey(db, source, key),
  };
}

test("fix-it: one card counting the legacy approvals, and none for keyed rows", async () => {
  const db = createDbClient(CORE);
  try {
    const store = boundStore(db);
    assert.equal(await detector.check(store), null, "nothing legacy: no card");
    assert.deepEqual(await fixitStore.listPending(db), []);

    const legacyRef = markerRef(join(HOME, "legacy-a"));
    pendingRow(legacyRef, approvalHash(legacyRef));
    const legacyRef2 = markerRef(join(HOME, "legacy-b"));
    pendingRow(legacyRef2, approvalHash(legacyRef2));
    const keyedId = pendingRow(markerRef(join(HOME, "keyed")));
    assert.equal((await approveBackend(db, keyedId)).ok, true);

    await detector.check(store);
    const pending = await fixitStore.listPending(db);
    assert.equal(pending.length, 1, "one card, however many rows");
    assert.equal(pending[0].title, "Data backends need approving again");
    assert.match(pending[0].why, /^2 data backend\(s\) were approved before Crow protected approvals/);
    assert.match(pending[0].why, /Projects page/);
    assert.ok((pending[0].remedies || []).some((r) => r.href === "/dashboard/projects"), "the card links to the Projects page");

    // Answered: the card resolves itself.
    const d = raw();
    d.prepare("UPDATE data_backends SET approved_ref_sha256 = NULL WHERE id IN (?, ?)").run(
      rowByRefId(legacyRef), rowByRefId(legacyRef2));
    d.close();
    assert.equal(await detector.check(store), null);
    assert.deepEqual(await fixitStore.listPending(db), []);
  } finally {
    db.close();
  }
});

function rowByRefId(ref) {
  const d = raw();
  try { return d.prepare("SELECT id FROM data_backends WHERE connection_ref = ?").get(ref).id; } finally { d.close(); }
}

// --------------------------------------------------------------- Projects page

test("Projects page: a legacy row shows the re-approve sentence and the Approve button", async () => {
  const { renderBackendApproval } = await import("../servers/gateway/dashboard/panels/projects.js");
  const ref = JSON.stringify({ command: "node", args: ["s.js"] });
  const html = renderBackendApproval(1, {
    id: 5, backend_type: "mcp_server", connection_ref: ref, approved_ref_sha256: "a".repeat(64),
  });
  const escaped = LEGACY_APPROVAL_MESSAGE.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  assert.ok(html.includes(escaped), "the re-approve sentence is missing");
  assert.match(html, /name="action" value="approve_backend"/);
  assert.doesNotMatch(html, /name="action" value="revoke_backend"/);

  const keyed = renderBackendApproval(1, {
    id: 6, backend_type: "mcp_server", connection_ref: ref, approved_ref_sha256: `hmac1:${"b".repeat(64)}`,
  });
  assert.equal(keyed.includes(escaped), false, "a keyed approval is not shown as legacy");
  assert.match(keyed, /name="action" value="revoke_backend"/);

  const never = renderBackendApproval(1, { id: 7, backend_type: "mcp_server", connection_ref: ref, approved_ref_sha256: null });
  assert.equal(never.includes(escaped), false);
});