/**
 * A BARE server name in a bot def's `tools.crow_mcp` (e.g. "studio").
 *
 * pi's `--tools` filter matches EXACT names, and pi-lab registers a local MCP server's
 * tools one by one as `mcp__<server>__<tool>`. So `mcp__studio` — today's spelling —
 * matched nothing: the server started and every tool was filtered out, while
 * "studio/studio_play" -> `mcp__studio__studio_play` worked. bare-server-tools.mjs lists
 * the server's real tools (primed before the spawn) and RETURNS the validated listing as
 * an explicit snapshot (`piRpcOpts.bareServerTools`); the csv assembly reads only that
 * snapshot, so the budget check and the spawn see one listing.
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
/** A SECOND Crow home with the same server id (F3): its listings must never mix. */
const HOME2 = mkdtempSync(join(tmpdir(), "crow-bare-tools-home2-"));
// Env BEFORE the modules load: model_resolver pins PI_MODELS_JSON at import time, and
// the skill/home resolvers read $HOME — keep both on scratch paths.
process.env.HOME = mkdtempSync(join(tmpdir(), "crow-bare-tools-user-"));
process.env.CROW_HOME = HOME;
process.env.PI_MODELS_JSON = join(HOME, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));

const BST = await import("../scripts/pi-bots/bare-server-tools.mjs");
const { toolAllowlist, buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
const { checkToolBudget } = await import("../scripts/pi-bots/tool-budget.mjs");
const { PI_TOOL_NAME_MAX } = await import("../scripts/pi-bots/service-blocks.mjs");
const { defaultCompanionBudget } = await import("../scripts/pi-bots/artifacts-companions.mjs");

const RESOLVED = { provider: "stub", model: "m1" };
const STUDIO_TOOLS = ["studio_play", "studio_status", "studio_stop"];

/**
 * Two add-on entries per instance: a healthy server ("studio") and one whose probe
 * fails ("broken"). Only the injected probe ever runs.
 */
function writeAddons(home) {
  const entry = (id) => ({ command: "node", args: ["server/index.js"], cwd: join(home, "bundles", id) });
  mkdirSync(join(home, "bundles", "studio"), { recursive: true });
  mkdirSync(join(home, "bundles", "broken"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"),
    JSON.stringify({ studio: entry("studio"), broken: entry("broken") }, null, 2));
}
writeAddons(HOME);
writeAddons(HOME2);

const def = (crowMcp, extra = {}) => ({ tools: { crow_mcp: crowMcp, ...extra } });
const listing = (list) => list.map((name) => ({ name }));

beforeEach(() => BST._resetBareServerToolsForTest());

// ── the expansion (from the explicit snapshot) ──────────────────────────────────

test("(a) a bare server expands to that server's real tool names", () => {
  const csv = toolAllowlist({ tools: { pi_builtin: ["read"], crow_mcp: ["studio"] } },
    { bareServerTools: { studio: STUDIO_TOOLS } });
  assert.equal(csv, "read,mcp__studio__studio_play,mcp__studio__studio_status,mcp__studio__studio_stop");
});

test("(b) per-tool entries are byte-identical to before, with and without a snapshot", () => {
  const d = { tools: { pi_builtin: ["read"], crow_mcp: ["studio/studio_play", "crow-memory/crow_recall"] } };
  const before = "read,mcp__studio__studio_play,mcp__crow-memory__crow_recall";
  assert.equal(toolAllowlist(d), before, "no snapshot: the same csv every caller got until now");
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

test("(e) an UNKNOWN bare name keeps today's spelling — the module cache is never read", () => {
  assert.equal(toolAllowlist(def(["studio"])), "mcp__studio", "no snapshot at all");
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: {} }), "mcp__studio", "an empty snapshot knows nothing");
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: { other: STUDIO_TOOLS } }), "mcp__studio");
  // A cache entry left by another path does not reach a spawn: the snapshot is the only input.
  BST._setBareServerToolsForTest("studio", STUDIO_TOOLS, { crowHome: HOME });
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME }), STUDIO_TOOLS, "the cache does hold it");
  assert.equal(toolAllowlist(def(["studio"])), "mcp__studio", "...and the turn path still reads no cache");
  assert.equal(BST.expandBareEntry("studio"), null, "expandBareEntry has no implicit cache fallback");
  assert.equal(BST.expandBareEntry("studio", { bareServerTools: [STUDIO_TOOLS] }), null, "an array is not a snapshot");
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

