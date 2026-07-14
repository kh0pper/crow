/**
 * Item 5 PR1 (spec §D2): templates are data with apply-time filtering — a
 * template can never make creation fail, never overlays permission policy,
 * and every card string ships EN+ES.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOT_TEMPLATES, getTemplate, applyTemplate, availableMcpSet,
} from "../servers/gateway/dashboard/panels/bot-builder/templates.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

test("registry shape: five templates, valid channel types, i18n en+es for every card string", () => {
  assert.deepEqual(BOT_TEMPLATES.map((t) => t.id),
    ["personal-assistant", "email-responder", "discord-qa", "project-manager", "blank"]);
  for (const tp of BOT_TEMPLATES) {
    for (const part of ["title", "desc", "needs"]) {
      const key = `botbuilder.tpl_${tp.id}_${part}`;
      const entry = translations[key];
      assert.ok(entry && entry.en && entry.es, `${key} must exist with non-empty en+es`);
    }
    assert.ok(["crow-messages", "gmail", "discord", "none"].includes(tp.gwType), `${tp.id} gwType`);
    assert.ok(!("permission_policy" in tp), `${tp.id} must not overlay permission policy (spec §D2)`);
  }
});

test("getTemplate: known id, unknown id", () => {
  assert.equal(getTemplate("blank").id, "blank");
  assert.equal(getTemplate("nope"), null);
  assert.equal(getTemplate(undefined), null);
});

function freshDef() {
  // Mirrors the defaultDefinition() fields applyTemplate touches.
  return {
    tools: { pi_builtin: ["read"], crow_mcp: ["crow-tasks/tasks_list"], pi_extensions: [], skills: [] },
    skills: [],
    system_prompt: "stock prompt",
  };
}

test("applyTemplate: filters tool additions against the available set (drop-silently)", () => {
  const tpl = getTemplate("personal-assistant");
  const available = new Set(["crow-memory/crow_search_memories"]); // only 1 of 3 available
  const def = applyTemplate(freshDef(), tpl, { availableMcp: available, availableSkills: [] });
  assert.deepEqual(def.tools.crow_mcp, ["crow-tasks/tasks_list", "crow-memory/crow_search_memories"]);
  assert.equal(def.system_prompt.includes("personal assistant"), true, "prompt overlaid");
});

test("applyTemplate: empty available set (fresh install, probe {_error}) keeps only the baked preset", () => {
  const tpl = getTemplate("personal-assistant");
  const def = applyTemplate(freshDef(), tpl, { availableMcp: new Set(), availableSkills: [] });
  assert.deepEqual(def.tools.crow_mcp, ["crow-tasks/tasks_list"], "no template additions on empty probe");
});

test("applyTemplate: blank keeps stock prompt and leaves tracker untouched (quick-create parity)", () => {
  const def = applyTemplate(freshDef(), getTemplate("blank"), { availableMcp: new Set(), availableSkills: [] });
  assert.equal(def.system_prompt, "stock prompt");
  assert.ok(!("tracker_config" in def), "blank must not write tracker_config");
});

test("applyTemplate: project-manager sets kanban tracker; assistants set none", () => {
  const pm = applyTemplate(freshDef(), getTemplate("project-manager"), { availableMcp: new Set(), availableSkills: [] });
  assert.equal(pm.tracker_config.type, "kanban");
  const pa = applyTemplate(freshDef(), getTemplate("personal-assistant"), { availableMcp: new Set(), availableSkills: [] });
  assert.equal(pa.tracker_config.type, "none");
});

test("availableMcpSet: {_error} and empty probes yield the empty set; ok servers map to server/tool", () => {
  assert.equal(availableMcpSet({ _error: "no canonical mcp.json" }).size, 0);
  assert.equal(availableMcpSet(null).size, 0);
  const set = availableMcpSet({
    "crow-memory": { ok: true, tools: [{ name: "crow_store_memory" }] },
    "broken": { ok: false, error: "x" },
  });
  assert.deepEqual([...set], ["crow-memory/crow_store_memory"]);
});

test("no maintainer-specific content in any template (fix-the-product rule)", () => {
  const json = JSON.stringify(BOT_TEMPLATES);
  for (const bad of ["kevin", "kh0pp", "maestro.press", "crow-local/qwen"]) {
    assert.ok(!json.toLowerCase().includes(bad), `templates must not contain '${bad}'`);
  }
});
