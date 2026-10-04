import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let B, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpaddons-"));
  process.env.CROW_HOME = dir;
  B = await import("../servers/gateway/routes/bundles.js");
});

const manifest = {
  id: "workspace",
  server: { command: "node", args: ["server/index.js"], envKeys: ["PUBLIC_KEY_LISTED"], configureEnv: "envKeys-only" },
  env_vars: [
    { name: "WORKSPACE_ADMIN_PASSWORD", secret: true },
    { name: "WORKSPACE_DB_PASSWORD", secret: true, generate: "secret" },
    { name: "PUBLIC_KEY_LISTED", secret: true },
    { name: "WORKSPACE_PUBLIC_HOST" },
  ],
};

test("Configure never copies secret or generated keys into mcp-addons.json", () => {
  const p = join(dir, "mcp-addons.json");
  writeFileSync(p, JSON.stringify({ workspace: { command: "node", args: ["server/index.js"] } }));
  const wrote = B.applyEnvToMcpAddons("workspace", {
    WORKSPACE_ADMIN_PASSWORD: "hunter2-hunter2", WORKSPACE_DB_PASSWORD: "dbpw", PUBLIC_KEY_LISTED: "ok-listed", WORKSPACE_PUBLIC_HOST: "crow.example.ts.net",
  }, p, manifest);
  assert.equal(wrote, true);
  const text = readFileSync(p, "utf8");
  assert.doesNotMatch(text, /hunter2|dbpw/);
  const env = JSON.parse(text).workspace.env;
  assert.deepEqual(env, { PUBLIC_KEY_LISTED: "ok-listed", WORKSPACE_PUBLIC_HOST: "crow.example.ts.net" });
});

test("bundles that did not opt in (kodi) still receive their secrets on Configure (regression)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const kodi = JSON.parse(rf(join(import.meta.dirname, "..", "bundles", "kodi", "manifest.json"), "utf8"));
  const p = join(dir, "mcp-addons-kodi.json");
  writeFileSync(p, JSON.stringify({ kodi: { command: "node", args: ["server/index.js"] } }));
  B.applyEnvToMcpAddons("kodi", { KODI_PASSWORD: "k-secret" }, p, kodi);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).kodi.env.KODI_PASSWORD, "k-secret");
});

test("without a manifest the old behaviour is unchanged (back-compat)", () => {
  const p = join(dir, "mcp-addons-2.json");
  writeFileSync(p, JSON.stringify({ x: { command: "node" } }));
  B.applyEnvToMcpAddons("x", { A: "1" }, p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).x.env, { A: "1" });
});

test("mcpAddonEntryFor mirrors the install shape", () => {
  assert.deepEqual(B.mcpAddonEntryFor({ server: { command: "node", args: ["server/index.js"] }, env_vars: [{ name: "P", default: "8456" }] }),
    { command: "node", args: ["server/index.js"], env: { P: "8456" } });
  assert.deepEqual(B.mcpAddonEntryFor({ server: { command: "node" } }), { command: "node", args: [] });
});
