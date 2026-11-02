/**
 * Review finding 4: a connection's redacted child stderr (Settings -> Integrations -> Advanced) is
 * shown to the owner only. The gate is the owner's own turn, the same check the For You page and
 * the phone's call approvals use (servers/gateway/dashboard/local-session.js): a local password
 * session, from ANOTHER machine. So an 'onhost' session (a login minted on this box), an SSO
 * session a paired instance minted, the owner's session replayed from this box, or a request with
 * no client address at all gets no int-stderr block and none of its lines.
 *
 * A real child, so the ring buffer has lines to hide: tests/fixtures/echo-mcp-server.mjs writes the
 * connection's token to stderr (children.js redacts and keeps the last 50 lines). Scratch Crow home
 * and data dir built by init-db; never ~/.crow, never a real service.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";
import { fromLaptop } from "./helpers/off-box.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "echo-mcp-server.mjs");
const HOME = mkdtempSync(join(tmpdir(), "crow-svcstderr-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-svcstderr-data-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;   // the scratch data dir's own crow.db, never the suite runner's
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_SERVICES_UI;   // the section's Services surface (the one that can show stderr)
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const C = await import("../servers/gateway/services/children.js");
const SENS = await import("../servers/shared/service-sensitivity.js");
const SC = await import("../servers/shared/service-connections.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");
const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
const section = (await import("../servers/gateway/dashboard/settings/sections/integrations.js")).default;

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const TOKEN = "test-token-stderr-3";

// The scratch install: github installed, its add-on entry pointing at the fake child, whose folder
// turns on the stderr lines.
const SERVICE = serviceById("github");
mkdirSync(join(HOME, "secrets"), { recursive: true });
mkdirSync(join(HOME, "bundles", SERVICE.bundleId), { recursive: true });
writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: SERVICE.bundleId, type: "mcp-server", version: "1.0.0" }]));
writeFileSync(join(HOME, "bundles", SERVICE.bundleId, "echo-control.json"), JSON.stringify({ stderr: true }));
writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({ [SERVICE.bundleId]: { command: "node", args: [FIXTURE], env: {} } }), { mode: 0o600 });

const db = createDbClient();
let conn;

// Sessions the gateway can mint, as their scopes say who they are: a local password login, one made
// on this box, and one a paired instance's sign-in made.
const SCOPES = {
  "owner-sess": "dashboard",
  "onhost-sess": "dashboard onhost",
  "sso-sess": "dashboard sso src:instance-peer",
};
{
  const pid = Number((await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES ('spring', 'Spring') RETURNING id" })).rows[0].id);
  const key = await ensureWriteKey(db, { crowHome: HOME });
  conn = await SC.createConnection(db, {
    projectId: pid, serviceId: SERVICE.id, accountLabel: "Main",
    secrets: { [GH]: TOKEN }, testedAt: new Date(),
  }, { key });
  // As the owner's connect route records it: the binding and its fingerprints.
  SENS.recordConnectionBinding(conn, { crowHome: HOME, service: SERVICE, values: { config: conn.config, secrets: { [GH]: TOKEN } } });
  for (const [tok, scopes] of Object.entries(SCOPES)) {
    await db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, datetime('now', '+1 day'))",
      args: [hashToken(tok), scopes],
    });
  }
  // Start the child and let its stderr arrive: the ring buffer is filled as the lines are read.
  const { client } = await C.ensureChild(db, conn.uuid, { crowHome: HOME });
  await client.callTool({ name: "whoami", arguments: {} });
  for (let i = 0; i < 60 && C.childStderr(conn.uuid).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

after(async () => {
  await C.stopAllChildren();
  try { db.close(); } catch { /* closed */ }
  for (const d of [HOME, DATA]) rmScratch(d);
});

const render = (req) => section.render({ req, db, lang: "en" });

test("a connection's stderr block shows to the owner's off-box session only", async () => {
  assert.ok(C.childStderr(conn.uuid).length > 0, "the fake child wrote stderr lines");

  const owner = await render(fromLaptop({ dashboardSession: "owner-sess" }));
  assert.ok(owner.includes(`data-int-conn="${conn.uuid}"`), "the connection row renders");
  assert.ok(owner.includes('class="int-stderr"'), "the off-box owner sees the stderr block");
  assert.ok(owner.includes("[redacted]"), "with the connection's values redacted on the way in");
  assert.ok(!owner.includes(TOKEN), "never the token itself");

  const others = [
    ["an onhost session", fromLaptop({ dashboardSession: "onhost-sess" })],
    ["an SSO session", fromLaptop({ dashboardSession: "sso-sess" })],
    ["the owner's session replayed from this box", { dashboardSession: "owner-sess", socket: { remoteAddress: "127.0.0.1" } }],
    ["a request with no determinable client address", { dashboardSession: "owner-sess" }],
  ];
  for (const [label, req] of others) {
    const html = await render(req);
    assert.ok(!html.includes("int-stderr"), `${label}: no stderr block`);
    assert.ok(!html.includes("[redacted]"), `${label}: no line of it`);
    assert.ok(!html.includes(TOKEN), `${label}: never the token`);
    assert.ok(html.includes(`data-int-conn="${conn.uuid}"`), `${label}: the row itself still renders`);
  }
});
