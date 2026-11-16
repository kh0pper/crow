/**
 * The owner-mount regex in scripts/pi-bots/mcp_writer.mjs has to cover EVERY
 * mountMcpServer prefix the gateway boot files publish without a signed actor.
 *
 * A bot handed one of those mounts would act with a gateway token's authority
 * (routes/mcp.js treats a valid local MCP token as the owner), so the writer
 * must refuse such a url block. This test derives the prefixes from the boot
 * sources themselves: a new unsigned mount added there fails here until the
 * regex learns it. The signed mounts (/board, /secrets, /phone, /artifacts)
 * verify a per-boot actor signature and must stay OUT of the regex.
 *
 * The gateway's root mount ("") is not listed: the loopback rule in
 * isOwnerProjectUrl already covers it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOwnerProjectUrl } from "../scripts/pi-bots/mcp_writer.mjs";

const REPO = join(import.meta.dirname, "..");
const BOOT_SOURCES = ["servers/gateway/boot/mcp-mounts.js", "servers/gateway/boot/feature-mounts.js"];

// mountMcpServer(app, "<prefix>", <factory>, sessionManager, ...) — the factory runs up to the
// call's own sessionManager argument, so anything a factory passes (a verifyActor, say) is included.
const MOUNT_RE = /mountMcpServer\(\s*app\s*,\s*(["'`])((?:(?!\1)[\s\S])*)\1\s*,\s*([\s\S]*?)\s*,\s*sessionManager\s*,/g;

// A mount that verifies a signed actor itself (actor-sig.mjs's verifyActor / verifyBoardActorSig /
// verifySecretsActorSig / verifyArtifactsActorSig, wired as `verifyActor: …` on the server factory).
const SIGNED_RE = /\bverify[A-Za-z]*Actor\b/;

/** Every mountMcpServer prefix in the boot sources, with whether its factory verifies a signature. */
function bootMounts() {
  const mounts = [];
  for (const rel of BOOT_SOURCES) {
    const src = readFileSync(join(REPO, rel), "utf8");
    for (const m of src.matchAll(MOUNT_RE)) {
      const raw = m[2];
      // `/tools-${name}` (clients.json) is the one template prefix; probe it with a real name shape.
      const prefix = raw.replace(/\$\{[^}]*\}/g, "client");
      // The root mount is covered by the loopback rule, not by the prefix regex.
      if (prefix === "") continue;
      mounts.push({ source: rel, raw, prefix, signed: SIGNED_RE.test(m[3] || "") });
    }
  }
  return mounts;
}

const SUFFIXES = ["mcp", "sse", "messages"];

test("every unsigned gateway mount prefix is an owner mount, every signed one is not", () => {
  const mounts = bootMounts();
  // The extraction itself: the mounts this repo publishes today.
  for (const prefix of ["/router", "/projects", "/research", "/memory", "/sharing", "/storage", "/blog-mcp", "/wm", "/tools", "/tools-client"]) {
    assert.ok(mounts.some((m) => m.prefix === prefix && !m.signed), "unsigned mount extracted: " + prefix);
  }
  for (const prefix of ["/board", "/secrets", "/phone", "/artifacts"]) {
    assert.ok(mounts.some((m) => m.prefix === prefix && m.signed), "signed mount extracted: " + prefix);
  }

  const unsigned = mounts.filter((m) => !m.signed);
  const signed = mounts.filter((m) => m.signed);
  assert.ok(unsigned.length && signed.length, "both kinds of mount are present");

  for (const { prefix, source } of unsigned) {
    for (const suffix of SUFFIXES) {
      const url = `http://gw.example/${prefix.slice(1)}/${suffix}`;
      assert.equal(isOwnerProjectUrl(url), true, `${source} mounts ${prefix} unsigned — ${url} must be refused as an owner mount`);
    }
  }
  for (const { prefix, source } of signed) {
    for (const suffix of SUFFIXES) {
      const url = `http://gw.example/${prefix.slice(1)}/${suffix}`;
      assert.equal(isOwnerProjectUrl(url), false, `${source} mounts ${prefix} with a signed actor — ${url} must stay allowed`);
    }
  }
});

test("the writer's own mounting of a disallowed url block still disables it", async () => {
  const { buildBotMcp } = await import("../scripts/pi-bots/mcp_writer.mjs");
  const blocks = {};
  for (const prefix of ["/sharing", "/wm"]) {
    blocks["gateway" + prefix] = { url: "http://192.0.2.10:3001" + prefix + "/mcp" };
  }
  const { json, servers, disabled } = buildBotMcp({ tools: { crow_mcp: Object.keys(blocks) } }, { mcpServers: blocks }, {});
  for (const name of Object.keys(blocks)) {
    assert.deepEqual(json.mcpServers[name], { disabled: true }, name);
    assert.ok(disabled.includes(name), name);
    assert.ok(!servers.includes(name), name);
  }
});