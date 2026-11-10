/**
 * A walled add-on that could not run stays OFF, and the owner is told why:
 * the failure record (scripts/addon-sandbox/failures.mjs), the Fix-it card it
 * raises, the remedy that answers it, and the orphan sweep that clears the
 * wrapper an earlier gateway left behind.
 *
 * Scratch Crow home and data dir under mkdtemp; nothing here reads ~/.crow.
 */
import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-addon-wall-failure-"));
const DATA = join(HOME, "data");
const WALLS_FILE = join(HOME, "addon-walls.json");
const NETNS_ENTRY = join(REPO, "scripts", "pi-bots", "pi_netns_entry.mjs");

// The scratch instance, set before the gateway modules are imported.
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_ADDON_WALLS;
delete process.env.CROW_ADDON_WALLS_DEFAULT;

mkdirSync(DATA, { recursive: true });
mkdirSync(join(HOME, "bundles"), { recursive: true });
// The install folders these cases connect (a stdio spawn's cwd).
for (const id of ["browser", "crashy", "steady"]) mkdirSync(join(HOME, "bundles", id), { recursive: true });
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: DATA }, stdio: "pipe", cwd: REPO,
});

const { createDbClient } = await import("../servers/db.js");
const store = await import("../servers/shared/fix-it/store.js");
const proxy = await import("../servers/gateway/proxy.js");
const fixIt = await import("../servers/gateway/fix-it/index.js");
const failures = await import("../scripts/addon-sandbox/failures.mjs");
const remedyMod = await import("../servers/gateway/fix-it/remedies/addon-unwall.js");
const { setWallMode } = await import("../servers/shared/addon-walls-file.js");
const { addonWallMode } = await import("../scripts/addon-sandbox/spawn.mjs");
const { buildNestHTML } = await import("../servers/gateway/dashboard/panels/nest/html.js");

const db = createDbClient();
/** The add-on ids these cases connect, so each one is dropped afterwards. */
const TOUCHED = ["browser", "crashy", "steady"];

/** A tiny stdio MCP server: answers initialize and tools/list, then exits when
 *  CRASH_AFTER_LIST is set (and otherwise stays up until its stdin ends). */
const TINY_SERVER = `
let buf = "";
function out(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || m.id === null) continue;
    if (m.method === "initialize") {
      out({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tiny", version: "1.0.0" },
      } });
    } else if (m.method === "tools/list") {
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
      if (process.env.CRASH_AFTER_LIST === "1") setTimeout(() => process.exit(7), 30);
    } else {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const TINY_SERVER_PATH = join(HOME, "tiny-mcp-server.mjs");
writeFileSync(TINY_SERVER_PATH, TINY_SERVER);

/** Resolve once `check()` is true, or reject after `ms`. */
function waitFor(check, ms = 5000, what = "condition") {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let ok = false;
      try { ok = await check(); } catch { ok = false; }
      if (ok) return resolve(ok);
      if (Date.now() > deadline) return reject(new Error("timed out waiting for " + what));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** The pending card with this dedup key, once the fire-and-forget emit landed. */
async function waitForCard(dedupKey, ms = 5000) {
  let card = null;
  await waitFor(async () => {
    const items = await store.listPending(db);
    card = items.find((i) => i.dedupKey === dedupKey) || null;
    return !!card;
  }, ms, "the Fix-it card " + dedupKey);
  return card;
}

/** Every row count, table by table (the "nothing else in crow.db" check). */
async function tableCounts() {
  const { rows } = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", args: [] });
  const counts = {};
  for (const row of rows) {
    const name = String(row.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    try {
      const res = await db.execute({ sql: `SELECT COUNT(*) AS n FROM "${name}"`, args: [] });
      counts[name] = Number(res.rows[0].n);
    } catch { counts[name] = null; }
  }
  return counts;
}

/** The walls file's bytes, or null when there is no file. */
function wallsBytes() {
  return existsSync(WALLS_FILE) ? readFileSync(WALLS_FILE) : null;
}

/** Insert a card straight into crow.db (the forged-card case). */
async function insertCard(dedupKey, { args = {}, context = null, source = "addon-wall" } = {}) {
  const remedies = [{ actionId: "addon-unwall", kind: "instant", args }];
  await db.execute({
    sql: `INSERT INTO fix_it_items (source, dedup_key, title, why, severity, remedies, context)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      source, dedupKey, "An add-on could not run inside its wall",
      "browser could not run inside its wall. It stays off until you choose.",
      "warn", JSON.stringify(remedies), context ? JSON.stringify(context) : null,
    ],
  });
  const { rows } = await db.execute({ sql: "SELECT id FROM fix_it_items WHERE source = ? AND dedup_key = ?", args: [source, dedupKey] });
  return Number(rows[0].id);
}

/** POST the remedy button for `itemId`; the redirect target is returned. */
async function clickRemedy(itemId, actionId = "addon-unwall") {
  let redirected = null;
  await fixIt.handleFixItAction(
    { body: { action: "remedy", item_id: String(itemId), action_id: actionId } },
    { redirectAfterPost: (u) => { redirected = u; } },
    { db },
  );
  return redirected;
}

