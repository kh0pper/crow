/**
 * mcp_writer's add-on path must never fall back to a bare name / PATH lookup:
 * a launcher that fails resolution or verification is OMITTED (logged, and
 * then surfaced by buildBotMcp as a selected-but-absent server).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraServersFromExtensions } from "../scripts/pi-bots/mcp_writer.mjs";

function home(addons) {
  const h = mkdtempSync(join(tmpdir(), "mcpw-cmd-"));
  for (const id of Object.keys(addons)) mkdirSync(join(h, "bundles", id), { recursive: true });
  writeFileSync(join(h, "mcp-addons.json"), JSON.stringify(addons));
  return h;
}
const def = (ids) => ({ tools: { crow_mcp: ids.map((i) => i + "/t") } });
const canonical = { mcpServers: {} };

test("an unresolvable bare launcher is omitted, not passed through for a PATH lookup", () => {
  const h = home({ ghost: { command: "uvx-not-installed-xyz", args: [] } });
  const logs = [];
  const orig = console.warn; console.warn = (m) => logs.push(String(m));
  try {
    const s = extraServersFromExtensions(def(["ghost"]), h, { canonical });
    assert.equal("ghost" in s, false);
  } finally { console.warn = orig; }
  assert.ok(logs.some((l) => /ghost/.test(l) && /not found/.test(l)), logs.join("\n"));
});

test("a user-owned absolute launcher without a pin is omitted; with a matching pin it is kept; node is the gateway binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpw-bin-"));
  const bin = join(dir, "uv");
  writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
  const pin = createHash("sha256").update("#!/bin/sh\n").digest("hex");
  const orig = console.warn; console.warn = () => {};
  try {
    const h = home({ a: { command: bin, args: [] }, b: { command: bin, command_sha256: pin, args: [] }, c: { command: "node", args: ["x.js"] } });
    const s = extraServersFromExtensions(def(["a", "b", "c"]), h, { canonical });
    assert.equal("a" in s, false);
    assert.equal(s.b.command, bin);
    assert.equal(s.b.command_sha256, pin, "the pin rides along for pi-lab's spawn-time re-check");
    assert.equal(s.c.command, process.execPath);
  } finally { console.warn = orig; }
});

test("a spawn block drops loader names from the entry env, keeping its other vars and adding no env when it has none", () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const h = home({
      ldr: { command: "node", args: ["x.js"], env: { FOO: "bar", NODE_OPTIONS: "--require /tmp/evil.js", LD_PRELOAD: "/tmp/evil.so" } },
      bare: { command: "node", args: ["x.js"] },
    });
    const s = extraServersFromExtensions(def(["ldr", "bare"]), h, { canonical });
    assert.equal(s.ldr.env.FOO, "bar", "an ordinary env var survives");
    assert.equal(s.ldr.env.NODE_OPTIONS, undefined, "NODE_OPTIONS would --require code before the server runs");
    assert.equal(s.ldr.env.LD_PRELOAD, undefined, "LD_PRELOAD would load a library before the server runs");
    assert.equal("env" in s.bare, false, "a block with no env must not gain one");
  } finally { console.warn = orig; }
});

test("pin-addon-command writes the launcher's SHA-256 (and an absolute command) into mcp-addons.json", async () => {
  const { pinAddonCommand } = await import("../scripts/ops/pin-addon-command.mjs");
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "mcpw-pin-"));
  const bin = join(dir, "uvx");
  writeFileSync(bin, "#!/bin/sh\necho hi\n"); chmodSync(bin, 0o755);
  const h = home({ gw: { command: "uvx", args: ["--from", "x"] } });
  assert.throws(() => pinAddonCommand({ crowHome: h, id: "gw" }), /absolute/);
  const r = pinAddonCommand({ crowHome: h, id: "gw", command: bin });
  const saved = JSON.parse(readFileSync(join(h, "mcp-addons.json"), "utf8")).gw;
  assert.equal(saved.command, bin);
  assert.equal(saved.command_sha256, createHash("sha256").update("#!/bin/sh\necho hi\n").digest("hex"));
  assert.deepEqual(saved.args, ["--from", "x"]);
  assert.equal(r.sha256, saved.command_sha256);
  const s = extraServersFromExtensions(def(["gw"]), h, { canonical });
  assert.equal(s.gw.command, bin);
});

test("a pinned uvx that fetches a floating git ref is omitted; a commit-pinned one is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpw-uvx-"));
  const bin = join(dir, "uvx");
  writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
  const pin = createHash("sha256").update("#!/bin/sh\n").digest("hex");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const orig = console.warn; const logs = []; console.warn = (m) => logs.push(String(m));
  try {
    const h = home({
      floating: { command: bin, command_sha256: pin, args: ["--from", "git+https://github.com/x/y", "y"] },
      fixed: { command: bin, command_sha256: pin, args: ["--from", `git+https://github.com/x/y@${SHA}`, "y"] },
    });
    const s = extraServersFromExtensions(def(["floating", "fixed"]), h, { canonical });
    assert.equal("floating" in s, false);
    assert.ok(s.fixed);
  } finally { console.warn = orig; }
  assert.ok(logs.some((l) => /floating/.test(l) && /commit/.test(l)), logs.join("\n"));
});
