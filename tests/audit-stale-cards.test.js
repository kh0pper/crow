/**
 * Security audit N5-4 — what the product says must stop being said once it is no
 * longer true:
 *
 *   1. "Crow updates stopped: …" used to outlive the failure: the next update that
 *      SUCCEEDED (applied, or "Up to date" with the updater healthy) left the bell
 *      in place. Every result write funnels through saveSetting(), so an `ok` result
 *      now dismisses this module's own open bells (the same write
 *      crow_dismiss_notification does) and nothing else's.
 *   2. A bundle's "Finish <App>'s setup now" card and bell survived the app's
 *      removal. The card is built from installed.json, so the removal empties it;
 *      the bell has to be dismissed explicitly, and only that bundle's.
 *   3. A removed app's grants made the bot's Abilities tab list a dead service
 *      ("couldn't load this service's tools (Cannot find module …)"). The row is no
 *      longer drawn and its grants are counted in one quiet line. Nothing is
 *      deleted on read.
 *   4. A fresh install has no canonical mcp.json at all. That is "no tools yet" and
 *      now renders an empty state instead of "cannot read canonical mcp.json at
 *      <path>: ENOENT".
 *
 * The update tests drive the real updater against a local fixture repo (the module's
 * own seams); the rest use stubs and pinned sources, so no real home, database or
 * MCP server is touched.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmScratch } from "./helpers/safe-rm.js";

// A successful update arms the gateway's restart chain; never inside a test.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

/**
 * A scratch HOME with no ~/.pi/agent/mcp.json — a fresh install — set BEFORE the
 * modules that resolve that path are imported (mcp_writer binds it at load).
 */
const FRESH_HOME = mkdtempSync(join(tmpdir(), "crow-audit-n5-4-home-"));
const savedHome = process.env.HOME;
process.env.HOME = FRESH_HOME;

const {
  checkForUpdates, _setAppRootForTest, _setDbForTest, _setCiVerdictForTest, UPDATE_NOTIFICATION_SOURCE,
} = await import("../servers/gateway/auto-update.js");
const { clearFirstAdminNotice, firstAdminDoneValues, pendingFirstAdminNotices } = await import("../servers/gateway/bundle-first-admin.js");
const { translations, fill } = await import("../servers/gateway/dashboard/shared/i18n.js");

const REAL_APP_ROOT = join(import.meta.dirname, "..");

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmScratch(FRESH_HOME);
});

// ---------------------------------------------------------------------------------
// 1. the stopped-updates bell
// ---------------------------------------------------------------------------------

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/**
 * dashboard_settings behind a Map, plus a notifications table just real enough for
 * the dismiss write: rows carry id/source/is_dismissed and a SELECT by source.
 */
function stubDb({ notifications = [], settings = {} } = {}) {
  const settingsMap = new Map(Object.entries(settings));
  const rows = notifications.map((n, i) => ({ id: n.id ?? i + 1, source: n.source ?? null, is_dismissed: n.is_dismissed ? 1 : 0, metadata: n.metadata ?? null }));
  return {
    settings: settingsMap,
    notifications: rows,
    async execute({ sql, args = [] } = {}) {
      const q = sql || "";
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(q)) {
        return { rows: settingsMap.has(args[0]) ? [{ value: settingsMap.get(args[0]) }] : [] };
      }
      if (/SELECT key, value FROM dashboard_settings WHERE key IN \(\?, \?\)/.test(q)) {
        return { rows: args.filter((k) => settingsMap.has(k)).map((k) => ({ key: k, value: settingsMap.get(k) })) };
      }
      if (/SELECT key, value FROM dashboard_settings WHERE key LIKE \?/.test(q)) {
        const prefix = String(args[0] || "").replace(/%$/, "");
        return { rows: [...settingsMap.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, value: settingsMap.get(k) })) };
      }
      if (/INSERT INTO dashboard_settings/.test(q)) {
        settingsMap.set(args[0], args[1]);
        return { rows: [], lastInsertRowid: 0 };
      }
      if (/SELECT id, metadata FROM notifications/.test(q)) {
        return { rows: rows.filter((r) => r.source === args[0] && r.is_dismissed === 0).map((r) => ({ id: r.id, metadata: r.metadata })) };
      }
      if (/UPDATE notifications SET is_dismissed = 1/.test(q) && /WHERE source = \?/.test(q)) {
        const mine = rows.filter((r) => r.source === args[0] && r.is_dismissed === 0);
        for (const r of mine) r.is_dismissed = 1;
        return { rows: [], rowsAffected: mine.length };
      }
      if (/UPDATE notifications SET is_dismissed = 1/.test(q) && /WHERE id = \?/.test(q)) {
        const row = rows.find((r) => r.id === args[0]);
        if (row) row.is_dismissed = 1;
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }
      return { rows: [] };
    },
  };
}

