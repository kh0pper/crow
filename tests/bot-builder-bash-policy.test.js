/**
 * Bot Builder › Abilities › Run commands: Off / Ask me first / Auto (+ the
 * Advanced command list), on the simplified editor.
 *
 *   - Ask me / Auto are live and save through the one owner-save funnel,
 *     which runs the shared validator (policy-guard → validatePermissionPolicy);
 *   - Perch-only (Kevin's ruling 2026-10-08): a bot that also answers on
 *     another channel cannot pick them — the page says why, and the guard
 *     refuses them even for a crafted post or a stored value;
 *   - the env-scrub switch refuses a shell on the owner save path;
 *   - with Auto, the status line says where commands are checked, or that
 *     no safety check is installed (with the catalog size);
 *   - a stored "sandbox" shows Off with a one-click owner offer to switch to
 *     Auto (confirm_sandbox_auto, through the same guard);
 *   - peer patches: bash validated, classifier never patchable, only tighten.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-bash-policy-"));
process.env.CROW_DATA_DIR = dir;
delete process.env.CROW_BOT_ENV_PASSTHROUGH;

let db, handleBotBuilderPost, renderBotEditor, applyPeerPatch, getClassifierStatus, _setSourcesForTest, OWN;

const PERCH = { models: {}, tools: { pi_builtin: ["read"] }, gateways: [{ type: "perch" }], permission_policy: { bash: "deny", write_paths: [] } };
const NOGW = { models: {}, tools: { pi_builtin: ["read"] }, permission_policy: { bash: "deny", write_paths: [] } };
const GMAIL = { models: {}, tools: { pi_builtin: ["read"] }, gateways: [{ type: "gmail", address: "bot@example.com", allowlist: ["alex@example.com"] }],
  permission_policy: { bash: "deny", write_paths: [] } };

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  ({ applyPeerPatch } = await import("../servers/gateway/bot-federation.js"));
  ({ getClassifierStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/classifier-status.js"));
  ({ _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js"));
  _setSourcesForTest({ error: null, sources: [] });
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  OWN = getOrCreateLocalInstanceId();
});
after(async () => { _setSourcesForTest(null); try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const mkRes = () => { const r = { html: null, redirected: null }; r.send = (s) => { r.html = s; return r; }; r.redirectAfterPost = (u) => { r.redirected = u; }; return r; };
async function putBot(id, def, name = id) {
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id=?", args: [id] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)", args: [id, name, JSON.stringify(def)] });
}
const readDef = async (id) => JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0].definition);
const post = async (body) => { const res = mkRes(); await handleBotBuilderPost({ body, headers: {}, cookies: {} }, res, { db }); return res; };
const setCmd = (id, mode, was) => post({ action: "save_abilities", bot_id: id, cmd_mode: mode, cmd_mode__was: was });
const render = async (id, lang = "en") => {
  const res = mkRes();
  const q = { bot: id, tab: "abilities" };
  await renderBotEditor({ method: "GET", query: q, body: {}, cookies: {}, headers: {} }, res, { db, layout: ({ content }) => content, lang, PAGE_CSS: "", botId: id, notice: "", q });
  return res.html;
};
const withPassthrough = async (fn) => { process.env.CROW_BOT_ENV_PASSTHROUGH = "1"; try { return await fn(); } finally { delete process.env.CROW_BOT_ENV_PASSTHROUGH; } };

test("Perch bot: Ask me and Auto save, add bash to the builtins; Off removes it", async () => {
  await putBot("p1", PERCH);
  assert.match((await setCmd("p1", "ask", "off")).redirected, /saved=1/);
  let d = await readDef("p1");
  assert.equal(d.permission_policy.bash, "ask");
  assert.ok(d.tools.pi_builtin.includes("bash"));
  assert.match((await setCmd("p1", "auto", "ask")).redirected, /saved=1/);
  assert.equal((await readDef("p1")).permission_policy.bash, "auto");
  assert.match((await setCmd("p1", "off", "auto")).redirected, /saved=1/);
  d = await readDef("p1");
  assert.equal(d.permission_policy.bash, "deny");
  assert.ok(!d.tools.pi_builtin.includes("bash"));
  await putBot("n1", NOGW);
  assert.match((await setCmd("n1", "auto", "off")).redirected, /saved=1/, "no gateway = Perch chat only");
});

test("Perch-only: a Gmail bot cannot pick Ask me or Auto (guard refuses, nothing written)", async () => {
  await putBot("g1", GMAIL);
  for (const mode of ["ask", "auto"]) {
    const r = await setCmd("g1", mode, "off");
    assert.match(r.redirected, /error=/, mode);
    assert.match(decodeURIComponent(r.redirected), /Perch/, mode);
    assert.equal((await readDef("g1")).permission_policy.bash, "deny");
  }
});

test("Perch-only is judged on every save: a stored auto + Gmail bot cannot save another tab until fixed", async () => {
  await putBot("g2", { ...GMAIL, permission_policy: { bash: "auto", write_paths: [] } });
  const r = await post({ action: "save_safety", bot_id: "g2", pp_write_paths: "/tmp/w" });
  assert.match(r.redirected, /error=/);
  assert.match(decodeURIComponent(r.redirected), /Perch/);
  assert.match((await setCmd("g2", "off", "auto")).redirected, /saved=1/, "switching Off is always allowed");
});

test("guard on the owner save path: a shell is refused while the env scrub is off", async () => {
  await putBot("p2", PERCH);
  await withPassthrough(async () => {
    for (const mode of ["ask", "auto"]) {
      const r = await setCmd("p2", mode, "off");
      assert.match(decodeURIComponent(r.redirected || ""), /environment scrub/, mode);
    }
  });
  assert.equal((await readDef("p2")).permission_policy.bash, "deny");
});

test("guard on the owner save path: a relative write path is refused (validator through the real handler)", async () => {
  await putBot("p3", PERCH);
  const r = await post({ action: "save_safety", bot_id: "p3", pp_write_paths: "relative/dir" });
  assert.match(r.redirected, /error=/);
  assert.match(decodeURIComponent(r.redirected), /absolute/);
});

test("the retired Permissions form is refused, not silently ignored", async () => {
  await putBot("p4", PERCH);
  const r = await post({ action: "save_permissions", bot_id: "p4", pp_bash: "auto" });
  assert.match(r.redirected, /error=/);
  assert.equal((await readDef("p4")).permission_policy.bash, "deny");
});

test("render: Ask me / Auto enabled for a Perch bot; disabled with a reason for a Gmail bot (en + es)", async () => {
  await putBot("p5", PERCH);
  const html = await render("p5");
  assert.match(html, /name="cmd_mode" value="ask"(?![^>]*disabled)/);
  assert.match(html, /name="cmd_mode" value="auto"(?![^>]*disabled)/);
  assert.doesNotMatch(html, /coming soon/);
  await putBot("g3", GMAIL);
  const g = await render("g3");
  assert.match(g, /name="cmd_mode" value="auto" disabled/);
  assert.match(g, /data-testid="cmd-perch-only"/);
  assert.match(g, /for bots you chat with in Perch; on gmail they need a separate locked-down bot user/);
  assert.match(await render("g3", "es"), /usuario de bot aparte/);
});

test("render: Auto with no safety check installed says so with the catalog size; ready says where it runs", async () => {
  await putBot("a1", { ...PERCH, permission_policy: { bash: "auto", write_paths: [] } });
  let html = await render("a1");
  assert.match(html, /data-testid="classifier-status" data-state="missing"/);
  assert.match(html, /qwen3\.5-4b \(about 2\.8 GB\)/);
  assert.match(html, /href="\/dashboard\/models"/);
  await db.execute({ sql: "INSERT OR REPLACE INTO providers (id, base_url, host, models, disabled, instance_id) VALUES (?,?,?,?,0,?)",
    args: ["tail-box", "http://100.64.20.9:8030/v1", "cloud", JSON.stringify([{ id: "qwen3.5-4b" }]), OWN] });
  await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('bot_safety_classifier', 'tail-box/qwen3.5-4b')" });
  try {
    html = await render("a1");
    assert.match(html, /Safety check runs on 100\.64\.20\.9/);
  } finally {
    await db.execute("DELETE FROM dashboard_settings WHERE key='bot_safety_classifier'");
    await db.execute("DELETE FROM providers WHERE id='tail-box'");
  }
});

test("classifier status through the real reader: own loopback row ready/not-responding; misconfigured setting", async () => {
  await db.execute({ sql: "INSERT OR REPLACE INTO providers (id, base_url, host, models, disabled, instance_id) VALUES (?,?,?,?,0,?)",
    args: ["qwen3.5-4b", "http://127.0.0.1:18100/v1", "local", JSON.stringify([{ id: "qwen3.5-4b" }]), OWN] });
  try {
    const up = await getClassifierStatus(db, { fetchImpl: async () => ({ ok: true }) });
    assert.equal(up.state, "ready");
    assert.equal(up.here, true);
    assert.equal((await getClassifierStatus(db, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).state, "not-responding");
    await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('bot_safety_classifier', 'nope/x')" });
    assert.equal((await getClassifierStatus(db, { probe: false })).state, "misconfigured");
  } finally {
    await db.execute("DELETE FROM dashboard_settings WHERE key='bot_safety_classifier'");
    await db.execute("DELETE FROM providers WHERE id='qwen3.5-4b'");
  }
});

test("stored sandbox: shows Off + a one-click offer (Perch bots only); the offer writes auto through the guard", async () => {
  await putBot("s1", { ...PERCH, permission_policy: { bash: "sandbox", write_paths: [] } }, "Hank");
  const html = await render("s1");
  assert.match(html, /name="cmd_mode" value="off" checked/);
  assert.match(html, /data-testid="bash-sandbox-offer"/);
  assert.match(html, /Hank was set to “sandbox”, which never worked — switch to Auto\?/);
  assert.match(html, /name="action" value="confirm_sandbox_auto"/);
  assert.match(await render("s1", "es"), /nunca funcionó/);
  // refused while the env scrub is off
  await withPassthrough(async () => {
    const r = await post({ action: "confirm_sandbox_auto", bot_id: "s1" });
    assert.match(decodeURIComponent(r.redirected), /environment scrub/);
  });
  assert.equal((await readDef("s1")).permission_policy.bash, "sandbox");
  const ok = await post({ action: "confirm_sandbox_auto", bot_id: "s1" });
  assert.match(ok.redirected, /saved=1/);
  const d = await readDef("s1");
  assert.equal(d.permission_policy.bash, "auto");
  assert.ok(d.tools.pi_builtin.includes("bash"));
  // only from sandbox
  assert.match((await post({ action: "confirm_sandbox_auto", bot_id: "s1" })).redirected, /error=/);
  // a Gmail bot gets no offer and the action is refused
  await putBot("s2", { ...GMAIL, permission_policy: { bash: "sandbox", write_paths: [] } });
  assert.doesNotMatch(await render("s2"), /bash-sandbox-offer/);
  assert.match(decodeURIComponent((await post({ action: "confirm_sandbox_auto", bot_id: "s2" })).redirected), /Perch/);
  assert.equal((await readDef("s2")).permission_policy.bash, "sandbox");
});

test("peer patch: bash validated, classifier refused, only tightening", () => {
  const off = { permission_policy: { bash: "deny" } };
  assert.equal(applyPeerPatch({ permission_policy: { bash: "auto" } }, { "permission_policy.bash": "deny" }).permission_policy.bash, "deny");
  assert.throws(() => applyPeerPatch(off, { "permission_policy.bash": "sandbox" }), /must be one of/);
  for (const v of ["ask", "auto", "allowlist"]) assert.throws(() => applyPeerPatch(off, { "permission_policy.bash": v }), /only be tightened/);
  assert.throws(() => applyPeerPatch(off, { "permission_policy.classifier": { url: "http://x/v1", model: "m" } }), /set by the bot engine/);
  assert.throws(() => applyPeerPatch({ permission_policy: { bash: "sandbox" } }, { "permission_policy.bash": "auto" }), /only be tightened/);
  assert.equal(applyPeerPatch({ permission_policy: { bash: "sandbox" } }, { "permission_policy.bash": "deny" }).permission_policy.bash, "deny");
});
