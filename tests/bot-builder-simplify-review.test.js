/**
 * Bot Builder simplification — the adversarial review's regression set.
 *
 * 18 awkward stored definitions, each re-saved untouched on every form of
 * every tab and checked byte for byte (plus the device store): models the
 * picker no longer offers, missing devices and voice profiles, kiosk
 * features, deleted boards and archived projects, extra channel keys, two
 * channel records, pretty-printed JSON, long names, odd casing. Plus the
 * lost-update races (compare-and-swap, rename), the two-account "always
 * ask", XSS in a stored channel type, and the read/write classification of
 * tools that only sound like lookups.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { decodeEntities } from "../servers/gateway/dashboard/panels/bot-builder/ui.js";

const dir = mkdtempSync(join(tmpdir(), "btb-review-set-"));
process.env.CROW_DATA_DIR = dir;
let db, handleBotBuilderPost, renderBotEditor, _setSourcesForTest, _setEngineStatusForTest;

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

// ===================================================================== review set
async function allSaveForms(botId) {
  const out = [];
  for (const tb of ["basics", "abilities", "safety", "advanced"]) {
    for (const f of forms(await render(botId, tb))) out.push({ tb, body: formBody(f) });
  }
  return out;
}
async function devices() {
  const { listDevices } = await import("../servers/shared/device-store.js");
  return JSON.stringify(await listDevices(db));
}

const NASTY = {
  empty: {},
  toolsSkillsOnly: { tools: { skills: ["research-pipeline"] } },
  glassesMissingDevice: { models: { default: "test-prov/model-a" }, gateways: [{ type: "glasses", device_id: "ghost" }] },
  companionNoFeatures: { models: { default: "test-prov/model-a" }, gateways: [{ type: "companion" }] },
  remoteMcp: { models: { default: "test-prov/model-a" }, tools: { remote_mcp: ["peer-1::crow-memory/search"] } },
  allowlistBash: { models: { default: "test-prov/model-a" }, tools: { pi_builtin: ["read", "bash"] }, permission_policy: { bash: "allowlist", bash_allow: ["git status", "ls"] } },
  customTrackerGoneSlug: { models: { default: "test-prov/model-a" }, tracker_config: { type: "custom", tracker_slug: "deleted-board", context_fields: ["a", "b"], queue_filter: { k: 5 } } },
  customTrackerTwoKeys: { models: { default: "test-prov/model-a" }, tracker_config: { type: "kanban", queue_filter: { a: "1", b: "2" } } },
  modelGone: { models: { default: "gone/x", escalation: "gone/y" }, fast_voice_model: "gone/z" },
  gmailExtraKeys: { models: { default: "test-prov/model-a" }, gateways: [{ type: "gmail", address: "bot@example.com", allowlist: ["alex@example.com"], label: "INBOX", poll_seconds: 60 }] },
  twoGateways: { models: { default: "test-prov/model-a" }, gateways: [{ type: "gmail", address: "bot@example.com", allowlist: ["alex@example.com"] }, { type: "discord", token: "x", allowlist: [] }] },
  readPathsTrailingSlash: { models: { default: "test-prov/model-a" }, permission_policy: { read_paths: ["/srv/notes/"] } },
  confirmDupes: { models: { default: "test-prov/model-a" }, tools: { crow_mcp: ["crow-tasks/tasks_update"] }, permission_policy: { confirm: ["tasks_update", "tasks_update"] } },
  skillCase: { models: { default: "test-prov/model-a" }, skills: ["Research_Pipeline"] },
  crowMcpDupes: { models: { default: "test-prov/model-a" }, tools: { crow_mcp: ["crow-tasks/tasks_list", "crow-tasks/tasks_list", 7] } },
  discord: { models: { default: "test-prov/model-a" }, gateways: [{ type: "discord", token: "tok", guild_id: "1", channel_ids: ["2"], allowlist: ["3"] }] },
  externalSendOdd: { models: { default: "test-prov/model-a" }, permission_policy: { external_send: "never" } },
  legacy: LEGACY,
};

for (const [name, def] of Object.entries(NASTY)) {
  test(`REVIEW round trip byte-identical: ${name}`, async () => {
    const id = "n-" + name.toLowerCase();
    await putBot(id, def);
    const t0 = await row(id);
    const d0 = await devices();
    const problems = [];
    for (const { tb, body } of await allSaveForms(id)) {
      const res = await post(body);
      const r = await row(id);
      if (r.definition !== t0.definition || r.display_name !== t0.display_name) {
        problems.push(`${tb}/${body.adv_section || ""}: ${res.redirected}\n   before ${t0.definition}\n   after  ${r.definition}`);
        await putBot(id, def);
      } else if (!/saved=1/.test(res.redirected || "")) {
        problems.push(`${tb}/${body.adv_section || ""} not saved: ${res.redirected}`);
      }
    }
    const d1 = await devices();
    if (d0 !== d1) problems.push("device store changed:\n " + d0 + "\n " + d1);
    assert.equal(problems.join("\n"), "");
  });
}

test("REVIEW pretty-printed stored definition", async () => {
  const id = "pretty";
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id=?", args: [id] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)", args: [id, "P", JSON.stringify(GMAIL, null, 2)] });
  const t0 = (await row(id)).definition;
  for (const { body } of await allSaveForms(id)) await post(body);
  assert.equal((await row(id)).definition, t0);
});

test("REVIEW long display name (>80) untouched Basics save", async () => {
  await putBot("longname", GMAIL, "x".repeat(100));
  const body = (await allSaveForms("longname")).find((f) => f.tb === "basics").body;
  await post(body);
  assert.equal((await row("longname")).display_name, "x".repeat(100));
});

test("REVIEW glasses: a Basics save (persona only) re-binds a device another bot took", async () => {
  const { pairDevice, updateDeviceProfiles, findDevice } = await import("../servers/shared/device-store.js");
  await pairDevice(db, { id: "dev-steal", name: "Glasses", generation: "unknown" });
  await putBot("gA", { models: { default: "test-prov/model-a" }, gateways: [{ type: "glasses", device_id: "dev-steal" }] });
  await updateDeviceProfiles(db, "dev-steal", { bound_bot_id: "gB" }); // operator moved it to bot B
  const body = (await allSaveForms("gA")).find((f) => f.tb === "basics").body;
  body.system_prompt = "edited persona";
  await post(body);
  const d = await findDevice(db, "dev-steal");
  assert.equal(d.bound_bot_id, "gB", "editing A's persona must not take B's device");
});

test("REVIEW glasses: untouched Basics save clears a device voice profile the list no longer offers", async () => {
  const { pairDevice, updateDeviceProfiles, findDevice } = await import("../servers/shared/device-store.js");
  await pairDevice(db, { id: "dev-prof", name: "Glasses2", generation: "unknown" });
  await updateDeviceProfiles(db, "dev-prof", { bound_bot_id: "gP", tts_profile_id: "tts-gone" });
  await putBot("gP", { models: { default: "test-prov/model-a" }, gateways: [{ type: "glasses", device_id: "dev-prof" }] });
  const body = (await allSaveForms("gP")).find((f) => f.tb === "basics").body;
  await post(body);
  const d = await findDevice(db, "dev-prof");
  assert.equal(d.tts_profile_id, "tts-gone");
});

test("REVIEW confirm: two accounts, unticking one keeps the other asked", async () => {
  const def = { models: { default: "test-prov/model-a" },
    tools: { crow_mcp: ["google-workspace/gmail_create_draft", "google-workspace-work/gmail_create_draft"] },
    permission_policy: { confirm: ["gmail_create_draft"] } };
  await putBot("acct", def);
  const body = (await allSaveForms("acct")).find((f) => f.tb === "safety").body;
  // both rendered checked; untick the personal one, keep work
  body.confirm_tool = [].concat(body.confirm_tool).filter((k) => k.startsWith("google-workspace-work/"));
  await post(body);
  const pp = JSON.parse((await row("acct")).definition).permission_policy;
  assert.ok(pp.confirm.includes("mcp__google-workspace-work__gmail_create_draft") || pp.confirm.includes("gmail_create_draft"),
    "work account still asks: " + JSON.stringify(pp.confirm));
});

test("REVIEW race: a write between the handler's read and its UPDATE is lost (no compare-and-swap)", async () => {
  await putBot("race", GMAIL);
  const body = (await allSaveForms("race")).find((f) => f.tb === "basics").body;
  body.system_prompt = "new persona";
  let injected = false;
  const proxy = new Proxy(db, { get(tgt, k) {
    if (k !== "execute") return typeof tgt[k] === "function" ? tgt[k].bind(tgt) : tgt[k];
    return async (q) => {
      const r = await tgt.execute(q);
      const sql = typeof q === "string" ? q : q.sql;
      if (!injected && /SELECT definition, project_id, display_name FROM pi_bot_defs/.test(sql)) {
        injected = true; // skill approved meanwhile (skill_promote commits here)
        const d = JSON.parse(r.rows[0].definition); d.skills = ["approved-skill"];
        await tgt.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id=?", args: [JSON.stringify(d), "race"] });
      }
      return r;
    };
  } });
  const res = mkRes();
  await handleBotBuilderPost({ body, headers: {}, cookies: {} }, res, { db: proxy });
  const def = JSON.parse((await row("race")).definition);
  assert.deepEqual(def.skills, ["approved-skill"], "approved skill lost: " + JSON.stringify(def.skills) + " " + res.redirected);
});

test("REVIEW rename race: a second open tab reverts a rename (def_rev covers the definition only)", async () => {
  await putBot("rn", GMAIL, "Old");
  const stale = (await allSaveForms("rn")).find((f) => f.tb === "basics").body;
  const fresh = (await allSaveForms("rn")).find((f) => f.tb === "basics").body;
  fresh.display_name = "New";
  await post(fresh);
  stale.system_prompt = "persona tweak";
  await post(stale);
  assert.equal((await row("rn")).display_name, "New");
});

test("REVIEW board: clearing a project writes NULL; changing nothing keeps it", async () => {
  await db.execute({ sql: "INSERT OR IGNORE INTO project_spaces (id, slug, name) VALUES (?,?,?)", args: [77, "p77", "P77"] });
  await putBot("brd", GMAIL);
  await db.execute({ sql: "UPDATE pi_bot_defs SET project_id=77 WHERE bot_id='brd'" });
  const f = (await allSaveForms("brd")).find((x) => x.body.adv_section === "board").body;
  await post({ ...f });
  assert.equal(Number((await db.execute("SELECT project_id FROM pi_bot_defs WHERE bot_id='brd'")).rows[0].project_id), 77);
  const f2 = (await allSaveForms("brd")).find((x) => x.body.adv_section === "board").body;
  f2.project_id = "";
  await post(f2);
  assert.equal((await db.execute("SELECT project_id FROM pi_bot_defs WHERE bot_id='brd'")).rows[0].project_id, null);
});

test("REVIEW XSS: a stored unknown channel type is escaped in the Basics picker", async () => {
  await putBot("xss", { models: { default: "test-prov/model-a" }, gateways: [{ type: 'x"><img src=x onerror=alert(1)>' }] });
  const html = await render("xss", "basics");
  assert.ok(!html.includes("<img src=x onerror"), "raw markup injected");
});

test("REVIEW XSS: tool names / accounts / skill names from a source are escaped", async () => {
  _setSourcesForTest({ error: null, sources: [{ server: "evil", name: "<b>evil</b>", account: "<i>acct</i>", ok: true,
    catalog: [{ name: "x<script>alert(1)</script>", access: "read", label: "<img src=x onerror=1>" }] }] });
  await putBot("xss2", { models: { default: "test-prov/model-a" }, tools: { crow_mcp: ["evil/x<script>alert(1)</script>"] } });
  const html = await render("xss2", "abilities") + await render("xss2", "safety");
  _setSourcesForTest(SOURCES);
  assert.ok(!/<script>alert|<img src=x|<b>evil|<i>acct/.test(html));
});

test("REVIEW classification: annotations widen a write-named tool to read", async () => {
  const { classifyTool } = await import("../servers/gateway/dashboard/panels/bot-builder/tool-access.js");
  assert.equal(classifyTool({ name: "gmail_send_message", readOnlyHint: true }), "write", "a server's readOnlyHint turned a send tool into a read");
});

test("REVIEW classification: real tools that change things classified read", async () => {
  const { classifyTool } = await import("../servers/gateway/dashboard/panels/bot-builder/tool-access.js");
  const wrong = ["crow_kiosk_show", "crow_kavita_want_to_read", "crow_calibreweb_reading_status", "crow_browser_paginate", "crow_browser_navigate", "crow_get_file_url"]
    .filter((n) => classifyTool({ name: n }) === "read");
  assert.deepEqual(wrong, []);
});

test("REVIEW All: a tool added later is not granted and the row reads Custom", async () => {
  const { sourceMode, expandSourceMode } = await import("../servers/gateway/dashboard/panels/bot-builder/tool-access.js");
  const cat = [{ name: "a", access: "read" }, { name: "b", access: "write" }];
  assert.equal(sourceMode("s", ["s/a", "s/b"], cat), "all");
  assert.equal(sourceMode("s", ["s/a", "s/b"], [...cat, { name: "c", access: "write" }]), "custom");
  await putBot("allnew", { models: { default: "test-prov/model-a" }, tools: { crow_mcp: ["crow-tasks/tasks_list", "crow-tasks/tasks_get", "crow-tasks/tasks_update"] } });
  const t0 = (await row("allnew")).definition;
  const ab = (await allSaveForms("allnew")).find((x) => x.tb === "abilities").body;
  await post(ab);
  assert.equal((await row("allnew")).definition, t0, "untouched Custom row must not gain tasks_complete");
});

test("REVIEW non-string crow_mcp entry (peer-patchable) crashes an Abilities save", async () => {
  await putBot("nonstr", { models: { default: "test-prov/model-a" }, tools: { crow_mcp: ["crow-tasks/tasks_list", 7] } });
  const ab = (await allSaveForms("nonstr")).find((x) => x.tb === "abilities").body;
  await post(ab); // throws TypeError today
});

// ===================================================================== follow-ups (re-check)

async function refusedSave(botId, body) {
  // a concurrent writer lands between the handler's read and its write: the
  // compare-and-swap refuses, and NOTHING may have changed — devices included
  let injected = false;
  const proxy = new Proxy(db, { get(tgt, k) {
    if (k !== "execute") return typeof tgt[k] === "function" ? tgt[k].bind(tgt) : tgt[k];
    return async (q) => {
      const r = await tgt.execute(q);
      const sql = typeof q === "string" ? q : q.sql;
      if (!injected && /SELECT definition, project_id, display_name FROM pi_bot_defs/.test(sql)) {
        injected = true;
        const d = JSON.parse(r.rows[0].definition); d.skills = ["approved-meanwhile"];
        await tgt.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id=?", args: [JSON.stringify(d), botId] });
      }
      return r;
    };
  } });
  const res = mkRes();
  await handleBotBuilderPost({ body, headers: {}, cookies: {} }, res, { db: proxy });
  return res;
}

test("a refused glasses save (row changed meanwhile) binds, unbinds and re-profiles no device", async () => {
  const { pairDevice, updateDeviceProfiles } = await import("../servers/shared/device-store.js");
  await pairDevice(db, { id: "dev-old", name: "Old glasses", generation: "unknown" });
  await pairDevice(db, { id: "dev-new", name: "New glasses", generation: "unknown" });
  await updateDeviceProfiles(db, "dev-old", { bound_bot_id: "gRef" });
  await updateDeviceProfiles(db, "dev-new", { bound_bot_id: "someone-else" });
  await putBot("gRef", { models: { default: "test-prov/model-a" }, gateways: [{ type: "glasses", device_id: "dev-old" }] });
  const before = await devices();
  const body = (await allSaveForms("gRef")).find((f) => f.tb === "basics").body;
  body.gw_device_id = "dev-new"; // move the bot to the other glasses
  const res = await refusedSave("gRef", body);
  assert.match(res.redirected, /error=/, "the save is refused");
  assert.equal(await devices(), before, "no device was bound, unbound or changed");
});

test("a refused new-kiosk save pairs no device", async () => {
  await putBot("kRef", { models: { default: "test-prov/model-a" }, gateways: [{ type: "companion" }] });
  const before = await devices();
  const body = (await allSaveForms("kRef")).find((f) => f.tb === "basics").body;
  body.gw_new_kiosk_name = "Hall display";
  const res = await refusedSave("kRef", body);
  assert.match(res.redirected, /error=/);
  assert.equal(await devices(), before, "no kiosk device was created");
});

test("an accepted glasses save binds the new device after the write", async () => {
  const { findDevice } = await import("../servers/shared/device-store.js");
  await putBot("gOk", { models: { default: "test-prov/model-a" }, gateways: [{ type: "glasses", device_id: "dev-old" }] });
  const body = (await allSaveForms("gOk")).find((f) => f.tb === "basics").body;
  body.gw_device_id = "dev-new";
  const res = await post(body);
  assert.match(res.redirected, /saved=1/, res.redirected);
  assert.equal((await findDevice(db, "dev-new")).bound_bot_id, "gOk");
  assert.equal(JSON.parse((await row("gOk")).definition).gateways[0].device_id, "dev-new");
});

test("a name that mixes a lookup word with a changing verb counts as changing things", async () => {
  const { classifyTool } = await import("../servers/gateway/dashboard/panels/bot-builder/tool-access.js");
  const verbs = ["purge", "execute", "exec", "reset", "clear", "kill", "drop", "wipe", "revoke", "grant",
    "approve", "reject", "enable", "disable", "start", "stop", "restart", "deploy", "merge", "push", "post",
    "submit", "pay", "transfer", "order", "book", "invite", "forward", "mark", "cancel", "trigger", "call",
    "dial", "sms", "notify", "assign", "install", "uninstall", "rotate", "restore", "import", "commit"];
  const wrong = verbs.map((v) => `get_${v}_status`).filter((n) => classifyTool({ name: n }) === "read");
  assert.deepEqual(wrong, [], "read-named tools carrying a changing verb");
  for (const n of ["list_items", "get_thread", "search_messages"]) assert.equal(classifyTool({ name: n }), "read", n);
});
