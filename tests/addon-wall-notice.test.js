/**
 * The add-on wall notices (PR D, review item 13) and the settings watch.
 *
 * Walls stay OFF by default: a host that has not asked for them and has not set
 * the kill switch gets no new bell. When walls are on, or the operator's kill
 * switch is set, one note per boot names what is not walled; the first boot that
 * really runs walls on adds the one-time walled note; and a change written
 * straight into addon-walls.json by another writer raises one note naming the
 * add-ons whose mode moved.
 *
 * Everything is a scratch dir under os.tmpdir(); the watch is the real
 * fs.watchFile polling, at a shorter interval so the file is quick.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addonWallsPath, readAddonWalls, rememberAddonWalls, setAddonWallsOutsideListener, setWallMode } from "../servers/shared/addon-walls-file.js";
import { bootNoticeFor, runAddonWallNotices, startAddonWallsWatch, walledNoticeFor } from "../scripts/addon-sandbox/notice.mjs";
import { addonWallStatus, renderAddonWallStatus } from "../servers/gateway/dashboard/shared/addon-wall-status.js";
import { NOTICE, RESIDUAL_LINE, SUMMARY, WALL_WORDS, sandboxLine } from "../scripts/addon-sandbox/words.mjs";

// ─── fixtures ──────────────────────────────────────────────────────────────

/** Walls off on this computer (the release default): no switch is set. */
const OFF = Object.freeze({});
/** Walls on for this computer. */
const WALLED = Object.freeze({ CROW_ADDON_WALLS_DEFAULT: "walled" });
/** The operator's kill switch. */
const KILLED = Object.freeze({ CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "walled" });

const walledWall = (over = {}) => ({ mode: "walled", tier: "walled", reason: null, source: "walled", profile: null, residuals: [], ...over });

const entry = (id, wall, extra = {}) => ({ id, kind: "addon", name: id, status: "connected", wall, ...extra });

const profileWith = (...parts) => ({ id: "x", labelParts: parts });

const homes = [];
function scratchHome() {
  const dir = mkdtempSync(join(tmpdir(), "crow-addon-wall-notice-"));
  homes.push(dir);
  return dir;
}
after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

/** A db stub whose settings table holds nothing (the notice falls back to English). */
const emptyDb = () => ({ execute: async () => ({ rows: [] }) });

function collector() {
  const calls = [];
  const createNotification = async (_db, opts) => { calls.push(opts); return { id: calls.length }; };
  return { calls, createNotification };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

// ─── the boot notice ───────────────────────────────────────────────────────

test("walls off by default and no kill switch: no notice at all", async () => {
  const crowHome = scratchHome();
  const { calls, createNotification } = collector();
  const res = await runAddonWallNotices({
    db: emptyDb(),
    crowHome,
    env: OFF,
    entries: [entry("notes", { mode: "unwalled", reason: "walls are off on this computer", source: "default" })],
    createNotification,
    lang: "en",
  });
  assert.deepEqual(calls, [], "an existing install sees nothing new in its bell");
  assert.deepEqual(res, { boot: false, walled: false });
  assert.equal(bootNoticeFor({ entries: [entry("notes", { mode: "unwalled", source: "default" })], env: OFF }), null);
});

test("walls on with one add-on the owner left unwalled: one note naming it", async () => {
  const crowHome = scratchHome();
  // A host that already had the one-time walled note: this boot sends the boot note only.
  writeFileSync(addonWallsPath(crowHome), JSON.stringify({ walledNoticeV1: true }, null, 2) + "\n", { mode: 0o600 });
  const { calls, createNotification } = collector();
  const entries = [
    entry("notes", { mode: "unwalled", reason: "your choice", source: "owner" }),
    entry("studio", walledWall()),
  ];
  const res = await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries, createNotification, lang: "en" });

  assert.equal(res.boot, true);
  assert.equal(calls.length, 1, "one note, not one per add-on");
  assert.equal(calls[0].title, "Some add-ons are not walled");
  assert.equal(calls[0].source, "addon-walls");
  assert.equal(calls[0].type, "system");
  assert.equal(calls[0].action_url, "/dashboard/extensions");
  assert.match(calls[0].body, /^notes: not walled \(your choice\)$/m);
  assert.ok(!calls[0].body.includes("studio:"), "a walled add-on is not in the list");
  assert.match(calls[0].body, /^Kill switch \(CROW_ADDON_WALLS=off\): off$/m);
});

