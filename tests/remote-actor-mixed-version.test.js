/**
 * Item 46 PR-B, E-M1 (mixed version): a NEW sender's gateway-signed voice call to an OLD receiver.
 *
 * bravo runs a tree from before PR-A (c8923fa2: no peer label, Workspace 0.4.0) with its own Workspace
 * add-on; alpha runs this checkout and signs its voice bot's tools/call. The old gateway knows nothing
 * of the remote-actor headers: the call still runs, and the comment reads "Crow" exactly as every peer
 * call did before PR-A. (The opposite direction, an old sender that never signs to a new receiver, is
 * E-F1 in tests/remote-actor-two-gateways.test.js.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Named, installWorkspace, pairInto, until, sha } from "./fixtures/peer-pair.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

/** Pre-PR-A main (#599). */
const PRE_PR_A_SHA = "c8923fa21ba43d98a510e34ab19c1e1bd9f5bb3d";
const FIX = join(import.meta.dirname, "fixtures", "workspace");
const OWNER_IP = { ip: "100.64.20.250" };
let A, B, old, fake;
const ownerToken = randomBytes(32).toString("hex");
const clients = [];

async function owner() {
  const c = new Client({ name: "remote-actor-mixed", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${await B.urlFor(OWNER_IP)}/tools/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } } }));
  clients.push(c);
  return c;
}
const body = (r) => JSON.parse(r.content[0].text);
const mod = (p) => JSON.stringify(new URL(`../${p}`, import.meta.url).href);

before(async () => {
  old = await oldTree(PRE_PR_A_SHA);
  fake = await startFakeNextcloud();
  fake.addFolder("S", { owner: "admin" });
  A = await new Named("alpha", "100.64.20.11").init();
  B = await new Named("bravo", "100.64.20.12", { repo: old.dir }).init();
  // The OLD tree's own Workspace add-on (installWorkspace runs it from inst.repo).
  installWorkspace(B, fake);
  B.sql("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('mcp_local_token_hash', ?)", [sha(ownerToken)]);
  await A.boot();
  const r = await pairInto(A, B);
  if (r.code !== 0) throw new Error(`pairing A into the old B failed: ${r.out}`);
  const ok = await until(async () => {
    try { return (await (await owner()).listTools()).tools.some((t) => t.name === "ws_docs_add_comment"); } catch { return false; }
  }, 60_000, 500);
  if (!ok) throw new Error(`Workspace add-on never connected on the old B\n${B.log.slice(-3000)}`);
});

after(async () => {
  for (const c of clients) { try { await c.close(); } catch { /* gone */ } }
  for (const i of [A, B]) { try { await i?.cleanup(); } catch { /* gone */ } }
  fake?.close();
  old?.cleanup();
});

test("E-M1: a new gateway's signed voice call to a pre-PR-A receiver runs and reads 'Crow'", async () => {
  assert.equal(JSON.parse(readFileSync(join(old.dir, "bundles", "workspace", "manifest.json"), "utf8")).version, "0.4.0",
    "the receiver really runs the old Workspace");
  fake.addFile("S/mixed.docx", readFileSync(join(FIX, "rich.docx")), { owner: "admin" });
  const url = await B.urlFor(A);
  // The real voice path on the new sender: buildRemoteVoiceContext signs with A's pair key for B.
  const code = `
    const { buildRemoteVoiceContext } = await import(${mod("servers/gateway/ai/remote-voice-tools.js")});
    const { createDbClient } = await import(${mod("servers/db.js")});
    const { defaultPairKey } = await import(${mod("servers/shared/sync-pair-binding.js")});
    const db = createDbClient();
    const ctx = await buildRemoteVoiceContext(db, { bot_id: "hank", display_name: "Hank", tools: { remote_mcp: [${JSON.stringify(`${B.id}::workspace`)}] } }, {
      readSettingFn: async () => JSON.stringify({ remote_invocation: true }),
      getPeerGatewayUrls: async () => new Map([[${JSON.stringify(B.id)}, ${JSON.stringify(url)}]]),
    });
    if (!ctx) { console.log("RESULT null"); process.exit(0); }
    const r = await ctx.callRemote("ws_docs_add_comment", { path: "S/mixed.docx", content: "from a new voice bot" });
    await ctx.close();
    console.log("RESULT " + JSON.stringify({ hasKey: !!defaultPairKey(${JSON.stringify(B.id)}), text: r.content[0].text }));
    process.exit(0);`;
  const r = await A.runAs(code);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `voice child failed: ${r.err.slice(-2000)}`);
  const out = JSON.parse(line.slice(7));
  assert.equal(out.hasKey, true, "the sender holds a pair key for B, so it signed");
  assert.doesNotMatch(r.err, /sending unsigned/, "the sender did not fall back to unsigned");
  const res = JSON.parse(out.text);
  assert.equal(res.success, true, JSON.stringify(res));
  const list = body(await (await owner()).callTool({ name: "ws_docs_list_comments", arguments: { path: "S/mixed.docx", include_resolved: true } }));
  assert.equal(list.data.comments.find((x) => x.id === res.data.comment_id)?.author, "Crow");
});
