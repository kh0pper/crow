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
process.env.PIBOT_JOB_TIMEOUT_MS = "5000";
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

let recordDraft, recordDrafts, betterSqliteDb, getStaged, handleInbound, runJob;

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
  // The stub child's own model registry: a key pi's models.json declares needs no
  // `pi --list-models` probe (the goal-job leg runs checkPiModel).
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
    providers: { stub: { models: [{ id: "m1" }] } },
  }));

  // The one bot the bridge leg runs a turn for. No project, no MCP servers: the world carries no
  // google block, so the recorder names no credential (and never calls Gmail).
  // `credstagebot` is the opposite case: its world DOES carry the google-workspace block, which is
  // what proves a bridge turn can name a credential when the operator config has one.
  const c = db();
  const defOf = (sessionDir, crowMcp) => JSON.stringify({
    system_prompt: "You are the staged-send test bot.",
    models: { default: "stub/m1" },
    tools: { pi_builtin: ["read"], crow_mcp: crowMcp },
    permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
    session_dir: sessionDir,
  });
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)").run(
    "stagebot", "Stage Bot", defOf(join(ROOT, "bots", "stagebot"), []), 1,
  );
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)").run(
    "credstagebot", "Cred Stage Bot", defOf(join(ROOT, "bots", "credstagebot"), ["google-workspace"]), 1,
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
    '      // The "turn dies after its tools ran" leg: no agent_end, an exit instead.',
    '      if (process.env.PIBOT_TEST_DIE_AFTER_CALLS) { process.exit(1); }',
    '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });',
    '    } else if (m.type === "abort") out({ type: "response", command: "abort" });',
    '  }',
    '});',
    'process.stdin.resume();',
  ].join("\n"));
  process.env.PIBOT_PI_CLI = STUB_PI;

  const recorder = await import("../servers/gateway/staged/recorder.js");
  recordDraft = recorder.recordDraft;
  recordDrafts = recorder.recordDrafts;
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

  assert.deepEqual(primary.credRef, { server: "google-workspace", role: "primary", source: "canonical" });
  assert.deepEqual(personal.credRef, { server: "google-workspace", role: "personal", source: "canonical" });
  assert.equal(primary.openInGmail, false);
  assert.equal(personal.openInGmail, false);

  const rowPrimary = await stagedById(primary.id);
  const rowPersonal = await stagedById(personal.id);
  assert.deepEqual(rowPrimary.credRef, { server: "google-workspace", role: "primary", source: "canonical" });
  assert.deepEqual(rowPersonal.credRef, { server: "google-workspace", role: "personal", source: "canonical" });
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

/* ------------------------------------------------ M2: a forged draft id */

test("a draft id inside wrapped or echoed text is not parsed", async () => {
  // The result must be the tool's OWN JSON, whole. Anything around it — a wrapper sentence, an echoed
  // copy, a different shape — is how a forged id would arrive, so none of these records.
  const inner = okResult("draft-echo", "gt-echo");
  for (const resultText of [
    "Done! " + inner,
    inner + "\n(the tool answered above)",
    JSON.stringify({ success: true, data: { draft_id: "draft echo" } }),
    JSON.stringify({ success: true, data: { draft_id: "draft-echo; DROP" } }),
    JSON.stringify({ success: true, data: { draft_id: 42 } }),
    JSON.stringify({ success: true, data: { draft_id: "" } }),
    JSON.stringify({ ok: true, data: { draft_id: "draft-echo" } }),
  ]) {
    const r = await recordOnce({ toolName: DRAFT, resultText, context: { threadId: "thread-echo" } });
    assert.equal(r, null, "records nothing: " + resultText.slice(0, 60));
  }
  assert.equal(stagedFor("thread_id", "thread-echo").length, 0);
});

test("the same draft recorded twice makes one row", async () => {
  const fake = createFakeGmail({
    drafts: { "draft-twice": { threadId: "gt-twice", raw: makeDraftRaw({ to: "alex@example.com", subject: "Once", body: "Body" }) } },
  });
  const once = () => recordOnce({
    toolName: DRAFT,
    args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
    resultText: okResult("draft-twice", "gt-twice"),
    context: { threadId: "thread-twice", fetchImpl: fake.fetchImpl },
  });

  const first = await once();
  assert.ok(first && first.id, "the first call records");
  const replay = await once();
  assert.equal(replay, null, "a replay of the same draft id + credential records nothing");
  assert.equal(stagedFor("provider_draft_id", "draft-twice").length, 1, "one row, not two");
});