test("(g) defaultCompanionBudget's countFor counts the expanded names when it is given the snapshot", async () => {
  const d = { ...def(["studio"]), models: { default: "stub/m1" } };
  const perTool = { tools: { crow_mcp: STUDIO_TOOLS.map((t) => "studio/" + t) }, models: { default: "stub/m1" } };
  const withMap = await defaultCompanionBudget(d, { bareServerTools: { studio: STUDIO_TOOLS } });
  const perToolBudget = await defaultCompanionBudget(perTool);
  assert.equal(withMap.countFor(d), perToolBudget.countFor(perTool),
    "one name per listed tool, not the single mcp__studio spelling");
  assert.equal(perToolBudget.countFor(perTool) - (await defaultCompanionBudget(d)).countFor(d), STUDIO_TOOLS.length - 1,
    "without the snapshot the count is unchanged: the bare entry counts as its one spelling");
});

// ── F1: tool names and server ids are data, never grants ────────────────────────

test("(l) F1: a listed name is kept only as a valid pi tool name of at most 64 characters", async () => {
  const prefix = "mcp__studio__";
  const fit = "a".repeat(PI_TOOL_NAME_MAX - prefix.length); // exactly 64 with the prefix
  const tooLong = "b".repeat(PI_TOOL_NAME_MAX - prefix.length + 1); // one over
  const listed = ["ok_tool", "ok_tool,read", "with space", "line\nbreak", "tab\tname", "semi;colon",
    "quote\"name", fit, tooLong, "x".repeat(80)];
  const logs = [];
  const probe = async () => ({ ok: true, tools: listing(listed) });
  const map = await BST.primeBareServerTools(def(["studio"]), { crowHome: HOME, probe, log: (m) => logs.push(m) });
  assert.deepEqual(map, { studio: ["ok_tool", fit] }, "only the shape-safe, short-enough names survive");
  const csv = buildToolsCsv(def(["studio"]), { resolved: RESOLVED, bareServerTools: map }).csv;
  const entries = csv.split(",");
  assert.deepEqual(entries.slice().sort(), ["mcp__studio__" + fit, "mcp__studio__ok_tool"].sort());
  assert.ok(!entries.includes("read"), "a name carrying a comma must never inject pi's built-in `read`");
  assert.ok(!csv.includes("ok_tool,read"), "nor be joined into the csv at all");
  assert.ok(!csv.includes(" "), "no space ends up in the csv");
  assert.ok(!csv.includes("\n"), "no newline ends up in the csv");
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(logs[0], /not a valid pi tool name/);
});

test("(l) F1: the dropped-name warning is one line per server", async () => {
  const logs = [];
  const probe = async () => ({ ok: true, tools: listing(["ok_tool", "bad,name", "also bad"]) });
  await BST.primeBareServerTools(def(["studio"]), { crowHome: HOME, probe, log: (m) => logs.push(m) });
  await BST.primeBareServerTools(def(["studio"]), { crowHome: HOME, probe, log: (m) => logs.push(m) });
  assert.equal(logs.filter((m) => /not a valid pi tool name/.test(m)).length, 1, logs.join("\n"));
});

