/**
 * getOrCreateLocalInstanceId (servers/gateway/instance-registry.js) when
 * `<data dir>/instance-id` EXISTS but cannot be read. Inside an add-on wall that
 * path is a masked /dev/null char device: existsSync() is true and
 * readFileSync() throws EACCES. The old code swallowed that and minted a random
 * id per call, so every per-instance setting (dashboard_settings_overrides is
 * keyed by (key, instance_id)) read as unset and every write added a junk row.
 *
 * A DIRECTORY named instance-id is the portable way to make readFileSync throw
 * (EISDIR) without depending on uid 0 or a bwrap build, and a walled child's
 * masked file is the same shape from this function's point of view: present,
 * unreadable. Each test points CROW_DATA_DIR at its own scratch dir, so the
 * module's per-process state cannot leak between them.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imported once: every path it resolves is read from process.env at CALL time.
const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");

/** A real instance id (32 hex, as generateInstanceId makes). */
const REAL_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

const SAVED = {
  CROW_HOME: process.env.CROW_HOME,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_LOCAL_INSTANCE_ID: process.env.CROW_LOCAL_INSTANCE_ID,
};
const roots = [];

/** A scratch data dir; `file` writes an instance-id, `unreadable` makes it a directory. */
function dataDir({ file = null, unreadable = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-instance-id-"));
  roots.push(dir);
  process.env.CROW_HOME = join(dir, "home");
  process.env.CROW_DATA_DIR = dir;
  if (unreadable) mkdirSync(join(dir, "instance-id"));
  else if (file !== null) writeFileSync(join(dir, "instance-id"), file);
  return dir;
}

function setEnvId(id) {
  if (id === undefined) delete process.env.CROW_LOCAL_INSTANCE_ID;
  else process.env.CROW_LOCAL_INSTANCE_ID = id;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setEnvId(SAVED.CROW_LOCAL_INSTANCE_ID);
});

test("a readable file is returned, trimmed, and an env id never overrides it", () => {
  dataDir({ file: `  ${REAL_ID}\n` });
  setEnvId(OTHER_ID);
  assert.equal(getOrCreateLocalInstanceId(), REAL_ID);
});

test("an unreadable file with a valid CROW_LOCAL_INSTANCE_ID returns that id and writes nothing", () => {
  const dir = dataDir({ unreadable: true });
  setEnvId(REAL_ID);
  assert.equal(getOrCreateLocalInstanceId(), REAL_ID);
  assert.equal(getOrCreateLocalInstanceId(), REAL_ID, "stable across calls");
  // Nothing was minted or persisted anywhere: the masked path is still a directory, empty.
  assert.deepEqual(readdirSync(dir), ["instance-id"]);
  assert.equal(statSync(join(dir, "instance-id")).isDirectory(), true);
  assert.deepEqual(readdirSync(join(dir, "instance-id")), []);
});

test("an unreadable file with no env id throws INSTANCE_ID_UNREADABLE, every time, and mints nothing", () => {
  const dir = dataDir({ unreadable: true });
  setEnvId(undefined);
  for (const attempt of [1, 2]) {
    assert.throws(() => getOrCreateLocalInstanceId(), (err) => {
      assert.equal(err.code, "INSTANCE_ID_UNREADABLE", `attempt ${attempt}`);
      assert.match(err.message, /refusing to invent one/);
      return true;
    });
  }
  assert.deepEqual(readdirSync(dir), ["instance-id"], "no file and no cached id was created");
  assert.deepEqual(readdirSync(join(dir, "instance-id")), []);
});

test("an unreadable file with a wrong-shaped env id throws: uppercase, short, long, path traversal, non-hex", () => {
  dataDir({ unreadable: true });
  const wrong = [
    REAL_ID.toUpperCase(),
    REAL_ID.slice(0, 31),
    `${REAL_ID}a`,
    `../../${REAL_ID}`,
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    "",
  ];
  for (const value of wrong) {
    setEnvId(value);
    assert.throws(() => getOrCreateLocalInstanceId(), { code: "INSTANCE_ID_UNREADABLE" }, JSON.stringify(value));
  }
  setEnvId(`  ${REAL_ID}  `);
  assert.equal(getOrCreateLocalInstanceId(), REAL_ID, "surrounding whitespace is not a wrong shape");
});

test("an empty file counts as unreadable: the env id is used, else it throws", () => {
  dataDir({ file: "   \n" });
  assert.throws(() => getOrCreateLocalInstanceId(), { code: "INSTANCE_ID_UNREADABLE" });
  setEnvId(REAL_ID);
  assert.equal(getOrCreateLocalInstanceId(), REAL_ID);
});

test("a missing file keeps the first-boot behaviour: mint a 32-hex id and persist it (the env id does not decide it)", () => {
  const dir = dataDir();
  setEnvId(OTHER_ID);
  const id = getOrCreateLocalInstanceId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(id, OTHER_ID, "the file, not the env, is the identity of a first boot");
  assert.equal(readFileSync(join(dir, "instance-id"), "utf8"), id, "the minted id is persisted");
  assert.equal(getOrCreateLocalInstanceId(), id, "and read back from the file afterwards");
});