/** A bare origin + a clone that is already level with it: the next check is "Up to date". */
function originFixture() {
  const root = mkdtempSync(join(tmpdir(), "crow-audit-n5-4-au-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "a.txt");
  g(work, "commit", "-m", "c1");
  g(work, "push", "origin", "main");
  return { root, work, cleanup: () => rmScratch(root) };
}

test("a successful update clears the stopped-updates bell", async () => {
  const fx = originFixture();
  const db = stubDb({
    settings: { auto_update_last_result: "Pull failed: local changes overlap it" },
    notifications: [
      { source: UPDATE_NOTIFICATION_SOURCE, metadata: JSON.stringify({ code: "pull-failed" }) },
      // Somebody else's bell, and one from another source that must survive.
      { source: "bundle-installer", metadata: null },
    ],
  });
  try {
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const r = await checkForUpdates();
    assert.equal(r.updated, false, JSON.stringify(r));
    assert.equal(db.settings.get("auto_update_last_result"), "Up to date",
      "the check found main up to date — the updater is healthy again");
    assert.equal(db.notifications[0].is_dismissed, 1, "the stopped-updates bell is gone");
    assert.equal(db.notifications[1].is_dismissed, 0, "another feature's bell is untouched");
  } finally {
    _setCiVerdictForTest(null);
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

test("a failing result still rings, and a later failure is not cleared by another instance's check", async () => {
  const fx = originFixture();
  const db = stubDb({ notifications: [{ source: UPDATE_NOTIFICATION_SOURCE, metadata: JSON.stringify({ code: "pull-failed" }), is_dismissed: 1 }] });
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const r = await checkForUpdates();
    assert.equal(r.skipped, "not-on-main");
    assert.equal(db.notifications[0].is_dismissed, 1, "a failure result never re-opens or clears an old row");
  } finally {
    _setDbForTest(null);
    _setAppRootForTest(REAL_APP_ROOT);
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------------
// 2. a removed bundle's finish-setup card and bell
// ---------------------------------------------------------------------------------

const KUMA = { id: "kuma", name: "Uptime Kuma", webUI: { port: 3007, path: "/" }, firstAdmin: { mode: "finish-setup" } };
const EYE = { id: "eye", name: "motionEye", webUI: { port: 8765, path: "/" }, firstAdmin: { mode: "default-login", user: "admin" } };
const INSTALL = "2026-11-01T10:00:00.000Z";

test("removing a bundle clears its finish-setup card", async () => {
  const db = stubDb({
    notifications: [
      { id: 1, source: "bundle-installer", metadata: JSON.stringify({ kind: "bundle-first-admin", bundle: "kuma", mode: "finish-setup" }) },
      { id: 2, source: "bundle-installer", metadata: JSON.stringify({ kind: "bundle-first-admin", bundle: "eye", mode: "default-login" }) },
      // The "Removed: Uptime Kuma" row shares the source and must stay.
      { id: 3, source: "bundle-installer", metadata: null },
    ],
  });
  // Before: the card is owed (installed, no Done press, no saved login).
  const before = pendingFirstAdminNotices({
    installed: { kuma: { installedAt: INSTALL }, eye: { installedAt: INSTALL } },
    manifests: { kuma: KUMA, eye: EYE },
    done: await firstAdminDoneValues(db),
  });
  assert.deepEqual(before.map((c) => c.id), ["kuma", "eye"]);

  const cleared = await clearFirstAdminNotice(db, "kuma", { installId: INSTALL });
  assert.equal(cleared.dismissed, 1, "one bell dismissed");
  assert.equal(db.notifications[0].is_dismissed, 1, "its finish-setup bell");
  assert.equal(db.notifications[1].is_dismissed, 0, "another app's bell stays");
  assert.equal(db.notifications[2].is_dismissed, 0, "the \"Removed:\" row is not a setup notice");

  // The card is gone even from a page rendered with the stale installed.json.
  const done = await firstAdminDoneValues(db);
  assert.equal(done.kuma, INSTALL, "the marker names this install, like the Done button's stamp");
  const afterCards = pendingFirstAdminNotices({
    installed: { kuma: { installedAt: INSTALL }, eye: { installedAt: INSTALL } },
    manifests: { kuma: KUMA, eye: EYE },
    done,
  });
  assert.deepEqual(afterCards.map((c) => c.id), ["eye"], "only the app that is still installed still asks");

  // Reinstalling asks again: the Done stamp is per install.
  const reinstalled = pendingFirstAdminNotices({
    installed: { kuma: { installedAt: "2026-12-01T10:00:00.000Z" } },
    manifests: { kuma: KUMA },
    done,
  });
  assert.deepEqual(reinstalled.map((c) => c.id), ["kuma"]);

  // And the uninstall path really calls it.
  const routes = readFileSync(join(REAL_APP_ROOT, "servers/gateway/routes/bundles.js"), "utf8");
  assert.match(routes, /clearFirstAdminNotice\(noticeDb, bundle_id, \{/, "the removal path clears the notice, naming the install it covered");
});

// ---------------------------------------------------------------------------------
// 3. a removed app's grants on the Abilities tab
// ---------------------------------------------------------------------------------

test("a removed bundle's server is counted, not drawn", async () => {
  const { renderAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
  const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
  const crowHome = mkdtempSync(join(tmpdir(), "crow-audit-n5-4-ab-"));
  // A removed bundle leaves its mcp-addons registration behind: that entry is what makes
  // the server provably an app's own, the probe cannot start it, and there is no folder
  // for it. Nothing is installed, either.
  writeFileSync(join(crowHome, "mcp-addons.json"),
    JSON.stringify({ "kuma-app": { command: "node", args: ["server/index.js"] } }));
  _setSourcesForTest({
    error: null,
    errorCode: null,
    sources: [
      { server: "kuma-app", name: "Kuma", ok: false, error: `Cannot find module '${crowHome}/bundles/kuma-app/server/index.js'`, catalog: [] },
      { server: "crow-memory", name: "Memory", ok: true, catalog: [{ name: "crow_search_memories", access: "read" }] },
    ],
  });
  const def = { tools: { crow_mcp: ["kuma-app/kuma_create_monitor", "crow-memory/crow_search_memories"], pi_builtin: [] }, permission_skills: [], permission_policy: { bash: "deny" } };
  try {
    const html = await renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(!html.includes('data-src="kuma-app"'), "no row for the app that is gone");
    assert.ok(!/Cannot find module/.test(html), "and no module error quoted at the operator");
    assert.match(html, /data-testid="removed-apps"/, "one quiet line instead");
    assert.ok(html.includes(translations["botbuilder.abRemovedAppsOne"].en), "one grant reads as one tool, not \"1 tools\"");
    assert.ok(html.includes('data-src="crow-memory"'), "the live source is still listed");
    // Nothing is deleted on read: the grant is still in the def, exactly as written.
    assert.deepEqual(def.tools.crow_mcp, ["kuma-app/kuma_create_monitor", "crow-memory/crow_search_memories"]);

    const es = await renderAbilities({ def, lang: "es", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(es.includes(translations["botbuilder.abRemovedAppsOne"].es), "the Spanish line");

    // Two dead grants from one removed app: the plural key, with its count.
    def.tools.crow_mcp = ["kuma-app/kuma_create_monitor", "kuma-app/kuma_list_monitors", "crow-memory/crow_search_memories"];
    const two = await renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(two.includes(fill(translations["botbuilder.abRemovedApps"].en, { n: 2 })), "the plural line for two");
  } finally {
    _setSourcesForTest(null);
    rmScratch(crowHome);
  }
});

test("a hand-added server that fails keeps its row and its error", async () => {
  const { renderAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
  const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
  const crowHome = mkdtempSync(join(tmpdir(), "crow-audit-n5-4-hand-"));
  // A server the operator added to ~/.pi/agent/mcp.json by hand never has a bundles/<id>
  // folder and is never in mcp-addons.json. A missing launcher (`spawn uvx ENOENT`) is a
  // broken service, not an app that was removed: it keeps its row, with its error.
  writeFileSync(join(crowHome, "mcp-addons.json"),
    JSON.stringify({ "kuma-app": { command: "node", args: ["server/index.js"] } }));
  _setSourcesForTest({
    error: null,
    errorCode: null,
    sources: [
      { server: "my-uvx-server", name: "My server", ok: false, error: "spawn uvx ENOENT", catalog: [] },
    ],
  });
  const def = { tools: { crow_mcp: ["my-uvx-server/some_tool"], pi_builtin: [] }, skills: [], permission_policy: { bash: "deny" } };
  try {
    const html = await renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(html.includes('data-src="my-uvx-server"'), "the broken server keeps its row");
    assert.ok(html.includes("spawn uvx ENOENT"), "and the row carries its own error");
    assert.ok(!html.includes('data-testid="removed-apps"'), "it is not counted as an app that is no longer installed");
    assert.deepEqual(def.tools.crow_mcp, ["my-uvx-server/some_tool"], "and its grants are untouched");
  } finally {
    _setSourcesForTest(null);
    rmScratch(crowHome);
  }
});

// ---------------------------------------------------------------------------------
// 4. a fresh install's Abilities tab
// ---------------------------------------------------------------------------------

test("a fresh install's Abilities tab shows an empty state, not ENOENT", async () => {
  const { renderAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
  const { loadSources, _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
  const crowHome = mkdtempSync(join(tmpdir(), "crow-audit-n5-4-fresh-"));
  _setSourcesForTest(null); // the REAL path: probeAll reads ~/.pi/agent/mcp.json, absent here
  const def = { tools: { crow_mcp: [], pi_builtin: [] }, skills: [], permission_policy: { bash: "deny" } };
  try {
    assert.ok(!existsSync(join(FRESH_HOME, ".pi", "agent", "mcp.json")), "a fresh install really has no file");
    const loaded = await loadSources({ db: null, projectId: null, crowHome });
    assert.equal(loaded.error, null, "a missing file is not an error");
    assert.deepEqual(loaded.sources, [], "there are no tools yet");

    const html = await renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(!/ENOENT/.test(html), "no errno on the page");
    assert.ok(!/cannot read canonical mcp\.json/.test(html), "no path-and-errno message");
    assert.ok(html.includes(translations["botbuilder.abNoToolsYet"].en), "the friendly empty state");
    assert.match(html, /data-testid="no-tools-yet"/);

    const es = await renderAbilities({ def, lang: "es", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(es.includes(translations["botbuilder.abNoToolsYet"].es), "es empty state");

    // A REAL error stays an error — in plain words, with the detail kept for the
    // operator. The damaged-file shape is exactly what loadSources hands the page
    // (probeAll's _error/_code, re-worded from a file that is there but wrong).
    _setSourcesForTest({ error: "canonical mcp.json is not valid JSON: Unexpected token n in JSON", errorCode: "EJSON", sources: [] });
    const errHtml = await renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(errHtml.includes(translations["botbuilder.abProbeErrorDamaged"].en), "a damaged file is still an error, in plain words");
    assert.ok(errHtml.includes("canonical mcp.json is not valid JSON"), "the detail is kept, muted, for the operator");
    assert.ok(!errHtml.includes(translations["botbuilder.abNoToolsYet"].en), "and it is not disguised as an empty state");
    _setSourcesForTest({ error: "cannot read canonical mcp.json at /home/alex/.pi/agent/mcp.json: EACCES: permission denied", errorCode: "EACCES", sources: [] });
    const permHtml = await renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", crowHome });
    assert.ok(permHtml.includes(translations["botbuilder.abProbeErrorNoAccess"].en), "an unreadable file names the permission problem");
  } finally {
    _setSourcesForTest(null);
    rmScratch(crowHome);
  }
});