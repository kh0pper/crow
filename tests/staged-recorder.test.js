/**
 * Staged sends, Task 2 — the recorder and the two process hooks (bridge channel turn, job runner).
 *
 * Harness (read before editing):
 *   • A real init-db'd scratch crow.db (CROW_DATA_DIR/CROW_HOME under mkdtemp) — every recorder
 *     write is real SQL, and the notification row is read back from the same file.
 *   • HOME points at a scratch dir too: a credential is named from operator config (the canonical
 *     `~/.pi/agent/mcp.json` / `~/.crow/mcp-addons.json`), so a test must never read the host's.
 *   • Every Gmail call goes through tests/fixtures/fake-gmail.mjs (`fetchImpl`); nothing here opens
 *     a socket.
 *   • The bridge leg runs the REAL handleInbound with a protocol-speaking stub pi (the
 *     tests/bridge-board-rail.test.js pattern); the job leg injects a bridge, because the card-job
 *     route's own recording is what is under test.
 *
 * Credentials in these fixtures are made-up token JSON under the scratch dir; the server ids are
 * generic (`google-workspace`, `google-workspace-personal`, `workspace-mcp`), and every address is
 * `@example.com`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakeGmail, makeDraftRaw } from "./fixtures/fake-gmail.mjs";

// Hermetic env FIRST: an ambient PI_*/PIBOT_* var would leak into the stub child.
for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];

const ROOT = mkdtempSync(join(tmpdir(), "staged-recorder-"));
process.env.CROW_DATA_DIR = ROOT;
process.env.CROW_HOME = join(ROOT, "home");
delete process.env.CROW_DB_PATH;
delete process.env.CROW_TASKS_DB_PATH;
// The canonical pi MCP config is what a turn's MCP blocks are minted from, and what a credential
// reference resolves against. HOME is swapped before ANY gateway/pi-bots module is imported.
const SCRATCH_HOME = join(ROOT, "userhome");
mkdirSync(join(SCRATCH_HOME, ".pi", "agent"), { recursive: true });
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = SCRATCH_HOME;
process.on("exit", () => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
});