test("the kill switch is named on its own", () => {
  const notice = bootNoticeFor({ entries: [entry("notes", { mode: "unwalled", reason: "walls switched off by the operator (CROW_ADDON_WALLS=off)", source: "kill-switch" })], env: KILLED });
  assert.ok(notice);
  assert.equal(notice.title, "Some add-ons are not walled");
  assert.match(notice.body, /^notes: not walled \(switched off by the operator\)$/m);
  assert.match(notice.body, /^Kill switch \(CROW_ADDON_WALLS=off\): on$/m);
});

test("the kill switch alone is enough for a note, even with no add-on to list", () => {
  const notice = bootNoticeFor({ entries: [], env: KILLED });
  assert.ok(notice, "the operator turned the walls off; that is worth saying");
  assert.equal(notice.body, "Kill switch (CROW_ADDON_WALLS=off): on");
});

test("walls on and everything walled: no boot note", async () => {
  const crowHome = scratchHome();
  writeFileSync(addonWallsPath(crowHome), JSON.stringify({ walledNoticeV1: true }, null, 2) + "\n", { mode: 0o600 });
  const { calls, createNotification } = collector();
  const res = await runAddonWallNotices({
    db: emptyDb(),
    crowHome,
    env: WALLED,
    entries: [entry("notes", walledWall()), entry("studio", walledWall())],
    createNotification,
    lang: "en",
  });
  assert.deepEqual(calls, []);
  assert.equal(res.boot, false);
});

test("the boot note is translated, and an approved data backend is listed by name", () => {
  const notice = bootNoticeFor({
    entries: [
      entry("notes", { mode: "unwalled", reason: "your choice", source: "owner" }),
      { id: "backend-1", kind: "backend", name: "orders-db", status: "connected", wall: { mode: "unwalled", source: "owner" } },
    ],
    env: WALLED,
    lang: "es",
  });
  assert.ok(notice);
  assert.equal(notice.title, NOTICE.bootTitle.es);
  assert.match(notice.body, /^orders-db: no aislado \(comandos aprobados\)$/m);
  assert.match(notice.body, /^notes: no aislado \(tu elección\)$/m);
  assert.match(notice.body, /^Interruptor de emergencia \(CROW_ADDON_WALLS=off\): desactivado$/m);
});

// ─── the first walled boot ─────────────────────────────────────────────────

test("booted twice with walls off, then walled twice: the walled note lands once, on the first walled boot", async () => {
  const crowHome = scratchHome();
  const { calls, createNotification } = collector();
  const entries = [entry("notes", walledWall({ profile: profileWith({ kind: "internet" }, { kind: "own-folder" }) }))];
  const boot = (env) => runAddonWallNotices({ db: emptyDb(), crowHome, env, entries, createNotification, lang: "en" });

  await boot(OFF);
  await boot(OFF);
  assert.equal(calls.length, 0, "never while walls are off");
  assert.ok(!existsSync(addonWallsPath(crowHome)) || readAddonWalls(crowHome).walledNoticeV1 !== true);

  await boot(WALLED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "Add-ons now run inside walls on this computer");
  assert.equal(calls[0].body, "notes: This add-on can: use the internet; keep files in its own folder");
  assert.equal(readAddonWalls(crowHome).walledNoticeV1, true, "the marker lives in the walls file");

  await boot(WALLED);
  assert.equal(calls.length, 1, "not on a later boot");
});

test("the marker survives a broken file: the note is sent again rather than skipped", async () => {
  const crowHome = scratchHome();
  writeFileSync(addonWallsPath(crowHome), "{ not json", { mode: 0o600 });
  const { calls, createNotification } = collector();
  await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries: [entry("notes", walledWall())], createNotification, lang: "en" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, NOTICE.walledTitle.en);
  assert.equal(readAddonWalls(crowHome).walledNoticeV1, true);
});

test("the walled note falls back to the status word when no live profile is known", () => {
  const notice = walledNoticeFor({ entries: [entry("notes", { mode: "unwalled", source: "owner" })], env: WALLED });
  assert.equal(notice.body, "notes: not walled (your choice)");
});

test("a notification layer that throws never breaks the boot", async () => {
  const crowHome = scratchHome();
  const res = await runAddonWallNotices({
    db: emptyDb(),
    crowHome,
    env: KILLED,
    entries: [],
    createNotification: async () => { throw new Error("the bell is on fire"); },
    lang: "en",
  });
  assert.deepEqual(res, { boot: false, walled: false });
  assert.notEqual(readAddonWalls(crowHome).walledNoticeV1, true, "nothing is marked as sent");
});

test("no db and no notifier: nothing thrown, nothing written", async () => {
  const crowHome = scratchHome();
  await runAddonWallNotices({ crowHome, env: KILLED, entries: [] });
  assert.deepEqual(readAddonWalls(crowHome), {});
});

