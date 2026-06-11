import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSkill } from "../scripts/pi-bots/skill_resolver.mjs";
import { normalizeSkillName } from "../scripts/pi-bots/skill_proposals.mjs";

test("resolveSkill rejects traversal and separator names", () => {
  assert.equal(resolveSkill("../../etc/passwd"), null);
  assert.equal(resolveSkill("/etc/passwd"), null);
  assert.equal(resolveSkill("..\\..\\x"), null);
  assert.equal(resolveSkill("foo/../bar"), null);
});

test("valid kebab names pass validation", () => {
  // resolution depends on env skill dirs; what matters is the validator accepts valid names
  assert.equal(normalizeSkillName("memory-management"), "memory-management");
});

test("normalizeSkillName accepts kebab and strips .md", () => {
  assert.equal(normalizeSkillName("My-Skill.md"), "my-skill");
  assert.equal(normalizeSkillName("emoji💥"), null);
});