process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";   // refused instantly; warm is non-fatal
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PI_MODELS_JSON = join(ROOT, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(ROOT, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/* ------------------------------------------------------- credential fixture */

const TOKEN_DIR = join(ROOT, "tokens");
mkdirSync(TOKEN_DIR, { recursive: true });
const PRIMARY_TOKEN = join(TOKEN_DIR, "primary.json");
const PERSONAL_TOKEN = join(TOKEN_DIR, "personal.json");
const MISSING_TOKEN = join(TOKEN_DIR, "not-there.json");
for (const [path, refresh] of [[PRIMARY_TOKEN, "refresh-primary"], [PERSONAL_TOKEN, "refresh-personal"]]) {
  writeFileSync(path, JSON.stringify({ refresh_token: refresh, client_id: "client-id", client_secret: "client-secret" }));
}

/** The three servers these tests name: readable primary+personal, unreadable, unreadable file. */
const SERVERS = {
  "google-workspace": { env: { GOOGLE_TOKEN_FILE: PRIMARY_TOKEN, GOOGLE_PERSONAL_TOKEN_FILE: PERSONAL_TOKEN } },
  "google-workspace-gone": { env: { GOOGLE_TOKEN_FILE: MISSING_TOKEN } },
  "workspace-mcp": { env: {} },   // the public server: no Crow-readable token
};

const CANONICAL_MCP = join(SCRATCH_HOME, ".pi", "agent", "mcp.json");
writeFileSync(CANONICAL_MCP, JSON.stringify({ mcpServers: SERVERS }));
const CONFIG_PATHS = { canonical: CANONICAL_MCP, addons: join(ROOT, "no-addons.json") };
const CRED_CONFIG = { mcpServers: SERVERS };

const DRAFT = "mcp__google-workspace__gmail_create_draft";
const DRAFT_PERSONAL = "mcp__google-workspace__gmail_create_draft_personal";
const DRAFT_UNREADABLE = "mcp__workspace-mcp__gmail_create_draft";
const DRAFT_MISSING_TOKEN = "mcp__google-workspace-gone__gmail_create_draft";

/* ------------------------------------------------------------- module seams */

let recordDraft, betterSqliteDb, getStaged, handleInbound, runJob;

/* --------------------------------------------------------------- helpers */

function db() {
  const c = new Database(DB_FILE);
  c.pragma("busy_timeout = 5000");
  return c;
}

/** A fresh connection per recorder call (the adapter the bridge/job hooks use). */
async function withRecorderDb(fn) {
  const c = db();
  try { return await fn(betterSqliteDb(c)); } finally { c.close(); }
}

async function recordOnce({ toolName = DRAFT, args, resultText, context = {} } = {}) {
  const baseContext = {
    threadId: "thread-recorder",
    botId: "stagebot",
    credConfig: CRED_CONFIG,
    configPaths: CONFIG_PATHS,
    tainted: false,
    notify: false,
  };
  return await withRecorderDb((dbClient) => recordDraft({
    db: dbClient,
    toolName,
    args: args === undefined ? { to: "args@example.com", subject: "Args subject", body: "Args body" } : args,
    resultText,
    context: Object.assign(baseContext, context),
  }));
}

async function stagedById(id) {
  return await withRecorderDb((dbClient) => getStaged(dbClient, id));
}

function stagedFor(where, value) {
  const c = db();
  try { return c.prepare(`SELECT * FROM staged_sends WHERE ${where} = ? ORDER BY rowid`).all(value); } finally { c.close(); }
}

const okResult = (draftId, threadId) => JSON.stringify({ success: true, data: { draft_id: draftId, thread_id: threadId } });
const piResult = (text) => ({ content: [{ type: "text", text }] });

/* ------------------------------------------------------------------ setup */

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: ROOT }, stdio: "pipe", cwd: REPO,
  });

  // The one bot the bridge leg runs a turn for. No project, no MCP servers: the world carries no
  // google block, so the recorder names no credential (and never calls Gmail).
  const c = db();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)").run(
    "stagebot", "Stage Bot",
    JSON.stringify({
      system_prompt: "You are the staged-send test bot.",
      models: { default: "stub/m1" },
      tools: { pi_builtin: ["read"], crow_mcp: [] },
      permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
      session_dir: join(ROOT, "bots", "stagebot"),
    }), 1,
  );
  c.close();

  // A protocol-speaking stub pi. The tool calls it emits carry BOTH payloads: `args` on the start
  // event and `result` on the end event, exactly as a real child does.
  const STUB_PI = join(ROOT, "stub-pi.mjs");
  writeFileSync(STUB_PI, [
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let calls = [];',
    'try { calls = JSON.parse(process.env.PIBOT_TEST_TOOLCALLS || "[]"); } catch {}',
    'let buf = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk.toString("utf8");',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    let m; try { m = JSON.parse(line); } catch { continue; }',
    '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "stub-session" } });',
    '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
    '    else if (m.type === "prompt") {',
    '      out({ type: "response", command: "prompt" });',
    '      for (const call of calls) {',
    '        if (call.args !== undefined) out({ type: "tool_execution_start", toolName: call.tool, toolCallId: call.id, args: call.args });',
    '        out({ type: "tool_execution_end", toolName: call.tool, toolCallId: call.id, isError: !!call.isError, result: call.result });',
    '      }',
    '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });',
    '    } else if (m.type === "abort") out({ type: "response", command: "abort" });',
    '  }',
    '});',
    'process.stdin.resume();',
  ].join("\n"));
  process.env.PIBOT_PI_CLI = STUB_PI;

  const recorder = await import("../servers/gateway/staged/recorder.js");
  recordDraft = recorder.recordDraft;
  betterSqliteDb = recorder.betterSqliteDb;
  ({ getStaged } = await import("../servers/gateway/staged/store.js"));
  ({ handleInbound } = await import("../scripts/pi-bots/bridge.mjs"));
  ({ runJob } = await import("../scripts/pi-bots/job_runner.mjs"));
});

