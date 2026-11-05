/**
 * N3-3: `instances.json` under the Crow home is PRIVATE (mode 0600).
 *
 * The audit found the file world-readable on a fresh install: the writer used a
 * plain writeFileSync, so the process umask (022 → 0644) decided its mode. The
 * file lists every same-machine instance's directory and gateway URL, so none of
 * it may be group/other readable — not even between create and chmod.
 *
 * Every writer path is covered (registration, revoke, the Data-hygiene repair and
 * its backup) plus the boot repair for installs that already carry a 0644 file.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, readFileSync, statSync, lstatSync, existsSync,
  chmodSync, symlinkSync, unlinkSync, readdirSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

// Scratch env BEFORE the import: instance-registry resolves every path at call
// time, but the suite's own seams must not be inherited here.
const ROOT = mkdtempSync(join(tmpdir(), "crow-instances-private-"));
process.env.CROW_HOME = join(ROOT, "home");
process.env.CROW_DATA_DIR = join(ROOT, "home", "data");
process.env.CROW_INSTANCES_JSON_PATH = join(ROOT, "home", "instances.json");
const HOME = process.env.CROW_HOME;
const DATA = process.env.CROW_DATA_DIR;
const INSTANCES = process.env.CROW_INSTANCES_JSON_PATH;

const {
  registerInstance, revokeInstance, removeStaleLocalInstances,
  tightenInstancesJsonPermissions, getOrCreateLocalInstanceId, ensureLocalInstanceRegistered,
} = await import("../servers/gateway/instance-registry.js");

after(() => rmScratch(ROOT));

const mode = (p) => statSync(p).mode & 0o777;
const read = (p = INSTANCES) => JSON.parse(readFileSync(p, "utf8"));
const fakeDb = (rows = []) => ({ execute: async () => ({ rows }) });

/** An install made before the private writer: a 0644 file, written plainly. */
function writeLegacyFile(obj) {
  mkdirSync(dirname(INSTANCES), { recursive: true });
  writeFileSync(INSTANCES, JSON.stringify(obj, null, 2));
  chmodSync(INSTANCES, 0o644);
  assert.equal(mode(INSTANCES), 0o644, "precondition: the legacy file is world-readable");
}

const ID_A = "a".repeat(32);

test("registration path: a fresh instances.json is created 0600, with no temp file left", async () => {
  if (existsSync(INSTANCES)) unlinkSync(INSTANCES);
  await registerInstance(fakeDb(), { id: ID_A, name: "alex:wt", directory: "/srv/wt-a", gatewayUrl: "http://100.64.20.5:3001" });

  assert.equal(mode(INSTANCES), 0o600, "a fresh install must not leave instances.json world-readable");
  assert.equal(read()[ID_A].name, "alex:wt");
  assert.deepEqual(readdirSync(dirname(INSTANCES)).filter((n) => n.includes(".tmp-")), [], "the temp file is renamed away");
});

test("registration path over a legacy 0644 file replaces it at 0600", async () => {
  writeLegacyFile({ [ID_A]: { name: "alex:wt", directory: "/srv/wt-a" } });
  await registerInstance(fakeDb(), { id: "b".repeat(32), name: "alex:wt-b", directory: "/srv/wt-b" });
  assert.equal(mode(INSTANCES), 0o600);
  assert.ok(read()["b".repeat(32)], "the rename replaced the file, not only its mode");
});

test("revoke path: removing the entry rewrites the file at 0600", async () => {
  writeLegacyFile({
    [ID_A]: { name: "alex:wt", directory: "/srv/wt-a" },
    ["c".repeat(32)]: { name: "peer", directory: "/srv/wt-c" },
  });
  await revokeInstance(fakeDb(), ID_A);
  const reg = read();
  assert.equal(reg[ID_A], undefined, "the revoked instance is gone from local discovery");
  assert.ok(reg["c".repeat(32)], "other entries survive");
  assert.equal(mode(INSTANCES), 0o600);
});

