// Crow Mail plan 3, Task 8b: the drafting turn in the bot runtime.
//
// A drafting turn is one pi spawn carrying exactly three MCP tools (read the draft's thread, read
// the person's context, propose the next revision) and exactly one MCP server block — this
// instance's own `/mail-draft/mcp` with a per-turn `mdt_` token and a `mail-draft` actor signature.
// Nothing is spawned here for the turn-level cases: `startDraftingTurn`'s `deps` seam hands it a
// `handleInbound` that records what it was given, so the token lifecycle, the session dir and the
// prompt are asserted without a pi process. The bridge cases drive the real `handleInbound` against
// a protocol-speaking stub pi (the tests/bridge-board-rail.test.js harness): the stub records its
// argv and the MCP config it was handed, and answers one prompt.
//
// The model gate and the csv/golden cases are pure functions and need no database.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ---------------------------------------------------------------- scratch env
//
// Before ANY import of bridge.mjs / mcp_writer.mjs: mcp_writer captures
// `CANONICAL_MCP_PATH` (`HOME + "/.pi/agent/mcp.json"`) at module load, so a
// `process.env.HOME =` made after a static import would always be too late.
for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];

const ROOT = mkdtempSync(join(tmpdir(), "mail-draft-turn-"));
const HOME_DIR = join(ROOT, "home");
mkdirSync(join(HOME_DIR, ".pi", "agent"), { recursive: true });
writeFileSync(join(HOME_DIR, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = HOME_DIR;
process.env.CROW_HOME = join(ROOT, "crowhome");
process.env.CROW_DATA_DIR = join(ROOT, "data");
delete process.env.CROW_DB_PATH;
delete process.env.CROW_TASKS_DB_PATH;
delete process.env.CROW_BOT_ENV_PASSTHROUGH;
process.env.CROW_PI_SANDBOX = "off";
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "300";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
process.env.PI_MODELS_JSON = join(ROOT, "models.json");
mkdirSync(process.env.CROW_HOME, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
// The providers table wins over models.json when any row parses (model_resolver.loadModels), so
// both name the same two keys: a loopback provider and a public one.
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
  providers: { stub: { models: [{ id: "m1" }] }, cloudy: { models: [{ id: "m1" }] } },
}));
process.on("exit", () => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* gone */ }
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
});

const CROW_DB = join(process.env.CROW_DATA_DIR, "crow.db");
const CROW_HOME = process.env.CROW_HOME;
const DRAFTBOT_ROOT = join(ROOT, "bots", "draftbot");

/** The bot the plan describes: a def that grants gmail, web, files and messaging. */
function botDef(overrides = {}) {
  return {
    system_prompt: "You draft mail.",
    models: { default: "stub/m1" },
    tools: {
      pi_builtin: ["bash", "read", "write", "edit"],
      crow_mcp: [
        "gmail/gmail_search",
        "gmail/gmail_create_draft",
        "brave-search/brave_web_search",
        "storage/storage_write_file",
        "messaging/messages_send",
      ],
    },
    permission_policy: { bash: "deny", write_paths: [], multi_agent: true },
    session_dir: DRAFTBOT_ROOT,
    ...overrides,
  };
}

function seedBot(id, def) {
  const c = new Database(CROW_DB);
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)")
    .run(id, id, JSON.stringify(def));
  c.close();
}

// ---------------------------------------------------------------- modules (dynamic)
//
// Loaded after the env above is in place. `store`/`accounts` are DB-only; `bridge`/`mcp_writer`
// read env at load (see the note above); `turn` imports `mcp_writer`.
const { createDbClient } = await import("../servers/db.js");
const { createAccount, updateAccount } = await import("../servers/gateway/mail/store/accounts.js");
const { createDraft, getDraft, transition } = await import("../servers/gateway/mail/drafts/store.js");
const { mintTurnToken, verifyTurnToken, TURN_TOKEN_MARGIN_MS, _resetTurnTokensForTests } = await import("../servers/gateway/mail/drafts/turn-token.js");
const {
  DRAFT_TURN_PROMPT, DRAFT_TURNS_DIRNAME, DRAFT_SESSION_RETENTION_MS, CLOUD_DRAFTING_SETTING,
  allowDraftModel, draftingTurnPrompt, readDraftingSettings, startDraftingTurn,
  _draftingTurnsInFlightForTests,
} = await import("../servers/gateway/mail/drafts/turn.js");
const {
  DRAFTING_TURN_TOOLS, MAIL_DRAFT_SERVER, isDraftingTurnTools, mailDraftBlock, mailDraftTurnDir,
} = await import("../scripts/pi-bots/mcp_writer.mjs");
const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
const { buildToolsCsv, toolAllowlist, handleInbound } = await import("../scripts/pi-bots/bridge.mjs");
const { initGatewayActorKey, verifyMailDraftActorSig, _resetActorKeyForTest } = await import("../scripts/pi-bots/actor-sig.mjs");

/** The one path a drafting turn's world root may be: `<CROW_HOME>/mail-draft-turns/<botId>/<draftId>`. */
function turnDirFor(botId, draftId) {
  return join(CROW_HOME, DRAFT_TURNS_DIRNAME, botId, draftId);
}

const RESOLVED = { provider: "stub", model: "m1", key: "stub/m1" };
const THREE = [
  "mcp__crow-mail-draft__mail_draft_read_thread",
  "mcp__crow-mail-draft__mail_draft_read_context",
  "mcp__crow-mail-draft__mail_draft_propose",
];
/** The csv `canonicalToolOrder` produces from the three names: `mcp__` group, code-unit order. */
const THREE_CSV = [
  "mcp__crow-mail-draft__mail_draft_propose",
  "mcp__crow-mail-draft__mail_draft_read_context",
  "mcp__crow-mail-draft__mail_draft_read_thread",
].join(",");
/** The csv this def's envelope produces without `exactTools`, pinned byte for byte so the drafting
 * option cannot move it. */
const GOLDEN_CHANNEL_CSV = "bash,edit,read,write,"
  + "mcp__brave-search__brave_web_search,mcp__gmail__gmail_create_draft,mcp__gmail__gmail_search,"
  + "mcp__messaging__messages_send,mcp__storage__storage_write_file";

let mailDb = null;
let account = null;

/** Wait for every turn `startDraftingTurn` launched in this process. */
async function settle() {
  await Promise.all(_draftingTurnsInFlightForTests());
}

