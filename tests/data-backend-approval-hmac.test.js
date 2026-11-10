/**
 * Keyed data-backend approvals (security audit N1b-11).
 *
 * An `mcp_server` data backend is a command the gateway runs. Its owner approval
 * used to be a plain SHA-256 kept in the SAME crow.db row, so anything that can
 * write crow.db could compute it and plant an "approved" row. The stored value is
 * now `hmac1:<hex>`: an HMAC over that same hash plus the row's id and a nonce
 * kept beside the key in `<CROW_HOME>/secrets/` — files a crow.db writer cannot
 * read or forge. The nonce is what binds a value to one row and makes a revoked
 * one useless if it is ever written back.
 *
 * Everything runs in a scratch HOME / data dir set BEFORE any app import.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  approveBackend, revokeBackendApproval, approvalHash, prepareSpawn, isApproved, hasApproval, isLegacyApproval,
  approvalNotFromThisMachine, approvalForAnotherBackend, LEGACY_APPROVAL_MESSAGE, MACHINE_APPROVAL_MESSAGE,
  NOT_FOR_THIS_BACKEND_MESSAGE, REVOKE_PARTIAL_MESSAGE,
} = await import("../servers/shared/data-backend-approval.js");
const {
  approvalKeyPath, approvalRecordPath, ensureApprovalKey, readApprovalKey, approvalNonce, setApprovalNonce,
  clearApprovalNonce, pruneApprovalNonces, APPROVAL_KEY_BYTES,
} = await import("../servers/shared/data-backend-approval-key.js");
const { createDbClient } = await import("../servers/db.js");
const { loadDynamicBackends } = await import("../servers/gateway/proxy.js");
const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
const { deleteProject } = await import("../servers/shared/project-lifecycle.js");
const { createProjectServer } = await import("../servers/research/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const fixitStore = await import("../servers/shared/fix-it/store.js");
const { renderFixItCards, LINK_REMEDIES } = await import("../servers/gateway/fix-it/index.js");

function raw() { return new Database(CORE); }
function projectId() {
  const d = raw();
  try {
    const row = d.prepare("SELECT id FROM project_spaces LIMIT 1").get();
    return row ? row.id : Number(d.prepare("INSERT INTO project_spaces (name, slug, type) VALUES ('t', 't-hmac', 'data_connector')").run().lastInsertRowid);
  } finally { d.close(); }
}
function pendingRow(ref, approved = null, project = projectId()) {
  const d = raw();
  try {
    return Number(d.prepare("INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status, approved_ref_sha256) VALUES (?, 'p', 'mcp_server', ?, 'pending_approval', ?)")
      .run(project, ref, approved).lastInsertRowid);
  } finally { d.close(); }
}
/** Put a row back with an explicit id (what a crow.db writer can do after a delete). */
function putBackRow(id, project, ref, approved) {
  const d = raw();
  try {
    d.prepare("INSERT INTO data_backends (id, project_id, name, backend_type, connection_ref, status, approved_ref_sha256) VALUES (?, ?, 'put back', 'mcp_server', ?, 'pending_approval', ?)")
      .run(id, project, ref, approved);
  } finally { d.close(); }
}
const text = (r) => (r.content || []).map((c) => c.text).join("\n");
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
  // The per-row nonce record outlives rows on purpose; sqlite reuses ids after
  // a delete, so each test starts from no nonces.
  rmSync(approvalRecordPath(CROW_HOME), { force: true });
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

