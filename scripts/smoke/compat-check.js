#!/usr/bin/env node
/**
 * Phase 4 smoke: compat() on known-good and known-broken (role, provider)
 * pairs. Exit 0 on pass, non-zero on fail.
 */

import { compat } from "../../servers/orchestrator/compat.js";
import { roleShape, listAllRoles } from "../../servers/orchestrator/role-shape.js";
import { providerCapabilities } from "../../servers/orchestrator/provider-capabilities.js";

let failed = 0;
function check(desc, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failed++; console.error(`FAIL: ${desc} — expected ${expected}, got ${actual}`); }
  else { console.log(`  ok: ${desc}`); }
}
function containsCode(arr, code) { return Array.isArray(arr) && arr.some((e) => e.code === code); }

// --- role-shape sanity ---
const roles = listAllRoles();
check("12 preset-agent rows", roles.length, 12);

const viewer = roleShape("vision_team", "viewer");
check("vision_team.viewer.needs_vision", viewer.needs_vision, true);

const synth = roleShape("vision_team", "synthesizer");
check("vision_team.synthesizer.needs_vision stays false", synth.needs_vision, false);

const researcher = roleShape("research", "researcher");
check("research.researcher tools count", researcher.tools_count, 18);
check("research.researcher needs_tools", researcher.needs_tools, true);

// --- provider-capabilities ---
const embed = providerCapabilities({
  id: "grackle-embed",
  models: [{ id: "Qwen3-Embedding-0.6B-embed" }],
});
check("grackle-embed tagged embed", embed.tags.includes("embed"), true);
check("grackle-embed not chat", embed.tags.includes("chat"), false);

const vision = providerCapabilities({
  id: "grackle-vision",
  models: [{ id: "glm-4.5v" }],
});
check("grackle-vision tagged vision", vision.tags.includes("vision"), true);

const cloudOpenai = providerCapabilities({
  id: "cloud-openai-xxx",
  provider_type: "openai",
  models: [{ id: "gpt-4o-mini" }],
});
check("cloud-openai tagged chat", cloudOpenai.tags.includes("chat"), true);

const swapCoder = providerCapabilities({
  id: "crow-swap-coder",
  models: [{ id: "qwen3-coder", mutexGroup: "8003-swap" }],
});
check("crow-swap-coder mutex group", swapCoder.mutex_groups.includes("8003-swap"), true);

// --- compat: known-good ---
const good = compat(
  { preset_name: "research", agent_name: "researcher" },
  { id: "crow-dispatch", host: "local", models: [{ id: "qwen3-8b" }], disabled: 0 },
);
check("good pair is ok", good.ok, true);
check("good pair no blockers", good.blockers.length, 0);
check("good pair no warnings", good.warnings.length, 0);

// --- compat: capability mismatch (embed on chat) ---
const bad1 = compat(
  { preset_name: "research", agent_name: "researcher" },
  { id: "grackle-embed", host: "grackle-xxx", models: [{ id: "Qwen3-Embedding-0.6B-embed" }], disabled: 0 },
);
check("embed-on-chat blocked", bad1.ok, false);
check("embed-on-chat has capability_mismatch", containsCode(bad1.blockers, "capability_mismatch"), true);

// --- compat: vision-required role with non-vision provider ---
const bad2 = compat(
  { preset_name: "vision_team", agent_name: "viewer" },
  { id: "crow-chat", host: "local", provider_type: null, models: [{ id: "qwen3-32b" }], disabled: 0 },
);
check("vision role with non-vision blocked", bad2.ok, false);
check("vision_required emitted", containsCode(bad2.blockers, "vision_required"), true);

// --- compat: disabled provider ---
const bad3 = compat(
  { preset_name: "research", agent_name: "researcher" },
  { id: "crow-dispatch", host: "local", models: [{ id: "qwen3-8b" }], disabled: 1 },
);
check("disabled provider blocked", bad3.ok, false);
check("provider_disabled emitted", containsCode(bad3.blockers, "provider_disabled"), true);

// --- compat: mutex collision within a preset ---
const mutex = compat(
  { preset_name: "code_team", agent_name: "coder" },
  { id: "crow-swap-coder", host: "local", models: [{ id: "qwen3-coder", mutexGroup: "8003-swap" }], disabled: 0 },
  {
    otherAssignments: [
      {
        agent_name: "researcher",
        provider: { id: "crow-swap-deep", host: "local", models: [{ id: "glm-4.5-air", mutexGroup: "8003-swap" }], disabled: 0 },
      },
    ],
  },
);
check("mutex collision emits warning", containsCode(mutex.warnings, "mutex_collision"), true);
check("mutex collision still ok", mutex.ok, true);

// --- compat: cloud on scheduled pipeline (research preset used by daily-summary + research-digest) ---
const sched = compat(
  { preset_name: "research", agent_name: "writer" },
  {
    id: "cloud-openai-gpt4o",
    host: "cloud",
    provider_type: "openai",
    models: [{ id: "gpt-4o" }],
    disabled: 0,
  },
);
check("cloud-on-schedule warning emitted", containsCode(sched.warnings, "cloud_on_schedule"), true);

// --- compat: cloud on tool-heavy role ---
const heavy = compat(
  { preset_name: "research", agent_name: "researcher" },
  {
    id: "cloud-openai-gpt4o",
    host: "cloud",
    provider_type: "openai",
    models: [{ id: "gpt-4o" }],
    disabled: 0,
  },
);
check("cloud-tool-heavy warning emitted", containsCode(heavy.warnings, "cloud_tool_heavy"), true);

console.log("");
if (failed === 0) { console.log(`PASS: all compat checks green`); process.exit(0); }
console.error(`FAIL: ${failed} check(s) failed`);
process.exit(1);