/** Poll until `fn()` answers true (for the best-effort writes a timer fires). */
async function waitFor(fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** The `bot_sessions` row of a drafting thread, or null (scoped to one bot when `botId` is given). */
async function draftingSessionRow(draftId, botId = null) {
  const { rows } = botId
    ? await mailDb.execute({
      sql: "SELECT id FROM bot_sessions WHERE gateway_thread_id = ? AND bot_id = ?",
      args: ["mail-draft:" + draftId, botId],
    })
    : await mailDb.execute({
      sql: "SELECT id FROM bot_sessions WHERE gateway_thread_id = ?",
      args: ["mail-draft:" + draftId],
    });
  return rows[0] ?? null;
}

/** Is another bot's row for the same drafting thread still there? */
async function otherBotDraftingSessionRow(draftId) {
  const { rows } = await mailDb.execute({
    sql: "SELECT id FROM bot_sessions WHERE gateway_thread_id = ? AND bot_id = ?",
    args: ["mail-draft:" + draftId, "otherbot"],
  });
  return rows.length > 0;
}

async function makeAccount(overrides = {}) {
  const account = await createAccount(mailDb, {
    label: "Alex",
    address: "alex@example.com",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
  });
  return Object.keys(overrides).length ? updateAccount(mailDb, account.id, overrides) : account;
}

async function makeDraft({ account, botId = "draftbot", state = "draft", now = 1_700_000_000_000 } = {}) {
  const draft = await createDraft(mailDb, {
    accountId: account.id,
    mode: "reply",
    replyToMid: "<m1@mail.example.test>",
    threadKey: "thread-1",
    projectId: null,
    botId,
    chatThreadId: "chat-1",
    audience: "sam",
    first: {
      to: [{ address: "sam@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Tuesday",
      body: "Hello Sam,\n\nTuesday works for me.\n",
      inReplyTo: "<m1@mail.example.test>",
      references: ["<m0@mail.example.test>"],
      attachments: [],
    },
    author: "bot",
  }, { now: () => now });
  if (state === "scheduled") {
    const ok = await transition(mailDb, draft.id, ["draft"], "scheduled", {
      due_at: now + 3_600_000, tap_seal: "seal-1", tap_id: "tap-1", tap_action: "schedule", attach_digest: "digest-1",
    }, { now: () => now });
    assert.equal(ok, true, "precondition: the draft is scheduled");
    return getDraft(mailDb, draft.id);
  }
  return draft;
}

/** A `deps` bag whose handleInbound records what the turn handed it and settles as asked. */
function recordingDeps({ outcome = "resolve" } = {}) {
  const calls = [];
  const logs = [];
  const timers = [];
  const deps = {
    log: (code) => logs.push(String(code)),
    now: () => 1_700_000_000_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() { /* unref'd timer */ } }; },
    handleInbound: async (opts) => {
      calls.push(opts);
      await opts.sendReply("REPLY TEXT THAT MUST NEVER BE LOGGED");
      if (outcome === "reject") {
        throw Object.assign(new Error("turn timed out"), { code: "TIMEOUT" });
      }
    },
  };
  return { deps, calls, logs, timers };
}

function bearerOf(opts) {
  return String(opts.draftingTurn.mcpBlock.headers.Authorization || "").replace(/^Bearer /, "");
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: process.env.CROW_DATA_DIR }, stdio: "pipe", cwd: REPO,
  });
  const c = new Database(CROW_DB);
  c.prepare("INSERT OR REPLACE INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,0)")
    .run("stub", "http://127.0.0.1:8003/v1", "none", "local", JSON.stringify([{ id: "m1" }]));
  c.prepare("INSERT OR REPLACE INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,0)")
    .run("cloudy", "https://api.example.test/v1", "none", "cloud", JSON.stringify([{ id: "m1" }]));
  c.close();
  // The bridge writes bot_sessions rows; the mail stores read the same file through db.execute.
  mailDb = createDbClient();
  seedBot("draftbot", botDef());
  seedBot("cloudbot", botDef({ models: { default: "cloudy/m1" } }));
  // A bot with a cloud ESCALATION model that a drafting turn must never reach.
  seedBot("escbot", botDef({ models: { default: "stub/m1", escalation: "cloudy/m1" } }));
  // A bot whose def carries a spawn_env key: a drafting turn gets none of it.
  seedBot("envbot", botDef({ spawn_env: { DRAFT_TEST_MARKER: "1" } }));
  initGatewayActorKey();
  account = await makeAccount();
});

after(() => {
  try { mailDb?.close(); } catch { /* already closed */ }
});

/* =========================================================== the csv and the argv pins */

test("the three names are absent from toolAllowlist(def) for every def", () => {
  const defs = [
    botDef(),
    botDef({ tools: { pi_builtin: ["read"], crow_mcp: [] } }),
    botDef({ tools: { crow_mcp: ["crow-browser/browser_navigate"] } }),
    { tools: {} },
    {},
  ];
  for (const def of defs) {
    const csv = toolAllowlist(def, { remoteEnabled: true });
    for (const name of THREE) assert.ok(!csv.includes(name), "the envelope never carries a drafting tool: " + name);
    assert.ok(!/crow-mail-draft/.test(csv));
  }
});

test("buildToolsCsv without exactTools is byte-identical to before", () => {
  // The golden csv the same def produced before `exactTools` existed.
  assert.equal(buildToolsCsv(botDef(), { resolved: RESOLVED }).csv, GOLDEN_CHANNEL_CSV);
  assert.equal(buildToolsCsv(botDef(), { resolved: RESOLVED, exactTools: null }).csv, GOLDEN_CHANNEL_CSV);
  assert.equal(buildToolsCsv(botDef(), { resolved: RESOLVED, exactTools: undefined }).csv, GOLDEN_CHANNEL_CSV);
});

test("buildToolsCsv with exactTools returns exactly the three names, and nothing else", () => {
  // A def that would otherwise add a builtin, the interactive pair and subagent.
  const def = botDef({ permission_policy: { bash: "deny", write_paths: [], multi_agent: true } });
  const { csv, maOptIn, maCapable } = buildToolsCsv(def, {
    resolved: { provider: "alibaba-coding", model: "qwen3.6-plus", key: "alibaba-coding/qwen3.6-plus" },
    interactive: true,
    narrowedTools: JSON.stringify(["read"]),
    exactTools: [...DRAFTING_TURN_TOOLS],
  });
  assert.equal(csv, THREE_CSV);
  assert.equal(maOptIn, false, "no subagent envelope");
  assert.equal(maCapable, false, "and the policy is told the same");
  assert.deepEqual(csv.split(",").sort(), [...THREE].sort());
});

test("exactTools is the frozen three or a refusal — never widened, never narrowed", () => {
  const bad = [
    [],
    ["read", ...DRAFTING_TURN_TOOLS],
    [...DRAFTING_TURN_TOOLS, "bash"],
    DRAFTING_TURN_TOOLS.slice(0, 2),
    [THREE[0], THREE[1], THREE[2].replace("propose", "Propose")],
    [THREE[0], THREE[0], THREE[1]],
    [...DRAFTING_TURN_TOOLS, THREE[0]],
    "mcp__crow-mail-draft__mail_draft_propose",
    [42, THREE[1], THREE[2]],
    null,
  ];
  for (const value of bad) {
    assert.equal(isDraftingTurnTools(value), false, JSON.stringify(value));
    if (value === null) continue;
    assert.throws(() => buildToolsCsv(botDef(), { resolved: RESOLVED, exactTools: value }), /exactTools/);
  }
  assert.ok(Object.isFrozen(DRAFTING_TURN_TOOLS));
  assert.deepEqual([...DRAFTING_TURN_TOOLS].sort(), [...THREE].sort());
});

/* =========================================================== the cloud-model gate */

