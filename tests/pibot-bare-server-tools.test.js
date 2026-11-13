/**
 * A BARE server name in a bot def's `tools.crow_mcp` (e.g. "studio").
 *
 * pi's `--tools` filter matches EXACT names, and pi-lab registers a local MCP server's
 * tools one by one as `mcp__<server>__<tool>`. So `mcp__studio` — today's spelling —
 * matched nothing: the server started and every tool was filtered out, while
 * "studio/studio_play" -> `mcp__studio__studio_play` worked. bare-server-tools.mjs lists
 * the server's real tools (primed before the spawn, so toolAllowlist stays synchronous)
 * and the bare entry expands to the names pi actually offers.
 *
 * Nothing here spawns a server: the probe is the injected seam, and the add-on entries
 * name a scratch bundle dir.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "crow-bare-tools-home-"));
const saved = { CROW_HOME: process.env.CROW_HOME };
process.env.CROW_HOME = HOME;

const BST = await import("../scripts/pi-bots/bare-server-tools.mjs");
const { toolAllowlist } = await import("../scripts/pi-bots/bridge.mjs");
const { checkToolBudget } = await import("../scripts/pi-bots/tool-budget.mjs");

const STUDIO_TOOLS = ["studio_play", "studio_status", "studio_stop"];

/**
 * Two add-on entries on this instance: a healthy server ("studio") and one whose probe
 * fails ("broken"). Only the injected probe ever runs.
 */
function writeAddons() {
  const entry = (id) => ({ command: "node", args: ["server/index.js"], cwd: join(HOME, "bundles", id) });
  mkdirSync(join(HOME, "bundles", "studio"), { recursive: true });
  mkdirSync(join(HOME, "bundles", "broken"), { recursive: true });
  writeFileSync(join(HOME, "mcp-addons.json"),
    JSON.stringify({ studio: entry("studio"), broken: entry("broken") }, null, 2));
}
writeAddons();

const def = (crowMcp, extra = {}) => ({ tools: { crow_mcp: crowMcp, ...extra } });

beforeEach(() => BST._resetBareServerToolsForTest());

// ── the expansion ────────────────────────────────────────────────────────────────

test("(a) a bare server expands to that server's real tool names", () => {
  const csv = toolAllowlist({ tools: { pi_builtin: ["read"], crow_mcp: ["studio"] } },
    { bareServerTools: { studio: STUDIO_TOOLS } });
  assert.equal(csv, "read,mcp__studio__studio_play,mcp__studio__studio_status,mcp__studio__studio_stop");
});

test("(b) per-tool entries are byte-identical to before, with and without an explicit list", () => {
  const d = { tools: { pi_builtin: ["read"], crow_mcp: ["studio/studio_play", "crow-memory/crow_recall"] } };
  const before = "read,mcp__studio__studio_play,mcp__crow-memory__crow_recall";
  assert.equal(toolAllowlist(d), before, "no option: the same csv every caller got until now");
  assert.equal(toolAllowlist(d, { bareServerTools: { studio: STUDIO_TOOLS } }), before,
    "a per-tool entry has a \"/\": the bare expander never claims it");
});

test("(c) a bare SERVICE entry with labelled blocks keeps today's spelling — the service wins first claim", () => {
  // "github" is both a bare name and a connected service that got blocks this turn.
  const d = def(["github"]);
  assert.equal(toolAllowlist(d, { serviceBlocks: { github: ["github-work"] } }), "mcp__github-work");
  assert.equal(toolAllowlist(d, { serviceBlocks: { github: ["github-work"] }, bareServerTools: { github: STUDIO_TOOLS } }),
    "mcp__github-work", "service blocks are claimed before the bare expansion");
  // A per-tool service entry is untouched by both.
  assert.equal(toolAllowlist(def(["github/get_me"]), { serviceBlocks: { github: ["github-work"] } }),
    "mcp__github-work__get_me");
});

test("(d) serviceSkippedTools (the over-long names) are dropped from a bare expansion", () => {
  const csv = toolAllowlist(def(["studio"]), {
    bareServerTools: { studio: STUDIO_TOOLS },
    serviceSkippedTools: ["mcp__studio__studio_status"],
  });
  assert.equal(csv, "mcp__studio__studio_play,mcp__studio__studio_stop");
});

