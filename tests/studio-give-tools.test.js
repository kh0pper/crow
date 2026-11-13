/**
 * Giving a song project's bot the Studio tools.
 *
 * Two halves, because the feature has two:
 *
 *   - the ROUTES (`GET .../project-bot` and `POST .../project-bot/studio-tools`)
 *     over the real web layer on a scratch crow.db, with the project-bot lookup
 *     and the def edit injected — the panel loader owns both in production, so
 *     this file pins their contract: what the page is told, and what a click
 *     sends, refuses and answers;
 *   - the DEF EDIT ITSELF (`server/give-tools.js`), exercised on a scratch
 *     libsql crow.db with a real `pi_bot_defs` row and the real audit append:
 *     one bare `studio` entry appended to `tools.crow_mcp`, nothing else
 *     touched, a compare-and-swap write, an idempotent second call, a stale
 *     definition, another project's bot, and a tool budget that is already
 *     spent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import express, { Router } from "express";
import { WebSocketServer } from "ws";
import { AclError, appendAudit } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import { createGiveBotStudioTools, grantsStudioTools, withStudioTools } from "../bundles/studio/server/give-tools.js";

/** The project with a bot, and one without. */
const PROJECT = 41;
const BOTLESS_PROJECT = 42;

/** The dashboard's author for a song created through the hub. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bot every route test is about. */
const BOT = Object.freeze({ bot_id: "bassbot", name: "Bass Bot" });

/** The CSRF value the fake dashboard auth accepts. */
const CSRF = "csrf-ok";

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/** A project ACL that allows the two projects here and swallows the audit rows. */
function fakeAcl() {
  const projects = new Set([PROJECT, BOTLESS_PROJECT]);
  async function assertProjectExists(_db, projectId) {
    const id = Number(projectId);
    if (!projects.has(id)) throw new AclError(`Project #${id} not found`, "not_found");
    return { id };
  }
  return {
    assertProjectExists,
    assertCapability: (db, projectId) => assertProjectExists(db, projectId),
    async appendAudit() {},
  };
}

/**
 * Boot the Studio router on 127.0.0.1:0 with one song per project.
 *
 * @param {import("node:test").TestContext} t
 * @param {{session?: boolean, bot?: object|null, give?: Function|null,
 *          canWrite?: Function|null}} [options]
 *   `session: false` refuses every request the way an ended session answers;
 *   `bot` is what the injected project-bot lookup answers (null: no bot);
 *   `give` is the injected def edit (null: this instance cannot edit a def);
 *   `canWrite` is the injected project write check (the default lets the caller
 *   write; a test passes one that refuses).
 */
async function boot(t, { session = true, bot = { ...BOT }, give = null, canWrite = null } = {}) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const hub = createHub({ db, acl: fakeAcl(), onBroadcast: () => {} });

  const botSong = await hub.createSong({ project_id: PROJECT, title: "Bot song", author: HUMAN });
  assert.equal(botSong.ok, true, `createSong was refused: ${botSong.error}`);
  const otherSong = await hub.createSong({ project_id: BOTLESS_PROJECT, title: "Other song", author: HUMAN });
  assert.equal(otherSong.ok, true, `createSong was refused: ${otherSong.error}`);

  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: () => "good",
      verifySession: async () => ({}),
      csrfTokenAccepted: (_req, presented) => presented === CSRF,
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome: mkdtempSync(join(tmpdir(), "studio-give-home-")),
    bundleDir: null,
    projectBotOf: async (projectId) =>
      bot && Number(projectId) === PROJECT ? { ...bot } : null,
    ...(give ? { giveBotStudioTools: give } : {}),
    // A project ACL that lets the caller write, unless the test injects a
    // refusal (the read-only member).
    assertCanWrite: canWrite ?? (async () => ({ role: "owner" })),
  });

  const dashboardAuth = session
    ? (_req, _res, next) => next()
    : (_req, res) => res.status(401).json({ error: "unauthorized" });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(web.router(dashboardAuth));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          // Nothing left to close.
        }
        server.close(() => resolve());
      }),
  );

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    botSong: botSong.song_id,
    otherSong: otherSong.song_id,
  };
}

/** @returns {Promise<{status: number, body: object|null}>} one project-bot answer. */
async function projectBot(base, songId) {
  const response = await fetch(`${base}/api/studio/songs/${encodeURIComponent(songId)}/project-bot`);
  return { status: response.status, body: await response.json() };
}

