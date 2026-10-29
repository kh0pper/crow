/**
 * The mascot sheet's "Needs attention" group (R1.2 spec §13, Task 2): the
 * markup (attention.js), the fragment route, the count route's `attention`
 * field, the sheet's empty slot and the strings.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionGroupHtml } from "../servers/gateway/dashboard/shell/attention.js";
import { shellAvatarSheet } from "../servers/gateway/dashboard/shell/chrome.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const dir = mkdtempSync(join(tmpdir(), "shell-attention-"));
process.env.CROW_DATA_DIR = dir;
mkdirSync(join(dir, "home"), { recursive: true });
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;

const WARN = { id: "disk", severity: "warn", label: "Disk is almost full", actionLabel: "Open storage", actionHref: "/dashboard/settings?section=storage", ack: null };
const BACKUP = { id: "backup", severity: "info", label: "No backup yet", actionLabel: "Run backup now", actionHref: "/dashboard/nest?action=backup", ack: null };
const FOREIGN = { id: "exposure:foreign:127.0.0.1:3008", severity: "warn", label: "Another service is public", actionLabel: "Review access", actionHref: "/dashboard/settings?section=integrations", ack: { kind: "exposure-foreign", key: "127.0.0.1:3008|/s,/s-assets" } };

let server, base, countServer, countBase, signalsMode = "ok";

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { default: express } = await import("express");
  const { healthAttentionRouter } = await import("../servers/gateway/dashboard/panels/health.js");
  const { createDbClient } = await import("../servers/db.js");
  const app = express();
  app.use(healthAttentionRouter({ createDbClient }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;

  const { default: notificationsRouter } = await import("../servers/gateway/routes/notifications.js");
  const app2 = express();
  app2.use(notificationsRouter((req, res, next) => next(), {
    collectSignals: async () => {
      if (signalsMode === "throw") throw new Error("signals down");
      return { issues: [WARN, BACKUP, FOREIGN] };
    },
  }));
  await new Promise((r) => { countServer = app2.listen(0, "127.0.0.1", r); });
  countBase = "http://127.0.0.1:" + countServer.address().port;
});
after(() => { if (server) server.close(); if (countServer) countServer.close(); rmSync(dir, { recursive: true, force: true }); });

test("empty issues render nothing", () => {
  assert.equal(attentionGroupHtml([], "en"), "");
  assert.equal(attentionGroupHtml(undefined, "en"), "");
});

test("rows keep dot, label and action", () => {
  const html = attentionGroupHtml([WARN, { ...BACKUP, actionLabel: "", actionHref: "" }], "en");
  assert.equal((html.match(/class="shell-attn-row"/g) || []).length, 2);
  assert.match(html, /shell-attn-dot--warn/);
  assert.match(html, /shell-attn-dot--info/);
  assert.match(html, /<span class="shell-attn-text">Disk is almost full<\/span>/);
  assert.match(html, /<a class="shell-attn-action" href="\/dashboard\/settings\?section=storage">Open storage<\/a>/);
  assert.match(html, /Needs attention/);
});

test("fragment escapes labels", async () => {
  const evil = { id: "x", severity: "warn", label: "<img src=x onerror=alert(1)>", actionLabel: "\"><b>go</b>", actionHref: "/x\" onclick=\"y", ack: { kind: "exposure-foreign", key: "k\"><i>" } };
  const html = attentionGroupHtml([evil], "en", "/dashboard/attention?a=\"<");
  assert.doesNotMatch(html, /<img|<b>|<i>|onclick="y/);
  assert.match(html, /&lt;img/);
});

test("backup issue keeps its POST form", () => {
  const html = attentionGroupHtml([BACKUP], "en");
  assert.match(html, /<form class="shell-attn-form" method="POST" action="\/dashboard\/nest\/backup">/);
  assert.match(html, /<button class="shell-attn-btn" type="submit">Run backup now<\/button>/);
  assert.doesNotMatch(html, /href="\/dashboard\/nest\?action=backup"/);
});

test("ack button posts kind and key", () => {
  const html = attentionGroupHtml([FOREIGN, WARN], "en", "/dashboard/attention");
  assert.equal((html.match(/action="\/dashboard\/health\/ack"/g) || []).length, 1, "only the issue with ack gets the button");
  assert.match(html, /name="kind" value="exposure-foreign"/);
  assert.match(html, /name="key" value="127\.0\.0\.1:3008\|\/s,\/s-assets"/);
  assert.match(html, /name="back" value="\/dashboard\/attention"/);
  assert.match(html, /name="_csrf" value=""/);
  assert.match(html, /This is expected/);
  assert.match(attentionGroupHtml([FOREIGN], "es"), /Esto es lo esperado/);
});

test("the fragment route is no-store HTML", async () => {
  const r = await fetch(base + "/dashboard/attention/fragment", { redirect: "manual" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type"), /text\/html/);
  await r.text();
});

test("count adds attention", async () => {
  signalsMode = "ok";
  const j = await (await fetch(countBase + "/api/notifications/count")).json();
  assert.equal(j.attention, 3);
  assert.equal(typeof j.count, "number");
});

test("count survives a signals failure", async () => {
  signalsMode = "throw";
  const r = await fetch(countBase + "/api/notifications/count");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.attention, 0);
  assert.equal(typeof j.count, "number");
});

test("the merged sheet has an empty attention slot before the tray; the plain one has none", () => {
  const merged = shellAvatarSheet({ lang: "en", tray: "<div>TRAY</div>" });
  const slot = merged.indexOf("data-shell-attention");
  assert.ok(slot > 0 && slot < merged.indexOf("TRAY"));
  assert.match(merged, /<section class="shell-attention" data-shell-attention aria-live="polite"><\/section>/);
  assert.doesNotMatch(shellAvatarSheet({ lang: "en" }), /data-shell-attention/);
});

test("en and es strings", () => {
  assert.equal(t("shell.attention", "en"), "Needs attention");
  assert.equal(t("shell.attention", "es"), "Necesita atención");
  assert.equal(t("signals.ack.expected", "en"), "This is expected");
});