test("a replay whose Gmail read now succeeds does not add a sendable row next to an unreadable one", async () => {
  const fake = createFakeGmail({
    drafts: { "draft-flaky": { threadId: "gt-flaky", raw: makeDraftRaw({ to: "alex@example.com", subject: "Flaky", body: "Body" }) } },
  });
  const call = (fetchImpl) => recordOnce({
    toolName: DRAFT,
    args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
    resultText: okResult("draft-flaky", "gt-flaky"),
    context: { threadId: "thread-flaky", fetchImpl },
  });
  const first = await call(async () => { throw new Error("network down"); });
  assert.ok(first && first.id, "the first call records an Open-in-Gmail row");
  const rows1 = stagedFor("provider_draft_id", "draft-flaky");
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].cred_ref, null, "the failed read left no credential");
  const replay = await call(fake.fetchImpl);
  assert.equal(replay, null, "the same draft id is the same draft, whatever this read says");
  assert.equal(stagedFor("provider_draft_id", "draft-flaky").length, 1, "still one row");
  assert.equal(fake.calls.get, 0, "the replay never read Gmail (the check runs first)");
});

test("an error result records nothing", async () => {
  // Through the bridge: the stub child reports the draft call as isError with a success-shaped body
  // (a provider that failed after minting an id, or an MCP error wrapping one). No row.
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
    id: "call-error-1",
    tool: DRAFT,
    isError: true,
    args: { to: "error-recipient@example.com", subject: "Should not stage", body: "Body" },
    result: piResult(okResult("draft-error", "gt-error")),
  }]);
  const result = await handleInbound({
    bot_id: "stagebot",
    gateway_type: "gmail",
    gateway_thread_id: "gmail-thread-error",
    user_message: "please draft it",
    log: () => {},
    sendReply: async () => {},
  });
  process.env.PIBOT_TEST_TOOLCALLS = "[]";

  assert.equal(result.action, "asked", "the turn itself succeeded");
  assert.equal(stagedFor("thread_id", "gmail-thread-error").length, 0, "an errored call records nothing");

  // And the shared per-turn path skips it too (a card job's failed call never becomes a row).
  const written = await withRecorderDb((dbClient) => recordDrafts(dbClient, [{
    tool: DRAFT, isError: true,
    args: { to: "error-recipient@example.com", subject: "Should not stage", body: "Body" },
    result: piResult(okResult("draft-error-direct", "gt-error")),
  }], { threadId: "thread-error-direct", credConfig: CRED_CONFIG, configPaths: CONFIG_PATHS }));
  assert.deepEqual(written, []);
  assert.equal(stagedFor("thread_id", "thread-error-direct").length, 0);
});

/* --------------------------------------------------- L4: the injected log */

test("recordDrafts logs a recorder failure through the injected log", async () => {
  const lines = [];
  // A connection that refuses every statement: the recorder fails inside safeRecordDraft.
  const broken = { async execute() { throw Object.assign(new Error("boom"), { code: "db_busy" }); } };
  const written = await recordDrafts(broken, [{
    tool: DRAFT,
    args: { to: "log-recipient@example.com", subject: "Log subject", body: "Log body" },
    result: piResult(okResult("draft-log", "gt-log")),
  }], { threadId: "thread-log", credConfig: { mcpServers: {} }, log: (l) => lines.push(String(l)) });

  assert.deepEqual(written, []);
  assert.equal(lines.length, 1, "exactly one line, through the caller's sink");
  assert.match(lines[0], /gmail_create_draft\): db_busy$/, "the tool name and an error code");
  for (const token of ["log-recipient@example.com", "Log subject", "Log body"]) {
    assert.ok(!lines[0].includes(token), "no draft content in the log: " + token);
  }
});

/* ------------------------------------------- M3: a draft made before a failure */