beforeEach(async () => {
  failures._resetWallFailuresForTest();
  await db.execute("DELETE FROM fix_it_items");
});

afterEach(async () => {
  proxy._setProxyDepsForTest(null);
  remedyMod._setAddonUnwallDepsForTest(null);
  delete process.env.CROW_ADDON_WALLS_DEFAULT;
  for (const id of TOUCHED) {
    try { await proxy.connectedServers.get(id)?.client?.close?.(); } catch { /* already gone */ }
    proxy.connectedServers.delete(id);
  }
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
});

// ---- the card's reason -----------------------------------------------------

test("a denial from the wall's relay names the target on the card", async () => {
  const relay = { denials: () => ["192.0.2.9:80"], close: () => {} };
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({
      walled: true,
      tier: "walled",
      // A command that cannot start: the connect fails at once.
      cmd: join(HOME, "no-such-binary"),
      args: [],
      env: { ...process.env },
      stdioExtra: [],
      relay,
      profile: { id: "browser", network: { internet: true, hosts: [] } },
      cleanup: () => {},
    }),
  });

  await proxy.connectAddonServer("browser", { command: "node", args: ["server/index.js"] });
  assert.equal(proxy.connectedServers.get("browser").status, "error", "the add-on stayed off");

  const card = await waitForCard("addon-wall:browser");
  assert.equal(card.title, "An add-on could not run inside its wall");
  assert.match(card.why, /tried to reach 192\.0\.2\.9:80, which it is not set up for/);
  assert.match(card.why, /It stays off until you choose\./);
  assert.deepEqual(card.context, { addonId: "browser" });
  assert.deepEqual(card.remedies.map((r) => r.actionId), ["addon-unwall", "addon-keep-off"]);
  assert.deepEqual(Object.keys(card.remedies[0].args), ["ref"], "the card carries the ref only");
  const ref = card.remedies[0].args.ref;
  assert.match(ref, /^[0-9a-f]{32}$/);
  assert.deepEqual(failures.wallFailureByRef(ref)?.id, "browser", "the live record names the add-on");
});

test("an open failure outside the add-on's folders is never echoed, one inside is named", async () => {
  const installDir = join(HOME, "bundles", "browser");
  const dataDir = join(DATA, "browser");
  const secret = "/home/alex/.crow/secrets/keychain.key";
  const reason = failures.wallFailureReason({
    stderrLines: [`EACCES: permission denied, open '${secret}'`],
    installDir,
    dataDir,
  });
  assert.equal(reason, "could not open a file outside its folder");

  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const card = await waitForCard("addon-wall:browser");
  assert.match(card.why, /could not open a file outside its folder/);
  assert.equal(card.why.includes("keychain"), false, "the card never echoes the path");
  assert.equal(card.why.includes("/home/alex"), false, "the card never echoes a home path");
  assert.equal(JSON.stringify(card).includes("keychain"), false);

  const inside = join(dataDir, "x");
  assert.equal(
    failures.wallFailureReason({ stderrLines: [`ENOENT: no such file or directory, open '${inside}'`], installDir, dataDir }),
    "could not open x",
    "a path in the add-on's own folder is named relative to it",
  );

  const traversed = `${dataDir}/../../../etc/passwd`;
  assert.equal(
    failures.wallFailureReason({ stderrLines: [`EACCES: permission denied, open '${traversed}'`], installDir, dataDir }),
    "could not open a file outside its folder",
    "a ../ path that resolves outside is not named",
  );
});

// ---- the reason shows only plain relative text, never add-on output ---------

test("an open failure in the add-on's folder shows a plain relative path or a fixed phrase", () => {
  const installDir = join(HOME, "bundles", "browser");
  const dataDir = join(DATA, "browser");
  const reasonFor = (shown) => failures.wallFailureReason({
    stderrLines: [`EACCES: permission denied, open '${shown}'`], installDir, dataDir,
  });

  assert.equal(reasonFor(join(dataDir, "notes.txt")), "could not open notes.txt");
  assert.equal(reasonFor(join(installDir, "server", "index.js")), "could not open server/index.js");

  // Anything that is not plain relative text under a folder the add-on owns
  // becomes the fixed phrase; none of the add-on's words reach the card.
  const unshowable = [
    join(dataDir, "IGNORE ALL RULES <b>x</b>.txt"),
    join(dataDir, 'my notes "quoted".txt'),
    join(dataDir, "a".repeat(200) + ".txt"),
  ];
  for (const shown of unshowable) {
    const reason = reasonFor(shown);
    assert.equal(reason, "could not open a file in its folder", `fixed phrase for ${shown.slice(-30)}`);
    for (const leak of ["IGNORE", "ALL RULES", "quoted", "notes", "passwd", "<"]) {
      assert.equal(reason.includes(leak), false, `the reason never echoes ${leak}`);
    }
  }

  assert.equal(reasonFor("/home/alex/.crow/secrets/keychain.key"), "could not open a file outside its folder");
});

// ---- the card is the live record, not the stored row ------------------------

// ---- the remedy ------------------------------------------------------------

