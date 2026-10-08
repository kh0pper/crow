/**
 * Bot Builder simplification — the four-tab editor (Basics, Abilities,
 * Safety, Activity) + Advanced, rendered and saved end to end.
 *
 * The load-bearing property: re-saving ANY tab of an existing bot without
 * touching a control leaves the stored definition byte-identical (the
 * editor is a projection; nothing is migrated until an operator changes a
 * control). The round-trip helper serialises each rendered form the way a
 * browser does (enabled controls only, checked boxes/radios only) and posts
 * it back through the real handler.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { decodeEntities } from "../servers/gateway/dashboard/panels/bot-builder/ui.js";

const dir = mkdtempSync(join(tmpdir(), "btb-simplify-"));
process.env.CROW_DATA_DIR = dir;

let db, handleBotBuilderPost, renderBotEditor, _setSourcesForTest, _setEngineStatusForTest, rowRev;

const SOURCES = {
  error: null,
  sources: [
    { server: "crow-memory", name: "Crow memory", account: "", ok: true, catalog: [
      { name: "crow_store_memory", access: "write" }, { name: "crow_search_memories", access: "read" },
      { name: "crow_recall_by_context", access: "read" } ] },
    { server: "crow-tasks", name: "Crow tasks", account: "", ok: true, catalog: [
      { name: "tasks_list", access: "read" }, { name: "tasks_get", access: "read" },
      { name: "tasks_update", access: "write" }, { name: "tasks_complete", access: "write" } ] },
    { server: "google-workspace", name: "Google Workspace", account: "", ok: true, catalog: [
      { name: "gmail_search_threads", access: "read" }, { name: "gmail_get_thread", access: "read" },
      { name: "gmail_create_draft", access: "write" } ] },
    { server: "google-workspace-work", name: "Google Workspace", account: "work", ok: true, catalog: [
      { name: "gmail_search_threads", access: "read" }, { name: "gmail_create_draft", access: "write" } ] },
    { server: "brave-search", name: "Brave Search", account: "", ok: false, error: "timeout", catalog: [] },
  ],
};

// A legacy bot carrying every value the new editor can no longer express.
const LEGACY = {
  engine: "pi",
  models: { default: "test-prov/model-a" },
  tools: {
    pi_builtin: ["read", "list", "glob", "bash"],
    crow_mcp: ["crow-tasks/tasks_list", "crow-tasks/tasks_update", "crow-memory/crow_search_memories",
      "brave-search/brave_web_search", "uninstalled-ext/do_thing", "crow-tasks/tasks_gone"],
    pi_extensions: ["plan-mode", "subagent"],
    skills: ["research-pipeline"],
  },
  gateways: [{ type: "glasses", device_id: "dev-1", fast_voice_model: "test-prov/model-a" }],
  companion_features: { hearing_style: "wake_word", voice_idle_timeout: 45 },
  permission_policy: { bash: "sandbox", bash_allow: ["ls"], write_paths: ["/srv/bots/legacy"],
    external_send: "draft_only", confirm: ["gmail_send", "tasks_update"], self_authoring: true, skill_learning: "off" },
  triggers: { gateway: true, cron: "*/15 * * * *" },
  system_prompt: "Line one\nLine two",
  skills: ["research-pipeline"],
  session_dir: "/srv/bots/legacy",
};
const GMAIL = {
  models: { default: "test-prov/model-a", escalation: "test-prov/model-b" },
  fast_voice_model: "test-prov/model-a",
  tools: { pi_builtin: ["read", "edit", "write"], crow_mcp: ["crow-memory/crow_store_memory", "crow-memory/crow_search_memories", "crow-memory/crow_recall_by_context", "google-workspace/gmail_search_threads", "google-workspace/gmail_get_thread"] },
  gateways: [{ type: "gmail", address: "bot@example.com", allowlist: ["alex@example.com"] }],
  permission_policy: { bash: "deny", write_paths: [], external_send: "draft_only", confirm: [] },
  system_prompt: "You are Hank.",
  skills: [],
};
const COMPANION = {
  models: { default: "test-prov/model-a" },
  gateways: [{ type: "companion", device_id: "kiosk-1" }],
  companion_features: { avatar_model: "shizuku", avatar_animation: true, pet_mode: false, social_chat: true, memory_integration: false, face_tracking: true, hearing_style: "wake_word", voice_idle_timeout: 60 },
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost, _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  ({ _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js"));
  ({ rowRev } = await import("../servers/gateway/dashboard/panels/bot-builder/def-adapter.js"));
  _setSourcesForTest(SOURCES);
  _setEngineStatusForTest({ state: "ready", source: "test" });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES (?,?,?)",
    args: ["test-prov", "http://127.0.0.1:1/v1", JSON.stringify([{ id: "model-a" }, { id: "model-b" }])] }).catch(() => {});
});