test("a non-local model is refused unless cloud drafting is on", () => {
  const local = allowDraftModel(botDef(), { localModelsOnly: false }, { providers: [], cloudDrafting: false });
  assert.equal(local.ok, false, "no provider rows prove nothing local, so it is not local (fail closed)");

  const cloud = allowDraftModel({ models: { default: "cloudy/m1" } }, { localModelsOnly: false }, { cloudDrafting: false });
  assert.equal(cloud.ok, false);
  assert.equal(cloud.code, "cloud_drafting_off");

  const on = allowDraftModel({ models: { default: "cloudy/m1" } }, { localModelsOnly: false }, { cloudDrafting: true });
  assert.equal(on.ok, true);
});

test("an account with local_models_only refuses a cloud model even when cloud drafting is on", () => {
  const def = { models: { default: "cloudy/m1" } };
  const verdict = allowDraftModel(def, { localModelsOnly: true }, { cloudDrafting: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "local_models_only");
});

test("a loopback provider is local, so it drafts with the owner switch off — and stays allowed under local_models_only", () => {
  const def = { models: { default: "stub/m1" } };
  const local = (baseUrl) => [{ id: "stub", baseUrl }];
  for (const url of ["http://127.0.0.1:8003/v1", "http://localhost:8003/v1"]) {
    const settings = { providers: local(url), cloudDrafting: false };
    assert.equal(allowDraftModel(def, { localModelsOnly: false }, settings).ok, true, url);
    assert.equal(allowDraftModel(def, { localModelsOnly: true }, settings).ok, true, url);
  }
});

test("a role ref is not proven local, so it waits for the owner switch", () => {
  const verdict = allowDraftModel({ models: { default: "role:chat" } }, { localModelsOnly: false }, { providers: [], cloudDrafting: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "cloud_drafting_off");
});

test("readDraftingSettings defaults cloud drafting off and reads it from dashboard_settings", async () => {
  assert.equal(CLOUD_DRAFTING_SETTING, "mail.cloud_drafting");
  const off = await readDraftingSettings(mailDb);
  assert.equal(off.cloudDrafting, false);
  assert.ok(Array.isArray(off.providers) && off.providers.some((p) => p.id === "stub"));
  await mailDb.execute({
    sql: "INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at) VALUES (?,?,datetime('now'))",
    args: [CLOUD_DRAFTING_SETTING, "1"],
  });
  try {
    const on = await readDraftingSettings(mailDb);
    assert.equal(on.cloudDrafting, true);
  } finally {
    await mailDb.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [CLOUD_DRAFTING_SETTING] });
  }
});

test("readDraftingSettings reads through readSetting, so this instance's override wins", async () => {
  // The per-instance override table is what readSetting adds over the plain dashboard_settings row:
  // the global row says on, this instance's row says off.
  const localId = getOrCreateLocalInstanceId();
  await mailDb.execute({
    sql: "INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at) VALUES (?,?,datetime('now'))",
    args: [CLOUD_DRAFTING_SETTING, "1"],
  });
  await mailDb.execute({
    sql: "INSERT OR REPLACE INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?,?,?,datetime('now'))",
    args: [CLOUD_DRAFTING_SETTING, localId, "0"],
  });
  try {
    const settings = await readDraftingSettings(mailDb);
    assert.equal(settings.cloudDrafting, false, "the override is read, not the global row");
  } finally {
    await mailDb.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE key = ?", args: [CLOUD_DRAFTING_SETTING] });
    await mailDb.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [CLOUD_DRAFTING_SETTING] });
  }
});

/* =========================================================== the prompt */

test("the prompt labels the person's words, and thread text and comments as untrusted data", () => {
  const prompt = draftingTurnPrompt({ instruction: "Shorter, please." });
  assert.ok(prompt.includes("own words"), "the person's instruction has its own labelled section");
  assert.ok(prompt.includes("Shorter, please."));
  assert.ok(prompt.includes("untrusted data"), "thread text and comments are named untrusted");
  assert.match(prompt, /never one to follow/);
  assert.ok(prompt.includes("mail_draft_propose"));
  assert.ok(prompt.includes("mail_draft_read_thread"));
  assert.ok(prompt.includes("mail_draft_read_context"));
  // The thread and the comments themselves never ride the prompt: the three tools read them.
  assert.ok(!prompt.includes("Hello Sam"));
});

test("a revise turn passes the person's own wording in the same labelled section", () => {
  const revised = "Hi Sam — Tuesday at nine, if that still works for you.";
  const prompt = draftingTurnPrompt({ instruction: "Apply my wording.", reviseFrom: revised });
  assert.ok(prompt.includes(revised), "the revision body reaches the bot");
  const labelAt = prompt.indexOf("own words");
  assert.ok(labelAt > 0 && prompt.indexOf(revised) > labelAt, "and it is inside the person's section");
  assert.ok(prompt.includes("Apply my wording."));
  assert.ok(prompt.includes("untrusted data"));
  assert.equal(prompt.indexOf("{person}"), -1, "the slot is filled");
  assert.ok(DRAFT_TURN_PROMPT.includes("{person}"));
});

/* =========================================================== startDraftingTurn */