test("a 0-byte key file (a crash between create and write) is replaced on the next approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-emptykey-"));
  const db = createDbClient(CORE);
  try {
    const path = approvalKeyPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.equal(statSync(path).size, 0);
    assert.equal(readApprovalKey({ crowHome: home }), null, "0 bytes is not a key");

    // Approving is what replaces it: the empty file is not a key, so the owner
    // must not be stuck forever after a crash.
    const rowId = pendingRow(markerRef(join(HOME, "after-crash")));
    assert.equal((await approveBackend(db, rowId, undefined, { crowHome: home })).ok, true);
    assert.equal(statSync(path).size, APPROVAL_KEY_BYTES, "the empty key file was not replaced");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readApprovalKey({ crowHome: home }), ensureApprovalKey({ crowHome: home }));
    assert.equal(isApproved(rowById(rowId), { crowHome: home }), true, "the approval replaced the key but does not verify under it");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a key file of the wrong length is refused, never overwritten, and approve stores nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-shortkey-"));
  const path = approvalKeyPath(home);
  const db = createDbClient(CORE);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "k".repeat(31), { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.equal(readApprovalKey({ crowHome: home }), null);
    assert.throws(() => ensureApprovalKey({ crowHome: home }), /does not hold a key/);
    assert.equal(statSync(path).size, 31, "a non-empty key file was overwritten");

    const id = pendingRow(markerRef(join(HOME, "wrong-key-length")));
    const r = await approveBackend(db, id, undefined, { crowHome: home });
    assert.equal(r.ok, false);
    assert.equal(rowById(id).approved_ref_sha256, null, "a row was approved under an unusable key");
    assert.equal(statSync(path).size, 31, "a refused approval rewrote the key file");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent ensureApprovalKey calls agree on one key", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-keyrace-"));
  try {
    const path = approvalKeyPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // The crash leftover, which each racing process also finds and replaces.
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
    const moduleUrl = pathToFileURL(join(ROOT, "servers/shared/data-backend-approval-key.js")).href;
    const code = `const m = await import(${JSON.stringify(moduleUrl)});`
      + `process.stdout.write(m.ensureApprovalKey({ crowHome: ${JSON.stringify(home)} }).toString("hex"));`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let why = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { why += d; });
      child.on("error", reject);
      child.on("close", (exitCode) => (exitCode === 0
        ? resolve(out)
        : reject(new Error(`a racing ensureApprovalKey failed (${exitCode}): ${why.slice(0, 300)}`))));
    });
    const keys = await Promise.all([run(), run(), run(), run()]);
    assert.equal(new Set(keys).size, 1, "the racing processes minted different keys");
    assert.equal(keys[0].length, APPROVAL_KEY_BYTES * 2);
    assert.equal(readApprovalKey({ crowHome: home }).toString("hex"), keys[0], "the key on disk is not the one returned");
    assert.equal(statSync(path).size, APPROVAL_KEY_BYTES);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("concurrent ensureApprovalKey calls agree on one key, with or without an empty leftover, every time", async () => {
  const moduleUrl = pathToFileURL(join(ROOT, "servers/shared/data-backend-approval-key.js")).href;
  for (let round = 0; round < 8; round++) {
    const home = mkdtempSync(join(tmpdir(), "crow-keyrace2-"));
    try {
      const path = approvalKeyPath(home);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (round % 2 === 0) { writeFileSync(path, "", { mode: 0o600 }); chmodSync(path, 0o600); }
      const code = `const m = await import(${JSON.stringify(moduleUrl)});`
        + `process.stdout.write(m.ensureApprovalKey({ crowHome: ${JSON.stringify(home)} }).toString("hex"));`;
      const run = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        let out = ""; let why = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { why += d; });
        child.on("error", reject);
        child.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`racer failed (${c}): ${why.slice(0, 300)}`))));
      });
      const keys = await Promise.all([run(), run(), run(), run(), run(), run()]);
      assert.equal(new Set(keys).size, 1, `round ${round}: the racing processes minted different keys`);
      assert.equal(readApprovalKey({ crowHome: home }).toString("hex"), keys[0], `round ${round}: the key on disk is not the one returned`);
      assert.equal(existsSync(`${path}.lock`), false, `round ${round}: the lock was left behind`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test("a lock left by a dead holder is taken over once it is stale, and a fresh one is waited on", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-keylock-"));
  try {
    const path = approvalKeyPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    const key = ensureApprovalKey({ crowHome: home });
    assert.equal(key.length, APPROVAL_KEY_BYTES);
    assert.equal(existsSync(`${path}.lock`), false, "the stale lock was not cleared");
    assert.equal(readApprovalKey({ crowHome: home }).toString("hex"), key.toString("hex"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a key file another principal can read is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-loosekey-"));
  const path = approvalKeyPath(home);
  const db = createDbClient(CORE);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.alloc(APPROVAL_KEY_BYTES, 3), { mode: 0o644 });
    chmodSync(path, 0o644);
    assert.equal(readApprovalKey({ crowHome: home }), null, "a group/world-readable key was used");
    assert.throws(() => ensureApprovalKey({ crowHome: home }), /mode 600/);
    assert.equal(statSync(path).mode & 0o777, 0o644, "a loose key file was replaced instead of refused");

    const id = pendingRow(markerRef(join(HOME, "loose-key")));
    assert.equal((await approveBackend(db, id, undefined, { crowHome: home })).ok, false);
    assert.equal(rowById(id).approved_ref_sha256, null);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
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

test("a revoked approval's old value is not accepted when it is written back", async () => {
  const db = createDbClient(CORE);
  try {
    const marker = join(HOME, "revoked-replay");
    const ref = markerRef(marker);
    const id = pendingRow(ref);
    assert.equal((await approveBackend(db, id)).ok, true);
    const old = rowById(id).approved_ref_sha256;
    assert.equal(isApproved(rowById(id)), true, "positive control");

    assert.equal(await revokeBackendApproval(db, id), true);
    assert.equal(rowById(id).approved_ref_sha256, null);
    assert.equal(approvalNonce(id), null, "the revoke kept the row's nonce on record");

    // Anyone who saw the old value writes it back into the column.
    const d = raw();
    d.prepare("UPDATE data_backends SET approved_ref_sha256 = ?, status = 'pending_approval' WHERE id = ?").run(old, id);
    d.close();
    assert.equal(isApproved(rowById(id)), false, "a revoked value was accepted again");
    assert.equal(approvalNotFromThisMachine(rowById(id)), true);
    assert.equal(prepareSpawn(rowById(id)).ok, false);

    await loadDynamicBackends();
    assert.equal(existsSync(marker), false, "a revoked backend was started again");
    assert.equal(rowById(id).status, "pending_approval");
  } finally {
    db.close();
  }
});

test("an approval copied onto another row with the same connection_ref is not accepted", async () => {
  const db = createDbClient(CORE);
  try {
    const ref = markerRef(join(HOME, "copied-approval"));
    const first = pendingRow(ref);
    assert.equal((await approveBackend(db, first)).ok, true);
    const value = rowById(first).approved_ref_sha256;
    const second = pendingRow(ref, value);
    assert.equal(isApproved(rowById(second)), false, "a copied approval was accepted on another row");
    assert.equal(approvalNotFromThisMachine(rowById(second)), true);
    assert.equal(prepareSpawn(rowById(second)).ok, false);
    assert.equal(isApproved(rowById(first)), true, "positive control: the row it was made for");
  } finally {
    db.close();
  }
});

test("re-approving writes a fresh nonce, so only the latest value verifies", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "reapproved")));
    assert.equal((await approveBackend(db, id)).ok, true);
    const before = rowById(id).approved_ref_sha256;
    const nonceBefore = approvalNonce(id);
    assert.equal((await approveBackend(db, id)).ok, true);
    const after = rowById(id).approved_ref_sha256;
    const nonceAfter = approvalNonce(id);
    assert.notEqual(nonceBefore, nonceAfter, "the re-approval reused the nonce");
    assert.notEqual(before, after);
    assert.equal(isApproved(rowById(id)), true);
    assert.equal(isApproved({ ...rowById(id), approved_ref_sha256: before }), false, "the value from before the re-approval was accepted");
  } finally {
    db.close();
  }
});

