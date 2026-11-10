/**
 * Security audit N1b-9 — the Bot Builder Safety tab must not claim limits the bot
 * does not have.
 *
 * The old page said, unconditionally, "These limits are enforced each time the bot
 * runs. Anything not allowed here is blocked." In the DEFAULT tier a bot's commands
 * run as the gateway's own user, so `read_paths`/`write_paths` are what the bot is
 * TOLD to use, not what it is held to; only the contain tier enforces them, and even
 * then crow.db/tasks.db stay read-write. The tab now shows the instance's level from
 * containment-status.mjs (through the same helper Settings → Bot Runtime uses —
 * containmentBots + instanceContainment, imported, never re-derived) and words the
 * folder card and the summary line for that level, in both languages.
 *
 * No real home, database, bwrap probe or MCP probe is used: the bot rows come from a
 * db stub, the tool sources are pinned, and the host probe is the section's own seam.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

import { renderSafety } from "../servers/gateway/dashboard/panels/bot-builder/tab-safety.js";
import { _setSourcesForTest } from "../servers/gateway/dashboard/panels/bot-builder/sources.js";
import { _setHostBwrapProbeForTest, containmentBots } from "../servers/gateway/dashboard/settings/sections/bot-runtime.js";
import {
  _resetContainmentForTest, recordContainment, botContainment, LEVEL_PARTLY, OPEN_DATA_DBS,
} from "../scripts/pi-bots/containment-status.mjs";
import { translations, t, fill } from "../servers/gateway/dashboard/shared/i18n.js";

const BOT = "helper";
const HOME = mkdtempSync(join(tmpdir(), "crow-audit-n1b9-"));
const savedSupervisor = process.env.PIBOT_SUPERVISOR;

/** The enabled pi bot the level is computed from. */
const BOT_ROW = {
  bot_id: BOT,
  display_name: "Helper",
  enabled: 1,
  definition: JSON.stringify({ engine: "pi", tools: { crow_mcp: [], pi_builtin: [] } }),
};

/** A db stub: pi_bot_defs rows for the level query, nothing else. */
function dbWith(rows = [BOT_ROW]) {
  return {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : (q && q.sql) || "";
      if (/pi_bot_defs/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

const ctx = (lang = "en", rows = [BOT_ROW]) => ({
  db: dbWith(rows),
  def: { tools: { crow_mcp: [] }, permission_policy: { bash: "deny", write_paths: [] } },
  botId: BOT,
  lang,
  hidden: (tab) => `<input type="hidden" name="tab" value="${tab}">`,
  crowHome: HOME,
});

before(() => {
  _setSourcesForTest({ error: null, sources: [] });
  // A host WITH bwrap, so "not contained" here is the tier's answer, not the host's.
  _setHostBwrapProbeForTest(() => true);
});

after(() => {
  _setSourcesForTest(null);
  _setHostBwrapProbeForTest(null);
  _resetContainmentForTest();
  if (savedSupervisor === undefined) delete process.env.PIBOT_SUPERVISOR;
  else process.env.PIBOT_SUPERVISOR = savedSupervisor;
  rmScratch(HOME);
});

beforeEach(() => {
  _resetContainmentForTest();
  _setHostBwrapProbeForTest(() => true);
  delete process.env.PIBOT_SUPERVISOR;
});

/** The contain tier's own status, recorded exactly as bridge.mjs records a spawn. */
function recordContainSpawn(botId = BOT, mcpServers = []) {
  const status = botContainment({ tier: "contain", mcpServers, tools: [] });
  recordContainment(botId, { ...status, tier: "contain" });
  return status;
}

test("the Safety tab says the folders are not limits when bots are not contained", async () => {
  // No record: the bot counts as not contained (never guessed from the gateway's env).
  const html = await renderSafety(ctx("en"));

  assert.ok(html.includes(translations["botbuilder.sfFoldersNotLimits"].en),
    "the folders card says what the lists really are");
  assert.match(html, /not contained/, "the computed level is shown, in Bot Runtime's words");
  assert.equal(fill(t("settings.botRuntimeContainmentLevel", "en"), { level: t("settings.containment.levelNot", "en") }),
    "Bots: not contained");
  assert.ok(html.includes(translations["botbuilder.sfSummaryNotContained"].en), "and the summary agrees");
  assert.ok(html.includes('href="/dashboard/settings?section=bot-runtime"'),
    "it links to the section that turns containment on — no switch invented here");
  assert.ok(html.includes("your home folder"), "it names what the bot can really reach");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforced"].en), "no enforcement is claimed");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforcedDbs"].en), "no enforcement is claimed");

  // The sentence the audit flagged is gone from the copy AND from the page.
  assert.equal(translations["botbuilder.hintPermEnforced"], undefined, "the unconditional claim is deleted");
  assert.ok(!/enforced each time the bot runs\. Anything not allowed here is blocked/.test(html));

  // The Spanish page says the same thing, in Spanish.
  const es = await renderSafety(ctx("es"));
  assert.ok(es.includes(translations["botbuilder.sfFoldersNotLimits"].es), "es folders card");
  assert.ok(es.includes(translations["botbuilder.sfSummaryNotContained"].es), "es summary");
});

