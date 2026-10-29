/**
 * Project services Task 16c: which connections are sensitive (servers/shared/service-sensitivity.js)
 * and the For You authority's slot on the services mount (off). A scratch Crow home: never ~/.crow.
 * The route is tested in services-api.test.js and the mount's refusal in services-mount.test.js.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-svcsens-home-"));
const saved = process.env.CROW_HOME;
process.env.CROW_HOME = HOME;
after(() => { if (saved === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = saved; rmScratch(HOME); });

const SENS = await import("../servers/shared/service-sensitivity.js");
const { serviceCatalog } = await import("../servers/shared/service-catalog.js");
const M = await import("../servers/gateway/services/mount.js");

const FILE = join(HOME, "secrets", SENS.SENSITIVITY_OVERRIDES_FILENAME);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conn = (serviceId, n) => ({ uuid: uuid(n), serviceId });
const sens = (serviceId, n) => SENS.isSensitiveConnection(conn(serviceId, n), { crowHome: HOME });
/** Write the override file by hand (a 600 file in the real secrets dir). */
function plant(path, text, mode = 0o600) {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}

test("the code-declared defaults (Kevin 2026-10-29): obsidian locked private; notion and discord private by default; the rest open", () => {
  const expect = {
    obsidian: { default: true, locked: true },
    notion: { default: true, locked: false },
    discord: { default: true, locked: false },
  };
  for (const id of ["github", "home-assistant", "brave-search", "trello", "canvas-lms", "zotero", "render", "arxiv"]) expect[id] = { default: false, locked: false };
  assert.deepEqual(JSON.parse(JSON.stringify(SENS.SERVICE_SENSITIVITY)), expect);
  for (const [id, s] of Object.entries(expect)) {
    assert.deepEqual({ ...SENS.serviceSensitivity(id) }, s, id);
    assert.equal(sens(id, 1), s.default, `${id}: no override → its default`);
  }
  assert.ok(Object.isFrozen(SENS.SERVICE_SENSITIVITY) && Object.isFrozen(SENS.SERVICE_SENSITIVITY.github), "frozen");
  // Every catalog service is decided here (a new one would be private + locked until someone decides).
  for (const s of serviceCatalog()) assert.ok(Object.hasOwn(SENS.SERVICE_SENSITIVITY, s.id), `${s.id} is declared`);
});

test("an unknown service is sensitive and locked; a malformed connection is sensitive", () => {
  for (const id of ["mystery", "", "__proto__", "constructor", "toString", undefined, null, 7]) {
    assert.deepEqual({ ...SENS.serviceSensitivity(id) }, { default: true, locked: true }, String(id));
  }
  assert.equal(SENS.isSensitiveConnection(null), true);
  assert.equal(SENS.isSensitiveConnection({}), true);
  assert.equal(SENS.isSensitiveConnection({ uuid: uuid(1) }), true);
  assert.equal(sens("mystery", 1), true);
  assert.throws(() => SENS.setSensitivityOverride(conn("mystery", 1), false, { crowHome: HOME }), (e) => e.code === "locked");
  assert.throws(() => SENS.setSensitivityOverride(conn("obsidian", 1), false, { crowHome: HOME }), (e) => e.code === "locked");
  assert.equal(existsSync(FILE), false, "a locked refusal writes nothing");
});