after(async () => {
  _setSourcesForTest(null);
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function putBot(botId, def, name = "Bot " + botId) {
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: [botId, name, JSON.stringify(def)] });
}
async function row(botId) {
  return (await db.execute({ sql: "SELECT display_name, definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
}
const mkRes = () => {
  const res = { html: null, redirected: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = (u) => { res.redirected = u; };
  return res;
};
async function render(botId, tab, lang = "en", extraQ = {}) {
  const res = mkRes();
  const q = { bot: botId, tab, ...extraQ };
  const req = { method: "GET", query: q, body: {}, cookies: {}, headers: {} };
  await renderBotEditor(req, res, { db, layout: ({ content }) => content, lang, PAGE_CSS: "", botId, notice: "", q });
  return res.html;
}
async function post(body) {
  const res = mkRes();
  await handleBotBuilderPost({ body, headers: {}, cookies: {} }, res, { db });
  return res;
}

/** Serialise a rendered form the way a browser submits it. */
function formBody(form) {
  const body = {};
  const add = (k, v) => {
    if (!k) return;
    if (k in body) body[k] = [].concat(body[k], v); else body[k] = v;
  };
  for (const el of form.querySelectorAll("input, select, textarea")) {
    if (el.hasAttribute("disabled")) continue;
    let p = el.parentElement, off = false;
    while (p && p !== form) { if (p.tagName === "FIELDSET" && p.hasAttribute("disabled")) { off = true; break; } p = p.parentElement; }
    if (off) continue;
    const name = el.getAttribute("name");
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "INPUT" && (type === "checkbox" || type === "radio")) {
      if (el.hasAttribute("checked")) add(name, el.getAttribute("value") ?? "on");
    } else if (tag === "SELECT") {
      const opts = [...el.querySelectorAll("option")];
      const sel = opts.find((o) => o.hasAttribute("selected")) || opts[0];
      add(name, sel ? (sel.getAttribute("value") ?? sel.textContent) : "");
    } else if (tag === "TEXTAREA") {
      // a browser decodes the textarea's character references, drops one
      // leading newline, and submits CRLF line breaks
      add(name, decodeEntities(el.textContent).replace(/^\n/, "").replace(/\n/g, "\r\n"));
    } else if (type !== "submit" && type !== "button" && type !== "search") {
      add(name, el.getAttribute("value") ?? "");
    }
  }
  return body;
}
function forms(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return [...document.querySelectorAll("form")].filter((f) => {
    const a = f.querySelector("input[name=action]");
    return a && /^save_/.test(a.getAttribute("value"));
  });
}

// ---------------------------------------------------------------- render

test("four tabs plus Advanced; the active one is marked for assistive tech", async () => {
  await putBot("gm", GMAIL);
  const html = await render("gm", "basics");
  for (const tb of ["basics", "abilities", "safety", "activity", "advanced"]) assert.match(html, new RegExp(`tab=${tb}"`));
  assert.match(html, /aria-current="page"[^>]*>Basics</);
  assert.doesNotMatch(html, /tab=triggers|tab=tracker"|tab=permissions"/);
});

test("legacy ?tab= values land on the tab that now holds those settings", async () => {
  await putBot("gm", GMAIL);
  const cases = { ai: "Basics", gateways: "Basics", triggers: "Basics", tools: "Abilities", skills: "Abilities",
    permissions: "Safety", sessions: "Activity", review: "Activity", tracker: "Advanced" };
  for (const [legacy, label] of Object.entries(cases)) {
    const html = await render("gm", legacy);
    assert.match(html, new RegExp(`aria-current="page"[^>]*>${label}`), legacy);
  }
  assert.match(await render("gm", "tracker"), /<details class="btb-adv-sec" id="board" open>/, "tracker opens the board section");
});

test("dead controls are gone from every view", async () => {
  await putBot("legacy", LEGACY);
  let all = "";
  for (const tb of ["basics", "abilities", "safety", "activity", "advanced"]) all += await render("legacy", tb);
  for (const bad of ["stt_profile_ref", "tts_profile_ref", "vision_profile_ref", "gw_hearing_style", "gw_voice_idle_timeout",
    "tr_cron", "tr_gateway", ">sandbox<", "value=\"sandbox\"", "Regenerate", ".mcp.json", "ext_plan-mode", "ext_todo", "ext_subagent",
    "gw_fast_voice_model", "pp_multi_agent", "pp_self_authoring", "pp_skill_learning"]) {
    assert.ok(!all.includes(bad), `still renders ${bad}`);
  }
  assert.match(all, /Check tool connections/);
});

test("Basics: one voice-model control, one channel picker that never auto-submits, inactive channels disabled", async () => {
  await putBot("gm", GMAIL);
  const html = await render("gm", "basics");
  assert.equal((html.match(/name="fast_voice_model"/g) || []).length, 1);
  assert.doesNotMatch(html, /name="gw_type"[^>]*onchange/);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const sets = [...document.querySelectorAll("fieldset.btb-channel")];
  const enabled = sets.filter((f) => !f.hasAttribute("disabled"));
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].getAttribute("data-channel"), "gmail");
  assert.ok(sets.length >= 9);
  assert.equal(document.querySelector("#bx-name").getAttribute("value"), "Bot gm");
});

test("Abilities: memory row, one row per source with its account, Read-only only where it means something, failed source kept", async () => {
  await putBot("gm", GMAIL);
  const html = await render("gm", "abilities");
  assert.match(html, /<span class="btb-src-name"[^>]*>Memory<\/span>/);
  assert.match(html, /name="src__crow-memory" value="all" checked/, "all memory tools selected -> On");
  assert.match(html, /name="src__google-workspace" value="read" checked/, "exactly the read tools -> Read-only");
  assert.match(html, /<span class="btb-acct">work<\/span>/);
  assert.match(html, /name="src__crow-tasks" value="off" checked/);
  assert.doesNotMatch(html, /name="src__crow-memory" value="read"/, "memory offers Off / On / Custom");
  assert.match(html, /Couldn&#39;t load this service|Couldn't load this service/);
  assert.doesNotMatch(html, /name="src__brave-search"/);
  assert.match(html, /<input type="radio" name="cmd_mode" value="ask" disabled>/, "Ask me first is not live yet");
  assert.match(html, /name="files_mode" value="edit" checked/);
  assert.match(html, /type="search"/);
  assert.match(html, /btb-tag-write/);
});

test("Safety: plain-language controls; the always-ask list offers the bot's write tools and keeps unknown entries", async () => {
  await putBot("legacy", LEGACY);
  const html = await render("legacy", "safety");
  assert.match(html, /Save it as a draft for me/);
  assert.match(html, /name="confirm_tool" value="crow-tasks\/tasks_update" checked/, "bare voice name counts");
  assert.doesNotMatch(html, /value="crow-tasks\/tasks_list"/, "read tools are not offered");
  assert.match(html, /<textarea name="confirm_other"[^>]*>gmail_send<\/textarea>/);
  assert.doesNotMatch(html, /external_send|draft_only<\/option>/);
});

test("every view renders in Spanish with no untranslated keys", async () => {
  await putBot("legacy", LEGACY);
  for (const tb of ["basics", "abilities", "safety", "activity", "advanced"]) {
    const html = await render("legacy", tb, "es");
    assert.doesNotMatch(html, /botbuilder\.[a-zA-Z_]+/, tb);
  }
  assert.match(await render("legacy", "basics", "es"), /Lo básico/);
});

// ---------------------------------------------------------------- the round trip

for (const [label, botId, def] of [["legacy", "legacy", LEGACY], ["gmail", "gm", GMAIL], ["companion", "comp", COMPANION]]) {
  test(`no-change round trip (${label}): saving every untouched form leaves the stored definition byte-identical`, async () => {
    await putBot(botId, def);
    const before = await row(botId);
    for (const tb of ["basics", "abilities", "safety", "advanced"]) {
      const html = await render(botId, tb);
      for (const f of forms(html)) {
        const body = formBody(f);
        const res = await post(body);
        assert.match(res.redirected || "", /saved=1/, `${tb}/${body.adv_section || body.action}: ${res.redirected}`);
        const now = await row(botId);
        assert.equal(now.definition, before.definition, `${tb}/${body.adv_section || body.action} rewrote the definition`);
        assert.equal(now.display_name, before.display_name);
      }
    }
  });
}

// ---------------------------------------------------------------- changes

async function formOf(botId, tab, pick = () => true) {
  return forms(await render(botId, tab)).filter(pick).map(formBody)[0];
}

test("Basics: rename writes the column only; the persona and voice model write their single fields", async () => {
  await putBot("gm", GMAIL);
  const before = JSON.parse((await row("gm")).definition);
  const body = await formOf("gm", "basics");
  body.display_name = "Hank";
  body.system_prompt = "You are Hank, the email bot.";
  body.fast_voice_model = "";
  const res = await post(body);
  assert.match(res.redirected, /saved=1/);
  const r = await row("gm");
  assert.equal(r.display_name, "Hank");
  const def = JSON.parse(r.definition);
  assert.equal(def.system_prompt, "You are Hank, the email bot.");
  assert.equal("fast_voice_model" in def, false);
  assert.deepEqual(def.gateways, before.gateways, "channel untouched");
  assert.deepEqual(def.models, before.models);
});

test("Basics: an empty name is refused and nothing is written", async () => {
  await putBot("gm", GMAIL);
  const body = await formOf("gm", "basics");
  body.display_name = "  ";
  body.system_prompt = "changed";
  const res = await post(body);
  assert.match(res.redirected, /error=/);
  assert.equal(JSON.parse((await row("gm")).definition).system_prompt, "You are Hank.");
});

test("Basics: a glasses save never writes gw.fast_voice_model; a companion save keeps hearing style and idle timeout", async () => {
  await putBot("comp", COMPANION);
  const body = await formOf("comp", "basics");
  body.gw_social_chat = undefined; delete body.gw_social_chat; // untick one feature
  await post(body);
  const def = JSON.parse((await row("comp")).definition);
  assert.equal(def.companion_features.social_chat, false);
  assert.equal(def.companion_features.hearing_style, "wake_word");
  assert.equal(def.companion_features.voice_idle_timeout, 60);

  await putBot("gl", { models: { default: "test-prov/model-a" }, gateways: [] });
  const g = await formOf("gl", "basics");
  g.gw_type = "glasses";
  await post(g);
  const gd = JSON.parse((await row("gl")).definition);
  assert.deepEqual(gd.gateways, [{ type: "glasses" }]);
});

test("Abilities: source modes expand from the rendered catalog; other sources and unrendered ones are kept", async () => {
  await putBot("legacy", LEGACY);
  const body = await formOf("legacy", "abilities");
  body["src__crow-tasks"] = "read";
  body["src__google-workspace"] = "all";
  const res = await post(body);
  assert.match(res.redirected, /saved=1/, res.redirected);
  const def = JSON.parse((await row("legacy")).definition);
  const sel = new Set(def.tools.crow_mcp);
  assert.ok(sel.has("crow-tasks/tasks_list") && sel.has("crow-tasks/tasks_get"));
  assert.ok(!sel.has("crow-tasks/tasks_update"), "read-only drops the write tool");
  assert.ok(!sel.has("crow-tasks/tasks_gone"), "choosing a mode replaces the source's selection");
  assert.ok(sel.has("google-workspace/gmail_create_draft"));
  assert.ok(sel.has("brave-search/brave_web_search"), "a source that failed to load is kept");
  assert.ok(sel.has("uninstalled-ext/do_thing"), "a source not on the page is kept");
  assert.ok(sel.has("crow-memory/crow_search_memories"), "memory untouched");
  assert.equal(def.permission_policy.bash, "sandbox", "commands untouched");
  assert.deepEqual(def.tools.pi_builtin, ["read", "list", "glob", "bash"], "files untouched");
});

test("Abilities: files and commands write real pi tool names; Off removes bash; a not-live mode is refused", async () => {
  await putBot("legacy", LEGACY);
  let body = await formOf("legacy", "abilities");
  body.files_mode = "edit";
  body.cmd_mode = "off"; body.cmd_mode__was = "off"; // unchanged command mode keeps sandbox
  await post(body);
  let def = JSON.parse((await row("legacy")).definition);
  assert.deepEqual(def.tools.pi_builtin, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
  assert.equal(def.permission_policy.bash, "sandbox");

  body = await formOf("legacy", "abilities");
  body.cmd_mode = "auto";
  const res = await post(body);
  assert.match(res.redirected, /error=/);
  assert.equal(JSON.parse((await row("legacy")).definition).permission_policy.bash, "sandbox", "nothing written");
});

test("Abilities: skills write def.skills only (no tools.skills mirror)", async () => {
  await putBot("gm", GMAIL);
  const body = await formOf("gm", "abilities");
  body.skills = ["memory-management"];
  body.skills_rendered = "1";
  await post(body);
  const def = JSON.parse((await row("gm")).definition);
  assert.deepEqual(def.skills, ["memory-management"]);
  assert.equal(def.tools.skills, undefined);
});

test("Safety: checking a tool stores both names; email choice; invalid folder refuses the save", async () => {
  await putBot("gm", GMAIL);
  let body = await formOf("gm", "safety");
  body.confirm_tool = ["crow-memory/crow_store_memory"];
  body.email_mode = "allow";
  await post(body);
  let def = JSON.parse((await row("gm")).definition);
  assert.deepEqual(def.permission_policy.confirm, ["mcp__crow-memory__crow_store_memory", "crow_store_memory"]);
  assert.equal(def.permission_policy.external_send, "allow");

  body = await formOf("gm", "safety");
  body.pp_read_paths = "relative/path";
  const res = await post(body);
  assert.match(res.redirected, /tab=safety&error=/);
});

test("Advanced: learning, helpers and the command list each write only their fields", async () => {
  await putBot("legacy", LEGACY);
  const adv = forms(await render("legacy", "advanced")).map(formBody);
  const learning = adv.find((b) => b.adv_section === "learning");
  assert.equal(learning.learn_mode, "custom", "self_authoring on + learning off is a custom combination");
  learning.learn_mode = "auto";
  await post(learning);
  let def = JSON.parse((await row("legacy")).definition);
  assert.equal(def.permission_policy.self_authoring, true);
  assert.equal(def.permission_policy.skill_learning, "auto");

  const adv2 = forms(await render("legacy", "advanced")).map(formBody);
  const helpers = adv2.find((b) => b.adv_section === "helpers");
  helpers.multi_agent = "on";
  await post(helpers);
  def = JSON.parse((await row("legacy")).definition);
  assert.equal(def.permission_policy.multi_agent, true);

  const adv3 = forms(await render("legacy", "advanced")).map(formBody);
  const cmds = adv3.find((b) => b.adv_section === "commands");
  cmds.cmd_list = "on";
  cmds.pp_bash_allow = "git status\r\nls -la";
  await post(cmds);
  def = JSON.parse((await row("legacy")).definition);
  assert.equal(def.permission_policy.bash, "allowlist");
  assert.deepEqual(def.permission_policy.bash_allow, ["git status", "ls -la"]);
  assert.ok(def.tools.pi_builtin.includes("bash"));
  assert.match(await render("legacy", "abilities"), /name="cmd_mode" value="list" checked/, "Abilities shows the list mode");
});

test("a stale page is refused; a post without def_rev keeps the old behaviour", async () => {
  await putBot("gm", GMAIL);
  const body = await formOf("gm", "basics");
  const r0 = (await db.execute({ sql: "SELECT definition, display_name, project_id FROM pi_bot_defs WHERE bot_id='gm'" })).rows[0];
  assert.equal(body.def_rev, rowRev(r0), "the revision covers the definition, name and project");
  // another writer changes the definition meanwhile
  const d = JSON.parse((await row("gm")).definition); d.skills = ["approved-meanwhile"];
  await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='gm'", args: [JSON.stringify(d)] });
  body.system_prompt = "stale edit";
  const res = await post(body);
  assert.match(res.redirected, /error=/);
  assert.match(decodeURIComponent(res.redirected), /changed somewhere else/);
  assert.deepEqual(JSON.parse((await row("gm")).definition).skills, ["approved-meanwhile"]);
  delete body.def_rev;
  const res2 = await post(body);
  assert.match(res2.redirected, /saved=1/);
});

test("engine gate: a changed complete channel is refused while the engine is absent; an unchanged one saves", async () => {
  await putBot("gm", GMAIL);
  _setEngineStatusForTest({ state: "absent" });
  try {
    const html = await render("gm", "basics");
    assert.match(html, /id="btb-basics-form"[^>]*data-engine-gate="1"/);
    assert.match(html, /data-engine-required-fields-json=/);
    let body = forms(html).map(formBody)[0];
    body.system_prompt = "renamed only";
    let res = await post(body);
    assert.match(res.redirected, /saved=1/, "unchanged channel: no gate");
    body = await formOf("gm", "basics");
    body.gw_allowlist = "alex@example.com\r\nsam@example.com";
    res = await post(body);
    assert.match(res.redirected, /error=engine_required/);
  } finally {
    _setEngineStatusForTest({ state: "ready", source: "test" });
  }
});

test("Activity: checklist links point at the new tabs and speak plain language", async () => {
  await putBot("legacy", LEGACY);
  const html = await render("legacy", "activity");
  assert.match(html, /tab=basics/);
  assert.match(html, /tab=safety/);
  assert.doesNotMatch(html, /tab=(ai|gateways|tools|permissions)"/);
  assert.match(html, /commands: off/, "stored sandbox reads as off");
  assert.doesNotMatch(html, /bash: <code>/);
});

// ---------------------------------------------------------------- client behaviour

test("BEHAVIOR (Abilities): a mode button ticks the right tools; ticking tools moves the mode; the filter hides rows", async () => {
  const vm = await import("node:vm");
  await putBot("gm", GMAIL);
  const html = await render("gm", "abilities");
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const ctx = vm.createContext({ window, document, console });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], ctx);
  const row = document.querySelector(".btb-src[data-src='crow-tasks']");
  const radio = (v) => row.querySelector(`input[type=radio][value='${v}']`);
  const boxes = () => [...row.querySelectorAll(".btb-tool input[type=checkbox]")];
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

  radio("read").checked = true; fire(radio("read"), "change");
  assert.deepEqual(boxes().map((b) => b.checked), [true, true, false, false], "Read-only ticks only the read tools");
  radio("all").checked = true; fire(radio("all"), "change");
  assert.ok(boxes().every((b) => b.checked), "All ticks everything");

  const upd = boxes()[2]; upd.checked = false; fire(upd, "change");
  assert.equal(radio("custom").checked, true, "unticking one tool makes it Custom");
  boxes().forEach((b) => { b.checked = false; }); fire(boxes()[0], "change");
  assert.equal(radio("off").checked, true, "no tools is Off");

  const filter = row.querySelector(".btb-tool-filter");
  filter.value = "update"; fire(filter, "input");
  const visible = [...row.querySelectorAll(".btb-tool")].filter((l) => !l.hidden).map((l) => l.textContent);
  assert.equal(visible.length, 1);
  assert.match(visible[0], /tasks_update/);
});

test("BEHAVIOR (Basics): the channel picker swaps fieldsets and never submits", async () => {
  const vm = await import("node:vm");
  await putBot("gm", GMAIL);
  const html = await render("gm", "basics");
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  let submitted = 0;
  const form = document.getElementById("btb-basics-form");
  form.requestSubmit = () => { submitted++; };
  form.submit = () => { submitted++; };
  const ctx = vm.createContext({ window, document, console, location: { reload() {} }, fetch: () => Promise.resolve({ json: () => ({}) }), setTimeout: () => 0, clearTimeout() {}, URL });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], ctx);
  const sel = document.querySelector("[name=gw_type]");
  for (const o of sel.querySelectorAll("option")) { if (o.getAttribute("value") === "telegram") o.setAttribute("selected", ""); else o.removeAttribute("selected"); }
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  const on = [...document.querySelectorAll("fieldset.btb-channel")].filter((f) => !f.disabled && !f.hidden).map((f) => f.getAttribute("data-channel"));
  assert.deepEqual(on, ["telegram"]);
  assert.equal(submitted, 0);
});

