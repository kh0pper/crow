import { test } from "node:test";
import assert from "node:assert/strict";
import { redactDefForPeer, applyPeerPatch, PATCHABLE_FIELDS, GATEWAY_SECRET_KEYS } from "../servers/gateway/bot-federation.js";
import gateways from "../scripts/pi-bots/gateways/index.mjs";

function sampleDef() {
  return {
    engine: "pi",
    models: { default: "crow-local/qwen3.6-35b-a3b" },
    system_prompt: "be helpful",
    tools: { pi_builtin: ["read"], crow_mcp: ["crow-tasks/tasks_list"], skills: [], pi_extensions: [], remote_mcp: [] },
    gateways: [
      { type: "discord", token: "SECRET-DISCORD", channel_ids: ["123"], allowlist: ["u#1"] },
      { type: "slack", bot_token: "xoxb-SECRET", app_token: "xapp-SECRET", channel_ids: ["C1"] },
      { type: "gmail", address: "bot+scout@example.com", allowlist: ["a@b.com"] },
    ],
    permission_policy: { bash: "deny", external_send: "draft_only", confirm: [] },
    triggers: { gateway: true, cron: "" },
    spawn_env: { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local", OPENAI_API_KEY: "sk-LEAK" },
    session_dir: "/home/alex/.crow/pi-bots/scout",
  };
}

test("redactDefForPeer: no raw secret survives serialization", () => {
  const red = redactDefForPeer(sampleDef());
  const json = JSON.stringify(red);
  for (const leak of ["SECRET-DISCORD", "xoxb-SECRET", "xapp-SECRET", "sk-LEAK"]) {
    assert.equal(json.includes(leak), false, `leaked ${leak}`);
  }
});

test("redactDefForPeer: secret fields become {__redacted:true,set:<bool>}", () => {
  const red = redactDefForPeer(sampleDef());
  assert.deepEqual(red.gateways[0].token, { __redacted: true, set: true });
  assert.deepEqual(red.gateways[1].bot_token, { __redacted: true, set: true });
  assert.deepEqual(red.gateways[1].app_token, { __redacted: true, set: true });
  assert.deepEqual(red.spawn_env.OPENAI_API_KEY, { __redacted: true, set: true });
});

test("redactDefForPeer: non-secret fields preserved verbatim", () => {
  const red = redactDefForPeer(sampleDef());
  assert.equal(red.system_prompt, "be helpful");
  assert.equal(red.models.default, "crow-local/qwen3.6-35b-a3b");
  assert.deepEqual(red.tools.crow_mcp, ["crow-tasks/tasks_list"]);
  assert.equal(red.gateways[0].type, "discord");
  assert.deepEqual(red.gateways[0].channel_ids, ["123"]);
  assert.equal(red.gateways[2].address, "bot+scout@example.com");
  assert.equal(red.spawn_env.PI_PROVIDER, "crow-local");
});

test("redactDefForPeer: does not mutate the input", () => {
  const def = sampleDef();
  redactDefForPeer(def);
  assert.equal(def.gateways[0].token, "SECRET-DISCORD");
});

test("applyPeerPatch: merges allowlisted non-secret fields by dotted path", () => {
  const merged = applyPeerPatch(sampleDef(), {
    "system_prompt": "new prompt",
    "models.default": "crow-local/other",
    "tools.skills": ["research"],
    "display_name": "Scout 2",
    "enabled": 1,
  });
  assert.equal(merged.system_prompt, "new prompt");
  assert.equal(merged.models.default, "crow-local/other");
  assert.deepEqual(merged.skills, ["research"], "an older peer's tools.skills patch lands on def.skills, the one store the runtime reads");
  assert.deepEqual(merged.tools.skills, [], "the retired mirror is left as it was");
  assert.deepEqual(merged.tools.crow_mcp, ["crow-tasks/tasks_list"]);
  assert.equal(merged.gateways[0].token, "SECRET-DISCORD");
});

test("applyPeerPatch: an older peer echoing the stale tools.skills mirror never drops a skill approved since", () => {
  const def = { ...sampleDef(), skills: ["a", "approved-later"], tools: { ...sampleDef().tools, skills: ["a"] } };
  // the old peer editor re-sends the unchanged mirror while changing only the model
  const merged = applyPeerPatch(def, { "models.default": "m2", "tools.skills": ["a"] });
  assert.deepEqual(merged.skills, ["a", "approved-later"]);
  // a real edit through the old editor: removes "a", adds "b" — applied as a diff
  const merged2 = applyPeerPatch(def, { "tools.skills": ["b"] });
  assert.deepEqual(merged2.skills, ["approved-later", "b"]);
  // a def that only has the old mirror (no skills yet) starts from the mirror
  const old = { ...sampleDef(), tools: { ...sampleDef().tools, skills: ["x"] } };
  delete old.skills;
  assert.deepEqual(applyPeerPatch(old, { "tools.skills": ["x", "y"] }).skills, ["x", "y"]);
});

test("applyPeerPatch: rejects a non-allowlisted path", () => {
  assert.throws(() => applyPeerPatch(sampleDef(), { "session_dir": "/evil" }), /not patchable/i);
});

test("applyPeerPatch: rejects any gateway-credential / secret path", () => {
  assert.throws(() => applyPeerPatch(sampleDef(), { "gateways": [] }), /not patchable/i);
  assert.throws(() => applyPeerPatch(sampleDef(), { "spawn_env.OPENAI_API_KEY": "x" }), /not patchable/i);
});

test("applyPeerPatch: does not mutate the input def", () => {
  const def = sampleDef();
  applyPeerPatch(def, { "system_prompt": "x" });
  assert.equal(def.system_prompt, "be helpful");
});

test("PATCHABLE_FIELDS includes the locked non-secret edit surface only", () => {
  for (const f of ["display_name", "system_prompt", "models.default", "tools.skills", "tools.crow_mcp", "permission_policy.external_send", "triggers.cron", "enabled"]) {
    assert.ok(PATCHABLE_FIELDS.some((p) => p === f || (p.endsWith(".*") && f.startsWith(p.slice(0, -1)))), `missing ${f}`);
  }
});

test("applyPeerPatch: rejects prototype-pollution paths and does NOT pollute", () => {
  for (const bad of ["permission_policy.__proto__.polluted", "models.__proto__.evil", "tracker_config.constructor.x", "triggers.prototype.y"]) {
    assert.throws(() => applyPeerPatch({}, { [bad]: "yes" }), /not patchable/i, `should reject ${bad}`);
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).evil, undefined);
});

test("applyPeerPatch: rejects a bare parent and near-miss siblings", () => {
  assert.throws(() => applyPeerPatch({}, { "models": {} }), /not patchable/i);
  assert.throws(() => applyPeerPatch({}, { "triggersX": 1 }), /not patchable/i);
  assert.throws(() => applyPeerPatch({}, { "models_evil": 1 }), /not patchable/i);
});

test("redaction covers every secret gateway field declared in the registry (drift guard)", () => {
  const registrySecrets = new Set();
  for (const cap of gateways.capabilitiesForUI()) {
    for (const f of (cap.configFields || [])) if (f.secret) registrySecrets.add(f.key);
  }
  assert.ok(registrySecrets.size > 0, "expected the registry to declare at least one secret field");
  for (const k of registrySecrets) {
    assert.ok(GATEWAY_SECRET_KEYS.has(k), `registry secret field "${k}" not in GATEWAY_SECRET_KEYS — redaction would leak it`);
  }
});