after(() => { /* the process-level exit handler removes the scratch root */ });

/* ----------------------------------------------------------------- tests */

test("success false records nothing", async () => {
  const failed = await recordOnce({
    toolName: DRAFT, resultText: JSON.stringify({ success: false, error: "provider refused" }),
    context: { threadId: "thread-failure" },
  });
  assert.equal(failed, null, "a provider error is not a draft");

  const notJson = await recordOnce({
    toolName: DRAFT, resultText: "Gmail said no", context: { threadId: "thread-failure" },
  });
  assert.equal(notJson, null, "a result that is not the tool's JSON records nothing");

  const noDraftId = await recordOnce({
    toolName: DRAFT, resultText: JSON.stringify({ success: true, data: {} }), context: { threadId: "thread-failure" },
  });
  assert.equal(noDraftId, null, "no draft id, no row");

  assert.equal(stagedFor("thread_id", "thread-failure").length, 0);
});

test("cred_ref primary vs personal", async () => {
  const fake = createFakeGmail({
    drafts: {
      "draft-p1": { threadId: "gt-provider", raw: makeDraftRaw({ to: "alex@example.com", subject: "Provider subject", body: "Provider body" }) },
    },
  });

  const primary = await recordOnce({
    toolName: DRAFT,
    args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
    resultText: okResult("draft-p1", "gt-provider"),
    context: { threadId: "thread-cred", fetchImpl: fake.fetchImpl },
  });
  const personal = await recordOnce({
    toolName: DRAFT_PERSONAL,
    args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
    resultText: okResult("draft-p1", "gt-provider"),
    context: { threadId: "thread-cred", fetchImpl: fake.fetchImpl },
  });

  assert.deepEqual(primary.credRef, { server: "google-workspace", role: "primary" });
  assert.deepEqual(personal.credRef, { server: "google-workspace", role: "personal" });
  assert.equal(primary.openInGmail, false);
  assert.equal(personal.openInGmail, false);

  const rowPrimary = await stagedById(primary.id);
  const rowPersonal = await stagedById(personal.id);
  assert.deepEqual(rowPrimary.credRef, { server: "google-workspace", role: "primary" });
  assert.deepEqual(rowPersonal.credRef, { server: "google-workspace", role: "personal" });
  // The provider's draft is what gets approved and hashed, never the args.
  assert.equal(rowPrimary.snapshot.subject, "Provider subject");
  assert.deepEqual(rowPrimary.snapshot.to, ["alex@example.com"]);
  assert.equal(rowPrimary.providerDraftId, "draft-p1");
  assert.equal(rowPrimary.providerThreadId, "gt-provider");
  assert.equal(fake.calls.get, 2, "each role re-read the draft once");
  // A row names a credential, never a token file.
  for (const row of [rowPrimary, rowPersonal]) {
    const text = JSON.stringify(row);
    assert.ok(!text.includes(PRIMARY_TOKEN) && !text.includes(PERSONAL_TOKEN), "no token path on a row");
  }
});

