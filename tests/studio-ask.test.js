/**
 * Studio's "Ask the agent" — the project-bot route and the client's half of it.
 *
 * The route (`GET /api/studio/songs/:id/project-bot`) is exercised against a
 * real session hub on a scratch crow.db, an ephemeral express server, and a
 * fake `projectBotOf` whose answer the test controls: that injection is where
 * the `pi_bot_defs` lookup lives in production (the panel loader owns it, see
 * bundles/studio/panel/routes.js), so this file pins the contract instead —
 * the song's own project is what gets asked about, one bot comes back for a
 * project that has one, `{bot_id: null}` for a project that has none, and the
 * dashboard session gate applies like every other Studio route.
 *
 * The client is a string emitted inline into the panel page, so its half is
 * asserted on the text: the Perch interactive paths it drives and the briefing
 * it spawns the session with (the song id and the no-locked-tracks rule). No
 * fake Perch server is needed for that.
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
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import { CLIENT_SCRIPT } from "../bundles/studio/panel/client.js";

/** The project with a bot, and one without. */
const PROJECT = 21;
const BOTLESS_PROJECT = 22;

/** The dashboard's author for a song created through the hub. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bot this file's fake `projectBotOf` answers for PROJECT. */
const BOT = Object.freeze({ bot_id: "bassbot", name: "Bass Bot" });

/** A scratch libsql client for one test, closed when the test ends. */
function scratchDb(t) {
  const db = createClient({ url: "file:" + join(mkdtempSync(join(tmpdir(), "studio-")), "crow.db") });
  t.after(() => db.close());
  return db;
}

/**
 * A project ACL that allows the two projects here and swallows the audit rows.
 * @returns {{assertProjectExists: Function, assertCapability: Function, appendAudit: Function}}
 */
function fakeAcl() {
  const projects = new Set([PROJECT, BOTLESS_PROJECT]);
  async function assertProjectExists(_db, projectId) {
    const id = Number(projectId);
    if (!projects.has(id)) throw new AclError(`Project #${id} not found`, "not_found");
    return { id };
  }
  async function assertCapability(db, projectId) {
    return assertProjectExists(db, projectId);
  }
  async function appendAudit() {}
  return { assertProjectExists, assertCapability, appendAudit };
}

/**
 * Boot the Studio router on 127.0.0.1:0 with one song per project.
 *
 * @param {import("node:test").TestContext} t
 * @param {{session?: boolean}} [options] - `session: false` installs a dashboard
 *   gate that refuses every request, the way an ended session answers
 */
async function boot(t, { session = true } = {}) {
  const db = scratchDb(t);
  await initStudioTables(db);
  const hub = createHub({ db, acl: fakeAcl(), onBroadcast: () => {} });

  const botSong = await hub.createSong({ project_id: PROJECT, title: "Bass song", author: HUMAN });
  assert.equal(botSong.ok, true, `createSong was refused: ${botSong.error}`);
  const otherSong = await hub.createSong({ project_id: BOTLESS_PROJECT, title: "Other song", author: HUMAN });
  assert.equal(otherSong.ok, true, `createSong was refused: ${otherSong.error}`);

  /** Every project id the route asked the injected lookup about. */
  const asked = [];
  const web = createStudioWeb({
    hub,
    Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: () => "good",
      verifySession: async () => ({}),
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome: mkdtempSync(join(tmpdir(), "studio-home-")),
    bundleDir: null,
    projectBotOf: async (projectId) => {
      asked.push(Number(projectId));
      return Number(projectId) === PROJECT ? { ...BOT } : null;
    },
  });

  const dashboardAuth = session
    ? (_req, _res, next) => next()
    : (_req, res) => res.status(401).json({ error: "unauthorized" });

  const app = express();
  // The gateway parses JSON for every route before the panel router.
  app.use(express.json({ limit: "1mb" }));
  app.use(web.router(dashboardAuth));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    try {
      server.closeAllConnections?.();
    } catch {
      // Nothing left to close.
    }
    server.close(() => resolve());
  }));

  const { port } = server.address();
  return { hub, asked, botSong: botSong.song_id, otherSong: otherSong.song_id, base: `http://127.0.0.1:${port}` };
}

/** GET one project-bot answer; returns the status and the parsed body. */
async function projectBot(base, songId) {
  const response = await fetch(`${base}/api/studio/songs/${encodeURIComponent(songId)}/project-bot`);
  return { status: response.status, body: await response.json() };
}