test("the approval record is 0600, one nonce per row, and a missing record approves nothing", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "record-missing")));
    assert.equal((await approveBackend(db, id)).ok, true);
    const path = approvalRecordPath(CROW_HOME);
    assert.equal(statSync(path).mode & 0o777, 0o600, "record mode");
    const rec = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(rec.v, 1);
    assert.deepEqual(Object.keys(rec.rows), [String(id)]);
    assert.match(rec.rows[String(id)], /^[0-9a-f]{32}$/);
    assert.equal(isApproved(rowById(id)), true, "positive control");

    rmSync(path);
    assert.equal(approvalNonce(id), null);
    assert.equal(isApproved(rowById(id)), false, "a missing record still approved the row");
    assert.equal(approvalNotFromThisMachine(rowById(id)), true);
    assert.equal(prepareSpawn(rowById(id)).ok, false);
  } finally {
    db.close();
  }
});

test("a record another principal can rewrite approves nothing", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "record-loose")));
    assert.equal((await approveBackend(db, id)).ok, true);
    assert.equal(isApproved(rowById(id)), true, "positive control");
    const path = approvalRecordPath(CROW_HOME);
    chmodSync(path, 0o644);
    assert.equal(isApproved(rowById(id)), false, "a group/world-writable record was trusted");
    assert.equal(approvalNotFromThisMachine(rowById(id)), true);
  } finally {
    db.close();
  }
});