test("unreadable cred → open-in-gmail row", async () => {
  const fake = createFakeGmail({});

  // (a) The server block carries no token env at all (the public workspace-mcp).
  const noEnv = await recordOnce({
    toolName: DRAFT_UNREADABLE,
    args: { to: "alex@example.com", subject: "Args subject", body: "Args body" },
    resultText: okResult("draft-u1"),
    context: { threadId: "thread-unreadable", fetchImpl: fake.fetchImpl },
  });
  assert.equal(noEnv.credRef, null);
  assert.equal(noEnv.openInGmail, true);
  const rowNoEnv = await stagedById(noEnv.id);
  assert.equal(rowNoEnv.credRef, null, "the card says Open in Gmail to send");
  assert.equal(rowNoEnv.snapshot.subject, "Args subject", "the args snapshot stands in for the read");
  assert.deepEqual(rowNoEnv.snapshot.to, ["alex@example.com"]);
  assert.equal(rowNoEnv.providerDraftId, "draft-u1");
  assert.equal(fake.calls.get, 0, "nothing was read — there was no credential to read with");

  // (b) A credential is named but its token file cannot be read.
  const missing = await recordOnce({
    toolName: DRAFT_MISSING_TOKEN,
    args: { to: "alex@example.com", subject: "Second subject", body: "Args body" },
    resultText: okResult("draft-u2"),
    context: { threadId: "thread-unreadable", fetchImpl: fake.fetchImpl },
  });
  assert.equal(missing.credRef, null);
  assert.equal(missing.openInGmail, true);
  const rowMissing = await stagedById(missing.id);
  assert.equal(rowMissing.credRef, null);
  assert.equal(rowMissing.snapshot.subject, "Second subject");
  assert.equal(fake.calls.get, 0, "an unreadable token never reaches the provider");
  assert.equal(fake.errorBodyReads, 0);
});

test("an unfaithful draft is recorded as open-in-gmail", async () => {
  // Reply-To: readable, but a shape Crow must not rebuild from a snapshot (a send would go
  // somewhere the card does not show).
  const raw = [
    "To: alex@example.com",
    "Reply-To: elsewhere@example.org",
    "Subject: Please send",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "provider body",
  ].join("\r\n");
  const fake = createFakeGmail({ drafts: { "draft-u": { threadId: "gt-u", raw } } });

  const r = await recordOnce({
    toolName: DRAFT,
    args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
    resultText: okResult("draft-u", "gt-u"),
    context: { threadId: "thread-unfaithful", fetchImpl: fake.fetchImpl },
  });
  assert.equal(r.openInGmail, true);
  assert.equal(r.credRef, null);
  assert.equal(r.reason, "reply-to");

  const row = await stagedById(r.id);
  assert.equal(row.credRef, null, "an unfaithful draft is never sent by Crow");
  assert.equal(row.snapshot.subject, "Please send", "the read DID succeed, so its snapshot is shown");
  assert.deepEqual(row.snapshot.to, ["alex@example.com"]);
});

test("notification has no draft text", async () => {
  const fake = createFakeGmail({
    drafts: { "draft-n": { threadId: "gt-n", raw: makeDraftRaw({ to: "provider-recipient@example.com", subject: "Provider subject", body: "provider body" }) } },
  });
  const r = await recordOnce({
    toolName: DRAFT,
    args: { to: "secret-recipient@example.com", subject: "Quarterly numbers", body: "The very secret plan" },
    resultText: okResult("draft-n", "gt-n"),
    context: { threadId: "thread-notify", fetchImpl: fake.fetchImpl, notify: true },
  });

  const c = db();
  const note = c.prepare("SELECT * FROM notifications WHERE action_url = ?").get("/dashboard/staged/" + r.id);
  c.close();
  assert.ok(note, "the non-Perch row notified");
  assert.equal(note.source, "staged-sends");
  assert.ok(
    ["Draft ready to review", "Borrador listo para revisar"].includes(note.title),
    "the reviewed title, in one of the two languages: " + note.title,
  );
  assert.equal(note.body, null, "no body text at all");
  const whole = JSON.stringify(note);
  for (const token of [
    "secret-recipient@example.com", "provider-recipient@example.com", "alex@example.com",
    "Quarterly numbers", "Provider subject", "The very secret plan", "provider body",
  ]) {
    assert.ok(!whole.includes(token), "the notification carries no draft content: " + token);
  }
});

