/**
 * F1: a bare crow_mcp entry expands to a server's WHOLE tool listing at spawn time, so
 * every place that holds a def up against its model's tool cap has to count the expanded
 * names. Two such places hold no snapshot of their own:
 *
 *   1. withBoardTools (bot-world.mjs) — the board verbs it adds are refused when the
 *      candidate passes the cap. A bot that was "just given studio" at ~120 tools on a
 *      128-tool model is over the cap the moment the bare entry expands, so no board
 *      verb may be added (and with room to spare they still are).
 *   2. the channel preflight in handleInbound (bridge.mjs) — it builds the csv from the
 *      piRpcOpts the spawn will use, then checkToolBudget. With the prepareSpawn snapshot
 *      it counts the expanded names; without it a bare-studio def at the cap looks small.
 *
 * Both go through defaultCompanionBudget / buildToolsCsv, which now prime the listing when
 * they are not handed one. The cap comes from the providers table (tool-budget.mjs: a
 * gufo-served model with no maxTools is 128) and the listing is the injected probe seam,
 * so nothing is spawned here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// Env BEFORE the modules load: model_resolver pins PI_MODELS_JSON at import time, the
// skill/home resolvers read HOME, and botsDbPath reads CROW_DB_PATH.
for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const DIR = mkdtempSync(join(tmpdir(), "crow-bare-budget-"));
const CROW_HOME = join(DIR, "home");
process.env.HOME = join(DIR, "fakehome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(join(CROW_HOME, "data"), { recursive: true });
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DB_PATH = join(DIR, "crow.db");
delete process.env.CROW_DATA_DIR;
process.env.CROW_PI_SANDBOX = "off";
process.env.PI_MODELS_JSON = join(DIR, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "engine-a": { models: [{ id: "big" }] } } }));

/** A gufo-served provider row with no maxTools: 128 functions (tool-budget.mjs). */
function seedProviders() {
  const d = new Database(process.env.CROW_DB_PATH);
  d.exec("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, models TEXT NOT NULL DEFAULT '[]',"
    + " disabled INTEGER DEFAULT 0, gpu_policy TEXT)");
  d.prepare("INSERT OR REPLACE INTO providers (id, models, gpu_policy) VALUES (?,?,?)").run(
    "engine-a", JSON.stringify([{ id: "big" }]),
    JSON.stringify({ engine: { managed: "external", label: "gufo" } }));
  d.close();
}
seedProviders();

// The bare entry's server, so the prime has something to list. Only the injected probe runs.
mkdirSync(join(CROW_HOME, "bundles", "studio"), { recursive: true });
writeFileSync(join(CROW_HOME, "mcp-addons.json"), JSON.stringify({
  studio: { command: "node", args: ["server/index.js"], cwd: join(CROW_HOME, "bundles", "studio") },
}, null, 2));

const { test, beforeEach } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const BST = await import("../scripts/pi-bots/bare-server-tools.mjs");
const { withBoardTools, BOARD_BOT_TOOLS } = await import("../scripts/pi-bots/bot-world.mjs");
const { defaultCompanionBudget } = await import("../scripts/pi-bots/artifacts-companions.mjs");
const { buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
const { capFor, checkToolBudget, channelBudgetMessage, GUFO_DEFAULT_MAX_TOOLS } =
  await import("../scripts/pi-bots/tool-budget.mjs");

beforeEach(() => BST._resetBareServerToolsForTest());

const MODEL = "engine-a/big";
const RESOLVED = { provider: "engine-a", model: "big" };
/** A def that grants the bare server id "studio" (not the board), on the 128-tool model. */
const bareDef = () => ({ tools: { crow_mcp: ["studio"] }, models: { default: MODEL } });
/** A listing of n tools, as the probe seam reports it. */
const listingOf = (n) => Array.from({ length: n }, (_, i) => ({ name: "studio_t" + i }));
const probeOf = (n) => async () => ({ ok: true, tools: listingOf(n) });

test("withBoardTools: a bare-studio bot near the cap gets NO board verbs past it", async () => {
  assert.equal(capFor(RESOLVED), GUFO_DEFAULT_MAX_TOOLS);
  const def = bareDef();
  // 120 listed tools + the board verbs (+ the interactive pair) = over 128.
  const budget = await defaultCompanionBudget(def, { crowHome: CROW_HOME, probe: probeOf(120) });
  assert.equal(budget.cap, 128, "the cap is the model's, read from DATA");
  const withVerbs = { ...def, tools: { ...def.tools, crow_mcp: [...def.tools.crow_mcp, ...BOARD_BOT_TOOLS] } };
  assert.ok(budget.countFor(withVerbs) > budget.cap, "the candidate is over: " + budget.countFor(withVerbs));

  const logs = [];
  const out = await withBoardTools(def, { wanted: true, budget, log: (m) => logs.push(m) });
  assert.equal(out, def, "the def is returned unchanged, not a copy with verbs");
  assert.deepEqual(out.tools.crow_mcp, ["studio"], "the bare entry is all this bot keeps");
  assert.match(logs.join("\n"), /board tools not added \(tool limit\)/);
});

test("withBoardTools: with room under the cap the board verbs ARE added", async () => {
  const def = bareDef();
  const budget = await defaultCompanionBudget(def, { crowHome: CROW_HOME, probe: probeOf(3) });
  const logs = [];
  const out = await withBoardTools(def, { wanted: true, budget, log: (m) => logs.push(m) });
  assert.notEqual(out, def, "a new def");
  for (const verb of BOARD_BOT_TOOLS) assert.ok(out.tools.crow_mcp.includes(verb), verb);
  assert.ok(out.tools.crow_mcp.includes("studio"), "the bare entry is untouched");
  assert.deepEqual(def.tools.crow_mcp, ["studio"], "the input def is never mutated");
  assert.match(logs.join("\n"), /board tools added/);
});

test("the channel preflight counts the prepareSpawn snapshot: same def, over the cap only with it", () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["studio"] }, models: { default: MODEL } };
  // A listing that fills the cap on its own: read + 128 listed names = 129.
  const snapshot = { studio: Array.from({ length: 128 }, (_, i) => "studio_t" + i) };
  const csvWith = buildToolsCsv(def, { resolved: RESOLVED, bareServerTools: snapshot }).csv;
  const overWith = checkToolBudget(csvWith, capFor(RESOLVED));
  assert.equal(overWith.ok, false, "the expanded listing is past the cap, so the turn is refused");
  assert.equal(overWith.count, 129);
  assert.match(channelBudgetMessage(overWith), /129/);
  assert.match(channelBudgetMessage(overWith), /128/);

  // Without a snapshot the same def is today's one spelling and looks tiny — the reason the
  // preflight must read the snapshot the spawn carries.
  const csvWithout = buildToolsCsv(def, { resolved: RESOLVED }).csv;
  assert.equal(csvWithout, "read,mcp__studio");
  assert.equal(checkToolBudget(csvWithout, capFor(RESOLVED)).ok, true);
});

test("the preflight in handleInbound builds its csv from piRpcOpts.bareServerTools, not from a bare spelling", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "pi-bots", "bridge.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function handleInbound("));
  const start = fn.indexOf("const { csv } = buildToolsCsv(po.def || def,");
  const end = fn.indexOf("checkToolBudget(", start);
  assert.ok(start > 0 && end > start, "the preflight block is where the budget check reads it");
  const preflight = fn.slice(start, end);
  assert.match(preflight, /bareServerTools: po\.bareServerTools/,
    "the same piRpcOpts snapshot prepareSpawn primed is what the budget counts");
});