// ---------------------------------------------------------------- the one policy guard

test("every save goes through one permission_policy guard: a changed invalid value is refused; an untouched legacy one is not", async () => {
  const { guardPolicyForSave } = await import("../servers/gateway/dashboard/panels/bot-builder/policy-guard.js");
  assert.equal(guardPolicyForSave({ bash: "sandbox" }, { bash: "sandbox" }), null, "untouched legacy value");
  assert.match(guardPolicyForSave({ bash: "sandbox" }, { bash: "deny" }), /bash/);
  assert.match(guardPolicyForSave({ write_paths: ["rel/x"] }, {}), /absolute/);
  assert.match(guardPolicyForSave({ classifier: { url: "http://evil" } }, {}), /engine/);
  assert.equal(guardPolicyForSave({ bash: "allowlist", bash_allow: ["ls"] }, { bash: "deny" }), null);

  // through the real handler: a legacy save that would write an invalid value is refused, nothing written
  await putBot("gm", GMAIL);
  const before = (await row("gm")).definition;
  const res = await post({ action: "save_permissions", bot_id: "gm", pp_bash: "sandbox", pp_write_paths: "", pp_external_send: "draft_only", pp_confirm: "", pp_read_paths: "" });
  assert.match(res.redirected, /error=/);
  assert.equal((await row("gm")).definition, before);
});