/** @returns {Promise<{status: number, body: object|null}>} one give-tools answer. */
async function postStudioTools(base, songId, body, headers = {}) {
  const response = await fetch(
    `${base}/api/studio/songs/${encodeURIComponent(songId)}/project-bot/studio-tools`,
    {
      method: "POST",
      headers: { "x-crow-csrf": CSRF, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

// ---- the routes --------------------------------------------------------

test("project-bot names the project's bot, its Studio grant, and where a missing bot comes from", async (t) => {
  const bare = await boot(t, { bot: { ...BOT } });
  const found = await projectBot(bare.base, bare.botSong);
  assert.equal(found.status, 200);
  assert.equal(found.body.bot_id, BOT.bot_id);
  assert.equal(found.body.name, BOT.name);
  assert.equal(found.body.project_id, PROJECT);
  assert.equal(found.body.has_studio_tools, false, "the def grants no Studio tools yet");
  assert.equal(found.body.setup_url, null, "a project that has a bot needs no setup link");

  const granted = await boot(t, { bot: { ...BOT, has_studio_tools: true } });
  assert.equal((await projectBot(granted.base, granted.botSong)).body.has_studio_tools, true);

  const botless = await boot(t, { bot: null });
  const none = await projectBot(botless.base, botless.botSong);
  assert.equal(none.status, 200);
  assert.equal(none.body.bot_id, null);
  assert.equal(none.body.name, null);
  assert.equal(none.body.has_studio_tools, null, "there is no bot to say anything about");
  assert.equal(
    none.body.setup_url,
    `/dashboard/bot-builder?new=1&project=${PROJECT}`,
    "the setup link is Bot Builder's new-bot-in-this-project page",
  );
});

test("the give-tools route needs a session and the CSRF header", async (t) => {
  const calls = [];
  const give = async (request) => {
    calls.push(request);
    return { ok: true, already: false };
  };

  const ended = await boot(t, { session: false, give });
  const refused = await postStudioTools(ended.base, ended.botSong, { bot_id: BOT.bot_id });
  assert.equal(refused.status, 401, "without a session the route answers like the rest of the dashboard");

  const open = await boot(t, { give });
  const noCsrf = await postStudioTools(open.base, open.botSong, { bot_id: BOT.bot_id }, { "x-crow-csrf": "wrong" });
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(noCsrf.body, { error: "csrf" });

  // An agent process holds a session (the MCP layer runs as the operator), so
  // presenting the Studio agent token is what marks it — and the edit is a
  // person's click, never an agent's.
  const asAgent = await postStudioTools(open.base, open.botSong, { bot_id: BOT.bot_id }, { "x-studio-token": "t" });
  assert.equal(asAgent.status, 403);
  assert.equal(asAgent.body.error.includes("agent cannot do it"), true);

  assert.deepEqual(calls, [], "nothing behind the gates was called");
});

test("a read-only member cannot give the bot tools", async (t) => {
  const calls = [];
  const { base, botSong } = await boot(t, {
    give: async (request) => {
      calls.push(request);
      return { ok: true, already: false };
    },
    canWrite: async (projectId) => {
      throw new AclError(`reader role on project #${projectId} lacks capability 'write_files'`, "missing_capability");
    },
  });

  const refused = await postStudioTools(base, botSong, { bot_id: BOT.bot_id });
  assert.equal(refused.status, 403, "the ACL refusal is a 403");
  assert.deepEqual(calls, [], "and the def was never read or written");
});

test("a bot id that is not this project's bot is refused without calling the edit", async (t) => {
  const calls = [];
  const { base, botSong } = await boot(t, {
    give: async (request) => {
      calls.push(request);
      return { ok: true, already: false };
    },
  });

  const stale = await postStudioTools(base, botSong, { bot_id: "someone-else" });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /not this song project's bot/);
  assert.deepEqual(calls, []);

  // No bot at all is the same 409: there is nothing to name.
  const botless = await boot(t, { bot: null, give: async () => ({ ok: true, already: false }) });
  const none = await postStudioTools(botless.base, botless.botSong, { bot_id: BOT.bot_id });
  assert.equal(none.status, 409);
});

test("a click calls the edit once and reports whether it was already granted", async (t) => {
  const calls = [];
  const { base, botSong } = await boot(t, {
    give: async (request) => {
      calls.push(request);
      return { ok: true, already: false };
    },
  });

  const granted = await postStudioTools(base, botSong, { bot_id: BOT.bot_id });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.body, { ok: true, already: false });
  assert.deepEqual(calls, [{ botId: BOT.bot_id, projectId: PROJECT }]);
});

test("each refusal the edit throws keeps its status and its sentence", async (t) => {
  const cases = [
    { code: "not_found", status: 404, message: "That bot is not this project's bot any more." },
    { code: "stale", status: 409, message: "The bot changed meanwhile; reload and try again." },
    { code: "bad_def", status: 422, message: "That bot's definition could not be read; fix it in Bot Builder first." },
    { code: "over_budget", status: 422, message: "That bot is near its model's tool limit." },
  ];

  for (const expected of cases) {
    const { base, botSong } = await boot(t, {
      give: async () => {
        throw Object.assign(new Error(expected.message), { code: expected.code });
      },
    });
    const answer = await postStudioTools(base, botSong, { bot_id: BOT.bot_id });
    assert.equal(answer.status, expected.status, expected.code);
    assert.deepEqual(answer.body, { error: expected.message }, expected.code);
  }
});

test("without the injected edit the route answers 503", async (t) => {
  const { base, botSong } = await boot(t, { give: null });
  const refused = await postStudioTools(base, botSong, { bot_id: BOT.bot_id });
  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, { error: "Studio cannot change a bot's tools on this instance." });
});

// ---- the def edit itself ------------------------------------------------

/** The bot row these helper tests edit. */
const HELPER_BOT = "bassbot";

/** Another bot, in another project. */
const OTHER_BOT = "otherbot";

/** @returns {Promise<object>} a scratch crow.db with the two tables the helper touches. */
async function helperDb(t) {
  const db = scratchDb(t);
  await db.execute(`
    CREATE TABLE pi_bot_defs (
      bot_id        TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      definition    TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      project_id    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    CREATE TABLE project_audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL,
      actor_type    TEXT NOT NULL,
      actor_id      TEXT,
      action        TEXT NOT NULL,
      target        TEXT,
      payload       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

/** One bot def, as Bot Builder stores it: a few tools, and settings the edit must not touch. */
function botDef(overrides = {}) {
  return {
    model: "a-model",
    tools: { crow_mcp: ["board/board_get_item"], fs: ["read"] },
    persona: { tone: "dry" },
    ...overrides,
  };
}

/** @returns {Promise<string>} one bot's stored definition, exactly as stored. */
async function storedDefinition(db, botId) {
  const { rows } = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [botId] });
  return rows[0].definition;
}

/** @returns {Promise<object>} the stored def of one bot, parsed. */
async function storedDef(db, botId) {
  return JSON.parse(await storedDefinition(db, botId));
}

/** @returns {Promise<object[]>} every audit row this bot's grant wrote. */
async function grantRows(db) {
  const { rows } = await db.execute({
    sql: "SELECT project_id, actor_type, action, target, payload FROM project_audit_log WHERE action = 'bot.tools.grant'",
    args: [],
  });
  return rows;
}

/** Seed one bot row with a def, and hand back the raw definition string. */
async function seedBot(db, { botId = HELPER_BOT, projectId = PROJECT, def = botDef() } = {}) {
  const raw = JSON.stringify(def);
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id) VALUES (?, ?, ?, ?)",
    args: [botId, "Bass Bot", raw, projectId],
  });
  return raw;
}

/** @returns {object} the helper over a real client, with the audit append really writing. */
function giveToolsOf(db, overrides = {}) {
  return createGiveBotStudioTools({
    db,
    appendAudit: (entry) => appendAudit(db, entry),
    emitDefsChanged: () => {},
    ...overrides,
  });
}

test("the def edit appends one bare studio entry and leaves everything else alone", async (t) => {
  const db = await helperDb(t);
  const before = await seedBot(db);
  const primed = [];
  const given = giveToolsOf(db, {
    primeTools: async (def) => {
      primed.push(def);
    },
    budgetFor: async () => ({ cap: 40, countFor: () => 5 }),
  });

  assert.equal(await storedDefinition(db, HELPER_BOT), before, "nothing is written before the call");

  const result = await given({ botId: HELPER_BOT, projectId: PROJECT });
  assert.deepEqual(result, { ok: true, already: false });

  const after = await storedDef(db, HELPER_BOT);
  assert.deepEqual(after.tools.crow_mcp, ["board/board_get_item", "studio"], "the bare Studio entry is appended");
  assert.deepEqual(after.tools.fs, ["read"], "the def's other tool lists are untouched");
  assert.equal(after.persona.tone, "dry", "and so is everything that is not a tool list");
  assert.equal(after.model, "a-model");
  assert.equal(primed.length, 1, "the candidate def is primed before the budget is counted");
  assert.deepEqual(primed[0].tools.crow_mcp, ["board/board_get_item", "studio"]);

  // Exactly one audit line, saying what was granted and from where.
  const rows = await grantRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_id, PROJECT);
  assert.equal(rows[0].actor_type, "local");
  assert.equal(rows[0].target, `bot:${HELPER_BOT}`);
  assert.deepEqual(JSON.parse(rows[0].payload), { server: "studio", via: "studio-ask" });

  // A second click changes nothing and audits nothing.
  const again = await given({ botId: HELPER_BOT, projectId: PROJECT });
  assert.deepEqual(again, { ok: true, already: true });
  assert.deepEqual(await storedDef(db, HELPER_BOT), after, "the stored def is the same one");
  assert.equal((await grantRows(db)).length, 1, "no second audit row");

  // A def that already grants a Studio TOOL counts as granted too.
  const spelled = await helperDb(t);
  await seedBot(spelled, { def: botDef({ tools: { crow_mcp: ["studio/studio_play"] } }) });
  const spelledRaw = (await storedDef(spelled, HELPER_BOT)).tools.crow_mcp;
  assert.equal(grantsStudioTools({ tools: { crow_mcp: spelledRaw } }), true);
  assert.deepEqual((await giveToolsOf(spelled)({ botId: HELPER_BOT, projectId: PROJECT })).already, true);
});

test("the def edit creates tools/crow_mcp when the def has none", async (t) => {
  const db = await helperDb(t);
  await seedBot(db, { def: { model: "a-model" } });

  const candidate = withStudioTools({ model: "a-model" });
  assert.deepEqual(candidate.tools, { crow_mcp: ["studio"] }, "a missing tools list is created, not required");

  await giveToolsOf(db)({ botId: HELPER_BOT, projectId: PROJECT });
  const after = await storedDef(db, HELPER_BOT);
  assert.deepEqual(after.tools.crow_mcp, ["studio"]);
  assert.deepEqual(Object.keys(after).sort(), ["model", "tools"], "no other key is created");
});

test("a definition that changed since it was read is stale", async (t) => {
  const db = await helperDb(t);
  const readDefinition = await seedBot(db);
  const newer = JSON.stringify(botDef({ persona: { tone: "warm" } }));

  // The race Bot Builder's compare-and-swap exists for: the row is rewritten
  // after the helper read it, so its write matches nothing.
  const racy = {
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (/SELECT definition, project_id/i.test(sql)) {
        await db.execute({ sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = ?", args: [newer, HELPER_BOT] });
        return { rows: [{ definition: readDefinition, project_id: PROJECT }] };
      }
      return db.execute(statement);
    },
  };

  await assert.rejects(
    createGiveBotStudioTools({ db: racy, appendAudit: (entry) => appendAudit(db, entry) })({
      botId: HELPER_BOT,
      projectId: PROJECT,
    }),
    (err) => {
      assert.equal(err.code, "stale");
      assert.match(err.message, /reload and try again/);
      return true;
    },
  );
  assert.deepEqual(await storedDef(db, HELPER_BOT), JSON.parse(newer), "the concurrent save stands");
  assert.equal((await grantRows(db)).length, 0, "and nothing was audited");
});

test("another project's bot is not found, and nothing is written", async (t) => {
  const db = await helperDb(t);
  await seedBot(db, { botId: OTHER_BOT, projectId: BOTLESS_PROJECT });
  const before = await storedDef(db, OTHER_BOT);

  await assert.rejects(giveToolsOf(db)({ botId: OTHER_BOT, projectId: PROJECT }), (err) => {
    assert.equal(err.code, "not_found");
    return true;
  });
  assert.deepEqual(await storedDef(db, OTHER_BOT), before);
  assert.equal((await grantRows(db)).length, 0);

  // A bot nobody stored is the same answer.
  await assert.rejects(giveToolsOf(db)({ botId: "ghost", projectId: PROJECT }), { code: "not_found" });
});

test("a model whose tool budget is already spent refuses the edit", async (t) => {
  const db = await helperDb(t);
  const before = await seedBot(db);

  await assert.rejects(
    giveToolsOf(db, { primeTools: async () => {}, budgetFor: async () => ({ cap: 5, countFor: () => 6 }) })({
      botId: HELPER_BOT,
      projectId: PROJECT,
    }),
    (err) => {
      assert.equal(err.code, "over_budget");
      assert.match(err.message, /tool limit/);
      assert.match(err.message, /Bot Builder/);
      return true;
    },
  );
  assert.equal(await storedDefinition(db, HELPER_BOT), before, "the def is unchanged");
  assert.equal((await grantRows(db)).length, 0, "and nothing was audited");
});

test("a budget that cannot be read fails open, as the companion helper does", async (t) => {
  const db = await helperDb(t);
  await seedBot(db);
  const logged = [];

  const budgeted = giveToolsOf(db, {
    budgetFor: async () => {
      throw new Error("no model could be resolved");
    },
    log: (line) => logged.push(line),
  });
  assert.deepEqual(await budgeted({ botId: HELPER_BOT, projectId: PROJECT }), { ok: true, already: false });
  assert.deepEqual((await storedDef(db, HELPER_BOT)).tools.crow_mcp, ["board/board_get_item", "studio"]);
  assert.equal(logged.length, 1, "the failed budget read is logged, not fatal");
});