test("the Safety tab says the folders are enforced when bots are contained, and names the databases they still reach", async () => {
  const status = recordContainSpawn();
  assert.equal(status.level, LEVEL_PARTLY, "Phase 1: a contain spawn is partly contained");
  assert.ok(status.open.includes(OPEN_DATA_DBS));

  const html = await renderSafety(ctx("en"));
  assert.ok(html.includes(translations["botbuilder.sfFoldersEnforcedDbs"].en),
    "the enforced sentence, with the databases that stay open");
  assert.match(html, /partly contained/, "the computed level, not a claim of full containment");
  assert.ok(html.includes("crow.db") && html.includes("tasks.db"), "both databases are named");
  assert.ok(html.includes(translations["botbuilder.sfSummaryContained"].en), "the summary agrees");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersNotLimits"].en), "not the unenforced wording");
  assert.ok(!html.includes(translations["botbuilder.sfContainmentLink"].en), "no \"turn it on\" link when it is on");

  const es = await renderSafety(ctx("es"));
  assert.ok(es.includes(translations["botbuilder.sfFoldersEnforcedDbs"].es), "es folders card");
  assert.ok(es.includes(translations["botbuilder.sfSummaryContained"].es), "es summary");
});

test("no bot observed: the page never claims enforcement (the level line says so)", async () => {
  // A bot page whose row the level query does not return (e.g. this bot is disabled):
  // nothing was observed, so the folders cannot be presented as limits.
  const html = await renderSafety(ctx("en", []));
  assert.ok(html.includes(translations["botbuilder.sfFoldersNotLimits"].en));
  assert.ok(html.includes(t("settings.containment.noBots", "en")), "Bot Runtime's own \"no bots\" sentence");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforced"].en));
});

test("a bot outside the contained list is told its folders are not limits", async () => {
  // The contain tier can cover a subset of the bots (CROW_PI_CONTAIN_BOTS), and the
  // containment list is per bot: another bot's `partly contained` says nothing about
  // THIS bot's folders, so the enforced wording is never shown from it.
  const OTHER = "second";
  const rows = [BOT_ROW, { bot_id: OTHER, display_name: "Second", enabled: 1, definition: JSON.stringify({ engine: "pi" }) }];
  const status = recordContainSpawn(BOT);
  assert.equal(status.level, LEVEL_PARTLY, "the other bot really is contained");

  const html = await renderSafety({ ...ctx("en", rows), botId: OTHER });
  assert.ok(html.includes(translations["botbuilder.sfFoldersNotLimits"].en),
    "this bot's folders are not limits, whatever another bot's spawn did");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforced"].en));
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforcedDbs"].en), "no enforcement is claimed");
  assert.ok(html.includes(translations["botbuilder.sfSummaryNotContained"].en), "the summary agrees");

  // The contained bot's own page still says it — the wording follows the BOT, not the page.
  const mine = await renderSafety(ctx("en", rows));
  assert.ok(mine.includes(translations["botbuilder.sfFoldersEnforcedDbs"].en), "the contained bot keeps its wording");

  const es = await renderSafety({ ...ctx("es", rows), botId: OTHER });
  assert.ok(es.includes(translations["botbuilder.sfFoldersNotLimits"].es), "es folders card");

  // A DISABLED pi bot is not in the list at all (it is enabled pi bots only), so nothing
  // was observed: not-limits, plus the one true thing — the tier is chosen at every pi
  // spawn (pi_contain.mjs), so it is decided when the bot runs.
  const disabledRows = [BOT_ROW, { bot_id: OTHER, display_name: "Second", enabled: 0, definition: JSON.stringify({ engine: "pi" }) }];
  const disabled = { ...ctx("en", disabledRows), botId: OTHER, bot: { bot_id: OTHER, enabled: 0, definition: JSON.stringify({ engine: "pi" }) } };
  const off = await renderSafety(disabled);
  assert.ok(off.includes(translations["botbuilder.sfFoldersNotLimits"].en), "not-limits for a bot that never ran");
  assert.ok(off.includes(translations["botbuilder.sfContainmentRunsChecked"].en), "and it says when containment is decided");
  assert.ok(!off.includes(translations["botbuilder.sfFoldersEnforced"].en));
});

test("a probe failure shows the not-limits wording", async () => {
  // Review L4: the level is read from the host probe, and a probe that cannot answer
  // must never turn into a claim of limits. (currentProbe() returns the seam's object
  // as-is; reading .ok from a broken one is the failure this page has to survive.)
  recordContainSpawn();
  _setHostBwrapProbeForTest(() => ({ get ok() { throw new Error("probe exploded"); } }));

  const html = await renderSafety(ctx("en"));
  assert.ok(html.includes(translations["botbuilder.sfFoldersNotLimits"].en), "the honest wording, not an error page");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforced"].en));
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforcedDbs"].en), "no enforcement is claimed");
  assert.ok(html.includes(translations["botbuilder.sfSummaryNotContained"].en), "the summary agrees");
});

test("the Safety tab reads the level from containment-status.mjs, not from its own rule", async () => {
  // PIBOT_SUPERVISOR=external means the spawns happen in another process: the level
  // must then stay `not contained` even though a record exists here — the same answer
  // Settings → Bot Runtime gives, because it is the same helper.
  recordContainSpawn();
  const observed = await containmentBots(dbWith());
  assert.equal(observed[0].level, LEVEL_PARTLY);
  process.env.PIBOT_SUPERVISOR = "external";
  const html = await renderSafety(ctx("en"));
  assert.ok(html.includes(translations["botbuilder.sfFoldersNotLimits"].en),
    "an unobserved spawn is not told apart from an uncontained one");
  assert.ok(!html.includes(translations["botbuilder.sfFoldersEnforced"].en));
  const unobserved = await containmentBots(dbWith());
  assert.notEqual(unobserved[0].level, LEVEL_PARTLY);
});