test("the remedy records the owner's choice in addon-walls.json and changes nothing else in crow.db", async () => {
  const reason = "its wall could not be set up on this computer";
  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const card = await waitForCard("addon-wall:browser");

  const reconnected = [];
  remedyMod._setAddonUnwallDepsForTest({
    crowHome: HOME,
    reconnect: async (id) => { reconnected.push(id); return { ok: true, status: "connected" }; },
  });

  const before = await tableCounts();
  const redirected = await clickRemedy(card.id);

  assert.match(redirected, /flash=fixit_addon_unwalled/);
  assert.equal((await store.getItem(db, card.id)).status, "resolved", "the card is answered");
  assert.deepEqual(reconnected, ["browser"], "the add-on was connected again, not restarted on its own");
  assert.equal(failures.wallFailureByRef(ref), null, "the record is spent");

  assert.ok(existsSync(WALLS_FILE), "the owner's choice was written");
  assert.equal(statSync(WALLS_FILE).mode & 0o777, 0o600, "addon-walls.json stays 0600");
  const doc = JSON.parse(readFileSync(WALLS_FILE, "utf8"));
  assert.equal(doc.modes?.browser, "unwalled");

  const countsAfter = await tableCounts();
  for (const [table, n] of Object.entries(before)) {
    if (table === "fix_it_items") continue;
    assert.equal(countsAfter[table], n, `${table} gained or lost rows`);
  }
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM fix_it_items", args: [] });
  assert.equal(Number(rows[0].n), before.fix_it_items, "no card row was added by the remedy");
});

test("a reconnect that fails after the choice was saved still answers the click (one warning)", async () => {
  const reason = "stopped with exit code 7";
  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const card = await waitForCard("addon-wall:browser");

  remedyMod._setAddonUnwallDepsForTest({
    crowHome: HOME,
    reconnect: async () => { throw new Error("could not start"); },
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.map(String).join(" ")); };
  let redirected = null;
  try {
    redirected = await clickRemedy(card.id);
  } finally {
    console.warn = origWarn;
  }
  assert.match(redirected, /flash=fixit_addon_unwalled/);
  assert.equal((await store.getItem(db, card.id)).status, "resolved");
  assert.equal(warns.filter((w) => w.includes("reconnect did not run")).length, 1, "exactly one warning");
  assert.equal(JSON.parse(readFileSync(WALLS_FILE, "utf8")).modes?.browser, "unwalled", "the choice is recorded");
});

// ---- forged and stale cards -------------------------------------------------

test("a forged card (no ref) is refused and the wall file is untouched", async () => {
  // A real failure for the same add-on is live: the forged card still names no
  // ref, so nothing may be written for it.
  const ref = failures.recordWallFailure("browser", "stopped with exit code 7");
  assert.equal(setWallMode(HOME, "notes", "walled"), true, "the wall file exists, so the byte check is exact");
  const itemId = await insertCard("addon-wall:forged", { args: { id: "browser" } });
  const before = wallsBytes();
  assert.ok(before, "there is a wall file to compare");

  const redirected = await clickRemedy(itemId);
  assert.match(redirected, /flash=fixit_addon_stale/);

  const after = wallsBytes();
  if (before === null) assert.equal(after, null, "no wall file was created");
  else assert.deepEqual(after, before, "addon-walls.json is byte-identical");
  assert.equal(failures.wallFailureByRef(ref)?.id, "browser", "the real record is untouched");
  assert.equal((await store.getItem(db, itemId)).status, "pending", "the card is still open");
});

test("a card whose ref names one add-on unwalls that one, whatever its args say", async () => {
  const ref = failures.recordWallFailure("studio", "its wall could not be set up on this computer");
  const itemId = await insertCard("addon-wall:studio", { args: { ref, id: "render" }, context: { addonId: "render" } });
  assert.equal(failures.bindWallFailureCard(ref, { itemId, dedupKey: "addon-wall:studio" }), true);
  const reconnected = [];
  remedyMod._setAddonUnwallDepsForTest({
    crowHome: HOME,
    reconnect: async (id) => { reconnected.push(id); return { ok: true, status: "connected" }; },
  });

  const redirected = await clickRemedy(itemId);
  assert.match(redirected, /flash=fixit_addon_unwalled/);
  const modes = JSON.parse(readFileSync(WALLS_FILE, "utf8")).modes || {};
  assert.equal(modes.studio, "unwalled", "the add-on the live record names was unwalled");
  assert.equal(modes.render, undefined, "the stored args named no other add-on");
  assert.deepEqual(reconnected, ["studio"]);
  assert.equal(failures.wallFailureByRef(ref), null);
});