// ─── the watch ─────────────────────────────────────────────────────────────

test("an outside change is handed to the listener before Crow's own next write replaces it", () => {
  const crowHome = scratchHome();
  setWallMode(crowHome, "notes", "unwalled");
  rememberAddonWalls(crowHome);

  const seen = [];
  setAddonWallsOutsideListener((diff) => seen.push(diff));
  try {
    // Another writer also walls a second add-on...
    writeFileSync(addonWallsPath(crowHome), JSON.stringify({ modes: { notes: "unwalled", other: "walled" } }, null, 2) + "\n", { mode: 0o600 });
    // ...and Crow's own next write reports it instead of overwriting it silently.
    assert.equal(setWallMode(crowHome, "notes", "walled"), true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].modesChanged, [{ id: "other", from: null, to: "walled" }]);
    assert.deepEqual(readAddonWalls(crowHome).modes, { notes: "walled", other: "walled" }, "the outside edit is kept, not laundered away");
  } finally {
    setAddonWallsOutsideListener(null);
  }
});

test("a write through the walls store raises no alert", async () => {
  const crowHome = scratchHome();
  const { createNotification } = collector();
  await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries: [entry("notes", walledWall())], createNotification, lang: "en" });

  const alerts = [];
  const stop = startAddonWallsWatch({ crowHome, onChange: (diff) => alerts.push(diff), intervalMs: 100 });
  try {
    assert.equal(setWallMode(crowHome, "notes", "unwalled"), true);
    await delay(500);
    assert.deepEqual(alerts, [], "Crow's own write is not an outside change");
  } finally {
    stop();
  }
});

test("the same change written straight to the file raises exactly one alert naming the add-on", async () => {
  const crowHome = scratchHome();
  const { createNotification } = collector();
  await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries: [entry("notes", walledWall())], createNotification, lang: "en" });
  setWallMode(crowHome, "notes", "unwalled");

  const alerts = [];
  const stop = startAddonWallsWatch({ crowHome, onChange: (diff) => alerts.push(diff), intervalMs: 100 });
  try {
    // Another writer: the same document, one mode moved.
    writeFileSync(addonWallsPath(crowHome), JSON.stringify({ modes: { notes: "walled" } }, null, 2) + "\n", { mode: 0o600 });
    assert.equal(await waitFor(() => alerts.length >= 1, 2000), true, "an outside change is reported within 2 s");
    await delay(400);
    assert.equal(alerts.length, 1, "one change, one alert");
    assert.deepEqual(alerts[0].modesChanged, [{ id: "notes", from: "unwalled", to: "walled" }]);
  } finally {
    stop();
  }
});

test("an outside edit that Crow's own next write lands on is still reported once (the watch's listener)", async () => {
  const crowHome = scratchHome();
  const { createNotification } = collector();
  await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries: [entry("notes", walledWall())], createNotification, lang: "en" });

  const alerts = [];
  // A long poll interval: only the store's pre-write check can see this edit in time.
  const stop = startAddonWallsWatch({ crowHome, onChange: (diff) => alerts.push(diff), intervalMs: 60_000 });
  try {
    await delay(50); // let the watch's own first check run
    writeFileSync(addonWallsPath(crowHome), JSON.stringify({ modes: { notes: "unwalled" } }, null, 2) + "\n", { mode: 0o600 });
    // Crow writes straight after, for another add-on: the edit must not become its baseline unseen.
    assert.equal(setWallMode(crowHome, "other", "walled"), true);
    assert.equal(alerts.length, 1, "the edit was handed over before Crow's write");
    assert.deepEqual(alerts[0].modesChanged, [{ id: "notes", from: null, to: "unwalled" }]);
    await delay(200);
    assert.equal(alerts.length, 1, "and only once");
  } finally {
    stop();
  }
});

test("a mode removed outside Crow reads as 'no choice'", async () => {
  const crowHome = scratchHome();
  setWallMode(crowHome, "notes", "unwalled");
  const { createNotification } = collector();
  await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries: [entry("notes", walledWall())], createNotification, lang: "en" });

  const alerts = [];
  const stop = startAddonWallsWatch({ crowHome, onChange: (diff) => alerts.push(diff), intervalMs: 100 });
  try {
    writeFileSync(addonWallsPath(crowHome), JSON.stringify({ modes: {} }, null, 2) + "\n", { mode: 0o600 });
    assert.equal(await waitFor(() => alerts.length >= 1, 2000), true);
    assert.deepEqual(alerts[0].modesChanged, [{ id: "notes", from: "unwalled", to: null }]);
  } finally {
    stop();
  }
});