test("bridge records with args and result", async () => {
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
    id: "call-bridge-1",
    tool: "mcp__google-workspace__gmail_create_draft",
    args: { to: "channel-recipient@example.com", subject: "About the invoice", body: "Here is the invoice." },
    result: piResult(okResult("draft-bridge", "gt-bridge")),
  }]);

  const result = await handleInbound({
    bot_id: "stagebot",
    gateway_type: "gmail",
    gateway_thread_id: "gmail-thread-1",
    user_message: "please draft the invoice reply",
    log: () => {},
    sendReply: async () => {},
  });
  process.env.PIBOT_TEST_TOOLCALLS = "[]";

  // The turn kept both payloads (that is what made the record possible).
  assert.equal(result.action, "asked");
  const call = (result.toolCalls || []).find((x) => /gmail_create_draft$/.test(String(x.tool)));
  assert.ok(call, "the turn reported the draft call");
  assert.ok(call.args && call.args.subject === "About the invoice", "the args survived toolCalls()");
  assert.ok(call.result, "the result survived toolCalls()");

  const rows = stagedFor("thread_id", "gmail-thread-1");
  assert.equal(rows.length, 1, "exactly one staged row for the channel draft");
  const row = rows[0];
  assert.equal(row.provider_draft_id, "draft-bridge", "the draft id comes from the RESULT");
  assert.equal(row.provider_thread_id, "gt-bridge");
  assert.equal(row.channel, "gmail");
  assert.equal(row.bot_id, "stagebot");
  assert.ok(row.session_id, "the bot_sessions row is the session id");
  assert.equal(row.tainted, 1, "a channel turn is outside content by definition");
  assert.equal(row.cred_ref, null, "this world has no google block to name a credential from");
  const snapshot = JSON.parse(row.snapshot);
  assert.equal(snapshot.subject, "About the invoice", "the snapshot comes from the ARGS when the read cannot happen");
  assert.deepEqual(snapshot.to, ["channel-recipient@example.com"]);

  const c = db();
  const note = c.prepare("SELECT * FROM notifications WHERE action_url = ?").get("/dashboard/staged/" + row.id);
  c.close();
  assert.ok(note, "a channel row notifies — there is no chat to show the card in");
});

test("job records with job_id and card_id", async () => {
  // A card job: runJob routes it to the bridge entry point, which this test injects. The bridge
  // skips its own recording for a turn that carries a job_id, so the job runner owns this row.
  const jobBridge = {
    async handleInbound() {
      return {
        action: "executed",
        piSessionId: "pi-job-1",
        replyPreview: "done",
        toolCalls: [{
          tool: "mcp__google-workspace__gmail_create_threaded_reply",
          args: { to: "job-recipient@example.com", subject: "Re: the report", body: "Threaded body", thread_id: "gt-job" },
          result: piResult(okResult("draft-job", "gt-job")),
        }],
      };
    },
  };
  const out = await runJob(
    { job_id: "job-staged-1", bot_id: "stagebot", card_id: 42, source: "card", goal: "reply to the report" },
    { log: () => {}, bridge: jobBridge },
  );
  assert.equal(out.result, "done");

  const rows = stagedFor("job_id", "job-staged-1");
  assert.equal(rows.length, 1, "the job's draft is recorded once");
  const row = rows[0];
  assert.equal(row.card_id, 42, "the card the job was dispatched from");
  assert.equal(row.job_id, "job-staged-1");
  assert.equal(row.bot_id, "stagebot");
  assert.equal(row.provider_draft_id, "draft-job");
  assert.equal(row.tainted, 1, "a job turn has no taint record to trust: fail closed");
  assert.equal(JSON.parse(row.snapshot).subject, "Re: the report");

  const c = db();
  const note = c.prepare("SELECT * FROM notifications WHERE action_url = ?").get("/dashboard/staged/" + row.id);
  c.close();
  assert.ok(note, "a job row notifies");
});