test("the owner's override: locked ? default : (override ?? default); written atomically, mode 600, in the hidden secrets dir", () => {
  assert.deepEqual(SENS.setSensitivityOverride(conn("github", 2), true, { crowHome: HOME }), { sensitive: true, locked: false, default: false });
  assert.deepEqual(SENS.setSensitivityOverride(conn("notion", 3), false, { crowHome: HOME }), { sensitive: false, locked: false, default: true });
  assert.equal(sens("github", 2), true);
  assert.equal(sens("notion", 3), false);
  assert.equal(sens("github", 4), false, "another connection keeps its default");
  assert.equal(sens("GITHUB", 2), true, "an unknown service id is locked: the override never applies");
  const st = statSync(FILE);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(statSync(join(HOME, "secrets")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")), { [uuid(2)]: true, [uuid(3)]: false });
  // An override recorded for a connection whose service is (now) locked is ignored.
  assert.equal(SENS.isSensitiveConnection({ uuid: uuid(3), serviceId: "obsidian" }, { crowHome: HOME }), true);
  assert.throws(() => SENS.setSensitivityOverride(conn("github", 2), "no", { crowHome: HOME }), (e) => e.code === "bad_value");
  assert.throws(() => SENS.setSensitivityOverride({ uuid: "../x", serviceId: "github" }, true, { crowHome: HOME }), (e) => e.code === "bad_value");
});

test("a corrupt, unreadable or wrong-mode override file is the DEFAULT for every connection, never 'not sensitive'", () => {
  SENS.setSensitivityOverride(conn("github", 5), true, { crowHome: HOME });
  SENS.setSensitivityOverride(conn("notion", 6), false, { crowHome: HOME });
  const good = readFileSync(FILE, "utf8");
  const cases = [
    ["not JSON", "{oops\n"],
    ["an array", "[]\n"],
    ["two lines", `${good}${good}`],
    ["JSON null", "null\n"],
    ["empty", ""],
  ];
  for (const [label, text] of cases) {
    plant(FILE, text);
    assert.equal(sens("github", 5), false, `${label}: github takes its default`);
    assert.equal(sens("notion", 6), true, `${label}: notion takes its default (private)`);
  }
  plant(FILE, good, 0o644);
  assert.equal(sens("notion", 6), true, "a 644 file is not trusted: notion's default");
  plant(FILE, JSON.stringify({ [uuid(6)]: "false", [uuid(5)]: 1, "not-a-uuid": false }) + "\n");
  assert.equal(sens("notion", 6), true, "a non-boolean value is no override");
  assert.equal(sens("github", 5), false);
  // The next owner write replaces a corrupt file with a good one.
  plant(FILE, "{oops\n");
  SENS.setSensitivityOverride(conn("notion", 6), false, { crowHome: HOME });
  assert.equal(sens("notion", 6), false);
  assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")), { [uuid(6)]: false });
});

test("the store reads only the anchored secrets dir: a file a bot could write elsewhere, or a dir planted at the secrets path, overrides nothing", () => {
  SENS.setSensitivityOverride(conn("notion", 7), true, { crowHome: HOME });
  const planted = JSON.stringify({ [uuid(7)]: false, [uuid(8)]: false }) + "\n";
  // Bot-writable places: the Crow home itself, its data dir, the bundles dir.
  for (const dir of [HOME, join(HOME, "data"), join(HOME, "bundles")]) {
    mkdirSync(dir, { recursive: true });
    plant(join(dir, SENS.SENSITIVITY_OVERRIDES_FILENAME), planted);
  }
  assert.equal(sens("notion", 7), true);
  assert.equal(sens("notion", 8), true);
  // A bot that renames the secrets dir away and plants its own at the old path: the anchor follows
  // the real dir (its fd), and the planted dir is never read.
  const real = join(HOME, "secrets");
  const moved = join(HOME, "secrets-moved");
  renameSync(real, moved);
  try {
    mkdirSync(real, { mode: 0o700 });
    plant(join(real, SENS.SENSITIVITY_OVERRIDES_FILENAME), planted);
    assert.equal(sens("notion", 7), true, "the real (moved) file still says private");
    assert.equal(sens("notion", 8), true, "the planted file is never read");
    SENS.setSensitivityOverride(conn("github", 9), true, { crowHome: HOME });
    assert.equal(JSON.parse(readFileSync(join(moved, SENS.SENSITIVITY_OVERRIDES_FILENAME), "utf8"))[uuid(9)], true, "writes follow the anchor too");
    assert.deepEqual(JSON.parse(readFileSync(join(real, SENS.SENSITIVITY_OVERRIDES_FILENAME), "utf8")), JSON.parse(planted), "the planted file is untouched");
  } finally {
    rmScratch(real);
    renameSync(moved, real);
  }
});

test("For You's read-only owner authority (For You spec §11) is a named slot on the mount, and it is OFF", async () => {
  assert.equal(M.FOR_YOU_READ_AUTHORITY_ENABLED, false);
  assert.equal(M.forYouReadAuthority({ scope: "for-you", botId: "for-you" }, { uuid: uuid(1) }), false);
  assert.equal(M.forYouReadAuthority(), false);
  // An actor that is neither a session nor a job never passes authorize (no DB is needed to refuse it).
  const db = { execute: async () => { throw new Error("must not read"); } };
  for (const scope of ["for-you", "foryou", "owner", "board", undefined]) {
    const r = await M.authorizeServiceCall(db, { scope, botId: "b1", defProjectId: 1 }, uuid(1), { crowHome: HOME });
    assert.deepEqual(r, { ok: false, code: "not_granted" }, String(scope));
  }
});
