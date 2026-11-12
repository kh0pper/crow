/**
 * N3-4 phase 1 — the "finish this app's setup now" notice: which installed apps
 * need one, the operator's Done marker, and the ONE bell per install.
 *
 * Fails on the code before this change: nothing read `firstAdmin` at all, no
 * `dashboard_settings` marker existed for either half, and an install of a
 * bundle whose own first-run page anyone can claim announced itself nowhere (the
 * install job's log line said "Installed: …", and that was it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstAdminOf,
  firstAdminNeedsOperator,
  firstAdminNeedsNotice,
  firstAdminTitle,
  firstAdminBody,
  firstAdminLink,
  pendingFirstAdminNotices,
  firstAdminDoneValues,
  markFirstAdminDone,
  notifyFirstAdmin,
  reportFirstAdminNotice,
  firstAdminDoneKey,
  firstAdminNoticeKey,
} from "../servers/gateway/bundle-first-admin.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";
import { firstAdminAfterFailureSentence, applyFirstAdminAfter } from "../servers/gateway/bundle-first-admin-after.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const INSTALL_A = "2026-11-01T10:00:00.000Z";
const INSTALL_B = "2026-11-05T09:00:00.000Z";

const FINISH = { id: "kuma", name: "Uptime Kuma", webUI: { port: 3007, path: "/", label: "Uptime Kuma" }, firstAdmin: { mode: "finish-setup" } };
const DEFAULT_LOGIN = {
  id: "eye", name: "motionEye", webUI: { port: 8765, path: "/", label: "motionEye" },
  firstAdmin: { mode: "default-login", user: "admin", note: "It starts with an empty password; set one now." },
};
const CROW = {
  id: "flux", name: "Miniflux", webUI: { port: 8085, path: "/", label: "Miniflux" },
  firstAdmin: { mode: "crow", via: "env", secretEnv: "MINIFLUX_ADMIN_PASSWORD" },
  env_vars: [{ name: "MINIFLUX_ADMIN_PASSWORD", generate: "secret", keychain: true, secret: true }],
};
const NO_LOGIN = { id: "dx", name: "Dozzle", webUI: { port: 8095, path: "/", label: "Dozzle" }, firstAdmin: { mode: "none" } };
const EXTERNAL = { id: "kodi", name: "Kodi", webUI: { port: 8080, path: "/", label: "Kodi" }, firstAdmin: { mode: "external" } };
const DIRECT = {
  id: "stash", name: "Unsloth Studio",
  webUI: { port: 3075, path: "/", label: "Unsloth Studio", proxyMode: "direct" },
  firstAdmin: { mode: "finish-setup" },
};

// ── the pure half: what the manifest means ──

test("firstAdminOf normalizes, and refuses a mode the schema does not know", () => {
  assert.deepEqual(firstAdminOf(DEFAULT_LOGIN), { mode: "default-login", path: null, user: "admin", note: "It starts with an empty password; set one now." });
  assert.equal(firstAdminOf({ firstAdmin: { mode: "nope" } }), null);
  assert.equal(firstAdminOf({}), null, "an old manifest declares nothing");
  assert.equal(firstAdminOf(null), null);
  assert.equal(firstAdminOf({ firstAdmin: { mode: "none", path: "admin" } }).path, null, "a path that is not one is dropped");
});

test("only finish-setup, default-login and the undeclared fallback need the operator", () => {
  assert.equal(firstAdminNeedsOperator(FINISH), true);
  assert.equal(firstAdminNeedsOperator(DEFAULT_LOGIN), true);
  assert.equal(firstAdminNeedsOperator(CROW), false, "Crow already made the admin");
  assert.equal(firstAdminNeedsOperator(NO_LOGIN), false);
  assert.equal(firstAdminNeedsOperator(EXTERNAL), false, "connects to the app you already run");
  assert.equal(firstAdminNeedsOperator({}), false);
});

test("a web UI that declares nothing becomes 'undeclared': a card, no claim warning, no bell", () => {
  // A community-store manifest written before the field existed (or a typo'd mode)
  // cannot silence the card by saying nothing — but Crow also will not claim there is an
  // admin account to steal when it has no idea whether the app has a login at all.
  const undeclared = { id: "shop", name: "Shop App", webUI: { port: 9000, path: "/", label: "Shop App" } };
  assert.deepEqual(firstAdminOf(undeclared), { mode: "undeclared", path: null, user: null, note: null });
  assert.equal(firstAdminNeedsOperator(undeclared), true);
  assert.deepEqual(firstAdminOf({ ...undeclared, firstAdmin: { mode: "nope" } }), { mode: "undeclared", path: null, user: null, note: null });
  // `undeclared` is Crow's own internal name: a manifest that declares it declared nothing.
  assert.deepEqual(firstAdminOf({ ...undeclared, firstAdmin: { mode: "undeclared" } }), { mode: "undeclared", path: null, user: null, note: null });
  assert.equal(firstAdminNeedsNotice(undeclared), false, "no bell for a card that may be about nothing");
  const cards = pendingFirstAdminNotices({
    installed: { shop: { installedAt: INSTALL_A } },
    manifests: { shop: undeclared },
    liveProxyIds: ["shop"],
  });
  assert.deepEqual(cards.map((c) => `${c.id}:${c.mode}`), ["shop:undeclared"]);
  // The softer card keeps the whole action set: open the app, save the login you made, Done.
  assert.equal(cards[0].canAuto, false, "Crow has no script to run for an app it does not know");
  assert.equal(cards[0].canSave, true);
  assert.equal(cards[0].canDone, true);
  // No manifest at all is still no card: there is nothing to link or name.
  assert.equal(firstAdminOf(null), null);
});

test("the undeclared card asks instead of warning, and says what to do", () => {
  const shop = { id: "shop", name: "Shop App", webUI: { port: 9000, path: "/", label: "Shop App" } };
  assert.equal(firstAdminTitle("Shop App", "en"), "Finish Shop App's setup now", "the title is unchanged");
  assert.equal(
    firstAdminBody(firstAdminOf(shop), "Shop App", "en"),
    "Crow can't tell whether Shop App has its own login. If it asks you to create an account when you open it, create it now and save it here.",
  );
  assert.notEqual(firstAdminBody(firstAdminOf(shop), "Shop App", "es"), firstAdminBody(firstAdminOf(shop), "Shop App", "en"));
  assert.equal(t("bundles.firstAdmin.undeclaredBody", "en").includes("can claim"), false, "never the claim warning");
});

test("the link is the Nest tile's: /proxy/<id><path>, or the app's own https origin when direct", () => {
  assert.equal(firstAdminLink("kuma", FINISH).href, "/proxy/kuma/");
  assert.equal(firstAdminLink("kuma", { ...FINISH, firstAdmin: { mode: "finish-setup", path: "/setup" } }).href, "/proxy/kuma/setup");
  const direct = firstAdminLink("stash", DIRECT);
  assert.equal(direct.proxyMode, "direct");
  assert.equal(direct.href, "/dashboard/extensions", "no-JS fallback, as on the Nest tile");
  assert.match(direct.onclick, /location\.hostname/, "the host is only known in the browser");
  assert.match(direct.onclick, /3075/);
});

test("title and body are the operator's words, in en and es, note appended", () => {
  assert.equal(firstAdminTitle("Uptime Kuma", "en"), "Finish Uptime Kuma's setup now");
  assert.equal(firstAdminTitle("Uptime Kuma", "es"), "Termina de configurar Uptime Kuma ahora");
  assert.equal(
    firstAdminBody(firstAdminOf(FINISH), "Uptime Kuma", "en"),
    "Until you do, anyone or anything on this machine can claim Uptime Kuma's admin account.",
  );
  assert.equal(
    firstAdminBody(firstAdminOf(DEFAULT_LOGIN), "motionEye", "en"),
    "motionEye starts with a known login (user admin). Change the password now. It starts with an empty password; set one now.",
  );
  assert.match(firstAdminBody(firstAdminOf(DIRECT), "Unsloth Studio", "es"), /Unsloth Studio/);
  assert.equal(firstAdminBody(firstAdminOf(CROW), "Miniflux", "en"), null);
});

test("a placeholder inside the app's own name is not substituted twice", () => {
  // One pass only: the name is inserted verbatim, so an app called "App {user}"
  // does not become "App admin" (review round 1, N6).
  assert.equal(
    firstAdminBody(firstAdminOf({ firstAdmin: { mode: "default-login", user: "admin" } }), "App {user}", "en"),
    "App {user} starts with a known login (user admin). Change the password now.",
  );
});

// ── the card list: shown / hidden, and the restart wording ──

test("a finish-setup and a default-login install each get a card; crow and none get none", () => {
  const installed = {
    kuma: { installedAt: INSTALL_A },
    eye: { installedAt: INSTALL_A },
    flux: { installedAt: INSTALL_A },
    dx: { installedAt: INSTALL_A },
  };
  const manifests = { kuma: FINISH, eye: DEFAULT_LOGIN, flux: CROW, dx: NO_LOGIN };
  const cards = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: ["kuma", "eye", "flux", "dx"] });
  assert.deepEqual(cards.map((c) => `${c.id}:${c.mode}`), ["kuma:finish-setup", "eye:default-login"]);
  assert.equal(cards[0].name, "Uptime Kuma");
  assert.equal(cards[1].user, "admin");
  assert.deepEqual(cards.map((c) => c.restartPending), [false, false]);
});

test("a subpath UI with no live /proxy route says 'restart Crow first'; a direct-mode one never does", () => {
  const installed = { kuma: { installedAt: INSTALL_A }, stash: { installedAt: INSTALL_A } };
  const manifests = { kuma: FINISH, stash: DIRECT };
  const cards = pendingFirstAdminNotices({ installed, manifests, liveProxyIds: [] });
  assert.deepEqual(cards.map((c) => c.restartPending), [true, false]);
  assert.deepEqual(cards.map((c) => c.linkUnavailable), [false, false]);
  // The sentence itself, in both languages.
  assert.equal(t("bundles.firstAdmin.restartFirst", "en"), "Restart Crow first, then open it");
  assert.notEqual(t("bundles.firstAdmin.restartFirst", "es"), t("bundles.firstAdmin.restartFirst", "en"));
});

test("a proxy router that failed to mount is not a restart: the card says the link is unavailable", () => {
  const cards = pendingFirstAdminNotices({
    installed: { kuma: { installedAt: INSTALL_A } },
    manifests: { kuma: FINISH },
    liveProxyIds: [],
    proxyMountFailed: true,
  });
  assert.equal(cards[0].restartPending, false, "a restart cannot mount a router that failed to mount");
  assert.equal(cards[0].linkUnavailable, true);
  assert.equal(t("bundles.firstAdmin.linkUnavailable", "en"), "The app link is unavailable; check the gateway log.");
  assert.notEqual(t("bundles.firstAdmin.linkUnavailable", "es"), t("bundles.firstAdmin.linkUnavailable", "en"));
});

test("Done hides the card for THAT install only; a reinstall asks again", () => {
  const manifests = { kuma: FINISH };
  const done = { kuma: INSTALL_A };
  assert.deepEqual(pendingFirstAdminNotices({ installed: { kuma: { installedAt: INSTALL_A } }, manifests, done }), []);
  const afterReinstall = pendingFirstAdminNotices({ installed: { kuma: { installedAt: INSTALL_B } }, manifests, done });
  assert.equal(afterReinstall.length, 1, "a reinstall's own first-run page is claimable again");
});

test("a satellite-hosted bundle has no local card (its own box owns its setup)", () => {
  const cards = pendingFirstAdminNotices({
    installed: { kuma: { mode: "satellite", host: "peer-1", installedAt: INSTALL_A } },
    manifests: { kuma: FINISH },
  });
  assert.deepEqual(cards, []);
});

test("an installed bundle with no manifest (registry-only entry) gets no card", () => {
  assert.deepEqual(pendingFirstAdminNotices({ installed: { gone: { installedAt: INSTALL_A } }, manifests: {} }), []);
});

// ── the db half: Done marker + the bell ──

/** dashboard_settings stub: SELECT reads a marker, INSERT/UPDATE writes it. */
function makeDb({ failSelect = false } = {}) {
  const rows = new Map();
  return {
    rows,
    db: {
      execute: async ({ sql, args = [] }) => {
        if (/LIKE \?/i.test(sql)) {
          if (failSelect) throw new Error("no such table");
          const prefix = String(args[0] || "").replace(/%$/, "");
          return { rows: [...rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
        }
        if (/SELECT value FROM dashboard_settings/i.test(sql)) {
          const key = /'language'/.test(sql) ? "language" : args[0];
          return { rows: rows.has(key) ? [{ value: rows.get(key) }] : [] };
        }
        if (/INSERT INTO dashboard_settings/i.test(sql)) {
          rows.set(args[0], args[1]);
          return { rows: [], rowsAffected: 1 };
        }
        return { rows: [] };
      },
    },
  };
}

const makeNotify = () => {
  const calls = [];
  const notify = async (_db, opts) => { calls.push(opts); return { id: calls.length }; };
  return { calls, notify };
};

test("one bell per install: same text as the card, links the Extensions detail, never a secret", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  await notifyFirstAdmin({ db, bundleId: "kuma", manifest: FINISH, bundleName: "Uptime Kuma", installId: INSTALL_A, nowMs: NOW, notify });

  assert.equal(calls.length, 1);
  const n = calls[0];
  assert.equal(n.type, "system");
  assert.equal(n.source, "bundle-installer");
  assert.equal(n.title, "Finish Uptime Kuma's setup now");
  assert.equal(n.body, "Until you do, anyone or anything on this machine can claim Uptime Kuma's admin account.");
  assert.equal(n.action_url, "/dashboard/extensions?q=kuma", "the Extensions detail");
  assert.deepEqual(n.metadata, { kind: "bundle-first-admin", bundle: "kuma", mode: "finish-setup" });
});

test("the bell is silent for crow, external and none", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  await notifyFirstAdmin({ db, bundleId: "flux", manifest: CROW, installId: INSTALL_A, notify });
  await notifyFirstAdmin({ db, bundleId: "dx", manifest: NO_LOGIN, installId: INSTALL_A, notify });
  await notifyFirstAdmin({ db, bundleId: "kodi", manifest: EXTERNAL, installId: INSTALL_A, notify });
  await notifyFirstAdmin({ db, bundleId: "old", manifest: {}, installId: INSTALL_A, notify });
  assert.equal(calls.length, 0);
});