test("(m) F1: an invalid SERVER id is never expanded and never probed", async () => {
  let calls = 0;
  const probe = async () => { calls++; return { ok: true, tools: listing(["studio_play"]) }; };
  const logs = [];
  const badIds = ["bad,id", "has space", "line\nbreak"];
  for (const id of badIds) {
    const map = await BST.primeBareServerTools(def([id]), { crowHome: HOME, probe, log: (m) => logs.push(m) });
    assert.deepEqual(map, {}, JSON.stringify(id) + " is not a server id");
    assert.equal(Object.hasOwn(map, id), false);
  }
  assert.equal(calls, 0, "no invalid id is ever probed");
  assert.equal(logs.length, badIds.length, "one line per id, and never a probe");
  assert.equal(BST.expandBareEntry("bad,id", { bareServerTools: { "bad,id": ["read"] } }), null,
    "an invalid id is never expanded, even with a hand-made snapshot");
});

test("(q) F4: an empty or unavailable listing keeps mcp__<id>", async () => {
  const logs = [];
  const empty = await BST.primeBareServerTools(def(["studio"]), {
    crowHome: HOME, probe: async () => ({ ok: true, tools: [] }), log: (m) => logs.push(m),
  });
  assert.deepEqual(empty, {}, "an empty listing has no usable names");
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: empty }), "mcp__studio",
    "the caller keeps its own spelling (a router-mode server registers exactly that name)");
  assert.match(logs[0], /exposes no tools/);
  // Names that all fail validation are the same case: nothing left, so no expansion.
  const allBad = await BST.primeBareServerTools(def(["studio"]), {
    crowHome: HOME, probe: async () => ({ ok: true, tools: listing(["a,b", "c d"]) }), log: () => {},
  });
  assert.deepEqual(allBad, {});
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: allBad }), "mcp__studio");
});

// ── priming: the returned snapshot and the cache behind it ──────────────────────

test("(h) a successful prime returns the snapshot, fills the cache, and is not re-probed", async () => {
  let calls = 0;
  const probe = async () => { calls++; return { ok: true, tools: listing(STUDIO_TOOLS) }; };
  const d = def(["studio"]);
  const map = await BST.primeBareServerTools(d, { crowHome: HOME, probe });
  assert.equal(calls, 1);
  assert.deepEqual(map, { studio: STUDIO_TOOLS }, "the returned map IS this turn's listing");
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME }), STUDIO_TOOLS);
  assert.equal(toolAllowlist(d, { bareServerTools: map }),
    "mcp__studio__studio_play,mcp__studio__studio_status,mcp__studio__studio_stop");
  // A fresh entry is NOT re-probed, and the next turn's prime returns it from the cache.
  const again = await BST.primeBareServerTools(d, { crowHome: HOME, probe });
  assert.equal(calls, 1, "a positive listing lives 5 minutes, so the same turn line costs one probe");
  assert.deepEqual(again, { studio: STUDIO_TOOLS }, "a fresh cache hit is still a usable snapshot");
});

test("(h) a failing probe warns ONCE for two primes and returns no key", async () => {
  const logs = [];
  const probe = async () => ({ ok: false, error: "spawn failed: ENOENT" });
  const d = def(["broken"]);
  const first = await BST.primeBareServerTools(d, { crowHome: HOME, probe, log: (m) => logs.push(m), now: 1_000 });
  await BST.primeBareServerTools(d, { crowHome: HOME, probe, log: (m) => logs.push(m), now: 62_000 + 1_000 });
  assert.deepEqual(first, {}, "a failure has no listing to hand the spawn");
  assert.equal(logs.filter((m) => /broken/.test(m)).length, 1, logs.join("\n"));
  assert.match(logs[0], /bare server "broken" in crow_mcp could not be listed/);
  assert.match(logs[0], /its entry stays "mcp__broken" and matches no tool/);
  assert.equal(toolAllowlist(d, { bareServerTools: first }), "mcp__broken", "a failed listing is not an expansion");
});

test("(h) a sealed add-on's failure is named apart from a broken server", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-bare-sealed-home-"));
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    sealed: { command: "node", args: ["server/index.js"], keychainEnv: ["API_KEY"] },
  }, null, 2));
  const logs = [];
  const map = await BST.primeBareServerTools(def(["sealed"]), { crowHome: home, log: (m) => logs.push(m) });
  assert.deepEqual(map, {});
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(logs[0], /sealed add-on: keys are not readable from this process/,
    "an operator must be able to tell this from a server that does not start");
});