// Finding 1: a crow.db writer can copy a genuine ref onto its own card. The
// record knows the one card it became, and the remedy trusts only that pair.
test("a forged card carrying a genuine ref is refused and the real card still works", async () => {
  const reason = "its wall could not be set up on this computer";
  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const real = await waitForCard("addon-wall:browser");
  assert.equal(failures.wallFailureByItemId(real.id)?.id, "browser", "the record is bound to its own card");

  const forgedId = await insertCard("addon-wall:studio", { args: { ref, id: "studio" }, context: { addonId: "studio" } });
  const reconnected = [];
  remedyMod._setAddonUnwallDepsForTest({
    crowHome: HOME,
    reconnect: async (id) => { reconnected.push(id); return { ok: true, status: "connected" }; },
  });

  const before = wallsBytes();
  const redirected = await clickRemedy(forgedId);
  assert.match(redirected, /flash=fixit_addon_stale/);
  const after = wallsBytes();
  if (before === null) assert.equal(after, null, "no wall file was created");
  else assert.deepEqual(after, before, "addon-walls.json is byte-identical");
  assert.deepEqual(reconnected, [], "nothing was connected again");
  assert.equal((await store.getItem(db, forgedId)).status, "pending", "the forged card is still open");
  assert.equal(failures.wallFailureByRef(ref)?.id, "browser", "the record is untouched");

  // The genuine card still answers.
  const realClick = await clickRemedy(real.id);
  assert.match(realClick, /flash=fixit_addon_unwalled/);
  assert.deepEqual(reconnected, ["browser"]);
  assert.equal(JSON.parse(readFileSync(WALLS_FILE, "utf8")).modes?.browser, "unwalled");
});

test("a forged card with a genuine ref but another source is refused", async () => {
  const ref = failures.recordWallFailure("browser", "stopped with exit code 7");
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason: "stopped with exit code 7", ref });
  const real = await waitForCard("addon-wall:browser");
  const forgedId = await insertCard("addon-wall:browser", {
    source: "remote-exposure", args: { ref }, context: { capability: "funkwhale" },
  });
  assert.notEqual(forgedId, real.id);

  const before = wallsBytes();
  const redirected = await clickRemedy(forgedId);
  assert.match(redirected, /flash=fixit_addon_stale/);
  const after = wallsBytes();
  if (before === null) assert.equal(after, null);
  else assert.deepEqual(after, before, "nothing was written");
  assert.equal(failures.wallFailureByRef(ref)?.id, "browser", "the record is untouched");
});

test("a card whose ref's record was never bound is refused", async () => {
  const ref = failures.recordWallFailure("studio", "its wall could not be set up on this computer");
  const itemId = await insertCard("addon-wall:studio", { args: { ref } });
  assert.equal(failures.wallFailureByItemId(itemId), null, "nothing bound this card to the record");

  const before = wallsBytes();
  const redirected = await clickRemedy(itemId);
  assert.match(redirected, /flash=fixit_addon_stale/);
  const after = wallsBytes();
  if (before === null) assert.equal(after, null);
  else assert.deepEqual(after, before, "nothing was written");
  assert.equal(failures.wallFailureByRef(ref)?.id, "studio", "the record is still live");
  assert.equal((await store.getItem(db, itemId)).status, "pending");
});

test("bindWallFailureCard binds one card to one record, and never rebinds", () => {
  const ref = failures.recordWallFailure("browser", "stopped with exit code 7");

  assert.equal(failures.bindWallFailureCard(ref, { itemId: 7, dedupKey: "addon-wall:studio" }), false, "another add-on's dedupKey");
  assert.equal(failures.bindWallFailureCard(ref, { itemId: 7, dedupKey: "addon-wall:browser" }), true);
  assert.deepEqual(failures.wallFailureByRef(ref), failures.wallFailureByItemId(7), "both reads name the same record");
  assert.equal(failures.wallFailureByRef(ref).itemId, 7);
  assert.equal(failures.wallFailureByRef(ref).dedupKey, "addon-wall:browser");

  const again = failures.bindWallFailureCard(ref, { itemId: 7, dedupKey: "addon-wall:browser" });
  assert.equal(again, true, "the same bind again is allowed (a re-detect bumps the same card)");
  assert.equal(failures.bindWallFailureCard(ref, { itemId: 8, dedupKey: "addon-wall:browser" }), false, "a second, different item id");
  assert.equal(failures.wallFailureByItemId(7)?.id, "browser", "the first binding stands");
  assert.equal(failures.wallFailureByItemId(8), null);

  const fresh = failures.recordWallFailure("steady", "stopped before it was ready");
  assert.equal(failures.bindWallFailureCard(fresh, { itemId: "9", dedupKey: "addon-wall:steady" }), false, "a non-integer item id");
  assert.equal(failures.bindWallFailureCard("0".repeat(32), { itemId: 9, dedupKey: "addon-wall:steady" }), false, "an unknown ref");
  assert.equal(failures.wallFailureByItemId(9), null);
});

