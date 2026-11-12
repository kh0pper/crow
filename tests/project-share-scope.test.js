/**
 * Project-share scope (Phase 1): the tool inventory the three project servers must fit, the
 * per-call decision for a bot, the home-project read/write scope, the by-id row rule, the
 * not-found-equals-hidden-row rule, and the one gate the project tools share.
 *
 * Scratch CROW_HOME + data dir, a real crow.db from scripts/init-db.js. Nothing here touches
 * ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "share-scope-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const REPO = join(import.meta.dirname, "..");
const DB_FILE = join(DATA, "crow.db");

let db = null;
let S = null;
let OWNER = null;
let UNKNOWN = null;
let CROW_VOICE_BOT_ID = null;
let createProjectSpace = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  S = await import("../servers/shared/project-share-scope.js");
  ({ OWNER, UNKNOWN } = await import("../servers/research/actor.js"));
  ({ CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// --- fixtures -------------------------------------------------------------------------------

let projectSeq = 0;
async function mkProject(name = `Scope project ${++projectSeq}`) {
  const r = await createProjectSpace(db, { name });
  return Number(r.id);
}

let botSeq = 0;
async function mkBot({ home = null } = {}) {
  botSeq += 1;
  const botId = `scope-bot-${botSeq}`;
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, `Bot ${botSeq}`, "{}", home],
  });
  return botId;
}

async function grant(projectId, botId, level = "read_write") {
  await db.execute({
    sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,?)",
    args: [Number(projectId), botId, level],
  });
}

async function setLevel(projectId, botId, level) {
  await db.execute({
    sql: "UPDATE project_bot_shares SET level = ? WHERE project_id = ? AND bot_id = ? AND revoked_at IS NULL",
    args: [level, Number(projectId), botId],
  });
}

let contactSeq = 0;
async function addOutsideMember(projectId) {
  contactSeq += 1;
  const crowId = `scope-peer-${contactSeq}`.padEnd(16, "0");
  const r = await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (?,?,?,?, 'remote')",
    args: [crowId, `Peer ${contactSeq}`, `${contactSeq}`.padEnd(64, "a"), `${contactSeq}`.padEnd(64, "b")],
  });
  const contactId = Number(r.lastInsertRowid);
  const m = await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role, mode) VALUES (?,?, 'viewer', 'live')",
    args: [Number(projectId), contactId],
  });
  return Number(m.lastInsertRowid);
}

const audits = async (projectId) => (await db.execute({
  sql: "SELECT actor_type, actor_id, action, target, payload FROM project_audit_log WHERE project_id = ? AND action = 'share.refused' ORDER BY id",
  args: [Number(projectId)],
})).rows;

const allNames = () => [...new Set([
  ...Object.keys(S.TOOL_CLASS),
  ...S.HOME_ONLY_TOOLS,
  ...S.SCOPED_LISTING_TOOLS,
  ...S.OWNER_ONLY_TOOLS,
  ...S.PROJECT_NEUTRAL_TOOLS,
])].sort();

// --- the inventory --------------------------------------------------------------------------

test("the five collections are frozen and shaped as the plan says", () => {
  for (const c of [S.TOOL_CLASS, S.HOME_ONLY_TOOLS, S.SCOPED_LISTING_TOOLS, S.SCOPED_LISTING_PROJECT_TOOLS,
    S.OWNER_ONLY_TOOLS, S.PROJECT_NEUTRAL_TOOLS]) {
    assert.ok(Object.isFrozen(c));
  }
  assert.ok(Object.isFrozen(S.TOOL_CLASS.crow_get_memory));
  assert.deepEqual(S.TOOL_CLASS.crow_get_memory, { family: "memory", class: "read" });
  assert.deepEqual(S.TOOL_CLASS.crow_fetch_source, { family: "source", class: "write" });
  assert.deepEqual(S.TOOL_CLASS.crow_upload_file, { family: "file", class: "write" });
  assert.deepEqual(S.TOOL_CLASS.crow_search_notes, { family: "note", class: "read" });
  assert.equal(S.PROJECT_NEUTRAL_TOOLS.length, 6);
  // A bot may SEND the operator a notification; reading or dismissing one is owner-only, because
  // the text carries other projects' names and card titles and a dismiss clears the owner's alerts.
  assert.ok(S.PROJECT_NEUTRAL_TOOLS.includes("crow_create_notification"));
  assert.ok(S.PROJECT_NEUTRAL_TOOLS.includes("crow_notification_settings"));
  for (const tool of ["crow_check_notifications", "crow_dismiss_notification", "crow_dismiss_all_notifications"]) {
    assert.ok(S.OWNER_ONLY_TOOLS.includes(tool), tool);
    assert.ok(!S.PROJECT_NEUTRAL_TOOLS.includes(tool), tool);
  }
  // The schedules table has no project column: the three schedule tools cannot be scoped at all.
  for (const tool of ["crow_create_schedule", "crow_list_schedules", "crow_update_schedule"]) {
    assert.ok(S.OWNER_ONLY_TOOLS.includes(tool), tool);
    assert.ok(!S.HOME_ONLY_TOOLS.includes(tool), tool);
  }
  // One listing takes a project_id filter, so it is a narrower list of its own.
  assert.deepEqual(S.SCOPED_LISTING_PROJECT_TOOLS, ["crow_list_context_sections"]);
  for (const tool of S.SCOPED_LISTING_PROJECT_TOOLS) {
    assert.ok(S.SCOPED_LISTING_TOOLS.includes(tool), `${tool} is a scoped listing too`);
  }
  // Only crow_dream is listed twice (in SCOPED_LISTING_TOOLS and OWNER_ONLY_TOOLS).
  const occurrences = [S.TOOL_CLASS, S.HOME_ONLY_TOOLS, S.SCOPED_LISTING_TOOLS, S.OWNER_ONLY_TOOLS, S.PROJECT_NEUTRAL_TOOLS]
    .map((c) => (Array.isArray(c) ? c.length : Object.keys(c).length))
    .reduce((a, b) => a + b, 0);
  assert.equal(occurrences, allNames().length + 1);
});

test("toolPolicyFor resolves crow_dream's two entries by dry_run and classifies every other name", () => {
  assert.equal(S.toolPolicyFor("crow_dream", { dry_run: true }).kind, "scoped_listing");
  assert.equal(S.toolPolicyFor("crow_dream", {}).kind, "scoped_listing", "dry_run defaults true");
  assert.equal(S.toolPolicyFor("crow_dream", { dry_run: false }).kind, "owner_only");
  assert.equal(S.toolPolicyFor("crow_get_memory").kind, "read");
  assert.equal(S.toolPolicyFor("crow_delete_memory").kind, "write");
  assert.equal(S.toolPolicyFor("crow_update_project").kind, "home_only");
  assert.equal(S.toolPolicyFor("crow_list_projects").kind, "scoped_listing");
  assert.equal(S.toolPolicyFor("crow_list_context_sections").kind, "scoped_listing");
  assert.equal(S.toolPolicyFor("crow_create_project").kind, "owner_only");
  assert.equal(S.toolPolicyFor("crow_create_schedule").kind, "owner_only");
  assert.equal(S.toolPolicyFor("crow_check_notifications").kind, "owner_only");
  assert.equal(S.toolPolicyFor("crow_create_notification").kind, "neutral");
  assert.equal(S.toolPolicyFor("crow_web_search").kind, "neutral");
  assert.equal(S.toolPolicyFor("crow_not_a_tool"), null, "unlisted: no policy, so denied at runtime");
});

// --- owner / unknown ------------------------------------------------------------------------

test("the owner and an unidentified actor are unrestricted, on any project and on project-less rows", async () => {
  const X = await mkProject("Owner only project");
  for (const tool of allNames()) {
    for (const actor of [OWNER, UNKNOWN]) {
      const d = await S.decideProjectAccess(db, actor, { tool, projectId: X, args: { dry_run: false } });
      assert.equal(d.allowed, true, `${actor.kind} may call ${tool}`);
      const row = await S.decideRowAccess(db, actor, { tool, rowProjectId: null, args: { dry_run: false } });
      assert.equal(row.allowed, true, `${actor.kind} may resolve ${tool} on a project-less row`);
      assert.equal(await S.botReadScope(db, actor), null);
      assert.deepEqual(await S.botWriteProject(db, actor, null), { projectId: null });
      assert.deepEqual(await S.botWriteProject(db, actor, X), { projectId: X });
    }
  }
  assert.equal((await audits(X)).length, 0, "no refusal is logged for an actor that is not a bot");
});

test("a bot may use every covered tool on its own project and is refused the owner-only ones", async () => {
  const home = await mkProject("Bot home");
  const bot = await mkBot({ home });
  const actor = { kind: "bot", id: bot };

  for (const tool of Object.keys(S.TOOL_CLASS)) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: home });
    assert.equal(d.allowed, true, `home allows ${tool}`);
  }
  for (const tool of S.HOME_ONLY_TOOLS) {
    assert.equal((await S.decideProjectAccess(db, actor, { tool, projectId: home })).allowed, true, tool);
  }
  for (const tool of S.SCOPED_LISTING_TOOLS) {
    assert.equal((await S.decideProjectAccess(db, actor, { tool, projectId: home, args: { dry_run: true } })).allowed, true, tool);
  }
  for (const tool of S.PROJECT_NEUTRAL_TOOLS) {
    assert.equal((await S.decideProjectAccess(db, actor, { tool, projectId: home })).allowed, true, tool);
    assert.equal((await S.decideProjectAccess(db, actor, { tool, projectId: null })).allowed, true, tool);
  }
  for (const tool of S.OWNER_ONLY_TOOLS) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: home, args: { dry_run: false } });
    assert.equal(d.allowed, false, tool);
    assert.equal(d.code, "owner_only", tool);
  }
  assert.equal((await audits(home)).length, 0, "a home-project call logs no refusal");
});

// --- a project the bot has no share to ------------------------------------------------------

test("a bot with no share is refused on X, and the refusal is logged on X without ever naming it", async () => {
  const X = await mkProject("Zephyrine Ledger");
  const home = await mkProject("Home of a refused bot");
  const bot = await mkBot({ home });
  const actor = { kind: "bot", id: bot };

  for (const tool of Object.keys(S.TOOL_CLASS)) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: X });
    assert.equal(d.allowed, false, tool);
    assert.equal(d.code, "no_share", tool);
    assert.ok(!d.message.includes("Zephyrine"), "the refusal never carries the project name");
  }

  const gate = S.makeShareGate(db, "crow_search_sources", { baseActor: actor });
  const refusal = await gate.check(X);
  assert.equal(refusal.isError, true);
  assert.match(refusal.content[0].text, /^Error: /);

  const rows = await audits(X);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_type, "bot");
  assert.equal(rows[0].actor_id, bot);
  assert.equal(rows[0].target, "tool:crow_search_sources");
  assert.deepEqual(JSON.parse(rows[0].payload), { code: "no_share" });
  assert.ok(!JSON.stringify(rows[0]).includes("Zephyrine"));
});

test("an unlisted tool name is refused for a bot even on its home project", async () => {
  const home = await mkProject("Default deny home");
  const bot = await mkBot({ home });
  const d = await S.decideProjectAccess(db, { kind: "bot", id: bot }, { tool: "crow_not_a_tool", projectId: home });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "owner_only");
});

// --- share levels ---------------------------------------------------------------------------

test("a read share allows every read-class tool and refuses every write-class tool", async () => {
  const X = await mkProject("Read share");
  const bot = await mkBot({});
  await grant(X, bot, "read");
  const actor = { kind: "bot", id: bot };

  for (const [tool, cls] of Object.entries(S.TOOL_CLASS)) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: X });
    if (cls.class === "read") {
      assert.equal(d.allowed, true, `read share allows ${tool}`);
    } else {
      assert.equal(d.allowed, false, `read share refuses ${tool}`);
      assert.equal(d.code, "read_only", tool);
    }
  }
});

test("a read_write share allows both classes", async () => {
  const X = await mkProject("Read write share");
  const bot = await mkBot({});
  await grant(X, bot, "read_write");
  const actor = { kind: "bot", id: bot };

  for (const [tool, cls] of Object.entries(S.TOOL_CLASS)) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: X });
    assert.equal(d.allowed, true, `read_write allows ${tool} (${cls.class})`);
  }
});

test("a level change takes effect on the next call with no regrant", async () => {
  const X = await mkProject("Level change");
  const bot = await mkBot({});
  await grant(X, bot, "read");
  const actor = { kind: "bot", id: bot };
  assert.equal((await S.decideProjectAccess(db, actor, { tool: "crow_store_memory", projectId: X })).code, "read_only");
  await setLevel(X, bot, "read_write");
  assert.equal((await S.decideProjectAccess(db, actor, { tool: "crow_store_memory", projectId: X })).allowed, true);
});

test("every HOME_ONLY tool is refused on X even with a read_write share", async () => {
  const X = await mkProject("Home only target");
  const home = await mkProject("Home only home");
  const bot = await mkBot({ home });
  await grant(X, bot, "read_write");
  const actor = { kind: "bot", id: bot };

  for (const tool of S.HOME_ONLY_TOOLS) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: X });
    assert.equal(d.allowed, false, tool);
    assert.equal(d.code, "home_only", tool);
    assert.ok(!d.message.includes("Home only target"), "the refusal never carries the project name");
  }
});

test("a scoped listing that names another project is home_only, even with a read_write share", async () => {
  const X = await mkProject("Listing target");
  const home = await mkProject("Listing home");
  const bot = await mkBot({ home });
  await grant(X, bot, "read_write");
  const actor = { kind: "bot", id: bot };

  const onX = await S.decideProjectAccess(db, actor, { tool: "crow_list_context_sections", projectId: X });
  assert.equal(onX.allowed, false, "a share of X does not buy X's section names");
  assert.equal(onX.code, "home_only");
  assert.ok(!onX.message.includes("Listing target"), "the refusal never carries the project name");

  const onHome = await S.decideProjectAccess(db, actor, { tool: "crow_list_context_sections", projectId: home });
  assert.equal(onHome.allowed, true, "the home project behaves as before");
  assert.equal(onHome.projectId, home);
  const noProject = await S.decideProjectAccess(db, actor, { tool: "crow_list_context_sections", projectId: null });
  assert.equal(noProject.allowed, true, "omitting the filter behaves as before");
  assert.equal(noProject.projectId, home);

  const gate = S.makeShareGate(db, "crow_list_context_sections", { baseActor: actor });
  assert.equal((await gate.check(X)).isError, true);
  assert.deepEqual(await gate.check(home), { projectId: home });

  const homeless = { kind: "bot", id: await mkBot({}) };
  assert.equal((await S.decideProjectAccess(db, homeless, { tool: "crow_list_context_sections", projectId: X })).code,
    "home_only");
});

test("notification reading and dismissing are owner-only; sending one stays neutral", async () => {
  const home = await mkProject("Notification home");
  const X = await mkProject("Notification target");
  const bot = await mkBot({ home });
  await grant(X, bot, "read_write");
  const actor = { kind: "bot", id: bot };

  for (const tool of ["crow_check_notifications", "crow_dismiss_notification", "crow_dismiss_all_notifications"]) {
    for (const projectId of [home, X, null]) {
      const d = await S.decideProjectAccess(db, actor, { tool, projectId });
      assert.equal(d.allowed, false, `${tool} with project ${projectId}`);
      assert.equal(d.code, "owner_only", tool);
    }
  }

  assert.equal((await S.decideProjectAccess(db, actor,
    { tool: "crow_create_notification", projectId: home })).allowed, true);
  assert.equal((await S.decideProjectAccess(db, actor,
    { tool: "crow_notification_settings", projectId: null })).allowed, true);

  // The operator's voice bot is exempt from the bot rules, notifications included.
  const voice = { kind: "bot", id: CROW_VOICE_BOT_ID };
  for (const tool of ["crow_check_notifications", "crow_dismiss_all_notifications"]) {
    assert.equal((await S.decideProjectAccess(db, voice, { tool, projectId: null })).allowed, true, tool);
  }
});

test("a suspended share is refused and recovers when the outside member goes, with no regrant", async () => {
  const X = await mkProject("Suspension target");
  const home = await mkProject("Suspension home");
  const bot = await mkBot({ home });
  await grant(X, bot, "read_write");
  const actor = { kind: "bot", id: bot };

  assert.equal((await S.decideProjectAccess(db, actor, { tool: "crow_search_sources", projectId: X })).allowed, true);

  const memberId = await addOutsideMember(X);
  const suspended = await S.decideProjectAccess(db, actor, { tool: "crow_search_sources", projectId: X });
  assert.equal(suspended.allowed, false);
  assert.equal(suspended.code, "suspended");

  await db.execute({ sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE id = ?", args: [memberId] });
  assert.equal((await S.decideProjectAccess(db, actor, { tool: "crow_search_sources", projectId: X })).allowed, true);
});

test("an outside member on the bot's own project suspends the share too", async () => {
  const X = await mkProject("Other side target");
  const home = await mkProject("Home with an outside member");
  const bot = await mkBot({ home });
  await grant(X, bot, "read_write");
  await addOutsideMember(home);
  const d = await S.decideProjectAccess(db, { kind: "bot", id: bot }, { tool: "crow_search_sources", projectId: X });
  assert.equal(d.code, "suspended");
});

// --- reads and writes with no project -------------------------------------------------------

test("botReadScope covers the home project only and never project-less rows", async () => {
  const home = await mkProject("Scope home");
  const other = await mkProject("Scope other");
  const bot = await mkBot({ home });
  const homeless = await mkBot({});
  await db.execute({ sql: "INSERT INTO memories (content, category, project_id) VALUES ('home row', 'general', ?)", args: [home] });
  await db.execute({ sql: "INSERT INTO memories (content, category, project_id) VALUES ('other row', 'general', ?)", args: [other] });
  await db.execute({ sql: "INSERT INTO memories (content, category, project_id) VALUES ('project-less row', 'general', NULL)", args: [] });
  // A share does NOT widen an omitted project_id: the recall stays home-only.
  await grant(other, bot, "read_write");

  const scope = await S.botReadScope(db, { kind: "bot", id: bot });
  assert.deepEqual(scope, { homeProjectId: home });
  const p = S.scopePredicate(scope);
  const rows = (await db.execute({ sql: `SELECT content FROM memories WHERE 1=1${p.sql} ORDER BY id`, args: p.args })).rows;
  assert.deepEqual(rows.map((r) => r.content), ["home row"]);

  const none = await S.botReadScope(db, { kind: "bot", id: homeless });
  assert.deepEqual(none, { homeProjectId: null });
  const np = S.scopePredicate(none);
  const noRows = (await db.execute({ sql: `SELECT COUNT(*) AS n FROM memories WHERE 1=1${np.sql}`, args: np.args })).rows[0];
  assert.equal(Number(noRows.n), 0, "a bot with no home project reads nothing");
});

test("botWriteProject defaults to the home project and refuses when the bot has none", async () => {
  const home = await mkProject("Write home");
  const bot = await mkBot({ home });
  const actor = { kind: "bot", id: bot };
  assert.deepEqual(await S.botWriteProject(db, actor, null), { projectId: home });
  assert.deepEqual(await S.botWriteProject(db, actor, undefined), { projectId: home });
  const X = await mkProject("Named write target");
  assert.deepEqual(await S.botWriteProject(db, actor, X), { projectId: X });

  const homeless = { kind: "bot", id: await mkBot({}) };
  const refused = await S.botWriteProject(db, homeless, null);
  assert.equal(refused.refused, true);
  assert.equal(refused.message, S.NAME_A_PROJECT_MESSAGE);
  assert.ok(!/project #\d/.test(refused.message), "the refusal names no project");

  assert.deepEqual(await S.botWriteProject(db, OWNER, null), { projectId: null }, "the owner keeps today's behavior");
  assert.deepEqual(await S.botWriteProject(db, OWNER, X), { projectId: X });
});

// --- by-id rows -----------------------------------------------------------------------------

test("a project-less row is refused for a bot and allowed for the owner", async () => {
  const bot = await mkBot({});
  const d = await S.decideRowAccess(db, { kind: "bot", id: bot }, { tool: "crow_get_memory", rowProjectId: null });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "no_share");
  const owner = await S.decideRowAccess(db, OWNER, { tool: "crow_get_memory", rowProjectId: null });
  assert.equal(owner.allowed, true);
});

test("a hidden row is refused with exactly the text a missing id gets, and the log keeps the true code", async () => {
  const X = await mkProject("Hidden row project");
  const bot = await mkBot({});
  const actor = { kind: "bot", id: bot };

  const d = await S.decideRowAccess(db, actor, { tool: "crow_get_memory", rowProjectId: X });
  assert.equal(d.code, "no_share");
  assert.ok(!d.message.includes("Hidden row project"));

  const gate = S.makeShareGate(db, "crow_get_memory", { baseActor: actor });
  const refusal = await gate.checkRow(X);
  assert.deepEqual(refusal, S.notFoundResult());
  assert.equal(refusal.isError, true);
  assert.equal(S.NOT_FOUND_MESSAGE, "Not found.");
  assert.equal(refusal.content[0].text, `Error: ${S.NOT_FOUND_MESSAGE}`);

  const rows = await audits(X);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].payload), { code: "no_share" });
});

test("a row inside the home project is reachable by id, and a write class follows the share level", async () => {
  const home = await mkProject("Row home");
  const X = await mkProject("Row read share");
  const bot = await mkBot({ home });
  await grant(X, bot, "read");
  const actor = { kind: "bot", id: bot };

  assert.equal((await S.decideRowAccess(db, actor, { tool: "crow_get_memory", rowProjectId: home })).allowed, true);
  assert.equal((await S.decideRowAccess(db, actor, { tool: "crow_update_memory", rowProjectId: home })).allowed, true);
  assert.equal((await S.decideRowAccess(db, actor, { tool: "crow_get_source", rowProjectId: X })).allowed, true);
  assert.equal((await S.decideRowAccess(db, actor, { tool: "crow_update_memory", rowProjectId: X })).code, "read_only");
  assert.equal((await S.decideRowAccess(db, OWNER, { tool: "crow_update_memory", rowProjectId: X })).allowed, true);
});

// --- the operator's voice bot ---------------------------------------------------------------

test("the voice bot keeps operator scope on every tool and every project", async () => {
  const X = await mkProject("Voice bot target");
  const voice = { kind: "bot", id: CROW_VOICE_BOT_ID };
  assert.equal(S.isOperatorVoice(voice), true);
  assert.equal(S.isOperatorVoice({ kind: "bot", id: CROW_VOICE_BOT_ID, botSession: true }), false);
  assert.equal(S.isOperatorVoice({ kind: "bot", id: `${CROW_VOICE_BOT_ID}.2` }), false);
  assert.equal(S.isOperatorVoice(OWNER), false);
  assert.equal(S.isOperatorVoice(UNKNOWN), false);

  for (const tool of allNames()) {
    const d = await S.decideProjectAccess(db, voice, { tool, projectId: X, args: { dry_run: false } });
    assert.equal(d.allowed, true, `the voice bot may call ${tool}`);
    assert.equal((await S.decideProjectAccess(db, voice, { tool, projectId: null, args: {} })).allowed, true, tool);
  }
  assert.equal(await S.botReadScope(db, voice), null);
  assert.deepEqual(await S.botWriteProject(db, voice, null), { projectId: null });
  assert.equal((await S.decideRowAccess(db, voice, { tool: "crow_get_memory", rowProjectId: null })).allowed, true);
  assert.equal((await audits(X)).length, 0);
});

test("the same id from a pi bot session gets no exemption, and no other bot id ever does", async () => {
  const X = await mkProject("Marked voice target");
  const marked = { kind: "bot", id: CROW_VOICE_BOT_ID, botSession: true };
  const readTool = "crow_search_sources";

  const d = await S.decideProjectAccess(db, marked, { tool: readTool, projectId: X });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "no_share");
  assert.equal((await S.decideProjectAccess(db, marked, { tool: "crow_create_project", projectId: X })).code, "owner_only");
  assert.deepEqual(await S.botReadScope(db, marked), { homeProjectId: null });
  const w = await S.botWriteProject(db, marked, null);
  assert.equal(w.refused, true);

  const lookalike = { kind: "bot", id: `${CROW_VOICE_BOT_ID}2`, botSession: true };
  assert.equal(S.isOperatorVoice(lookalike), false);
  assert.equal((await S.decideProjectAccess(db, lookalike, { tool: readTool, projectId: X })).code, "no_share");
  assert.deepEqual(await S.botReadScope(db, lookalike), { homeProjectId: null });
});

// --- the unverified bot ---------------------------------------------------------------------

test("an unverified bot is refused every registered tool with owner_only", async () => {
  const X = await mkProject("Unverified target");
  const unverified = { kind: "bot", id: null, unverified: true };

  for (const tool of allNames()) {
    for (const projectId of [X, null]) {
      const d = await S.decideProjectAccess(db, unverified, { tool, projectId, args: { dry_run: true } });
      assert.equal(d.allowed, false, `${tool} (project ${projectId})`);
      assert.equal(d.code, "owner_only", tool);
    }
    const row = await S.decideRowAccess(db, unverified, { tool, rowProjectId: X });
    assert.equal(row.allowed, false, tool);
    assert.equal(row.code, "owner_only", tool);
  }
  assert.deepEqual(await S.botReadScope(db, unverified), { homeProjectId: null });
  assert.equal((await S.botWriteProject(db, unverified, null)).refused, true);
});

// --- HOME_ONLY with no project_id -----------------------------------------------------------

test("I3: a HOME_ONLY call with no project_id becomes the home project, and is refused without one", async () => {
  const home = await mkProject("Context home");
  const bot = await mkBot({ home });
  const actor = { kind: "bot", id: bot };
  const homeless = { kind: "bot", id: await mkBot({}) };

  for (const tool of ["crow_get_context", "crow_update_context_section"]) {
    const d = await S.decideProjectAccess(db, actor, { tool, projectId: null });
    assert.equal(d.allowed, true, tool);
    assert.equal(d.projectId, home, `${tool} is resolved to the home project`);

    const gate = S.makeShareGate(db, tool, { baseActor: actor });
    assert.deepEqual(await gate.check(undefined), { projectId: home }, tool);
    assert.deepEqual(await gate.writeProject(undefined), { projectId: home }, tool);

    const noHome = await S.decideProjectAccess(db, homeless, { tool, projectId: null });
    assert.equal(noHome.allowed, false, tool);
    assert.equal(noHome.code, "home_only", tool);

    const byDevice = await S.decideProjectAccess(db, actor, { tool, projectId: null, deviceId: "device-1" });
    assert.equal(byDevice.allowed, false, tool);
    assert.equal(byDevice.code, "owner_only", tool);

    const viaGate = await S.makeShareGate(db, tool, { baseActor: actor }).check(home, { device_id: "device-1" });
    assert.equal(viaGate.isError, true, tool);
  }
});

test("I3: the schedule tools are owner_only for a bot, home project or not", async () => {
  const home = await mkProject("Schedule home");
  const X = await mkProject("Schedule target");
  const bot = await mkBot({ home });
  await grant(X, bot, "read_write");
  const actor = { kind: "bot", id: bot };

  // The schedules table has no project column, so nothing can be scoped to a project: a bot gets
  // no schedule tool at all, on its own project or on a shared one.
  for (const tool of ["crow_create_schedule", "crow_list_schedules", "crow_update_schedule"]) {
    for (const projectId of [home, X, null]) {
      const d = await S.decideProjectAccess(db, actor, { tool, projectId });
      assert.equal(d.allowed, false, `${tool} with project ${projectId}`);
      assert.equal(d.code, "owner_only", tool);
    }
  }

  const voice = { kind: "bot", id: CROW_VOICE_BOT_ID };
  assert.equal((await S.decideProjectAccess(db, voice, { tool: "crow_create_schedule", projectId: X })).allowed, true,
    "the operator's voice bot stays exempt");
});

// --- the gate's pass shape ------------------------------------------------------------------

test("the gate answers the resolved project on a pass and the tool-result shape on a refusal", async () => {
  const home = await mkProject("Gate home");
  const X = await mkProject("Gate target");
  const bot = await mkBot({ home });
  await grant(X, bot, "read");
  const actor = { kind: "bot", id: bot };

  const readGate = S.makeShareGate(db, "crow_search_sources", { baseActor: actor });
  assert.deepEqual(await readGate.check(X), { projectId: X }, "a named project resolves to itself");
  assert.deepEqual(await readGate.check(undefined), { projectId: home }, "an omitted project resolves to home");

  const writeGate = S.makeShareGate(db, "crow_store_memory", { baseActor: actor });
  const refusal = await writeGate.check(X);
  assert.equal(refusal.isError, true);
  assert.equal(refusal.projectId, undefined, "a refusal carries no project for a handler to write against");
  assert.equal(refusal.content[0].text, `Error: This bot's share of that project is read-only.`);

  const rowGate = S.makeShareGate(db, "crow_get_memory", { baseActor: actor });
  assert.equal(await rowGate.checkRow(home), null, "checkRow passes null: the row already names its project");
  const unshared = await mkProject("Gate unshared target");
  assert.deepEqual(await rowGate.checkRow(unshared), S.notFoundResult(), "and refuses with the not-found result");

  assert.deepEqual(await S.makeShareGate(db, "crow_web_search", { baseActor: OWNER }).check(X), { projectId: X });
  assert.deepEqual(await S.makeShareGate(db, "crow_web_search", { baseActor: OWNER }).check(null), { projectId: null });
});

// --- refusal repeat suppression -------------------------------------------------------------

test("repeats of one refusal inside 60 s collapse, and the log takes the next one after that", async () => {
  const X = await mkProject("Repeat project");
  const bot = await mkBot({});
  const actor = { kind: "bot", id: bot };
  const call = (now, code = "no_share", tool = "crow_get_source") =>
    S.auditRefusal(db, actor, { tool, projectId: X, code, now });

  let t = 1_000_000;
  await call(() => t);
  await call(() => t);
  t += 30_000;
  await call(t);
  assert.equal((await audits(X)).length, 1, "within 60 s: one row");

  t += 31_000; // 61 s after the first
  await call(() => t);
  assert.equal((await audits(X)).length, 2);

  await call(() => t, "read_only");
  assert.equal((await audits(X)).length, 3, "a different code is its own row");
  await call(() => t, "no_share", "crow_search_sources");
  assert.equal((await audits(X)).length, 4, "a different tool is its own row");

  const other = await mkBot({});
  await S.auditRefusal(db, { kind: "bot", id: other }, { tool: "crow_get_source", projectId: X, code: "no_share", now: () => t });
  assert.equal((await audits(X)).length, 5, "a different bot is its own row");

  await S.auditRefusal(db, actor, { tool: "crow_get_source", projectId: 987654, code: "no_share", now: () => t });
  const ghost = await db.execute({ sql: "SELECT COUNT(*) AS n FROM project_audit_log WHERE project_id = 987654", args: [] });
  assert.equal(Number(ghost.rows[0].n), 0, "a project that does not exist takes no row");
});

test("a refusal that names no project is logged on the bot's home project, and dropped when it has none", async () => {
  const home = await mkProject("Refusal home");
  const bot = await mkBot({ home });
  const actor = { kind: "bot", id: bot };

  // Through the gate: a device-named call is owner_only and names no project at all.
  const gate = S.makeShareGate(db, "crow_get_context", { baseActor: actor });
  const refusal = await gate.check(undefined, { device_id: "device-1" });
  assert.equal(refusal.isError, true);

  const rows = await audits(home);
  assert.equal(rows.length, 1, "the bot's own project log records the refusal");
  assert.equal(rows[0].actor_type, "bot");
  assert.equal(rows[0].actor_id, bot);
  assert.equal(rows[0].target, "tool:crow_get_context");
  assert.deepEqual(JSON.parse(rows[0].payload), { code: "owner_only" });
  assert.ok(!rows[0].payload.includes("Refusal home"));

  // The 60 s suppression still covers the home-project fallback.
  await gate.check(undefined, { device_id: "device-1" });
  assert.equal((await audits(home)).length, 1, "a repeat inside 60 s collapses");

  // A bot with no home project, and an unverified bot, are skipped silently.
  const t = 9_000_000;
  const homeless = await mkBot({});
  await S.auditRefusal(db, { kind: "bot", id: homeless },
    { tool: "crow_get_memory", projectId: null, code: "owner_only", now: () => t });
  await S.auditRefusal(db, { kind: "bot", id: null, unverified: true },
    { tool: "crow_get_memory", projectId: null, code: "owner_only", now: () => t });
  const stray = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM project_audit_log
           WHERE action = 'share.refused' AND target = 'tool:crow_get_memory'
             AND (actor_id = ? OR actor_id = 'unknown')`,
    args: [homeless],
  });
  assert.equal(Number(stray.rows[0].n), 0, "there is nothing to log a homeless or unverified bot against");
});

// --- coverage: the three factories ------------------------------------------------------------

test("every tool the project, memory and storage servers register is in exactly one collection", async () => {
  const { createProjectServer } = await import("../servers/research/server.js");
  const { createMemoryServer } = await import("../servers/memory/server.js");
  const { createStorageServer } = await import("../servers/storage/server.js");

  const registered = [
    ...Object.keys(createProjectServer(DB_FILE)._registeredTools),
    ...Object.keys(createMemoryServer(DB_FILE)._registeredTools),
    ...Object.keys(createStorageServer(DB_FILE)._registeredTools),
  ].sort();
  assert.ok(registered.length > 50, `read the whole surface (got ${registered.length})`);
  assert.equal(new Set(registered).size, registered.length, "no tool name is registered twice");

  const collections = {
    TOOL_CLASS: Object.keys(S.TOOL_CLASS),
    HOME_ONLY_TOOLS: [...S.HOME_ONLY_TOOLS],
    SCOPED_LISTING_TOOLS: [...S.SCOPED_LISTING_TOOLS],
    OWNER_ONLY_TOOLS: [...S.OWNER_ONLY_TOOLS],
    PROJECT_NEUTRAL_TOOLS: [...S.PROJECT_NEUTRAL_TOOLS],
  };

  for (const tool of registered) {
    const hits = Object.entries(collections).filter(([, names]) => names.includes(tool)).map(([name]) => name);
    if (tool === "crow_dream") {
      assert.deepEqual(hits.sort(), ["OWNER_ONLY_TOOLS", "SCOPED_LISTING_TOOLS"], "the one documented two-entry tool");
    } else {
      assert.equal(hits.length, 1, `${tool} is in ${hits.length ? hits.join(" + ") : "no collection"}`);
    }
    assert.ok(S.toolPolicyFor(tool, { dry_run: true }), `${tool} has a policy`);
    assert.ok(S.toolPolicyFor(tool, { dry_run: false }), `${tool} has a policy with dry_run false`);
  }

  const covered = new Set([
    ...collections.TOOL_CLASS, ...collections.HOME_ONLY_TOOLS, ...collections.SCOPED_LISTING_TOOLS,
    ...collections.OWNER_ONLY_TOOLS, ...collections.PROJECT_NEUTRAL_TOOLS,
  ]);
  for (const tool of covered) assert.ok(registered.includes(tool), `${tool} is a real registered tool`);
});