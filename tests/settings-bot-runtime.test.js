/**
 * Settings → Bot Runtime: the honest containment status (bot containment
 * Phase 1, Task 8; fixed by the PR 7 fix wave, F1 + F3). Phase 1 can never show
 * "contained" for a bot; the section must render `Bots: partly contained` plus
 * every open line for a bot whose spawn THIS process recorded, and it must
 * NEVER claim more than it observed: no record (or PIBOT_SUPERVISOR=external,
 * whose spawns run in another unit) is `not contained` with the unobserved
 * line, never a tier guessed from the gateway's own env.
 *
 * The host's bwrap probe is pinned (a test box may lack bwrap, which would make
 * the whole instance `not contained` for the right reason but not the one under
 * test). No real home, database or bot is touched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import section, {
  renderContainmentStatus, containmentLineText, secretsAncestorsStatus, _setHostBwrapProbeForTest,
} from "../servers/gateway/dashboard/settings/sections/bot-runtime.js";
import {
  _resetContainmentForTest, recordContainment, botContainment, addOnLine,
  OPEN_DATA_DBS, OPEN_BROWSER, OPEN_SECRETS_SWAP, OPEN_UNCONTAINED, OPEN_NO_BWRAP, OPEN_UNOBSERVED,
} from "../scripts/pi-bots/containment-status.mjs";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const savedEnv = {
  CROW_PI_SANDBOX: process.env.CROW_PI_SANDBOX,
  CROW_PI_CONTAIN_BOTS: process.env.CROW_PI_CONTAIN_BOTS,
  PIBOT_SUPERVISOR: process.env.PIBOT_SUPERVISOR,
  CROW_BOT_UID: process.env.CROW_BOT_UID,
};
before(() => { _setHostBwrapProbeForTest(() => true); });
after(() => {
  _setHostBwrapProbeForTest(null);
  _resetContainmentForTest();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/**
 * The GATEWAY's own sandbox env. Setting it is the point: the status must never
 * infer a bot's tier from it (the bot may spawn in another unit with another
 * env), so `containAll()` changes nothing unless this process recorded a spawn.
 */
function containAll() {
  process.env.CROW_PI_SANDBOX = "contain";
  delete process.env.CROW_PI_CONTAIN_BOTS;
}
function containNone() {
  delete process.env.CROW_PI_SANDBOX;
  delete process.env.CROW_PI_CONTAIN_BOTS;
}
function externalSupervisor(on) {
  if (on) process.env.PIBOT_SUPERVISOR = "external";
  else delete process.env.PIBOT_SUPERVISOR;
}

/** A db stub: pi_bot_defs rows for the status query, nothing for the flags. */
function dbWith(rows) {
  return {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : (q && q.sql) || "";
      return { rows: /pi_bot_defs/.test(sql) ? rows : [] };
    },
  };
}

const def = (tools) => JSON.stringify({ engine: "pi", tools });
const HELPER = {
  bot_id: "helper",
  display_name: "Helper",
  enabled: 1,
  definition: def({ pi_builtin: ["read"], crow_mcp: ["github/create_issue", "crow-memory/crow_search_memories", "browser/navigate"] }),
};

/** Record what the bridge would have recorded for a contain spawn of this def. */
function recordContainSpawn(botId, mcpServers, tools) {
  const status = botContainment({ tier: "contain", mcpServers, tools });
  recordContainment(botId, { ...status, tier: "contain" });
  return status;
}

test("a recorded contain spawn renders `Bots: partly contained` and each open line, HTML-escaped", async () => {
  containAll();
  _resetContainmentForTest();
  recordContainSpawn("helper", ["github", "crow-memory", "browser"], ["read"]);
  const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
  assert.match(html, /Bots: partly contained/);
  assert.ok(html.includes(OPEN_DATA_DBS), "the crow.db line");
  assert.ok(html.includes("github runs inside the sandbox with its own credentials"), "the add-on line");
  assert.ok(!html.includes("crow-memory runs inside"), "Crow's own server is not an add-on");
  assert.ok(html.includes(OPEN_BROWSER), "the browser line");
  assert.ok(!html.includes(OPEN_SECRETS_SWAP), "no uncontained bot: no secrets-dir line");
  assert.ok(!html.includes(OPEN_UNOBSERVED), "a recorded spawn is observed");
  assert.ok(html.includes(t("settings.containment.note", "en")), "the phase 1 note");
  assert.equal(section.id, "bot-runtime");
  _resetContainmentForTest();
});

