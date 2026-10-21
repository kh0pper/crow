/**
 * Settings menu regrouped by user goal (model-roles-and-settings redesign, spec §10).
 * Advanced is collapsed; multi-instance pages stay hidden until a second Crow is paired.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "settings-menu-groups-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") },
    stdio: "pipe", cwd: REPO_ROOT,
  });
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_DB_PATH = join(dir, "crow.db");
}

async function setup() {
  freshDb();
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  const panel = (await import("../servers/gateway/dashboard/panels/settings.js")).default;
  const reg = await import("../servers/gateway/dashboard/settings/registry.js");
  const { renderSettingsMenu } = await import("../servers/gateway/dashboard/settings/menu-renderer.js");
  return { db, panel, reg, renderSettingsMenu };
}

const hasRow = (html, id) => html.includes(`href="/dashboard/settings?section=${id}"`);

test("GROUPS keys and order follow the goal-based menu", async () => {
  const { reg } = await setup();
  const keys = Object.keys(reg.GROUPS).sort((a, b) => reg.GROUPS[a].order - reg.GROUPS[b].order);
  assert.deepEqual(keys, ["ai", "voice", "accounts", "devices", "security", "backup", "appearance", "blog", "otherCrows", "advanced"]);
});

test("legacy add-on group names are aliased, not dropped", async () => {
  const { reg } = await setup();
  const map = { general: "appearance", connections: "accounts", content: "blog", multiInstance: "otherCrows", system: "advanced", account: "security" };
  for (const [old, now] of Object.entries(map)) {
    const id = `legacy-test-${old}`;
    reg.registerSettingsSection({ id, group: old, labelKey: "settings.section.blog", render: async () => "" });
    assert.equal(reg.getSettingsSection(id).group, now);
  }
});

test("no peer: Other Crows shows only 'Pair another Crow'; Advanced is collapsed", async () => {
  const { db, reg, renderSettingsMenu } = await setup();
  const html = await renderSettingsMenu(reg.getSettingsSections(), db, "en");
  for (const id of ["unified-dashboard", "other-crows-sharing", "remote-exposure", "remote-invocation", "remote-bot-management", "theme"]) {
    assert.ok(!hasRow(html, id), `${id} row hidden`);
  }
  assert.ok(html.includes("Pair another Crow"));
  const pair = html.match(/href="\/dashboard\/settings\?section=paired-instances"[^>]*>[\s\S]*?<\/a>/);
  assert.ok(pair && pair[0].includes("Pair another Crow"), "single pair row links to paired-instances");
  assert.match(html, /<details class="settings-group settings-advanced">/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  const adv = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
  for (const id of ["ports", "device-context", "shared-context", "data-hygiene", "sync-conflicts", "audit-log", "shared-storage", "bot-runtime"]) {
    assert.ok(hasRow(adv, id), `${id} inside Advanced`);
  }
  assert.ok(html.includes("Saved passwords &amp; keys") || html.includes("Saved passwords & keys"));
});

test("trusted peer: paired-instances, other-crows-sharing and unified-dashboard rows appear", async () => {
  const { db, reg, renderSettingsMenu } = await setup();
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  const { hasTrustedPeer } = await import("../servers/gateway/dashboard/settings/menu-renderer.js");
  assert.equal(await hasTrustedPeer(db), false);
  await db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, 'me', 'crow:a', 'active', 1)", args: [getOrCreateLocalInstanceId()] });
  assert.equal(await hasTrustedPeer(db), false, "self row is not a peer");
  await db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted) VALUES ('peer-1', 'other', 'crow:b', 'active', 1)", args: [] });
  assert.equal(await hasTrustedPeer(db), true);
  const html = await renderSettingsMenu(reg.getSettingsSections(), db, "en");
  assert.ok(hasRow(html, "paired-instances"));
  assert.ok(hasRow(html, "other-crows-sharing"));
  assert.ok(hasRow(html, "unified-dashboard"));
  assert.ok(!html.includes("Pair another Crow"));
});

test("every audit deep link still resolves to a section or a live redirect", async () => {
  const { db, panel, reg } = await setup();
  const ids = ["two-factor", "sync-conflicts", "paired-instances", "nav-groups", "password", "integrations", "connections", "passwords", "notifications", "updates", "theme", "bot-runtime", "data-hygiene", "discovery", "blog", "help-setup", "remote-exposure", "remote-invocation", "remote-bot-management", "unified-dashboard", "llm", "other-crows-sharing"];
  for (const id of ids) {
    let redirected = null, laidOut = null;
    const res = { redirect: (u) => { redirected = u; }, redirectAfterPost: (u) => { redirected = u; }, status() { return this; }, setHeader() {}, set() {}, locals: {} };
    const req = { method: "GET", query: { section: id }, body: {}, headers: {}, get: () => "" };
    await panel.handler(req, res, { db, lang: "en", layout: ({ title, content }) => { laidOut = { title, content }; return "<html>" + content + "</html>"; } });
    if (redirected) {
      const target = new URL(redirected, "http://x").searchParams.get("section");
      assert.ok(target && reg.getSettingsSection(target), `${id} redirected to live section (${redirected})`);
    } else {
      assert.ok(laidOut && laidOut.content.length > 0, `${id} rendered`);
    }
  }
});

test("other-crows-sharing renders the three remote forms and delegates their actions", async () => {
  const { reg, db } = await setup();
  const s = reg.getSettingsSection("other-crows-sharing");
  assert.ok(s);
  const html = await s.render({ req: {}, res: {}, db, lang: "en" });
  for (const a of ["set_remote_exposure", "set_remote_invocation", "set_remote_bot_management"]) {
    assert.ok(html.includes(`value="${a}"`), `${a} form present`);
  }
  assert.equal(await s.handleAction({ req: { body: {} }, res: {}, db, action: "nonsense" }), false);
  for (const id of ["remote-exposure", "remote-invocation", "remote-bot-management"]) {
    assert.equal(reg.getSettingsSection(id).hidden, true);
  }
});

test("blog settings links to the blog theme; passwords label renamed; es parity", async () => {
  const { reg, db } = await setup();
  const html = await reg.getSettingsSection("blog").render({ db, lang: "en" });
  assert.ok(html.includes("section=theme"));
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.equal(t("settings.section.passwords", "en"), "Saved passwords & keys");
  assert.equal(t("settings.section.passwords", "es"), "Contraseñas y claves guardadas");
  for (const k of ["ai", "voice", "accounts", "devices", "security", "backup", "appearance", "blog", "otherCrows", "advanced"]) {
    for (const lang of ["en", "es"]) assert.ok(t(`settings.group.${k}`, lang) && !t(`settings.group.${k}`, lang).startsWith("settings."), `${k} ${lang}`);
  }
  for (const lang of ["en", "es"]) {
    assert.ok(t("settings.pairAnotherCrow", lang).length > 0);
    assert.ok(t("settings.section.otherCrowsSharing", lang).length > 0);
  }
});

test("hasTrustedPeer: untrusted, revoked, paused and self rows are not peers; offline trusted is", async () => {
  const { db } = await setup();
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  const { hasTrustedPeer } = await import("../servers/gateway/dashboard/settings/menu-renderer.js");
  const ins = (id, status, trusted) => db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, ?, ?)", args: [id, id, `crow:${id}`, status, trusted] });
  await ins(getOrCreateLocalInstanceId(), "active", 1);
  await ins("p-untrusted", "active", 0);
  await ins("p-revoked", "revoked", 1);
  await ins("p-paused", "paused", 1);
  assert.equal(await hasTrustedPeer(db), false);
  await ins("p-offline", "offline", 1);
  assert.equal(await hasTrustedPeer(db), true);
});

test("sections with no group or an unknown group render under Advanced", async () => {
  const { db, reg, renderSettingsMenu } = await setup();
  reg.registerSettingsSection({ id: "no-group-test", labelKey: "settings.section.blog", render: async () => "" });
  reg.registerSettingsSection({ id: "bogus-group-test", group: "bogus", labelKey: "settings.section.blog", render: async () => "" });
  const html = await renderSettingsMenu(reg.getSettingsSections(), db, "en");
  const adv = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
  assert.ok(hasRow(adv, "no-group-test"));
  assert.ok(hasRow(adv, "bogus-group-test"));
});

test("the companion bundle's settings section is in the voice group", async () => {
  const { reg } = await setup();
  const mod = (await import("../bundles/companion/settings-section.js")).default;
  reg.registerSettingsSection(mod);
  assert.equal(reg.getSettingsSection(mod.id).group, "voice");
});

test("POST from the combined Sharing page stays on it; POST without a section is still dispatched", async () => {
  const { db, panel } = await setup();
  const run = async (query) => {
    let redirected = null;
    const res = { redirect: (u) => { redirected = u; }, redirectAfterPost: (u) => { redirected = u; }, locals: {} };
    const req = { method: "POST", query, body: { action: "set_remote_invocation", enabled: "on" }, headers: {}, get: () => "" };
    await panel.handler(req, res, { db, lang: "en", layout: () => "" });
    return redirected;
  };
  assert.equal(await run({ section: "other-crows-sharing" }), "/dashboard/settings?section=other-crows-sharing");
  assert.equal(await run({}), "/dashboard/settings?section=remote-invocation");
});