test("an undeclared web UI install gets its card but rings NO bell", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  const undeclared = { id: "shop", name: "Shop App", webUI: { port: 9000, path: "/", label: "Shop App" } };
  assert.equal(await notifyFirstAdmin({ db, bundleId: "shop", manifest: undeclared, installId: INSTALL_A, notify }), null);
  assert.equal(calls.length, 0, "Crow cannot prove there is an account to claim, so it does not alarm");
});

test("a second install of the same bundle rings again; the same install never rings twice", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  await notifyFirstAdmin({ db, bundleId: "kuma", manifest: FINISH, installId: INSTALL_A, notify });
  await notifyFirstAdmin({ db, bundleId: "kuma", manifest: FINISH, installId: INSTALL_A, notify });
  assert.equal(calls.length, 1, "one per install");
  await notifyFirstAdmin({ db, bundleId: "kuma", manifest: FINISH, installId: INSTALL_B, notify });
  assert.equal(calls.length, 2, "a reinstall after an uninstall may ring again");
  // Another bundle is its own install.
  await notifyFirstAdmin({ db, bundleId: "eye", manifest: DEFAULT_LOGIN, installId: INSTALL_A, notify });
  assert.equal(calls.length, 3);
});

test("an unreadable marker rings rather than staying silent; a broken bell never throws", async () => {
  const { db } = makeDb({ failSelect: true });
  const { calls, notify } = makeNotify();
  await notifyFirstAdmin({ db, bundleId: "kuma", manifest: FINISH, installId: INSTALL_A, notify });
  assert.equal(calls.length, 1);

  const broken = async () => { throw new Error("bell is broken"); };
  const ok2 = makeDb();
  assert.equal(await notifyFirstAdmin({ db: ok2.db, bundleId: "kuma", manifest: FINISH, installId: INSTALL_A, notify: broken, log: { warn() {} } }), null);
  assert.equal(await notifyFirstAdmin({ db: null, bundleId: "kuma", manifest: FINISH, notify: broken }), null);
});

