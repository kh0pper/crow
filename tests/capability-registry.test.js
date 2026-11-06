import { test } from "node:test";
import assert from "node:assert/strict";
import { getLocalCatalog, canonicalForCategory } from "../servers/gateway/capability-registry.js";

const db = {
  async execute() {
    return { rows: [
      { bot_id: "a", display_name: "A", enabled: 1, project_id: null, definition: JSON.stringify({ models: { default: "m1" }, tools: { crow_mcp: ["crow-memory/x"] }, system_prompt: "SENTINEL_SECRET_LEAK" }) },
      { bot_id: "b", display_name: "B", enabled: 0, project_id: 3, definition: "{}" },
    ] };
  },
};

test("catalog includes core tools with canonical+category and a positive count", async () => {
  const cat = await getLocalCatalog(db, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self", instanceName: "Self" });
  const mem = cat.tools.find((t) => t.canonicalId === canonicalForCategory("memory"));
  assert.ok(mem, "memory core tool present");
  assert.equal(mem.category, "memory");
  assert.ok(mem.toolCount > 0);
});

test("catalog projects bots public-safe (no definition leak)", async () => {
  const cat = await getLocalCatalog(db, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self" });
  assert.equal(cat.bots.length, 2);
  assert.equal(cat.bots[0].model, "m1");
  assert.equal(cat.bots[0].tool_count, 1);
  assert.ok(!JSON.stringify(cat.bots).includes("definition"));
  assert.ok(!JSON.stringify(cat.bots).includes("SENTINEL_SECRET_LEAK"), "system_prompt must not leak");
  assert.equal(cat.instanceId, "self");
});

test("catalog reflects the exposure set on tool entries", async () => {
  // db stub: exposure setting returns ["crow-memory"]; bot query returns [].
  const exposingDb = {
    async execute({ sql }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/FROM dashboard_settings\b/.test(sql)) return { rows: [{ value: JSON.stringify(["crow-memory"]) }] };
      return { rows: [] }; // pi_bot_defs
    },
  };
  const cat = await getLocalCatalog(exposingDb, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self" });
  const mem = cat.tools.find((t) => t.canonicalId === canonicalForCategory("memory"));
  assert.equal(mem.exposed, true);
  const others = cat.tools.filter((t) => t.canonicalId !== "crow-memory");
  assert.ok(others.every((t) => t.exposed === false), "non-exposed tools are exposed:false");
});

// N1b-8 review round 1 (S2): `exposed` used to come from the all-peer list
// only, so a requesting peer's Bot Builder showed a granted tool as NOT
// exposed. Served to a verified peer, the catalog must mark a capability
// exposed when it is in the all-peer list OR that peer holds an active grant —
// and never show another peer's allowance.
test("catalog served to a verified peer marks its OWN grant exposed, and nobody else's", async () => {
  const now = Date.now();
  const prior = new Date(now - 120_000).toISOString();
  const grants = {
    "peer-a": {
      "crow-blog": { expires_at: null, granted_at: prior },                                    // active, until removed
      "crow-projects": { expires_at: new Date(now - 60_000).toISOString(), granted_at: prior }, // expired
    },
    "peer-b": { "crow-storage": { expires_at: null, granted_at: prior } },
  };
  const stub = {
    async execute({ sql, args }) {
      const key = args?.[0];
      if (/dashboard_settings_overrides/.test(sql)) {
        if (key === "remote_exposed_tools_by_peer") return { rows: [{ value: JSON.stringify(grants) }] };
        return { rows: [] };
      }
      if (/FROM dashboard_settings\b/.test(sql)) {
        if (key === "remote_exposed_tools") return { rows: [{ value: JSON.stringify(["crow-memory"]) }] };
        return { rows: [] };
      }
      return { rows: [] }; // pi_bot_defs
    },
  };
  const exposedFor = async (peerId) => {
    const cat = await getLocalCatalog(stub, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self", peerId });
    return Object.fromEntries(cat.tools.map((t) => [t.canonicalId, t.exposed]));
  };

  const a = await exposedFor("peer-a");
  assert.equal(a["crow-memory"], true, "the all-peer list applies to every peer");
  assert.equal(a["crow-blog"], true, "peer-a's own one-device grant is exposed to peer-a");
  assert.equal(a["crow-projects"], false, "an expired grant is not exposed");
  assert.equal(a["crow-storage"], false, "peer-b's grant is invisible to peer-a");

  const b = await exposedFor("peer-b");
  assert.equal(b["crow-memory"], true);
  assert.equal(b["crow-storage"], true, "peer-b sees its own grant");
  assert.equal(b["crow-blog"], false, "peer-a's grant is invisible to peer-b");

  // No verified peer (the local/settings view): the all-peer list only.
  const local = await getLocalCatalog(stub, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self" });
  const exposedIds = local.tools.filter((t) => t.exposed).map((t) => t.canonicalId);
  assert.deepEqual(exposedIds, ["crow-memory"], "no peer's grants leak into a peerless catalog");
});

// Skills panel option C, PR 2: peers are not advertised a skill this Crow
// switched off (it would not load).
test("catalog skills leave out a skill switched off on this instance", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { setSkillOff } = await import("../servers/shared/skill-state.js");
  const home = mkdtempSync(join(tmpdir(), "cap-skill-off-"));
  try {
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "kept-on.md"), "# On\n");
    writeFileSync(join(home, "skills", "switched-off.md"), "# Off\n");
    setSkillOff(home, "switched-off", true);
    setSkillOff(home, "memory-management", true);
    const names = (await getLocalCatalog(db, { crowHome: home, instanceId: "self" })).skills.map((s) => s.name);
    assert.ok(names.includes("kept-on"));
    assert.ok(!names.includes("switched-off"));
    assert.ok(!names.includes("memory-management"), "a built-in switched off is left out too");
    assert.ok(names.includes("tutoring"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
