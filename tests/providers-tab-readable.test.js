import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../servers/db.js";
import tab, { duplicateClusters } from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";

let dir, db, piDir;

const ins = (id, url, { key = null, disabled = 0, models = [{ id: "m1" }], desc = null } = {}) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, description) VALUES (?,?,?,?,?,?,?)",
    args: [id, url, key, "local", JSON.stringify(models), disabled, desc],
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "providers-readable-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
  `);
  await ins("local-chat", "http://192.168.1.5:8000/v1");
  await ins("local-alias", "http://192.168.1.5:8000/v1/");
  await ins("local-voice", "http://192.168.1.5:8011/v1");
  await ins("retired-one", "http://192.168.1.5:9000/v1", { disabled: 1 });
  await ins("pi-only", "http://192.168.1.5:7000/v1");
  await ins("crow-hf-token", "https://huggingface.co", { disabled: 0 });
  await ins("cloud-x", "https://api.example.com/v1", { desc: "<script>x</script>" });
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
    args: ["b1", "Helper <Bot>", JSON.stringify({ models: { default: "local-voice/m1" }, gateways: [] })],
  });
  piDir = join(dir, "pi");
  mkdirSync(join(piDir, "agents"), { recursive: true });
  writeFileSync(join(piDir, "settings.json"), JSON.stringify({ subagent: { modelOverrides: { scout: "pi-only/m1" } } }));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const html = (extra = {}) => tab.render({ db, lang: "en", piAgentDir: piDir, tasksDbPaths: [], ...extra });

test("retired rows are hidden behind a Show N retired toggle", async () => {
  const h = await html();
  assert.match(h, /data-show-retired/);
  assert.match(h, /Show 1 retired/);
  const [main, retired] = h.split("data-show-retired");
  assert.ok(!main.includes("retired-one"));
  assert.ok(retired.includes("retired-one"));
  assert.match(retired, /llm_provider_enable/);
  assert.match(await html({ lang: "es" }), /retirado/);
});

test("duplicateClusters groups enabled rows by normalised URL and key presence", () => {
  const p = (id, baseUrl, apiKey = null, disabled = false) => ({ id, baseUrl, apiKey, disabled });
  const m = duplicateClusters([
    p("a", "http://H:1/v1"), p("b", "http://h:1/v1/"), p("c", "http://h:1"), p("d", "http://h:1/v1", "k"),
    p("e", "http://h:1/v1", null, true),
  ]);
  assert.deepEqual(m.get("a"), ["b"]);
  assert.deepEqual(m.get("b"), ["a"]);
  assert.ok(!m.has("c") && !m.has("d") && !m.has("e"));
});

test("duplicate rows carry data-dup-of and a badge; no merge action", async () => {
  const h = await html();
  assert.match(h, /data-dup-of="local-alias"/);
  assert.match(h, /data-dup-of="local-chat"/);
  assert.match(h, /Same service as local-alias/);
  assert.doesNotMatch(h, /llm_provider_merge/);
  assert.match(await html({ lang: "es" }), /Mismo servicio que/);
});

test("Used by shows bot labels (escaped) and pi config refs", async () => {
  const h = await html();
  assert.match(h, /Helper &lt;Bot&gt;/);
  assert.doesNotMatch(h, /Helper <Bot>/);
  const piRow = h.split("<tr").find((r) => r.includes(">pi-only<"));
  assert.match(piRow, /pi config: .*subagent:scout/);
});

test("crow-hf-token never renders, enabled or disabled", async () => {
  assert.ok(!(await html()).includes("crow-hf-token"));
  await db.execute("UPDATE providers SET disabled = 1 WHERE id = 'crow-hf-token'");
  assert.ok(!(await html()).includes("crow-hf-token"));
});

test("no piAgentDir shows the not-scanned hint; a failing scan still renders the page", async () => {
  assert.match(await html({ piAgentDir: null }), /pi config not scanned on this instance/);
  const broken = { execute: (q) => (String(q.sql || q).includes("FROM providers") ? db.execute(q) : Promise.reject(new Error("boom"))) };
  const h = await tab.render({ db: broken, lang: "en", piAgentDir: null });
  assert.match(h, /local-chat/);
});