test("the bell follows the dashboard language", async () => {
  const { db, rows } = makeDb();
  rows.set("language", "es");
  const { calls, notify } = makeNotify();
  await notifyFirstAdmin({ db, bundleId: "kuma", manifest: FINISH, bundleName: "Uptime Kuma", installId: INSTALL_A, notify });
  assert.equal(calls[0].title, "Termina de configurar Uptime Kuma ahora");
});

test("reportFirstAdminNotice owns and closes its client, and returns early for crow/none", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  let closed = 0;
  const factory = () => ({ ...db, close: () => { closed++; } });
  const row = await reportFirstAdminNotice({ bundleId: "kuma", manifest: FINISH, installId: INSTALL_A, dbFactory: factory, notify, log: { warn() {} } });
  assert.ok(row);
  assert.equal(calls.length, 1);
  assert.equal(closed, 1);

  assert.equal(await reportFirstAdminNotice({ bundleId: "flux", manifest: CROW, installId: INSTALL_A, dbFactory: () => { throw new Error("never opened"); } }), null);
  assert.equal(await reportFirstAdminNotice({ bundleId: "kuma", manifest: FINISH, dbFactory: () => { throw new Error("db down"); }, log: { warn() {} } }), null);
});

/** A crow/via-setup manifest: the only shape that can carry an after-step. */
const SETUP = {
  id: "vik", name: "Vikunja", webUI: { port: 3456, path: "/", label: "Vikunja" },
  firstAdmin: {
    mode: "crow", via: "setup", user: "admin", secretEnv: "VIK_ADMIN_PASSWORD",
    setup: { script: "scripts/first-admin.sh", timeout_s: 30, after: { env: { VIK_CLOSE_SIGNUPS: "false" }, recreate: true } },
  },
  env_vars: [{ name: "VIK_CLOSE_SIGNUPS", default: "true" }],
};
const AFTER_FAILED = { ok: false, outcome: "recreate-failed: port is already allocated" };