test("setApprovalNonce replaces a row's nonce and clearApprovalNonce drops it", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-records-"));
  try {
    await setApprovalNonce(7, "a".repeat(32), { crowHome: home });
    await setApprovalNonce(8, "b".repeat(32), { crowHome: home });
    assert.equal(approvalNonce(7, { crowHome: home }), "a".repeat(32));
    await setApprovalNonce(7, "c".repeat(32), { crowHome: home });
    assert.equal(approvalNonce(7, { crowHome: home }), "c".repeat(32));
    assert.equal(approvalNonce(8, { crowHome: home }), "b".repeat(32), "another row's nonce was lost");
    await setApprovalNonce(7, "not-hex", { crowHome: home }).then(
      () => assert.fail("a malformed nonce was stored"),
      () => {});
    await clearApprovalNonce(7, { crowHome: home });
    assert.equal(approvalNonce(7, { crowHome: home }), null);
    assert.equal(approvalNonce(8, { crowHome: home }), "b".repeat(32));
    assert.equal(statSync(approvalRecordPath(home)).mode & 0o777, 0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
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

// ------------------------------------- a deleted backend's approval cannot come back
test("a backend removed through the MCP tool cannot be approved again by putting the row back", async () => {
  const db = createDbClient(CORE);
  try {
    const { id: pid } = await createProjectSpace(db, { name: "Remove backend" });
    const ref = markerRef(join(HOME, "removed-tool"));
    const id = pendingRow(ref, null, pid);
    assert.equal((await approveBackend(db, id)).ok, true);
    const old = rowById(id).approved_ref_sha256;
    assert.match(String(old), /^hmac1:/);
    assert.equal(isApproved(rowById(id)), true, "positive control");
    assert.notEqual(approvalNonce(id), null, "positive control: the nonce is on record");

    // The real tool: preview, then the token it returned.
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createProjectServer(CORE).connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const preview = text(await client.callTool({ name: "crow_remove_backend", arguments: { id, confirm_token: "" } }));
    const token = /confirm_token: "([^"]+)"/.exec(preview)?.[1];
    assert.ok(token, preview);
    const done = text(await client.callTool({ name: "crow_remove_backend", arguments: { id, confirm_token: token } }));
    assert.match(done, /removed/i, done);
    assert.equal(rowById(id), undefined, "the row was not deleted");
    assert.equal(approvalNonce(id), null, "the removed backend's nonce is still on record");

    // A crow.db writer puts the row back with its old id, its exact connection_ref
    // and the value that was approved: SQLite accepts an explicit id.
    putBackRow(id, pid, ref, old);
    assert.equal(isApproved(rowById(id)), false, "a deleted backend's old approval verified again");
    assert.equal(prepareSpawn(rowById(id)).ok, false);
  } finally { db.close(); }
});

test("a project delete drops its backends' nonces, so a row put back does not verify", async () => {
  const db = createDbClient(CORE);
  try {
    const { id: pid } = await createProjectSpace(db, { name: "Delete backend project" });
    const ref = markerRef(join(HOME, "deleted-project"));
    const id = pendingRow(ref, null, pid);
    assert.equal((await approveBackend(db, id)).ok, true);
    const old = rowById(id).approved_ref_sha256;
    assert.equal(isApproved(rowById(id)), true, "positive control");

    const r = await deleteProject(db, pid, { confirmName: "Delete backend project", disconnectBackend: () => true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(rowById(id), undefined, "the project's backends were not deleted");
    assert.equal(approvalNonce(id), null, "the deleted backend's nonce is still on record");

    putBackRow(id, pid, ref, old);
    assert.equal(isApproved(rowById(id)), false, "a deleted project's backend approval verified again");
    assert.equal(prepareSpawn(rowById(id)).ok, false);
  } finally { db.close(); }
});

test("a record entry for a row that no longer exists is pruned when the gateway loads", async () => {
  await setApprovalNonce(4242, "c".repeat(32));
  await setApprovalNonce(4243, "d".repeat(32));
  const path = approvalRecordPath(CROW_HOME);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).rows).sort(), ["4242", "4243"]);

  // No rows at all in the table: every entry is stale, and the load drops them.
  await loadDynamicBackends();
  assert.equal(approvalNonce(4242), null, "a stale record entry survived the load");
  assert.equal(approvalNonce(4243), null);

  // Nothing stale now: a second load does not rewrite the record.
  const settled = readFileSync(path, "utf8");
  await loadDynamicBackends();
  assert.equal(readFileSync(path, "utf8"), settled, "a load with nothing stale rewrote the record");
});

