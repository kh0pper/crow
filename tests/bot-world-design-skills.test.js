// Design kit × bot spawn (spec §3.1, §4.3, §4.4; review H2): the kit mode comes
// from THIS instance's install (installedKitDir), is stated in one explicit
// prompt line, and the kit's skills are taken only from <crowHome>/skills — a
// copy another instance installed into ~/.crow/skills never leaks in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bot-world-design-"));
const crowHome = join(dir, "home");
const saved = { PI_MODELS_JSON: process.env.PI_MODELS_JSON, HOME: process.env.HOME };
const put = (home, n, body) => { mkdirSync(join(home, "skills"), { recursive: true }); writeFileSync(join(home, "skills", `${n}.md`), body + "\n"); };
for (const [n, body] of [["artifacts", "# Artifacts\n\nUse artifact_create."], ["design-frontend", "# Design frontend\n\nBold."], ["design-poster", "# Design poster\n\nPhilosophy first."], ["design-themes", "# Design themes\n\nUse --hs-bg."]]) put(crowHome, n, body);
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
// The MAIN instance's skills dir (~/.crow/skills) holds the kit skills, as it will on crow.
process.env.HOME = join(dir, "fakehome");
put(join(process.env.HOME, ".crow"), "design-frontend", "# Design frontend\n\nFROM-MAIN-INSTANCE");
put(join(process.env.HOME, ".crow"), "design-themes", "# Design themes\n\nFROM-MAIN-INSTANCE");
const { skillNamesFor, prepareSpawn, houseStylePromptBlock, kitModeLine, DESIGN_SKILLS } = await import("../scripts/pi-bots/bot-world.mjs");
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmScratch(dir);
});

const def = (crowMcp, skills = []) => ({ tools: { crow_mcp: crowMcp }, skills, models: { default: "stub/m1" } });
const HS = { id: "ocean-depths", name: "Ocean Depths", links: ["__lib/font/work-sans/font.css", "__lib/themes/ocean-depths.css"] };

test("skill names: kit skills only when THIS instance has the kit; design-poster only by selection", () => {
  assert.deepEqual(DESIGN_SKILLS, ["design-frontend"]);
  assert.deepEqual(skillNamesFor(def(["artifacts"]), { crowHome, kitInstalled: true }), ["artifacts", "design-frontend"]);
  assert.deepEqual(skillNamesFor(def(["artifacts"]), { crowHome, kitInstalled: true, houseStyle: HS }), ["artifacts", "design-frontend", "design-themes"]);
  assert.deepEqual(skillNamesFor(def(["artifacts"]), { crowHome, kitInstalled: false, houseStyle: HS }), ["artifacts"], "kit not installed here: nothing extra, whatever skill files exist");
  assert.deepEqual(skillNamesFor(def(["memory"]), { crowHome, kitInstalled: true, houseStyle: HS }), [], "no Artifacts grant, no design skills");
  assert.deepEqual(skillNamesFor(def(["artifacts"], ["design-poster"]), { crowHome, kitInstalled: true }), ["design-poster", "artifacts", "design-frontend"], "selected by the operator; no duplicates");
  assert.deepEqual(skillNamesFor(def(["artifacts"], ["design-poster", "memory-management"]), { crowHome, kitInstalled: false }), ["memory-management", "artifacts"], "an operator-selected design-* skill never leaks onto a kit-less instance (strict H2)");
  const other = join(dir, "other-instance"); put(other, "artifacts", "# Artifacts");
  assert.deepEqual(skillNamesFor(def(["artifacts"]), { crowHome: other, kitInstalled: true }), ["artifacts"], "kit skills present only in ~/.crow/skills (another instance) are never attached (review H2)");
});

test("prepareSpawn: one explicit mode line; house-style block and design-themes only with a house style", async () => {
  const sessionDir = join(dir, "s"); mkdirSync(sessionDir, { recursive: true });
  const world = (kitInstalled, houseStyle, d = def(["artifacts"]), home = crowHome) => ({ def: d, crowHome: home, projectId: null, projectSpace: null, sessionDir, cwd: sessionDir, mcpDelivery: "fd", mcpConfig: null, tasksDbPath: null, remoteEnabled: false, peerGatewayUrls: {}, session: null, botClassifier: null, narrowedTools: null, gatewayType: "perch", kitInstalled, houseStyle });
  const on = readFileSync((await prepareSpawn(world(true, HS), {})).sysFile, "utf8");
  assert.equal(on.split(kitModeLine(true)).length - 1, 1, "exactly one mode line");
  assert.match(on, /# Design frontend\n\nBold\./, "this instance's copy, not the main instance's");
  assert.doesNotMatch(on, /FROM-MAIN-INSTANCE/);
  assert.ok(on.includes(houseStylePromptBlock(HS)));
  assert.match(houseStylePromptBlock(HS), /"Ocean Depths" \(theme:ocean-depths\)/);
  assert.match(houseStylePromptBlock(HS), /__lib\/themes\/ocean-depths\.css/);
  const plain = readFileSync((await prepareSpawn(world(true, null), {})).sysFile, "utf8");
  assert.doesNotMatch(plain, /# Design themes|## House style/);
  const other = join(dir, "other-instance");
  const off = readFileSync((await prepareSpawn(world(false, null, def(["artifacts"]), other), {})).sysFile, "utf8");
  assert.ok(off.includes(kitModeLine(false)), "an instance without the kit says so");
  assert.doesNotMatch(off, /Design frontend|FROM-MAIN-INSTANCE/);
  const noGrant = readFileSync((await prepareSpawn(world(true, HS, def(["memory"])), {})).sysFile, "utf8");
  assert.doesNotMatch(noGrant, /Design kit:|House style/, "no Artifacts grant: nothing new");
});

test("spawn growth is measured (review L9)", async () => {
  const sessionDir = join(dir, "s2"); mkdirSync(sessionDir, { recursive: true });
  const w = (kitInstalled) => ({ def: def(["artifacts"]), crowHome, projectId: null, projectSpace: null, sessionDir, cwd: sessionDir, mcpDelivery: "fd", mcpConfig: null, tasksDbPath: null, remoteEnabled: false, peerGatewayUrls: {}, session: null, botClassifier: null, narrowedTools: null, gatewayType: "perch", kitInstalled, houseStyle: null });
  const a = readFileSync((await prepareSpawn(w(false), {})).sysFile).length;
  const b = readFileSync((await prepareSpawn(w(true), {})).sysFile).length;
  assert.ok(b > a);
  console.log(`[design-kit] fixture spawn growth with the kit: ${b - a} bytes (Step 4 records the real skill's growth)`);
});

test("final review M2: only the three kit skill names are dropped on a kit-less instance; another design-* skill survives", () => {
  const picks = ["design-frontend", "design-themes", "design-poster", "design-notes", "memory-management"];
  assert.deepEqual(skillNamesFor(def(["memory"], picks), { crowHome, kitInstalled: false }), ["design-notes", "memory-management"]);
  assert.deepEqual(skillNamesFor(def(["memory"], picks), { crowHome, kitInstalled: true }), picks);
});