describe("startDraftingTurn", () => {
  test("it answers {turnId} as soon as the turn is launched, and the turn carries the three tools", async () => {
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    const out = await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    assert.match(out.turnId, /^mt-[0-9a-f]{16}$/);
    await settle();
    assert.equal(calls.length, 1);
    const opts = calls[0];
    assert.equal(opts.bot_id, "draftbot");
    assert.equal(opts.gateway_type, "mail-draft");
    assert.equal(opts.gateway_thread_id, "mail-draft:" + draft.id);
    assert.deepEqual(opts.draftingTurn.exactTools, [...DRAFTING_TURN_TOOLS]);
    assert.equal(opts.user_message, draftingTurnPrompt({ instruction: "Be brief." }));
  });

  test("a file-delivery host is refused before a bot is loaded, a token minted or a turn launched", async () => {
    const { deps, calls, logs } = recordingDeps();
    const loads = [];
    deps.loadBot = async (id) => { loads.push(id); throw new Error("no bot is loaded when the host cannot run the turn"); };
    const draft = await makeDraft({ account });
    const draftDir = turnDirFor("draftbot", draft.id);
    process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
    try {
      await assert.rejects(
        startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." }),
        (err) => err.name === "MailError" && err.code === "delivery_unsupported",
      );
    } finally {
      process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
    }
    assert.equal(loads.length, 0, "the refusal comes before the bot is loaded");
    assert.equal(calls.length, 0, "nothing was launched, so no token ever reached a turn");
    assert.equal(_draftingTurnsInFlightForTests().length, 0, "and no turn is in flight");
    // The mint sits after the turn's own directory in the launch path: a directory that was never
    // created is a token that was never minted.
    assert.equal(existsSync(draftDir), false, "the turn's own dir is never created");
    assert.equal(existsSync(join(draftDir, ".mcp.json")), false, "and no config path is touched in either mode");
    assert.equal(await draftingSessionRow(draft.id), null, "no session row is stamped");
    assert.ok(!logs.some((l) => l.startsWith("turn_error")), "nothing ran to fail: " + logs.join(","));
  });

  test("the token is live while the turn runs, revoked once it ends, and never given to the reply path", async () => {
    _resetTurnTokensForTests();
    const { deps, calls, logs, timers } = recordingDeps();
    const draft = await makeDraft({ account });
    let liveDuring = null;
    const inner = deps.handleInbound;
    deps.handleInbound = async (opts) => {
      liveDuring = verifyTurnToken(bearerOf(opts));
      await inner(opts);
    };
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    assert.equal(liveDuring?.draftId, draft.id, "the token names this draft for the length of the turn");
    assert.equal(liveDuring?.startHash, draft.headHash, "and the head hash the turn started from");
    assert.equal(liveDuring?.botId, "draftbot", "and the bot the turn runs as");
    assert.equal(verifyTurnToken(bearerOf(calls[0])), null, "revoked in the turn's finally");
    assert.ok(!logs.some((l) => l.includes("REPLY TEXT")), "the reply text is discarded, only a code is logged");
    assert.equal(timers.length, 1, "a session dir is scheduled for deletion");
  });

  test("the token's life is the turn's own timeout plus the margin, not a fixed default", async () => {
    _resetTurnTokensForTests();
    const { deps } = recordingDeps();
    const draft = await makeDraft({ account });
    let liveDuring = null;
    const inner = deps.handleInbound;
    deps.handleInbound = async (opts) => {
      liveDuring = verifyTurnToken(bearerOf(opts));
      await inner(opts);
    };
    const before = Date.now();
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    const after = Date.now();
    // The spawned turn's prompt timeout: bridge.mjs's `Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600000)`.
    const turnTimeout = Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600_000);
    const ttl = turnTimeout + TURN_TOKEN_MARGIN_MS;
    assert.ok(liveDuring, "the token was live during the turn");
    assert.ok(
      liveDuring.expiresAt >= before + ttl && liveDuring.expiresAt <= after + ttl,
      `expiresAt ${liveDuring.expiresAt} is one turn timeout plus the margin from the mint`,
    );
    assert.ok(ttl > 60_000, "the margin is on top of a real timeout");
  });

  test("the turn runs as the bot the request names, and its token names that bot", async () => {
    _resetTurnTokensForTests();
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    let liveDuring = null;
    const inner = deps.handleInbound;
    deps.handleInbound = async (opts) => {
      liveDuring = verifyTurnToken(bearerOf(opts));
      await inner(opts);
    };
    await mailDb.execute({
      sql: "INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at) VALUES (?,?,datetime('now'))",
      args: [CLOUD_DRAFTING_SETTING, "1"],
    });
    try {
      await startDraftingTurn(mailDb, deps, { draftId: draft.id, botId: "cloudbot", instruction: "Be brief." });
    } finally {
      await mailDb.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [CLOUD_DRAFTING_SETTING] });
    }
    await settle();
    assert.equal(calls[0].bot_id, "cloudbot", "the bot the person named runs the turn");
    assert.equal(liveDuring?.botId, "cloudbot", "and the token names it");
  });

  test("an error in the turn is caught and logged as a code, and still revokes the token", async () => {
    _resetTurnTokensForTests();
    const { deps, calls, logs } = recordingDeps({ outcome: "reject" });
    const draft = await makeDraft({ account });
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    assert.equal(verifyTurnToken(bearerOf(calls[0])), null, "revoked on error too");
    assert.ok(logs.some((l) => l.includes("TIMEOUT")), "the code is logged: " + logs.join(","));
    assert.ok(!logs.some((l) => l.includes("turn timed out")), "never the error's own message");
  });

  test("a drafting turn writes no config of its own: its dir holds only pi's session dir", async () => {
    const { deps, calls, timers } = recordingDeps();
    const draft = await makeDraft({ account });
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    const dir = calls[0].draftingTurn.sessionDir;
    // The config the turn runs with is the block handed to the bridge: it reaches pi on the fd and is
    // never written, so the turn's own directory carries nothing but pi's session dir.
    assert.deepEqual(readdirSync(dir), ["sessions"]);
    assert.equal(existsSync(join(dir, ".mcp.json")), false);
    // The dir is still scheduled for deletion a day after the turn, and the row that would resume it
    // goes with it, so a later turn of the same draft starts fresh.
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, DRAFT_SESSION_RETENTION_MS);
    assert.ok(DRAFT_SESSION_RETENTION_MS >= 24 * 60 * 60 * 1000);
    assert.equal(existsSync(dir), true);
    await mailDb.execute({
      sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control, pi_session_id) VALUES (?,?,?,?,?,?)",
      args: ["draftbot", "mail-draft", "mail-draft:" + draft.id, "waiting-user", "run", "pi-session-1"],
    });
    timers[0].fn();
    assert.equal(existsSync(dir), false);
    assert.equal(await waitFor(async () => (await draftingSessionRow(draft.id)) === null), true, "the session row goes with the dir");
  });

  test("the session dir is under <CROW_HOME>/mail-draft-turns/<botId>/<draftId>, outside every bot-writable root", async () => {
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    const dir = calls[0].draftingTurn.sessionDir;
    assert.equal(dir, turnDirFor("draftbot", draft.id));
    assert.equal(dir, mailDraftTurnDir(CROW_HOME, "draftbot", draft.id));
    assert.equal(dir.startsWith(CROW_HOME + "/"), true, "under the instance's own home");
    assert.equal(dir.startsWith(DRAFTBOT_ROOT + "/"), false, "never inside the bot's world root");
    assert.notEqual(dir, DRAFTBOT_ROOT, "never the world root a chat turn resumes from");
    assert.equal(existsSync(join(dir, "sessions")), true, "pi's --session-dir has a place to write");
    assert.equal(statSync(dir).mode & 0o777, 0o700, "the turn's own directory is private");
  });

  test("a sweep on start removes turn dirs older than a day and leaves the new one", async () => {
    const { deps } = recordingDeps();
    const turnsRoot = join(CROW_HOME, DRAFT_TURNS_DIRNAME, "draftbot");
    const oldDir = join(turnsRoot, "md-00000000deadbeef");
    mkdirSync(join(oldDir, "sessions"), { recursive: true });
    await mailDb.execute({
      sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control, pi_session_id) VALUES (?,?,?,?,?,?)",
      args: ["draftbot", "mail-draft", "mail-draft:md-00000000deadbeef", "waiting-user", "run", "pi-session-old"],
    });
    // A row of ANOTHER bot on the same draft id: the sweep forgets only its own bot's rows.
    await mailDb.execute({
      sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control, pi_session_id) VALUES (?,?,?,?,?,?)",
      args: ["otherbot", "mail-draft", "mail-draft:md-00000000deadbeef", "waiting-user", "run", "pi-session-other"],
    });
    const twoDaysAgo = new Date(1_700_000_000_000 - 2 * DRAFT_SESSION_RETENTION_MS);
    utimesSync(oldDir, twoDaysAgo, twoDaysAgo);
    const freshDir = join(turnsRoot, "md-1111111111111111");
    mkdirSync(freshDir, { recursive: true });
    const draft = await makeDraft({ account });
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    assert.equal(existsSync(oldDir), false, "the day-old turn dir is swept");
    assert.equal(await draftingSessionRow("md-00000000deadbeef", "draftbot"), null, "and its own session row with it");
    assert.equal(await otherBotDraftingSessionRow("md-00000000deadbeef"), true, "another bot's row on the same draft id stays");
    assert.equal(existsSync(freshDir), true, "a recent one is left alone");
    rmSync(freshDir, { recursive: true, force: true });
    await mailDb.execute({ sql: "DELETE FROM bot_sessions WHERE bot_id = ?", args: ["otherbot"] });
  });

  test("a symlinked turn root or bot folder is refused, and nothing outside it is touched", async () => {
    const { deps, calls } = recordingDeps();
    const base = join(CROW_HOME, DRAFT_TURNS_DIRNAME);
    const outside = join(ROOT, "outside-turns");
    mkdirSync(join(outside, "keep"), { recursive: true });
    writeFileSync(join(outside, "keep", "file.txt"), "keep me");
    mkdirSync(base, { recursive: true });

    // 1. `<CROW_HOME>/mail-draft-turns` is a symlink to a directory outside it.
    renameSync(base, base + ".real");
    symlinkSync(outside, base);
    try {
      const draft = await makeDraft({ account });
      await assert.rejects(
        startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." }),
        (err) => err.code === "turn_dir",
      );
      assert.equal(readFileSync(join(outside, "keep", "file.txt"), "utf8"), "keep me");
    } finally {
      rmSync(base, { force: true });
      renameSync(base + ".real", base);
    }

    // 2. The bot's own folder is a symlink to the same place.
    const botRoot = join(base, "draftbot");
    renameSync(botRoot, botRoot + ".real");
    symlinkSync(outside, botRoot);
    try {
      const draft = await makeDraft({ account });
      await assert.rejects(
        startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." }),
        (err) => err.code === "turn_dir",
      );
      assert.equal(readFileSync(join(outside, "keep", "file.txt"), "utf8"), "keep me");
    } finally {
      rmSync(botRoot, { force: true });
      renameSync(botRoot + ".real", botRoot);
    }
    assert.equal(calls.length, 0, "no turn was handed anything");
    rmSync(outside, { recursive: true, force: true });
  });

  test("a sweep refuses a symlinked entry and deletes nothing outside the turn root", async () => {
    const { deps } = recordingDeps();
    const botRoot = join(CROW_HOME, DRAFT_TURNS_DIRNAME, "draftbot");
    mkdirSync(botRoot, { recursive: true });
    const outside = join(ROOT, "outside-entry");
    mkdirSync(join(outside, "sessions"), { recursive: true });
    writeFileSync(join(outside, "sessions", "file.txt"), "keep me");
    const planted = join(botRoot, "md-00000000deadbeef");
    symlinkSync(outside, planted);
    try {
      const draft = await makeDraft({ account });
      await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
      await settle();
      assert.equal(readFileSync(join(outside, "sessions", "file.txt"), "utf8"), "keep me", "the link's target is untouched");
      assert.equal(existsSync(join(outside, "sessions")), true, "and still there");
    } finally {
      rmSync(planted, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a bot id that cannot be one path segment is refused before anything is created", async () => {
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    for (const botId of ["../../escape", "a/b", "..", ".hidden"]) {
      await assert.rejects(
        startDraftingTurn(mailDb, deps, { draftId: draft.id, botId, instruction: "Be brief." }),
        (err) => err.code === "BAD_INPUT" || err.code === "NOT_FOUND",
        JSON.stringify(botId),
      );
    }
    assert.equal(calls.length, 0);
  });

  test("a turn carries the model check the bridge runs on the model it resolved", async () => {
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    await updateAccount(mailDb, account.id, { localModelsOnly: true });
    try {
      await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
      await settle();
    } finally {
      await updateAccount(mailDb, account.id, { localModelsOnly: false });
    }
    const check = calls[0].draftingTurn.checkModel;
    assert.equal(typeof check, "function");
    assert.equal(check(RESOLVED).ok, true, "the local model this turn resolves is allowed");
    const verdict = check({ provider: "cloudy", model: "m1", key: "cloudy/m1" });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "local_models_only", "an escalated cloud model is refused for a local-only account");
  });

  test("a draft in a state that cannot take a turn is refused frozen, and nothing launches", async () => {
    // `scheduled` is the representative frozen state (holding/sending/sent/discarded/unknown are the
    // rest); the store owns which states exist, this refusal owns which ones a turn may start from.
    const { deps, calls } = recordingDeps();
    const scheduled = await makeDraft({ account, state: "scheduled" });
    await assert.rejects(
      startDraftingTurn(mailDb, deps, { draftId: scheduled.id, instruction: "Be brief." }),
      (err) => err.code === "frozen",
    );
    assert.equal(calls.length, 0);
  });

  test("a draft with no bot is refused bad_input; an unknown draft is not_found", async () => {
    const { deps, calls } = recordingDeps();
    const orphan = await makeDraft({ account, botId: null });
    await assert.rejects(
      startDraftingTurn(mailDb, deps, { draftId: orphan.id, instruction: "Be brief." }),
      (err) => err.code === "BAD_INPUT",
    );
    await assert.rejects(
      startDraftingTurn(mailDb, deps, { draftId: "md-ffffffffffffffff", instruction: "Be brief." }),
      (err) => err.code === "NOT_FOUND",
    );
    assert.equal(calls.length, 0);
  });

  test("an empty instruction is refused bad_input before anything is minted or spawned", async () => {
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    for (const instruction of ["", "   ", null, 42]) {
      await assert.rejects(
        startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction }),
        (err) => err.code === "BAD_INPUT",
      );
    }
    assert.equal(calls.length, 0);
  });

  test("a cloud-model bot is refused before the launch unless the owner switch is on", async () => {
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account, botId: "cloudbot" });
    await assert.rejects(
      startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." }),
      (err) => err.code === "cloud_drafting_off",
    );
    assert.equal(calls.length, 0);
    await mailDb.execute({
      sql: "INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at) VALUES (?,?,datetime('now'))",
      args: [CLOUD_DRAFTING_SETTING, "1"],
    });
    try {
      const out = await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
      assert.match(out.turnId, /^mt-/);
    } finally {
      await mailDb.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [CLOUD_DRAFTING_SETTING] });
    }
    await settle();
    assert.equal(calls.length, 1, "the switch is what let it through");
  });

  test("the token stays out of the database", async () => {
    _resetTurnTokensForTests();
    const { deps, calls } = recordingDeps();
    const draft = await makeDraft({ account });
    await startDraftingTurn(mailDb, deps, { draftId: draft.id, instruction: "Be brief." });
    await settle();
    const token = bearerOf(calls[0]);
    assert.match(token, /^mdt_[0-9a-f]{64}$/);
    const bytes = readFileSync(CROW_DB).toString("latin1");
    assert.equal(bytes.includes("mdt_"), false, "no turn token is ever written to crow.db");
  });
});