test("the prune keeps the nonce of a row that still exists", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "kept-nonce")));
    assert.equal((await approveBackend(db, id)).ok, true);
    await setApprovalNonce(4244, "e".repeat(32));
    await loadDynamicBackends();
    assert.notEqual(approvalNonce(id), null, "a live row's nonce was pruned");
    assert.equal(approvalNonce(4244), null);
    assert.equal(await pruneApprovalNonces([id]), 0, "nothing is stale now");
  } finally { db.close(); }
});

// --------------------------------------------------- a revoke that cannot update the record
test("a revoke whose record write fails still clears the column, says so, and reports partial", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "revoke-partial")));
    assert.equal((await approveBackend(db, id)).ok, true);
    const nonce = approvalNonce(id);
    const old = rowById(id).approved_ref_sha256;

    const r = await revokeBackendApproval(db, id, { clearNonce: async () => { throw new Error("record write refused"); } });
    assert.equal(r.ok, true);
    assert.equal(r.partial, true);
    const row = rowById(id);
    assert.equal(row.approved_ref_sha256, null, "the column kept an approval the owner just stopped");
    assert.equal(row.status, "pending_approval");
    assert.equal(row.last_error, REVOKE_PARTIAL_MESSAGE, "the row does not say the stop is not permanent");

    // Why it is not permanent: the nonce is still on record, so a value put back verifies again.
    assert.equal(approvalNonce(id), nonce);
    const d = raw();
    d.prepare("UPDATE data_backends SET approved_ref_sha256 = ? WHERE id = ?").run(old, id);
    d.close();
    assert.equal(isApproved(rowById(id)), true, "the partial stop was described as permanent, but it is not");
  } finally { db.close(); }
});

test("a revoke with a working record write returns true and leaves no partial flag", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "revoke-clean")));
    assert.equal((await approveBackend(db, id)).ok, true);
    assert.equal(await revokeBackendApproval(db, id), true);
    assert.equal(rowById(id).last_error, null, "a clean stop wrote the partial sentence");
    assert.equal(approvalNonce(id), null);
  } finally { db.close(); }
});

test("the revoke clears the nonce again AFTER the column write", async () => {
  const db = createDbClient(CORE);
  try {
    const id = pendingRow(markerRef(join(HOME, "revoke-twice")));
    assert.equal((await approveBackend(db, id)).ok, true);
    // The seam records what the column held at the moment each clear ran.
    const seen = [];
    const clearNonce = async (rowId, opts) => {
      seen.push(rowById(id).approved_ref_sha256);
      await clearApprovalNonce(rowId, opts);
    };
    assert.equal(await revokeBackendApproval(db, id, { clearNonce }), true);
    assert.equal(seen.length, 2, "the nonce was not cleared again after the column write");
    assert.match(String(seen[0]), /^hmac1:/, "the first clear ran after the column was already empty");
    assert.equal(seen[1], null, "the second clear ran before the column write");
    assert.equal(approvalNonce(id), null);
  } finally { db.close(); }
});