test("project-bot route returns the song project's bot, and null without one", async (t) => {
  const { base, asked, botSong, otherSong } = await boot(t);

  const found = await projectBot(base, botSong);
  assert.equal(found.status, 200, "a song of the bot's project answers 200");
  assert.equal(found.body.bot_id, BOT.bot_id, "the enabled bot of that project is named");
  assert.equal(found.body.name, BOT.name, "with its display name");
  assert.equal(found.body.project_id, PROJECT, "and the project the page files its session under");
  assert.deepEqual(asked, [PROJECT], "the lookup was asked about the song's own project");

  const none = await projectBot(base, otherSong);
  assert.equal(none.status, 200, "a project with no bot is still a valid answer");
  assert.equal(none.body.bot_id, null, "and says so instead of naming a bot");
  assert.equal(none.body.name, null, "there is no name to show either");
});

test("an unknown song has no project bot", async (t) => {
  const { base, asked } = await boot(t);

  const missing = await projectBot(base, "no-such-song");
  assert.equal(missing.status, 404, "a song that is not there is not found");
  assert.deepEqual(asked, [], "and no bot lookup is made for it");
});

test("the project-bot route needs a dashboard session", async (t) => {
  const { base, asked, botSong } = await boot(t, { session: false });

  const refused = await projectBot(base, botSong);
  assert.equal(refused.status, 401, "without a session the route answers like the rest of the dashboard");
  assert.deepEqual(asked, [], "and nothing behind it is read or asked about");
});

test("the client script drives the Perch interactive session for the project bot", () => {
  // The two calls that make a session and drive it, and the stream its replies
  // arrive on. They are built from the one ASK_API constant, so the text
  // carries the paths with the session id in between.
  assert.ok(CLIENT_SCRIPT.includes("'/dashboard/perch-api'"), "the client knows the Perch API prefix");
  assert.ok(CLIENT_SCRIPT.includes("'/bots/'"), "it spawns the bot's interactive session");
  assert.ok(
    CLIENT_SCRIPT.includes("'/interactive/' + encodeURIComponent(sid) + '/message'"),
    "it sends each question to that session",
  );
  assert.ok(
    CLIENT_SCRIPT.includes("'/interactive/' + encodeURIComponent(sid) + '/events'"),
    "and reads the replies from the session's SSE stream",
  );
  assert.ok(
    CLIENT_SCRIPT.includes("'/api/studio/songs/' + encodeURIComponent(activeSongId) + '/project-bot'"),
    "it asks the project-bot route first",
  );

  // The three sentences a person sees when the bot cannot be reached.
  assert.ok(CLIENT_SCRIPT.includes("'The bot engine is not running.'"), "engine_required has its own sentence");
  assert.ok(
    CLIENT_SCRIPT.includes("' is not set up for chat yet (Bot Builder "),
    "perch_not_attached names the bot and where to fix it",
  );
  assert.ok(CLIENT_SCRIPT.includes("'Could not reach '"), "anything else is a plain could-not-reach");
  // The disabled box's own text belongs to the handler's markup, which is why
  // the script reads that placeholder back instead of carrying it.
  assert.ok(
    CLIENT_SCRIPT.includes("askInput.setAttribute('placeholder', askPlaceholder)"),
    "the ask box's resting text is the handler's own placeholder",
  );
});

test("the briefing names the song and the rules the bot must keep", () => {
  assert.ok(CLIENT_SCRIPT.includes("'You are in Crow Studio on song '"), "the briefing opens with the song");
  assert.ok(CLIENT_SCRIPT.includes("' (' + activeSongId + ')'"), "the song id travels with the title");
  assert.ok(CLIENT_SCRIPT.includes("'. Use the studio_* tools;"), "it names the tools it should use");
  assert.ok(CLIENT_SCRIPT.includes("the human sees every edit live and can undo it."), "and what the person sees");
  assert.ok(CLIENT_SCRIPT.includes("'Never edit locked tracks;"), "it names the locked-track rule");
  assert.ok(CLIENT_SCRIPT.includes("never start or stop their playback."), "and the playback rule");
  assert.ok(
    CLIENT_SCRIPT.includes(
      "tools are available when the operator has enabled the Studio extension for you in Bot Builder.",
    ),
    "and where its tools come from",
  );
});