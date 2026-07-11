// tests/extensions-collections.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCollections, getCollection, COLLECTIONS_PATH } from "../servers/gateway/dashboard/panels/extensions/collections.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = JSON.parse(readFileSync(join(REPO, "registry/add-ons.json"), "utf8"))["add-ons"];
const byId = new Map(REGISTRY.map((a) => [a.id, a]));
const manifestOf = (id) =>
  JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
const hasCompose = (id) => existsSync(join(REPO, "bundles", id, "docker-compose.yml"));

test("loader returns the four collections with well-formed shape", () => {
  const cols = loadCollections();
  assert.deepEqual(cols.map((c) => c.id).sort(), ["development", "education", "home-server", "research"]);
  for (const c of cols) {
    assert.ok(c.name && c.description && c.icon, `${c.id} missing display fields`);
    assert.ok(Array.isArray(c.members) && c.members.length > 0, `${c.id} has no members`);
    for (const m of c.members) {
      assert.ok(["deploys", "connects", "builtin"].includes(m.kind), `${c.id}/${m.id} bad kind '${m.kind}'`);
    }
  }
});

test("HARD RULE: every member exists in the official registry and on disk", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      assert.ok(byId.has(m.id), `${c.id}: '${m.id}' is not in registry/add-ons.json`);
      assert.ok(existsSync(join(REPO, "bundles", m.id, "manifest.json")), `${c.id}: bundles/${m.id} has no manifest`);
    }
  }
});

test("HARD RULE: no member is privileged, consent_required, or GPU-gated", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      const man = manifestOf(m.id);
      assert.notEqual(man.privileged, true, `${c.id}/${m.id} is privileged — one-click must not bypass the consent gate`);
      assert.notEqual(man.consent_required, true, `${c.id}/${m.id} is consent_required — one-click must not bypass the consent gate`);
      assert.ok(!man.requires?.gpu, `${c.id}/${m.id} requires a GPU — host-specific, not collection material`);
      assert.ok(!man.requires?.min_vram_gb, `${c.id}/${m.id} requires VRAM — host-specific`);
    }
  }
});

test("HARD RULE: no member's compose file uses host networking or a docker socket (install would be refused)", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      if (!hasCompose(m.id)) continue;
      const compose = readFileSync(join(REPO, "bundles", m.id, "docker-compose.yml"), "utf8");
      assert.ok(!/network_mode:\s*["']?host/.test(compose), `${c.id}/${m.id} uses host networking — validateComposeFile refuses it without privileged+consent`);
      assert.ok(!/\/var\/run\/docker\.sock/.test(compose), `${c.id}/${m.id} mounts the docker socket — refused without consent_required`);
    }
  }
});

test("HARD RULE: dependency closure + topological order", () => {
  for (const c of loadCollections()) {
    const seen = new Set();
    for (const m of c.members) {
      const deps = manifestOf(m.id).requires?.bundles || [];
      for (const d of deps) {
        assert.ok(c.members.some((x) => x.id === d), `${c.id}/${m.id} requires '${d}' which is not in the collection`);
        assert.ok(seen.has(d), `${c.id}: '${d}' must be ordered BEFORE its dependent '${m.id}'`);
      }
      seen.add(m.id);
    }
  }
});

test("HARD RULE: kind matches reality; connects members declare what you'll need", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      if (hasCompose(m.id)) {
        assert.equal(m.kind, "deploys", `${c.id}/${m.id} ships a compose file → kind must be 'deploys'`);
      } else {
        assert.notEqual(m.kind, "deploys", `${c.id}/${m.id} has no compose file → kind cannot be 'deploys'`);
      }
      if (m.kind === "connects") {
        assert.ok(m.you_need && m.you_need.length > 0, `${c.id}/${m.id} is 'connects' → must declare you_need (an external service the user must already run)`);
      }
    }
  }
});

test("loader is crash-proof: missing file → [], corrupt file → []", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowcol-"));
  assert.deepEqual(loadCollections(join(dir, "nope.json")), []);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ this is not json");
  assert.deepEqual(loadCollections(bad), []);
});

test("getCollection returns a collection by id, null for unknown", () => {
  assert.equal(getCollection("home-server").id, "home-server");
  assert.equal(getCollection("does-not-exist"), null);
});

test("COLLECTIONS_PATH points at the real registry file", () => {
  assert.ok(existsSync(COLLECTIONS_PATH), "registry/collections.json must exist");
});