test("no record: the bot counts as not contained, never inferred from the gateway's own env (F1)", async () => {
  // The gateway's env says contain — a wrong answer is exactly what the old
  // fallback produced, because the bot may spawn with an env this process
  // never sees.
  containAll();
  _resetContainmentForTest();
  const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
  assert.match(html, /Bots: not contained/);
  assert.ok(!html.includes("Bots: partly contained"));
  assert.ok(html.includes("helper: " + OPEN_UNOBSERVED));
  assert.ok(html.includes(OPEN_SECRETS_SWAP), "an unobserved bot can swap the secrets dir");
  assert.ok(!html.includes(OPEN_DATA_DBS), "nothing about the bot's config is claimed");
});

test("PIBOT_SUPERVISOR=external: no record + CROW_PI_SANDBOX=contain is still `not contained`, with the line (F1)", async () => {
  containAll();
  externalSupervisor(true);
  _resetContainmentForTest();
  try {
    const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
    assert.match(html, /Bots: not contained/);
    assert.ok(!html.includes("Bots: partly contained"));
    assert.ok(html.includes("helper: " + OPEN_UNOBSERVED));
    assert.ok(html.includes(OPEN_SECRETS_SWAP), "the secrets-swap line is not dropped");
  } finally {
    externalSupervisor(false);
  }
});

test("PIBOT_SUPERVISOR=external: even a record made here is insufficient (the channel turns run elsewhere)", async () => {
  containAll();
  _resetContainmentForTest();
  externalSupervisor(true);
  recordContainSpawn("helper", ["crow-memory"], []);
  try {
    const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
    assert.match(html, /Bots: not contained/);
    assert.ok(!html.includes("Bots: partly contained"));
    assert.ok(html.includes("helper: " + OPEN_UNOBSERVED));
  } finally {
    externalSupervisor(false);
    _resetContainmentForTest();
  }
});

