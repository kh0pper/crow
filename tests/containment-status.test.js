/**
 * Honest containment status (bot containment Phase 1, Task 8).
 *
 * The exhaustive list of what Phase 1 leaves open is in the policy; these tests
 * pin the WORDS (the docs, the spawn log and the settings page quote them) and
 * the folding rules (weakest bot wins, union of open lines, bot ids prefixed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const CS = await import("../scripts/pi-bots/containment-status.mjs");

const DATA = "crow.db and tasks.db are readable and writable (provider keys, OAuth tokens, settings, bot definitions)";
const BROWSER = "the browser is unreachable (no browser door yet)";
const SWAP = "an uncontained bot could replace the hidden secrets dir before a restart (peer tokens, service bindings)";
const UNCONTAINED = "runs with the operator's files, network and keys";
const NO_BWRAP = "this host has no bwrap";
const UNOBSERVED = "spawns outside this process are not observed here, so this bot counts as not contained";

test("phase 1 is never contained: a contain-tier bot with any config is partly contained, and crow.db is always the first line", () => {
  for (const tier of ["contain", "contain-noseccomp", "contain-hostnet", "contain-noseccomp-hostnet"]) {
    const s = CS.botContainment({ tier, mcpServers: ["crow-memory"], tools: ["read"] });
    assert.equal(s.level, "partly contained", tier);
    assert.equal(s.open[0], DATA, tier);
    assert.ok(!s.open.some((l) => /runs with the operator's files/.test(l)), "a contain spawn is not called uncontained");
  }
  assert.equal(CS.OPEN_DATA_DBS, DATA);
  assert.equal(CS.OPEN_BROWSER, BROWSER);
  assert.equal(CS.OPEN_SECRETS_SWAP, SWAP);
  assert.equal(CS.OPEN_UNCONTAINED, UNCONTAINED);
  assert.equal(CS.OPEN_NO_BWRAP, NO_BWRAP);
  assert.equal(CS.OPEN_UNOBSERVED, UNOBSERVED);
});

test("an unobserved bot (no record here, or PIBOT_SUPERVISOR=external) is not contained, with the one line (F1)", () => {
  assert.deepEqual(CS.unobservedContainment(), { level: "not contained", open: [UNOBSERVED] });
  const inst = CS.instanceContainment([
    { botId: "helper", ...CS.unobservedContainment() },
    { botId: "desk", level: "partly contained", open: [DATA] },
  ], { host: { bwrap: true } });
  assert.equal(inst.level, "not contained", "an unobserved bot is never more than not contained");
  assert.ok(inst.open.includes("helper: " + UNOBSERVED));
  assert.ok(inst.open.includes(SWAP), "an unobserved bot runs as this uid and can swap the secrets dir");
  assert.ok(inst.open.includes("desk: " + DATA), "the observed bot's lines are kept");
});

test("each credentialed add-on in the bot's config gets its own line; Crow's own servers do not", () => {
  const s = CS.botContainment({
    tier: "contain",
    mcpServers: ["crow-projects", "crow-tasks", "artifacts", "github", "trello", "canvas-lms"],
    tools: [],
  });
  assert.deepEqual(s.open, [
    DATA,
    "github runs inside the sandbox with its own credentials",
    "trello runs inside the sandbox with its own credentials",
    "canvas-lms runs inside the sandbox with its own credentials",
  ]);
});

test("the browser line applies when a browser MCP or a browser tool is configured (and never doubles as an add-on)", () => {
  for (const name of ["browser", "crow-browser", "crow-browser-live"]) {
    const s = CS.botContainment({ tier: "contain", mcpServers: [name] });
    assert.deepEqual(s.open, [DATA, BROWSER], name);
  }
  const viaTool = CS.botContainment({ tier: "contain", mcpServers: [], tools: ["crow_browser_navigate"] });
  assert.deepEqual(viaTool.open, [DATA, BROWSER]);
  assert.equal(CS.isBrowserServer("crow-browser"), true);
  assert.equal(CS.isBrowserServer("brave-search"), false);
});

test("a server added twice (two tools of the same add-on) is named once", () => {
  const s = CS.botContainment({ tier: "contain", mcpServers: ["github", "github"] });
  assert.deepEqual(s.open, [DATA, "github runs inside the sandbox with its own credentials"]);
});

test("uncontained bot: tier other than contain (or none at all) is not contained, with the one line", () => {
  for (const tier of [null, undefined, "none", "pidns", "userns", "nnp"]) {
    const s = CS.botContainment({ tier, mcpServers: ["github"], tools: ["read"] });
    assert.deepEqual(s, { level: "not contained", open: [UNCONTAINED] }, String(tier));
  }
});

test("refused bot: a provider with no door is not contained, and the open line names it", () => {
  assert.deepEqual(CS.botContainment({ tier: null, missing: [{ provider: "lan-row", reason: "provider lan-row has no door" }] }),
    { level: "not contained", open: ["provider lan-row has no door"] });
  // The refusal wins even for a spawn that had a contain tier planned.
  const s = CS.botContainment({ tier: "contain", missing: [{ provider: "cloud-row" }] });
  assert.deepEqual(s, { level: "not contained", open: ["provider cloud-row has no door"] });
  // Deduped, and a bare provider id is enough.
  assert.deepEqual(CS.botContainment({ missing: ["a", "provider b has no door", { provider: "a" }] }).open,
    ["provider a has no door", "provider b has no door"]);
  assert.equal(CS.noDoorLine("x"), "provider x has no door");
});

test("host without bwrap: the instance is not contained and says why", () => {
  const s = CS.instanceContainment([{ botId: "helper", level: "partly contained", open: [DATA] }], { host: { bwrap: false } });
  assert.equal(s.level, "not contained");
  assert.ok(s.open.includes(NO_BWRAP));
  assert.ok(s.open.includes("helper: " + DATA), "the bots' own lines are kept");
});

test("instance level is the weakest bot's; open is the union, de-duplicated, bot ids prefixed", () => {
  const bots = [
    { botId: "helper", level: "partly contained", open: [DATA, "github runs inside the sandbox with its own credentials"] },
    { botId: "desk", level: "partly contained", open: [DATA, BROWSER] },
  ];
  const partly = CS.instanceContainment(bots, { host: { bwrap: true } });
  assert.equal(partly.level, "partly contained");
  assert.deepEqual(partly.open, [
    "helper: " + DATA,
    "helper: github runs inside the sandbox with its own credentials",
    "desk: " + DATA,
    "desk: " + BROWSER,
  ]);
  assert.ok(!partly.open.includes(SWAP), "no uncontained bot, no secrets-dir line");

  const mixed = CS.instanceContainment([...bots, { botId: "chatty", level: "not contained", open: [UNCONTAINED] }], { host: { bwrap: true } });
  assert.equal(mixed.level, "not contained", "the weakest level wins");
  assert.ok(mixed.open.includes("chatty: " + UNCONTAINED));
  assert.ok(mixed.open.includes(SWAP), "an uncontained bot can swap the secrets dir");
  assert.ok(mixed.open.includes("helper: " + DATA), "nothing from the contained bots is lost");
});

test("uncontained bots can swap the secrets dir: the line appears only while one enabled pi bot is not contained", () => {
  const withUncontained = CS.instanceContainment([
    { botId: "a", level: "partly contained", open: [DATA] },
    { botId: "b", level: "not contained", open: [UNCONTAINED] },
  ], { host: { bwrap: true } });
  assert.equal(withUncontained.open.filter((l) => l === SWAP).length, 1);
  const allContained = CS.instanceContainment([{ botId: "a", level: "partly contained", open: [DATA] }], { host: { bwrap: true } });
  assert.deepEqual(allContained.open.filter((l) => l === SWAP), []);
  assert.equal(CS.instanceContainment([], { host: { bwrap: true } }).level, "contained", "no bot open, nothing exposed");
});

test("the last spawn's status is remembered in-process, and the [containment] line is one fixed line", () => {
  CS._resetContainmentForTest();
  assert.equal(CS.recordedContainment("helper"), null);
  CS.recordContainment("helper", { level: "partly contained", open: [DATA, BROWSER], tier: "contain" });
  const got = CS.recordedContainment("helper");
  assert.equal(got.level, "partly contained");
  assert.deepEqual(got.open, [DATA, BROWSER]);
  assert.equal(got.tier, "contain");
  got.open.push("mutated");
  assert.equal(CS.recordedContainment("helper").open.length, 2, "a reader cannot mutate the record");
  const line = CS.formatContainmentLine("helper", { level: "partly contained", open: [DATA, BROWSER] });
  assert.equal(line, "[containment] helper partly contained: 2 open (" + DATA + "; " + BROWSER + ")");
  assert.equal(CS.formatContainmentLine(null, { level: "not contained", open: [UNCONTAINED] }),
    "[containment] not contained: 1 open (" + UNCONTAINED + ")");
  CS._resetContainmentForTest();
});

test("crowMcpServers/defToolNames reduce a def's grants the way the spawner does", () => {
  const def = {
    tools: {
      pi_builtin: ["read", "bash"],
      crow_mcp: ["crow-memory/crow_store_memory", "crow-memory/crow_search_memories", "github/create_issue", "board__board_list_cards"],
    },
  };
  assert.deepEqual(CS.crowMcpServers(def), ["crow-memory", "github", "board"]);
  assert.deepEqual(CS.defToolNames(def), ["read", "bash", "crow-memory/crow_store_memory", "crow-memory/crow_search_memories", "github/create_issue", "board__board_list_cards"]);
  assert.deepEqual(CS.crowMcpServers({}), []);
  assert.equal(CS.isCrowOwnServer("crow-memory"), true);
  assert.equal(CS.isCrowOwnServer("github"), false);
});