/* =========================================================== the bridge: argv and config */

describe("the drafting turn at the bridge", () => {
  const STUB_PI = join(ROOT, "stub-pi.mjs");
  const DRAFT_DIR = join(ROOT, "draftturn");
  let captureN = 0;

  before(async () => {
    mkdirSync(DRAFT_DIR, { recursive: true });
    writeFileSync(STUB_PI, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      'try { writeFileSync(process.env.PIBOT_TEST_ARGV, JSON.stringify(process.argv.slice(2))); } catch {}',
      'try {',
      '  if (process.env.PIBOT_TEST_ENVCAP) {',
      '    const env = {};',
      '    for (const k of ["DRAFT_TEST_MARKER", "PI_BOT_SECRET_VALUES_FD", "PI_BOT_SECRET_VALUES_FILE"]) {',
      '      if (Object.hasOwn(process.env, k)) env[k] = process.env[k];',
      '    }',
      '    writeFileSync(process.env.PIBOT_TEST_ENVCAP, JSON.stringify(env));',
      '  }',
      '} catch {}',
      'let cfg = null;',
      'try {',
      '  if (process.env.PI_BOT_MCP_CONFIG_FD) cfg = readFileSync(Number(process.env.PI_BOT_MCP_CONFIG_FD), "utf8");',
      '  else if (process.env.PI_BOT_MCP_CONFIG) cfg = readFileSync(process.env.PI_BOT_MCP_CONFIG, "utf8");',
      '} catch { cfg = null; }',
      'let buf = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buf += chunk.toString("utf8");',
      '  let nl;',
      '  while ((nl = buf.indexOf("\\n")) >= 0) {',
      '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
      '    let m; try { m = JSON.parse(line); } catch { continue; }',
      '    if (m.type === "get_state") {',
      '      out({ type: "response", command: "get_state", data: { sessionId: process.env.PIBOT_TEST_SESSION_ID || "stub-session" } });',
      '    } else if (m.type === "get_session_stats") {',
      '      out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
      '    } else if (m.type === "prompt") {',
      '      if (process.env.PIBOT_TEST_MCPCAP) { try { writeFileSync(process.env.PIBOT_TEST_MCPCAP, cfg == null ? "null" : cfg); } catch {} }',
      '      if (process.env.PIBOT_TEST_PROMPTCAP) { try { writeFileSync(process.env.PIBOT_TEST_PROMPTCAP, JSON.stringify({ prompt: m.message })); } catch {} }',
      '      out({ type: "response", command: "prompt" });',
      '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });',
      '    } else if (m.type === "abort") {',
      '      out({ type: "response", command: "abort" });',
      '    }',
      '  }',
      '});',
      'process.stdin.resume();',
      '',
    ].join("\n"));
    process.env.PIBOT_PI_CLI = STUB_PI;
  });

  after(() => { rmSync(DRAFT_DIR, { recursive: true, force: true }); });

  /** One draftingTurn option, built the way the gateway builds it. */
  function draftingTurnFor(draftId, { botId = "draftbot", sessionDir = turnDirFor(botId, draftId), checkModel } = {}) {
    const turnId = "mt-" + randomBytes(8).toString("hex");
    const token = mintTurnToken({ draftId, turnId, startHash: "a".repeat(64), botId });
    return {
      token, turnId,
      option: {
        exactTools: [...DRAFTING_TURN_TOOLS],
        mcpBlock: mailDraftBlock({ botId, draftId, turnId, token }),
        sessionDir,
        // turn.js's own check (allowDraftModelKey); these cases pin the bridge's half of it.
        checkModel: checkModel || (() => ({ ok: true, local: true, key: "stub/m1" })),
      },
    };
  }

  function capturePaths() {
    const n = ++captureN;
    const argvPath = join(DRAFT_DIR, `argv-${n}.json`);
    const mcpPath = join(DRAFT_DIR, `mcp-${n}.json`);
    const envPath = join(DRAFT_DIR, `env-${n}.json`);
    process.env.PIBOT_TEST_ARGV = argvPath;
    process.env.PIBOT_TEST_MCPCAP = mcpPath;
    process.env.PIBOT_TEST_ENVCAP = envPath;
    return { argvPath, mcpPath, envPath };
  }

  function toolsOf(argvPath) {
    const argv = JSON.parse(readFileSync(argvPath, "utf8"));
    const at = argv.indexOf("--tools");
    return { argv, csv: at === -1 ? undefined : argv[at + 1] };
  }

  test("drafting turn argv has --tools exactly equal to the three names for a bot whose def grants gmail, web, files and messaging", async () => {
    const paths = capturePaths();
    const { option } = draftingTurnFor("md-00000000000000aa");
    await handleInbound({
      bot_id: "draftbot", gateway_type: "mail-draft",
      gateway_thread_id: "mail-draft:md-00000000000000aa",
      user_message: "draft it", log: () => {}, sendReply: async () => {},
      draftingTurn: option,
    });
    assert.ok(existsSync(paths.argvPath), "the stub pi recorded its argv");
    const { csv } = toolsOf(paths.argvPath);
    assert.equal(csv, THREE_CSV);
    assert.deepEqual(String(csv).split(",").sort(), [...THREE].sort());
  });

  test("the argv has no built-in tool name and no subagent", async () => {
    const paths = capturePaths();
    const { option } = draftingTurnFor("md-00000000000000bb");
    await handleInbound({
      bot_id: "draftbot", gateway_type: "mail-draft",
      gateway_thread_id: "mail-draft:md-00000000000000bb",
      user_message: "draft it", log: () => {}, sendReply: async () => {},
      draftingTurn: option,
    });
    const { argv, csv } = toolsOf(paths.argvPath);
    for (const builtin of ["bash", "read", "write", "edit", "subagent", "ask_user", "send_user_file", "crow_request_secret"]) {
      assert.ok(!String(csv).split(",").includes(builtin), "no " + builtin + " on a drafting turn");
      assert.ok(!argv.includes(builtin), "and not anywhere else in the argv either: " + builtin);
    }
    assert.ok(!argv.join(" ").includes("gmail"), "none of the bot's own tools are pinned");
  });

  test("a drafting turn's delivered config has exactly one enabled server", async () => {
    const paths = capturePaths();
    const { turnId, option } = draftingTurnFor("md-00000000000000cc");
    await handleInbound({
      bot_id: "draftbot", gateway_type: "mail-draft",
      gateway_thread_id: "mail-draft:md-00000000000000cc",
      user_message: "draft it", log: () => {}, sendReply: async () => {},
      draftingTurn: option,
    });
    const config = JSON.parse(readFileSync(paths.mcpPath, "utf8"));
    assert.ok(config && typeof config === "object", "the child was handed a config");
    const enabled = Object.entries(config.mcpServers).filter(([, block]) => !(block && block.disabled === true)).map(([name]) => name);
    assert.deepEqual(enabled, [MAIL_DRAFT_SERVER], "exactly one server is active");
    const block = config.mcpServers[MAIL_DRAFT_SERVER];
    assert.match(block.url, /^http:\/\/127\.0\.0\.1:\d+\/mail-draft\/mcp$/);
    assert.equal(block.headers.Authorization, "Bearer " + option.mcpBlock.headers.Authorization.split(" ")[1]);
    assert.equal(block.headers["X-Crow-Actor-Kind"], "mail-draft");
    assert.equal(block.headers["X-Crow-Actor-Id"], "draftbot");
    assert.equal(
      verifyMailDraftActorSig({
        botId: "draftbot", draftId: "md-00000000000000cc", turnId,
        sig: block.headers["X-Crow-Actor-Sig"],
      }),
      true,
      "the mount's own verifier accepts the delivered signature",
    );
    // None of the bot's own servers, implied or selected, ride along.
    const text = JSON.stringify(config);
    for (const name of ["gmail", "brave-search", "storage", "messaging", "board", "phone", "artifacts"]) {
      assert.ok(!text.includes(`"${name}"`), "no " + name + " block on a drafting turn");
    }
  });

  test("a normal turn of the same bot gets none of the three", async () => {
    const paths = capturePaths();
    await handleInbound({
      bot_id: "draftbot", gateway_type: "gmail", gateway_thread_id: "chat-thread-" + captureN,
      user_message: "hello", log: () => {}, sendReply: async () => {},
    });
    const { csv } = toolsOf(paths.argvPath);
    assert.ok(csv.includes("mcp__gmail__gmail_search"), "the bot's own envelope is unchanged: " + csv);
    for (const name of THREE) assert.ok(!csv.includes(name), name);
    const config = JSON.parse(readFileSync(paths.mcpPath, "utf8"));
    assert.equal(Object.hasOwn(config.mcpServers, MAIL_DRAFT_SERVER), false);
  });

  test("a drafting turn's config is closed-world: the operator's global servers are disabled", async () => {
    // pi-lab's mcp-client loads the operator's global `~/.pi/agent/mcp.json` in BOTH delivery modes,
    // so a config naming only `crow-mail-draft` would still start every global server as a child of
    // a turn that must have exactly one. The drafting config disables them the way buildBotMcp does.
    const canonical = join(HOME_DIR, ".pi", "agent", "mcp.json");
    const before = readFileSync(canonical, "utf8");
    writeFileSync(canonical, JSON.stringify({ mcpServers: { "team-wiki": { command: "node", args: ["/tmp/wiki.js"] } } }));
    try {
      const paths = capturePaths();
      const { option } = draftingTurnFor("md-00000000000000f1");
      await handleInbound({
        bot_id: "draftbot", gateway_type: "mail-draft",
        gateway_thread_id: "mail-draft:md-00000000000000f1",
        user_message: "draft it", log: () => {}, sendReply: async () => {},
        draftingTurn: option,
      });
      const config = JSON.parse(readFileSync(paths.mcpPath, "utf8"));
      assert.deepEqual(config.mcpServers["team-wiki"], { disabled: true }, "a global server is disabled, not started");
      assert.ok(config.mcpServers[MAIL_DRAFT_SERVER] && typeof config.mcpServers[MAIL_DRAFT_SERVER].url === "string",
        "and the turn's own server is still enabled");
    } finally {
      writeFileSync(canonical, before);
    }
  });

  test("a drafting turn is refused when the host delivers MCP configs as files, before anything is spawned or written", async () => {
    const paths = capturePaths();
    const draftId = "md-00000000000000f2";
    const draftDir = turnDirFor("draftbot", draftId);
    mkdirSync(draftDir, { recursive: true });
    // A planted target where a file-mode config would go: nothing may be written through it, and the
    // link itself may not be replaced or removed either, because nothing touches the path at all.
    const outside = join(ROOT, "outside-mcp.json");
    writeFileSync(outside, "DO NOT TOUCH\n");
    const link = join(draftDir, ".mcp.json");
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
    try {
      const { option } = draftingTurnFor(draftId);
      await assert.rejects(
        handleInbound({
          bot_id: "draftbot", gateway_type: "mail-draft", gateway_thread_id: "mail-draft:" + draftId,
          user_message: "draft it", log: () => {}, sendReply: async () => {}, draftingTurn: option,
        }),
        (err) => err.name === "MailError" && err.code === "delivery_unsupported",
      );
    } finally {
      process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
    }
    assert.equal(readFileSync(outside, "utf8"), "DO NOT TOUCH\n", "the file behind the link is untouched");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "and the planted link is neither replaced nor removed");
    assert.equal(existsSync(paths.argvPath), false, "no pi was spawned");
    rmSync(link, { force: true });
    rmSync(outside, { force: true });

    // The refusal is the drafting turn's alone: an ordinary turn of the same bot still runs from a
    // file, which is what the file mode is for.
    const normal = capturePaths();
    process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
    try {
      await handleInbound({
        bot_id: "draftbot", gateway_type: "gmail", gateway_thread_id: "file-mode-chat-thread",
        user_message: "hello", log: () => {}, sendReply: async () => {},
      });
    } finally {
      process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
    }
    assert.equal(existsSync(normal.argvPath), true, "an ordinary turn still spawns in file mode");
    assert.equal(existsSync(join(DRAFTBOT_ROOT, ".mcp.json")), true, "and reads its config from the world file");
    rmSync(join(DRAFTBOT_ROOT, ".mcp.json"), { force: true });
  });

  test("a drafting turn's spawn env carries neither the def's spawn_env nor the card values", async () => {
    const drafting = capturePaths();
    const { option } = draftingTurnFor("md-00000000000000f3", { botId: "envbot" });
    await handleInbound({
      bot_id: "envbot", gateway_type: "mail-draft", gateway_thread_id: "mail-draft:md-00000000000000f3",
      user_message: "draft it", log: () => {}, sendReply: async () => {}, draftingTurn: option,
    });
    const draftingEnv = JSON.parse(readFileSync(drafting.envPath, "utf8"));
    assert.deepEqual(Object.keys(draftingEnv), [], "the child got no spawn_env key and no card-values fd");

    // A normal turn of the same bot still gets the def's own spawn_env: the skip is the drafting turn's.
    const normal = capturePaths();
    await handleInbound({
      bot_id: "envbot", gateway_type: "gmail", gateway_thread_id: "envbot-chat-thread",
      user_message: "hello", log: () => {}, sendReply: async () => {},
    });
    const normalEnv = JSON.parse(readFileSync(normal.envPath, "utf8"));
    assert.equal(normalEnv.DRAFT_TEST_MARKER, "1", "a channel turn keeps its def's spawn_env");
  });

  test("a drafting turn never escalates: !escalate in the instruction cannot reach the cloud model", async () => {
    const paths = capturePaths();
    const promptPath = join(DRAFT_DIR, "prompt-escalate.json");
    process.env.PIBOT_TEST_PROMPTCAP = promptPath;
    const { option } = draftingTurnFor("md-00000000000000f4", { botId: "escbot" });
    await handleInbound({
      bot_id: "escbot", gateway_type: "mail-draft", gateway_thread_id: "mail-draft:md-00000000000000f4",
      user_message: "!escalate Shorten the second paragraph.", log: () => {}, sendReply: async () => {},
      draftingTurn: option,
    });
    const { argv } = toolsOf(paths.argvPath);
    assert.equal(argv.join(" ").includes("cloudy"), false, "the cloud escalation model is never spawned: " + argv.join(" "));
    assert.ok(argv.join(" ").includes("stub"), "the turn ran the local default");
    const prompt = JSON.parse(readFileSync(promptPath, "utf8")).prompt;
    assert.equal(prompt.includes("!escalate"), false, "the token is stripped before the prompt");
    assert.ok(prompt.includes("Shorten the second paragraph."), "the person's own words are still there");
  });

  test("the bridge refuses the turn when the model it resolved is not allowed", async () => {
    const paths = capturePaths();
    let sawResolved = null;
    const { option } = draftingTurnFor("md-00000000000000f5", {
      checkModel: (resolvedModel) => { sawResolved = resolvedModel; return { ok: false, code: "local_models_only" }; },
    });
    const result = await handleInbound({
      bot_id: "draftbot", gateway_type: "mail-draft", gateway_thread_id: "mail-draft:md-00000000000000f5",
      user_message: "draft it", log: () => {}, sendReply: async () => {}, draftingTurn: option,
    });
    assert.equal(result.action, "error");
    assert.equal(sawResolved.key, "stub/m1", "the check sees the model handleInbound resolved");
    assert.equal(existsSync(paths.argvPath), false, "nothing was spawned");
  });

  test("a chat turn never resumes the drafting turn's session", async () => {
    const draftId = "md-00000000000000dd";
    const draftDir = turnDirFor("draftbot", draftId);
    process.env.PIBOT_TEST_SESSION_ID = "drafting-session-1";
    const paths = capturePaths();
    const { option } = draftingTurnFor(draftId, { sessionDir: draftDir });
    await handleInbound({
      bot_id: "draftbot", gateway_type: "mail-draft", gateway_thread_id: "mail-draft:" + draftId,
      user_message: "draft it", log: () => {}, sendReply: async () => {}, draftingTurn: option,
    });
    const draftingArgv = toolsOf(paths.argvPath).argv;
    assert.equal(draftingArgv.includes("--session"), false, "the first drafting turn starts fresh");
    assert.ok(draftingArgv.includes(join(draftDir, "sessions")), "and its --session-dir is the draft's own");

    process.env.PIBOT_TEST_SESSION_ID = "chat-session-1";
    const chatPaths = capturePaths();
    await handleInbound({
      bot_id: "draftbot", gateway_type: "gmail", gateway_thread_id: "chat-thread-" + draftId,
      user_message: "hello", log: () => {}, sendReply: async () => {},
    });
    const chatArgv = toolsOf(chatPaths.argvPath).argv;
    assert.equal(chatArgv.includes("--session"), false, "a chat thread of the same bot has its own session row");
    assert.ok(chatArgv.includes(join(DRAFTBOT_ROOT, "sessions")), "and its --session-dir is the world root's");
    assert.ok(!chatArgv.includes(join(draftDir, "sessions")), "never the drafting turn's dir");
  });

  test("a malformed draftingTurn is refused before anything is spawned", async () => {
    const paths = capturePaths();
    const thread = "mail-draft:md-00000000000000ee";
    const before = (() => {
      const c = new Database(CROW_DB);
      const n = c.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE gateway_thread_id = ?").get(thread).n;
      c.close();
      return n;
    })();
    const good = draftingTurnFor("md-00000000000000ee").option;
    const bad = [
      { mcpBlock: good.mcpBlock, sessionDir: good.sessionDir, checkModel: good.checkModel },       // no exactTools
      { ...good, exactTools: ["read"] },                                                          // not the three
      { ...good, mcpBlock: null },                                                                 // no block
      { ...good, mcpBlock: { url: "http://127.0.0.1:3001/board/mcp", headers: good.mcpBlock.headers } },
      { ...good, mcpBlock: { ...good.mcpBlock, url: "http://example.test:3001/mail-draft/mcp" } },
      { ...good, mcpBlock: { ...good.mcpBlock, headers: { ...good.mcpBlock.headers, Authorization: "Bearer board-token" } } },
      { ...good, mcpBlock: { ...good.mcpBlock, headers: { ...good.mcpBlock.headers, "X-Crow-Actor-Kind": "bot" } } },
      // The block's actor is another bot than the turn's own.
      { ...good, mcpBlock: { ...good.mcpBlock, headers: { ...good.mcpBlock.headers, "X-Crow-Actor-Id": "otherbot" } } },
      // No model check: the drafting gate cannot be left off.
      { ...good, checkModel: null },
      { ...good, checkModel: "yes" },
      // The session dir is the ONE path under <CROW_HOME>/mail-draft-turns/<botId>/<draftId>.
      { ...good, sessionDir: "relative/dir" },
      { ...good, sessionDir: null },
      { ...good, sessionDir: join(ROOT, "draftturn", "md-00000000000000ee") },
      { ...good, sessionDir: join(CROW_HOME, DRAFT_TURNS_DIRNAME, "otherbot", "md-00000000000000ee") },
      { ...good, sessionDir: good.sessionDir + "/../../escape" },
      { ...good, sessionDir: good.sessionDir + "/" },
    ];
    for (const option of bad) {
      await assert.rejects(
        handleInbound({
          bot_id: "draftbot", gateway_type: "mail-draft", gateway_thread_id: thread,
          user_message: "draft it", log: () => {}, sendReply: async () => {}, draftingTurn: option,
        }),
        /draftingTurn refused/,
      );
    }
    assert.equal(existsSync(paths.argvPath), false, "no pi was spawned");
    const c = new Database(CROW_DB);
    const after = c.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE gateway_thread_id = ?").get(thread).n;
    c.close();
    assert.equal(after, before, "and no session row was stamped");
  });
});