test("Projects page: a stop that could not update the record shows the sentence", async () => {
  const panel = (await import("../servers/gateway/dashboard/panels/projects.js")).default;
  const db = createDbClient(CORE);
  try {
    const { id: pid } = await createProjectSpace(db, { name: "Stop partial" });
    const layout = ({ content }) => content;
    const res = { redirectAfterPost: (url) => ({ redirect: url }) };
    const get = (query) => panel.handler({ method: "GET", query, body: {}, csrfToken: "" }, res, { db, layout, lang: "en" });
    const html = String(await get({ view: String(pid), error: "backend_stop_partial" }));
    assert.ok(html.includes(REVOKE_PARTIAL_MESSAGE), "the page does not show why the stop is not permanent");
    assert.equal(String(await get({ view: String(pid) })).includes(REVOKE_PARTIAL_MESSAGE), false, "the sentence shows without the partial stop");
  } finally { db.close(); }
});

// ------------------------------------------------- which sentence a failed check gets
test("a value made for another row says so; an empty record keeps the restore sentence", async () => {
  const db = createDbClient(CORE);
  try {
    // A row that really was approved here (so the record holds a nonce), taken back out of
    // the column so nothing is started, and its value copied onto a second, never-approved row.
    const ref = markerRef(join(HOME, "copied-wording"));
    const owner = pendingRow(ref);
    assert.equal((await approveBackend(db, owner)).ok, true);
    const value = rowById(owner).approved_ref_sha256;
    const d = raw();
    d.prepare("UPDATE data_backends SET approved_ref_sha256 = NULL WHERE id = ?").run(owner);
    d.close();
    const copy = pendingRow(ref, value);
    assert.equal(approvalForAnotherBackend(rowById(copy)), true);
    assert.equal(approvalNotFromThisMachine(rowById(copy)), true, "the copied value is also one this row does not own");

    await loadDynamicBackends();
    const copied = rowById(copy);
    assert.equal(copied.status, "pending_approval");
    assert.equal(copied.last_error, NOT_FOR_THIS_BACKEND_MESSAGE, "a copied value was described as a restore");
    const html = (await import("../servers/gateway/dashboard/panels/projects.js")).renderBackendApproval(1, copied);
    assert.ok(html.includes(NOT_FOR_THIS_BACKEND_MESSAGE), "the page does not say the value was made for another backend");
    assert.equal(html.includes(MACHINE_APPROVAL_MESSAGE), false);

    // The restore case: an approved row whose record (secrets/) did not come along.
    const restored = pendingRow(markerRef(join(HOME, "restored-wording")));
    assert.equal((await approveBackend(db, restored)).ok, true);
    rmSync(approvalRecordPath(CROW_HOME), { force: true });
    await loadDynamicBackends();
    assert.equal(rowById(restored).last_error, MACHINE_APPROVAL_MESSAGE, "an empty record lost the restore sentence");
    assert.equal(approvalForAnotherBackend(rowById(restored)), false, "an empty record is not another row's value");
  } finally { db.close(); }
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
    assert.ok((pending[0].remedies || []).some((r) => r.kind === "link"), "the card has a link remedy");
    assert.equal((pending[0].remedies || [])[0].href, undefined, "a link target must never be stored in the row");
    assert.equal(LINK_REMEDIES[(pending[0].remedies || [])[0].actionId], "/dashboard/projects", "the card links to the Projects page");

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
  // A keyed value needs its row's nonce on record before this machine can call
  // it approved; nothing in this render re-hashes the pinned files.
  assert.match(keyed, /name="action" value="approve_backend"/, "a value this machine cannot check is not 'approved'");
  await setApprovalNonce(6, "e".repeat(32));
  const keyedHere = renderBackendApproval(1, {
    id: 6, backend_type: "mcp_server", connection_ref: ref, approved_ref_sha256: `hmac1:${"b".repeat(64)}`,
  });
  assert.match(keyedHere, /name="action" value="revoke_backend"/);

  const never = renderBackendApproval(1, { id: 7, backend_type: "mcp_server", connection_ref: ref, approved_ref_sha256: null });
  assert.equal(never.includes(escaped), false);
});