// Finding 1: what the card SHOWS is the record too, not the stored row.
test("the rendered add-on card comes from the live record, not from the crow.db row", async () => {
  const reason = "tried to reach 192.0.2.9:80, which it is not set up for";
  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const card = await waitForCard("addon-wall:browser");
  const req = { csrfToken: "tok123" };

  let html = await fixIt.renderFixItCards(db, { lang: "en", req });
  assert.match(html, /Run browser without the wall/);
  assert.ok(html.includes(remedyMod.unwallLabel("browser")), "the unwall label is built from the live record");
  assert.ok(html.includes(remedyMod.KEEP_OFF_LABEL));
  assert.match(html, /browser tried to reach 192\.0\.2\.9:80, which it is not set up for\. It stays off until you choose\./);
  assert.match(html, /Keep it off/);
  assert.match(html, /An add-on could not run inside its wall/);

  // A crow.db writer overwrites the row with other text.
  await db.execute({
    sql: "UPDATE fix_it_items SET title = ?, why = ?, remedies = ?, context = ? WHERE id = ?",
    args: [
      "Run studio", "<script>alert(1)</script>",
      JSON.stringify([{ actionId: "addon-unwall", kind: "instant", label: "Run studio", args: {} }]),
      JSON.stringify({ addonId: "studio", capability: "funkwhale" }), card.id,
    ],
  });
  html = await fixIt.renderFixItCards(db, { lang: "en", req });
  assert.match(html, /Run browser without the wall/);
  assert.match(html, /An add-on could not run inside its wall/);
  assert.equal(html.includes("Run studio"), false, "no overwritten title or label");
  assert.equal(html.includes("alert(1)"), false, "no overwritten why");
  assert.equal(html.includes("&lt;script&gt;"), false, "the stored why is not rendered at all");
  assert.equal(html.includes("funkwhale"), false, "no stored context is rendered");

  // No live record: the card says so and offers only "Keep it off".
  failures._resetWallFailuresForTest();
  html = await fixIt.renderFixItCards(db, { lang: "en", req });
  assert.ok(html.includes(remedyMod.STALE_MESSAGE), "the stale line is shown");
  assert.equal(html.includes("without the wall"), false, "no unwall button without a record");
  assert.equal(html.includes("Run studio"), false);
  assert.match(html, /Keep it off/);
  assert.match(html, /Not now/);
});

test("after a restart (the records gone) the real card is refused with the restart wording", async () => {
  const reason = "its wall could not be set up on this computer";
  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const card = await waitForCard("addon-wall:browser");
  const before = wallsBytes();

  failures._resetWallFailuresForTest();
  const redirected = await clickRemedy(card.id);
  assert.match(redirected, /flash=fixit_addon_stale/);
  const after = wallsBytes();
  if (before === null) assert.equal(after, null);
  else assert.deepEqual(after, before, "nothing was written");
  assert.equal((await store.getItem(db, card.id)).status, "pending");
  assert.match(remedyMod.STALE_MESSAGE, /^This failure is from before Crow last restarted/);
});

// ---- a crash inside the wall ----------------------------------------------

test("a walled add-on that crashes right after connecting stays off, with one card", async () => {
  process.env.CROW_ADDON_WALLS_DEFAULT = "walled";
  const spawned = [];
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async (o) => {
      spawned.push(o);
      return {
        walled: true,
        tier: "walled",
        cmd: process.execPath,
        args: [TINY_SERVER_PATH],
        env: { ...process.env, CRASH_AFTER_LIST: "1" },
        stdioExtra: [],
        relay: null,
        profile: { id: "crashy", network: { internet: false, hosts: [] } },
        cleanup: () => {},
      };
    },
  });

  await proxy.connectAddonServer("crashy", { command: "node", args: ["server/index.js"] });
  assert.equal(proxy.connectedServers.get("crashy").status, "connected");

  const card = await waitForCard("addon-wall:crashy");
  assert.match(card.why, /stopped with exit code 7/);
  assert.equal(proxy.connectedServers.get("crashy").status, "error", "the entry says it is not running");

  // Nothing restarts it: a second spawn would show up here.
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(spawned.length, 1, "no second spawn within 5 s");
  assert.equal(addonWallMode({ id: "crashy", gatewayEnv: process.env, crowHome: HOME }).mode, "walled", "the mode is still walled");
  const cards = (await store.listPending(db)).filter((i) => i.dedupKey === "addon-wall:crashy");
  assert.equal(cards.length, 1, "one card for one add-on");
});

// ---- a close Crow asked for is not a failure --------------------------------

test("a walled add-on that Crow disconnects within 60 s raises no card and no record", async () => {
  process.env.CROW_ADDON_WALLS_DEFAULT = "walled";
  const emitted = [];
  const realDeps = { emitFixIt: async (_db, name, payload) => { emitted.push([name, payload]); } };
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({
      walled: true,
      tier: "walled",
      cmd: process.execPath,
      args: [TINY_SERVER_PATH],
      env: { ...process.env },
      stdioExtra: [],
      relay: null,
      profile: { id: "steady", network: { internet: false, hosts: [] } },
      cleanup: () => {},
    }),
    ...realDeps,
  });

  await proxy.connectAddonServer("steady", { command: "node", args: ["server/index.js"] });
  assert.equal(proxy.connectedServers.get("steady").status, "connected");
  await proxy.disconnectAddonServer("steady");
  // Give a late close event the time it would need to land.
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(emitted, [], "no failure event for a close Crow asked for");
  const cards = (await store.listPending(db)).filter((i) => i.dedupKey === "addon-wall:steady");
  assert.equal(cards.length, 0, "no card");
  delete process.env.CROW_ADDON_WALLS_DEFAULT;
});

// ---- the walled decision with no usable bwrap ------------------------------

