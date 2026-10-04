import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let C, home;
before(async () => {
  home = mkdtempSync(join(tmpdir(), "ws-config-"));
  process.env.CROW_HOME = home;
  C = await import("../bundles/workspace/server/config.js");
});
const writeEnv = (text) => { mkdirSync(join(home, "bundles", "workspace"), { recursive: true }); writeFileSync(join(home, "bundles", "workspace", ".env"), text, { mode: 0o600 }); };

test("not_ready until bootstrap finished and the app password exists", () => {
  writeEnv("WORKSPACE_PUBLIC_HOST=crow.example.ts.net\n");
  assert.throws(() => C.getConfig(), (e) => e.code === "not_ready" && /bootstrap\.sh/.test(e.message));
});

test("reads quoted values through the bundle codec and re-reads on change", async () => {
  writeEnv("WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.example.ts.net\nWORKSPACE_BOT_APP_PASSWORD='abc def$x'\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt1\n");
  const c = C.getConfig();
  assert.equal(c.user, "crow-bot");
  assert.equal(c.appPassword, "abc def$x");
  assert.equal(c.webBase, "https://crow.example.ts.net:8456");
  assert.equal(Object.isFrozen(c), true);
  await new Promise((r) => setTimeout(r, 20));
  writeEnv("WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.example.ts.net\nWORKSPACE_BOT_APP_PASSWORD=second\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt1\n");
  assert.equal(C.getConfig().appPassword, "second");
});

test("redact removes every secret occurrence", () => {
  const c = C.getConfig();
  assert.equal(C.redact("x second y jwt1 z second", c), "x [redacted] y [redacted] z [redacted]");
});

test("handler maps WsError and redacts unexpected errors", async () => {
  const { handler, WsError } = await import("../bundles/workspace/server/result.js");
  const r1 = await handler(async () => { throw new WsError("not_found", "nope", { a: 1 }); })({});
  assert.deepEqual(JSON.parse(r1.content[0].text), { success: false, code: "not_found", error: "nope", data: { a: 1 } });
  assert.equal(r1.isError, true);
  const r2 = await handler(async () => { throw new TypeError("boom second"); }, { redactWith: () => C.getConfig() })({});
  assert.equal(JSON.parse(r2.content[0].text).error, "Unexpected error: TypeError: boom [redacted]");
  const r3 = await handler(async () => ({ v: 1 }))({});
  assert.deepEqual(JSON.parse(r3.content[0].text), { success: true, data: { v: 1 } });
});

test("installed copy (no CROW_APP_ROOT) finds the repo via ~/crow and answers tools/list (review I11)", async () => {
  const repo = join(import.meta.dirname, "..");
  const tmp = mkdtempSync(join(tmpdir(), "ws-spawn-"));
  const fakeHome = join(tmp, "home");
  mkdirSync(fakeHome);
  symlinkSync(repo, join(fakeHome, "crow"));
  const copy = join(tmp, "installed", "workspace");
  cpSync(join(repo, "bundles", "workspace"), copy, { recursive: true });
  // the installed copy resolves its bare imports from the bundle's own node_modules or the repo's
  if (!existsSync(join(copy, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(copy, "node_modules"));
  const env = { ...process.env, HOME: fakeHome, CROW_HOME: join(tmp, "crowhome") };
  delete env.CROW_APP_ROOT;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["server/index.js"], cwd: copy, env });
  const client = new Client({ name: "t", version: "0" }, {});
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "crow-workspace"); // initialize answered => app root resolved, imports loaded
    // McpServer registers tools/list only once the first tool exists (Task 4); until then -32601 is the correct answer.
    try { assert.ok(Array.isArray((await client.listTools()).tools)); }
    catch (e) { assert.equal(e.code, -32601); }
  } finally { await client.close(); }
});
