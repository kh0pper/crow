/**
 * bundle-pull-alert.test.js — security audit N1c-7.
 *
 * A failed `docker compose pull` during an install used to be a job-log line and
 * nothing else. It now rings the in-app bell: type `system`, a FIXED message that
 * names the bundle, no command output (it can carry registry URLs and proxy
 * credentials), and at most one bell per bundle per 24 h.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PULL_ALERT_COOLDOWN_MS,
  notifyImagePullFailure,
  pullAlertSettingKey,
  reportImagePullFailure,
  bundlePageUrl,
} from "../servers/gateway/bundle-pull-alert.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/** dashboard_settings stub: SELECT reads the marker, INSERT/UPDATE writes it. */
function makeDb() {
  const rows = new Map();
  return {
    rows,
    db: {
      execute: async ({ sql, args = [] }) => {
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
  const notify = async (db, opts) => { calls.push(opts); return { id: calls.length }; };
  return { calls, notify };
};

test("one bell, type system, fixed text naming the bundle, no command output, links to the bundle's page", async () => {
  const { db, rows } = makeDb();
  const { calls, notify } = makeNotify();
  await notifyImagePullFailure({ db, bundleId: "navidrome", bundleName: "Navidrome", nowMs: NOW, notify });

  assert.equal(calls.length, 1);
  const n = calls[0];
  assert.equal(n.type, "system");
  assert.equal(n.source, "bundle-installer");
  assert.equal(n.title, t("bundles.imagePullFailed.title", "en").replace("{name}", "Navidrome"));
  assert.match(n.title, /Navidrome/);
  assert.equal(n.body, t("bundles.imagePullFailed.body", "en"), "the body is the fixed sentence, never the command's output");
  assert.equal(n.action_url, bundlePageUrl("navidrome"));
  assert.equal(n.action_url, "/dashboard/extensions?q=navidrome");
  assert.equal(n.metadata.kind, "bundle-image-pull");
  assert.equal(n.metadata.bundle, "navidrome");
  assert.ok(rows.has(pullAlertSettingKey("navidrome")), "the cooldown marker is stamped");
});

test("dedupe: a second failure inside 24 h is silent, the next one after it rings again", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();

  await notifyImagePullFailure({ db, bundleId: "plex", nowMs: NOW, notify });
  await notifyImagePullFailure({ db, bundleId: "plex", nowMs: NOW + HOUR, notify });
  assert.equal(calls.length, 1, "one bell per bundle per window");

  // Another bundle is its own window.
  await notifyImagePullFailure({ db, bundleId: "jellyfin", nowMs: NOW + 2 * HOUR, notify });
  assert.equal(calls.length, 2);

  await notifyImagePullFailure({ db, bundleId: "plex", nowMs: NOW + PULL_ALERT_COOLDOWN_MS, notify });
  assert.equal(calls.length, 3, "the window reopening rings again");
});

test("an unreadable marker rings rather than staying silent", async () => {
  const db = { execute: async ({ sql }) => { if (/SELECT/i.test(sql)) throw new Error("no such table"); return { rows: [] }; } };
  const { calls, notify } = makeNotify();
  await notifyImagePullFailure({ db, bundleId: "kavita", nowMs: NOW, notify });
  assert.equal(calls.length, 1);
});

test("never throws: a notify failure or a missing db leaves the install path alone", async () => {
  const { db } = makeDb();
  const broken = async () => { throw new Error("bell is broken"); };
  assert.equal(await notifyImagePullFailure({ db, bundleId: "romm", nowMs: NOW, notify: broken, log: { warn() {} } }), null);
  assert.equal(await notifyImagePullFailure({ db: null, bundleId: "romm", notify: broken }), null);
  assert.equal(await notifyImagePullFailure({ db, bundleId: "", notify: broken }), null);
});

test("reportImagePullFailure owns and closes its database client", async () => {
  const { db } = makeDb();
  const { calls, notify } = makeNotify();
  let closed = 0;
  const row = await reportImagePullFailure({
    bundleId: "wallabag",
    dbFactory: () => ({ ...db, close: () => { closed++; } }),
    notify,
    nowMs: NOW,
    log: { warn() {} },
  });
  assert.ok(row, "the bell row comes back");
  assert.equal(calls.length, 1);
  assert.equal(closed, 1, "the client it opened is closed again");

  // A factory that throws must not escape into the install job.
  assert.equal(await reportImagePullFailure({ bundleId: "wallabag", dbFactory: () => { throw new Error("db down"); }, log: { warn() {} } }), null);
});

test("the bell reads the dashboard language", async () => {
  const { db, rows } = makeDb();
  rows.set("language", "es");
  const { calls, notify } = makeNotify();
  await notifyImagePullFailure({ db, bundleId: "trilium", bundleName: "TriliumNext", nowMs: NOW, notify });
  assert.equal(calls[0].title, "No se pudieron descargar las imágenes de TriliumNext");
});