test("a walled decision that lands on no usable bwrap records its source as no-bwrap", async () => {
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({
      walled: false,
      tier: "nnp",
      cmd: process.execPath,
      args: [TINY_SERVER_PATH],
      env: { ...process.env },
      reason: "bubblewrap (bwrap) is not installed",
    }),
  });

  await proxy.connectAddonServer("steady", { command: "node", args: ["server/index.js"] });
  const entry = proxy.connectedServers.get("steady");
  assert.equal(entry.status, "connected");
  assert.equal(entry.wall.mode, "unwalled");
  assert.equal(entry.wall.tier, "nnp");
  assert.equal(entry.wall.source, "no-bwrap");
  assert.equal(entry.wall.reason, "bubblewrap (bwrap) is not installed");
  await proxy.disconnectAddonServer("steady");
});

// ---- dedup -----------------------------------------------------------------

test("two failures of the same add-on give one card, counted twice, and only the newest ref is live", async () => {
  const first = failures.recordWallFailure("browser", "stopped with exit code 7");
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason: "stopped with exit code 7", ref: first });
  const second = failures.recordWallFailure("browser", "tried to reach 192.0.2.9:80, which it is not set up for");
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason: "tried to reach 192.0.2.9:80, which it is not set up for", ref: second });

  const cards = (await store.listPending(db)).filter((i) => i.dedupKey === "addon-wall:browser");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].count, 2);
  assert.equal(failures.wallFailureByRef(first), null, "a newer failure drops the older record");
  assert.equal(failures.wallFailureByRef(second)?.id, "browser");
});

// ---- the entry snapshot and the orphan sweep ------------------------------

test("addonWallEntries is a plain snapshot of the entries that went through the wall decision", () => {
  const wall = { mode: "unwalled", tier: "none", reason: "walls are off on this computer", source: "default", profile: null, residuals: [] };
  proxy.connectedServers.set("builtin-x", { client: { callTool: () => {} }, tools: [], status: "connected", isBuiltin: true, wall });
  proxy.connectedServers.set("backend-3", { client: null, tools: [], status: "connected", isBackend: true, backendName: "Paperless" });
  proxy.connectedServers.set("instance-p1", { client: {}, tools: [], status: "connected", isRemote: true });
  // An add-on that never went through the wall decision (an HTTP add-on, one
  // that failed before it): no local child ran, so it is neither walled nor counted.
  proxy.connectedServers.set("http-x", { client: {}, tools: [], status: "connected", isAddon: true });
  try {
    const entries = proxy.addonWallEntries();
    assert.deepEqual(entries.find((e) => e.id === "builtin-x"), {
      id: "builtin-x", kind: "builtin", name: "builtin-x", status: "connected", wall,
    });
    assert.deepEqual(entries.find((e) => e.id === "backend-3"), {
      id: "backend-3", kind: "backend", name: "Paperless", status: "connected", wall: null,
    });
    assert.equal(entries.some((e) => e.id === "instance-p1"), false, "a federation peer is not an add-on here");
    assert.equal(entries.some((e) => e.id === "http-x"), false, "an add-on with no wall record never ran a local child");
    assert.equal(JSON.stringify(entries).includes("callTool"), false, "no client reaches the snapshot");
  } finally {
    proxy.connectedServers.delete("builtin-x");
    proxy.connectedServers.delete("backend-3");
    proxy.connectedServers.delete("instance-p1");
    proxy.connectedServers.delete("http-x");
  }
});

test("isOrphanAddonWrapper matches only an orphaned bwrap wrapper around a bundles folder", () => {
  const wrapper = ["/usr/bin/bwrap", "--chdir", join(HOME, "bundles", "browser"), "--", process.execPath, NETNS_ENTRY, "--fds", "0,1,2"];
  assert.equal(
    proxy.isOrphanAddonWrapper({ ppid: 1, argv: wrapper, crowHome: HOME, appRoot: REPO, netnsEntry: NETNS_ENTRY }),
    true,
  );
  assert.equal(
    proxy.isOrphanAddonWrapper({ ppid: 4200, argv: wrapper, crowHome: HOME, appRoot: REPO, netnsEntry: NETNS_ENTRY }),
    false,
    "a wrapper another gateway parents is that gateway's",
  );
  const bot = ["/usr/bin/bwrap", "--chdir", join(HOME, "pi-bots", "twig"), "--", process.execPath, NETNS_ENTRY];
  assert.equal(
    proxy.isOrphanAddonWrapper({ ppid: 1, argv: bot, crowHome: HOME, appRoot: REPO, netnsEntry: NETNS_ENTRY }),
    false,
    "a bot runs the same entry, but not into a bundles folder",
  );
});

test("the sweep kills the matching orphan and leaves the others alone", async () => {
  const killed = [];
  const procs = [
    { pid: 9001, ppid: 1, argv: ["/usr/bin/bwrap", "--chdir", join(HOME, "bundles", "browser"), "--", process.execPath, NETNS_ENTRY] },
    { pid: 9002, ppid: 4200, argv: ["/usr/bin/bwrap", "--chdir", join(HOME, "bundles", "browser"), "--", process.execPath, NETNS_ENTRY] },
    { pid: 9003, ppid: 1, argv: ["/usr/bin/bwrap", "--chdir", "/tmp/elsewhere", "--", process.execPath, NETNS_ENTRY] },
    { pid: 9004, ppid: 1, argv: [process.execPath, "server/index.js", "--chdir", join(HOME, "bundles", "browser")] },
  ];
  proxy._setProxyDepsForTest({
    legacyEnvSources: () => [],
    loadDynamicBackends: async () => {},
    connectAddonServer: async () => null,
    listProcs: () => procs,
    killPid: (pid) => { killed.push(pid); },
  });

  await proxy.initProxyServers();
  assert.deepEqual(killed, [9001], "only the init-adopted bwrap wrapper in a bundles folder");
});