test("a draft made before a turn failed is still recorded", async () => {
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
    id: "call-failed-turn-1",
    tool: DRAFT,
    args: { to: "failed-recipient@example.com", subject: "Made before the failure", body: "Body" },
    result: piResult(okResult("draft-failed-turn", "gt-failed")),
  }]);
  let replies = 0;
  const result = await handleInbound({
    bot_id: "stagebot",
    gateway_type: "gmail",
    gateway_thread_id: "gmail-thread-failed",
    user_message: "please draft it",
    log: () => {},
    // The reply is what fails, AFTER the draft tool already ran — the catch path's own reply works.
    sendReply: async () => { replies += 1; if (replies === 1) throw new Error("the gateway is down"); },
  });
  process.env.PIBOT_TEST_TOOLCALLS = "[]";

  assert.equal(result.action, "error");
  assert.ok(
    Array.isArray(result.toolCalls) && result.toolCalls.some((c) => /gmail_create_draft$/.test(String(c.tool))),
    "the failed turn's result still reports its calls (a card job records from them)",
  );
  const rows = stagedFor("thread_id", "gmail-thread-failed");
  assert.equal(rows.length, 1, "the draft the failed turn made is still recorded");
  assert.equal(rows[0].provider_draft_id, "draft-failed-turn");
});

test("a goal job records its draft", async () => {
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
    id: "call-goal-1",
    tool: DRAFT,
    args: { to: "goal-recipient@example.com", subject: "Goal subject", body: "Goal body" },
    result: piResult(okResult("draft-goal", "gt-goal")),
  }]);
  let out;
  try {
    out = await runJob(
      { job_id: "job-staged-goal", bot_id: "stagebot", goal: "draft the goal reply", escalate: 0 },
      { log: () => {} },
    );
  } finally {
    process.env.PIBOT_TEST_TOOLCALLS = "[]";
  }
  assert.equal(out.result, "ok", "the stub's own reply is the job's result");

  const rows = stagedFor("job_id", "job-staged-goal");
  assert.equal(rows.length, 1, "a goal job's draft is a row");
  assert.equal(rows[0].provider_draft_id, "draft-goal");
  assert.equal(rows[0].channel, "gmail");
  assert.equal(JSON.parse(rows[0].snapshot).subject, "Goal subject");
});

test("a goal job records its draft when the turn dies after it", async () => {
  // The goal-job catch path: pi exits after the draft tool ran, so the turn never completes. The
  // calls are read before the child closes and recorded, or the row would be lost.
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
    id: "call-goal-died-1",
    tool: DRAFT,
    args: { to: "goal-died@example.com", subject: "Died subject", body: "Body" },
    result: piResult(okResult("draft-goal-died", "gt-goal-died")),
  }]);
  process.env.PIBOT_TEST_DIE_AFTER_CALLS = "1";
  try {
    await assert.rejects(
      () => runJob({ job_id: "job-staged-goal-died", bot_id: "stagebot", goal: "draft then die", escalate: 0 }, { log: () => {} }),
      /pi exited|exited/,
    );
  } finally {
    delete process.env.PIBOT_TEST_DIE_AFTER_CALLS;
    process.env.PIBOT_TEST_TOOLCALLS = "[]";
  }
  const rows = stagedFor("job_id", "job-staged-goal-died");
  assert.equal(rows.length, 1, "a goal job that died after its draft still records it");
  assert.equal(rows[0].provider_draft_id, "draft-goal-died");
});

test("a failed card job still records its draft", async () => {
  // The bridge's failed turn reports `toolCalls`; the job records them before it fails the job.
  const jobBridge = {
    async handleInbound() {
      return {
        action: "error",
        error: "pi exited mid-turn",
        toolCalls: [{
          tool: DRAFT,
          isError: false,
          args: { to: "card-fail-recipient@example.com", subject: "Card failed", body: "Body" },
          result: piResult(okResult("draft-card-fail", "gt-card-fail")),
        }],
      };
    },
  };
  await assert.rejects(
    () => runJob(
      { job_id: "job-staged-fail", bot_id: "stagebot", card_id: 44, source: "card", goal: "reply" },
      { log: () => {}, bridge: jobBridge },
    ),
    /card execute failed/,
  );
  const rows = stagedFor("job_id", "job-staged-fail");
  assert.equal(rows.length, 1, "the failed card job's draft is still recorded");
  assert.equal(rows[0].provider_draft_id, "draft-card-fail");
  assert.equal(rows[0].card_id, 44);
});

/* ------------------------------------------- credentials from a real config */