test("a hostile server name is escaped, never markup", async () => {
  containAll();
  _resetContainmentForTest();
  const evil = { ...HELPER, bot_id: "evil", definition: def({ pi_builtin: [], crow_mcp: ["<img src=x onerror=alert(1)>/t"] }) };
  recordContainSpawn("evil", ["<img src=x onerror=alert(1)>"], []);
  try {
    const html = await section.render({ db: dbWith([evil]), lang: "en" });
    assert.ok(!html.includes("<img src=x onerror=alert(1)>"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; runs inside the sandbox with its own credentials"));
  } finally {
    _resetContainmentForTest();
  }
});

test("a recorded uncontained spawn shows `Bots: not contained` with its own line and the secrets-dir line", async () => {
  containNone();
  _resetContainmentForTest();
  recordContainment("helper", { level: "not contained", open: [OPEN_UNCONTAINED], tier: "none" });
  try {
    const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
    assert.match(html, /Bots: not contained/);
    assert.ok(html.includes("helper: " + OPEN_UNCONTAINED));
    assert.ok(html.includes(OPEN_SECRETS_SWAP));
    assert.ok(!html.includes(OPEN_DATA_DBS));
  } finally {
    _resetContainmentForTest();
  }
});

test("a host without bwrap is not contained and says so", async () => {
  containAll();
  _resetContainmentForTest();
  _setHostBwrapProbeForTest(() => false);
  try {
    const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
    assert.match(html, /Bots: not contained/);
    assert.ok(html.includes(OPEN_NO_BWRAP));
  } finally {
    _setHostBwrapProbeForTest(() => true);
  }
});

test("the last spawn's recorded status wins over the defs (a refused spawn names the provider)", async () => {
  containAll();
  _resetContainmentForTest();
  recordContainment("helper", { level: "not contained", open: ["provider lan-row has no door"], tier: null });
  try {
    const html = await section.render({ db: dbWith([HELPER]), lang: "en" });
    assert.match(html, /Bots: not contained/);
    assert.ok(html.includes("helper: provider lan-row has no door"));
    assert.ok(html.includes(OPEN_SECRETS_SWAP), "a refused bot runs nothing contained, so it can swap the secrets dir");
  } finally {
    _resetContainmentForTest();
  }
});

test("no enabled bots: the level line says so instead of claiming containment", async () => {
  containAll();
  _resetContainmentForTest();
  const html = await section.render({ db: dbWith([{ ...HELPER, enabled: 0 }]), lang: "en" });
  assert.ok(html.includes(t("settings.containment.noBots", "en")));
  assert.ok(!/Bots: contained/.test(html));
});

test("Spanish: the heading and level line translate; the English sentences stay recoverable", async () => {
  containAll();
  _resetContainmentForTest();
  recordContainSpawn("helper", ["browser"], []);
  try {
    const html = await section.render({ db: dbWith([HELPER]), lang: "es" });
    assert.ok(html.includes(t("settings.containment.title", "es")));
    assert.ok(html.includes(t("settings.containment.levelPartly", "es")));
    assert.notEqual(t("settings.containment.levelPartly", "es"), t("settings.containment.levelPartly", "en"));
    assert.ok(html.includes(t("settings.containment.openBrowser", "es")));
  } finally {
    _resetContainmentForTest();
  }
});

test("Spanish: the unobserved line and the other-owner reason are translated too", async () => {
  containAll();
  _resetContainmentForTest();
  const html = await section.render({ db: dbWith([HELPER]), lang: "es" });
  assert.ok(html.includes(t("settings.containment.levelNot", "es")));
  assert.ok(html.includes(t("settings.containment.openUnobserved", "es")));
  assert.notEqual(t("settings.containment.openUnobserved", "es"), t("settings.containment.openUnobserved", "en"));
  const status = renderContainmentStatus({
    bots: [{ botId: "helper", level: "partly contained", open: [OPEN_DATA_DBS] }],
    host: { bwrap: true },
    ancestors: { ok: false, refused: false, findings: [{ path: "/home/x/.crow", why: "owned by another user" }] },
    lang: "es",
  });
  assert.ok(status.includes(t("settings.containment.whyOtherOwner", "es")));
  assert.notEqual(t("settings.containment.whyOtherOwner", "es"), "owned by another user");
});

test("containmentLineText: English output is the policy sentence byte for byte, bot prefix included", () => {
  for (const line of [OPEN_DATA_DBS, OPEN_BROWSER, OPEN_SECRETS_SWAP, OPEN_UNCONTAINED, OPEN_NO_BWRAP, OPEN_UNOBSERVED]) {
    assert.equal(containmentLineText(line, "en"), line);
  }
  assert.equal(containmentLineText("helper: " + OPEN_BROWSER, "en"), "helper: " + OPEN_BROWSER);
  assert.equal(containmentLineText("helper: " + OPEN_UNOBSERVED, "en"), "helper: " + OPEN_UNOBSERVED);
  assert.equal(containmentLineText(addOnLine("github"), "en"), "github runs inside the sandbox with its own credentials");
  assert.equal(containmentLineText("provider lan-row has no door", "en"), "provider lan-row has no door");
  assert.equal(containmentLineText("something new entirely", "en"), "something new entirely");
  for (const lang of ["en", "es"]) {
    assert.notEqual(containmentLineText(OPEN_DATA_DBS, lang), OPEN_DATA_DBS + "x");
    assert.notEqual(t("settings.containment.openNoDoor", lang), "");
  }
});

test("renderContainmentStatus: the ancestors findings are listed, and a refused anchor says why", () => {
  const html = renderContainmentStatus({
    bots: [{ botId: "helper", level: "partly contained", open: [OPEN_DATA_DBS] }],
    host: { bwrap: true },
    ancestors: { ok: false, refused: true, findings: [{ path: "/home/x/.crow", why: "group-writable by a group with other members" }] },
    lang: "en",
  });
  assert.ok(html.includes("Bots: partly contained"));
  assert.ok(html.includes("/home/x/.crow: group-writable by a group with other members"));
  assert.ok(html.includes(t("settings.containment.ancestorRefused", "en")));
});

test("F3: CROW_BOT_UID alone is not a refusal — `refused` is the report's own verdict", (t2) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crow-bot-runtime-f3-")));
  t2.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "secrets"), { recursive: true, mode: 0o700 });
  const env = { CROW_HOME: root, CROW_BOT_UID: "54321" };
  const clean = (p) => ({ uid: process.getuid(), gid: process.getgid(), mode: 0o040755 });
  const cleanTree = secretsAncestorsStatus(env, { stat: clean });
  assert.deepEqual(cleanTree.findings, []);
  assert.equal(cleanTree.refused, false, "a clean tree is not refused just because a bot uid is set");
  const html = renderContainmentStatus({
    bots: [{ botId: "helper", level: "partly contained", open: [OPEN_DATA_DBS] }],
    host: { bwrap: true }, ancestors: cleanTree, lang: "en",
  });
  assert.ok(!html.includes(t("settings.containment.ancestorRefused", "en")), "no refused text for a clean tree");
  // The field is live: the same env over a world-writable ancestor IS refused.
  const dirty = secretsAncestorsStatus(env, { stat: () => ({ uid: process.getuid(), gid: process.getgid(), mode: 0o040777 }) });
  assert.equal(dirty.refused, true);
  const refusedHtml = renderContainmentStatus({ bots: [], host: { bwrap: true }, ancestors: dirty, lang: "en" });
  assert.ok(refusedHtml.includes(t("settings.containment.ancestorRefused", "en")));
});