test("(e) an UNKNOWN bare name keeps today's spelling", () => {
  assert.equal(toolAllowlist(def(["studio"])), "mcp__studio", "nothing primed, no cache entry");
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: {} }), "mcp__studio", "an empty explicit map knows nothing");
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: { other: STUDIO_TOOLS } }), "mcp__studio");
});

test("(f) remoteEnabled false/true add exactly what they added before", () => {
  const d = { tools: { pi_builtin: ["read"], crow_mcp: ["studio"], remote_mcp: ["g1abcdef::crow-memory", "g1abcdef::crow-blog"] } };
  const opts = { bareServerTools: { studio: STUDIO_TOOLS } };
  const off = toolAllowlist(d, { ...opts, remoteEnabled: false }).split(",");
  assert.equal(toolAllowlist(d, { ...opts }).split(",").join(","), off.join(","), "false is the default (no opts)");
  assert.deepEqual(off.filter((n) => n.startsWith("mcp__crow-remote-")), [], "no remote entry on a local turn");
  const on = toolAllowlist(d, { ...opts, remoteEnabled: true }).split(",");
  assert.deepEqual(on.filter((n) => n.startsWith("mcp__crow-remote-")).sort(),
    ["mcp__crow-remote-g1abcdef-crow-blog", "mcp__crow-remote-g1abcdef-crow-memory"]);
  assert.deepEqual(on.filter((n) => n.startsWith("mcp__studio__")), STUDIO_TOOLS.map((t) => "mcp__studio__" + t));
});

test("(g) the tool budget counts the expanded names exactly like the same list written per tool", () => {
  const expanded = toolAllowlist(def(["studio"]), { bareServerTools: { studio: STUDIO_TOOLS } });
  const perTool = toolAllowlist(def(STUDIO_TOOLS.map((t) => "studio/" + t)));
  assert.equal(expanded, perTool, "same names, same order — the expansion is not a special count");
  assert.equal(checkToolBudget(expanded, STUDIO_TOOLS.length).ok, true, "at the cap is fine");
  assert.equal(checkToolBudget(expanded, STUDIO_TOOLS.length - 1).ok, false, "past it is over");
  assert.equal(checkToolBudget(expanded, STUDIO_TOOLS.length - 1).count, STUDIO_TOOLS.length);
});

// ── priming the cache ───────────────────────────────────────────────────────────

test("(h) a successful prime fills the cache so toolAllowlist() — no option — expands", async () => {
  let calls = 0;
  const probe = async () => { calls++; return { ok: true, tools: STUDIO_TOOLS.map((name) => ({ name })) }; };
  const d = def(["studio"]);
  await BST.primeBareServerTools(d, { crowHome: HOME, probe });
  assert.equal(calls, 1);
  assert.deepEqual(BST.getBareServerTools("studio"), STUDIO_TOOLS);
  assert.equal(toolAllowlist(d), "mcp__studio__studio_play,mcp__studio__studio_status,mcp__studio__studio_stop");
  // A fresh entry is NOT re-probed: the next turn's prime costs nothing.
  await BST.primeBareServerTools(d, { crowHome: HOME, probe });
  assert.equal(calls, 1, "a positive listing lives 5 minutes, so the same turn line costs one probe");
});

test("(h) a failing probe warns ONCE for two primes and keeps today's spelling", async () => {
  const logs = [];
  const probe = async () => ({ ok: false, error: "spawn failed: ENOENT" });
  const d = def(["broken"]);
  await BST.primeBareServerTools(d, { crowHome: HOME, probe, log: (m) => logs.push(m), now: 1_000 });
  await BST.primeBareServerTools(d, { crowHome: HOME, probe, log: (m) => logs.push(m), now: 62_000 + 1_000 });
  assert.equal(logs.filter((m) => /broken/.test(m)).length, 1, logs.join("\n"));
  assert.match(logs[0], /bare server "broken" in crow_mcp could not be listed/);
  assert.match(logs[0], /its entry stays "mcp__broken" and matches no tool/);
  assert.equal(toolAllowlist(d), "mcp__broken", "a failed listing is not an expansion");
});