test("a card job names its credential through the operator config", async () => {
  const fake = createFakeGmail({
    drafts: { "draft-card-cred": { threadId: "gt-card-cred", raw: makeDraftRaw({ to: "alex@example.com", subject: "Provider subject", body: "Provider body" }) } },
  });
  const jobBridge = {
    async handleInbound() {
      return {
        action: "executed",
        piSessionId: "pi-job-cred",
        replyPreview: "done",
        toolCalls: [{
          tool: DRAFT,
          isError: false,
          args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
          result: piResult(okResult("draft-card-cred", "gt-card-cred")),
        }],
      };
    },
  };
  // A card job's world is built inside the bridge, so the credential comes from the operator's own
  // config. The provider read goes through the fake: nothing here opens a socket.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  try {
    await runJob(
      { job_id: "job-staged-cred", bot_id: "stagebot", card_id: 45, source: "card", goal: "reply" },
      { log: () => {}, bridge: jobBridge },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  const rows = stagedFor("job_id", "job-staged-cred");
  assert.equal(rows.length, 1);
  const row = await stagedById(rows[0].id);
  assert.deepEqual(row.credRef, { server: "google-workspace", role: "primary", source: "canonical" }, "named from ~/.pi/agent/mcp.json");
  assert.equal(row.snapshot.subject, "Provider subject", "the credential worked: the provider's draft is the snapshot");
  assert.equal(fake.calls.get, 1);
  const text = JSON.stringify(row);
  assert.ok(!text.includes(PRIMARY_TOKEN), "the row names a credential, never a token path");
});

test("a bridge turn whose world can name a credential records cred_ref", async () => {
  const fake = createFakeGmail({
    drafts: { "draft-bridge-cred": { threadId: "gt-bridge-cred", raw: makeDraftRaw({ to: "alex@example.com", subject: "Provider subject", body: "Provider body" }) } },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  let result;
  try {
    // credstagebot's def selects google-workspace, so its world carries the server's token env.
    process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
      id: "call-bridge-cred-1",
      tool: DRAFT,
      args: { to: "args@example.com", subject: "Args subject", body: "Args body" },
      result: piResult(okResult("draft-bridge-cred", "gt-bridge-cred")),
    }]);
    result = await handleInbound({
      bot_id: "credstagebot",
      gateway_type: "gmail",
      gateway_thread_id: "gmail-thread-cred",
      user_message: "please draft the reply",
      log: () => {},
      sendReply: async () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
    process.env.PIBOT_TEST_TOOLCALLS = "[]";
  }
  assert.equal(result.action, "asked");

  const rows = stagedFor("thread_id", "gmail-thread-cred");
  assert.equal(rows.length, 1);
  const row = await stagedById(rows[0].id);
  assert.deepEqual(row.credRef, { server: "google-workspace", role: "primary", source: "canonical" }, "the turn's own world names the credential");
  assert.equal(row.snapshot.subject, "Provider subject");
  assert.equal(fake.calls.get, 1);
});

/* ------------------------------------ L5: only a draft call keeps its payload */

test("a non-draft tool's args and result are not kept", async () => {
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([
    {
      id: "call-read-1",
      tool: "read",
      args: { path: "/tmp/inside-note.txt" },
      result: piResult("a private file body"),
    },
    {
      id: "call-draft-keep",
      tool: DRAFT,
      args: { to: "keep@example.com", subject: "Kept", body: "Kept body" },
      result: piResult(okResult("draft-keep", "gt-keep")),
    },
  ]);
  const result = await handleInbound({
    bot_id: "stagebot",
    gateway_type: "gmail",
    gateway_thread_id: "gmail-thread-keep",
    user_message: "read it and draft a reply",
    log: () => {},
    sendReply: async () => {},
  });
  process.env.PIBOT_TEST_TOOLCALLS = "[]";

  // This list is what live-pi-driver-child writes into its progress NDJSON: an eval run must never
  // carry another tool's args or result.
  const read = result.toolCalls.find((c) => c.tool === "read");
  assert.ok(read, "the call is still reported by name");
  assert.deepEqual(Object.keys(read).sort(), ["isError", "tool"], "a non-draft call keeps the bare shape");
  const draft = result.toolCalls.find((c) => /gmail_create_draft$/.test(String(c.tool)));
  assert.ok(draft && draft.args && draft.result, "a draft call keeps what the recorder needs");
  assert.ok(!JSON.stringify(result.toolCalls).includes("inside-note"), "no other tool's payload rides along");
});

/* ------------------------------- the duplicate guard on a real job turn */

test("a real handleInbound call with a job_id records zero rows", async () => {
  // The bridge must leave a job turn entirely to the job runner (which owns job_id/card_id). If it
  // recorded here too, every card job's draft would become two rows.
  process.env.PIBOT_TEST_TOOLCALLS = JSON.stringify([{
    id: "call-job-guard-1",
    tool: DRAFT,
    args: { to: "guard-recipient@example.com", subject: "Guard subject", body: "Body" },
    result: piResult(okResult("draft-job-guard", "gt-job-guard")),
  }]);
  const result = await handleInbound({
    bot_id: "stagebot",
    gateway_type: "board",
    gateway_thread_id: "board-job-guard-1",
    user_message: "draft the reply for this job",
    job_id: "job-staged-guard",
    log: () => {},
    sendReply: async () => {},
  });
  process.env.PIBOT_TEST_TOOLCALLS = "[]";

  assert.equal(result.action, "asked");
  assert.ok((result.toolCalls || []).some((c) => /gmail_create_draft$/.test(String(c.tool))), "the draft call happened");
  assert.equal(stagedFor("job_id", "job-staged-guard").length, 0, "the bridge leaves a job turn to the job runner");
  assert.equal(stagedFor("thread_id", "board-job-guard-1").length, 0, "and wrote no row of its own");
});
test("a draft held by the add-on account records source addons, proven by the read", async () => {
  // Two accounts under one server and role: the canonical file names "work", the add-on file names
  // "personal-acct". The draft lives in the add-on account, so the canonical token's read 404s.
  const WORK = join(TOKEN_DIR, "work.json");
  const OTHER = join(TOKEN_DIR, "addon-acct.json");
  writeFileSync(WORK, JSON.stringify({ refresh_token: "refresh-work", client_id: "c", client_secret: "s" }));
  writeFileSync(OTHER, JSON.stringify({ refresh_token: "refresh-addon", client_id: "c", client_secret: "s" }));
  const canon = join(ROOT, "two-acct-mcp.json");
  const addons = join(ROOT, "two-acct-addons.json");
  writeFileSync(canon, JSON.stringify({ mcpServers: { "google-workspace": { env: { GOOGLE_TOKEN_FILE: WORK } } } }));
  writeFileSync(addons, JSON.stringify({ "google-workspace": { env: { GOOGLE_TOKEN_FILE: OTHER } } }));
  const reads = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/token")) {
      const rt = new URLSearchParams(String(opts.body)).get("refresh_token");
      return { ok: true, status: 200, json: async () => ({ access_token: "at-" + rt, expires_in: 3600 }) };
    }
    const auth = (opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || "";
    reads.push(auth.replace("Bearer ", ""));
    if (u.includes("/drafts/draft-in-addon") && auth.endsWith("at-refresh-addon")) {
      const raw = Buffer.from("To: alex@example.com\r\nSubject: Hi\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nBody\r\n", "latin1").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      return { ok: true, status: 200, json: async () => ({ id: "draft-in-addon", message: { raw, threadId: "t-addon" } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const out = await recordOnce({
    resultText: okResult("draft-in-addon", "t-addon"),
    context: { threadId: "thread-two-acct", fetchImpl, configPaths: { canonical: canon, addons }, credConfig: { mcpServers: { "google-workspace": { env: { GOOGLE_TOKEN_FILE: "1" } } } } },
  });
  assert.ok(out && out.id, "recorded");
  const row = stagedFor("provider_draft_id", "draft-in-addon")[0];
  assert.deepEqual(JSON.parse(row.cred_ref), { server: "google-workspace", role: "primary", source: "addons" }, "the account that holds the draft");
  assert.ok(reads.includes("at-refresh-work") && reads.includes("at-refresh-addon"), "both accounts were tried");
});

test("a draft neither account holds records no credential", async () => {
  const canon = join(ROOT, "two-acct-mcp.json");
  const addons = join(ROOT, "two-acct-addons.json");
  const fetchImpl = async (url) => String(url).includes("/token")
    ? { ok: true, status: 200, json: async () => ({ access_token: "at-x", expires_in: 3600 }) }
    : { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  const out = await recordOnce({
    resultText: okResult("draft-nowhere", "t-nowhere"),
    context: { threadId: "thread-nowhere", fetchImpl, configPaths: { canonical: canon, addons }, credConfig: { mcpServers: { "google-workspace": { env: { GOOGLE_TOKEN_FILE: "1" } } } } },
  });
  assert.ok(out && out.id);
  assert.equal(stagedFor("provider_draft_id", "draft-nowhere")[0].cred_ref, null, "Open in Gmail: no account was proven");
});
