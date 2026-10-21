// Skills panel option C, PR 2: the off list reaches the paths that don't go
// through the pi spawn. Voice / glasses / kiosk bound bots resolve raw
// def.skills (system-prompt.js), so a Design kit skill a bot selects still
// loads there on a kit-less Crow (review I1): the row keeps its switch, and
// switching it off is what removes it. Job runs and the gateways process are
// pinned at the source level.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "skills-off-voice-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.CROW_HOME, "skills", "design-frontend.md"), "# Design frontend\n\nBOLD-DESIGN-TEXT\n");
writeFileSync(join(process.env.CROW_HOME, "installed.json"), "[]"); // no Design kit on this Crow
after(() => rmSync(scratch, { recursive: true, force: true }));

const { generateSystemPrompt } = await import("../servers/gateway/ai/system-prompt.js");
const { setSkillOff } = await import("../servers/shared/skill-state.js");
const { installedKitDir } = await import("../servers/shared/design-kit.js");

test("voice path, kit-less Crow: a selected Design kit skill loads while on, and is gone once switched off (no 'not found' warning)", async () => {
  assert.equal(installedKitDir(process.env.CROW_HOME), null, "the kit is not installed here");
  const botDef = { system_prompt: "You are the house voice.", skills: ["design-frontend"] };
  assert.match(await generateSystemPrompt({ botDef }), /BOLD-DESIGN-TEXT/, "loads on a voice turn although chat bots would skip it");
  setSkillOff(process.env.CROW_HOME, "design-frontend", true);
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    const prompt = await generateSystemPrompt({ botDef });
    assert.doesNotMatch(prompt, /BOLD-DESIGN-TEXT/);
    assert.match(prompt, /You are the house voice\./);
  } finally { console.warn = orig; setSkillOff(process.env.CROW_HOME, "design-frontend", false); }
  assert.ok(!warns.some((w) => /not found/.test(w)), warns.join("\n"));
});

test("job runs resolve through resolveSkills (the off list's choke point)", () => {
  const src = readFileSync(new URL("../scripts/pi-bots/job_runner.mjs", import.meta.url), "utf8");
  assert.match(src, /resolveSkills\(def\.skills \|\| \[\], \{ crowHome \}\)/);
  assert.doesNotMatch(src, /resolveSkill\(/, "no direct single-skill lookup that would bypass the list");
});

test("the gateways process logs that its resolver honours the off list, once at boot (review I3)", () => {
  const src = readFileSync(new URL("../scripts/pi-bots/gateways/gateway_runner.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ SKILL_OFF_LIST_SUPPORTED \} from "\.\.\/skill_resolver\.mjs";/);
  const main = src.slice(src.indexOf("(function main()"));
  assert.match(main, /if \(SKILL_OFF_LIST_SUPPORTED\) log\("skill off-list: supported"\);/);
});