test("(h) primeBareServerTools never throws — a rejecting probe, a junk def, no tools object", async () => {
  const boom = async () => { throw new Error("kaboom"); };
  await BST.primeBareServerTools(def(["studio"]), { crowHome: HOME, probe: boom, log: () => {} });
  assert.equal(toolAllowlist(def(["studio"])), "mcp__studio");
  for (const junk of [null, undefined, {}, { tools: null }, { tools: { crow_mcp: "studio" } }, { tools: { crow_mcp: [null, 7, {}] } }]) {
    await BST.primeBareServerTools(junk, { crowHome: HOME, probe: boom });
  }
});

test("(i) a failed probe is remembered 60 s and retried after it", async () => {
  let mode = "fail";
  let calls = 0;
  const probe = async () => {
    calls++;
    return mode === "fail" ? { ok: false, error: "not up yet" } : { ok: true, tools: [{ name: "studio_play" }] };
  };
  const d = def(["studio"]);
  // The clock seam only shifts the stamps: toolAllowlist reads the cache against
  // the real clock, so the base stays close to it.
  const t0 = Date.now();
  await BST.primeBareServerTools(d, { crowHome: HOME, probe, now: t0 });
  assert.equal(calls, 1);
  assert.equal(toolAllowlist(d), "mcp__studio");
  // Still inside the 60 s window: no re-probe, no expansion.
  mode = "ok";
  await BST.primeBareServerTools(d, { crowHome: HOME, probe, now: t0 + 59_000 });
  assert.equal(calls, 1, "a broken server is not re-probed on every turn");
  assert.equal(toolAllowlist(d), "mcp__studio");
  // Past it: probed again, and the listing is used.
  await BST.primeBareServerTools(d, { crowHome: HOME, probe, now: t0 + 61_000 });
  assert.equal(calls, 2);
  assert.equal(toolAllowlist(d), "mcp__studio__studio_play");
});

// ── satellite-hosted bundles are never expanded locally ─────────────────────────

test("(j) a satellite-hosted bundle's bare entry is never expanded from a local listing", () => {
  // The loaded cache is exactly what used to turn "gitea" into local tool names.
  BST._setBareServerToolsForTest("gitea", ["gitea_list", "gitea_create"]);
  const satelliteBlocks = { "gitea-remote": "gitea" };
  assert.equal(toolAllowlist(def(["gitea"]), { satelliteBlocks }), "mcp__gitea",
    "a bare entry naming a satellite-hosted bundle keeps today's spelling");
  assert.equal(BST.expandBareEntry("gitea", { bareServerTools: { gitea: ["gitea_list"] }, satelliteBundles: ["gitea"] }), null,
    "an array of bundle ids is enough to exempt the entry");
  assert.equal(BST.expandBareEntry("gitea", { bareServerTools: { gitea: ["gitea_list"] }, satelliteBundles: new Set(["gitea"]) }), null,
    "a Set works too");
  // Per-tool entries are spelled by expandSatelliteEntry exactly as before.
  assert.equal(toolAllowlist(def(["gitea/gitea_list", "gitea/gitea_create"]), { satelliteBlocks }),
    "mcp__gitea-remote__gitea_list,mcp__gitea-remote__gitea_create");
  // No block this turn (revoked satellite, ungranted bundle): unchanged.
  assert.equal(toolAllowlist(def(["gitea/gitea_list"])), "mcp__gitea__gitea_list");
  // Only a satellite-HOSTED bundle is exempt: the same cache entry still expands for a
  // plain local server id.
  assert.equal(toolAllowlist(def(["gitea"]), { satelliteBlocks: {} }),
    "mcp__gitea__gitea_list,mcp__gitea__gitea_create");
});

test("(k) a satellite-hosted add-on is never probed, logged or cached", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-bare-sat-home-"));
  writeFileSync(join(home, "mcp-addons.json"),
    JSON.stringify({ gitea: { transport: "satellite", satellite_id: "s1", bundle: "gitea" } }, null, 2));
  let calls = 0;
  const logs = [];
  const probe = async () => { calls++; return { ok: true, tools: [{ name: "gitea_list" }] }; };
  const d = def(["gitea"]);
  await BST.primeBareServerTools(d, { crowHome: home, probe, log: (m) => logs.push(m) });
  assert.equal(calls, 0, "there is no local server to list");
  assert.deepEqual(logs, [], "nothing is broken, so there is nothing to warn about");
  assert.equal(BST.getBareServerTools("gitea"), null, "nothing cached");
  assert.equal(toolAllowlist(d), "mcp__gitea", "a revoked or ungranted satellite stays with NO tools");
});