test("a failed after-step rings once with the press-Restart sentence; ok or absent stays silent", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();

  // The setup run was ok and so was the follow-up: silence, as before the step existed.
  assert.equal(await notifyFirstAdmin({ db, bundleId: "vik", manifest: SETUP, installId: INSTALL_A, autoResult: "ok", afterResult: { ok: true, outcome: "applied" }, notify }), null);
  // No after-step at all: unchanged too.
  assert.equal(await notifyFirstAdmin({ db, bundleId: "vik", manifest: SETUP, installId: INSTALL_A, autoResult: "ok", notify }), null);
  assert.equal(calls.length, 0);

  // The account exists but Crow could not close registration: the owner hears about it.
  const row = await notifyFirstAdmin({ db, bundleId: "vik", manifest: SETUP, bundleName: "Vikunja", installId: INSTALL_A, autoResult: "ok", afterResult: AFTER_FAILED, notify });
  assert.ok(row);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, firstAdminAfterFailureSentence("Vikunja"));
  assert.match(calls[0].body, /registration may still be open: press Restart on the Extensions card/);
  assert.equal(calls[0].action_url, "/dashboard/extensions?q=vik", "the Extensions detail, as its other notices");
  assert.equal(calls[0].type, "system");
  assert.equal(calls[0].source, "bundle-installer");
  assert.deepEqual(calls[0].metadata, { kind: "bundle-first-admin", bundle: "vik", mode: "crow" });
  assert.equal(String(calls[0].body).includes("password"), false, "never the password");

  // Same install: never a second bell, whatever the next call says.
  await notifyFirstAdmin({ db, bundleId: "vik", manifest: SETUP, bundleName: "Vikunja", installId: INSTALL_A, autoResult: "ok", afterResult: AFTER_FAILED, notify });
  assert.equal(calls.length, 1, "one per install");
  // A new install asks again.
  await notifyFirstAdmin({ db, bundleId: "vik", manifest: SETUP, bundleName: "Vikunja", installId: INSTALL_B, autoResult: "ok", afterResult: AFTER_FAILED, notify });
  assert.equal(calls.length, 2);
});