/* =========================================================== the block builder */

test("mailDraftBlock is the mount's own door: one url, the turn's bearer, and its actor headers", () => {
  const turnId = "mt-0123456789abcdef";
  const block = mailDraftBlock({
    botId: "draftbot", draftId: "md-0123456789abcdef", turnId, token: "mdt_" + "a".repeat(64), port: 3999,
  });
  assert.equal(block.url, "http://127.0.0.1:3999/mail-draft/mcp");
  assert.deepEqual(Object.keys(block.headers).sort(), [
    "Authorization", "X-Crow-Actor-Id", "X-Crow-Actor-Kind", "X-Crow-Actor-Sig",
  ]);
  assert.equal(block.headers.Authorization, "Bearer mdt_" + "a".repeat(64));
  assert.equal(verifyMailDraftActorSig({
    botId: "draftbot", draftId: "md-0123456789abcdef", turnId, sig: block.headers["X-Crow-Actor-Sig"],
  }), true);
  // Another turn's signature does not verify for this tuple.
  assert.equal(verifyMailDraftActorSig({
    botId: "draftbot", draftId: "md-0123456789abcdef", turnId: "mt-ffffffffffffffff",
    sig: block.headers["X-Crow-Actor-Sig"],
  }), false);
  // Nothing but the three headers and the bearer: no bot-server header, no relay.
  assert.equal(Object.hasOwn(block.headers, "X-Crow-Job-Id"), false);
  assert.equal(Object.hasOwn(block.headers, "X-Crow-Actor-Scope"), false);
});

test("mailDraftBlock refuses a token, id or key that cannot be one", () => {
  _resetActorKeyForTest();
  const valid = { botId: "draftbot", draftId: "md-0123456789abcdef", turnId: "mt-0123456789abcdef", token: "mdt_" + "b".repeat(64) };
  // No key in this process: the block would be unsigned, so it is refused instead.
  assert.throws(() => mailDraftBlock(valid), /actor key/);
  initGatewayActorKey();
  for (const [name, over] of [
    ["a non-mdt token", { token: "board-token" }],
    ["a short token", { token: "mdt_abc" }],
    ["no bot", { botId: "" }],
    ["no draft", { draftId: "" }],
    ["no turn", { turnId: "" }],
    ["a colon in the turn id", { turnId: "mt:1" }],
  ]) {
    assert.throws(() => mailDraftBlock({ ...valid, ...over }), (err) => err instanceof TypeError, name);
  }
  assert.ok(mailDraftBlock(valid).url.startsWith("http://127.0.0.1:"));
});