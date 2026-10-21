// Skills panel option C, PR 2 (review I2): "Used by" is computed through the
// spawn's own skillNamesFor, never a copy of its rules, so the toast count,
// the delete warning and the row meta can't drift from what bots really load.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillUsage, loadBotRows } from "../servers/gateway/skills-used-by.js";
import { skillNamesFor } from "../scripts/pi-bots/bot-world.mjs";

const scratch = mkdtempSync(join(tmpdir(), "skills-used-by-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const crowHome = join(scratch, "home");
mkdirSync(join(crowHome, "skills"), { recursive: true });
for (const n of ["artifacts", "design-frontend", "design-themes", "media"]) writeFileSync(join(crowHome, "skills", `${n}.md`), `# ${n}\n`);

const bot = (bot_id, def, enabled = 1) => ({ bot_id, display_name: bot_id.replace(/-/g, " "), enabled, definition: typeof def === "string" ? def : JSON.stringify(def) });
const BOTS = [
  bot("home-helper", { skills: ["media", "tutoring"], tools: { crow_mcp: ["memory"] } }),
  bot("research-desk", { skills: ["media"], tools: { crow_mcp: ["artifacts"] }, design: { house_style: "ocean-depths" } }, 0),
  bot("poster-bot", { skills: [], tools: { crow_mcp: ["artifacts/artifact_create"] } }),
  bot("broken", "{ not json"),
];
const names = (u, skill) => (u.get(skill) || []).map((b) => b.botId + (b.paused ? "(paused)" : "") + (b.auto ? "*" : ""));

test("explicit selections, the artifacts auto-attach, paused bots flagged, bad JSON skipped", () => {
  const u = skillUsage({ crowHome, botRows: BOTS, kitInstalled: false, knownThemes: new Set() });
  assert.deepEqual(names(u, "media"), ["home-helper", "research-desk(paused)"]);
  assert.deepEqual(names(u, "tutoring"), ["home-helper"]);
  assert.deepEqual(names(u, "artifacts"), ["research-desk(paused)*", "poster-bot*"], "auto-attached by the grant (marked auto)");
  assert.deepEqual(names(u, "design-frontend"), [], "no kit here: never attached");
  assert.equal(u.get("media")[0].name, "home helper");
});

test("artifacts is attached only when its file resolves", () => {
  const bare = join(scratch, "bare");
  mkdirSync(join(bare, "skills"), { recursive: true });
  const u = skillUsage({ crowHome: bare, botRows: BOTS, kitInstalled: false, knownThemes: new Set() });
  assert.deepEqual(names(u, "artifacts"), []);
});

test("design-frontend only with the kit and the user-dir file; design-themes only for a bot whose house style is known", () => {
  const u = skillUsage({ crowHome, botRows: BOTS, kitInstalled: true, knownThemes: new Set(["ocean-depths"]) });
  assert.deepEqual(names(u, "design-frontend"), ["research-desk(paused)*", "poster-bot*"]);
  assert.deepEqual(names(u, "design-themes"), ["research-desk(paused)*"]);
  const unknown = skillUsage({ crowHome, botRows: BOTS, kitInstalled: true, knownThemes: new Set() });
  assert.deepEqual(names(unknown, "design-themes"), [], "a theme the kit doesn't know is no house style");
});

test("guard: every bot's usage equals skillNamesFor for that bot", () => {
  for (const kitInstalled of [false, true]) {
    const u = skillUsage({ crowHome, botRows: BOTS, kitInstalled, knownThemes: new Set(["ocean-depths"]) });
    for (const row of BOTS.slice(0, 3)) {
      const def = JSON.parse(row.definition);
      const expect = skillNamesFor(def, { crowHome, kitInstalled, houseStyle: def.design ? { id: def.design.house_style } : null }).sort();
      const got = [...u.entries()].filter(([, bots]) => bots.some((b) => b.botId === row.bot_id && !b.voiceJobOnly)).map(([n]) => n).sort();
      assert.deepEqual(got, expect, `${row.bot_id} kit=${kitInstalled}`);
    }
  }
});

test("loadBotRows reads pi_bot_defs and survives a missing table", async () => {
  const rows = await loadBotRows({ execute: async () => ({ rows: BOTS }) });
  assert.equal(rows.length, 4);
  assert.deepEqual(await loadBotRows({ execute: async () => { throw new Error("no such table"); } }), []);
});

test("without the Design kit, a bot that selects a kit skill still counts, marked voice/job only (chat skips it, voice and jobs load it)", () => {
  const rows = [bot("voice-desk", { skills: ["design-frontend", "media"] })];
  const u = skillUsage({ crowHome, botRows: rows, kitInstalled: false, knownThemes: new Set() });
  assert.deepEqual(u.get("design-frontend"), [{ botId: "voice-desk", name: "voice desk", paused: false, auto: false, voiceJobOnly: true }]);
  assert.equal(u.get("media")[0].voiceJobOnly, undefined);
  const withKit = skillUsage({ crowHome, botRows: rows, kitInstalled: true, knownThemes: new Set() });
  assert.equal(withKit.get("design-frontend")[0].voiceJobOnly, undefined, "with the kit every path loads it");
});