test("(h) primeBareServerTools never throws — a rejecting probe, a junk def, no tools object", async () => {
  const boom = async () => { throw new Error("kaboom"); };
  assert.deepEqual(await BST.primeBareServerTools(def(["studio"]), { crowHome: HOME, probe: boom, log: () => {} }), {});
  assert.equal(toolAllowlist(def(["studio"])), "mcp__studio");
  for (const junk of [null, undefined, {}, { tools: null }, { tools: { crow_mcp: "studio" } }, { tools: { crow_mcp: [null, 7, {}] } }]) {
    assert.deepEqual(await BST.primeBareServerTools(junk, { crowHome: HOME, probe: boom }), {});
  }
});

test("(i) a failed probe is remembered 60 s and retried after it", async () => {
  let mode = "fail";
  let calls = 0;
  const probe = async () => {
    calls++;
    return mode === "fail" ? { ok: false, error: "not up yet" } : { ok: true, tools: listing(["studio_play"]) };
  };
  const d = def(["studio"]);
  const t0 = Date.now();
  const failed = await BST.primeBareServerTools(d, { crowHome: HOME, probe, now: t0 });
  assert.equal(calls, 1);
  assert.deepEqual(failed, {});
  // Still inside the 60 s window: no re-probe, still no key.
  mode = "ok";
  const inside = await BST.primeBareServerTools(d, { crowHome: HOME, probe, now: t0 + 59_000 });
  assert.equal(calls, 1, "a broken server is not re-probed on every turn");
  assert.deepEqual(inside, {});
  // Past it: probed again, and the listing is used.
  const after = await BST.primeBareServerTools(d, { crowHome: HOME, probe, now: t0 + 61_000 });
  assert.equal(calls, 2);
  assert.deepEqual(after, { studio: ["studio_play"] });
  assert.equal(toolAllowlist(d, { bareServerTools: after }), "mcp__studio__studio_play");
});

test("(n) F2 expiry boundary: the held snapshot still expands after 5 minutes; the cache read does not", async () => {
  const t0 = Date.now();
  const d = def(["studio"]);
  const map = await BST.primeBareServerTools(d, {
    crowHome: HOME, probe: async () => ({ ok: true, tools: listing(STUDIO_TOOLS) }), now: t0,
  });
  assert.deepEqual(map, { studio: STUDIO_TOOLS });
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME, now: t0 + 1_000 }), STUDIO_TOOLS);
  const later = t0 + BST.BARE_TOOLS_TTL_MS + 1_000;
  // The spawn uses exactly what the budget check saw: no clock is consulted for the map.
  const csv = buildToolsCsv(d, { resolved: RESOLVED, bareServerTools: map }).csv;
  assert.equal(csv.split(",").filter((n) => n.startsWith("mcp__studio__")).length, STUDIO_TOOLS.length,
    "the held listing is still the one this spawn was decided on");
  assert.equal(BST.getBareServerTools("studio", { crowHome: HOME, now: later }), null,
    "a cache read past the TTL is null, so the next rail primes again");
});

test("(o) F3: one cache per Crow home — the same id never mixes two homes' listings", async () => {
  let callsA = 0, callsB = 0;
  const a = await BST.primeBareServerTools(def(["studio"]), {
    crowHome: HOME, probe: async () => { callsA++; return { ok: true, tools: listing(["a_tool"]) }; },
  });
  const b = await BST.primeBareServerTools(def(["studio"]), {
    crowHome: HOME2, probe: async () => { callsB++; return { ok: true, tools: listing(["b_tool"]) }; },
  });
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  assert.deepEqual(a, { studio: ["a_tool"] });
  assert.deepEqual(b, { studio: ["b_tool"] });
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME }), ["a_tool"]);
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME2 }), ["b_tool"]);
  // Each home's own fresh entry serves its own next turn, without cross-probing.
  const again = await BST.primeBareServerTools(def(["studio"]), {
    crowHome: HOME2, probe: async () => { callsB++; return { ok: true, tools: listing(["wrong"]) }; },
  });
  assert.deepEqual(again, { studio: ["b_tool"] });
  assert.equal(callsB, 1);
  assert.equal(toolAllowlist(def(["studio"]), { bareServerTools: b }), "mcp__studio__b_tool");
});