test("the sweep does nothing in a gateway that is PID 1 in a container", () => {
  const killed = [];
  const procs = [
    { pid: 9001, ppid: 1, argv: ["/usr/bin/bwrap", "--chdir", join(HOME, "bundles", "browser"), "--", process.execPath, NETNS_ENTRY] },
  ];
  proxy._setProxyDepsForTest({ listProcs: () => procs, killPid: (pid) => { killed.push(pid); } });
  try {
    assert.equal(proxy.sweepOrphanAddonWrappers({ selfPid: 1 }), 0, "a PID-1 gateway owns its ppid-1 children");
    assert.deepEqual(killed, [], "nothing was killed");
    assert.equal(proxy.sweepOrphanAddonWrappers({ selfPid: 4242 }), 1, "any other pid sweeps as before");
    assert.deepEqual(killed, [9001]);
  } finally {
    proxy._setProxyDepsForTest(null);
  }
});

// ---- the failure record's own guards --------------------------------------

test("an older, out-of-order emit never overwrites the card with a dead ref", async () => {
  const emitted = [];
  proxy._setProxyDepsForTest({ emitFixIt: async (_db, name, payload) => { emitted.push({ name, ...payload }); } });

  // Two failures for one add-on, both recorded before either emit runs: the
  // second drops the first's record, so only the live one raises a card.
  proxy.reportWallFailure("browser", { refused: true, cwd: join(HOME, "bundles", "browser") });
  proxy.reportWallFailure("browser", { refused: true, cwd: join(HOME, "bundles", "browser") });

  await waitFor(() => emitted.length >= 1, 2000, "the live record's card");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(emitted.length, 1, "only the live record is emitted");
  assert.equal(emitted[0].name, "addon-wall-failed");
  assert.equal(failures.wallFailureByRef(emitted[0].ref)?.id, "browser", "the emitted ref is the live one");
});

test("a failure's paths are shown relative to the add-on's own install folder, never a stored cwd", async () => {
  const emitted = [];
  proxy._setProxyDepsForTest({ emitFixIt: async (_db, name, payload) => { emitted.push(payload); } });
  const line = (p) => ({ stderrLines: () => [`EACCES: permission denied, open '${p}'`] });

  // A cwd outside both folders the wall allows is ignored.
  const elsewhere = join(HOME, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  proxy.reportWallFailure("browser", { transport: line(join(elsewhere, "x")), cwd: elsewhere });
  await waitFor(() => emitted.length >= 1, 2000, "the first card");
  assert.equal(emitted[0].reason, "could not open a file outside its folder", "the stored folder is not shown");

  // The bundled install folder is: at it and below it.
  emitted.length = 0;
  failures._resetWallFailuresForTest();
  proxy.reportWallFailure("browser", { transport: line(join(HOME, "bundles", "browser", "notes.txt")), cwd: join(HOME, "bundles", "browser") });
  await waitFor(() => emitted.length >= 1, 2000, "the second card");
  assert.equal(emitted[0].reason, "could not open notes.txt");
});

// ---- a gateway shutdown is not a wall failure ---------------------------

test("a walled close during the 2 s window raises no card when Crow is closing", async () => {
  process.env.CROW_ADDON_WALLS_DEFAULT = "walled";
  const emitted = [];
  proxy._setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    startAddonWall: async () => ({
      walled: true,
      tier: "walled",
      cmd: process.execPath,
      args: [TINY_SERVER_PATH],
      env: { ...process.env, CRASH_AFTER_LIST: "1" },
      stdioExtra: [],
      relay: null,
      profile: { id: "crashy", network: { internet: false, hosts: [] } },
      cleanup: () => {},
    }),
    emitFixIt: async (_db, name, payload) => { emitted.push({ name, ...payload }); },
  });

  try {
    await proxy.connectAddonServer("crashy", { command: "node", args: ["server/index.js"] });
    // Wait for the child's own close: that is what starts the 2 s wait.
    await waitFor(() => proxy.connectedServers.get("crashy")?.status === "error", 5000, "the walled close");
    const entry = proxy.connectedServers.get("crashy");
    // Crow's own close marks the entry closing; it is the same entry afterwards.
    await proxy.disconnectAddonServer("crashy");
    proxy.connectedServers.set("crashy", entry);
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(emitted, [], "an exiting gateway never raises a card");
    const cards = (await store.listPending(db)).filter((i) => i.dedupKey === "addon-wall:crashy");
    assert.equal(cards.length, 0, "no card");
  } finally {
    delete process.env.CROW_ADDON_WALLS_DEFAULT;
  }
});

