/** Connect an in-process Workspace MCP server to a fake Nextcloud. Instant clock: sleeps advance a virtual now. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function connectWorkspace(fake, { clock } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ws-tools-"));
  mkdirSync(join(home, "bundles", "workspace"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"),
    "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n", { mode: 0o600 });
  process.env.CROW_HOME = home;
  mkdirSync(join(home, "data"), { recursive: true });
  process.env.CROW_DATA_DIR = join(home, "data");
  process.env.WORKSPACE_NC_INTERNAL_URL = fake.ncUrl;
  process.env.WORKSPACE_OO_INTERNAL_URL = fake.ooUrl;
  const virtual = clock || (() => { let t = 1_800_000_000_000; return { now: () => t, sleep: async (ms) => { t += ms; fake.advance?.(ms); } }; })();
  const { createWorkspaceServer } = await import("../../bundles/workspace/server/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWorkspaceServer({ clock: virtual });
  const client = new Client({ name: "ws-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse(r.content[0].text);
  };
  return { call, client, clock: virtual, home, close: () => client.close() };
}
