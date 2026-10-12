// F4 (Artifacts acceptance smoke, spec v1.6 chat-first PR-1 Task 1.5): a bot
// whose tools grant the Artifacts server always spawns with the bundle's
// protocol skill inlined into its system prompt — the child never has to read
// the skill file itself (the sandbox refusal that made a smoke bot bypass
// artifact_create). Pins: the grant predicate's parity with the bundle's
// grantsServer, the name-selection rules, and a real prepareSpawn sysFile.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE the module loads: model_resolver pins PI_MODELS_JSON at import
// time and skill_resolver reads HOME — same discipline as the golden fixture
// (bot-world.test.js), hence the dynamic imports below.
const dir = mkdtempSync(join(tmpdir(), "bot-world-art-"));
const crowHome = join(dir, "home");
const saved = { PI_MODELS_JSON: process.env.PI_MODELS_JSON, HOME: process.env.HOME };
mkdirSync(join(crowHome, "skills"), { recursive: true });
writeFileSync(join(crowHome, "skills", "artifacts.md"), "# Artifacts\n\nUse artifact_create to make something the owner can open.\n");
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
// skill_resolver falls back to ~/.crow/skills and ~/crow/skills; keep the
// real home out of the picture so only the scratch crowHome can resolve.
process.env.HOME = join(dir, "fakehome");
mkdirSync(process.env.HOME, { recursive: true });

const { botGrantsServer, skillNamesFor, prepareSpawn } = await import("../scripts/pi-bots/bot-world.mjs");
const { grantsServer } = await import("../bundles/artifacts/server/delivery.js");

before(() => {});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const def = (crowMcp, skills = []) => ({ tools: { crow_mcp: crowMcp }, skills, models: { default: "stub/m1" } });

test("parity: botGrantsServer(def,'artifacts') === the bundle's grantsServer on every entry spelling", () => {
  const entries = [
    "artifacts", "artifacts/artifact_create", "artifacts__artifact_create", "artifacts/",
    "memory", "art", "artifact", "artifacts2", "artifacts-x", "ARTIFACTS", "", null, 42, {},
    "memory/artifacts", "phone__artifacts",
  ];
  for (const e of entries) {
    const d = { tools: { crow_mcp: [e] } };
    assert.equal(botGrantsServer(d, "artifacts"), grantsServer(e, "artifacts"), JSON.stringify(e));
  }
  // Mixed lists and missing shapes.
  assert.equal(botGrantsServer(def(["memory", "artifacts/artifact_reply"]), "artifacts"), true);
  assert.equal(botGrantsServer(def(["memory"]), "artifacts"), false);
  assert.equal(botGrantsServer({ tools: {} }, "artifacts"), false);
  assert.equal(botGrantsServer({}, "artifacts"), false);
  assert.equal(botGrantsServer(null, "artifacts"), false);
});

test("skillNamesFor: the grant attaches the skill; an explicit selection wins; no grant, no file — nothing", () => {
  assert.deepEqual(skillNamesFor(def(["artifacts"]), { crowHome }), ["artifacts"]);
  assert.deepEqual(skillNamesFor(def(["artifacts/artifact_update"]), { crowHome }), ["artifacts"]);
  assert.deepEqual(skillNamesFor(def(["artifacts"], ["govqa-portal"]), { crowHome }), ["govqa-portal", "artifacts"], "appended after the operator's picks, once");
  assert.deepEqual(skillNamesFor(def(["artifacts"], ["artifacts"]), { crowHome }), ["artifacts"], "no duplicate");
  assert.deepEqual(skillNamesFor(def(["memory"]), { crowHome }), [], "no grant, no skill");
  // Bundle not installed on this instance: the grant adds nothing and the
  // spawn stays quiet (no missingSkills churn for a file that was never there).
  const bare = join(dir, "bare-home");
  mkdirSync(join(bare, "skills"), { recursive: true });
  assert.deepEqual(skillNamesFor(def(["artifacts"]), { crowHome: bare }), []);
  // A locked untrusted round's def is the SAME def — the protocol skill is
  // exactly what a narrowed session needs.
  assert.deepEqual(skillNamesFor(def(["artifacts__artifact_update"]), { crowHome }), ["artifacts"]);
});

test("prepareSpawn inlines the artifacts skill into the system prompt file when the def grants the server", async () => {
  const sessionDir = join(dir, "sessions", "botty");
  mkdirSync(sessionDir, { recursive: true });
  const world = (d) => ({
    def: d, crowHome, projectId: null, projectSpace: null, sessionDir, cwd: sessionDir,
    mcpDelivery: "fd", mcpConfig: null, tasksDbPath: null, remoteEnabled: false,
    peerGatewayUrls: {}, session: null, botClassifier: null, narrowedTools: null, gatewayType: "perch",
  });
  const withGrant = await prepareSpawn(world(def(["artifacts"])), {});
  const sys = readFileSync(withGrant.sysFile, "utf8");
  assert.match(sys, /^You are a Crow bot\./);
  assert.match(sys, /# Artifacts/);
  assert.match(sys, /artifact_create/);
  const without = await prepareSpawn(world(def(["memory"])), {});
  assert.doesNotMatch(readFileSync(without.sysFile, "utf8"), /# Artifacts/);
});
