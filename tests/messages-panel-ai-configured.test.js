/**
 * messages-panel-ai-configured — CDP round fix (C1-B Task 9, finding #1).
 *
 * "Meet your Crow" hands the user a dead conversation: the wizard's local
 * -download branch registers a provider ONLY in the `providers` DB table
 * (see onboarding/starter-content.js resolveStarterProvider), but the
 * Messages panel's `aiConfigured` gate (panels/messages.js) used to check
 * only `.env` AI_PROVIDER and `dashboard_settings.ai_profiles` — never that
 * table — so client.js stubbed `loadAiConversation` to a no-op and the
 * freshly-created starter conversation could never open.
 *
 * This drives the REAL panel handler (not a re-implementation of its logic)
 * against a real sqlite db (scripts/init-db.js, CROW_DATA_DIR-scoped, same
 * pattern as tests/messages-verified-badge.test.js) and reads the emitted
 * client <script> to tell true from false: aiConfigured=true emits the real
 * `async function loadAiConversation(id) {` implementation; false emits the
 * no-op stub `function loadAiConversation() {}` (client.js:284/475/714).
 *
 * `process.env.HOME` is pointed at a throwaway dir with no `.crow/.env` so
 * `getProviderConfig()` (servers/gateway/ai/provider.js, reads
 * `~/.crow/.env` — NOT scoped by CROW_DATA_DIR) deterministically returns
 * null regardless of what's on the real operator machine running this suite.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "msg-ai-configured-data-"));
const fakeHome = mkdtempSync(join(tmpdir(), "msg-ai-configured-home-"));
process.env.CROW_DATA_DIR = dataDir;
process.env.HOME = fakeHome; // no ~/.crow/.env here — getProviderConfig() reads null

let db = null;
let messagesPanel = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });

  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ default: messagesPanel } = await import("../servers/gateway/dashboard/panels/messages.js"));
});

after(() => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute("DELETE FROM providers");
  await db.execute("DELETE FROM dashboard_settings WHERE key = 'ai_profiles'");
});

/** Drive the real panel handler; returns the emitted content string. */
async function render() {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {}, headersSent: false };
  const req = { method: "GET", query: {}, headers: {} };
  const out = await messagesPanel.handler(req, res, { db, lang: "en", layout });
  return typeof out === "string" ? out : captured;
}

const REAL_MARKER = "async function loadAiConversation(id)";
const STUB_MARKER = "function loadAiConversation() {}";

function assertAiConfigured(content, expected, msg) {
  const hasReal = content.includes(REAL_MARKER);
  const hasStub = content.includes(STUB_MARKER);
  assert.ok(hasReal !== hasStub, "loadAiConversation renders as exactly one of real/stub");
  assert.equal(hasReal, expected, msg);
}

async function insertProvider({ id, models, disabled = 0 }) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, models, disabled) VALUES (?, ?, ?, ?)`,
    args: [id, "http://127.0.0.1:1/v1", JSON.stringify(models), disabled],
  });
}

test("aiConfigured is FALSE with no env, no profiles, no providers rows (baseline)", async () => {
  const content = await render();
  assertAiConfigured(content, false, "nothing configured anywhere -> gate stays closed");
});

test("aiConfigured is TRUE with ONLY a usable providers-table row (env unset, no ai_profiles)", async () => {
  await insertProvider({ id: "qwen3-4b", models: [{ id: "qwen3-4b" }] });
  const content = await render();
  assertAiConfigured(content, true, "a usable providers row alone must open the gate (the wizard's local-download path)");
});

test("aiConfigured stays FALSE when the only providers row is disabled", async () => {
  await insertProvider({ id: "qwen3-4b", models: [{ id: "qwen3-4b" }], disabled: 1 });
  const content = await render();
  assertAiConfigured(content, false, "a disabled provider row must not count");
});

test("aiConfigured stays FALSE when the only providers row has an empty models array (no_auto_provider placeholder)", async () => {
  await insertProvider({ id: "no_auto_provider", models: [] });
  const content = await render();
  assertAiConfigured(content, false, "an empty-models placeholder row must not count as usable");
});

test("aiConfigured is TRUE when dashboard_settings.ai_profiles has an entry, unchanged from prior behavior", async () => {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES ('ai_profiles', ?)",
    args: [JSON.stringify([{ id: "p1", provider: "openai", model: "gpt-4o" }])],
  });
  const content = await render();
  assertAiConfigured(content, true, "an ai_profiles entry alone must still open the gate (pre-existing behavior)");
});

test("a providers query failure degrades to the env/profiles-only result, never crashes the render", async () => {
  const throwingDb = {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      if (/FROM providers/i.test(sql)) throw new Error("providers table is on fire");
      return db.execute(q);
    },
  };
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {}, headersSent: false };
  const req = { method: "GET", query: {}, headers: {} };
  const out = await messagesPanel.handler(req, res, { db: throwingDb, lang: "en", layout });
  const content = typeof out === "string" ? out : captured;
  assertAiConfigured(content, false, "a providers-table blowup must not crash the panel and must not falsely claim configured");
});