test("(p) F6: concurrent primes of one (home, server) probe it ONCE", async () => {
  let calls = 0;
  const probe = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 25));
    return { ok: true, tools: listing(["studio_play"]) };
  };
  const maps = await Promise.all([1, 2, 3, 4].map(() =>
    BST.primeBareServerTools(def(["studio"]), { crowHome: HOME, probe })));
  assert.equal(calls, 1, "one in-flight listing per (home, server)");
  for (const m of maps) assert.deepEqual(m, { studio: ["studio_play"] });
  // The in-flight entry is cleaned up, so a later turn after the TTL probes again.
  await BST.primeBareServerTools(def(["studio"]), {
    crowHome: HOME, probe, now: Date.now() + BST.BARE_TOOLS_TTL_MS + 1_000,
  });
  assert.equal(calls, 2);
});

// ── satellite-hosted bundles are never expanded locally ─────────────────────────

test("(j) a satellite-hosted bundle's bare entry is never expanded from a local listing", async () => {
  // The planted cache entry is exactly what used to turn "gitea" into local tool names.
  BST._setBareServerToolsForTest("gitea", ["gitea_list", "gitea_create"], { crowHome: HOME });
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
  // Only a satellite-HOSTED bundle is exempt: the same listing still expands for a
  // plain local server id.
  const map = await BST.primeBareServerTools(def(["gitea"]), {
    crowHome: HOME, probe: async () => { throw new Error("a fresh cache hit is not probed"); },
  });
  assert.deepEqual(map, { gitea: ["gitea_list", "gitea_create"] }, "the prime returns the fresh cache entry");
  assert.equal(toolAllowlist(def(["gitea"]), { satelliteBlocks: {}, bareServerTools: map }),
    "mcp__gitea__gitea_list,mcp__gitea__gitea_create");
  assert.equal(toolAllowlist(def(["gitea"]), { satelliteBlocks, bareServerTools: map }), "mcp__gitea");
});

test("(k) a satellite-hosted add-on is never probed, logged or cached", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-bare-sat-home-"));
  writeFileSync(join(home, "mcp-addons.json"),
    JSON.stringify({ gitea: { transport: "satellite", satellite_id: "s1", bundle: "gitea" } }, null, 2));
  let calls = 0;
  const logs = [];
  const probe = async () => { calls++; return { ok: true, tools: listing(["gitea_list"]) }; };
  const d = def(["gitea"]);
  const map = await BST.primeBareServerTools(d, { crowHome: home, probe, log: (m) => logs.push(m) });
  assert.equal(calls, 0, "there is no local server to list");
  assert.deepEqual(logs, [], "nothing is broken, so there is nothing to warn about");
  assert.deepEqual(map, {}, "no listing, so no key in the snapshot");
  assert.equal(BST.getBareServerTools("gitea", { crowHome: home }), null, "nothing cached");
  assert.equal(toolAllowlist(d, { bareServerTools: map }), "mcp__gitea",
    "a revoked or ungranted satellite stays with NO tools");
});

test("the test seams are per Crow home too", () => {
  BST._setBareServerToolsForTest("studio", STUDIO_TOOLS, { crowHome: HOME });
  BST._setBareServerToolsForTest("studio", ["other_tool"], { crowHome: HOME2 });
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME }), STUDIO_TOOLS);
  assert.deepEqual(BST.getBareServerTools("studio", { crowHome: HOME2 }), ["other_tool"]);
  BST._resetBareServerToolsForTest();
  assert.equal(BST.getBareServerTools("studio", { crowHome: HOME }), null);
  assert.equal(BST.getBareServerTools("studio", { crowHome: HOME2 }), null);
});