test("data-hygiene path: the rewritten file AND its backup are 0600", async () => {
  const junk = {};
  for (let i = 0; i < 3; i++) junk[`junk${i}`.padEnd(32, "0")] = { name: "crow:/nonexistent/wt", directory: "/nonexistent/wt" };
  const keep = { ["d".repeat(32)]: { name: "alex:keep", directory: "/nonexistent/keep-but-named" } };
  writeLegacyFile({ ...keep, ...junk });

  // `knownIds` answers the scan's SELECT id FROM crow_instances.
  const db = fakeDb([{ id: "d".repeat(32) }]);
  const dry = await removeStaleLocalInstances(db, { localId: null });
  assert.equal(dry.scan.candidates.length, 3);
  const out = await removeStaleLocalInstances(db, { confirm: true, expected: dry.scan.candidates.length, localId: null });
  assert.equal(out.removed, 3);
  assert.deepEqual(Object.keys(read()), ["d".repeat(32)]);
  assert.equal(mode(INSTANCES), 0o600);

  const backups = readdirSync(dirname(INSTANCES)).filter((n) => n.startsWith("instances.json.bak-hygiene-"));
  assert.equal(backups.length, 1, "the repair backs the file up first");
  assert.equal(mode(join(dirname(INSTANCES), backups[0])), 0o600, "the backup holds the same content, so it is private too");
});

test("boot repair: a pre-existing 0644 file is tightened to 0600 once, and says so", () => {
  writeLegacyFile({ [ID_A]: { name: "alex:wt", directory: "/srv/wt-a" } });
  const lines = [];
  assert.equal(tightenInstancesJsonPermissions({ log: (m) => lines.push(m) }), true);
  assert.equal(mode(INSTANCES), 0o600);
  assert.equal(lines.length, 1, "exactly one log line when it changes something");
  assert.match(lines[0], /tightened .*instances\.json to 0600 \(was 644\)/);
  assert.equal(tightenInstancesJsonPermissions({ log: (m) => lines.push(m) }), false, "already private → no-op");
  assert.equal(lines.length, 1, "no log line for a no-op");
});

test("boot wiring: ensureLocalInstanceRegistered tightens the file it is about to rewrite", async () => {
  const localId = getOrCreateLocalInstanceId();
  writeLegacyFile({ [localId]: { name: "alex:wt", directory: "/srv/wt-a" } });
  await ensureLocalInstanceRegistered(fakeDb([{ id: localId, name: "alex:wt", status: "active", trusted: 1, is_home: 0 }]), {});
  assert.equal(mode(INSTANCES), 0o600, "boot must not leave an upgraded install's file readable");
});

test("a symlink is left alone (never chmod'ed through to its target)", () => {
  const target = join(ROOT, "elsewhere.json");
  writeFileSync(target, JSON.stringify({ [ID_A]: { name: "x", directory: "/srv/x" } }));
  chmodSync(target, 0o644);
  if (existsSync(INSTANCES)) unlinkSync(INSTANCES);
  symlinkSync(target, INSTANCES);

  assert.equal(tightenInstancesJsonPermissions({ log: () => {} }), false);
  assert.ok(lstatSync(INSTANCES).isSymbolicLink(), "the symlink itself is untouched");
  assert.equal(mode(target), 0o644, "the target is not ours to change");

  unlinkSync(INSTANCES);
});

test("nothing throws when the file is missing", () => {
  if (existsSync(INSTANCES)) unlinkSync(INSTANCES);
  assert.equal(tightenInstancesJsonPermissions({ log: () => {} }), false);
  assert.equal(tightenInstancesJsonPermissions({ path: join(ROOT, "nope", "instances.json"), log: () => {} }), false);
  assert.equal(existsSync(INSTANCES), false, "a boot repair never creates the file");
  assert.ok(DATA.startsWith(ROOT) && HOME.startsWith(ROOT));
});