test("reportFirstAdminNotice carries the after-step's failure through to the bell", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  const row = await reportFirstAdminNotice({
    bundleId: "vik", manifest: SETUP, bundleName: "Vikunja", installId: INSTALL_A,
    autoResult: "ok", afterResult: { ok: false, outcome: "env-failed: EACCES" },
    dbFactory: () => ({ ...db, close() {} }), notify, log: { warn() {} },
  });
  assert.ok(row);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, firstAdminAfterFailureSentence("Vikunja"));

  // The shape applyFirstAdminAfter really returns, over its seams.
  const failed = await applyFirstAdminAfter({
    bundleId: "vik", manifest: SETUP, destDir: "/tmp/vik",
    writeEnv: () => {}, recreate: async () => ({ ok: false, reason: "port is already allocated" }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.outcome, /^recreate-failed: /);
  const ok = await applyFirstAdminAfter({ bundleId: "vik", manifest: SETUP, destDir: "/tmp/vik", writeEnv: () => {}, recreate: async () => ({ ok: true }) });
  assert.deepEqual({ ok: ok.ok, outcome: ok.outcome }, { ok: true, outcome: "applied" });
});

test("Done writes this install's stamp, and firstAdminDoneValues reads every marker back", async () => {
  const { db, rows } = makeDb();
  const stamp = await markFirstAdminDone(db, "kuma", INSTALL_A);
  assert.equal(stamp, INSTALL_A);
  assert.equal(rows.get(firstAdminDoneKey("kuma")), INSTALL_A);
  await markFirstAdminDone(db, "eye", INSTALL_B);
  assert.deepEqual(await firstAdminDoneValues(db), { kuma: INSTALL_A, eye: INSTALL_B });

  // No install id (an old installed.json): a timestamp still records the word.
  const fallback = await markFirstAdminDone(db, "dx", null, { nowMs: NOW });
  assert.equal(fallback, new Date(NOW).toISOString());

  // Unreadable table: no markers rather than a broken page (the card shows).
  assert.deepEqual(await firstAdminDoneValues(makeDb({ failSelect: true }).db), {});
  assert.deepEqual(await firstAdminDoneValues(null), {});
});

test("both markers are local-only settings keys", async () => {
  const { isSyncable, isInstanceScope } = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
  for (const key of [firstAdminDoneKey("kuma"), firstAdminNoticeKey("kuma")]) {
    assert.equal(isSyncable(key), false, `${key} must never replicate to a paired instance`);
    assert.equal(isInstanceScope(key), true, `${key} is per-install state`);
  }
});