// ------------------------------------------------------- Fix-it link targets
test("fix-it: a stored href is never rendered; a link's target is held in code", async () => {
  const db = createDbClient(CORE);
  try {
    const stored = ["/\\evil.example", "/\t/evil.example", "https://x"];
    for (const [i, href] of stored.entries()) {
      await fixitStore.upsertItem(db, {
        source: "test-link", dedupKey: `unknown-${i}`, title: "A card", severity: "warn",
        remedies: [{ actionId: "not-a-remedy", kind: "link", label: "Open", href }],
      });
    }
    const unknown = await renderFixItCards(db, { req: {} });
    assert.equal(unknown.includes("evil.example"), false, "a stored href reached the page");
    assert.equal(unknown.includes("https://x"), false, "a stored href reached the page");
    assert.equal(unknown.includes("data-fixit-link"), false, "an unknown actionId rendered a link");

    // The registered actionId renders the path from LINK_REMEDIES, whatever href is stored.
    const { default: projectsPanel } = await import("../servers/gateway/dashboard/panels/projects.js");
    assert.equal(LINK_REMEDIES["open-projects-page"], projectsPanel.route, "the code-held link must be the Projects page route");
    await fixitStore.upsertItem(db, {
      source: "test-link", dedupKey: "known", title: "Another card", severity: "warn",
      remedies: [{ actionId: "open-projects-page", kind: "link", label: "Open the Projects page", href: "/\\evil.example" }],
    });
    const known = await renderFixItCards(db, { req: {} });
    assert.ok(known.includes(`href="${projectsPanel.route}"`), "the code-held target is missing");
    assert.equal(known.includes("evil.example"), false, "a stored href reached the page");
  } finally {
    db.close();
  }
});

test("fix-it: an approval re-runs the re-approval check, so its card clears without a restart", async () => {
  const { refreshReapprovalCard } = await import("../servers/gateway/dashboard/panels/projects.js");
  const db = createDbClient(CORE);
  try {
    const legacyRef = markerRef(join(HOME, "legacy-panel"));
    const id = pendingRow(legacyRef, approvalHash(legacyRef));
    await detector.check(boundStore(db));
    assert.equal((await fixitStore.listPending(db)).length, 1, "positive control: the card is up");
    assert.equal((await approveBackend(db, id)).ok, true);
    assert.equal((await fixitStore.listPending(db)).length, 1, "the card clears only when the check runs");
    await refreshReapprovalCard(db);
    assert.deepEqual(await fixitStore.listPending(db), [], "the card stayed up after the approval");

    const src = readFileSync(join(ROOT, "servers/gateway/dashboard/panels/projects.js"), "utf8");
    assert.match(src, /approveBackend\([\s\S]{0,500}?refreshReapprovalCard\(db\)/,
      "the approve handler never re-runs the re-approval check");
  } finally {
    db.close();
  }
});

// ---------------------------------------------- an approval from another machine
test("an approval this machine cannot check says so, in the row and on the page", async () => {
  const { renderBackendApproval } = await import("../servers/gateway/dashboard/panels/projects.js");
  const db = createDbClient(CORE);
  try {
    const marker = join(HOME, "restored-machine");
    const id = pendingRow(markerRef(marker));
    assert.equal((await approveBackend(db, id)).ok, true);
    // A restore: crow.db came over, secrets/ (the key and the nonce record) did not.
    rmSync(approvalRecordPath(CROW_HOME), { force: true });
    await loadDynamicBackends();
    assert.equal(existsSync(marker), false, "a row approved on another machine was started");

    const row = rowById(id);
    assert.equal(row.status, "pending_approval");
    assert.equal(row.last_error, MACHINE_APPROVAL_MESSAGE);

    const html = renderBackendApproval(1, row);
    assert.ok(html.includes(MACHINE_APPROVAL_MESSAGE), "the page does not say the approval is not from this machine");
    assert.equal(html.includes("Approved (checked again every time it starts)"), false, "the page still says Approved");
    assert.match(html, /name="action" value="approve_backend"/, "the page must offer the Approve button");
    assert.doesNotMatch(html, /name="action" value="revoke_backend"/);
  } finally {
    db.close();
  }
});