// ---- a weaker tier is never called a wall --------------------------------

test("a decision with no source and a weaker tier never reads as walled", async () => {
  const { addonWallWord } = await import("../servers/gateway/dashboard/shared/addon-wall-status.js");
  for (const [tier, source] of [["nnp", "no-bwrap"], ["walled", "refused"]]) {
    proxy._setProxyDepsForTest({
      addonWallMode: () => ({ mode: "walled", reason: null }),
      startAddonWall: async () => ({
        walled: false,
        tier,
        cmd: process.execPath,
        args: [TINY_SERVER_PATH],
        env: { ...process.env },
        reason: "no usable bwrap here",
      }),
    });
    const installDir = join(HOME, "bundles", "steady");
    await proxy.connectAddonServer("steady", { command: "node", args: [TINY_SERVER_PATH], cwd: installDir });
    const entry = proxy.connectedServers.get("steady");
    assert.equal(entry.wall.mode, "unwalled");
    assert.equal(entry.wall.source, source, `${tier}: the fallback source`);
    assert.notEqual(
      addonWallWord({ id: "steady", kind: "addon", status: entry.status, wall: entry.wall }, { env: {} }),
      "walled",
      `${tier}: a non-walled run is never called walled`,
    );
    await proxy.disconnectAddonServer("steady");
  }
});

// ---- the unwall flash names the add-on -----------------------------------

test("the unwall success flash names the add-on from the live record, and only a plain id is shown", async () => {
  const reason = "its wall could not be set up on this computer";
  const ref = failures.recordWallFailure("browser", reason);
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason, ref });
  const card = await waitForCard("addon-wall:browser");
  remedyMod._setAddonUnwallDepsForTest({
    crowHome: HOME,
    reconnect: async () => ({ ok: true, status: "connected" }),
  });

  const redirected = await clickRemedy(card.id);
  assert.match(redirected, /flash=fixit_addon_unwalled&addon=browser$/);

  const nestData = (flashAddon) => ({
    pinnedItems: [], bundles: [], instances: [], trustedInstances: [], peerOverviews: [],
    ssoEnabled: false, healthSignals: null, flash: "fixit_addon_unwalled", flashAddon,
  });
  assert.ok(buildNestHTML(nestData("browser"), "en").includes(
    "Done. browser now runs without its wall on this computer. You can wall it again on its page under Extensions."));
  assert.ok(buildNestHTML(nestData(null), "en").includes(remedyMod.UNWALLED_MESSAGE), "no id: the generic line");
  for (const bad of ["<script>alert(1)</script>", "Browser", "a/b", "", "x\" onmouseover=\"y"]) {
    const html = buildNestHTML(nestData(bad), "en");
    assert.ok(html.includes(remedyMod.UNWALLED_MESSAGE), `the id ${JSON.stringify(bad)} is not shown`);
    assert.equal(html.includes("alert(1)"), false);
  }
});
// ---- review round 2: the record is found by the clicked card, and "Keep it off" spends it ----

test("a card whose stored ref went stale still unwalls the add-on its bound record names", async () => {
  const ref = failures.recordWallFailure("browser", "stopped with exit code 3");
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason: "stopped with exit code 3", ref });
  const card = await waitForCard("addon-wall:browser");
  // An out-of-order write left a dead ref in the stored args.
  const stale = "0".repeat(32);
  await db.execute({ sql: "UPDATE fix_it_items SET remedies = ? WHERE id = ?", args: [JSON.stringify([{ actionId: "addon-unwall", kind: "instant", args: { ref: stale } }]), card.id] });
  const reconnected = [];
  remedyMod._setAddonUnwallDepsForTest({ crowHome: HOME, reconnect: async (id) => { reconnected.push(id); return { ok: true, status: "connected" }; } });
  const redirected = await clickRemedy(card.id);
  assert.match(redirected, /flash=fixit_addon_unwalled/);
  assert.deepEqual(reconnected, ["browser"]);
});

test("Keep it off spends the record: a card set back to pending can no longer unwall", async () => {
  const ref = failures.recordWallFailure("browser", "stopped with exit code 3");
  await fixIt.emitFixIt(db, "addon-wall-failed", { id: "browser", reason: "stopped with exit code 3", ref });
  const card = await waitForCard("addon-wall:browser");
  const before = wallsBytes();
  assert.match(await clickRemedy(card.id, "addon-keep-off"), /flash=fixit_fixed/);
  assert.equal(failures.wallFailureByItemId(card.id), null, "the record is gone");
  // A crow.db writer reopens the answered card.
  await db.execute({ sql: "UPDATE fix_it_items SET status = 'pending' WHERE id = ?", args: [card.id] });
  const reconnected = [];
  remedyMod._setAddonUnwallDepsForTest({ crowHome: HOME, reconnect: async (id) => { reconnected.push(id); return { ok: true }; } });
  assert.match(await clickRemedy(card.id), /flash=fixit_addon_stale/);
  assert.deepEqual(reconnected, []);
  const after = wallsBytes();
  if (before === null) assert.equal(after, null);
  else assert.deepEqual(after, before, "addon-walls.json is byte-identical");
});