test("a watch on a file that does not exist yet reports the first write", async () => {
  const crowHome = scratchHome();
  rememberAddonWalls(crowHome);

  const alerts = [];
  const stop = startAddonWallsWatch({ crowHome, onChange: (diff) => alerts.push(diff), intervalMs: 100 });
  try {
    writeFileSync(addonWallsPath(crowHome), JSON.stringify({ modes: { notes: "walled" } }, null, 2) + "\n", { mode: 0o600 });
    assert.equal(await waitFor(() => alerts.length >= 1, 2000), true);
    assert.deepEqual(alerts[0].modesChanged, [{ id: "notes", from: null, to: "walled" }]);
  } finally {
    stop();
  }
});

test("stop() ends the watch: a change after it reports nothing", async () => {
  const crowHome = scratchHome();
  const { createNotification } = collector();
  await runAddonWallNotices({ db: emptyDb(), crowHome, env: WALLED, entries: [entry("notes", walledWall())], createNotification, lang: "en" });

  const alerts = [];
  const stop = startAddonWallsWatch({ crowHome, onChange: (diff) => alerts.push(diff), intervalMs: 100 });
  stop();
  writeFileSync(addonWallsPath(crowHome), JSON.stringify({ modes: { notes: "walled" } }, null, 2) + "\n", { mode: 0o600 });
  await delay(400);
  assert.deepEqual(alerts, []);
});

// ─── the status page ───────────────────────────────────────────────────────

test("the status page lists an approved data backend as 'not walled (approved commands)'", () => {
  const entries = [
    entry("notes", walledWall({ profile: profileWith({ kind: "internet" }) })),
    { id: "backend-1", kind: "backend", name: "orders-db", status: "connected", wall: { mode: "unwalled", source: "owner" } },
  ];
  const status = addonWallStatus({ entries, env: WALLED, probe: { ok: true }, lang: "en" });
  assert.equal(status.backends.length, 1);
  assert.equal(status.backends[0].id, "backend-1", "the backend is never counted as an add-on");
  assert.equal(status.backends[0].word, "not walled (approved commands)");
  assert.equal(status.entries.length, 1);

  const html = renderAddonWallStatus({ entries, env: WALLED, probe: { ok: true }, lang: "en" });
  assert.match(html, /<li>orders-db: not walled \(approved commands\)<\/li>/);
  assert.match(html, /<li>notes: walled<\/li>/);
  assert.ok(html.includes(RESIDUAL_LINE.en), "the residual line is always shown");
  assert.match(html, /id="crow-addon-wall-status"/);
});

test("the status block escapes whatever an add-on row holds", () => {
  const html = renderAddonWallStatus({
    entries: [{ id: "<script>alert(1)</script>", kind: "addon", name: "x", status: "connected", wall: walledWall() }],
    env: WALLED,
    probe: { ok: true },
    lang: "en",
  });
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
});

// ─── the words themselves ──────────────────────────────────────────────────

test("no add-on word, summary, notice or sandbox line ever says 'contained'", () => {
  const texts = [];
  for (const word of Object.values(WALL_WORDS)) texts.push(word.en, word.es);
  for (const text of Object.values(SUMMARY)) texts.push(text.en, text.es);
  for (const text of Object.values(NOTICE)) texts.push(text.en, text.es);
  texts.push(RESIDUAL_LINE.en, RESIDUAL_LINE.es);
  const profile = profileWith({ kind: "internet" }, { kind: "local-host", label: "Paperless-ngx" }, { kind: "own-folder" }, { kind: "crow-db" });
  for (const lang of ["en", "es"]) {
    texts.push(sandboxLine(profile, lang));
    texts.push(sandboxLine(profile, lang, { walled: false }));
    const status = addonWallStatus({
      entries: [entry("notes", { mode: "unwalled", source: "owner" }), entry("studio", walledWall({ profile }))],
      env: WALLED,
      probe: { ok: true },
      lang,
    });
    texts.push(status.sentence, status.residualLine, ...status.entries.map((e) => e.word));
    texts.push(bootNoticeFor({ entries: [entry("notes", { mode: "unwalled", source: "owner" })], env: WALLED, lang }).body);
    texts.push(walledNoticeFor({ entries: [entry("studio", walledWall({ profile }))], env: WALLED, lang }).body);
  }
  for (const text of texts) assert.doesNotMatch(String(text), /contained|contenido/i, text);
});

test("the words module is a leaf: it imports nothing", () => {
  const src = readFileSync(new URL("../scripts/addon-sandbox/words.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m, "words.mjs must not import anything");
});